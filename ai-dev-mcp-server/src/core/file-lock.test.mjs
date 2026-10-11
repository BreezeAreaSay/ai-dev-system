import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BREAK_LOCK_STALE_MS,
  EMPTY_LOCK_GRACE_MS,
  LOCK_STALE_MS,
  LOCK_SUFFIX,
  LOCK_TIMEOUT_MS,
  acquireFileLock,
  breakStaleLock,
  lockIsLive,
  lockPathFor,
  processAlive,
  readLock,
  sameLock,
  withFileLock
} from "./file-lock.mjs";
import * as hookLib from "../../hooks/lib.mjs";

const tempDirectories = [];
test.after(() => Promise.all(tempDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function tempFile(name = "ledger.jsonl") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-lock-"));
  tempDirectories.push(directory);
  return path.join(directory, name);
}

/** A pid that is certainly not running: past the kernel's limit on every OS we run on. */
const DEAD_PID = 2 ** 30 + 7;

test("the lock sits beside the file it guards", () => {
  assert.equal(lockPathFor("/data/state/usage/events.jsonl"), path.resolve("/data/state/usage/events.jsonl") + LOCK_SUFFIX);
});

test("a holder is live while its process runs and the lock is young", () => {
  const now = 1_000_000;
  const holder = { pid: process.pid, host: os.hostname(), token: "t", acquired_at: now - 10 };
  assert.equal(lockIsLive({ holder, mtimeMs: now }, { now }), true);
  assert.equal(lockIsLive({ holder: { ...holder, pid: DEAD_PID }, mtimeMs: now }, { now }), false, "a dead pid is stale at once");
  assert.equal(lockIsLive({ holder: { ...holder, acquired_at: now - LOCK_STALE_MS }, mtimeMs: now }, { now }), false, "an old lock is stale whoever holds it");
  assert.equal(lockIsLive({ holder: { ...holder, host: "another-machine", pid: DEAD_PID }, mtimeMs: now }, { now }), true, "a pid on another host cannot be checked, so only age decides");
  assert.equal(lockIsLive({ holder: null, mtimeMs: now - 10 }, { now }), true, "a lock still being written is live for a moment");
  assert.equal(lockIsLive({ holder: null, mtimeMs: now - EMPTY_LOCK_GRACE_MS }, { now }), false, "an empty lock left by a killed writer is stale after the grace");
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(DEAD_PID), false);
  assert.equal(processAlive(0), false);
});

test("the hooks' copy of the protocol agrees with the server's on every case", () => {
  assert.equal(hookLib.LOCK_SUFFIX, LOCK_SUFFIX);
  assert.equal(hookLib.LOCK_STALE_MS, LOCK_STALE_MS);
  assert.equal(hookLib.EMPTY_LOCK_GRACE_MS, EMPTY_LOCK_GRACE_MS);
  assert.equal(hookLib.BREAK_LOCK_STALE_MS, BREAK_LOCK_STALE_MS);
  assert.equal(hookLib.lockPathFor("relative/ledger.jsonl"), lockPathFor("relative/ledger.jsonl"));
  const now = 5_000_000;
  const base = { pid: process.pid, host: os.hostname(), token: "t", acquired_at: now - 5 };
  const cases = [
    { holder: base, mtimeMs: now },
    { holder: { ...base, pid: DEAD_PID }, mtimeMs: now },
    { holder: { ...base, acquired_at: now - LOCK_STALE_MS - 1 }, mtimeMs: now },
    { holder: { ...base, host: "elsewhere" }, mtimeMs: now },
    { holder: { ...base, host: "elsewhere", acquired_at: 0 }, mtimeMs: now },
    { holder: null, mtimeMs: now - 1 },
    { holder: null, mtimeMs: now - EMPTY_LOCK_GRACE_MS - 1 },
    { holder: "garbage", mtimeMs: now - 1 },
    { holder: null, mtimeMs: 0, unreadable: true }
  ];
  for (const observed of cases) {
    assert.equal(hookLib.lockIsLive(observed, { now }), lockIsLive(observed, { now }), JSON.stringify(observed));
  }
  const pairs = [
    [{ id: "1:2", holder: { token: "t" }, mtimeMs: 5 }, { id: "1:2", holder: { token: "t" }, mtimeMs: 9 }],
    [{ id: "1:2", holder: { token: "t" }, mtimeMs: 5 }, { id: "1:3", holder: { token: "t" }, mtimeMs: 5 }],
    [{ id: "1:2", holder: null, mtimeMs: 5 }, { id: "1:2", holder: null, mtimeMs: 5 }],
    [{ id: "1:2", holder: null, mtimeMs: 5 }, { id: "1:2", holder: null, mtimeMs: 6 }],
    [{ id: "", holder: null, mtimeMs: 5, unreadable: true }, { id: "", holder: null, mtimeMs: 5 }]
  ];
  for (const [left, right] of pairs) {
    assert.equal(hookLib.sameLock(left, right), sameLock(left, right), JSON.stringify([left, right]));
  }
  assert.deepEqual(pairs.map(([left, right]) => sameLock(left, right)), [true, false, true, false, false]);
});

