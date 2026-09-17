/**
 * Fetching the pinned BGE-M3 export, one file at a time, and refusing anything
 * that is not byte-for-byte what the manifest says.
 *
 * Ported from the `scripts/models.mjs` of the snapshot branch, which had the
 * shape right and no home (docs/DEFECTS.md, Д-42): stream the body through a
 * sha256 tap, write to a `.part` file, and only rename over the target once the
 * digest matches. A half-written 600 MB weights file that looks finished is the
 * failure worth spending a rename on — it is indistinguishable from a good one
 * until the model fails to load, hours later, with a protobuf parse error.
 *
 * `fetch` is a parameter so the whole path — redirect, mismatch, truncated
 * body, a dead source falling through to the next — is tested against a local
 * `node:http` server rather than against huggingface.co.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File, verifyDenseModelDirectory } from "./dense-manifest.mjs";

/** How many bytes of a response we are willing to buffer for an error message. */
const ERROR_BODY_LIMIT = 200;

/**
 * Download one file to `target`, verifying its digest before it takes the name.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.target
 * @param {string} options.expected - Lowercase hex sha256.
 * @param {typeof fetch} options.fetchImpl
 * @param {(line: string) => void} options.log
 * @returns {Promise<number>} Bytes written.
 */
/**
 * No byte has arrived for this long, so the transfer is dead.
 *
 * A stalled CDN is not a slow one: the Windows acceptance run watched a
 * connection open, send 510 MB of 542, and then send nothing at all, with no
 * error and no end — `npm run setup -- --dense` sat there past ten minutes and
 * the tester killed it (docs/DEFECTS.md, Д-73). `fetch` has no timeout of its
 * own, so without this the wait is unbounded. The timer is re-armed by every
 * chunk, so a slow link is not cut off; only a silent one is.
 */
export const DOWNLOAD_STALL_MS = 60_000;

/** How long an abandoned `.part` file is left alone before it is swept. */
export const ORPHAN_PART_MAX_AGE_MS = 60 * 60_000;

/**
 * Delete `.part` files left behind for this target by runs that are gone.
 *
 * The temporary name carries the writer's pid so two installs cannot write the
 * same file, and it is removed in a `finally`. A process that is killed outright
 * — the sleep of a laptop, a Ctrl-C, the tester who gave up at ten minutes —
 * never reaches that `finally`, and the orphan is invisible to every later run
 * because the pid in its name is not theirs. Three of them piled up in one
 * macOS session (docs/DEFECTS.md, Д-73).
 *
 * Age is the guard rather than the pid: a `.part` written a minute ago may
 * belong to a download running right now in another terminal.
 *
 * @param {string} target - The final path, not the temporary one.
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {Promise<string[]>} The files removed.
 */
export async function sweepOrphanParts(target, { now = Date.now(), maxAgeMs = ORPHAN_PART_MAX_AGE_MS } = {}) {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  const removed = [];
  const entries = await fsp.readdir(directory).catch(() => []);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".part")) continue;
    const full = path.join(directory, entry);
    const stats = await fsp.stat(full).catch(() => null);
    if (!stats || now - stats.mtimeMs <= maxAgeMs) continue;
    await fsp.rm(full, { force: true }).catch(() => undefined);
    removed.push(entry);
  }
  return removed;
}

async function downloadOne({ url, target, expected, fetchImpl, log, stallMs = DOWNLOAD_STALL_MS }) {
  const controller = new AbortController();
  let stallTimer = null;
  let stalled = false;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  armStallTimer();
  try {
    return await transfer();
  } catch (error) {
    if (stalled) {
      throw new Error(
        `${path.basename(target)}: no data for ${Math.round(stallMs / 1000)}s. `
        + "The source accepted the connection and then stopped sending. "
        + "Run the command again — files that already match are skipped, so it picks up where it stopped."
      );
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }

  async function transfer() {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) {
      const detail = response.ok ? "no response body" : `HTTP ${response.status}`;
      let hint = "";
      try {
        hint = String(await response.text()).trim().slice(0, ERROR_BODY_LIMIT);
      } catch {
        hint = "";
      }
      throw new Error(`${url} returned ${detail}${hint ? `: ${hint}` : ""}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await sweepOrphanParts(target);
    const temporary = `${target}.${process.pid}.part`;
    await fsp.rm(temporary, { force: true });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        armStallTimer();
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      }
    });
    log(`downloading ${path.posix.normalize(String(url).split("/").slice(-1)[0])}`);
    try {
      await pipeline(Readable.fromWeb(response.body), tap, fs.createWriteStream(temporary, { flags: "wx" }));
      const actual = hash.digest("hex");
      if (actual !== expected) {
        // Said with both digests: a mismatch is either a truncated transfer or an
        // upstream that moved, and the two are told apart by comparing this hex
        // against what the manifest was generated from — not by rerunning.
        throw new Error(`checksum mismatch for ${path.basename(target)}: got ${actual}, manifest says ${expected}`);
      }
      await fsp.rename(temporary, target);
      return bytes;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Download every file the manifest names that is not already correct on disk.
 *
 * Files whose digest already matches are skipped, which makes the whole thing
 * idempotent and makes a resumed install cheap: re-running after a failure
 * re-fetches only what did not land. There is no byte-range resume — a partial
 * file is discarded rather than continued, because a `.part` file cannot prove
 * which revision its existing bytes came from.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.targetDir
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.log]
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {Promise<object>} The verification result for the finished directory.
 */
export async function downloadDenseModel({
  manifest,
  targetDir,
  fetchImpl = fetch,
  log = (line) => process.stderr.write(`${line}\n`),
  env = process.env,
  stallMs = DOWNLOAD_STALL_MS
} = {}) {
  if (String(env.AI_DEV_OFFLINE ?? "") === "1") {
    throw new Error("AI_DEV_OFFLINE=1 prevents downloads; point BGE_M3_ONNX_DIR at a verified model directory instead.");
  }
  const sources = manifest.sources ?? [];
  if (!sources.length) throw new Error("Dense model manifest lists no sources to download from.");
  const resolved = path.resolve(String(targetDir));
  let downloaded = 0;
  let bytes = 0;
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const target = path.join(resolved, relative);
    if (await sha256File(target) === digest) continue;
    let lastError = null;
    for (const source of sources) {
      try {
        bytes += await downloadOne({
          url: `${String(source).replace(/\/$/, "")}/${relative}`,
          target,
          expected: digest,
          fetchImpl,
          log,
          stallMs
        });
        lastError = null;
        downloaded += 1;
        break;
      } catch (error) {
        lastError = error;
        log(`source failed for ${relative}: ${error.message}`);
      }
    }
    if (lastError) throw new Error(`Could not fetch ${relative}: ${lastError.message}`);
  }
  // The manifest travels with the weights so the directory can name its own
  // revision later without re-hashing hundreds of megabytes.
  await fsp.mkdir(resolved, { recursive: true });
  await fsp.writeFile(path.join(resolved, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const status = await verifyDenseModelDirectory({ manifest, dir: resolved });
  return { ...status, downloaded, bytes };
}
