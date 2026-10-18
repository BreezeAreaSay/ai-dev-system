import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_LEGACY_FOLDERS,
  describeRuntimeHome,
  mergeLedgers,
  migrateCodexRuntime,
  migrateDoubledRuntimeHome,
  migrateVolumeState,
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
  // A ledger both trees grew: merged in time order, nothing dropped.
  await write(path.join(legacy, "state", "usage", "events.jsonl"), '{"at":"2026-09-01T00:00:00Z"}\n{"at":"2026-10-01T00:00:00Z"}\n');
  await write(path.join(aiDevHome, "state", "usage", "events.jsonl"), '{"at":"2026-09-15T00:00:00Z"}\n');
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
  assert.equal(
    await fs.readFile(path.join(aiDevHome, "state", "usage", "events.jsonl"), "utf8"),
    '{"at":"2026-09-01T00:00:00Z"}\n{"at":"2026-09-15T00:00:00Z"}\n{"at":"2026-10-01T00:00:00Z"}\n',
    "time order, so pruning the oldest lines prunes the oldest records"
  );
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

test("two processes starting at once migrate once: nothing merged twice, nothing aborted", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  const ledger = Array.from({ length: 5_000 }, (_, i) => JSON.stringify({ at: "2026-09-01T00:00:00Z", i })).join("\n");
  await write(path.join(legacy, "state", "usage", "events.jsonl"), `${ledger}\n`);
  await write(path.join(aiDevHome, "state", "usage", "events.jsonl"), '{"at":"2026-10-01T00:00:00Z"}\n');
  for (let i = 0; i < 20; i += 1) await write(path.join(legacy, "state", "tasks", `task-${i}.json`), `{"i":${i}}\n`);
  const moduleUrl = new URL("./runtime-home-migration.mjs", import.meta.url).href;
  const source = `const { migrateDoubledRuntimeHome } = await import(${JSON.stringify(moduleUrl)});
const result = await migrateDoubledRuntimeHome({ env: JSON.parse(process.argv[1]) });
process.stdout.write(JSON.stringify(result));`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", JSON.stringify(env)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.equal(result.code, 0, result.err);
  const parsed = results.map((result) => JSON.parse(result.out));
  assert.deepEqual(parsed.map((result) => result.errors?.length ?? 0), [0, 0]);
  assert.equal(parsed.reduce((sum, result) => sum + result.moved, 0), 20, "every task moved exactly once");
  assert.equal(parsed.reduce((sum, result) => sum + result.merged, 0), 1, "the ledger merged exactly once");
  const lines = (await fs.readFile(path.join(aiDevHome, "state", "usage", "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 5_001);
  await assert.rejects(fs.stat(legacy), { code: "ENOENT" });
});

test("a link in the old tree moves as a link, and doctor does not call a skipped one clean", async (t) => {
  if (process.platform === "win32") {
    t.skip("creating a symlink needs a privilege Windows does not give by default");
    return;
  }
  const { root, aiDevHome, legacy, env } = await fixture(t);
  const elsewhere = path.join(root, "other-disk", "models");
  await write(path.join(elsewhere, "bge-m3-onnx", "model.onnx"), "weights");
  await fs.symlink(elsewhere, path.join(legacy, "models"));
  const result = await migrateDoubledRuntimeHome({ env });
  assert.equal(result.moved, 1);
  assert.equal(await fs.readlink(path.join(aiDevHome, "models")), elsewhere);
  assert.equal(await fs.readFile(path.join(aiDevHome, "models", "bge-m3-onnx", "model.onnx"), "utf8"), "weights");

  // A link that cannot move — the destination is taken — is listed, not skipped.
  await fs.mkdir(legacy, { recursive: true });
  await fs.symlink(elsewhere, path.join(legacy, "models"));
  await migrateDoubledRuntimeHome({ env });
  const info = await describeRuntimeHome({ env });
  assert.deepEqual(info.legacy_files, ["models"]);
  assert.equal(evaluateRuntimeHome(info).status, "warn");
});

test("an entry that cannot move is reported, and the rest of the tree moves anyway", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  await write(path.join(legacy, "state", "tasks", "task-1.json"), "{}\n");
  await write(path.join(legacy, "state", "blocked", "inside.json"), "{}\n");
  await write(path.join(aiDevHome, "state", "blocked"), "a file where 2.x had a directory\n");
  await write(path.join(legacy, "state", "zz-last.json"), "{}\n");
  const result = await migrateDoubledRuntimeHome({ env });
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.equal(result.errors[0].path, path.join("state", "blocked"));
  assert.ok(await fs.stat(path.join(aiDevHome, "state", "tasks", "task-1.json")));
  assert.ok(await fs.stat(path.join(aiDevHome, "state", "zz-last.json")), "entries after the failed one still move");
  const health = evaluateRuntimeHome(await describeRuntimeHome({ env }));
  assert.equal(health.status, "warn");
  assert.match(health.summary, /could not be moved/);
});

test("large files are compared in chunks: equal ones are deduplicated, a last-byte difference is a conflict", async (t) => {
  const { aiDevHome, legacy, env } = await fixture(t);
  const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const differentAtTheEnd = Buffer.from(big);
  differentAtTheEnd[differentAtTheEnd.length - 1] = 8;
  for (const [name, mine, theirs] of [["same.bin", big, big], ["differs.bin", big, differentAtTheEnd], ["shorter.bin", big, big.subarray(1)]]) {
    await fs.mkdir(path.join(legacy, "models"), { recursive: true });
    await fs.mkdir(path.join(aiDevHome, "models"), { recursive: true });
    await fs.writeFile(path.join(legacy, "models", name), mine);
    await fs.writeFile(path.join(aiDevHome, "models", name), theirs);
  }
  const result = await migrateDoubledRuntimeHome({ env });
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.conflicts.sort(), [path.join("models", "differs.bin"), path.join("models", "shorter.bin")]);
});

