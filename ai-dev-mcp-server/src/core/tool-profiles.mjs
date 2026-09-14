/**
 * Capability profiles: eight named slices of the tool surface.
 *
 * The server exposes 133 tools. That is a strength when an agent needs one of
 * them and a cost the rest of the time: every tool in `tools/list` is schema
 * text in the model's context before the first word of the task is read. The
 * profiles cut the surface along the lines a person already thinks in — "I am
 * writing backend code", "I am reviewing a diff", "I am building a screen" —
 * so a session can carry the tools it will use and leave the rest out.
 *
 * `core` is the spine and is always on: project context, skill routing, and the
 * task lifecycle through to a verified completion. Every other profile is
 * additive, and none of them is required for the system to do the thing it
 * promises.
 *
 * The mapping is exhaustive and exclusive — every tool the server exposes
 * belongs to exactly one profile. `scripts/render-tool-reference.mjs` checks
 * that against the live tool list and fails in CI when a new tool has no home,
 * the same way it already refuses a tool that belongs to no documentation
 * group.
 */

/**
 * @typedef {object} ToolProfile
 * @property {string} id Stable identifier used in `AI_DEV_PROFILES`.
 * @property {string} title Human-readable name.
 * @property {string} summary One line: what a session gains by turning it on.
 * @property {boolean} always `true` when the profile cannot be switched off.
 * @property {readonly string[]} tools Tool names, in the order they are documented.
 */

/** The profile that is on in every session, whatever the setting says. */
export const ALWAYS_ON_PROFILE = "core";

/** The setting value that asks for the whole tool surface. */
export const ALL_PROFILES = "all";

/** @type {readonly ToolProfile[]} */
export const TOOL_PROFILES = Object.freeze([
  {
    id: "core",
    title: "Core",
    summary: "Project context, skill routing, and a task from first command to verified completion.",
    always: true,
    tools: Object.freeze([
      "search_knowledge",
      "read_knowledge",
      "search_all",
      "hybrid_search",
      "preset_search",
      "search_skills",
      "read_skill",
      "recommend_skills",
      "bootstrap_project",
      "prepare_project",
      "project_identity",
      "list_projects",
      "read_project",
      "register_project",
      "analyze_project",
      "compile_project_context",
      "project_context_status",
      "begin_task",
      "get_task",
      "list_tasks",
      "checkpoint_task",
      "run_quality_gate",
      "verify_task",
      "complete_task",
      "system_health_check"
    ])
  },
  {
    id: "coding",
    title: "Coding",
    summary: "Work too big for one arc: epics, the plan gate, project cards, and the repository's own rules.",
    always: false,
    tools: Object.freeze([
      "decompose_task",
      "epic_status",
      "plan_task",
      "plan_status",
      "coverage_gaps",
      "list_auto_commands",
      "match_auto_command",
      "read_auto_command",
      "sync_project_card",
      "update_project_card",
      "refresh_project_map",
      "refresh_project_memory",
      "start_project_pilot",
      "record_project_pilot_review",
      "project_pilot_status",
      "list_rule_packs",
      "install_project_rules",
      "distill_project_rules"
    ])
  },
  {
    id: "memory",
    title: "Memory",
    summary: "What survives the session: decisions, handoffs, learned instincts, and the notes behind them.",
    always: false,
    tools: Object.freeze([
      "record_decision",
      "list_decisions",
      "save_session",
      "resume_session",
      "list_sessions",
      "context_budget_status",
      "record_instinct",
      "propose_instincts",
      "list_instincts",
      "update_instinct",
      "evolve_instincts",
      "export_instincts",
      "import_instincts",
      "prune_state",
      "write_knowledge_note",
      "append_knowledge_note"
    ])
  },
  {
    id: "git",
    title: "Git",
    summary: "Everything that touches the working tree: isolated worktrees, snapshots and rollback, diff review, pull request text.",
    always: false,
    tools: Object.freeze([
      "begin_task_in_worktree",
      "list_task_worktrees",
      "plan_worktree_cleanup",
      "remove_task_worktree",
      "snapshot_task",
      "list_task_snapshots",
      "rollback_task",
      "verify_change_hygiene",
      "prepare_pull_request"
    ])
  },
  {
    id: "frontend",
    title: "Frontend",
    summary: "User-facing surfaces: brief, visual directions, design system, and the references behind them.",
    always: false,
    tools: Object.freeze([
      "query_ui_ux_knowledge",
      "frontend_product_builder",
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "record_frontend_directions",
      "approve_frontend_direction",
      "record_frontend_concept_jury",
      "approve_frontend_design_system",
      "generate_ui_ux_design_system",
      "plan_frontend_references",
      "register_frontend_references",
      "reference_factory_status",
      "frontend_product_gate"
    ])
  },
  {
    id: "qa",
    title: "QA",
    summary: "Runners that produce evidence: Playwright and visual QA, and the benchmarks that hold search and routing honest.",
    always: false,
    tools: Object.freeze([
      "run_frontend_qa",
      "run_visual_reference_qa",
      "record_visual_review",
      "run_search_eval",
      "run_skill_routing_eval",
      "validate_skill_library",
      "skill_outcome_status",
      "rebuild_skill_outcomes"
    ])
  },
  {
    id: "security",
    title: "Security",
    summary: "The guard rails: secret and dependency scans, command and write policy, and an inventory of what your agents are wired to.",
    always: false,
    tools: Object.freeze([
      "run_security_scan",
      "install_agent_hooks",
      "agent_hooks_status",
      "list_policy_rules",
      "upsert_policy_rule",
      "remove_policy_rule",
      "list_mcp_servers",
      "scan_agent_config"
    ])
  },
  {
    id: "advanced",
    title: "Advanced",
    summary: "Maintaining the system itself: diagrams, the search and skill indexes, the dashboard, usage, and packaging a runtime for another machine.",
    always: false,
    tools: Object.freeze([
      "archify_doctor",
      "archify_guide",
      "archify_brands",
      "archify_validate",
      "archify_render",
      "archify_deliver",
      "archify_visual_check",
      "archify_compare",
      "archify_migrate",
      "search_index_status",
      "rebuild_search_index",
      "list_search_presets",
      "explain_search",
      "embed_texts",
      "embedding_status",
      "search_projects",
      "search_notes",
      "search_skill_registry",
      "rebuild_index",
      "list_skill_groups",
      "browse_skill_group",
      "rebuild_skill_taxonomy",
      "sync_skill_overlays",
      "list_skill_overlays",
      "upsert_skill_overlay",
      "sync_skill_cards",
      "list_skill_cards",
      "search_skill_cards",
      "read_skill_card",
      "import_skill_repo",
      "rebuild_system_dashboard",
      "system_dashboard_status",
      "record_usage",
      "usage_report",
      "prepare_runtime_distribution",
      "runtime_distribution_status"
    ])
  }
]);

