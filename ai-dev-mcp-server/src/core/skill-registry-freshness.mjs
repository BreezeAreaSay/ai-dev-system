/**
 * Whether the generated skill registry still describes the skills on disk, and
 * a reader that rebuilds it when it does not.
 *
 * `03-skills-catalog/registries/skills.index.json` is built by `rebuild_index`
 * from the `SKILL.md` files under `03-skills-catalog/sources/`, and routing,
 * skill search and the search index all read the registry, not the files. A
 * `git pull` that removes, adds or rewrites skills changes the files and leaves
 * the registry as it was, so the removed skills went on being recommended and
 * found (docs/DEFECTS.md, Д-119). Three signals tell, without reading a skill:
 *
 * - an entry whose `SKILL.md` is gone;
 * - an entry whose `SKILL.md` is newer than the registry;
 * - a directory between `sources/` and a skill that is newer than the
 *   registry — something was added, removed or renamed in it.
 *
 * A file stamped with the registry's own time counts as newer: the kernel
 * stamps writes from a clock that moves in ticks of a few milliseconds, so a
 * change in the tick the registry was written in has the same time — the cost
 * of counting it is one rebuild too many, the cost of not counting it a change
 * never seen. A time in the future says nothing about the order of two writes
 * (a tree unpacked from a machine whose clock ran ahead), so it is not counted:
 * otherwise no rebuild could ever make the registry current again.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

/** How long a verdict on the registry is trusted before the files are looked at again. */
export const SKILL_REGISTRY_CHECK_INTERVAL_MS = 5_000;

const EXAMPLES = 5;

