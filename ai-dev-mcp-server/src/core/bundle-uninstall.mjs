/**
 * Taking the Windows install off a computer: what its uninstaller runs —
 * `ai-dev uninstall`, from `desktop/build/installer.nsh` — before it removes
 * the program's own folder.
 *
 * The program's folder is the installer's to remove. What the app made
 * outside it is this module's: the runtime copies in `<runtime>/app/` and the
 * stable link AI clients run (`app-bundle.mjs`), the clients' `ai-dev` entries
 * that run them (when asked), and — only when asked, and only a folder that
 * is plainly AI Dev's — the runtime home with the person's data.
 *
 * Every daemon of the runtime home is stopped first: on Windows a running
 * daemon holds its copy's Node and DLLs, and nothing it holds can be removed.
 * A copy still held is reported and left; nothing is forced.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_LINK, currentLink } from "./app-bundle.mjs";
import { APP_MARKER } from "./app-home.mjs";
import { clientStatePath, listClients } from "./client-connections.mjs";
import { stopDaemons } from "./daemon-client.mjs";
import { removeServer } from "./mcp-clients.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** What a runtime home holds; a folder with none of it is not taken for one. */
const RUNTIME_PARTS = ["state", "cache", "app", "models", "vault", "run", "logs", "artifacts", "config.json"];

const fold = (value, platform) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);

/** The runtime copies the Windows install made: folders in `<runtime>/app/` whose marker says `bundle`. */
export async function bundleCopies(appsRoot) {
  const copies = [];
  for (const entry of await fs.readdir(appsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(appsRoot, entry.name);
    const marker = await fs.readFile(path.join(folder, APP_MARKER), "utf8").then(JSON.parse, () => null);
    if (marker?.kind === "bundle") copies.push(folder);
  }
  return copies.sort();
}

/**
 * Whether a client's `ai-dev` entry runs the Windows install: its command or
 * an argument lies under the stable link or in one of its copies. An entry of
 * a clone, of an npx copy, of Docker is someone else's, and stays.
 *
 * @param {{ command?: unknown, args?: unknown } | undefined} entry
 * @param {{ appsRoot: string, copies: string[], platform?: string }} where
 * @returns {boolean}
 */
export function runsBundle(entry, { appsRoot, copies, platform = process.platform }) {
  if (!entry || typeof entry !== "object") return false;
  const owned = new Set([CURRENT_LINK, ...copies.map((folder) => path.basename(folder))].map((name) => fold(name, platform)));
  const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((word) => typeof word === "string" && word);
  return words.some((word) => {
    const relative = path.relative(appsRoot, path.resolve(word));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return owned.has(fold(relative.split(path.sep)[0], platform));
  });
}

/**
 * Why `folder` must not be deleted as a runtime home, or "" when it may be: it
 * is the home itself, a folder above it, a drive's root, or holds nothing a
 * runtime home holds.
 *
 * @param {string} folder
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {Promise<string>}
 */
export async function refuseDataRemoval(folder, { home = os.homedir(), platform = process.platform } = {}) {
  const resolved = path.resolve(folder);
  if (path.parse(resolved).root === resolved) return `${resolved} is the root of a drive.`;
  const relative = path.relative(resolved, path.resolve(home));
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return `${resolved} holds the home folder ${home}.`;
  const names = new Set((await fs.readdir(resolved).catch(() => [])).map((name) => fold(name, platform)));
  if (!names.size) return "";
  return RUNTIME_PARTS.some((part) => names.has(part)) ? "" : `${resolved} does not look like an AI Dev runtime home (none of ${RUNTIME_PARTS.join(", ")}).`;
}

/** Remove a folder by moving it aside first, so one Windows refuses half-way is not left looking whole. */
async function removeFolder(folder) {
  const aside = `${folder}.${process.pid}.removing.partial`;
  try {
    await fs.rename(folder, aside);
  } catch (error) {
    return String(error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES" ? "in use" : error?.message ?? error);
  }
  await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  return "";
}

/** Remove the stable link, never what it names. */
async function removeLink(link) {
  const stat = await fs.lstat(link).catch(() => null);
  if (!stat) return "absent";
  if (!stat.isSymbolicLink()) return "left";
  try {
    await fs.unlink(link);
  } catch {
    await fs.rmdir(link).catch(() => undefined);
  }
  return await fs.lstat(link).then(() => "left", () => "removed");
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.platform]
 * @param {boolean} [options.clients] - Take the install's `ai-dev` entries out of the clients.
 * @param {boolean} [options.data] - Delete the runtime home with everything in it.
 * @param {boolean} [options.apply] - Without it, only say what would happen.
 * @param {typeof stopDaemons} [options.stop]
 * @returns {Promise<{ apply: boolean, runtime_home: string, daemons: object[], clients: object[], copies: { removed: string[], left: Array<{ folder: string, reason: string }> }, link: string, data: { asked: boolean, removed: boolean, reason?: string } }>}
 */
export async function uninstallBundle({ env = process.env, home = os.homedir(), platform = process.platform, clients = false, data = false, apply = false, stop = stopDaemons } = {}) {
  const runtimeHome = resolveRuntimeStateRoot("", env);
  const appsRoot = path.join(runtimeHome, "app");
  const copies = await bundleCopies(appsRoot);
  const result = { apply, runtime_home: runtimeHome, daemons: [], clients: [], copies: { removed: [], left: [] }, link: "absent", data: { asked: data, removed: false } };
  if (apply) result.daemons = (await stop({ env })).daemons;

  if (clients) {
    const rows = await listClients({ env, home });
    const targets = rows.filter((row) => runsBundle(row.row?.entries?.["ai-dev"], { appsRoot, copies, platform })).map((row) => row.row);
    result.clients = await removeServer({ targets, apply, statePath: clientStatePath(env) });
  }

  if (apply) {
    result.link = await removeLink(currentLink(runtimeHome));
    for (const folder of copies) {
      const reason = await removeFolder(folder);
      if (reason) result.copies.left.push({ folder, reason });
      else result.copies.removed.push(folder);
    }
  } else {
    result.link = await fs.lstat(currentLink(runtimeHome)).then(() => "would-remove", () => "absent");
    result.copies.removed = copies;
  }

  if (data) {
    const reason = await refuseDataRemoval(runtimeHome, { home, platform });
    if (reason) result.data.reason = reason;
    else if (apply) {
      await fs.rm(runtimeHome, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
        result.data.reason = String(error?.message ?? error);
      });
      result.data.removed = !(await fs.access(runtimeHome).then(() => true, () => false));
      if (!result.data.removed) result.data.reason ??= "some of its files are in use";
    }
  }
  return result;
}
