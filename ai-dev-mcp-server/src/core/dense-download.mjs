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
async function downloadOne({ url, target, expected, fetchImpl, log }) {
  const response = await fetchImpl(url, { redirect: "follow" });
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
  const temporary = `${target}.${process.pid}.part`;
  await fsp.rm(temporary, { force: true });
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
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
  env = process.env
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
          log
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
