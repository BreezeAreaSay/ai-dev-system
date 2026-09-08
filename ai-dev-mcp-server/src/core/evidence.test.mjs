import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindEvidence, captureProjectState, evidenceMatchesState } from "./evidence.mjs";

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid"
    }
  });
}

async function gitFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ["init"]);
  await fs.writeFile(path.join(root, "app.js"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

test("editing an already-dirty file changes the fingerprint", async (t) => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, "app.js"), "export const value = 2;\n");
  const before = await captureProjectState(root);
  assert.equal(before.strength, "strong");
  assert.ok(before.dirty);

  await fs.writeFile(path.join(root, "app.js"), "export const value = 2; // regressed\n");
  const after = await captureProjectState(root);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("editing an untracked file changes the fingerprint", async (t) => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, "new.js"), "one\n");
  const before = await captureProjectState(root);
  await fs.writeFile(path.join(root, "new.js"), "two\n");
  const after = await captureProjectState(root);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("a clean tree is stable across snapshots", async (t) => {
  const root = await gitFixture(t);
  const a = await captureProjectState(root);
  const b = await captureProjectState(root);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.dirty, false);
});

test("a non-git directory fingerprints its file contents, not just its path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-evidence-fs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "main.py"), "print(1)\n");
  const before = await captureProjectState(root);
  assert.equal(before.git, false);
  assert.equal(before.kind, "filesystem");
  assert.equal(before.strength, "medium");

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(path.join(root, "main.py"), "print(2)\n");
  const after = await captureProjectState(root);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("an empty non-git directory is weak", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-evidence-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = await captureProjectState(root);
  assert.equal(state.strength, "weak");
});

test("bindEvidence / evidenceMatchesState round-trip on the fingerprint", () => {
  const projectState = { fingerprint: "abc", head: "def" };
  const evidence = bindEvidence({ type: "task-verification", result: { status: "passed" }, projectState });
  assert.equal(evidence.source_state_fingerprint, "abc");
  assert.equal(evidenceMatchesState(evidence, projectState), true);
  assert.equal(evidenceMatchesState(evidence, { fingerprint: "xyz" }), false);
  assert.equal(evidenceMatchesState(null, projectState), false);
});
