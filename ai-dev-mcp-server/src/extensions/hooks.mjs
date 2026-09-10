import path from "node:path";
import {
  CURSOR_HOOKS_FORMATS,
  CURSOR_HOOKS_FORMAT_VERSION,
  HOOK_PROFILES,
  HOOK_TARGETS,
  HOOKS_RELATIVE_DIR,
  POLICY_RELATIVE_PATH,
  agentHooksStatus,
  installAgentHooks
} from "../core/agent-hooks.mjs";

/**
 * Agent hooks tools: install deterministic client-side guards (Claude Code /
 * Cursor hooks) that complement the MCP server: block --no-verify and
 * destructive commands, protect secrets and linter configs, auto-format,
 * inject the last handoff on session start, capture session summaries, and
 * advise on strategic compaction.
 *
 * @param {{ resolveProjectIdentity: Function, serverRoot: string, markSearchIndexDirty?: Function }} host
 */
export function createHookTools(host) {
  return {
    definitions: [
      {
        name: "install_agent_hooks",
        description: "Install the AI Dev agent hooks into a repository: self-contained scripts under .ai-dev/hooks, a hookify-style .ai-dev/policy.json, and registrations in .claude/settings.json (Claude Code) and/or .cursor/hooks.json (Cursor). Re-running refreshes the scripts and keeps custom policy rules.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            targets: { type: "array", items: { type: "string", enum: HOOK_TARGETS }, default: ["claude"] },
            profile: { type: "string", enum: HOOK_PROFILES, default: "standard", description: "minimal: guards + session capture; standard: + session start context, formatting, compaction advice, stop checks; strict: standard + push/amend warnings." },
            overwrite: { type: "boolean", default: false, description: "Also reset .ai-dev/policy.json to defaults." },
            cursor_format_version: { type: "number", enum: CURSOR_HOOKS_FORMATS, default: CURSOR_HOOKS_FORMAT_VERSION, description: "Format version of .cursor/hooks.json to write. Cursor 3.x still reads version 1; a new format gets its own adapter rather than a rewrite of this one." },
            dry_run: { type: "boolean", default: false }
          },
          required: ["project_path"]
        }
      },
      {
        name: "agent_hooks_status",
        description: "Report which AI Dev hooks, policy, and harness registrations are installed in a repository.",
        inputSchema: {
          type: "object",
          properties: { project_path: { type: "string" } },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      async install_agent_hooks(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const result = await installAgentHooks({
          projectRoot: identity.project_root,
          hooksSourceDir: path.join(host.serverRoot, "hooks"),
          targets: args.targets?.length ? args.targets : ["claude"],
          profile: args.profile || "standard",
          overwrite: Boolean(args.overwrite),
          cursorFormatVersion: args.cursor_format_version || CURSOR_HOOKS_FORMAT_VERSION,
          dryRun: Boolean(args.dry_run)
        });
        return {
          action: args.dry_run ? "hooks_planned" : "hooks_installed",
          project_path: identity.project_root,
          hooks_dir: HOOKS_RELATIVE_DIR,
          policy_path: POLICY_RELATIVE_PATH,
          ...result,
          next_step: [
            ...result.warnings.map((warning) => `Resolve by hand: ${warning}`),
            args.dry_run
              ? "Re-run without dry_run to write the files."
              : "Restart the client (or start a new session) so the hooks load; tune .ai-dev/policy.json rules and profile as needed. Commit .ai-dev/hooks, .ai-dev/policy.json, and the harness registration files."
          ].join(" ")
        };
      },
      async agent_hooks_status(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        return agentHooksStatus(identity.project_root);
      }
    },
    readOnly: ["agent_hooks_status"]
  };
}
