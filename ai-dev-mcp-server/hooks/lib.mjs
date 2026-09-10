// Shared helpers for the AI Dev System agent hooks. Zero dependencies: these
// files are copied into a project's .ai-dev/hooks/ and run on the developer's
// machine by Claude Code / Cursor, possibly while the MCP server runs in Docker.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const MAX_STDIN = 1024 * 1024;
export const PROFILES = ["minimal", "standard", "strict"];

export function log(message) {
  process.stderr.write(`${message}\n`);
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let truncated = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (data.length >= MAX_STDIN) {
        truncated = true;
        return;
      }
      data += chunk.slice(0, MAX_STDIN - data.length);
    });
    process.stdin.on("end", () => resolve({ raw: data, truncated }));
    process.stdin.on("error", () => resolve({ raw: data, truncated }));
    setTimeout(() => resolve({ raw: data, truncated }), 2000).unref();
  });
}

/** Normalize Claude Code and Cursor payloads to one shape. */
export function normalizeInput(raw) {
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const toolInput = payload.tool_input ?? payload.args ?? {};
  return {
    payload,
    event: String(payload.hook_event_name || payload.hookName || ""),
    tool: String(payload.tool_name || payload.tool || ""),
    command: String(toolInput.command ?? payload.command ?? ""),
    filePath: String(toolInput.file_path ?? payload.file_path ?? payload.path ?? payload.file ?? ""),
    content: String(toolInput.content ?? toolInput.new_string ?? payload.new_text ?? payload.content ?? ""),
    edits: Array.isArray(toolInput.edits) ? toolInput.edits : [],
    transcriptPath: String(payload.transcript_path ?? payload.transcriptPath ?? ""),
    sessionId: String(payload.session_id ?? payload.conversation_id ?? process.env.CLAUDE_SESSION_ID ?? "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default",
    cwd: String(payload.cwd || process.cwd()),
    source: String(payload.source || "")
  };
}

export function isCursor() {
  return process.argv.includes("--cursor");
}

/** Block the tool call. Claude Code: exit 2 + stderr. Cursor: permission JSON. */
export function block(reason) {
  if (isCursor()) {
    process.stdout.write(`${JSON.stringify({ permission: "deny", userMessage: reason, agentMessage: reason })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Non-blocking note injected into the model's next turn. */
export function emitContext(eventName, text) {
  if (!text) return;
  if (isCursor()) {
    process.stdout.write(`${JSON.stringify({ additional_context: text })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })}\n`);
}

export function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function realpathOf(target) {
  try {
    // fs.realpathSync, not realpathSync.native: the server resolves roots with
    // fs.realpath (core/project-identity.mjs), and on Windows the native variant
    // also expands 8.3 short names (RUNNER~1 -> runneradmin). Two spellings of
    // one directory would key two different project ids, so the hook and the
    // server must resolve them the same way.
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}


function hashKey(key) {
  return crypto.createHash("sha256").update(process.platform === "win32" ? key.toLowerCase() : key).digest("hex").slice(0, 20);
}

export function projectRootOf(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return realpathOf(top || cwd);
}

/** Same normalization as the server's project identity: POSIX separators, case-folded on Windows. */
export function normalizePath(value) {
  const resolved = path.resolve(String(value ?? "")).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Compare two paths the way the platform does: Windows ignores case and separator style. */
export function samePath(left, right) {
  if (!left || !right) return false;
  return normalizePath(left) === normalizePath(right);
}

/** Repository-relative path with POSIX separators, whatever the platform. */
export function relativePosix(fromRoot, target) {
  return path.relative(fromRoot, target).replaceAll("\\", "/");
}

/** Same derivation as the server's resolveProjectIdentity (core/project-identity.mjs). */
export function projectIdOf(projectRoot, isGit = true) {
  return `project-${hashKey(`${isGit ? "git" : "filesystem"}:${normalizePath(projectRoot)}`)}`;
}

/**
 * Same derivation as the server's repositoryId (core/project-identity.mjs): the
 * clone's `--git-common-dir` (identical in every linked worktree) plus the
 * project's path inside its own worktree. Empty outside Git.
 */
export function repositoryIdOf(projectRoot) {
  const root = path.resolve(projectRoot);
  const commonDir = git(root, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return "";
  const canonicalCommonDir = realpathOf(path.isAbsolute(commonDir) ? commonDir : path.resolve(root, commonDir));
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  const relative = path.relative(realpathOf(toplevel || root), realpathOf(root)).replaceAll("\\", "/");
  const scope = !relative || relative.startsWith("..") ? "" : `#${relative}`;
  return `repository-${hashKey(`git-common:${normalizePath(canonicalCommonDir)}${scope}`)}`;
}

/**
 * Read order for the memory a repository shares across its worktrees: the
 * repository id first, then the project id records were written under before
 * repository ids existed. Writers use the first key and migrate the rest.
 */
export function memoryKeysOf(projectRoot, isGit = true) {
  const keys = [];
  const repository = isGit ? repositoryIdOf(projectRoot) : "";
  if (repository) keys.push(repository);
  const project = projectIdOf(projectRoot, isGit);
  if (!keys.includes(project)) keys.push(project);
  return keys;
}

export function stateRoot() {
  if (process.env.AI_DEV_STATE_ROOT) return path.resolve(process.env.AI_DEV_STATE_ROOT);
  const home = process.env.AI_DEV_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".ai-dev", "state");
}

