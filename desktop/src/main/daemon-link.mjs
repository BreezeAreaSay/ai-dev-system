/**
 * The main process's connection to the daemon: one MCP SDK client over the
 * daemon's socket (the server's `openControlClient`, the shared transport),
 * the calls the page makes through it with their progress and cancel, and
 * where the connection stands, for the page and the tray.
 */
import { EventEmitter } from "node:events";

/** How often the tray's colour is refreshed while the daemon is reachable. */
export const STATUS_EVERY_MS = 30_000;

/** A call's longest silence: a download or a setup reports progress far more often. */
const CALL_TIMEOUT_MS = 10 * 60_000;

export class DaemonLink extends EventEmitter {
  #server;
  #env;
  #execPath;
  #client = null;
  #transport = null;
  #calls = new Map();
  #timer = null;
  #connecting = null;

  /** `connecting`, `starting`, `online`, `offline` or `no-node`, with what goes with it. */
  state = { phase: "connecting" };

  /** The last `system_status` answer (without checks), or null. */
  status = null;

  /**
   * @param {{ server: { openControlClient: Function, stopDaemons: Function, daemonLogTail: Function }, env: NodeJS.ProcessEnv, execPath: string | null, noNode?: string }} options
   */
  constructor({ server, env, execPath, noNode }) {
    super();
    this.#server = server;
    this.#env = env;
    this.#execPath = execPath;
    if (!execPath) this.#set({ phase: "no-node", error: noNode ?? "" });
  }

  #set(state) {
    this.state = state;
    this.emit("state", state);
  }

  /**
   * Reach the daemon; with `start`, start it when it is not running. Two
   * calls at once share one attempt.
   */
  connect({ start = false } = {}) {
    if (!this.#execPath) return Promise.resolve(this.state);
    if (this.#client) return Promise.resolve(this.state);
    this.#connecting ??= this.#connect(start).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect(start) {
    this.#set({ phase: start ? "starting" : "connecting" });
    try {
      const { client, transport } = await this.#server.openControlClient({
        env: this.#env,
        execPath: this.#execPath,
        start,
        name: "ai-dev-desktop"
      });
      this.#client = client;
      this.#transport = transport;
      transport.onclose = () => this.#lost();
      await this.refreshStatus();
      this.#set({ phase: "online", needsSetup: !this.status?.index?.exists, served_by: this.status?.served_by ?? null });
      this.#timer = setInterval(() => this.refreshStatus().catch(() => undefined), STATUS_EVERY_MS);
      this.#timer.unref?.();
    } catch (error) {
      this.#client = null;
      this.#transport = null;
      const notRunning = error?.code === "ENOTRUNNING";
      this.#set({
        phase: "offline",
        error: notRunning ? "" : String(error?.message ?? error),
        log: notRunning ? [] : await this.#server.daemonLogTail(this.#env).catch(() => [])
      });
    }
    return this.state;
  }

  #lost() {
    if (!this.#client) return;
    this.#client = null;
    this.#transport = null;
    clearInterval(this.#timer);
    for (const call of this.#calls.values()) call.abort("The daemon went away.");
    this.#calls.clear();
    this.status = null;
    this.emit("status", null);
    this.#set({ phase: "offline", error: "", log: [] });
  }

  /** `system_status` without checks, for the tray; null when offline. */
  async refreshStatus() {
    if (!this.#client) return null;
    const result = await this.#client.callTool({ name: "system_status", arguments: { checks: false } });
    this.status = result.isError ? null : result.structuredContent?.result ?? null;
    this.emit("status", this.status);
    return this.status;
  }

  /**
   * Call a tool; resolves `{ ok: true, result }` or `{ ok: false, error, cancelled }` —
   * never throws, so the page gets the daemon's own words.
   */
  async call(tool, args, { id, onProgress } = {}) {
    if (!this.#client) return { ok: false, error: "The daemon is not connected.", cancelled: false };
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args }, undefined, {
        signal: controller.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(onProgress ? { onprogress: (progress) => onProgress(progress) } : {})
      });
      if (result.isError) return { ok: false, error: result.content?.[0]?.text ?? "The tool failed.", cancelled: false };
      if (tool !== "system_status") this.refreshStatus().catch(() => undefined);
      return { ok: true, result: result.structuredContent?.result ?? null };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      return { ok: false, error: cancelled ? String(controller.signal.reason ?? "Cancelled.") : String(error?.message ?? error), cancelled };
    } finally {
      this.#calls.delete(id);
    }
  }

  /** Cancel a call by its id; false when there is none. */
  cancel(id) {
    const controller = this.#calls.get(id);
    if (!controller) return false;
    controller.abort("Cancelled.");
    return true;
  }

  /** Stop every daemon of this runtime home (the tray's "Stop the daemon"). */
  async stopDaemon() {
    const stopped = await this.#server.stopDaemons({ env: this.#env, timeoutMs: 10_000 });
    this.#lost();
    return stopped;
  }

  async close() {
    clearInterval(this.#timer);
    for (const call of this.#calls.values()) call.abort("The app is closing.");
    const client = this.#client;
    this.#client = null;
    await client?.close().catch(() => undefined);
  }
}
