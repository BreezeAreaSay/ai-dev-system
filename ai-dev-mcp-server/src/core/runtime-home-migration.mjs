import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { explicitRuntimeHome, legacyDoubledRuntimeRoot, resolveRuntimeStateRoot } from "./runtime-home.mjs";
import { atomicWriteJson, withExclusiveFile } from "./atomic-files.mjs";

/**
 * Move what 2.x wrote into `<AI_DEV_HOME>/.ai-dev` up into `<AI_DEV_HOME>`.
 *
 * Before 3.0 the code appended `.ai-dev` to `AI_DEV_HOME` while every document
 * and the Docker image treated the variable as the runtime folder itself, so the
 * data of everyone who set it landed one level deeper than they were told
 * (docs/DEFECTS.md, Д-90). The owner's decision D2 keeps the documented meaning;
 * this moves the data to match. Nothing is lost:
 *
 * - a file that does not exist at the destination is moved;
 * - an identical one is dropped from the old tree;
 * - a JSONL ledger is appended to the one already there;
 * - anything else that exists on both sides stays where it is, and is reported.
 *
 * Re-running is safe and cheap; a 2.x hook that still writes the old tree is
 * picked up by the next run.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "not-applicable"|"clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, conflicts: string[] }>}
 */
export async function migrateDoubledRuntimeHome({ env = process.env, now = () => new Date() } = {}) {
  const empty = { moved: 0, merged: 0, duplicates: 0, conflicts: [] };
  const legacy = legacyDoubledRuntimeRoot(env);
  if (!legacy) return { status: "not-applicable", ...empty };
  if (!(await isDirectory(legacy))) return { status: "clean", ...empty };
  const target = resolveRuntimeStateRoot("", env);
  const counts = { ...empty, conflicts: [] };
  await mergeTree(legacy, target, legacy, counts);
  await removeEmptyDirectories(legacy);
  const result = { status: "migrated", from: legacy, to: target, ...counts };
  if (counts.moved || counts.merged || counts.duplicates || counts.conflicts.length) {
    await recordMigration(target, { ...result, at: now().toISOString() });
  }
  return result;
}

async function isDirectory(candidate) {
  return fs.stat(candidate).then((stat) => stat.isDirectory()).catch(() => false);
}

async function sameContent(left, right) {
  const [a, b] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return a.length === b.length && crypto.createHash("sha256").update(a).digest("hex") === crypto.createHash("sha256").update(b).digest("hex");
}

async function mergeTree(sourceDir, targetDir, legacyRoot, counts) {
  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mergeTree(source, destination, legacyRoot, counts);
      continue;
    }
    if (!entry.isFile()) continue;
    const existing = await fs.lstat(destination).catch(() => null);
    if (!existing) {
      await fs.rename(source, destination);
      counts.moved += 1;
    } else if (existing.isFile() && await sameContent(source, destination)) {
      await fs.rm(source, { force: true });
      counts.duplicates += 1;
    } else if (existing.isFile() && entry.name.endsWith(".jsonl")) {
      const text = await fs.readFile(source, "utf8");
      await withExclusiveFile(destination, async () => {
        const current = await fs.readFile(destination, "utf8").catch(() => "");
        const glue = current && !current.endsWith("\n") ? "\n" : "";
        await fs.appendFile(destination, `${glue}${text}${text && !text.endsWith("\n") ? "\n" : ""}`, "utf8");
      });
      await fs.rm(source, { force: true });
      counts.merged += 1;
    } else {
      counts.conflicts.push(path.relative(legacyRoot, source));
    }
  }
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
 * Every entry point calls it before the first tool runs — the stdio server, the
 * daemon, `npm run setup` and the CLI — so the data a 2.x install left behind
 * is in place before anything looks for it. A failure is reported on stderr
 * and does not stop the server: the old tree stays where it was, and `doctor`
 * names it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [options]
 * @returns {Promise<object>} the migration result
 */
export function prepareRuntimeHome({ env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  prepared ??= migrateDoubledRuntimeHome({ env }).then((result) => {
    if (result.status === "migrated" && (result.moved || result.merged || result.conflicts.length)) {
      log(`ai-dev: moved ${result.moved + result.merged} file(s) from ${result.from} to ${result.to} (AI_DEV_HOME is the runtime folder itself now).`);
    }
    if (result.conflicts.length) {
      log(`ai-dev: ${result.conflicts.length} file(s) exist in both places and were left in ${result.from}; npm run doctor lists them.`);
    }
    return result;
  }).catch((error) => {
    log(`ai-dev: could not move the runtime tree out of AI_DEV_HOME/.ai-dev: ${error.message}`);
    return { status: "failed", error: error.message, moved: 0, merged: 0, duplicates: 0, conflicts: [] };
  });
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
    else if (entry.isFile()) found.push(path.relative(root, full));
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
  return {
    root,
    ai_dev_home: raw,
    ai_dev_home_names_home: Boolean(raw) && !explicitRuntimeHome(env),
    legacy_root: legacy,
    legacy_files: legacy ? await listFiles(legacy) : [],
    last_migration: history.at(-1) ?? null
  };
}
