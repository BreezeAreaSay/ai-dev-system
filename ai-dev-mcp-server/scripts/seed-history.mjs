#!/usr/bin/env node
/**
 * Every version of a seed file a seed shipped before vaults kept a record of
 * their sync — what an old Docker volume can hold.
 *
 *   node scripts/seed-history.mjs            print what the history would hold
 *   node scripts/seed-history.mjs --write    write data/seed-history.json
 *   node scripts/seed-history.mjs --check    exit 1 when the file is not what git says
 *
 * 2.x images copied their seed into the volume with `cp -n` and kept no record
 * (docs/DEFECTS.md, Д-99). The sync that replaces it (`src/core/seed-sync.mjs`)
 * tells a file the user changed from one an update should replace by that
 * record; a 2.x volume has none, so every skill an older image left there would
 * look like the user's own, and none would ever be updated or removed. This
 * history is how the sync tells them apart: each (path, sha256) pair that any
 * commit of `docker/public-seed` held, minus the pairs the current manifest
 * lists, as the first 16 hex digits of `sha256("<path>\0<sha256>")`.
 *
 * It needs the repository's history, so it is run by hand when the seed of a
 * 2.x line changes (a fresh clone of CI has one commit): the file it writes is
 * what ships.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { SEED_HISTORY_FILE, seedHistoryKey } from "../src/core/seed-sync.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const SEED = "docker/public-seed";

function git(args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding, shell: false, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr || result.error?.message || "failed").trim()}`);
  return result.stdout;
}

/** The history as git has it, against the manifest in the working tree. */
export async function computeSeedHistory() {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("This clone is shallow: the seed's history is not in it. Run `git fetch --unshallow` first.");
  }
  const commits = git(["log", "--format=%H %h %ad", "--date=short", "--", SEED]).trim().split("\n").filter(Boolean);
  const blobSha = new Map();
  const pairs = new Set();
  for (const line of commits) {
    const [commit] = line.split(" ");
    for (const entry of git(["ls-tree", "-r", "--full-tree", commit, "--", SEED]).split("\n").filter(Boolean)) {
      const [meta, file] = entry.split("\t");
      const blob = meta.split(" ")[2];
      if (!blobSha.has(blob)) {
        blobSha.set(blob, crypto.createHash("sha256").update(git(["cat-file", "blob", blob], { encoding: "buffer" })).digest("hex"));
      }
      pairs.add(`${file.slice(SEED.length + 1)}\0${blobSha.get(blob)}`);
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, SEED, "public-seed.manifest.json"), "utf8"));
  for (const file of manifest.files) pairs.delete(`${file.path}\0${file.sha256}`);
  const keys = [...pairs].map((pair) => {
    const [relative, sha] = pair.split("\0");
    return seedHistoryKey(relative, sha);
  });
  const [last, first] = [commits[0], commits.at(-1)].map((line) => line.split(" ").slice(1).join(" "));
  return {
    schema_version: 1,
    $comment: "Every (path, sha256) a commit of docker/public-seed held that the current manifest does not list: what a 2.x volume's `cp -n` can have left. Written by scripts/seed-history.mjs; read by src/core/seed-sync.mjs.",
    key: "sha256 of `<path>\\0<sha256 of the file>`, first 16 hex digits",
    commits: commits.length,
    first,
    last,
    pairs: [...new Set(keys)].sort()
  };
}

if (await isDirectExecution(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? "";
    if (mode && !["--write", "--check"].includes(mode)) throw new Error(`Unknown argument: ${mode}`);
    const history = await computeSeedHistory();
    const text = `${JSON.stringify(history, null, 1)}\n`;
    if (mode === "--write") {
      await fs.mkdir(path.dirname(SEED_HISTORY_FILE), { recursive: true });
      await fs.writeFile(SEED_HISTORY_FILE, text, "utf8");
    } else if (mode === "--check") {
      const current = await fs.readFile(SEED_HISTORY_FILE, "utf8").catch(() => "");
      if (current !== text) {
        process.stderr.write(`${path.relative(repositoryRoot, SEED_HISTORY_FILE)} is not what git says: run \`node scripts/seed-history.mjs --write\`.\n`);
        process.exitCode = 1;
      }
    }
    process.stdout.write(`${JSON.stringify({ commits: history.commits, first: history.first, last: history.last, pairs: history.pairs.length, bytes: Buffer.byteLength(text) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
