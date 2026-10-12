/**
 * The files a target ships, read from the one allowlist every target shares.
 *
 * `npm run dist` (the folder the npm package and the Windows installer are
 * made from) and `npm run docker:prepare` (the image's build context) used to
 * list their files in their own code, and the lists drifted: a file one target
 * needed was missing from another until a user hit it (docs/DEFECTS.md, Д-37,
 * Д-38, Д-56, Д-57). `distribution.allowlist.json` names the groups once; each
 * target maps a group to the folder it lands in, or leaves it out.
 *
 * No dependency beyond Node: the image's publish job and `bootstrap.sh` build
 * the context before any `npm ci`.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Where the allowlist sits, relative to the repository root. */
export const ALLOWLIST_PATH = path.join("ai-dev-mcp-server", "distribution.allowlist.json");

/**
 * A glob as a regular expression over `/`-separated relative paths: `**`
 * spans folders, `*` and `?` stay within one name.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` matches no folder too: `**/*.test.mjs` takes `a.test.mjs` at the top.
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const GLOB = /[*?]/;

/** Every file under `directory`, as `/`-separated paths relative to `root`. Links are refused, not followed. */
async function walk(root, directory, found) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`${full} is a link; a distribution ships files, not links.`);
    if (entry.isDirectory()) await walk(root, full, found);
    else if (entry.isFile()) found.push(relative);
  }
}

async function isFile(file) {
  return fs.stat(file).then((stat) => stat.isFile(), () => false);
}

/**
 * The files of one group, relative to its `from`.
 *
 * @param {string} root - The group's `from`, absolute.
 * @param {{ name: string, include?: string[], exclude?: string[], manifest?: string }} group
 * @returns {Promise<string[]>}
 */
async function groupFiles(root, group) {
  if (group.manifest) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, group.manifest), "utf8"));
    const listed = Array.isArray(manifest.files) ? manifest.files.map((item) => String(item.path)) : [];
    return [group.manifest, ...listed];
  }
  const exclude = (group.exclude ?? []).map(globToRegExp);
  const files = new Set();
  for (const pattern of group.include ?? []) {
    const matched = [];
    if (!GLOB.test(pattern)) {
      if (await isFile(path.join(root, pattern))) matched.push(pattern);
    } else {
      // Walk only the folder the pattern starts with, not the whole tree.
      const segments = pattern.split("/");
      const fixed = segments.slice(0, segments.findIndex((segment) => GLOB.test(segment))).join("/");
      const listed = [];
      await walk(root, path.join(root, fixed), listed);
      const regex = globToRegExp(pattern);
      matched.push(...listed.filter((relative) => regex.test(relative)));
    }
    const kept = matched.filter((relative) => !exclude.some((regex) => regex.test(relative)));
    // A pattern that matches nothing is a file renamed or moved out from under
    // the allowlist: the target would ship without it, so the build stops.
    if (!kept.length) throw new Error(`The ${group.name} pattern "${pattern}" matches no file under ${root}.`);
    for (const relative of kept) files.add(relative);
  }
  return [...files];
}

/**
 * Read the allowlist.
 *
 * @param {string} repositoryRoot
 * @returns {Promise<{ schema_version: number, groups: object[] }>}
 */
export async function readAllowlist(repositoryRoot) {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, ALLOWLIST_PATH), "utf8"));
}

/**
 * What a target ships: each file's source and where it lands, sorted by the
 * latter. Two groups landing one file at the same place stop the plan.
 *
 * @param {object} input
 * @param {string} input.repositoryRoot
 * @param {"dist"|"docker"} input.target
 * @param {{ groups: object[] }} [input.allowlist]
 * @returns {Promise<Array<{ group: string, source: string, destination: string }>>}
 */
export async function planDistribution({ repositoryRoot, target, allowlist }) {
  const list = allowlist ?? await readAllowlist(repositoryRoot);
  const plan = [];
  const seen = new Map();
  for (const group of list.groups ?? []) {
    const to = group.to?.[target];
    if (to === undefined) continue;
    const root = path.resolve(repositoryRoot, group.from);
    for (const relative of await groupFiles(root, group)) {
      const destination = path.posix.normalize(path.posix.join(to, relative));
      if (destination.startsWith("../") || path.posix.isAbsolute(destination)) {
        throw new Error(`The ${group.name} file ${relative} would land outside the ${target} folder.`);
      }
      if (seen.has(destination)) throw new Error(`${destination} comes from both the ${seen.get(destination)} and the ${group.name} groups.`);
      seen.set(destination, group.name);
      plan.push({ group: group.name, source: path.join(root, ...relative.split("/")), destination });
    }
  }
  return plan.sort((left, right) => (left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0));
}