test("a writer waits out an abandoned lock rather than failing before it goes stale", () => {
  assert.ok(LOCK_TIMEOUT_MS > LOCK_STALE_MS, `${LOCK_TIMEOUT_MS} ms of waiting against ${LOCK_STALE_MS} ms to go stale`);
});

test("an unreadable lock — Windows refusing a file in use — counts as held", () => {
  assert.equal(lockIsLive({ holder: null, mtimeMs: 0, unreadable: true }), true);
});

const DEAD_HOLDER = () => JSON.stringify({ pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() });

for (const [label, read, breakLock] of [
  ["server", (lockPath) => readLock(lockPath), (lockPath, observed) => breakStaleLock(lockPath, observed)],
  ["hooks", (lockPath) => hookLib.readLockSync(lockPath), (lockPath, observed) => hookLib.breakStaleLockSync(lockPath, observed)]
]) {
  test(`${label}: a lock taken afresh after it was judged stale is not broken`, async () => {
    const target = await tempFile();
    const lockPath = lockPathFor(target);
    await fs.writeFile(lockPath, DEAD_HOLDER());
    const observed = await read(lockPath);
    assert.equal(lockIsLive(observed), false, "judged stale");
    // Meanwhile the abandoned lock was cleared and a live writer took a new one.
    await fs.rm(lockPath);
    const fresh = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "fresh", acquired_at: Date.now() });
    await fs.writeFile(lockPath, fresh);
    assert.equal(await breakLock(lockPath, observed), false);
    assert.equal(await fs.readFile(lockPath, "utf8"), fresh, "the fresh lock stands");
    await assert.rejects(fs.stat(`${lockPath}.break`), { code: "ENOENT" }, "the breaker cleans up after itself");
  });

  test(`${label}: a breaker killed mid-break holds the others up only until its own lock goes stale`, async () => {
    const target = await tempFile();
    const lockPath = lockPathFor(target);
    await fs.writeFile(lockPath, DEAD_HOLDER());
    const observed = await read(lockPath);
    await fs.writeFile(`${lockPath}.break`, "");
    assert.equal(await breakLock(lockPath, observed), false, "a young breaker lock means somebody is breaking it");
    const old = new Date(Date.now() - BREAK_LOCK_STALE_MS - 1_000);
    await fs.utimes(`${lockPath}.break`, old, old);
    assert.equal(await breakLock(lockPath, observed), false, "the abandoned breaker is cleared first");
    assert.equal(await breakLock(lockPath, observed), true, "then the stale lock goes");
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  });
}

test("a lock is taken, holds its holder, and is gone after release", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  const holder = JSON.parse(await fs.readFile(lockPathFor(target), "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.host, os.hostname());
  assert.match(holder.token, /^[0-9a-f-]{36}$/);
  await release();
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a second writer waits for the first and then runs", async () => {
  const target = await tempFile();
  const order = [];
  const release = await acquireFileLock(target);
  const waiting = withFileLock(target, async () => order.push("second"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  order.push("first done");
  await release();
  await waiting;
  assert.deepEqual(order, ["first done", "second"]);
});

test("a lock left by a dead process is broken at once", async () => {
  const target = await tempFile();
  await fs.writeFile(lockPathFor(target), JSON.stringify({ pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() }));
  const started = Date.now();
  await withFileLock(target, async () => undefined, { timeoutMs: 2_000 });
  assert.ok(Date.now() - started < 1_000, "nobody should wait for a dead holder");
});

test("an empty lock is broken once its grace has passed, and not before", async () => {
  const target = await tempFile();
  await fs.writeFile(lockPathFor(target), "");
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 100 }), /Timed out/);
  const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 1_000);
  await fs.utimes(lockPathFor(target), old, old);
  await withFileLock(target, async () => undefined, { timeoutMs: 1_000 });
});

test("waiting for a live holder ends in an error that names it", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 120 }), new RegExp(`held by pid ${process.pid}`));
  await release();
});

test("releasing never removes a lock someone else holds now", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  const theirs = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "someone-else", acquired_at: Date.now() });
  await fs.writeFile(lockPathFor(target), theirs);
  await release();
  assert.equal(await fs.readFile(lockPathFor(target), "utf8"), theirs);
});

test("the operation's result and error both come through", async () => {
  const target = await tempFile();
  assert.equal(await withFileLock(target, async () => 42), 42);
  await assert.rejects(withFileLock(target, async () => {
    throw new Error("inside");
  }), /inside/);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" }, "a failed operation still releases");
});

