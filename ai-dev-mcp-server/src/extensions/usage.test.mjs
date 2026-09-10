import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { UsageLedger } from "../core/usage-ledger.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createUsageTools } from "./usage.mjs";

test("usage tools scope reports by task and project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const usageLedger = new UsageLedger({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    usageLedger,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createUsageTools]);
  const task = await taskStore.begin({
    task: "Measure cost",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "a" }
  });

  const recorded = await registry.handlers.get("record_usage")({
    task_id: task.id,
    model: "claude-opus-5",
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: 0.07,
    source: "session-runner"
  });
  assert.equal(recorded.event.project_path, projectRoot);
  await usageLedger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 50, taskId: task.id, projectPath: projectRoot });

  const byTask = await registry.handlers.get("usage_report")({ task_id: task.id });
  assert.equal(byTask.events, 2);
  assert.equal(byTask.tasks[0].cost_usd, 0.07);
  const byProject = await registry.handlers.get("usage_report")({ project_path: projectRoot });
  assert.equal(byProject.events, 2);
  await assert.rejects(registry.handlers.get("record_usage")({ model: "x" }), /needs input_tokens/);
});
