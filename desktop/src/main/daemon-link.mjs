/**
 * The main process's connection to the daemon: one MCP SDK client over the
 * daemon's socket (the server's `openControlClient`, the shared transport),
 * the calls the page makes through it with their progress and cancel, where
 * the connection stands, and the install's verdict for the tray.
 */
import { EventEmitter } from "node:events";

/**
 * How often things are looked at again. The tray's verdict is the health
 * checks' (`system_status` with checks, about a second of the daemon's time):
 * at connect, after anything the app changes, when the quick state moves, and
 * every five minutes. Between those the quick state (what is on disk) is read
 * every thirty seconds. An app with no daemon looks for one every ten.
 */
export const TIMING = Object.freeze({ statusEveryMs: 30_000, checksEveryMs: 5 * 60_000, retryEveryMs: 10_000 });

/** A call's longest silence: a download or a setup reports progress far more often. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** The tools the interface calls that only read: no verdict to refresh after them. */
const READS_ONLY = new Set(["system_status", "clients_list", "settings_get", "model_verify", "logs_tail", "workspace_overview"]);

/** What the quick state says, to tell when the verdict needs the checks again. */
function quickState(status) {
  if (!status) return "";
  return JSON.stringify([
    status.index?.exists, status.index?.fresh, status.index?.documents, status.index?.dense_documents,
    status.model?.installed, status.clients?.connected, status.clients?.found, status.settings_problems?.length ?? 0
  ]);
}

export class DaemonLink extends EventEmitter {
  #server = null;
  #env;
  #execPath = null;
  #t;
  #timing;
  #client = null;
  #calls = new Map();
  #quickTimer = null;
  #checksTimer = null;
  #retryTimer = null;
  #connecting = null;
  #checking = null;
  #quick = "";
  #leaving = null;

  /** `connecting`, `starting`, `reconnecting`, `online`, `offline`, `no-node` or `broken`, with what goes with it. */
  state = { phase: "connecting" };

  /** The install's verdict for the tray: the last `system_status` answer with its checks, or null. */
  status = null;

  /**
   * @param {{ env: NodeJS.ProcessEnv, t?: (key: string, params?: object) => string, timing?: Partial<typeof TIMING> }} options
   */
  constructor({ env, t = (key) => key, timing = {} }) {
    super();
    this.#env = env;
    this.#t = t;
    this.#timing = { ...TIMING, ...timing };
  }