test("ledgers merge in time order; untimed records keep the old ledger first; a torn tail is dropped", () => {
  const at = (day) => JSON.stringify({ at: `2026-09-${day}T00:00:00Z` });
  assert.equal(mergeLedgers(`${at("01")}\n${at("20")}\n`, `${at("10")}\n${at("30")}\n`), `${at("01")}\n${at("10")}\n${at("20")}\n${at("30")}\n`);
  assert.equal(mergeLedgers('{"n":1}\n', '{"n":2}\n'), '{"n":1}\n{"n":2}\n');
  assert.equal(mergeLedgers('{"n":1}\n{"half":', '{"n":2}\n'), '{"n":1}\n{"n":2}\n', "a record cut off by a killed writer");
  assert.equal(mergeLedgers('{"n":1}', ""), '{"n":1}\n', "a complete last record without its newline is kept");
  assert.equal(mergeLedgers('{"at":"old-1"}\n', `${at("01")}\n`), `{"at":"old-1"}\n${at("01")}\n`, "only ISO times are times");
  assert.equal(mergeLedgers("", ""), "");
});

test("AI Dev's Codex-era folders move into the runtime tree; the rest of ~/.codex stays (Д-104)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codex = path.join(home, ".codex");
  const runtime = path.join(home, ".ai-dev");
  const env = { HOME: home };
  await write(path.join(codex, "config.toml"), "model = \"o3\"\n");
  await write(path.join(codex, "sessions", "rollout.jsonl"), "{}\n");
  await write(path.join(codex, "state", "ai-dev-system", "tasks", "task-1.json"), "{\"id\":\"task-1\"}\n");
  await write(path.join(codex, "state", "ai-dev-system", "usage", "events.jsonl"),
    '{"at":"2026-09-01T00:00:00Z","n":1}\n{"at":"2026-09-03T00:00:00Z","n":3}\n');
  // A hook wrote ~/.ai-dev/state meanwhile, which made 2.x stop reading ~/.codex.
  await write(path.join(runtime, "state", "usage", "events.jsonl"), '{"at":"2026-09-02T00:00:00Z","n":2}\n');
  await write(path.join(codex, "state", "archify-receipts", "r.json"), "{}\n");
  await write(path.join(codex, "cache", "ai-dev-system", "search-index", "ai-dev-search.sqlite"), "index");
  await write(path.join(codex, "models", "bge-m3-onnx", "model.onnx"), "weights");

  const result = await migrateCodexRuntime({ env, now: () => new Date("2026-10-12T08:00:00Z") });
  assert.equal(result.status, "migrated");
  assert.equal(result.kind, "codex");
  assert.equal(result.moved, 4);
  assert.equal(result.merged, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await fs.readFile(path.join(runtime, "state", "tasks", "task-1.json"), "utf8"), "{\"id\":\"task-1\"}\n");
  assert.deepEqual((await fs.readFile(path.join(runtime, "state", "usage", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).n), [1, 2, 3]);
  assert.ok(await fs.stat(path.join(runtime, "state", "archify-receipts", "r.json")));
  assert.ok(await fs.stat(path.join(runtime, "cache", "search-index", "ai-dev-search.sqlite")));
  assert.ok(await fs.stat(path.join(runtime, "models", "bge-m3-onnx", "model.onnx")));
  assert.equal(await fs.readFile(path.join(codex, "config.toml"), "utf8"), "model = \"o3\"\n", "Codex's own config stays");
  assert.ok(await fs.stat(path.join(codex, "sessions", "rollout.jsonl")), "and so do its sessions");
  await assert.rejects(fs.stat(path.join(codex, "state", "ai-dev-system")), "the emptied folder goes");
  const record = await readMigrationRecord(runtime);
  assert.equal(record.history.at(-1).kind, "codex");
  assert.equal(record.history.at(-1).from, codex);
  assert.equal((await migrateCodexRuntime({ env })).status, "clean", "a second run has nothing to do");
});

