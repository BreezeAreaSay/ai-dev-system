import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-files.mjs";
import { PROTECTED_CONFIG_FILES, SECRET_FILE_PATTERN, SECRET_PATTERNS } from "./change-hygiene.mjs";

export const HOOK_FILES = ["lib.mjs", "guard.mjs", "post-edit.mjs", "session-start.mjs", "session-end.mjs", "compact-advisor.mjs", "stop-check.mjs"];
export const HOOK_TARGETS = ["claude", "cursor"];
export const HOOK_PROFILES = ["minimal", "standard", "strict"];
export const HOOKS_RELATIVE_DIR = ".ai-dev/hooks";
export const POLICY_RELATIVE_PATH = ".ai-dev/policy.json";
const COMMAND_MARKER = ".ai-dev/hooks/";

/**
 * Default `.ai-dev/policy.json`: hookify-style rules the project can extend.
 *
 * @param {string} [profile]
 * @returns {object}
 */
export function defaultPolicy(profile = "standard") {
  return {
    schema_version: 1,
    profile: HOOK_PROFILES.includes(profile) ? profile : "standard",
    allow_config_edits: false,
    format_on_edit: true,
    compact_tool_threshold: 50,
    compact_context_threshold: 0,
    compact_context_interval: 60000,
    allow_commands: [],
    rules: [
      {
        id: "warn-eval",
        event: "file",
        pattern: "\\beval\\s*\\(",
        action: "warn",
        message: "Dynamic code evaluation is a security smell; prefer explicit parsing or a sandboxed evaluator."
      },
      {
        id: "warn-inner-html",
        event: "file",
        pattern: "\\.innerHTML\\s*=|dangerouslySetInnerHTML",
        action: "warn",
        message: "Raw HTML injection: sanitize the value or use text APIs."
      },
      {
        id: "block-prod-migrations",
        event: "bash",
        pattern: "(migrate|migration).*(--prod|production)|prisma\\s+migrate\\s+deploy",
        action: "block",
        message: "Production migrations need explicit human approval."
      }
    ]
  };
}

/**
 * Serialize the server's secret and config patterns for the hooks so the
 * guard and the MCP hygiene scan never drift.
 *
 * @returns {object}
 */
export function renderHookPatterns() {
  return {
    generated_by: "ai-dev-system install_agent_hooks",
    secrets: SECRET_PATTERNS.map((rule) => ({
      id: rule.id,
      severity: rule.severity,
      source: rule.pattern.source,
      flags: rule.pattern.flags,
      placeholder_aware: Boolean(rule.placeholderAware)
    })),
    secret_file: SECRET_FILE_PATTERN.source,
    protected_config_files: [...PROTECTED_CONFIG_FILES]
  };
}

function command(script, ...args) {
  return { type: "command", command: ["node", `${HOOKS_RELATIVE_DIR}/${script}`, ...args].join(" ") };
}

/**
 * Claude Code hook registrations for a profile.
 *
 * @param {string} profile
 * @returns {Record<string, object[]>}
 */
export function claudeHookEntries(profile = "standard") {
  const full = profile !== "minimal";
  const hooks = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ ...command("guard.mjs", "bash"), timeout: 10 }] },
      { matcher: "Write|Edit|MultiEdit", hooks: [{ ...command("guard.mjs", "file"), timeout: 10 }] }
    ],
    Stop: [{ hooks: [{ ...command("session-end.mjs"), timeout: 30 }] }],
    PreCompact: [{ hooks: [{ ...command("session-end.mjs", "--compact"), timeout: 30 }] }]
  };
  if (full) {
    hooks.PreToolUse.push({ matcher: "Edit|Write", hooks: [{ ...command("compact-advisor.mjs"), timeout: 5 }] });
    hooks.PostToolUse = [{ matcher: "Write|Edit|MultiEdit", hooks: [{ ...command("post-edit.mjs"), timeout: 30 }] }];
    hooks.SessionStart = [{ hooks: [{ ...command("session-start.mjs"), timeout: 10 }] }];
    hooks.Stop[0].hooks.push({ ...command("stop-check.mjs"), timeout: 30 });
  }
  return hooks;
}

/**
 * Cursor hook registrations (`.cursor/hooks.json`, version 1).
 *
 * @param {string} profile
 * @returns {object}
 */
export function cursorHooksDocument(profile = "standard") {
  const full = profile !== "minimal";
  const entry = (script, ...args) => ({ command: ["node", `${HOOKS_RELATIVE_DIR}/${script}`, ...args, "--cursor"].join(" ") });
  const hooks = {
    beforeShellExecution: [entry("guard.mjs", "bash")],
    sessionEnd: [entry("session-end.mjs")],
    preCompact: [entry("session-end.mjs", "--compact")]
  };
  if (full) {
    hooks.afterFileEdit = [entry("post-edit.mjs")];
    hooks.sessionStart = [entry("session-start.mjs")];
    hooks.stop = [entry("stop-check.mjs")];
  }
  return { version: 1, hooks };
}

function isOurs(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
  return hooks.some((hook) => String(hook?.command || "").includes(COMMAND_MARKER));
}

/**
 * Merge our registrations into an existing Claude Code settings document:
 * previous AI Dev entries are replaced, everything else is preserved.
 *
 * @param {object} current - Existing settings.json content.
 * @param {Record<string, object[]>} entries - From {@link claudeHookEntries}.
 * @returns {object}
 */
export function mergeClaudeSettings(current, entries) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current) : {};
  const hooks = document.hooks && typeof document.hooks === "object" ? { ...document.hooks } : {};
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
    if (!hooks[event]?.length) delete hooks[event];
  }
  for (const [event, list] of Object.entries(entries)) {
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  document.hooks = hooks;
  return document;
}

