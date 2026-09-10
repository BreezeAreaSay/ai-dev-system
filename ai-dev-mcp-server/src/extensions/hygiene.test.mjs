import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createHygieneTools } from "./hygiene.mjs";

test("hygiene extension scans a task and checkpoints its result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-extension-")); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]]) { const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, shell: false }); if (result.status !== 0) throw new Error(result.stderr); }
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") }); const task = await taskStore.begin({ task: "Add feature", project: { project_name: "fixture", project_path: root }, skills: [], baseline: { fingerprint: "x" } }); await fs.writeFile(path.join(root, "src", "a.js"), "console.log('debug');\n");
  const registry = createExtensionTools({ taskStore, resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath }) }, [createHygieneTools]); const result = await registry.handlers.get("verify_change_hygiene")({ task_id: task.id, record_checkpoint: true });
  assert.equal(result.status, "warn"); assert.equal(result.checkpoint.checkpoints, 1); assert.ok(result.findings.some((item) => item.code === "console_log"));
});
