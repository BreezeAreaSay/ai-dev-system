import fs from "node:fs/promises";
import path from "node:path";
import { explicitRuntimeHome, legacyDoubledRuntimeRoot, resolveRuntimeStateRoot, resolveUserHome } from "./runtime-home.mjs";
import { atomicWriteFile, atomicWriteJson, withExclusiveFile } from "./atomic-files.mjs";
import { withFileLock } from "./file-lock.mjs";

/**
 * Two clients starting at once both run the migration; the second waits for
 * the first rather than racing it — racing, it read a JSONL ledger the first
 * was merging and merged it again, or aborted on a file the first had moved.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/** Link errors that mean "this filesystem or this pair of paths cannot hard-link", not "the destination exists". */
const LINK_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EINVAL"]);

/**
 * Move what 2.x wrote into `<AI_DEV_HOME>/.ai-dev` up into `<AI_DEV_HOME>`.
 *
 * Before 3.0 the code appended `.ai-dev` to `AI_DEV_HOME` while every document
 * and the Docker image treated the variable as the runtime folder itself, so the
 * data of everyone who set it landed one level deeper than they were told
 * (docs/DEFECTS.md, Д-90). The owner's decision D2 keeps the documented meaning;
 * this moves the data to match. Nothing is lost:
 *
 * - a file or link that does not exist at the destination is moved — never
 *   over one that appears meanwhile;
 * - an identical file is dropped from the old tree;
 * - a JSONL ledger is merged into the one already there, in time order;
 * - anything else that exists on both sides stays where it is, and is reported;
 * - an entry that cannot be moved (another disk, a file in use) stays where it
 *   is, is reported with its error, and the rest of the tree moves anyway.
 *
 * Re-running is safe; a 2.x hook that still writes the old tree is picked up by
 * the next run.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "not-applicable"|"clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, conflicts: string[], errors: Array<{ path: string, code: string, message: string }> }>}
 */
export async function migrateDoubledRuntimeHome({ env = process.env, now = () => new Date() } = {}) {
  const empty = () => ({ moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] });
  const legacy = legacyDoubledRuntimeRoot(env);
  if (!legacy) return { status: "not-applicable", ...empty() };
  if (!(await isDirectory(legacy))) return { status: "clean", ...empty() };
  const target = resolveRuntimeStateRoot("", env);
  return withFileLock(legacy, async () => {
    // The process that held the lock before may have moved everything.
    if (!(await isDirectory(legacy))) return { status: "clean", ...empty() };
    const counts = empty();
    await mergeTree(legacy, target, legacy, counts);
    await removeEmptyDirectories(legacy);
    const result = { status: "migrated", from: legacy, to: target, ...counts };
    if (counts.moved || counts.merged || counts.duplicates || counts.conflicts.length || counts.errors.length) {
      await recordMigration(target, { ...result, at: now().toISOString() });
    }
    return result;
  }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
}

/**
 * Where 2.x kept AI Dev's data under `~/.codex`, by the variable that names each
 * place now. The runtime that came with Codex desktop kept it there, and 2.x
 * read a `~/.codex` folder whenever its `~/.ai-dev` twin did not exist yet — so
 * the first hook, or `ai-dev clients install`, that created `~/.ai-dev/state`
 * made the server leave the Codex-era tasks and sessions behind without a word,
 * while the hooks had never read them at all (docs/DEFECTS.md, Д-104). Only
 * these folders are AI Dev's; the rest of `~/.codex` is Codex's own and stays.
 */
export const CODEX_LEGACY_FOLDERS = Object.freeze([
  { variable: "AI_DEV_STATE_ROOT", from: ["state", "ai-dev-system"], to: ["state"] },
  { variable: "AI_DEV_ARCHIFY_RECEIPTS_ROOT", from: ["state", "archify-receipts"], to: ["state", "archify-receipts"] },
  { variable: "AI_DEV_SEARCH_INDEX_DIR", from: ["cache", "ai-dev-system", "search-index"], to: ["cache", "search-index"] },
  { variable: "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT", from: ["artifacts", "frontend-qa"], to: ["artifacts", "frontend-qa"] },
  { variable: "AI_DEV_ARCHIFY_ARTIFACT_ROOT", from: ["artifacts", "archify"], to: ["artifacts", "archify"] },
  { variable: "BGE_M3_ONNX_DIR", from: ["models", "bge-m3-onnx"], to: ["models", "bge-m3-onnx"] }
]);

