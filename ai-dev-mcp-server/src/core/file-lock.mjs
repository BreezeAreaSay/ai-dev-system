import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process file locks for the files several processes write at once.
 *
 * Every MCP client starts its own server process, and the agent hooks run as
 * processes of their own, so the in-process queue in `atomic-files.mjs` cannot
 * order their writes: three writers appending 200 lines each kept about 210 of
 * the 600 (docs/DEFECTS.md, Д-96). A lock file beside the target serialises
 * them. `hooks/lib.mjs` carries a synchronous copy of this protocol — the hooks
 * run in other people's repositories without this package — and the two must
 * stay interchangeable: same lock path, same holder record, same staleness rule
 * (AGENTS.md, rule 3).
 *
 * The protocol:
 * - the lock is `<target>.lock`, created with `wx` (exclusive) and holding
 *   `{ pid, host, token, acquired_at }`;
 * - a holder is stale when its process is gone (same host) or the lock is older
 *   than {@link LOCK_STALE_MS} — locks are held for milliseconds, so that bound
 *   only ever fires for an abandoned one, including one whose pid was reused;
 * - a lock with no readable holder — its writer was killed between creating it
 *   and filling it in — is stale after {@link EMPTY_LOCK_GRACE_MS};
 * - a stale lock is broken by renaming it aside and checking that what was
 *   renamed is the holder that was judged stale, so two processes breaking the
 *   same abandoned lock cannot delete each other's fresh one;
 * - release deletes the lock only if it still carries this holder's token.
 */

/** Suffix of the lock file that sits beside the file it guards. */
export const LOCK_SUFFIX = ".lock";

/** A lock held longer than this is abandoned, whoever holds it. */
export const LOCK_STALE_MS = 30_000;

/**
 * How long a lock with no readable holder counts as live. Creating the lock and
 * writing its holder are two system calls; a writer killed between them leaves
 * an empty lock nobody can attribute, and one that has been empty this long was
 * left by exactly that.
 */
export const EMPTY_LOCK_GRACE_MS = 2_000;

/** How long a writer waits for a live holder before giving up. */
export const LOCK_TIMEOUT_MS = 15_000;

const MAX_BACKOFF_MS = 50;

/**
 * Path of the lock file guarding `filePath`.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function lockPathFor(filePath) {
  return `${path.resolve(filePath)}${LOCK_SUFFIX}`;
}

/**
 * Whether a process with this pid is running on this machine. `EPERM` means it
 * exists and belongs to someone else, which still counts as alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Is the lock described by `holder` still owned by a live writer?
 *
 * An unreadable or half-written holder (the creator is between `open` and
 * `write`, or was killed there) is judged by the lock file's own age against
 * {@link EMPTY_LOCK_GRACE_MS} instead.
 *
 * @param {{ holder: object|null, mtimeMs: number }} observed
 * @param {{ now?: number, staleMs?: number, emptyGraceMs?: number, host?: string, alive?: (pid: number) => boolean }} [options]
 * @returns {boolean}
 */
export function lockIsLive(observed, { now = Date.now(), staleMs = LOCK_STALE_MS, emptyGraceMs = EMPTY_LOCK_GRACE_MS, host = os.hostname(), alive = processAlive } = {}) {
  const holder = observed?.holder;
  if (!holder || typeof holder !== "object") {
    return now - Number(observed?.mtimeMs || 0) < emptyGraceMs;
  }
  if (now - Number(holder.acquired_at || 0) >= staleMs) return false;
  if (holder.host && holder.host !== host) return true;
  return alive(Number(holder.pid));
}

async function readHolder(lockPath) {
  let text;
  let stat;
  try {
    stat = await fs.stat(lockPath);
    text = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let holder = null;
  try {
    holder = JSON.parse(text);
  } catch {
    holder = null;
  }
  return { holder, mtimeMs: stat.mtimeMs };
}

/**
 * Remove an abandoned lock without ever removing a fresh one.
 *
 * The lock is renamed to a name only this process uses; if what was renamed is
 * not the holder judged stale (another writer broke it and took a new lock in
 * between), it is linked back so that writer keeps its lock.
 */
async function breakStaleLock(lockPath, observed) {
  const aside = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const taken = await readHolder(aside);
  const sameHolder = (taken?.holder?.token ?? null) === (observed?.holder?.token ?? null);
  if (!sameHolder) {
    await fs.link(aside, lockPath).catch(() => undefined);
  }
  await fs.rm(aside, { force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the lock for `filePath`, waiting for a live holder and breaking an
 * abandoned one.
 *
 * @param {string} filePath - The file the lock guards (not the lock itself).
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<() => Promise<void>>} release
 */
export async function acquireFileLock(filePath, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = lockPathFor(filePath);
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token, acquired_at: Date.now() }));
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readHolder(lockPath).catch(() => null);
        if (current?.holder?.token === token) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      // Windows answers EPERM for a lock file another process is deleting.
      if (error?.code !== "EEXIST" && !(process.platform === "win32" && error?.code === "EPERM")) throw error;
    }
    const observed = await readHolder(lockPath);
    if (observed && !lockIsLive(observed, { staleMs })) {
      await breakStaleLock(lockPath, observed);
      continue;
    }
    if (Date.now() >= deadline) {
      const owner = observed?.holder?.pid ? ` (held by pid ${observed.holder.pid})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the lock ${lockPath}${owner}.`);
    }
    await sleep(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Run `operation` while holding the cross-process lock for `filePath`.
 *
 * Not re-entrant: an operation must not take the same lock again.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(filePath, operation, options = {}) {
  const release = await acquireFileLock(filePath, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
