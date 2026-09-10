import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", "target"
]);
const DIRTY_CONTENT_MAX_FILES = 500;
const DIRTY_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const FILESYSTEM_WALK_MAX_FILES = 2000;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function git(projectRoot, args) {
  try {
    return await runProcess({
      executable: "git",
      args: ["-C", path.resolve(projectRoot), ...args],
      cwd: projectRoot,
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024
    });
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}

/**
 * A git porcelain path can be quoted and, for renames/copies, carry an
 * `orig -> new` pair. Return the on-disk path that matters (the destination).
 */
function porcelainWorkingPath(entry) {
  let raw = String(entry).trim();
  const arrow = raw.indexOf(" -> ");
  if (arrow >= 0) raw = raw.slice(arrow + 4);
  if (raw.startsWith("\"") && raw.endsWith("\"")) raw = raw.slice(1, -1);
  return raw;
}

/**
 * Hash the *contents* of a fixed set of working-tree paths so that editing an
 * already-dirty (or untracked) file changes the fingerprint even though
 * `git status` output does not.
 */
async function hashFileSet(root, relativePaths) {
  const digest = crypto.createHash("sha256");
  const ordered = [...new Set(relativePaths.map(porcelainWorkingPath).filter(Boolean))].sort();
  const truncated = ordered.length > DIRTY_CONTENT_MAX_FILES;
  for (const relative of ordered.slice(0, DIRTY_CONTENT_MAX_FILES)) {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = await fsp.lstat(absolute);
    } catch {
      digest.update(`${relative}\0missing\n`);
      continue;
    }
    if (stat.isDirectory()) {
      digest.update(`${relative}\0dir\n`);
      continue;
    }
    if (!stat.isFile()) {
      digest.update(`${relative}\0special\n`);
      continue;
    }
    digest.update(`${relative}\0${stat.size}\0`);
    if (stat.size <= DIRTY_CONTENT_MAX_BYTES) {
      try {
        digest.update(await fsp.readFile(absolute));
      } catch {
        digest.update(`unreadable:${stat.mtimeMs}`);
      }
    } else {
      digest.update(`large:${stat.mtimeMs}`);
    }
    digest.update("\n");
  }
  return { hash: digest.digest("hex"), truncated };
}

/**
 * Bounded recursive fingerprint of a non-git directory: `path\0size\0mtime` for
 * every file outside the usual build/vendor directories, so a plain edit still
 * moves the fingerprint.
 */
async function filesystemFingerprint(root) {
  const digest = crypto.createHash("sha256");
  let count = 0;
  let truncated = false;

  async function walk(directory) {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fsp.stat(absolute);
      } catch {
        continue;
      }
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      digest.update(`${relative}\0${stat.size}\0${stat.mtimeMs}\n`);
      count += 1;
      if (count >= FILESYSTEM_WALK_MAX_FILES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(root);
  return { hash: digest.digest("hex"), count, truncated };
}

/**
 * Snapshot a project's verification state. For a git repo this is HEAD + branch
 * + full porcelain status + the contents of every dirty/untracked file, hashed
 * into a `fingerprint`. For a non-git directory it is a bounded recursive
 * `path/size/mtime` walk. Strength is `"strong"` for a complete git snapshot,
 * `"medium"` when the file set was truncated or the directory is non-git, and
 * `"weak"` only when nothing could be fingerprinted.
 *
 * @param {string} projectRoot - Repository or directory path.
 * @returns {Promise<{ kind: "git" | "filesystem", project_root: string, git: boolean, head?: string, branch?: string, dirty?: boolean, dirty_files?: string[], status_hash?: string, content_hash?: string, file_count?: number, fingerprint: string, captured_at: string, strength: "strong" | "medium" | "weak" }>}
 */
export async function captureProjectState(projectRoot) {
  const rootResult = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    const resolvedRoot = path.resolve(projectRoot);
    const walk = await filesystemFingerprint(resolvedRoot);
    return {
      kind: "filesystem",
      project_root: resolvedRoot,
      git: false,
      file_count: walk.count,
      content_hash: walk.hash,
      fingerprint: hash(`filesystem:${resolvedRoot}\n${walk.hash}`),
      captured_at: new Date().toISOString(),
      strength: walk.count > 0 ? "medium" : "weak"
    };
  }
  const gitRoot = rootResult.stdout.trim();
  const [head, branch, status] = await Promise.all([
    git(gitRoot, ["rev-parse", "HEAD"]),
    git(gitRoot, ["branch", "--show-current"]),
    git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const statusText = status.stdout.replace(/\r\n/g, "\n").trimEnd();
  const dirtyFiles = statusText
    ? statusText.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  const headValue = head.ok ? head.stdout.trim() : "";
  const dirtyContent = await hashFileSet(gitRoot, dirtyFiles);
  return {
    kind: "git",
    project_root: gitRoot,
    git: true,
    head: headValue,
    branch: branch.ok ? branch.stdout.trim() : "",
    dirty: dirtyFiles.length > 0,
    dirty_files: dirtyFiles,
    status_hash: hash(statusText),
    content_hash: dirtyContent.hash,
    fingerprint: hash(`${headValue}\n${statusText}\n${dirtyContent.hash}`),
    captured_at: new Date().toISOString(),
    strength: dirtyContent.truncated ? "medium" : "strong"
  };
}

/**
 * Bind a check result to the project state it was produced from, so completion
 * can later prove the evidence is still current.
 *
 * @param {{ type: string, result?: { status?: string, gate?: string, ok?: boolean }, projectState: { fingerprint: string, head?: string }, details?: Record<string, unknown> }} input
 * @returns {{ type: string, status: string, source_state_fingerprint: string, source_head: string | null, captured_at: string, details: Record<string, unknown> }}
 */
export function bindEvidence({ type, result, projectState, details = {} }) {
  return {
    type,
    status: result?.status || result?.gate || (result?.ok ? "passed" : "unknown"),
    source_state_fingerprint: projectState.fingerprint,
    source_head: projectState.head || null,
    captured_at: new Date().toISOString(),
    details
  };
}

/**
 * True when `evidence` was captured against the exact `projectState` fingerprint
 * (i.e. nothing has changed since the check ran).
 *
 * @param {{ source_state_fingerprint?: string } | null | undefined} evidence
 * @param {{ fingerprint?: string } | null | undefined} projectState
 * @returns {boolean}
 */
export function evidenceMatchesState(evidence, projectState) {
  return Boolean(
    evidence?.source_state_fingerprint
    && evidence.source_state_fingerprint === projectState?.fingerprint
  );
}
