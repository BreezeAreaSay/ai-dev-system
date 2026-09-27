/**
 * Where a project's dependency trees are.
 *
 * A package manager's audit reads the lockfile in the directory it runs in, so
 * a repository whose `frontend/` and `backend/` each have one — and nothing at
 * the root — used to get no dependency scan at all (docs/DEFECTS.md, Д-83).
 * This module finds those directories, and says which Yarn a directory uses,
 * because Yarn 1 and Yarn 2+ audit with different commands.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** How far below the root a package manager's lockfile is looked for. */
export const LOCKFILE_SEARCH_DEPTH = 2;

/**
 * Directories never searched for lockfiles: installed trees, build output,
 * and fixtures that are lockfiles on purpose.
 */
export const LOCKFILE_SEARCH_SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "fixtures", "__fixtures__", "bower_components"]);

async function pathExists(target) {
  return fs.stat(target).then(() => true).catch(() => false);
}

/**
 * Yarn 1 and Yarn 2+ audit with different commands and print different
 * reports. The project says which it is: a `packageManager` of `yarn@2` or
 * later, or a `.yarnrc.yml`, is Yarn 2+; anything else is Yarn 1.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function yarnAuditArgs(directory) {
  const manifest = await fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const declared = /^yarn@(\d+)/.exec(String(manifest?.packageManager ?? ""));
  const berry = declared ? Number(declared[1]) >= 2 : await pathExists(path.join(directory, ".yarnrc.yml"));
  return berry ? ["npm", "audit", "--all", "--recursive", "--json"] : ["audit", "--json"];
}

/**
 * Every directory, from the root down {@link LOCKFILE_SEARCH_DEPTH} levels,
 * that holds one of the markers. Hidden directories, installed trees, build
 * output and fixtures are not searched; symbolic links are not followed.
 *
 * @param {string} projectRoot
 * @param {string[]} markers
 * @param {number} [depth]
 * @returns {Promise<string[]>}
 */
export async function markerDirectories(projectRoot, markers, depth = LOCKFILE_SEARCH_DEPTH) {
  const found = [];
  async function visit(directory, level) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && markers.includes(entry.name))) found.push(directory);
    if (level >= depth) return;
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !LOCKFILE_SEARCH_SKIP.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of children) await visit(path.join(directory, name), level + 1);
  }
  await visit(projectRoot, 0);
  return found;
}