/** The `~/.codex` folders of AI Dev's that this environment would read, existing or not. */
function codexLegacyFolders(env) {
  const codex = path.join(resolveUserHome("", env), ".codex");
  const target = resolveRuntimeStateRoot("", env);
  // A place named by its variable was never looked for in ~/.codex.
  return CODEX_LEGACY_FOLDERS.filter((folder) => !env[folder.variable]).map((folder) => ({
    ...folder,
    codex,
    source: path.join(codex, ...folder.from),
    destination: path.join(target, ...folder.to)
  }));
}

/**
 * Move AI Dev's Codex-era folders from `~/.codex` into the runtime tree, once.
 * The same rules as {@link migrateDoubledRuntimeHome}: nothing is replaced,
 * identical files are dropped, JSONL ledgers are merged, anything else on both
 * sides stays in `~/.codex` and is reported; the move is recorded.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, conflicts: string[], errors: Array<{ path: string, code: string, message: string }> }>}
 */
export async function migrateCodexRuntime({ env = process.env, now = () => new Date() } = {}) {
  const empty = () => ({ moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] });
  const present = async () => {
    const found = [];
    for (const folder of codexLegacyFolders(env)) if (await isDirectory(folder.source)) found.push(folder);
    return found;
  };
  if (!(await present()).length) return { status: "clean", ...empty() };
  const target = resolveRuntimeStateRoot("", env);
  await fs.mkdir(target, { recursive: true });
  return withFileLock(path.join(target, "codex-migration"), async () => {
    // The process that held the lock before may have moved everything.
    const folders = await present();
    if (!folders.length) return { status: "clean", ...empty() };
    const counts = empty();
    for (const folder of folders) {
      await mergeTree(folder.source, folder.destination, folder.codex, counts);
      await removeEmptyDirectories(folder.source);
    }
    const result = { status: "migrated", kind: "codex", from: folders[0].codex, to: target, ...counts };
    if (counts.moved || counts.merged || counts.duplicates || counts.conflicts.length || counts.errors.length) {
      await recordMigration(target, { ...result, at: now().toISOString() });
    }
    return result;
  }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
}

async function isDirectory(candidate) {
  return fs.stat(candidate).then((stat) => stat.isDirectory()).catch(() => false);
}

/**
 * Byte-for-byte equality, sizes first and then in chunks: a legacy model file
 * is 2.3 GB, and reading both copies whole failed past 2 GiB (ERR_FS_FILE_TOO_LARGE).
 */