test("a place named by its variable is not taken from ~/.codex, and what could not move is in doctor (Д-104)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codex = path.join(home, ".codex");
  const runtime = path.join(home, ".ai-dev");
  await write(path.join(codex, "state", "ai-dev-system", "pilots.json"), '{"pilots":[1]}\n');
  await write(path.join(runtime, "state", "pilots.json"), '{"pilots":[2]}\n');
  await write(path.join(codex, "artifacts", "archify", "x.svg"), "<svg/>");

  const named = await migrateCodexRuntime({ env: { HOME: home, AI_DEV_STATE_ROOT: path.join(root, "elsewhere"), AI_DEV_ARCHIFY_ARTIFACT_ROOT: path.join(root, "a") } });
  assert.equal(named.status, "clean", "both places are named, so 2.x never read them from ~/.codex");
  assert.ok(await fs.stat(path.join(codex, "state", "ai-dev-system", "pilots.json")));

  const env = { HOME: home };
  const result = await migrateCodexRuntime({ env, now: () => new Date("2026-10-12T09:00:00Z") });
  assert.deepEqual(result.conflicts, [path.join("state", "ai-dev-system", "pilots.json")]);
  assert.equal(result.moved, 1);
  const info = await describeRuntimeHome({ env });
  assert.deepEqual(info.codex_files, [path.join("state", "ai-dev-system", "pilots.json")]);
  const warned = evaluateRuntimeHome(info);
  assert.equal(warned.status, "warn");
  assert.match(warned.summary, /1 file\(s\) of AI Dev's are still in .*\.codex, where the Codex-era runtime kept them; only .* is read now\. 1 differ from the copy/);
  await fs.rm(path.join(codex, "state", "ai-dev-system", "pilots.json"));
  assert.equal(evaluateRuntimeHome(await describeRuntimeHome({ env })).status, "ok");
});

