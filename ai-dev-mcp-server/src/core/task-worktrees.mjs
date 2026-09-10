import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

export const WORKTREES_DIR = ".worktrees";
export const TASK_BRANCH_PREFIX = "task/";
const HANDOFF_FILES = ["AGENTS.md", ".ai-dev/README.md", ".ai-dev/project-brief.md", ".ai-dev/project-map.md", ".ai-dev/quality-gate.md"];
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

async function git(cwd, args, { timeoutMs = 60_000 } = {}) {
  const result = await runProcess({
    executable: "git",
    args: ["-C", cwd, ...args],
    cwd,
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024
  }).catch((error) => ({ ok: false, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  return result;
}

function assertOk(result, label) {
  if (result.ok) return result;
  throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown git error").trim().slice(0, 500)}`);
}

async function pathExists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

/**
 * Build a filesystem- and branch-safe worktree name from free text (task id,
 * task title). Falls back to `task` when nothing usable remains.
 *
 * @param {string} value
 * @param {number} [maxLength=48]
 * @returns {string}
 */
export function worktreeName(value, maxLength = 48) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(8, maxLength))
    .replace(/-+$/g, "");
  return slug || "task";
}

function assertName(name) {
  if (!NAME_PATTERN.test(String(name || "")) || String(name).includes("..")) {
    throw new Error(`Invalid worktree name: ${name}`);
  }
  return name;
}

async function mainRepositoryRoot(projectRoot) {
  const toplevel = assertOk(await git(projectRoot, ["rev-parse", "--show-toplevel"]), "git rev-parse");
  const commonDir = assertOk(await git(projectRoot, ["rev-parse", "--git-common-dir"]), "git rev-parse --git-common-dir");
  const rawCommon = commonDir.stdout.trim();
  const commonAbsolute = path.isAbsolute(rawCommon) ? rawCommon : path.resolve(toplevel.stdout.trim(), rawCommon);
  // The main working tree is the parent of the common .git directory.
  const mainRoot = path.basename(commonAbsolute) === ".git" ? path.dirname(commonAbsolute) : toplevel.stdout.trim();
  return { mainRoot: await fs.realpath(mainRoot), currentRoot: await fs.realpath(toplevel.stdout.trim()), commonDir: commonAbsolute };
}

async function ensureExcluded(commonDir, entry) {
  const excludePath = path.join(commonDir, "info", "exclude");
  const current = await fs.readFile(excludePath, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return false;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
  return true;
}

/**
 * Uncommitted changes in a worktree, ignoring the untracked handoff files that
 * {@link createTaskWorktree} copies on purpose.
 *
 * @param {string} worktreePath
 * @returns {Promise<{ dirty: boolean, dirty_files: number, files: string[] }>}
 */
export async function worktreeStatus(worktreePath) {
  const status = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = status.ok
    ? status.stdout.split("\n").filter(Boolean).filter((line) => {
      const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
      return !(line.startsWith("??") && HANDOFF_FILES.includes(filePath));
    }).map((line) => line.slice(3).trim())
    : [];
  return { dirty: files.length > 0, dirty_files: files.length, files };
}

async function copyHandoffFiles(mainRoot, worktreePath) {
  const copied = [];
  for (const relative of HANDOFF_FILES) {
    const source = path.join(mainRoot, ...relative.split("/"));
    const target = path.join(worktreePath, ...relative.split("/"));
    if (!(await pathExists(source)) || await pathExists(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    copied.push(relative);
  }
  return copied;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * @param {string} text
 * @returns {Array<{ path: string, head: string, branch: string, bare: boolean, detached: boolean, locked: boolean, prunable: boolean }>}
 */
export function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9).trim(), head: "", branch: "", bare: false, detached: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Create an isolated git worktree plus branch for one task:
 * `<main>/.worktrees/<name>` on `task/<name>` from `baseRef`. The `.worktrees`
 * directory is excluded through `.git/info/exclude` (no tracked file changes)
 * and untracked agent handoff files (`AGENTS.md`, `.ai-dev/*.md`) are copied so
 * the task starts with the same context as the main checkout.
 *
 * @param {{ projectRoot: string, name: string, baseRef?: string, worktreesDir?: string, branchPrefix?: string }} input
 * @returns {Promise<{ path: string, branch: string, base_ref: string, main_root: string, created: boolean, copied_files: string[] }>}
 */
export async function createTaskWorktree({ projectRoot, name, baseRef = "HEAD", worktreesDir = WORKTREES_DIR, branchPrefix = TASK_BRANCH_PREFIX }) {
  assertName(name);
  const { mainRoot, commonDir } = await mainRepositoryRoot(path.resolve(projectRoot));
  const worktreePath = path.join(mainRoot, worktreesDir, name);
  const branch = `${branchPrefix}${name}`;
  const existing = parseWorktreeList((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)
    .find((item) => path.resolve(item.path) === path.resolve(worktreePath));
  if (existing) {
    return { path: worktreePath, branch: existing.branch || branch, base_ref: baseRef, main_root: mainRoot, created: false, copied_files: [] };
  }
  if (await pathExists(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
  const branchExists = (await git(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, baseRef];
  assertOk(await git(mainRoot, args), "git worktree add");
  await ensureExcluded(commonDir, `/${worktreesDir}/`);
  const copied = await copyHandoffFiles(mainRoot, worktreePath);
  return { path: worktreePath, branch, base_ref: baseRef, main_root: mainRoot, created: true, copied_files: copied };
}

/**
 * List task worktrees of a repository (branches under `branchPrefix` or paths
 * under `worktreesDir`), optionally with dirty-state information.
 *
 * @param {{ projectRoot: string, worktreesDir?: string, branchPrefix?: string, includeStatus?: boolean }} input
 * @returns {Promise<{ main_root: string, worktrees: object[] }>}
 */
export async function listTaskWorktrees({ projectRoot, worktreesDir = WORKTREES_DIR, branchPrefix = TASK_BRANCH_PREFIX, includeStatus = false }) {
  const { mainRoot } = await mainRepositoryRoot(path.resolve(projectRoot));
  const entries = parseWorktreeList(assertOk(await git(mainRoot, ["worktree", "list", "--porcelain"]), "git worktree list").stdout);
  const container = path.resolve(mainRoot, worktreesDir);
  const mainHead = entries.find((entry) => path.resolve(entry.path) === mainRoot)?.head || "";
  const worktrees = [];
  for (const entry of entries) {
    const inside = path.resolve(entry.path).startsWith(`${container}${path.sep}`);
    if (!inside && !entry.branch.startsWith(branchPrefix)) continue;
    const item = { ...entry, name: path.basename(entry.path), main_root: mainRoot };
    if (includeStatus && !entry.prunable) {
      const status = await worktreeStatus(entry.path);
      item.dirty = status.dirty;
      item.dirty_files = status.dirty_files;
      const ahead = mainHead ? await git(entry.path, ["rev-list", "--count", `${mainHead}..HEAD`]) : { ok: false };
      item.commits_ahead_of_main = ahead.ok ? Number(ahead.stdout.trim()) || 0 : null;
    }
    worktrees.push(item);
  }
  return { main_root: mainRoot, worktrees };
}

/**
 * Remove a task worktree. Refuses while the worktree has uncommitted changes
 * unless `force` is set; optionally deletes the task branch afterwards.
 *
 * @param {{ projectRoot: string, worktreePath: string, force?: boolean, deleteBranch?: boolean }} input
 * @returns {Promise<{ removed: string, branch: string, branch_deleted: boolean, dirty_files: number }>}
 */
export async function removeTaskWorktree({ projectRoot, worktreePath, force = false, deleteBranch = false }) {
  const { mainRoot } = await mainRepositoryRoot(path.resolve(projectRoot));
  const target = path.resolve(worktreePath);
  if (target === mainRoot) throw new Error("Refusing to remove the main working tree.");
  const entry = parseWorktreeList((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)
    .find((item) => path.resolve(item.path) === target);
  if (!entry) throw new Error(`Not a registered worktree: ${worktreePath}`);
  let dirtyFiles = 0;
  if (!entry.prunable) {
    dirtyFiles = (await worktreeStatus(target)).dirty_files;
    if (dirtyFiles && !force) {
      throw new Error(`Worktree has ${dirtyFiles} uncommitted change(s). Commit or stash them, or pass force=true to discard.`);
    }
  }
  // Our own dirty guard already ran (it ignores the copied handoff files, which
  // git would otherwise refuse to delete), so git itself is always forced here.
  assertOk(await git(mainRoot, ["worktree", "remove", "--force", target]), "git worktree remove");
  await git(mainRoot, ["worktree", "prune"]);
  let branchDeleted = false;
  if (deleteBranch && entry.branch) {
    branchDeleted = (await git(mainRoot, ["branch", "-D", entry.branch])).ok;
  }
  return { removed: target, branch: entry.branch, branch_deleted: branchDeleted, dirty_files: dirtyFiles };
}
