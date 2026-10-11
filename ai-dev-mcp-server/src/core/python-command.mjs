/**
 * Which Python interpreter runs the optional Python helpers — the UI UX Pro Max
 * script behind `query_ui_ux_knowledge` and the legacy dense backend. Search
 * does not need one (docs/DEFECTS.md, Д-85).
 *
 * The server and the client installer used to decide separately: the server
 * fell back to `python` on Windows, the installer to `python3` everywhere, and
 * a client configured on Windows overrode a working interpreter with one that
 * is not there (Д-94). This is the only place that picks it.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The interpreter a bundled runtime ships beside Node:
 * `<runtime>/node/bin/node` next to `<runtime>/python/…`.
 *
 * @param {{ platform?: string, execPath?: string }} [options]
 * @returns {string}
 */
export function bundledPythonPath({ platform = process.platform, execPath = process.execPath } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const runtimeRoot = paths.resolve(paths.dirname(execPath), "..", "..");
  return platform === "win32"
    ? paths.join(runtimeRoot, "python", "python.exe")
    : paths.join(runtimeRoot, "python", "bin", "python");
}

/**
 * `AI_DEV_PYTHON` when set, else a bundled interpreter, else the name the
 * platform's own installers provide: `python3` off Windows — macOS dropped
 * `python` with Python 2 (Д-72) — and `python` on Windows, where the python.org
 * installer and the Store alias give that name and `python3.exe` is, where it
 * exists at all, often the Store's placeholder.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, execPath?: string, exists?: (file: string) => boolean }} [options]
 * @returns {string}
 */
export function resolvePythonCommand({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync
} = {}) {
  const explicit = String(env.AI_DEV_PYTHON ?? "").trim();
  if (explicit) return explicit;
  const bundled = bundledPythonPath({ platform, execPath });
  if (exists(bundled)) return bundled;
  return platform === "win32" ? "python" : "python3";
}