async function sameContent(left, right) {
  const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (a.size !== b.size) return false;
  const [first, second] = await Promise.all([fs.open(left, "r"), fs.open(right, "r")]);
  try {
    const one = Buffer.alloc(1 << 20);
    const two = Buffer.alloc(1 << 20);
    for (let position = 0; position < a.size;) {
      const [{ bytesRead: read }, { bytesRead: readToo }] = await Promise.all([
        first.read(one, 0, one.length, position),
        second.read(two, 0, two.length, position)
      ]);
      if (read !== readToo || !one.subarray(0, read).equals(two.subarray(0, readToo))) return false;
      if (read === 0) break;
      position += read;
    }
    return true;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

async function mergeTree(sourceDir, targetDir, legacyRoot, counts) {
  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
    await fs.mkdir(targetDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") counts.errors.push(entryError(legacyRoot, sourceDir, error));
    return;
  }
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    try {
      if (entry.isDirectory()) await mergeTree(source, destination, legacyRoot, counts);
      else if (entry.isFile() || entry.isSymbolicLink()) await mergeEntry(source, destination, entry, legacyRoot, counts);
      // A socket or a pipe a 2.x daemon left behind is not data.
    } catch (error) {
      if (error?.code !== "ENOENT") counts.errors.push(entryError(legacyRoot, source, error));
    }
  }
}

function entryError(legacyRoot, file, error) {
  return { path: path.relative(legacyRoot, file) || ".", code: String(error?.code ?? ""), message: String(error?.message ?? error).slice(0, 240) };
}

async function mergeEntry(source, destination, entry, legacyRoot, counts) {
  const existing = await fs.lstat(destination).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (!existing) {
    try {
      await moveWithoutReplacing(source, destination, entry);
      counts.moved += 1;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Something wrote the destination meanwhile: judge it like any other pair.
      return mergeEntry(source, destination, entry, legacyRoot, counts);
    }
  }
  if (entry.isFile() && existing.isFile()) {
    if (await sameContent(source, destination)) {
      await fs.rm(source, { force: true });
      counts.duplicates += 1;
      return;
    }
    if (entry.name.endsWith(".jsonl")) {
      await mergeJsonl(source, destination);
      counts.merged += 1;
      return;
    }
  }
  counts.conflicts.push(path.relative(legacyRoot, source));
}

/**
 * Move a file or a link to a destination that does not exist, without ever
 * replacing one that appears in between: a hard link fails with EEXIST where a
 * rename would overwrite. Links themselves, and filesystems that cannot
 * hard-link, are renamed after one more check. Across disks both fail with
 * EXDEV, and the entry is reported rather than copied behind the user's back.
 */
async function moveWithoutReplacing(source, destination, entry) {
  if (entry.isFile()) {
    try {
      await fs.link(source, destination);
      await fs.unlink(source);
      return;
    } catch (error) {
      if (!LINK_UNSUPPORTED.has(error?.code) || error?.code === "EXDEV") throw error;
    }
  }
  const present = await fs.lstat(destination).then(() => true, (error) => (error?.code === "ENOENT" ? false : Promise.reject(error)));
  if (present) throw Object.assign(new Error(`${destination} appeared meanwhile`), { code: "EEXIST" });
  await fs.rename(source, destination);
}

/**
 * The ISO time a ledger record carries, or NaN. Only ISO strings count: V8's
 * `Date.parse` reads "old-1" as 1 January 2001.
 */
function recordTime(line) {
  try {
    const record = JSON.parse(line);
    const value = record.at ?? record.timestamp ?? record.ts ?? record.time ?? record.created_at;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function isJson(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** Complete records only: a last line without its newline that does not parse was cut off by a killed writer. */
function ledgerLines(text) {
  const lines = text.split("\n");
  const tail = lines.pop();
  if (tail && isJson(tail)) lines.push(tail);
  return lines.filter((line) => line.trim());
}

/**
 * Two append-only ledgers as one, in time order: each is already ordered, so
 * this is a merge, and a record without a time keeps its place before the
 * newer ledger's. Appending the old ledger after the new one put 2.x's records
 * last, and the ledger's pruning, which keeps the last lines, dropped the
 * newest ones first.
 *
 * @param {string} older - The 2.x ledger.
 * @param {string} current - The one already at the destination.
 * @returns {string}
 */
export function mergeLedgers(older, current) {
  const left = ledgerLines(older);
  const right = ledgerLines(current);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length) merged.push(left[i++]);
    else if (i >= left.length) merged.push(right[j++]);
    else if (recordTime(right[j]) < recordTime(left[i])) merged.push(right[j++]);
    else merged.push(left[i++]);
  }
  return merged.length ? `${merged.join("\n")}\n` : "";
}

/** Merge the 2.x ledger into the current one under the ledger's own lock, which every writer takes. */
async function mergeJsonl(source, destination) {
  await withExclusiveFile(destination, async () => {
    const [older, current] = await Promise.all([fs.readFile(source, "utf8"), fs.readFile(destination, "utf8").catch(() => "")]);
    await atomicWriteFile(destination, mergeLedgers(older, current));
    await fs.rm(source, { force: true });
  });
}

async function removeEmptyDirectories(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
  }
  if ((await fs.readdir(directory).catch(() => ["keep"])).length === 0) {
    await fs.rmdir(directory).catch(() => undefined);
  }
}

/** Where `doctor` reads what the last migration did. */
export function migrationRecordPath(runtimeRoot) {
  return path.join(runtimeRoot, "state", "runtime-home-migration.json");
}

async function recordMigration(runtimeRoot, entry) {
  const target = migrationRecordPath(runtimeRoot);
  await withExclusiveFile(target, async () => {
    const history = (await readMigrationRecord(runtimeRoot)).history;
    history.push(entry);
    await atomicWriteJson(target, { schema_version: 1, history: history.slice(-20) });
  });
}

/**
 * What earlier migrations did, newest last.
 *
 * @param {string} runtimeRoot
 * @returns {Promise<{ history: object[] }>}
 */
export async function readMigrationRecord(runtimeRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(migrationRecordPath(runtimeRoot), "utf8"));
    return { history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch {
    return { history: [] };
  }
}

let prepared = null;

/**
 * Bring the runtime tree to the layout this version reads, once per process.
 *
 * `mcp-stdio.mjs` awaits it before it chooses a single path, so every entry
 * that loads the server — the stdio server, the daemon, `npm run setup`, the
 * CLI, the tests — has the data a 2.x install left behind in place first. A
 * failure is reported on stderr and does not stop the server: the old tree
 * stays where it was, and `doctor` names it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [options]
 * @returns {Promise<object>} the migration result
 */
export function prepareRuntimeHome({ env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const report = (result, why) => {
    if (result.status === "migrated" && (result.moved || result.merged)) {
      log(`ai-dev: moved ${result.moved + result.merged} file(s) from ${result.from} to ${result.to} (${why}).`);
    }
    if (result.conflicts.length) {
      log(`ai-dev: ${result.conflicts.length} file(s) exist in both places and were left in ${result.from}; ai-dev doctor lists them.`);
    }
    if (result.errors.length) {
      log(`ai-dev: ${result.errors.length} file(s) could not be moved out of ${result.from} (${result.errors[0].code || "error"}: ${result.errors[0].path}); ai-dev doctor lists them.`);
    }
    return result;
  };
  const failed = (what) => (error) => {
    log(`ai-dev: could not move ${what}: ${error.message}`);
    return { status: "failed", error: error.message, moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] };
  };
  prepared ??= migrateDoubledRuntimeHome({ env })
    .then((result) => report(result, "AI_DEV_HOME is the runtime folder itself now"), failed("the runtime tree out of AI_DEV_HOME/.ai-dev"))
    .then(async (result) => ({
      ...result,
      codex: await migrateCodexRuntime({ env })
        .then((codex) => report(codex, "AI Dev's data is read from ~/.ai-dev only now"), failed("AI Dev's data out of ~/.codex"))
    }));
  return prepared;
}

async function listFiles(directory, root = directory, limit = 50, found = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= limit) break;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(full, root, limit, found);
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(path.relative(root, full));
  }
  return found;
}

/**
 * Where the runtime tree is and what the last migration did, for `doctor`.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ root: string, ai_dev_home: string, ai_dev_home_names_home: boolean, legacy_root: string, legacy_files: string[], last_migration: object|null }>}
 */
export async function describeRuntimeHome({ env = process.env } = {}) {
  const root = resolveRuntimeStateRoot("", env);
  const raw = String(env.AI_DEV_HOME ?? "").trim();
  const legacy = legacyDoubledRuntimeRoot(env);
  const { history } = await readMigrationRecord(root);
  const codexFiles = [];
  for (const folder of codexLegacyFolders(env)) {
    for (const file of await listFiles(folder.source, folder.codex, 50 - codexFiles.length)) codexFiles.push(file);
  }
  return {
    root,
    ai_dev_home: raw,
    ai_dev_home_names_home: Boolean(raw) && !explicitRuntimeHome(env),
    legacy_root: legacy,
    legacy_files: legacy ? await listFiles(legacy) : [],
    codex_root: path.join(resolveUserHome("", env), ".codex"),
    codex_files: codexFiles,
    last_migration: history.at(-1) ?? null
  };
}
