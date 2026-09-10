/**
 * Usage ledger tools: clients report model usage per turn/task, and
 * `usage_report` aggregates it together with the automatically recorded MCP
 * tool-call telemetry.
 *
 * @param {{ usageLedger: import("../core/usage-ledger.mjs").UsageLedger, resolveProjectIdentity: Function, taskStore: { read: Function } }} host
 */
export function createUsageTools(host) {
  async function scope({ project_path = "", task_id = "" }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      return { taskId: task_id, projectPath: record.project.path };
    }
    if (project_path) {
      return { taskId: "", projectPath: (await host.resolveProjectIdentity(project_path)).project_root };
    }
    return { taskId: "", projectPath: "" };
  }

  return {
    definitions: [
      {
        name: "record_usage",
        description: "Record model usage reported by the client for a turn, task, or session (tokens, cache, cost, duration). The MCP server never sees tokens itself; a session runner or the agent posts them here so cost per task becomes visible.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            project_path: { type: "string" },
            session_id: { type: "string" },
            model: { type: "string" },
            input_tokens: { type: "number" },
            output_tokens: { type: "number" },
            cache_read_tokens: { type: "number" },
            cache_creation_tokens: { type: "number" },
            cost_usd: { type: "number" },
            duration_ms: { type: "number" },
            turns: { type: "number" },
            source: { type: "string", description: "Who reported it: client, session-runner, manual.", default: "client" },
            note: { type: "string" }
          }
        }
      },
      {
        name: "usage_report",
        description: "Aggregate recorded tool calls and model usage: per-tool call counts, failure rates and latency, per-task tokens and cost, and per-model totals. Filter by project, task, or start time.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            since: { type: "string", description: "ISO timestamp lower bound, for example 2026-09-01T00:00:00Z." },
            limit_tools: { type: "number", default: 15 }
          }
        }
      }
    ],
    handlers: {
      async record_usage(args) {
        const scoped = await scope(args);
        const event = await host.usageLedger.recordUsage({
          model: args.model,
          inputTokens: args.input_tokens,
          outputTokens: args.output_tokens,
          cacheReadTokens: args.cache_read_tokens,
          cacheCreationTokens: args.cache_creation_tokens,
          costUsd: args.cost_usd,
          durationMs: args.duration_ms,
          turns: args.turns,
          taskId: scoped.taskId,
          projectPath: scoped.projectPath,
          sessionId: args.session_id,
          source: args.source,
          note: args.note
        });
        return { action: "usage_recorded", event, ledger_path: host.usageLedger.filePath };
      },
      async usage_report(args) {
        const scoped = await scope(args);
        return host.usageLedger.report({
          projectPath: scoped.projectPath,
          taskId: scoped.taskId,
          since: args.since,
          limitTools: args.limit_tools
        });
      }
    },
    readOnly: ["usage_report"]
  };
}
