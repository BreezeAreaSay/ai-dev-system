/**
 * `ai-dev servers` — the MCP servers the AI clients start for a repository:
 * what each runs, which client config names it, and what to look at before
 * trusting it (`list_mcp_servers`). Read-only.
 *
 * Exit codes: 0 done, 1 failed, 2 a usage mistake.
 */
import path from "node:path";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { tildify } from "./context.mjs";
import { cut, lineWidth, withTools } from "./tools.mjs";

export function usage() {
  return [
    "Usage: ai-dev servers [--project <path>] [--mine] [--json]",
    "",
    "The MCP servers AI clients start for a repository — Claude Code, Cursor, VS Code, Gemini, Codex —",
    "from the configs in it: what each runs, which config names it, and what to check before",
    "trusting it (an unpinned package, a credential in cleartext). Nothing is changed.",
    "",
    "  --project <path>   the repository; the current folder when left out",
    "  --mine             also your own configs in your home folder, which apply to every repository",
    "  --json             print the result as JSON"
  ].join("\n");
}

/** What a server runs, in one phrase. */
function runs(server) {
  if (server.url) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values } = parseCommandLine(argv, {
    command: "servers",
    options: { json: { type: "boolean" }, project: { type: "string" }, mine: { type: "boolean" } }
  });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  const project = path.resolve(values.project ?? process.cwd());
  return withTools(async ({ call }) => {
    const listed = await call("list_mcp_servers", { project_path: project, include_user_scope: Boolean(values.mine) });
    if (values.json) {
      io.out(JSON.stringify(listed, null, 2));
      return EXIT.ok;
    }
    const width = lineWidth(io);
    io.out(`MCP servers · ${tildify(project)}${values.mine ? " and your own configs" : ""}`);
    if (!listed.servers.length) io.out(`  None in ${values.mine ? "these configs" : "this repository's configs: --mine adds your own"}.`);
    const column = Math.min(24, Math.max(0, ...listed.servers.map((server) => server.name.length))) + 4;
    for (const server of listed.servers) {
      const where = [...new Set(server.origins.map((origin) => origin.client))].join(", ");
      io.out(`${`  ${server.name}`.padEnd(column)}${cut(runs(server), Math.max(20, width - column - where.length - 3))}  (${where})`);
    }
    for (const finding of listed.findings ?? []) io.out(`  ${finding.severity} · ${finding.server}: ${cut(finding.message, width * 2)}`);
    const unreadable = listed.sources.filter((source) => source.exists && !source.readable);
    for (const source of unreadable) io.out(`  ${source.path} could not be read: ${source.error}`);
    // The tool speaks to an agent; at a terminal its tool is a command (Д-599, п. 3).
    if (listed.next_step) io.out(String(listed.next_step).replaceAll("install_local_mcp_clients", "`ai-dev clients install`"));
    return EXIT.ok;
  });
}