function statOrUndefined(target) {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Compare the registry's entries with the files they were built from.
 *
 * @param {object} input
 * @param {string} input.catalogRoot - `<vault>/03-skills-catalog`; entry paths are relative to it.
 * @param {number} input.builtAtMs - When the registry was written (its mtime).
 * @param {string[]} input.paths - The `path` of every registry entry.
 * @param {number} [input.nowMs] - Times after this are not trusted.
 * @param {(target: string) => (fs.Stats|undefined)} [input.stat]
 * @returns {{ stale: boolean, missing: number, changed: number, directories: number, examples: string[] }}
 */
export function skillRegistryStaleness({ catalogRoot, builtAtMs, paths, nowMs = Date.now(), stat = statOrUndefined }) {
  const sourcesRoot = path.join(catalogRoot, "sources");
  const newer = (info) => info.mtimeMs >= builtAtMs && info.mtimeMs <= nowMs;
  const examples = [];
  const note = (text) => {
    if (examples.length < EXAMPLES) examples.push(text);
  };
  const directories = new Set();
  let missing = 0;
  let changed = 0;
  for (const relative of paths) {
    const file = path.resolve(catalogRoot, relative);
    const info = stat(file);
    if (!info) {
      missing += 1;
      note(`missing ${relative}`);
      continue;
    }
    if (newer(info)) {
      changed += 1;
      note(`changed ${relative}`);
    }
    // The skill's own directory holds more than the skill — Python caches,
    // vendored node_modules — so only the directories above it are watched.
    for (let directory = path.dirname(path.dirname(file)); inside(sourcesRoot, directory); directory = path.dirname(directory)) {
      directories.add(directory);
      if (directory === sourcesRoot) break;
    }
  }
  let newerDirectories = 0;
  for (const directory of directories) {
    const info = stat(directory);
    if (info && newer(info)) {
      newerDirectories += 1;
      note(`directory ${path.relative(catalogRoot, directory).replaceAll("\\", "/")}`);
    }
  }
  return { stale: missing + changed + newerDirectories > 0, missing, changed, directories: newerDirectories, examples };
}

/**
 * Read a registry file the way the server always has: UTF-8, BOM tolerated.
 *
 * @param {string} registryPath
 * @returns {Promise<object[]>}
 */
export async function readSkillRegistryFile(registryPath) {
  const raw = await fs.promises.readFile(registryPath, "utf8");
  return JSON.parse(raw.replace(/^﻿/, ""));
}

/**
 * Whether a registry on disk is out of date, for callers that look once (the
 * setup command) rather than keep a reader.
 *
 * @param {{ registryPath: string, catalogRoot: string, nowMs?: number }} input
 * @returns {Promise<ReturnType<typeof skillRegistryStaleness> | null>} null when there is no registry
 */
export async function checkSkillRegistry({ registryPath, catalogRoot, nowMs = Date.now() }) {
  const info = statOrUndefined(registryPath);
  if (!info) return null;
  const items = await readSkillRegistryFile(registryPath);
  const paths = (Array.isArray(items) ? items : []).map((item) => String(item?.path ?? "")).filter(Boolean);
  return skillRegistryStaleness({ catalogRoot, builtAtMs: info.mtimeMs, paths, nowMs });
}

/**
 * The registry, rebuilt first when its skills changed on disk.
 *
 * At most one look at the files per `intervalMs` while the registry file stays
 * the same; at most one rebuild at a time, which concurrent readers wait for.
 * Reads made by the rebuild itself go straight to the file — waiting there
 * would be the rebuild waiting for itself. A rebuild that fails, or that writes
 * a registry still naming a file that is not there, is not retried until the
 * registry file changes: the registry on disk is served as it is, and
 * `onError` hears why. Files that changed while it ran are simply seen by the
 * next look.
 *
 * @param {object} input
 * @param {string} input.registryPath
 * @param {string} input.catalogRoot
 * @param {(verdict: ReturnType<typeof skillRegistryStaleness>) => Promise<unknown>} input.rebuild
 * @param {number} [input.intervalMs]
 * @param {() => number} [input.now]
 * @param {(error: Error) => void} [input.onError]
 * @returns {{ read: () => Promise<object[]>, ensureFresh: () => Promise<{ action: string, verdict?: object, error?: string }> }}
 */
export function createSkillRegistryReader({
  registryPath,
  catalogRoot,
  rebuild,
  intervalMs = SKILL_REGISTRY_CHECK_INTERVAL_MS,
  now = Date.now,
  onError = () => {}
}) {
  const rebuilding = new AsyncLocalStorage();
  let inFlight = null;
  let checkedKey = "";
  let checkedAt = -Infinity;
  let pathsKey = "";
  let paths = [];
  let givenUpKey = "";

  const keyOf = (info) => `${info.mtimeMs}:${info.size}`;

  async function verdictFor(info) {
    const key = keyOf(info);
    if (key !== pathsKey) {
      const items = await readSkillRegistryFile(registryPath);
      paths = (Array.isArray(items) ? items : []).map((item) => String(item?.path ?? "")).filter(Boolean);
      pathsKey = key;
    }
    return skillRegistryStaleness({ catalogRoot, builtAtMs: info.mtimeMs, paths, nowMs: now() });
  }

  async function runRebuild(verdict) {
    try {
      await rebuild(verdict);
    } catch (error) {
      const info = statOrUndefined(registryPath);
      givenUpKey = info ? keyOf(info) : "";
      onError(error instanceof Error ? error : new Error(String(error)));
      return { action: "failed", verdict, error: String(error?.message ?? error) };
    }
    const info = statOrUndefined(registryPath);
    if (!info) return { action: "rebuilt", verdict };
    const after = await verdictFor(info);
    checkedKey = keyOf(info);
    checkedAt = now();
    if (after.missing > 0) {
      givenUpKey = checkedKey;
      onError(new Error(`skill registry still out of date after a rebuild: ${after.examples.join("; ")}`));
    }
    return { action: "rebuilt", verdict };
  }

  async function ensureFresh() {
    if (rebuilding.getStore()) return { action: "current" };
    if (inFlight) return inFlight;
    const info = statOrUndefined(registryPath);
    if (!info) return { action: "absent" };
    const key = keyOf(info);
    if (key === checkedKey && now() - checkedAt < intervalMs) return { action: "current" };
    const verdict = await verdictFor(info);
    checkedKey = key;
    checkedAt = now();
    if (!verdict.stale) return { action: "current", verdict };
    if (key === givenUpKey) return { action: "stale", verdict };
    if (inFlight) return inFlight;
    inFlight = rebuilding.run(true, () => runRebuild(verdict)).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function read() {
    await ensureFresh();
    return readSkillRegistryFile(registryPath);
  }

  return { read, ensureFresh };
}
