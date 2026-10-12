import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DAEMON_DESCRIPTOR_NAME,
  MAX_SOCKET_PATH_BYTES,
  RETIRED_DAEMON_NAME,
  aiDevHome,
  clientConfigPath,
  daemonAddressCandidates,
  daemonInfoPath,
  daemonLogPath,
  logsDir,
  prepareSocketDirectory,
  randomDaemonName,
  retiredDaemonPath,
  runtimeDir,
  socketDirectoryCandidates,
  tasksStateRoot
} from "./runtime-paths.mjs";

// AI_DEV_HOME names the runtime folder itself (owner decision D2,
// docs/DEFECTS.md Д-90); these tests hand it `<home>/.ai-dev`, which is where
// the runtime tree of a user with that home lives.
function withHome(home, run) {
  const previous = process.env.AI_DEV_HOME;
  process.env.AI_DEV_HOME = path.join(home, ".ai-dev");
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.AI_DEV_HOME;
    else process.env.AI_DEV_HOME = previous;
  }
}

// Resolved once, because `\tmp\home` is absolute on POSIX but only
// drive-relative on Windows, where it resolves against the current drive.
// Writing the expectation by hand instead passed on Linux and failed on
// Windows CI with `D:\tmp\home\.ai-dev`.
const HOME = path.resolve(path.join(path.sep, "tmp", "home"));

test("every runtime path hangs off the same .ai-dev root", () => {
  withHome(HOME, () => {
    const root = aiDevHome();
    assert.equal(root, path.join(HOME, ".ai-dev"));
    assert.equal(runtimeDir(), path.join(root, "run"));
    assert.equal(logsDir(), path.join(root, "logs"));
    assert.equal(daemonInfoPath("0123456789abcdef"), path.join(root, "run", "daemon-0123456789abcdef.json"));
    assert.equal(DAEMON_DESCRIPTOR_NAME.exec(path.basename(daemonInfoPath("0123456789abcdef")))[1], "0123456789abcdef");
    assert.equal(DAEMON_DESCRIPTOR_NAME.test("daemon.json"), false, "2.x's descriptor is not one of these");
    assert.equal(retiredDaemonPath(4242), path.join(root, "run", "retired-4242.json"));
    assert.equal(RETIRED_DAEMON_NAME.exec("retired-4242.json")[1], "4242");
    assert.equal(daemonLogPath(), path.join(root, "logs", "daemon.log"));
    assert.equal(clientConfigPath(), path.join(root, "config.json"));
    assert.equal(tasksStateRoot(), path.join(root, "state"));
  });
});

test("a home that is not absolute still yields an absolute root", () => {
  // The daemon writes its lock and socket here and chmods the directory, so a
  // path that moves with the working directory would be a different tree each
  // run. This case fails on every platform if the resolve is ever dropped —
  // unlike a hand-spelled absolute path, which only fails on Windows.
  withHome(path.join("relative", "home"), () => {
    const root = aiDevHome();
    assert.equal(path.isAbsolute(root), true);
    assert.equal(root, path.resolve(path.join("relative", "home"), ".ai-dev"));
  });
});

test("every daemon start draws a name nobody can guess and take first (Д-107)", () => {
  const names = new Set(Array.from({ length: 50 }, () => randomDaemonName()));
  assert.equal(names.size, 50);
  for (const name of names) assert.match(name, /^ai-dev-[0-9a-f]{24}$/);
  assert.equal(randomDaemonName(Buffer.alloc(12, 0xab)), `ai-dev-${"ab".repeat(12)}`);
});

test("a Windows daemon listens on a named pipe with that random name, not the user's", () => {
  const [candidate, ...others] = daemonAddressCandidates({ platform: "win32", name: "ai-dev-0123" });
  assert.deepEqual(candidate, { address: "\\\\.\\pipe\\ai-dev-0123", directory: null });
  assert.equal(others.length, 0);
  assert.doesNotMatch(daemonAddressCandidates({ platform: "win32" })[0].address, /ivan|user/i);
});

test("a socket goes in the runtime's run/ while the path is short enough", () => {
  const runDir = path.join(path.sep, "home", "ivan", ".ai-dev", "run");
  const [first] = daemonAddressCandidates({ platform: "linux", name: "ai-dev-x", runDir, env: {}, uid: 1000 });
  assert.deepEqual(first, { address: path.join(runDir, "ai-dev-x.sock"), directory: runDir });
});

test("a home too long for a socket moves it to XDG_RUNTIME_DIR, then to /tmp/ai-dev-<uid> (Д-97)", () => {
  const longRun = path.join(path.sep, "home", "x".repeat(120), ".ai-dev", "run");
  const name = randomDaemonName();
  const withXdg = daemonAddressCandidates({ platform: "linux", name, runDir: longRun, env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 });
  assert.deepEqual(withXdg.map((candidate) => candidate.directory), [path.join("/run/user/1000", "ai-dev"), path.join("/tmp", "ai-dev-1000")]);
  const withoutXdg = daemonAddressCandidates({ platform: "linux", name, runDir: longRun, env: {}, uid: 1000 });
  assert.deepEqual(withoutXdg.map((candidate) => candidate.directory), [path.join("/tmp", "ai-dev-1000")]);
  for (const { address } of [...withXdg, ...withoutXdg]) assert.ok(Buffer.byteLength(address) <= MAX_SOCKET_PATH_BYTES, address);
});

test("the length is counted in bytes, as the kernel counts it, not in characters", () => {
  // 40 Cyrillic letters are 40 characters and 80 bytes.
  const runDir = path.join(path.sep, "home", "и".repeat(40), ".ai-dev", "run");
  const name = randomDaemonName();
  assert.ok(path.join(runDir, `${name}.sock`).length <= MAX_SOCKET_PATH_BYTES);
  const [first] = daemonAddressCandidates({ platform: "linux", name, runDir, env: {}, uid: 1000 });
  assert.equal(first.directory, path.join("/tmp", "ai-dev-1000"));
});

test("a relative XDG_RUNTIME_DIR is not a place for a socket", () => {
  assert.deepEqual(socketDirectoryCandidates({ runDir: "/r", env: { XDG_RUNTIME_DIR: "run/user" }, uid: 7 }), ["/r", path.join("/tmp", "ai-dev-7")]);
});

test("a socket directory is made this user's alone: 0700, a plain directory, owned by this uid", { skip: process.platform === "win32" && "POSIX modes and owners" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-sockdir-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fresh = path.join(root, "fresh");
  await prepareSocketDirectory(fresh);
  assert.equal((await fs.stat(fresh)).mode & 0o777, 0o700);

  const open = path.join(root, "open");
  await fs.mkdir(open, { mode: 0o755 });
  await fs.chmod(open, 0o777);
  await prepareSocketDirectory(open);
  assert.equal((await fs.stat(open)).mode & 0o777, 0o700, "group and others lose their access");

  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(elsewhere);
  const link = path.join(root, "link");
  await fs.symlink(elsewhere, link);
  await assert.rejects(prepareSocketDirectory(link), /not a plain directory/);

  // Someone else's directory, as /tmp/ai-dev-<uid> created first by another user.
  await assert.rejects(prepareSocketDirectory(fresh, { uid: (process.getuid?.() ?? 0) + 1 }), /belongs to uid/);
});