test("a Codex-era index or half a download that ~/.ai-dev has its own of is dropped, not a conflict (Д-183)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-codex-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codex = path.join(home, ".codex");
  const runtime = path.join(home, ".ai-dev");
  const env = { HOME: home };
  await write(path.join(codex, "cache", "ai-dev-system", "search-index", "ai-dev-search.sqlite"), "codex-era index");
  await write(path.join(runtime, "cache", "search-index", "ai-dev-search.sqlite"), "current index");
  await write(path.join(codex, "models", "bge-m3-onnx", "onnx", "model_int8.onnx.part"), "half a model");
  await write(path.join(runtime, "models", "bge-m3-onnx", "onnx", "model_int8.onnx.part"), "another half");
  // State is never dropped: a task on both sides that differs stays a conflict.
  await write(path.join(codex, "state", "ai-dev-system", "tasks", "t.json"), "{\"v\":1}\n");
  await write(path.join(runtime, "state", "tasks", "t.json"), "{\"v\":2}\n");
  const result = await migrateCodexRuntime({ env });
  assert.equal(result.superseded, 2);
  assert.deepEqual(result.conflicts, [path.join("state", "ai-dev-system", "tasks", "t.json")]);
  assert.equal(await fs.readFile(path.join(runtime, "cache", "search-index", "ai-dev-search.sqlite"), "utf8"), "current index");
  await assert.rejects(fs.stat(path.join(codex, "cache", "ai-dev-system", "search-index", "ai-dev-search.sqlite")));
  const verdict = evaluateRuntimeHome(await describeRuntimeHome({ env }));
  assert.match(verdict.summary, /1 file\(s\) of AI Dev's are still in/, "only the state conflict is left to settle");
});

test("the test runtime pins every place the migration takes from ~/.codex: a test run never moves a developer's data", () => {
  // test/setup.mjs runs before every test file and keeps HOME as it is.
  assert.deepEqual(CODEX_LEGACY_FOLDERS.filter((folder) => !process.env[folder.variable]).map((folder) => folder.variable), []);
});

test("nothing looks for the Codex desktop runtime any more: not the server, not a script (Д-104)", async () => {
  const repository = path.resolve(import.meta.dirname, "..", "..", "..");
  const places = [
    path.join(repository, "scripts"),
    path.join(repository, "ai-dev-mcp-server", "scripts"),
    path.join(repository, "ai-dev-mcp-server", "src"),
    path.join(repository, "ai-dev-mcp-server", "hooks"),
    path.join(repository, "ai-dev-mcp-server", "bin")
  ];
  const offenders = [];
  for (const place of places) {
    for (const name of await fs.readdir(place, { recursive: true })) {
      if (!/\.(?:m?js|ps1|sh)$/.test(name) || /\.test\.mjs$/.test(name)) continue;
      const text = await fs.readFile(path.join(place, name), "utf8");
      // The runtime Codex shipped, by any of the paths 2.x looked in.
      if (/codex-runtimes|\.codex[\\/]runtimes|codex-primary-runtime/i.test(text)) offenders.push(path.relative(repository, path.join(place, name)));
    }
  }
  assert.deepEqual(offenders, []);
});

/** A container's view: the volume at `<root>/data`, the host's state folder mounted at `hostState`. */
async function containerFixture(t, hostState) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-volume-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "data", "runtime-home", ".ai-dev");
  const env = { HOME: path.join(root, "data", "runtime-home"), AI_DEV_HOME: runtime, AI_DEV_RUNTIME: "docker", AI_DEV_STATE_ROOT: hostState ?? path.join(root, "host-state") };
  return { root, runtime, volume: path.join(runtime, "state"), target: env.AI_DEV_STATE_ROOT, env };
}

