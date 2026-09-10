import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "./task-lifecycle.mjs";

test("task completion requires met criteria and current-state verification", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-tasks-"));
  const store = new TaskStore({ stateRoot });
  const record = await store.begin({
    task: "Исправить форму",
    project: {
      project_name: "fixture",
      project_path: stateRoot,
      project_types: ["frontend"],
      stack: ["React"]
    },
    skills: [{ name: "bugfix-investigator" }],
    baseline: { fingerprint: "before" }
  });
  await assert.rejects(
    store.complete(record.id, { summary: "done", projectState: { fingerprint: "after" } }),
    /unresolved acceptance criteria/i
  );
  await store.checkpoint(record.id, {
    summary: "implemented",
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["test"] }))
  });
  await store.addVerification(record.id, {
    id: "verify-1",
    passed: true,
    evidence: { source_state_fingerprint: "after" }
  });
  const complete = await store.complete(record.id, {
    summary: "done",
    projectState: { fingerprint: "after" }
  });
  assert.equal(complete.status, "complete");
});

test("completion rejects a stale, failed, or repeated verification", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-stale-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const record = await store.begin({
    task: "Fix a frontend console error without changing the UI",
    project: { project_name: "fixture", project_path: stateRoot, project_types: [], stack: [] },
    skills: [],
    baseline: { fingerprint: "before" }
  });
  await store.checkpoint(record.id, {
    summary: "done",
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["x"] }))
  });

  await store.addVerification(record.id, {
    id: "verify-pass", passed: true, evidence: { source_state_fingerprint: "state-1" }
  });
  // A later failed run must block completion even though a passing run exists.
  await store.addVerification(record.id, {
    id: "verify-fail", passed: false, evidence: { source_state_fingerprint: "state-1" }
  });
  await assert.rejects(
    store.complete(record.id, { summary: "done", projectState: { fingerprint: "state-1" } }),
    /latest verification .* failed/i
  );

  // A passing run against a stale fingerprint must block completion.
  await store.addVerification(record.id, {
    id: "verify-stale", passed: true, evidence: { source_state_fingerprint: "state-1" }
  });
  await assert.rejects(
    store.complete(record.id, { summary: "done", projectState: { fingerprint: "state-2" } }),
    /stale/i
  );

  // Current passing run completes, and a second completion is refused.
  await store.addVerification(record.id, {
    id: "verify-current", passed: true, evidence: { source_state_fingerprint: "state-2" }
  });
  const done = await store.complete(record.id, { summary: "done", projectState: { fingerprint: "state-2" } });
  assert.equal(done.status, "complete");
  assert.deepEqual(done.completion.verification_ids, ["verify-current"]);
  await assert.rejects(
    store.complete(record.id, { summary: "again", projectState: { fingerprint: "state-2" } }),
    /already complete/i
  );
});

test("completion refuses a task with no verification", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-noverify-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const record = await store.begin({
    task: "Fix a frontend console error without changing the UI",
    project: { project_name: "fixture", project_path: stateRoot, project_types: [], stack: [] },
    skills: [],
    baseline: { fingerprint: "before" }
  });
  await store.checkpoint(record.id, {
    summary: "done",
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["x"] }))
  });
  await assert.rejects(
    store.complete(record.id, { summary: "done", projectState: { fingerprint: "s" } }),
    /No verification is recorded/i
  );
});

test("design-first criteria apply to Russian product work but not a narrow frontend bug", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-product-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const project = {
    project_name: "fixture",
    project_path: stateRoot,
    project_types: ["frontend"],
    stack: ["React"]
  };

  const productTask = await store.begin({
    task: "\u0423\u043b\u0443\u0447\u0448\u0438 \u0434\u0438\u0437\u0430\u0439\u043d \u0444\u0440\u043e\u043d\u0442\u0435\u043d\u0434\u0430",
    project,
    skills: [],
    baseline: { fingerprint: "before-product" }
  });
  assert.ok(productTask.acceptance_criteria.some((item) => (
    /design-first implementation gate/i.test(item.text)
  )));

  const bugTask = await store.begin({
    task: "Fix a frontend console error without changing the UI",
    project,
    skills: [],
    baseline: { fingerprint: "before-bug" }
  });
  assert.equal(bugTask.acceptance_criteria.some((item) => (
    /design-first implementation gate/i.test(item.text)
  )), false);
});

test("archify delivery criterion tracks diagram intent, not schema work", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-diagram-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const project = { project_name: "fixture", project_path: stateRoot, project_types: ["api"], stack: ["Node.js"] };

  const diagramTask = await store.begin({
    task: "Build an architecture diagram of the payment service",
    project, skills: [], baseline: { fingerprint: "a" }
  });
  assert.ok(diagramTask.acceptance_criteria.some((item) => /archify_deliver/i.test(item.text)));

  const migrationTask = await store.begin({
    task: "Добавь миграцию схемы базы данных",
    project, skills: [], baseline: { fingerprint: "b" }
  });
  assert.equal(migrationTask.acceptance_criteria.some((item) => /archify_deliver/i.test(item.text)), false);
});

test("risk routing does not confuse продвижение with production", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-risk-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const record = await store.begin({
    task: "Улучши продвижение продукта",
    project: { project_name: "fixture", project_path: stateRoot, project_types: [] },
    skills: [],
    baseline: { fingerprint: "risk" }
  });
  assert.equal(record.risk, "low");
});

test("task listing canonicalizes a nested project path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-task-list-project-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-task-list-state-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, "apps", "web");
  const sourcePath = path.join(projectRoot, "src");
  await fs.mkdir(sourcePath, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), "{\"name\":\"web\"}\n");
  const store = new TaskStore({ stateRoot });
  await store.begin({
    task: "Fix the nested project",
    project: { project_name: "web", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "before" }
  });

  const records = await store.list({ projectPath: sourcePath });
  assert.equal(records.length, 1);
  assert.equal(records[0].project.path, projectRoot);
});
