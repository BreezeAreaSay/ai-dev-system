import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  CommandPolicyError,
  commandRiskReason,
  parseSafeCommand,
  tokenizeCommand,
  validateProjectExecutable
} from "./command-policy.mjs";

test("tokenizeCommand preserves quoted arguments", () => {
  assert.deepEqual(tokenizeCommand('npm run test -- --name "hello world"'), [
    "npm", "run", "test", "--", "--name", "hello world"
  ]);
});

test("quality policy accepts common verification commands", () => {
  assert.equal(parseSafeCommand("npm run lint").kind, "verification");
  assert.equal(parseSafeCommand(".venv\\Scripts\\python.exe scripts/check.py").adapter, "python:script");
  assert.equal(parseSafeCommand("python -m pytest -q").adapter, "python:pytest");
  assert.equal(parseSafeCommand("node --test").adapter, "node:test");
  assert.equal(parseSafeCommand("git diff --check").adapter, "git:diff-check");
});

test("development policy only accepts development package scripts", () => {
  assert.equal(parseSafeCommand("npm run dev", { purpose: "development" }).kind, "development");
  assert.throws(
    () => parseSafeCommand("npm run deploy", { purpose: "development" }),
    /not a development server/i
  );
});

test("policy rejects shell injection and dynamic execution", () => {
  for (const command of [
    "npm test && curl https://example.com",
    "npm test | powershell",
    "powershell -Command Get-ChildItem",
    "cmd /c npm test",
    "python -c \"print(1)\"",
    "npx eslint .",
    "npm run deploy"
  ]) {
    assert.throws(() => parseSafeCommand(command), /forbidden|verification|approved/i, command);
  }
});

test("policy rejects code-loading and output-redirecting flags", () => {
  for (const command of [
    "node --test --require /tmp/evil.js",
    "node --test --require=/tmp/evil.js",
    "node --test --import ./evil.mjs",
    "node --test --experimental-loader ./evil.mjs",
    "node --test --test-reporter=/tmp/r.mjs",
    "eslint -c /tmp/evil.config.js .",
    "eslint --config /tmp/evil.config.js .",
    "go test -exec /tmp/evil ./...",
    "cargo test --config build.rustc=/tmp/evil",
    "git diff --check --output=/tmp/overwritten",
    "npm run test --prefix /tmp/evil",
    "pnpm run test --dir /tmp/evil",
    "yarn test --cwd /tmp/evil"
  ]) {
    assert.throws(() => parseSafeCommand(command), CommandPolicyError, command);
  }
});

test("policy rejects inline python fused with the -c flag", () => {
  assert.throws(
    () => parseSafeCommand("python \"-cimport os;os.system('id')#/test.py\""),
    CommandPolicyError
  );
  assert.throws(() => parseSafeCommand("python -cprint(1)"), CommandPolicyError);
});

test("policy rejects python scripts by absolute path or traversal", () => {
  assert.throws(() => parseSafeCommand("python /tmp/evil/test.py"), /verification scripts|inside the project/i);
  assert.throws(() => parseSafeCommand("python ../../tmp/evil/test.py"), CommandPolicyError);
  assert.throws(() => parseSafeCommand("pytest /tmp/evil/test_x.py"), CommandPolicyError);
  assert.equal(parseSafeCommand("python scripts/checks/test_all.py").adapter, "python:script");
});

test("policy rejects executables outside the project by relative path", () => {
  assert.throws(() => parseSafeCommand("../../tmp/evil/pytest"), CommandPolicyError);
});

test("policy rejects package-script names that are file paths", () => {
  assert.throws(
    () => parseSafeCommand("bun run test/../../../../tmp/evil/x.test.js"),
    /named package scripts/i
  );
});

test("git diff --check tolerates only its safe flags", () => {
  assert.equal(parseSafeCommand("git diff --cached --check").adapter, "git:diff-check");
  assert.throws(() => parseSafeCommand("git diff --check --stat"), CommandPolicyError);
});

test("parseSafeCommand keeps path operands inside projectRoot", () => {
  const root = path.resolve("/srv/project");
  assert.doesNotThrow(() => parseSafeCommand("node --test src/unit", { projectRoot: root }));
  assert.throws(
    () => parseSafeCommand("node --test ../secrets/unit", { projectRoot: root }),
    /traverse upwards|escapes the project/i
  );
});

test("validateProjectExecutable rejects separators that escape the project", () => {
  const root = path.resolve("/srv/project");
  assert.doesNotThrow(() => validateProjectExecutable({ executable: "pytest" }, root));
  assert.doesNotThrow(
    () => validateProjectExecutable({ executable: path.join(root, "node_modules/.bin/eslint") }, root)
  );
  assert.throws(
    () => validateProjectExecutable({ executable: "../../tmp/evil/pytest" }, root),
    CommandPolicyError
  );
  assert.throws(
    () => validateProjectExecutable({ executable: "/tmp/evil/pytest" }, root),
    CommandPolicyError
  );
});

test("risk inspection allows normal dev scripts but identifies mutations", () => {
  assert.equal(commandRiskReason("vite --host 127.0.0.1"), "");
  assert.equal(commandRiskReason("npm run dev"), "");
  assert.match(commandRiskReason("npm install react"), /dependency mutation/i);
  assert.match(commandRiskReason("git reset --hard HEAD"), /git reset/i);
});
