import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLAN_CRITERION_TEXT, classifyTaskComplexity, normalizePlan, renderPlanMarkdown, withPlanGateWarning, writeTaskPlan } from "./task-plans.mjs";
import { TaskStore } from "./task-lifecycle.mjs";

test("classifies plans and records a durable normalized plan", async (t) => {
  assert.equal(classifyTaskComplexity({ task: "Fix a typo" }).complexity, "small");
  assert.equal(classifyTaskComplexity({ task: "Refactor all modules", risk: "high", selectedFiles: new Array(8) }).plan_required, true);
  assert.throws(() => normalizePlan({ overview: "x", phases: [] }), /At least one phase/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-plans-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot: path.join(root, "state") });
  const task = await store.begin({ task: "Migrate the production database across all services", project: { project_name: "fixture", project_path: root, project_types: ["api"] }, skills: [], baseline: { fingerprint: "x" }, context: { selected_files: new Array(10) } });
  assert.equal(task.plan_policy.plan_required, true);
  assert.ok(task.acceptance_criteria.some((item) => item.text === PLAN_CRITERION_TEXT));
  assert.match(withPlanGateWarning(task, ["src/a.mjs"]).plan_warning, /requires a recorded plan/);
  const written = await writeTaskPlan({ projectRoot: root, taskId: task.id, task: task.task, plan: { overview: "Migrate safely.", phases: [{ title: "Schema", steps: [{ action: "Write migration", file: "db/migration.sql", risk: "medium" }] }] } });
  assert.equal(written.steps, 1); assert.match(renderPlanMarkdown({ taskId: task.id, task: task.task, plan: written.plan }), /Write migration/);
  assert.ok(await fs.stat(path.join(root, written.path)));
});