test("in the image, the volume's state moves into the host's state folder the hooks share (Д-103)", async (t) => {
  const { runtime, volume, target, env } = await containerFixture(t);
  await write(path.join(volume, "tasks", "task-1.json"), '{"id":"task-1"}');
  await write(path.join(volume, "sessions", "k", "handoff.json"), '{"from":"volume"}');
  await write(path.join(volume, "usage", "events.jsonl"), '{"at":"2026-10-01T00:00:00Z","n":1}\n');
  await write(path.join(target, "usage", "events.jsonl"), '{"at":"2026-10-02T00:00:00Z","n":2}\n');
  await write(path.join(target, "sessions", "k", "handoff.json"), '{"from":"host"}');
  const result = await migrateVolumeState({ env });
  assert.equal(result.status, "migrated");
  assert.deepEqual([result.moved, result.merged, result.conflicts], [1, 1, ["sessions/k/handoff.json"]]);
  assert.equal(await fs.readFile(path.join(target, "tasks", "task-1.json"), "utf8"), '{"id":"task-1"}');
  assert.equal((await fs.readFile(path.join(target, "usage", "events.jsonl"), "utf8")).trim().split("\n").length, 2, "the ledgers are one");
  assert.equal(await fs.readFile(path.join(target, "sessions", "k", "handoff.json"), "utf8"), '{"from":"host"}', "the host's own file is not replaced");
  assert.equal(await fs.readFile(path.join(volume, "sessions", "k", "handoff.json"), "utf8"), '{"from":"volume"}', "a file in both places stays where it was");
  await assert.rejects(fs.access(path.join(volume, "tasks")), /ENOENT/);
  assert.equal((await readMigrationRecord(runtime, env)).history.at(-1).kind, "volume", "kept in the state folder, not in the one moved out");
  await assert.rejects(fs.access(path.join(volume, "runtime-home-migration.json")), /ENOENT/);
  // The health check says where they went: the host's folder, not the runtime tree (Д-328).
  const health = evaluateRuntimeHome(await describeRuntimeHome({ env }));
  assert.match(health.summary, new RegExp(`were moved to ${target.replaceAll("\\", "\\\\")} from`));
  assert.doesNotMatch(health.summary, /moved here/);
  // A 2.x launcher's session writes the volume again; the next start takes it too.
  await write(path.join(volume, "tasks", "task-2.json"), '{"id":"task-2"}');
  assert.equal((await migrateVolumeState({ env })).moved, 1);
  await fs.access(path.join(target, "tasks", "task-2.json"));
});

test("the volume's state is only moved in the image, into a state folder that is another one", async (t) => {
  const { volume, env } = await containerFixture(t);
  await write(path.join(volume, "tasks", "task-1.json"), "{}");
  assert.equal((await migrateVolumeState({ env: { ...env, AI_DEV_RUNTIME: "" } })).status, "not-applicable");
  assert.equal((await migrateVolumeState({ env: { ...env, AI_DEV_STATE_ROOT: "" } })).status, "not-applicable", "a 2.x launcher's session: the volume is the state");
  assert.equal((await migrateVolumeState({ env: { ...env, AI_DEV_STATE_ROOT: volume } })).status, "not-applicable");
  await fs.access(path.join(volume, "tasks", "task-1.json"));
  await fs.rm(volume, { recursive: true });
  assert.equal((await migrateVolumeState({ env })).status, "clean");
});

test("the move crosses from the volume to the host's mount: copied without replacing, then removed", async (t) => {
  // /dev/shm is another filesystem than the temp folder on Linux: a hard link fails with EXDEV there, as it does
  // from a Docker volume into a bind mount.
  const shm = await fs.mkdtemp("/dev/shm/ai-dev-host-state-").catch(() => "");
  if (!shm) {
    t.skip("no /dev/shm to cross into");
    return;
  }
  t.after(() => fs.rm(shm, { recursive: true, force: true }));
  const { volume, env } = await containerFixture(t, shm);
  await write(path.join(volume, "tasks", "task-1.json"), '{"id":"task-1"}');
  const result = await migrateVolumeState({ env });
  assert.deepEqual([result.status, result.moved, result.errors], ["migrated", 1, []]);
  assert.equal(await fs.readFile(path.join(shm, "tasks", "task-1.json"), "utf8"), '{"id":"task-1"}');
  await assert.rejects(fs.access(path.join(volume, "tasks", "task-1.json")), /ENOENT/);
});
