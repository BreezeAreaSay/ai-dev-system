import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeRuntimeHome,
  migrateDoubledRuntimeHome,
  migrationRecordPath,
  prepareRuntimeHome,
  readMigrationRecord
} from "./runtime-home-migration.mjs";
import { evaluateRuntimeHome } from "./system-health.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-migrate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const aiDevHome = path.join(home, "ai-dev-data");
  const legacy = path.join(aiDevHome, ".ai-dev");
  await fs.mkdir(legacy, { recursive: true });
  return { root, home, aiDevHome, legacy, env: { HOME: home, AI_DEV_HOME: aiDevHome } };
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

test("nothing to do without AI_DEV_HOME, or without a doubled tree", async (t) => {
  const { home, aiDevHome, legacy } = await fixture(t);
  assert.equal((await migrateDoubledRuntimeHome({ env: { HOME: home } })).status, "not-applicable");
  await fs.rm(legacy, { recursive: true });
  assert.equal((await migrateDoubledRuntimeHome({ env: { HOME: home, AI_DEV_HOME: aiDevHome } })).status, "clean");
  assert.equal((await migrateDoubledRuntimeHome({ env: { HOME: home, AI_DEV_HOME: home } })).status, "not-applicable", "AI_DEV_HOME naming the home has nothing doubled");
});

test("a 2.x tree under AI_DEV_HOME/.ai-dev moves up without losing a file (Д-90)", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  await write(path.join(legacy, "state", "tasks", "task-1.json"), '{"id":"task-1"}\n');
  await write(path.join(legacy, "state", "sessions", "repo-a", "handoff.json"), '{"topic":"a"}\n');
  await write(path.join(legacy, "cache", "search-index", "ai-dev-search.sqlite"), "sqlite bytes");
  // Same file on both sides, identical: the old copy goes.
  await write(path.join(legacy, "state", "instincts.json"), '{"instincts":[]}\n');
  await write(path.join(aiDevHome, "state", "instincts.json"), '{"instincts":[]}\n');
  // A ledger both trees grew: appended, nothing dropped.
  await write(path.join(legacy, "state", "usage", "events.jsonl"), '{"at":"old-1"}\n{"at":"old-2"}\n');
  await write(path.join(aiDevHome, "state", "usage", "events.jsonl"), '{"at":"new-1"}\n');
  // Different content on both sides: left where it is, and named.
  await write(path.join(legacy, "state", "skill-outcomes.json"), '{"outcomes":[1]}\n');
  await write(path.join(aiDevHome, "state", "skill-outcomes.json"), '{"outcomes":[2]}\n');

  const result = await migrateDoubledRuntimeHome({ env, now: () => new Date("2026-10-10T12:00:00Z") });
  assert.equal(result.status, "migrated");
  assert.equal(result.from, legacy);
  assert.equal(result.to, path.resolve(aiDevHome));
  assert.deepEqual({ moved: result.moved, merged: result.merged, duplicates: result.duplicates }, { moved: 3, merged: 1, duplicates: 1 });
  assert.deepEqual(result.conflicts, [path.join("state", "skill-outcomes.json")]);

  assert.equal(await fs.readFile(path.join(aiDevHome, "state", "tasks", "task-1.json"), "utf8"), '{"id":"task-1"}\n');
  assert.equal(await fs.readFile(path.join(aiDevHome, "cache", "search-index", "ai-dev-search.sqlite"), "utf8"), "sqlite bytes");
  assert.equal(await fs.readFile(path.join(aiDevHome, "state", "usage", "events.jsonl"), "utf8"), '{"at":"new-1"}\n{"at":"old-1"}\n{"at":"old-2"}\n');
  assert.equal(await fs.readFile(path.join(aiDevHome, "state", "skill-outcomes.json"), "utf8"), '{"outcomes":[2]}\n', "the current copy is not overwritten");
  assert.equal(await fs.readFile(path.join(legacy, "state", "skill-outcomes.json"), "utf8"), '{"outcomes":[1]}\n', "the old copy is kept");
  await assert.rejects(fs.stat(path.join(legacy, "state", "tasks")), { code: "ENOENT" }, "emptied directories are removed");

  const record = await readMigrationRecord(path.resolve(aiDevHome));
  assert.equal(record.history.length, 1);
  assert.equal(record.history[0].at, "2026-10-10T12:00:00.000Z");
  assert.equal(path.dirname(migrationRecordPath(aiDevHome)), path.join(aiDevHome, "state"));

  const again = await migrateDoubledRuntimeHome({ env });
  assert.deepEqual({ moved: again.moved, merged: again.merged, duplicates: again.duplicates }, { moved: 0, merged: 0, duplicates: 0 }, "a rerun only meets the conflict");
  assert.deepEqual(again.conflicts, result.conflicts);
  assert.equal((await readMigrationRecord(path.resolve(aiDevHome))).history.length, 2, "the rerun is recorded because a conflict remains");
});

test("doctor names the runtime tree, the last migration and what was left behind", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  await write(path.join(legacy, "state", "pilots.json"), '{"pilots":[1]}\n');
  await write(path.join(aiDevHome, "state", "pilots.json"), '{"pilots":[2]}\n');
  await write(path.join(legacy, "artifacts", "archify", "x.svg"), "<svg/>");
  await migrateDoubledRuntimeHome({ env, now: () => new Date("2026-10-10T08:00:00Z") });

  const info = await describeRuntimeHome({ env });
  assert.equal(info.root, path.resolve(aiDevHome));
  assert.deepEqual(info.legacy_files, [path.join("state", "pilots.json")]);
  assert.equal(info.last_migration.moved, 1);
  const warned = evaluateRuntimeHome(info);
  assert.equal(warned.status, "warn");
  assert.match(warned.summary, /1 file\(s\) are still in/);

  await fs.rm(path.join(legacy, "state", "pilots.json"));
  const clean = evaluateRuntimeHome(await describeRuntimeHome({ env }));
  assert.equal(clean.status, "ok");
  assert.match(clean.summary, /On 2026-10-10 1 file\(s\) were moved here from/);

  const namesHome = evaluateRuntimeHome(await describeRuntimeHome({ env: { HOME: env.HOME, AI_DEV_HOME: env.HOME } }));
  assert.equal(namesHome.status, "ok");
  assert.match(namesHome.summary, /keeps its 2\.x meaning/);
});

test("the entry points migrate once per process and say what they moved", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  await write(path.join(legacy, "state", "tasks", "task-9.json"), "{}\n");
  const lines = [];
  const first = await prepareRuntimeHome({ env, log: (line) => lines.push(line) });
  const second = await prepareRuntimeHome({ env, log: (line) => lines.push(line) });
  assert.equal(first, second, "memoised for the process");
  assert.equal(first.moved, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /moved 1 file\(s\) from .* \(AI_DEV_HOME is the runtime folder itself now\)/);
  assert.ok(await fs.stat(path.join(aiDevHome, "state", "tasks", "task-9.json")));
});
