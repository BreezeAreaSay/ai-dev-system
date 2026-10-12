import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DAEMON_PROTOCOL, newSecret, writeDaemonInfo } from "./daemon-channel.mjs";
import { DEFAULT_START_TIMEOUT_MS, connectDaemon, daemonDisabled, daemonStatus, logTail, spawnDaemon, startTimeoutMs, stopDaemon } from "./daemon-client.mjs";
import { daemonInfoPath, daemonLogPath, runtimeDir } from "./runtime-paths.mjs";

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

test("status and stop say there is no daemon, or that daemon.json names one long gone", async (t) => {
  await fs.rm(daemonInfoPath(), { force: true });
  assert.deepEqual(await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} }), { running: false, info: daemonInfoPath() });
  assert.deepEqual(await stopDaemon(), { running: false });
  await fs.mkdir(runtimeDir(), { recursive: true });
  // A pid no process has: the highest a 32-bit system hands out, plus one.
  await writeDaemonInfo(daemonInfoPath(), { protocol: DAEMON_PROTOCOL, pid: 4194305, address: "/nowhere.sock", secret: newSecret() });
  t.after(() => fs.rm(daemonInfoPath(), { force: true }));
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: {} });
  assert.equal(status.running, false);
  assert.equal(status.stale, true);
  assert.match(status.reason, /names pid 4194305, which is not running/);
  assert.deepEqual(await stopDaemon(), { running: false });
});