  #set(state) {
    this.state = state;
    this.emit("state", state);
  }

  /**
   * Give the link its server and the Node the daemon runs on, once the app
   * has them; without a Node the page says so.
   *
   * @param {{ server: { openControlClient: Function, stopDaemons: Function, daemonLogTail: Function }, execPath: string | null, noNode?: string }} options
   */
  attach({ server, execPath, noNode }) {
    this.#server = server;
    this.#execPath = execPath;
    if (!execPath) this.#set({ phase: "no-node", error: noNode ?? "" });
  }

  /** The app could not get going: why, and what to do (main.mjs). */
  fail(failure) {
    this.#stopTimers();
    this.#set({ phase: "broken", ...failure });
  }

  /**
   * Reach the daemon; with `start`, start it when it is not running. Two
   * calls at once share one attempt. `reconnecting` says the app had a
   * session and is opening another: the page keeps its place.
   */
  connect({ start = false, reconnecting = false } = {}) {
    if (!this.#server || !this.#execPath) return Promise.resolve(this.state);
    if (this.#client) return Promise.resolve(this.state);
    this.#connecting ??= this.#connect(start, reconnecting).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(start) {
    const { client } = await this.#server.openControlClient({
      env: this.#env,
      execPath: this.#execPath,
      start,
      name: "ai-dev-desktop"
    });
    // The client's own close callback: the SDK keeps the transport's for
    // itself (it ends the calls in flight), and calls this one after.
    client.onclose = () => this.#lost(client);
    this.#client = client;
    clearTimeout(this.#retryTimer);
    this.#quick = "";
    this.status = null;
    await this.refreshStatus({ checks: true }).catch(() => this.refreshStatus({ checks: false })).catch(() => null);
    this.#set({ phase: "online", needsSetup: !this.status?.index?.exists, served_by: this.status?.served_by ?? null });
    this.#arm();
  }

  async #connect(start, reconnecting) {
    this.#set({ phase: reconnecting ? "reconnecting" : start ? "starting" : "connecting" });
    try {
      await this.#open(start);
    } catch (error) {
      this.#client = null;
      const notRunning = error?.code === "ENOTRUNNING";
      this.#set({
        phase: "offline",
        error: notRunning ? "" : String(error?.message ?? error),
        log: notRunning ? [] : await this.#server.daemonLogTail(this.#env).catch(() => [])
      });
      this.#retry();
    }
    return this.state;
  }

  /**
   * While there is no daemon, look for one every few seconds without starting
   * it: an AI client starts the daemon on its own, and the app comes back
   * online with it (docs/DEFECTS.md, Д-243).
   */
  #retry() {
    clearTimeout(this.#retryTimer);
    if (this.state.phase !== "offline") return;
    this.#retryTimer = setTimeout(async () => {
      if (this.#client || this.#connecting || this.state.phase !== "offline") return;
      this.#connecting = this.#open(false).catch(() => this.#retry()).finally(() => {
        this.#connecting = null;
      });
    }, this.#timing.retryEveryMs);
    this.#retryTimer.unref?.();
  }

  #arm() {
    this.#stopTimers();
    this.#quickTimer = setInterval(() => this.#poll().catch(() => undefined), this.#timing.statusEveryMs);
    this.#checksTimer = setInterval(() => this.refreshStatus({ checks: true }).catch(() => undefined), this.#timing.checksEveryMs);
    this.#quickTimer.unref?.();
    this.#checksTimer.unref?.();
  }

  #stopTimers() {
    clearInterval(this.#quickTimer);
    clearInterval(this.#checksTimer);
    clearTimeout(this.#retryTimer);
  }

  /** The quick state; the checks again only when it moved. */
  async #poll() {
    if (!this.#client) return;
    const quick = await this.#ask({ checks: false });
    if (!quick) return;
    if (quick.served_by?.retired) {
      this.#moveOn();
      return;
    }
    if (quickState(quick) !== this.#quick) await this.refreshStatus({ checks: true });
  }

  #lost(client) {
    if (client && client !== this.#client) return;
    if (!this.#client) return;
    this.#client = null;
    this.#stopTimers();
    for (const call of this.#calls.values()) call.abort(this.#t("link.wentAway"));
    this.#calls.clear();
    this.status = null;
    this.emit("status", null);
    const expected = this.#leaving;
    this.#leaving = null;
    if (expected === "stopped") {
      this.#set({ phase: "offline", error: "", log: [] });
      this.#retry();
      return;
    }
    // Not asked for: the daemon stopped on its own or was killed; its log says why (Д-257, п. 6).
    this.#set({ phase: "offline", error: this.#t("link.lost"), log: [] });
    this.#server.daemonLogTail(this.#env).then((log) => {
      if (this.state.phase === "offline" && !this.#client) this.#set({ ...this.state, log });
    }, () => undefined);
    this.#retry();
  }

  async #ask(args) {
    const client = this.#client;
    if (!client) return null;
    const result = await client.callTool({ name: "system_status", arguments: args });
    return result.isError ? null : result.structuredContent?.result ?? null;
  }

  /**
   * `system_status` — with the health checks unless told otherwise — for the
   * tray; the answer is the verdict when it has the checks. One check at a
   * time: a second caller shares the first one's.
   */
  async refreshStatus({ checks = true } = {}) {
    if (!checks) return this.#accept(await this.#ask({ checks: false }), false);
    this.#checking ??= this.#ask({ checks: true }).then((answer) => this.#accept(answer, true)).finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  #accept(answer, checked) {
    if (!answer) return this.status;
    if (answer.served_by?.retired) {
      this.#moveOn();
      return this.status;
    }
    if (checked) {
      this.status = answer;
      this.#quick = quickState(answer);
      this.emit("status", answer);
    } else if (!this.status) {
      this.status = answer;
      this.emit("status", answer);
    }
    return this.status;
  }

  /**
   * The daemon retired: the code it runs was replaced in place and a daemon
   * of the new code serves. Leave it, so it can finish, and use the new one
   * (docs/DEFECTS.md, Д-245).
   */
  #moveOn() {
    if (this.#leaving) return;
    this.reconnect().catch(() => undefined);
  }

  /**
   * Call a tool; resolves `{ ok: true, result }` or `{ ok: false, error, cancelled }` —
   * never throws, so the page gets the daemon's own words.
   */
  async call(tool, args, { id, onProgress } = {}) {
    if (!this.#client) return { ok: false, error: this.#t("link.notConnected"), cancelled: false };
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args }, undefined, {
        signal: controller.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(onProgress ? { onprogress: (progress) => onProgress(progress) } : {})
      });
      if (result.isError) return { ok: false, error: result.content?.[0]?.text ?? this.#t("link.failed"), cancelled: false };
      const answer = result.structuredContent?.result ?? null;
      // Every verdict the app gets is the tray's too (docs/DEFECTS.md, Д-240);
      // after a change, the checks run again.
      if (tool === "system_status") this.#accept(answer, args?.checks !== false);
      else if (!READS_ONLY.has(tool)) this.refreshStatus({ checks: true }).catch(() => undefined);
      return { ok: true, result: answer };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      return { ok: false, error: cancelled ? String(controller.signal.reason ?? this.#t("link.cancelled")) : String(error?.message ?? error), cancelled };
    } finally {
      this.#calls.delete(id);
    }
  }

  /** Cancel a call by its id; false when there is none. */
  cancel(id) {
    const controller = this.#calls.get(id);
    if (!controller) return false;
    controller.abort(this.#t("link.cancelled"));
    return true;
  }

  /** Stop every daemon of this runtime home (the tray's "Stop the daemon"). */
  async stopDaemon() {
    this.#leaving = "stopped";
    const stopped = await this.#server.stopDaemons({ env: this.#env, timeoutMs: 10_000 });
    this.#lost(this.#client);
    this.#leaving = null;
    return stopped;
  }

  /**
   * Drop this session and open a new one, starting a daemon when none of this
   * build runs. The old daemon goes on for its other clients.
   */
  async reconnect() {
    this.#leaving = "reconnect";
    await this.close(this.#t("link.reconnected"));
    this.#leaving = null;
    return this.connect({ start: true, reconnecting: true });
  }

  async close(reason = this.#t("link.closing")) {
    this.#stopTimers();
    for (const call of this.#calls.values()) call.abort(reason);
    this.#calls.clear();
    const client = this.#client;
    this.#client = null;
    await client?.close().catch(() => undefined);
  }
}
