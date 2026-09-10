import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstinctStore } from "../core/instincts.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createInstinctTools } from "./instincts.mjs";

test("instinct tools record, list, update, evolve into vault drafts, export, and import", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instinct-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(projectRoot);
  await fs.mkdir(vaultRoot);
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const instinctStore = new InstinctStore({ stateRoot });
  const dirty = [];
  const host = {
    taskStore,
    instinctStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ stack: ["Python", "FastAPI"], project_types: ["api"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createInstinctTools]);
  const task = await taskStore.begin({ task: "Fix flaky tests", project: { project_name: "svc", project_path: projectRoot }, skills: [], baseline: { fingerprint: "a" } });

  await assert.rejects(registry.handlers.get("record_instinct")({ trigger: "x", action: "y" }), /project_path or task_id is required/);
  const recorded = await registry.handlers.get("record_instinct")({ task_id: task.id, trigger: "when a pytest test is flaky", action: "pin the reproduction rate before fixing", domain: "testing", note: "happened twice" });
  assert.equal(recorded.action, "instinct_created");
  assert.equal(recorded.instinct.project_id, "project-test");
  assert.deepEqual(recorded.instinct.stack, ["Python", "FastAPI"]);
  for (const [trigger, action] of [["when adding a regression test", "name it by the behavior it protects"], ["when tests share state", "isolate fixtures per test"]]) {
    await registry.handlers.get("record_instinct")({ project_path: projectRoot, trigger, action, domain: "testing", confidence: 0.75 });
  }
  const globalOne = await registry.handlers.get("record_instinct")({ trigger: "when handling user input", action: "validate at the boundary", domain: "security", scope: "global", confidence: 0.8 });
  assert.equal(globalOne.instinct.scope, "global");

  const listed = await registry.handlers.get("list_instincts")({ project_path: projectRoot });
  assert.equal(listed.count, 4);
  const confirmed = await registry.handlers.get("update_instinct")({ id: recorded.instinct.id, action: "confirm", note: "helped" });
  assert.equal(confirmed.action, "instinct_confirmed");
  assert.equal(confirmed.instinct.confidence, 0.35);

  const preview = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3 });
  assert.equal(preview.action, "evolution_previewed");
  assert.equal(preview.clusters.length, 1);
  assert.match(preview.clusters[0].markdown, /^---\nname: learned-testing-project/);
  const evolved = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3, write_drafts: true });
  assert.equal(evolved.action, "instincts_evolved");
  const draftPath = path.join(vaultRoot, "03-skills-catalog", "sources", "custom", "learned-testing-project", "SKILL.md");
  assert.match(await fs.readFile(draftPath, "utf8"), /## Workflow/);
  assert.equal(dirty.length, 1);
  assert.equal((await registry.handlers.get("list_instincts")({ project_path: projectRoot, domain: "testing" })).count, 0);

  const exported = await registry.handlers.get("export_instincts")({ scope: "global" });
  assert.equal(exported.instincts.length, 1);
  const imported = await registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "global" });
  assert.equal(imported.imported, 1);
  assert.equal(imported.reinforced, 1, "same global instinct merges instead of duplicating");
  await assert.rejects(registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "project" }), /project_path is required/);
});
