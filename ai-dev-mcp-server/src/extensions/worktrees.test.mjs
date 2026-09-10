import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createWorktreeTools } from "./worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("begin_task_in_worktree starts the task inside a fresh worktree and remove cleans it up", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const realRepo = await fs.realpath(repo);

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const calls = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-test" }),
    async callTool(name, args) {
      calls.push({ name, args });
      const record = await taskStore.begin({
        task: args.task,
        project: { project_name: "fixture", project_path: args.project_path },
        skills: [],
        baseline: { fingerprint: "a" }
      });
      return { content: [{ type: "text", text: JSON.stringify({ ...record, next_actions: ["verify"] }) }] };
    }
  };
  const registry = createExtensionTools(host, [createWorktreeTools]);

  const begun = await registry.handlers.get("begin_task_in_worktree")({
    project_path: repo,
    task: "Add login form validation",
    name: "login-validation"
  });
  assert.equal(calls[0].name, "begin_task");
  assert.equal(calls[0].args.project_path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.equal(begun.worktree.branch, "task/login-validation");
  assert.equal(begun.context.worktree.path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.match(begun.next_actions[0], /Work only inside/);
  assert.equal(runGit(begun.worktree.path, ["branch", "--show-current"]), "task/login-validation");

  const listed = await registry.handlers.get("list_task_worktrees")({ project_path: repo });
  assert.equal(listed.count, 1);
  assert.equal(listed.worktrees[0].name, "login-validation");

  await assert.rejects(
    registry.handlers.get("remove_task_worktree")({ task_id: begun.id }),
    /complete it first or pass force=true/
  );
  const removed = await registry.handlers.get("remove_task_worktree")({ task_id: begun.id, force: true, delete_branch: true });
  assert.equal(removed.branch, "task/login-validation");
  assert.equal(removed.branch_deleted, true);
  const record = await taskStore.read(begun.id);
  assert.ok(record.context.worktree.removed_at);
  assert.equal((await registry.handlers.get("list_task_worktrees")({ project_path: repo })).count, 0);
  await assert.rejects(registry.handlers.get("remove_task_worktree")({}), /task_id or worktree_path is required/);

  // Auto-generated names are derived from the task text plus a timestamp.
  const auto = await registry.handlers.get("begin_task_in_worktree")({ project_path: repo, task: "Починить форму логина" });
  assert.match(auto.worktree.branch, /^task\/[a-z0-9-]+-\d{8}$/);
});
