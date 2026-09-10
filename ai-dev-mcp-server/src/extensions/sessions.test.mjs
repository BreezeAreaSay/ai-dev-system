import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../core/session-memory.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createSessionTools } from "./sessions.mjs";

test("session tools save a handoff, resume with a briefing, and estimate the budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, ".ai-dev", "rules"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# AGENTS\n".repeat(50));
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "rules", "common.md"), "rules ".repeat(400));
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(path.join(vaultRoot, "skills"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "skills", "one.md"), "x".repeat(8_000));
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const sessionStore = new SessionStore({ stateRoot });
  const host = {
    taskStore,
    sessionStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    captureProjectState: async () => ({ fingerprint: "f1", branch: "feature/auth", dirty: true, dirty_files: ["a.ts"] }),
    detectProject: async () => ({ stack: ["TypeScript"], project_types: ["frontend"] }),
    instinctStore: { rankForContext: async () => ({ markdown: "Active instincts:\n- [project 80%] grep before edit" }) }
  };
  const registry = createExtensionTools(host, [createSessionTools]);
  const task = await taskStore.begin({
    task: "Finish auth",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [{ name: "one", path: "skills/one.md" }],
    baseline: { fingerprint: "f0" },
    context: { compiled_context: "c".repeat(20_000) }
  });

  const empty = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(empty.session, null);
  assert.match(empty.briefing, /NO SAVED SESSION/);
  assert.equal(empty.context_pack.compiled, false);

  const saved = await registry.handlers.get("save_session")({
    task_id: task.id,
    building: "JWT auth with httpOnly cookies; the login route still needs to set the cookie.",
    worked: [{ item: "register endpoint", evidence: "Postman 200" }],
    failed: [{ approach: "Next-Auth", reason: "Prisma adapter conflict" }, { approach: "iron-session", why: "no rotation story" }],
    next_step: "Set the cookie in the login route and run verify_task.",
    client: "claude-code"
  });
  assert.equal(saved.action, "session_saved");
  assert.equal(saved.checkpoint.checkpoints, 1);
  assert.match(await fs.readFile(path.join(projectRoot, ".ai-dev", "context", "handoff.md"), "utf8"), /Set the cookie/);

  await fs.mkdir(path.join(projectRoot, ".ai-dev", "context"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "context", "latest.json"), JSON.stringify({ source_state_fingerprint: "f1" }));
  const resumed = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(resumed.session.id, saved.session_id);
  assert.equal(resumed.session.branch, "feature/auth");
  assert.equal(resumed.open_tasks[0].id, task.id);
  assert.equal(resumed.context_pack.fresh, true);
  assert.match(resumed.briefing, /WHAT NOT TO RETRY:\n- Next-Auth — Prisma adapter conflict/);
  // `why` is the ECC spelling of `reason`; it must survive the round trip as reason.
  assert.deepEqual(resumed.session.failed[1], { approach: "iron-session", reason: "no rotation story" });
  assert.match(resumed.briefing, /grep before edit/);
  assert.match(resumed.briefing, /GIT: branch feature\/auth, 1 uncommitted/);

  const budget = await registry.handlers.get("context_budget_status")({ task_id: task.id });
  assert.equal(budget.components.context_pack, 5_000);
  assert.equal(budget.components.routed_skills, 2_000);
  assert.ok(budget.components.rules > 0);
  assert.ok(budget.components.agents_md > 0);
  assert.equal(budget.compaction_hint, "none");
  await assert.rejects(registry.handlers.get("save_session")({ topic: "x" }), /project_path or task_id is required/);
});
