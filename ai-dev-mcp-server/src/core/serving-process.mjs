/**
 * Which process is answering: the daemon every client shares, or a client's
 * own server (`npm start`, a 2.x entry, `AI_DEV_DAEMON=0`, the bridge's
 * fallback). The daemon says so once it serves; `system_status` reads it.
 */
import process from "node:process";

let daemon = null;

/**
 * Called by the daemon when it starts serving.
 *
 * @param {{ build: string, startedAt: string, idleTimeoutMs: number, sessions: () => number }} info
 */
export function markServingDaemon(info) {
  daemon = info;
}

/**
 * @returns {{ kind: "daemon" | "process", pid: number, build?: string, sessions?: number, started_at?: string, idle_timeout_ms?: number }}
 */
export function servingProcess() {
  if (!daemon) return { kind: "process", pid: process.pid };
  return {
    kind: "daemon",
    pid: process.pid,
    build: daemon.build,
    sessions: daemon.sessions(),
    started_at: daemon.startedAt,
    // A whole number, as the contract says, whatever fraction the variable held (Д-223).
    idle_timeout_ms: Math.round(daemon.idleTimeoutMs)
  };
}
