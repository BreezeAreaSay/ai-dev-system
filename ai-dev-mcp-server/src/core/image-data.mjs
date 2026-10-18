/**
 * The data the image is built with, and the first start of a volume made from it.
 *
 * What a first start builds — the seed in the vault, the skill registry, the
 * quality report, the search index, the routing benchmark — is built when the
 * image is, in its `/data`, and Docker copies that into each new named volume.
 * Freshness is judged by time, and two things on the way move time:
 *
 * - an image layer keeps a file's time to the second, so a registry written in
 *   the same second as the skills it was built from came out as old as they are,
 *   and the index's own record of each document's time (to the nanosecond)
 *   stopped matching — a fresh volume rebuilt everything on its first start;
 * - the copy into a new volume gives each folder the time of the copy, and a
 *   folder above a skill that is newer than the registry means a skill was added
 *   or removed (`skill-registry-freshness.mjs`).
 *
 * So the build dates the seed a minute back before anything is built from it,
 * then rounds every time down to the second and rebuilds what that made stale;
 * the image records the seed's time beside the data ({@link PREPARED_MARKER}),
 * and the first start of a volume that still carries the record gives the
 * skill folders that time back, then removes it.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Beside the image's data: the time the seed was dated to. Removed by the first start. */
export const PREPARED_MARKER = ".ai-dev-image-data.json";

/** The folders whose times say whether a skill was added or removed. */
export const SKILL_SOURCES = ["03-skills-catalog", "sources"];

/** Every file and folder below `root` (only the folders, when asked), folders after what is in them; links are not followed. */
async function entries(root, { folders = false } = {}) {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        found.push(full);
      } else if (entry.isFile() && !folders) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * Give every file and folder below `root`, and `root` itself, one time.
 *
 * @param {string} root
 * @param {number} seconds - Seconds since the epoch.
 * @returns {Promise<number>} How many were dated.
 */
export async function dateTree(root, seconds) {
  const all = [...await entries(root), root];
  for (const target of all) await fs.utimes(target, seconds, seconds);
  return all.length;
}

/**
 * Round every time below `root` down to the second, as an image layer keeps it,
 * so what is judged at build is what the volume will hold.
 *
 * @param {string} root
 * @returns {Promise<number>} How many times changed.
 */
export async function settleTimes(root) {
  let changed = 0;
  for (const target of [...await entries(root), root]) {
    const stat = await fs.stat(target);
    const seconds = Math.floor(stat.mtimeMs / 1000);
    if (seconds * 1000 === stat.mtimeMs) continue;
    await fs.utimes(target, seconds, seconds);
    changed += 1;
  }
  return changed;
}

/**
 * Record, beside the data, the time the seed was dated to.
 *
 * @param {string} dataRoot - `/data`.
 * @param {{ seconds: number, version?: string }} record
 */
export async function writePreparedMarker(dataRoot, { seconds, version = "" }) {
  await fs.writeFile(path.join(dataRoot, PREPARED_MARKER), `${JSON.stringify({ schema_version: 1, seed_dated: seconds, version })}\n`);
}

/**
 * On a volume's first start from the image's data: give the skill folders the
 * time the build dated them to, which the copy into the volume replaced, then
 * remove the record. A record that does not parse, or names no time, dates
 * nothing and goes too: the first start then judges and rebuilds as it would on
 * any volume. So does a container that may not date the folders: one run as
 * another user than the image's (`--user`, on Linux) owns none of them, and
 * without CAP_FOWNER only the owner sets a file's times.
 *
 * @param {{ dataRoot: string, vaultRoot: string }} input
 * @returns {Promise<{ restored: boolean, dated: number, refused?: string }>}
 */
export async function restorePreparedTimes({ dataRoot, vaultRoot }) {
  const marker = path.join(dataRoot, PREPARED_MARKER);
  const text = await fs.readFile(marker, "utf8").catch(() => null);
  if (text === null) return { restored: false, dated: 0 };
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    // Not one the build wrote: nothing to date by, and nothing to keep.
  }
  if (!record) {
    await fs.rm(marker, { force: true });
    return { restored: false, dated: 0 };
  }
  const seconds = Number(record.seed_dated);
  let dated = 0;
  if (Number.isFinite(seconds) && seconds > 0) {
    const sources = path.join(vaultRoot, ...SKILL_SOURCES);
    if (await fs.stat(sources).then((stat) => stat.isDirectory(), () => false)) {
      for (const folder of [...await entries(sources, { folders: true }), sources]) {
        try {
          await fs.utimes(folder, seconds, seconds);
        } catch (error) {
          if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
          await fs.rm(marker, { force: true });
          return { restored: true, dated, refused: `${error.code}: not this user's to date` };
        }
        dated += 1;
      }
    }
  }
  await fs.rm(marker, { force: true });
  return { restored: true, dated };
}
