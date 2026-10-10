import assert from "node:assert/strict";
import test from "node:test";
import { bundledPythonPath, resolvePythonCommand } from "./python-command.mjs";

const nothing = () => false;

test("without AI_DEV_PYTHON or a bundled runtime, each platform gets the name its installers provide (Д-94)", () => {
  assert.equal(resolvePythonCommand({ env: {}, platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", exists: nothing }), "python");
  assert.equal(resolvePythonCommand({ env: {}, platform: "darwin", execPath: "/usr/local/bin/node", exists: nothing }), "python3");
  assert.equal(resolvePythonCommand({ env: {}, platform: "linux", execPath: "/usr/bin/node", exists: nothing }), "python3");
});

test("AI_DEV_PYTHON wins, and a blank one counts as unset", () => {
  assert.equal(resolvePythonCommand({ env: { AI_DEV_PYTHON: "C:\\Python312\\python.exe" }, platform: "win32", exists: nothing }), "C:\\Python312\\python.exe");
  assert.equal(resolvePythonCommand({ env: { AI_DEV_PYTHON: "  " }, platform: "win32", execPath: "C:\\node\\node.exe", exists: nothing }), "python");
});

test("a runtime that ships Python beside Node uses it, on either separator", () => {
  const windows = bundledPythonPath({ platform: "win32", execPath: "C:\\runtime\\node\\bin\\node.exe" });
  assert.equal(windows, "C:\\runtime\\python\\python.exe");
  assert.equal(resolvePythonCommand({ env: {}, platform: "win32", execPath: "C:\\runtime\\node\\bin\\node.exe", exists: (file) => file === windows }), windows);

  const posix = bundledPythonPath({ platform: "linux", execPath: "/opt/runtime/node/bin/node" });
  assert.equal(posix, "/opt/runtime/python/bin/python");
  assert.equal(resolvePythonCommand({ env: {}, platform: "linux", execPath: "/opt/runtime/node/bin/node", exists: (file) => file === posix }), posix);
});