/** @type {ReadonlyMap<string, ToolProfile>} */
const BY_ID = new Map(TOOL_PROFILES.map((profile) => [profile.id, profile]));

/** @type {ReadonlyMap<string, string>} */
const PROFILE_OF_TOOL = new Map(
  TOOL_PROFILES.flatMap((profile) => profile.tools.map((tool) => [tool, profile.id]))
);

/** Every profile id, in documentation order. @type {readonly string[]} */
export const PROFILE_IDS = Object.freeze(TOOL_PROFILES.map((profile) => profile.id));

/**
 * @param {string} id
 * @returns {ToolProfile | undefined}
 */
export function findProfile(id) {
  return BY_ID.get(String(id || "").trim().toLowerCase());
}

/**
 * @param {string} toolName
 * @returns {string | undefined} The profile that owns the tool, if any does.
 */
export function profileOfTool(toolName) {
  return PROFILE_OF_TOOL.get(toolName);
}

/**
 * Read an `AI_DEV_PROFILES` value. The setting is deliberately forgiving —
 * a typo should not silently cost a session half its tools, so an unknown name
 * is reported and everything else still resolves.
 *
 * An empty or absent value means the whole surface, so an installation that
 * never heard of profiles behaves exactly as it did before they existed.
 *
 * @param {string | undefined | null} raw
 * @returns {{ ids: string[], all: boolean, unknown: string[] }}
 */
export function parseProfileSetting(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ids: [...PROFILE_IDS], all: true, unknown: [] };

  const requested = text
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes(ALL_PROFILES)) return { ids: [...PROFILE_IDS], all: true, unknown: [] };

  const unknown = [];
  const ids = new Set([ALWAYS_ON_PROFILE]);
  for (const name of requested) {
    if (BY_ID.has(name)) ids.add(name);
    else unknown.push(name);
  }
  const ordered = PROFILE_IDS.filter((id) => ids.has(id));
  return { ids: ordered, all: ordered.length === PROFILE_IDS.length, unknown };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ids: string[], all: boolean, unknown: string[], source: string }}
 */
export function profilesFromEnvironment(env = process.env) {
  const raw = env?.AI_DEV_PROFILES;
  return { ...parseProfileSetting(raw), source: raw ? "AI_DEV_PROFILES" : "default (every profile)" };
}

/**
 * @param {readonly string[]} profileIds
 * @returns {Set<string>} Every tool name the given profiles carry.
 */
export function resolveToolNames(profileIds) {
  const names = new Set();
  for (const id of [ALWAYS_ON_PROFILE, ...profileIds]) {
    const profile = BY_ID.get(id);
    if (profile) for (const tool of profile.tools) names.add(tool);
  }
  return names;
}

/**
 * Narrow a tool list to the active profiles, preserving its order.
 *
 * A tool the mapping has never heard of is kept rather than dropped: an
 * extension that registers a tool at runtime should stay callable even before
 * anyone has filed it under a profile.
 *
 * @template {{ name: string }} T
 * @param {readonly T[]} tools
 * @param {readonly string[]} profileIds
 * @returns {T[]}
 */
export function filterToolsByProfiles(tools, profileIds) {
  const allowed = resolveToolNames(profileIds);
  return tools.filter((tool) => !PROFILE_OF_TOOL.has(tool.name) || allowed.has(tool.name));
}

/**
 * Check the mapping against the tool list the server actually exposes.
 *
 * @param {readonly string[]} toolNames
 * @returns {{ missing: string[], unknown: string[], duplicated: string[] }}
 */
export function auditProfileCoverage(toolNames) {
  const live = new Set(toolNames);
  const seen = new Set();
  const duplicated = [];
  for (const profile of TOOL_PROFILES) {
    for (const tool of profile.tools) {
      if (seen.has(tool)) duplicated.push(tool);
      seen.add(tool);
    }
  }
  return {
    missing: [...live].filter((name) => !seen.has(name)),
    unknown: [...seen].filter((name) => !live.has(name)),
    duplicated
  };
}
