import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createTaskWorktree,
  listTaskWorktrees,
  parseWorktreeList,
  removeTaskWorktree,
  worktreeName
} from "./task-worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function repoFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-worktrees-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  await fs.writeFile(path.join(repo, "AGENTS.md"), "# AGENTS\n");
  await fs.writeFile(path.join(repo, ".ai-dev", "quality-gate.md"), "# Quality Gate\n\n- Tests: `node --test`\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "index.js"]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return await fs.realpath(repo);
}

test("worktreeName and parseWorktreeList normalise input", () => {
  assert.equal(worktreeName("Исправить форму: Login / Signup!"), "login-signup");
  assert.equal(worktreeName("task-20260910T111806-280cf829"), "task-20260910t111806-280cf829");
  assert.equal(worktreeName("!!!"), "task");
  const parsed = parseWorktreeList([
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/one",
    "HEAD def",
    "branch refs/heads/task/one",
    "locked",
    "",
    "worktree /repo/.worktrees/gone",
    "HEAD 000",
    "detached",
    "prunable gitdir file points to non-existent location",
    ""
  ].join("\n"));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1], { path: "/repo/.worktrees/one", head: "def", branch: "task/one", bare: false, detached: false, locked: true, prunable: false });
  assert.equal(parsed[2].prunable, true);
  assert.equal(parsed[2].detached, true);
});

test("create, list, and remove task worktrees with handoff files and dirty guard", async (t) => {
  const repo = await repoFixture(t);
  const created = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(created.created, true);
  assert.equal(created.branch, "task/login-form");
  assert.equal(created.path, path.join(repo, ".worktrees", "login-form"));
  assert.deepEqual(created.copied_files, ["AGENTS.md", ".ai-dev/quality-gate.md"]);
  assert.equal(runGit(created.path, ["branch", "--show-current"]), "task/login-form");
  assert.match(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.worktrees\/$/m);
  assert.equal(runGit(repo, ["status", "--porcelain"]).includes(".worktrees"), false, ".worktrees is excluded");

  const again = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(again.created, false);
  await assert.rejects(createTaskWorktree({ projectRoot: repo, name: "../escape" }), /Invalid worktree name/);

  // A worktree can be created from inside another worktree; it still lands under the main root.
  const nested = await createTaskWorktree({ projectRoot: created.path, name: "second", baseRef: "main" });
  assert.equal(nested.main_root, repo);
  assert.equal(nested.path, path.join(repo, ".worktrees", "second"));

  const listed = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.deepEqual(listed.worktrees.map((item) => item.name).sort(), ["login-form", "second"]);
  assert.equal(listed.worktrees.every((item) => item.dirty === false), true, "copied handoff files do not count as dirty");
  assert.equal(listed.worktrees.every((item) => item.commits_ahead_of_main === 0), true);
  await fs.writeFile(path.join(nested.path, "feature.js"), "export const f = 1;\n");
  runGit(nested.path, ["add", "feature.js"]);
  runGit(nested.path, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "feat: add"]);
  const ahead = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(ahead.worktrees.find((item) => item.name === "second").commits_ahead_of_main, 1);

  await fs.writeFile(path.join(created.path, "index.js"), "export const one = 2;\n");
  const dirtyList = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(dirtyList.worktrees.find((item) => item.name === "login-form").dirty, true);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: created.path }), /uncommitted change/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: repo }), /main working tree/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: path.join(repo, "nope") }), /Not a registered worktree/);

  const removed = await removeTaskWorktree({ projectRoot: repo, worktreePath: created.path, force: true, deleteBranch: true });
  assert.equal(removed.dirty_files, 1);
  assert.equal(removed.branch_deleted, true);
  assert.equal(await fs.access(created.path).then(() => true).catch(() => false), false);
  assert.equal(runGit(repo, ["branch", "--list", "task/login-form"]), "");
  const clean = await removeTaskWorktree({ projectRoot: repo, worktreePath: nested.path });
  assert.equal(clean.branch_deleted, false);
  assert.equal(runGit(repo, ["branch", "--list", "task/second"]).trim().endsWith("task/second"), true, "branch kept");
});
