/**
 * Which search index file a vault reads and writes (docs/DEFECTS.md, Д-195).
 *
 * A runtime home keeps one index directory. Until 3.0 every vault served from
 * it wrote the same `ai-dev-search.sqlite`, and nothing in the file said which
 * vault it was built from: two clients with different `AI_DEV_VAULT_ROOT` took
 * turns rebuilding it, and a search in one vault answered with the notes of
 * the other.
 *
 * The file now belongs to one vault, named by a claim beside it,
 * `ai-dev-search.sqlite.vault`, made in one step that only one process can
 * win; every other vault keeps an index of its own beside it,
 * `ai-dev-search-<12 hex of its root>.sqlite`. An index written before claims
 * existed goes only to the vault it was built from — the one its `meta` names,
 * or, for a 2.x index that names none, the one whose notes are the very files
 * it indexed — so after an upgrade the vault that has been using it keeps it,
 * with its vectors, whichever process starts first: a command run from a
 * shell with another vault does not take it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { noteIdentity } from "./search-documents.mjs";
import { loadSqlite, sqliteSupport } from "./search-sqlite.mjs";
import { canonicalFolder } from "./session-env.mjs";

/** The index file a runtime home has always had. */
export const DEFAULT_INDEX_FILE = "ai-dev-search.sqlite";

/** What names the vault an index file belongs to: `<index file><suffix>`. */
export const CLAIM_SUFFIX = ".vault";

/**
 * The vault a claim names, or null when there is no claim or it is unreadable.
 *
 * @param {string} claimFile
 * @returns {string | null} the vault root as it was claimed
 */
function readClaim(claimFile) {
  try {
    const vault = JSON.parse(fs.readFileSync(claimFile, "utf8"))?.vault_root;
    return typeof vault === "string" && vault ? vault : null;
  } catch {
    return null;
  }
}

/**
 * Claim `claimFile` for `vaultRoot`, unless another process has: the claim is
 * written whole under another name and then linked into place, which fails
 * when the name exists — so a claim is never seen half written.
 *
 * @returns {"claimed" | "taken" | "unwritable"}
 */
function claim(claimFile, vaultRoot) {
  const body = `${JSON.stringify({ vault_root: vaultRoot, claimed_at: new Date().toISOString() })}\n`;
  const draft = `${claimFile}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(draft, body, { flag: "wx", mode: 0o600 });
  } catch {
    return "unwritable";
  }
  try {
    fs.linkSync(draft, claimFile);
    return "claimed";
  } catch (error) {
    if (error?.code === "EEXIST") return "taken";
    // A file system without hard links: create it exclusively instead.
    try {
      fs.writeFileSync(claimFile, body, { flag: "wx", mode: 0o600 });
      return "claimed";
    } catch (fallback) {
      return fallback?.code === "EEXIST" ? "taken" : "unwritable";
    }
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

/** How many of an index's notes are looked at in a vault to tell whether it was built from it. */
const SAMPLE_NOTES = 200;

/**
 * Which vault an index file not yet claimed was built from, as far as it
 * says: `this`, `another`, or `unknown` — no documents to tell by, or not an
 * index at all, which the search runtime sets aside and builds again.
 *
 * @param {string} file
 * @param {string} vaultRoot
 * @param {(left: string, right: string) => boolean} same
 * @returns {"this" | "another" | "unknown"}
 */
export function indexOrigin(file, vaultRoot, same) {
  if (!sqliteSupport().available) return "unknown";
  let db;
  try {
    db = new (loadSqlite().DatabaseSync)(file, { readOnly: true });
    const recorded = db.prepare("SELECT value FROM meta WHERE key = 'vault_root'").get()?.value;
    if (recorded) return same(String(recorded), vaultRoot) ? "this" : "another";
    // A 2.x index names no vault. The notes it was built from are the files
    // whose content and modification time it recorded; the same notes in
    // another vault — a copy of the seed, a clone, the skill catalog every
    // vault has — are other files, with times of their own, and a note of the
    // same name written in the same instant has other content. That a path
    // exists says nothing: a vault sharing the catalog took the index that way
    // (docs/DEFECTS.md, Д-219). The sample is spread over the table by id.
    const notes = db.prepare("SELECT path, mtime, content_hash FROM documents WHERE source = 'vault-note' ORDER BY id LIMIT ?").all(SAMPLE_NOTES)
      .filter((row) => {
        const relative = String(row.path ?? "");
        return relative && !path.isAbsolute(relative) && !path.win32.isAbsolute(relative);
      });
    if (!notes.length) return "unknown";
    // Notes deleted since — a pull that removed half the catalog — say
    // nothing either way; of those still there, the vault it was built from
    // has kept most as they were (a pull rewrites only what it changes).
    let present = 0;
    let unchanged = 0;
    for (const row of notes) {
      const note = noteIdentity(vaultRoot, String(row.path));
      if (!note) continue;
      present += 1;
      if (note.contentHash === row.content_hash && Math.abs(note.mtime - Number(row.mtime)) < 1e-6) unchanged += 1;
    }
    // In doubt — nothing of it here, or most of it other files — a file of
    // its own rather than another vault's index.
    return present > 0 && unchanged * 2 >= present ? "this" : "another";
  } catch {
    return "unknown";
  } finally {
    db?.close();
  }
}

/**
 * The index file of `vaultRoot` in `dir`.
 *
 * @param {object} options
 * @param {string} options.dir - The index directory (`AI_DEV_SEARCH_INDEX_DIR`, or the runtime home's).
 * @param {string} options.vaultRoot
 * @param {string} [options.platform]
 * @returns {{ path: string, owner: string, reason: "own" | "claimed" | "another-vault" | "unclaimed" }}
 *   `owner`: the vault the default file belongs to, as claimed; `unclaimed`:
 *   no claim could be written here — a read-only directory — so the default
 *   file is used as before.
 */
export function vaultIndexPath({ dir, vaultRoot, platform = process.platform, origin = indexOrigin }) {
  const defaultFile = path.join(dir, DEFAULT_INDEX_FILE);
  const claimFile = `${defaultFile}${CLAIM_SUFFIX}`;
  const mine = canonicalFolder(vaultRoot, platform);
  const same = (left, right) => canonicalFolder(left, platform) === canonicalFolder(right, platform);
  const ownFile = () => path.join(dir, `ai-dev-search-${crypto.createHash("sha256").update(mine).digest("hex").slice(0, 12)}.sqlite`);
  let owner = readClaim(claimFile);
  let reason = "own";
  if (owner === null) {
    // A claim that cannot be read is nobody's to share: the default file stays
    // with whoever wrote it, and this vault keeps its own.
    if (fs.existsSync(claimFile)) return { path: ownFile(), owner: "", reason: "another-vault" };
    // An index from before claims, built from another vault, is left to it.
    if (fs.existsSync(defaultFile) && origin(defaultFile, vaultRoot, same) === "another") {
      return { path: ownFile(), owner: "", reason: "another-vault" };
    }
    const outcome = claim(claimFile, path.resolve(vaultRoot));
    if (outcome === "unwritable") return { path: defaultFile, owner: "", reason: "unclaimed" };
    owner = outcome === "claimed" ? path.resolve(vaultRoot) : readClaim(claimFile);
    if (outcome === "claimed") reason = "claimed";
  }
  if (owner !== null && same(owner, vaultRoot)) return { path: defaultFile, owner, reason };
  return { path: ownFile(), owner: owner ?? "", reason: "another-vault" };
}
