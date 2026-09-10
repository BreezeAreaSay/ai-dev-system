import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createPlanTools } from "./plans.mjs";

test("plan extension exposes status and records a plan", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-extension-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const task = await taskStore.begin({ task: "Migrate the production database across all services", project: { project_name: "fixture", project_path: root }, skills: [], baseline: { fingerprint: "x" } });
  const registry = createExtensionTools({ taskStore, resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath }) }, [createPlanTools]);
  assert.equal((await registry.handlers.get("plan_status")({ task_id: task.id })).plan_policy.plan_required, true);
  const result = await registry.handlers.get("plan_task")({ task_id: task.id, overview: "Migrate safely.", phases: [{ steps: [{ action: "Write migration", file: "db/m.sql" }] }] });
  assert.equal(result.action, "plan_recorded"); assert.ok(await fs.stat(path.join(root, result.plan.path)));
});