test("the hooks' synchronous lock excludes the server's and is released the same way", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  assert.throws(() => hookLib.withFileLockSync(target, () => "never", { timeoutMs: 100 }), /Timed out/);
  await release();
  assert.equal(hookLib.withFileLockSync(target, () => "ran", { timeoutMs: 1_000 }), "ran");
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a heartbeat keeps a long-held lock live past its staleness bound, from any host's point of view", async () => {
  const target = await tempFile();
  // Beats 16 times per bound: only a stall of most of a second could age it.
  const release = await acquireFileLock(target, { staleMs: 800, heartbeatMs: 50 });
  const first = JSON.parse(await fs.readFile(lockPathFor(target), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const later = await readLock(lockPathFor(target));
  assert.ok(later.holder, "a reader never finds the holder half-rewritten");
  assert.equal(later.holder.token, first.token, "the same holder, rewritten in place");
  assert.ok(later.holder.acquired_at > first.acquired_at, "with a fresh acquired_at");
  // Another host cannot check the pid; the refreshed time is what keeps it held.
  assert.equal(lockIsLive(later, { staleMs: 800, host: "another-host" }), true);
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 150, staleMs: 800 }), /Timed out/);
  await release();
  await withFileLock(target, async () => undefined, { timeoutMs: 500, staleMs: 800 });
});

test("a heartbeat whose file cannot be closed does not take the process down (Д-129)", async () => {
  const target = await tempFile();
  const realOpen = fs.open;
  let failedCloses = 0;
  // What a network file system can do: report a deferred write error at close.
  fs.open = async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    if (flags !== "r+") return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      failedCloses += 1;
      throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
    };
    return handle;
  };
  try {
    const release = await acquireFileLock(target, { heartbeatMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await release();
  } finally {
    fs.open = realOpen;
  }
  assert.ok(failedCloses >= 3, `the beats ran into the failing close: ${failedCloses}`);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a lock from another host that stopped beating is broken once its bound has passed", async () => {
  const target = await tempFile();
  // A container killed mid-rebuild: its host is not this one and its pid means nothing here.
  await fs.writeFile(lockPathFor(target), JSON.stringify({ pid: process.pid, host: "dead-container", token: "gone", acquired_at: Date.now() - 400 }));
  const started = Date.now();
  await withFileLock(target, async () => undefined, { timeoutMs: 2_000, staleMs: 300 });
  assert.ok(Date.now() - started < 1_000);
});

test("a process that exits while holding a lock removes it on the way out", async () => {
  const target = await tempFile();
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("./file-lock.mjs", import.meta.url).href;
  // What a SIGTERM handler that calls process.exit does: no finally runs.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireFileLock, lockPathFor } = await import(${JSON.stringify(moduleUrl)});
    const fs = await import("node:fs");
    await acquireFileLock(${JSON.stringify(target)}, { heartbeatMs: 1000 });
    if (!fs.existsSync(lockPathFor(${JSON.stringify(target)}))) process.exit(2);
    process.exit(0);
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("an exit in the middle of a release still removes the lock, and never one someone else took (Д-132)", async () => {
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("./file-lock.mjs", import.meta.url).href;
  const run = (target, body) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireFileLock, lockPathFor } = await import(${JSON.stringify(moduleUrl)});
    const fs = await import("node:fs");
    const fsp = (await import("node:fs/promises")).default;
    const target = ${JSON.stringify(target)};
    ${body}
  `], { encoding: "utf8" });

  // A SIGTERM handler exits while the release is reading the lock back.
  const releasing = await tempFile();
  const first = run(releasing, `
    const release = await acquireFileLock(target);
    const realOpen = fsp.open;
    fsp.open = async (file, flags, ...rest) => { if (flags === "r") process.exit(0); return realOpen(file, flags, ...rest); };
    await release();
    process.exit(3);
  `);
  assert.equal(first.status, 0, first.stderr);
  await assert.rejects(fs.stat(lockPathFor(releasing)), { code: "ENOENT" });

  // The lock was broken and taken by another process before this one exits.
  const retaken = await tempFile();
  const second = run(retaken, `
    await acquireFileLock(target);
    fs.writeFileSync(lockPathFor(target), JSON.stringify({ pid: 1, host: "elsewhere", token: "theirs", acquired_at: Date.now() }));
    process.exit(0);
  `);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(await fs.readFile(lockPathFor(retaken), "utf8")).token, "theirs");
});

test("a reader racing the heartbeat always finds a whole holder", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target, { staleMs: 60_000, heartbeatMs: 1 });
  try {
    for (let round = 0; round < 400; round += 1) {
      const seen = await readLock(lockPathFor(target));
      assert.ok(seen?.holder?.token, `round ${round}: ${JSON.stringify(seen)}`);
    }
  } finally {
    await release();
  }
});

