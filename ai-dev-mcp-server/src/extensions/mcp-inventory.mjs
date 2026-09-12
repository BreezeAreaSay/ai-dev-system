/**
 * The MCP surface over the MCP inventory: what servers this repository wires
 * into its agents, read out of the config files the clients load.
 *
 * The reading lives in `src/core/mcp-inventory.mjs`; this module resolves the
 * project and turns the report into the one sentence a caller should act on.
 */
import { listMcpServers } from "../core/mcp-inventory.mjs";

function nextStep(report) {
  const { block, warn } = report.summary;
  if (block) {
    const files = [...new Set(report.findings.filter((finding) => finding.severity === "block").map((finding) => finding.path))];
    return `Move ${block} credential${block === 1 ? "" : "s"} out of ${files.join(", ")} into the environment and reference them as \${VAR}. A value that has been committed is already in every clone: rotate it, do not just delete the line.`;
  }
  if (warn) return `${warn} finding${warn === 1 ? "" : "s"} to review before trusting this set of servers; nothing is a credential in cleartext.`;
  if (!report.summary.servers) return "No MCP server is declared for this repository. install_local_mcp_clients (or the client's own settings) registers one; a project with none is not a finding.";
  return `${report.summary.servers} server${report.summary.servers === 1 ? "" : "s"} declared, nothing to act on.`;
}

/**
 * @param {{ resolveProjectIdentity: Function }} host
 */
export function createMcpInventoryTools(host) {
  return {
    definitions: [
      {
        name: "list_mcp_servers",
        description: "Inventory the MCP servers a repository wires into its agents: .mcp.json, .claude/settings.json (and settings.local.json), .cursor/mcp.json, .vscode/mcp.json, .gemini/settings.json and .codex/config.toml. Reports each server once with the files that declare it, its transport, the environment variables it substitutes and whether they are set, and whether Claude Code starts it without asking. Findings: a credential written out in a config file blocks; a plain-HTTP endpoint, an unpinned npx package, a shell-wrapped command, an entry no client can start, a config that cannot be read, or the same name defined differently in two files warn.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_user_scope: {
              type: "boolean",
              default: false,
              description: "Also read the current user's own config files (~/.claude.json including its per-project block, ~/.cursor/mcp.json, ~/.gemini/settings.json, ~/.codex/config.toml). They apply to this project too, but they are outside the repository and belong to the person running the server."
            }
          },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      async list_mcp_servers(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const report = await listMcpServers({
          projectRoot: identity.project_root,
          includeUserScope: Boolean(args.include_user_scope)
        });
        return { ...report, project_path: identity.project_root, next_step: nextStep(report) };
      }
    },
    readOnly: ["list_mcp_servers"]
  };
}
