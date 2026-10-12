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
  // A reconnect under way: a retired daemon does not start a second move.
  #leaving = null;
  // Stops in flight: a loss meanwhile is what was asked for, and no move
  // starts a daemon (docs/DEFECTS.md, Д-278).
  #stopping = 0;
  // close() moves it on: a session that opens after it is given up (docs/DEFECTS.md, Д-266, п. 10).
  #generation = 0;
  // The attempt under way is the offline look, which does not start a daemon.
  #lookOnly = false;
  // The daemon retired while calls were in flight: move once they end (Д-263).
  #moveWhenIdle = false;
  // The calls the person cancelled, told apart from the ones the link ended —
  // with the key of the link's words, said in the language in force (Д-280).
  #byPerson = new WeakSet();
  #endedBy = new WeakMap();
  // Whether the app may start a daemon: the start-up asked with autostart on,
  // or the person pressed Start. The move off a retired daemon starts one only
  // then (docs/DEFECTS.md, Д-276, п. 5).
  #mayStart = false;

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
    if (start && !reconnecting) this.#mayStart = true;
    if (!this.#server || !this.#execPath) return Promise.resolve(this.state);
    if (this.#client) return Promise.resolve(this.state);
    if (this.#connecting) {
      // The offline look does not start a daemon: Start pressed meanwhile waits for it, then starts one (Д-266, п. 10).
      if (start && this.#lookOnly) return this.#connecting.then(() => this.connect({ start, reconnecting }));
      return this.#connecting;
    }
    this.#connecting = this.#connect(start, reconnecting).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(start) {
    const generation = this.#generation;
    const { client } = await this.#server.openControlClient({
      env: this.#env,
      execPath: this.#execPath,
      start,
      name: "ai-dev-desktop"
    });
    // The link was closed while the session opened — the app quits: give it up.
    if (generation !== this.#generation) {
      await client.close().catch(() => undefined);
      return;
    }
    // The client's own close callback: the SDK keeps the transport's for
    // itself (it ends the calls in flight), and calls this one after.
    client.onclose = () => this.#lost(client);
    this.#client = client;
    clearTimeout(this.#retryTimer);
    this.#quick = "";
    this.status = null;
    await this.refreshStatus({ checks: true }).catch(() => this.refreshStatus({ checks: false })).catch(() => null);
    // The daemon went away while it answered: #lost has said so and looks for one again (Д-262).
    if (this.#client !== client) return;
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
    this.#retryTimer = setTimeout(() => {
      if (this.#client || this.#connecting || this.state.phase !== "offline") return;
      this.#lookOnly = true;
      this.#connecting = this.#open(false).catch(() => this.#retry()).finally(() => {
        this.#connecting = null;
        this.#lookOnly = false;
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
    this.#moveWhenIdle = false;
    this.#stopTimers();
    this.#endCalls("link.wentAway");
    this.status = null;
    this.emit("status", null);
    if (this.#stopping) {
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
    if (this.#leaving || this.#stopping) return;
    // A call in flight is the retired daemon's to finish; the move waits for it (Д-263).
    if (this.#calls.size) {
      this.#moveWhenIdle = true;
      return;
    }
    this.#moveWhenIdle = false;
    this.reconnect().catch(() => undefined);
  }

  /**
   * Call a tool; resolves `{ ok: true, result }` or `{ ok: false, error, cancelled }` —
   * never throws, so the page gets the daemon's own words.
   */
  async call(tool, args, { id, onProgress } = {}) {
    if (!this.#client) return this.#failure("link.notConnected");
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args }, undefined, {
        signal: controller.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(onProgress ? { onprogress: (progress) => onProgress(progress) } : {})
      });
      if (result.isError) return result.content?.[0]?.text ? { ok: false, error: result.content[0].text, cancelled: false } : this.#failure("link.failed");
      const answer = result.structuredContent?.result ?? null;
      // Every verdict the app gets is the tray's too (docs/DEFECTS.md, Д-240);
      // after a change, the checks run again.
      if (tool === "system_status") this.#accept(answer, args?.checks !== false);
      else if (!READS_ONLY.has(tool)) this.refreshStatus({ checks: true }).catch(() => undefined);
      return { ok: true, result: answer };
    } catch (error) {
      // Cancelled is what the person asked for; a call the link ended — the
      // daemon went away, the app quits — failed, in the link's words (Д-263).
      if (this.#byPerson.has(controller)) return { ...this.#failure("link.cancelled"), cancelled: true };
      if (this.#endedBy.has(controller)) return this.#failure(this.#endedBy.get(controller));
      return { ok: false, error: String(error?.message ?? error), cancelled: false };
    } finally {
      this.#calls.delete(id);
      if (this.#moveWhenIdle && !this.#calls.size) this.#moveOn();
    }
  }

  /** A call that failed in the link's own words: `key` says them again in another language. */
  #failure(key) {
    return { ok: false, error: this.#t(key), key, cancelled: false };
  }

  /** End every call in flight, in the link's words `key`. */
  #endCalls(key) {
    for (const controller of this.#calls.values()) {
      this.#endedBy.set(controller, key);
      controller.abort(this.#t(key));
    }
    this.#calls.clear();
  }

  /** Cancel a call by its id; false when there is none. */
  cancel(id) {
    const controller = this.#calls.get(id);
    if (!controller) return false;
    this.#byPerson.add(controller);
    controller.abort(this.#t("link.cancelled"));
    return true;
  }

  /**
   * Stop every daemon of this runtime home (the tray's "Stop the daemon").
   * The link acts on the session it had when asked, and on no other: its
   * daemon stopped — the session is closed, not left open; it would not stop
   * — the session stays, and the answer says why. Not knowing which daemon
   * is its own, the link keeps the session while any daemon still runs: if
   * that one was the session's, the session ends by itself (docs/DEFECTS.md,
   * Д-273, Д-278).
   */
  async stopDaemon() {
    const client = this.#client;
    const serving = this.status?.served_by?.pid ?? this.state.served_by?.pid ?? null;
    this.#stopping += 1;
    try {
      const answer = await this.#server.stopDaemons({ env: this.#env, timeoutMs: 10_000 });
      const daemons = answer?.daemons ?? [];
      const ended = serving === null
        ? daemons.every((daemon) => daemon.stopped !== false)
        : daemons.some((daemon) => daemon.pid === serving && daemon.stopped !== false);
      if (client && ended) {
        this.#lost(client);
        await client.close().catch(() => undefined);
      }
      return answer;
    } finally {
      // Whatever came of it, a later loss is unasked again (Д-266, п. 10).
      this.#stopping -= 1;
    }
  }

  /**
   * Drop this session and open a new one — starting a daemon when none of
   * this build runs, if the app may start one. The old daemon goes on for its
   * other clients.
   */
  async reconnect() {
    this.#leaving = "reconnect";
    try {
      await this.close("link.reconnected");
    } finally {
      this.#leaving = null;
    }
    // An attempt under way — the one whose first checks found the daemon
    // retired — gives up after close(); a connect() now would only share it.
    // Wait for it, then open a new one (docs/DEFECTS.md, Д-268). While a Stop
    // runs, it starts none (Д-278).
    await this.#connecting?.catch(() => undefined);
    return this.connect({ start: this.#mayStart && !this.#stopping, reconnecting: true });
  }

  /** Close the session; the calls in flight end in the link's words `key`. */
  async close(key = "link.closing") {
    this.#generation += 1;
    this.#moveWhenIdle = false;
    this.#stopTimers();
    this.#endCalls(key);
    const client = this.#client;
    this.#client = null;
    await client?.close().catch(() => undefined);
  }
}
