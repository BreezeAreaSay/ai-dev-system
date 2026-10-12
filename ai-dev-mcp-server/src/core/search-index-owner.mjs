/**
 * Which search index file a vault reads and writes (docs/DEFECTS.md, Д-195).
 *
 * A runtime home keeps one index directory. Until 3.0 every vault served from
 * it wrote the same `ai-dev-search.sqlite`, and nothing in the file said which
 * vault it was built from: two clients with different `AI_DEV_VAULT_ROOT` took
 * turns rebuilding it, and a search in one vault answered with the notes of
 * the other.
 *
 * The file now belongs to the vault that claims it first. The claim is a small
 * file beside it, `ai-dev-search.sqlite.vault`, made in one step that only one
 * process can win; every other vault keeps an index of its own beside it,
 * `ai-dev-search-<12 hex of its root>.sqlite`. An index written before claims
 * existed is claimed by the first vault that opens it — after an upgrade, the
 * vault that has been using it, with its vectors.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
export function vaultIndexPath({ dir, vaultRoot, platform = process.platform }) {
  const defaultFile = path.join(dir, DEFAULT_INDEX_FILE);
  const claimFile = `${defaultFile}${CLAIM_SUFFIX}`;
  const mine = canonicalFolder(vaultRoot, platform);
  const same = (claimed) => canonicalFolder(claimed, platform) === mine;
  let owner = readClaim(claimFile);
  let reason = "own";
  if (owner === null) {
    // A claim that cannot be read is nobody's to share: the default file stays
    // with whoever wrote it, and this vault keeps its own.
    const outcome = fs.existsSync(claimFile) ? "taken" : claim(claimFile, path.resolve(vaultRoot));
    if (outcome === "unwritable") return { path: defaultFile, owner: "", reason: "unclaimed" };
    owner = outcome === "claimed" ? path.resolve(vaultRoot) : readClaim(claimFile);
    if (outcome === "claimed") reason = "claimed";
  }
  if (owner !== null && same(owner)) return { path: defaultFile, owner, reason };
  const digest = crypto.createHash("sha256").update(mine).digest("hex").slice(0, 12);
  return { path: path.join(dir, `ai-dev-search-${digest}.sqlite`), owner: owner ?? "", reason: "another-vault" };
}
