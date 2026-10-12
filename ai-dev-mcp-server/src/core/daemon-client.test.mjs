import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DAEMON_PROTOCOL, acceptHandshake, describeBuild, newSecret, readLine, writeDaemonInfo, writeLine } from "./daemon-channel.mjs";
import { tryAcquireFileLock } from "./file-lock.mjs";
import { DEFAULT_START_TIMEOUT_MS, connectDaemon, daemonDisabled, daemonStatus, listDaemons, logTail, spawnDaemon, startTimeoutMs, stopDaemons } from "./daemon-client.mjs";
import { daemonInfoPath, daemonLogPath, retiredDaemonPath, runtimeDir } from "./runtime-paths.mjs";

// The runtime home here is the one test/setup.mjs gives every test process.

/** A spawn that starts nothing: the child "exits" as told, and the call is recorded. */
function fakeSpawn(exit) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => undefined;
    setTimeout(() => child.emit("exit", exit, null), 20);
    return child;
  };
  return { spawnImpl, calls };
}

test("AI_DEV_DAEMON turns the daemon off with 0, off, false or no, in any case", () => {
  for (const value of ["0", "off", "OFF", "false", "no", " No "]) assert.equal(daemonDisabled({ AI_DEV_DAEMON: value }), true, value);
  for (const value of [undefined, "", "1", "on", "yes"]) assert.equal(daemonDisabled({ AI_DEV_DAEMON: value }), false, String(value));
});

test("the start timeout is milliseconds from the environment, 20 s otherwise", () => {
  assert.equal(startTimeoutMs({}), DEFAULT_START_TIMEOUT_MS);
  assert.equal(startTimeoutMs({ AI_DEV_DAEMON_START_TIMEOUT_MS: "1500" }), 1500);
  for (const value of ["", "abc", "0", "-3"]) assert.equal(startTimeoutMs({ AI_DEV_DAEMON_START_TIMEOUT_MS: value }), DEFAULT_START_TIMEOUT_MS, value);
});

test("a daemon is started detached, without a window, writing to its log, and its failure is told with the log's last lines", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  await fs.mkdir(path.dirname(daemonLogPath()), { recursive: true });
  await fs.writeFile(daemonLogPath(), "2026-10-12T00:00:00Z daemon 1: cannot listen at /x: EACCES\n");
  t.after(() => fs.rm(daemonLogPath(), { force: true }));
  const { spawnImpl, calls } = fakeSpawn(1);
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: {}, spawnImpl, timeoutMs: 5_000 }),
    (error) => error.code === "ESTART" && /The daemon did not start: it exited with 1\. Its log \(.*daemon\.log\) ends with: .*cannot listen at \/x: EACCES/.test(error.message)
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ["/cli/ai-dev.mjs", "daemon", "run"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio[0], "ignore");
  assert.equal(typeof calls[0].options.stdio[1], "number", "stdout and stderr go to the log file");
});

test("a daemon that never shows up is given up on at the timeout", async () => {
  const { spawnImpl } = fakeSpawn(0);
  const started = Date.now();
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: {}, spawnImpl, timeoutMs: 400 }),
    (error) => error.code === "ETIMEDOUT" && /did not start within 0 s/.test(error.message)
  );
  assert.ok(Date.now() - started < 3_000);
});

test("a daemon that steps aside for one that never shows up is started again, a few times at most (Д-193)", async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: {}, spawnImpl, timeoutMs: 1_000, restartAfterMs: 100 }),
    (error) => error.code === "ETIMEDOUT"
  );
  assert.equal(calls.length, 3);
});

test("a big log is set aside before a daemon writes to it", async (t) => {
  await fs.mkdir(path.dirname(daemonLogPath()), { recursive: true });
  await fs.writeFile(daemonLogPath(), "x".repeat(1024 * 1024 + 1));
  t.after(() => Promise.all([fs.rm(daemonLogPath(), { force: true }), fs.rm(`${daemonLogPath()}.1`, { force: true })]));
  const { spawnImpl } = fakeSpawn(0);
  spawnDaemon({ cliPath: "/cli/ai-dev.mjs", serverRoot: process.cwd(), env: {}, spawnImpl });
  assert.equal((await fs.stat(`${daemonLogPath()}.1`)).size, 1024 * 1024 + 1);
  assert.equal((await fs.stat(daemonLogPath())).size, 0);
  assert.match(await logTail(), /^$|Its log/);
});

/** This install's build, as status computes it for the tests below. */
const ownBuild = () => describeBuild({ serverRoot: process.cwd(), version: "3.0.0", env: {} });