/**
 * Merge our registrations into an existing Cursor hooks document.
 *
 * @param {object} current
 * @param {object} ours - From {@link cursorHooksDocument}.
 * @returns {object}
 */
export function mergeCursorHooks(current, ours) {
  const document = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current) : { version: 1 };
  const hooks = document.hooks && typeof document.hooks === "object" ? { ...document.hooks } : {};
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
    if (!hooks[event]?.length) delete hooks[event];
  }
  for (const [event, list] of Object.entries(ours.hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  return { ...document, version: document.version || 1, hooks };
}

async function readJson(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot parse ${target}: ${error.message}`);
  }
}

async function readText(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Install the hook scripts, patterns, policy, and harness registrations into
 * a repository.
 *
 * @param {{ projectRoot: string, hooksSourceDir: string, targets?: string[], profile?: string, overwrite?: boolean, dryRun?: boolean }} input
 * @returns {Promise<{ profile: string, targets: string[], written: string[], updated: string[], skipped: string[], planned: string[], backups: string[] }>}
 */
export async function installAgentHooks({ projectRoot, hooksSourceDir, targets = ["claude"], profile = "standard", overwrite = false, dryRun = false }) {
  if (!HOOK_PROFILES.includes(profile)) throw new Error(`Unknown hook profile: ${profile}. Known: ${HOOK_PROFILES.join(", ")}`);
  for (const target of targets) {
    if (!HOOK_TARGETS.includes(target)) throw new Error(`Unknown hooks target: ${target}. Known: ${HOOK_TARGETS.join(", ")}`);
  }
  const root = path.resolve(projectRoot);
  const written = [];
  const updated = [];
  const skipped = [];
  const planned = [];
  const backups = [];

  async function writeManaged(relativePath, content) {
    const absolute = path.join(root, ...relativePath.split("/"));
    const current = await readText(absolute);
    if (current === content) {
      skipped.push(`${relativePath} (current)`);
      return;
    }
    if (dryRun) {
      planned.push(relativePath);
      return;
    }
    await atomicWriteFile(absolute, content, "utf8");
    (current === null ? written : updated).push(relativePath);
  }

  for (const name of HOOK_FILES) {
    const source = await fs.readFile(path.join(hooksSourceDir, name), "utf8");
    await writeManaged(`${HOOKS_RELATIVE_DIR}/${name}`, source);
  }
  await writeManaged(`${HOOKS_RELATIVE_DIR}/patterns.json`, `${JSON.stringify(renderHookPatterns(), null, 2)}\n`);

  const policyPath = path.join(root, ...POLICY_RELATIVE_PATH.split("/"));
  const existingPolicy = await readText(policyPath);
  if (existingPolicy === null || overwrite) {
    await writeManaged(POLICY_RELATIVE_PATH, `${JSON.stringify(defaultPolicy(profile), null, 2)}\n`);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(existingPolicy);
    } catch {
      skipped.push(`${POLICY_RELATIVE_PATH} (exists but is not valid JSON; fix it by hand)`);
    }
    if (parsed && parsed.profile !== profile) {
      await writeManaged(POLICY_RELATIVE_PATH, `${JSON.stringify({ ...parsed, profile }, null, 2)}\n`);
    } else if (parsed) {
      skipped.push(`${POLICY_RELATIVE_PATH} (kept)`);
    }
  }

  if (targets.includes("claude")) {
    const settingsPath = path.join(root, ".claude", "settings.json");
    const current = await readJson(settingsPath);
    const next = mergeClaudeSettings(current, claudeHookEntries(profile));
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    const currentText = current === null ? null : await readText(settingsPath);
    if (currentText === nextText) {
      skipped.push(".claude/settings.json (current)");
    } else if (dryRun) {
      planned.push(".claude/settings.json");
    } else {
      if (currentText !== null) {
        const backup = `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await fs.copyFile(settingsPath, backup);
        backups.push(path.relative(root, backup).replaceAll("\\", "/"));
      }
      await atomicWriteFile(settingsPath, nextText, "utf8");
      (currentText === null ? written : updated).push(".claude/settings.json");
    }
  }

  if (targets.includes("cursor")) {
    const cursorPath = path.join(root, ".cursor", "hooks.json");
    const current = await readJson(cursorPath);
    const next = mergeCursorHooks(current, cursorHooksDocument(profile));
    await writeManaged(".cursor/hooks.json", `${JSON.stringify(next, null, 2)}\n`);
  }

  return { profile, targets, written, updated, skipped, planned, backups };
}

/**
 * Report what is installed.
 *
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */
export async function agentHooksStatus(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = {};
  for (const name of [...HOOK_FILES, "patterns.json"]) {
    files[name] = await readText(path.join(root, ".ai-dev", "hooks", name)) !== null;
  }
  const policyText = await readText(path.join(root, ".ai-dev", "policy.json"));
  let policy = null;
  try {
    policy = policyText ? JSON.parse(policyText) : null;
  } catch {
    policy = { error: "policy.json is not valid JSON" };
  }
  const claude = await readJson(path.join(root, ".claude", "settings.json")).catch(() => null);
  const cursor = await readJson(path.join(root, ".cursor", "hooks.json")).catch(() => null);
  const count = (document) => Object.values(document?.hooks ?? {}).flat().filter(isOurs).length;
  return {
    project_path: root,
    hooks_dir: HOOKS_RELATIVE_DIR,
    files,
    installed: Object.values(files).every(Boolean),
    profile: policy?.profile ?? null,
    policy_rules: Array.isArray(policy?.rules) ? policy.rules.length : 0,
    claude_entries: count(claude),
    cursor_entries: count(cursor)
  };
}