/** Same sanitisation as the server's SessionStore.directoryFor. */
export function sessionsDirectory(key) {
  return path.join(stateRoot(), "sessions", String(key || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

/**
 * Move handoffs a legacy key wrote into the first key's directory, so the
 * split between a worktree and its main checkout disappears on the first
 * capture. Best effort: readers merge every key anyway.
 */
export function migrateSessions(keys) {
  const [primary, ...legacy] = keys;
  if (!primary || !legacy.length) return;
  const target = sessionsDirectory(primary);
  for (const key of legacy) {
    const source = sessionsDirectory(key);
    let names = [];
    try {
      names = fs.readdirSync(source).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    if (!names.length) continue;
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) {
      const destination = path.join(target, name);
      if (fs.existsSync(destination)) continue;
      try {
        fs.renameSync(path.join(source, name), destination);
      } catch {
        // Keep the legacy copy: every reader still merges both keys.
      }
    }
    try {
      fs.rmdirSync(source);
    } catch {
      // Records that could not move keep the directory alive.
    }
  }
}

export function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadPolicy(projectRoot) {
  const policy = readJson(path.join(projectRoot, ".ai-dev", "policy.json"), {}) || {};
  const patterns = readJson(path.join(projectRoot, ".ai-dev", "hooks", "patterns.json"), {}) || {};
  const envProfile = String(process.env.AI_DEV_HOOK_PROFILE || "").toLowerCase();
  const profile = PROFILES.includes(envProfile) ? envProfile : PROFILES.includes(policy.profile) ? policy.profile : "standard";
  return { ...policy, profile, patterns, rules: Array.isArray(policy.rules) ? policy.rules : [] };
}

export function hooksDisabled(hookId) {
  const flag = String(process.env.AI_DEV_HOOKS_ENABLED || "true").toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return true;
  const disabled = String(process.env.AI_DEV_DISABLED_HOOKS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return disabled.includes(hookId);
}

export function profileAllows(profile, allowed) {
  return allowed.includes(profile);
}

export function compileRegex(source, flags = "i") {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Split a shell command into segments on unquoted ; | & and newlines, stripping quotes. */
export function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  // Also inspect command substitutions and sh -c bodies.
  const nested = [];
  for (const segment of segments) {
    for (const match of segment.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push((match[1] || match[2] || "").trim());
    const wrapper = segment.match(/^(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\s+-c\s+(.+)$/);
    if (wrapper) nested.push(wrapper[1].trim());
  }
  return [...segments, ...nested.filter(Boolean)];
}

export function tokensOf(segment) {
  return segment.split(/\s+/).filter(Boolean);
}