/**
 * A stand-in daemon: a process that lives until it is stopped, and a control
 * channel in this test process that answers for it — `status` with what it is
 * told, `stop` by ending the process.
 */
async function standIn(t, { build, buildParts, retired = false, sessions = 1, clientName = "cursor", answersStatus = true }) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  // Under /tmp: a long TMPDIR would cut the socket path short (Д-201).
  const directory = process.platform === "win32" ? "" : await fs.mkdtemp(path.join("/tmp", "dcl-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\ai-dev-test-${process.pid}-${child.pid}` : path.join(directory, "s.sock");
  const secret = newSecret();
  const sockets = new Set();
  const server = net.createServer(async (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    try {
      const accepted = await acceptHandshake(socket, { secret, pid: child.pid, version: "3.0.0", build });
      const { message } = await readLine(socket, { buffered: accepted.rest });
      if (message.control === "status" && !answersStatus) {
        socket.destroy();
        return;
      }
      if (message.control === "status") await writeLine(socket, { ok: true, pid: child.pid, version: "3.0.0", build, sessions, clients: [{ name: clientName, version: "1" }], retired, ...(retired ? { retired_reason: "its code was replaced" } : {}) });
      if (message.control === "stop") {
        await writeLine(socket, { ok: true, stopping: true, sessions });
        child.kill();
      }
      socket.end();
    } catch {
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(async () => {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  const info = { protocol: DAEMON_PROTOCOL, pid: child.pid, version: "3.0.0", build, build_parts: buildParts, address, secret, sessions };
  const file = retired ? retiredDaemonPath(child.pid) : daemonInfoPath(build);
  await fs.mkdir(runtimeDir(), { recursive: true });
  // As a real daemon does: its lock beside its descriptor, or its retired record, for as long as it lives.
  const lock = await tryAcquireFileLock(file, { heartbeatMs: 1_000 });
  child.once("exit", () => lock.release?.().catch(() => undefined));
  await writeDaemonInfo(file, info);
  t.after(async () => {
    await lock.release?.().catch(() => undefined);
    await fs.rm(file, { force: true });
  });
  return { child, info, file };
}

const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("status and stop with no daemon, and with descriptors whose daemons are long gone", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  const build = await ownBuild();
  assert.deepEqual(await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} }), { running: false, build: build.id, info: daemonInfoPath(build.id), others: [] });
  assert.deepEqual(await stopDaemons(), { daemons: [] });
  await fs.mkdir(runtimeDir(), { recursive: true });
  // A pid no process has: the highest a 32-bit system hands out, plus one.
  await writeDaemonInfo(daemonInfoPath(build.id), { protocol: DAEMON_PROTOCOL, pid: 4194305, build: build.id, address: "/nowhere.sock", secret: newSecret() });
  await writeDaemonInfo(retiredDaemonPath(4194305), { protocol: DAEMON_PROTOCOL, pid: 4194305, build: "0123456789abcdef", address: "/nowhere.sock", secret: newSecret(), retired: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} });
  assert.equal(status.running, false);
  assert.equal(status.stale, true);
  assert.equal(status.reason, "pid 4194305 is not running");
  assert.equal(existsSync(daemonInfoPath(build.id)), true, "status only looks");
  // stop clears what is left of daemons that are gone, and says there was nothing to stop (docs/DEFECTS.md, Д-194).
  const stopped = await stopDaemons();
  assert.deepEqual(stopped.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.gone]), [[4194305, true, true], [4194305, true, true]]);
  assert.equal(existsSync(daemonInfoPath(build.id)), false);
  assert.equal(existsSync(retiredDaemonPath(4194305)), false);
});

test("a descriptor whose daemon answers nobody stays while its lock is held, and goes once nobody holds it", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  await fs.mkdir(runtimeDir(), { recursive: true });
  // Alive — this very process — and unreachable, with a live lock beside it.
  const descriptor = daemonInfoPath(build.id);
  await writeDaemonInfo(descriptor, { protocol: DAEMON_PROTOCOL, pid: process.pid, build: build.id, address: path.join(runtimeDir(), "gone.sock"), secret: newSecret() });
  await fs.writeFile(`${descriptor}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", acquired_at: Date.now() }));
  const listed = await listDaemons({ clean: true });
  assert.equal(listed.length, 1);
  assert.match(listed[0].unreachable, /^Cannot reach the daemon at .*gone\.sock/);
  assert.equal(listed[0].removed, false, "a live lock says a daemon may still serve it");
  const stopped = await stopDaemons();
  assert.equal(stopped.daemons[0].stopped, false);
  assert.match(stopped.daemons[0].reason, /^Cannot reach the daemon/);
  assert.doesNotMatch(stopped.daemons[0].reason, /\.$/, "a clause, for the CLI to end with one full stop");
  // Its lock abandoned: the descriptor is a leftover, and goes.
  await fs.writeFile(`${descriptor}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", acquired_at: Date.now() - 120_000 }));
  assert.equal((await listDaemons({ clean: true }))[0].removed, true);
  assert.equal(existsSync(descriptor), false);
});

