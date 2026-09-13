import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  aiDevHome,
  clientConfigPath,
  daemonInfoPath,
  daemonLockPath,
  logsDir,
  pipeSafeUsername,
  runtimeDir,
  socketAddress,
  tasksStateRoot
} from "./runtime-paths.mjs";

function withHome(home, run) {
  const previous = process.env.AI_DEV_HOME;
  process.env.AI_DEV_HOME = home;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.AI_DEV_HOME;
    else process.env.AI_DEV_HOME = previous;
  }
}

test("every runtime path hangs off the same .ai-dev root", () => {
  withHome(path.join(path.sep, "tmp", "home"), () => {
    const root = aiDevHome();
    assert.equal(root, path.join(path.sep, "tmp", "home", ".ai-dev"));
    assert.equal(runtimeDir(), path.join(root, "run"));
    assert.equal(logsDir(), path.join(root, "logs"));
    assert.equal(daemonInfoPath(), path.join(root, "run", "daemon.json"));
    assert.equal(daemonLockPath(), path.join(root, "run", "daemon.lock"));
    assert.equal(clientConfigPath(), path.join(root, "config.json"));
    assert.equal(tasksStateRoot(), path.join(root, "state"));
  });
});

test("the lock and the socket share one directory, so one mode 0700 covers both", () => {
  withHome(path.join(path.sep, "tmp", "home"), () => {
    assert.equal(
      path.dirname(socketAddress({ platform: "linux" })),
      path.dirname(daemonLockPath())
    );
  });
});

test("a Windows daemon listens on a named pipe, not a path", () => {
  const address = socketAddress({ platform: "win32", username: "ivan" });
  assert.equal(address, "\\\\.\\pipe\\ai-dev-ivan");
});

test("a domain account still yields a usable pipe name", () => {
  // `CORP\Ivan Petrov` carries a separator and a space; left raw they would cut
  // the pipe name short, and two such accounts could collide on one machine.
  assert.equal(
    socketAddress({ platform: "win32", username: "CORP\\Ivan Petrov" }),
    "\\\\.\\pipe\\ai-dev-CORP_Ivan_Petrov"
  );
});

test("a username with nothing safe in it still names a pipe", () => {
  assert.equal(pipeSafeUsername("！！！"), "___");
  assert.equal(pipeSafeUsername(""), "user");
  assert.equal(pipeSafeUsername(undefined), "user");
});

test("a caller may place the socket itself", () => {
  const directory = path.join(path.sep, "run", "user", "1000");
  assert.equal(
    socketAddress({ platform: "linux", directory }),
    path.join(directory, "ai-dev.sock")
  );
});
