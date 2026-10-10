import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appendJsonLines, atomicAppendFile, atomicWriteFile, atomicWriteJson, truncateTornTail, withExclusiveFile } from "./atomic-files.mjs";

test("atomic writes replace complete files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-atomic-"));
  const file = path.join(root, "state.json");
  await atomicWriteJson(file, { version: 1 });
  await atomicWriteJson(file, { version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 2 });
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("queued appends do not lose concurrent updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-append-"));
  const file = path.join(root, "events.log");
  await atomicWriteFile(file, "");
  await Promise.all(Array.from({ length: 20 }, (_, index) => atomicAppendFile(file, `${index}\n`)));
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  assert.deepEqual(new Set(lines), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

// --- Several processes at once (docs/DEFECTS.md, Д-96) ---------------------
//
// Every MCP client runs its own server process and the agent hooks run as
// processes too, so these tests write from separate processes, the way a user's
// machine does. Before the cross-process lock three writers kept 208-223 lines
// of 600 and the JSON stores 202-222 updates of 600.

const atomicFilesUrl = new URL("./atomic-files.mjs", import.meta.url).href;
const hookLibUrl = new URL("../../hooks/lib.mjs", import.meta.url).href;

/** Run `source` (an ES module body) in a fresh Node process; resolves with its exit code. */
function runWriter(source, args, { env = {} } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, done };
}

const serverWriter = `
const [target, writer, count] = process.argv.slice(1);
const { appendJsonLines } = await import(${JSON.stringify(atomicFilesUrl)});
for (let i = 0; i < Number(count); i += 1) await appendJsonLines(target, JSON.stringify({ writer, i }) + "\\n");
`;

const hookWriter = `
const [writer, count] = process.argv.slice(1);
const { appendUsageEvents, usageLedgerPath } = await import(${JSON.stringify(hookLibUrl)});
for (let i = 0; i < Number(count); i += 1) appendUsageEvents([{ writer, i }]);
`;

async function readRecords(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const byWriter = {};
  let broken = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      (byWriter[record.writer] ??= []).push(record.i);
    } catch {
      broken += 1;
    }
  }
  return { byWriter, broken };
}

const inOrder = (values) => values.every((value, index) => value === index);

test("three processes appending 200 lines each keep all 600", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-multi-append-"));
  const file = path.join(root, "usage", "events.jsonl");
  const writers = ["a", "b", "c"].map((name) => runWriter(serverWriter, [file, name, "200"]));
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0);
  for (const name of ["a", "b", "c"]) {
    assert.equal(byWriter[name]?.length, 200, `writer ${name}`);
    assert.ok(inOrder(byWriter[name]), `writer ${name} kept its own order`);
  }
  await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" }, "no lock is left behind");
});

test("a hook and two servers appending to one ledger keep every line", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-hook-append-"));
  const file = path.join(stateRoot, "usage", "events.jsonl");
  const writers = [
    runWriter(serverWriter, [file, "server-1", "150"]),
    runWriter(serverWriter, [file, "server-2", "150"]),
    runWriter(hookWriter, ["hook", "150"], { env: { AI_DEV_STATE_ROOT: stateRoot } })
  ];
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(byWriter).map(([name, values]) => [name, values.length])), { hook: 150, "server-1": 150, "server-2": 150 });
});

test("a writer killed mid-stream leaves no broken line and does not block the others", async (t) => {
  if (process.platform === "win32") {
    t.skip("SIGKILL timing is POSIX-specific; the lock's dead-pid rule is covered by file-lock.test.mjs");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-kill-append-"));
  const file = path.join(root, "events.jsonl");
  const survivors = [runWriter(serverWriter, [file, "a", "300"]), runWriter(serverWriter, [file, "b", "300"])];
  const victim = runWriter(serverWriter, [file, "victim", "100000"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  victim.child.kill("SIGKILL");
  const killed = await victim.done;
  assert.equal(killed.signal, "SIGKILL");
  const results = await Promise.all(survivors.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0, "no line is torn");
  assert.equal(byWriter.a.length, 300);
  assert.equal(byWriter.b.length, 300);
  assert.ok(inOrder(byWriter.victim ?? []), "what the killed writer finished is intact and in order");
});

test("read-modify-write from three processes loses no update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-multi-rmw-"));
  const file = path.join(root, "store.json");
  const updater = `
const [target, writer, count] = process.argv.slice(1);
const fs = await import("node:fs/promises");
const { atomicWriteJson, withExclusiveFile } = await import(${JSON.stringify(atomicFilesUrl)});
for (let i = 0; i < Number(count); i += 1) {
  await withExclusiveFile(target, async () => {
    let store = { events: [] };
    try { store = JSON.parse(await fs.readFile(target, "utf8")); } catch {}
    store.events.push(writer + ":" + i);
    await atomicWriteJson(target, store);
  });
}
`;
  const writers = ["a", "b", "c"].map((name) => runWriter(updater, [file, name, "100"]));
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const store = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(store.events.length, 300);
  assert.equal(new Set(store.events).size, 300);
});

test("a torn last record is cut off before the next append, and only in JSONL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-torn-"));
  const ledger = path.join(root, "events.jsonl");
  await fs.writeFile(ledger, '{"ok":1}\n{"half":', "utf8");
  await appendJsonLines(ledger, '{"ok":2}\n');
  assert.equal(await fs.readFile(ledger, "utf8"), '{"ok":1}\n{"ok":2}\n');

  const note = path.join(root, "note.md");
  await fs.writeFile(note, "# Note\nlast line without a newline", "utf8");
  await atomicAppendFile(note, "\nappended\n");
  assert.equal(await fs.readFile(note, "utf8"), "# Note\nlast line without a newline\nappended\n", "a human-edited note is never cut");

  const noNewlineAtAll = path.join(root, "only-torn.jsonl");
  await fs.writeFile(noNewlineAtAll, '{"half":', "utf8");
  assert.equal(await truncateTornTail(noNewlineAtAll), 8);
  assert.equal(await fs.readFile(noNewlineAtAll, "utf8"), "");
  assert.equal(await truncateTornTail(path.join(root, "missing.jsonl")), 0);
  await assert.rejects(appendJsonLines(ledger, '{"no":"newline"}'), /complete records/);
});

test("the hooks cut a torn record the same way", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-hook-torn-"));
  const ledger = path.join(root, "events.jsonl");
  await fs.writeFile(ledger, `{"ok":1}\n${"x".repeat(70 * 1024)}`, "utf8");
  const { truncateTornTailSync } = await import(hookLibUrl);
  assert.equal(truncateTornTailSync(ledger), 70 * 1024, "a torn tail longer than one read chunk");
  assert.equal(await fs.readFile(ledger, "utf8"), '{"ok":1}\n');
  assert.equal(await truncateTornTail(ledger), 0);
});