test("status shows the daemons of other builds and the retired ones with why; stop stops every one", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  const mine = await standIn(t, { build: build.id, buildParts: build, sessions: 2 });
  const otherVault = await standIn(t, { build: "1111111111111111", buildParts: { ...build, environment: { ...build.environment, AI_DEV_VAULT_ROOT: "abc" } } });
  const old = await standIn(t, { build: "2222222222222222", buildParts: { ...build, source: "0000" }, retired: true, sessions: 3 });

  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} });
  assert.equal(status.running, true);
  assert.equal(status.current, true);
  assert.equal(status.pid, mine.child.pid);
  assert.equal(status.sessions, 2);
  assert.equal(status.secret, undefined, "status never carries the secret");
  const others = Object.fromEntries(status.others.map((daemon) => [daemon.pid, daemon]));
  assert.deepEqual(others[otherVault.child.pid].differences, ["another environment: AI_DEV_VAULT_ROOT differs"]);
  assert.equal(others[otherVault.child.pid].retired, false);
  assert.equal(others[old.child.pid].retired, true);
  assert.equal(others[old.child.pid].retired_reason, "its code was replaced");
  assert.equal(others[old.child.pid].sessions, 3);

  const stopped = await stopDaemons({ timeoutMs: 5_000 });
  assert.equal(stopped.daemons.length, 3);
  assert.ok(stopped.daemons.every((daemon) => daemon.stopped), JSON.stringify(stopped));
  assert.deepEqual(stopped.daemons.map((daemon) => daemon.sessions).sort(), [1, 2, 3]);
  for (const { child } of [mine, otherVault, old]) assert.equal(gone(child.pid), true);
});

test("a status answer of any reasonable length is read, and a daemon that does not answer status still takes stop (Д-196)", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  const long = await standIn(t, { build: build.id, buildParts: build, clientName: "x".repeat(20_000) });
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} });
  assert.equal(status.running, true);
  assert.equal(status.clients[0].name.length, 20_000);
  const mute = await standIn(t, { build: "3333333333333333", buildParts: { ...build, source: "other" }, answersStatus: false });
  const stopped = await stopDaemons({ timeoutMs: 5_000 });
  assert.deepEqual(stopped.daemons.map((daemon) => [daemon.pid, daemon.stopped]).sort(), [[long.child.pid, true], [mute.child.pid, true]].sort());
  assert.equal(gone(long.child.pid), true);
  assert.equal(gone(mute.child.pid), true);
});

test("a retired daemon nobody can reach is still shown; its record goes once nobody holds its lock, whoever has its pid (Д-197, Д-198)", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  // A process that is not a daemon now has the pid the record names.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill());
  await fs.mkdir(runtimeDir(), { recursive: true });
  const record = retiredDaemonPath(unrelated.pid);
  await writeDaemonInfo(record, { protocol: DAEMON_PROTOCOL, pid: unrelated.pid, build: build.id, address: path.join(runtimeDir(), "gone.sock"), secret: newSecret(), retired: true });
  // While its lock is held — by a retired daemon still finishing a session — it stays.
  const held = await tryAcquireFileLock(record, { heartbeatMs: 100 });
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} });
  assert.equal(status.running, false);
  assert.deepEqual(status.others.map((daemon) => [daemon.pid, daemon.retired, Boolean(daemon.unreachable)]), [[unrelated.pid, true, true]], "shown, not hidden");
  const first = await stopDaemons({ timeoutMs: 200 });
  assert.equal(first.daemons[0].stopped, false);
  assert.equal(existsSync(record), true);
  // Its daemon gone: the lock is not held any more, and stop clears the record.
  await held.release();
  const second = await stopDaemons({ timeoutMs: 200 });
  assert.deepEqual(second.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.gone]), [[unrelated.pid, true, true]]);
  assert.equal(existsSync(record), false);
  assert.equal(gone(unrelated.pid), false, "the process that has the pid now is left alone");
});
