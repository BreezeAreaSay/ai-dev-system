import fs from "node:fs/promises";
import path from "node:path";
import { atomicAppendFile, atomicWriteFile } from "./atomic-files.mjs";

export const USAGE_EVENT_KINDS = ["tool_call", "usage"];
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const KEEP_LINES_AFTER_PRUNE = 20_000;

function now() {
  return new Date().toISOString();
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

/**
 * Append-only JSONL ledger of MCP tool calls and client-reported model usage
 * (`~/.ai-dev/state/usage/events.jsonl`). The MCP server cannot see model
 * tokens itself; the client (or an orchestrator such as a session runner) posts
 * them through `record_usage`, while tool calls are recorded by the tool
 * dispatcher (`callTool` in `mcp-stdio.mjs`) whichever caller invoked it: the
 * MCP transport, the CLI, a smoke script, or a tool composed from other tools.
 */
export class UsageLedger {
  constructor({ stateRoot, maxBytes = MAX_LEDGER_BYTES, keepLines = KEEP_LINES_AFTER_PRUNE }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "usage", "events.jsonl");
    this.maxBytes = maxBytes;
    this.keepLines = Math.max(1, Number(keepLines) || KEEP_LINES_AFTER_PRUNE);
    this.queue = Promise.resolve();
  }

  async append(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await atomicAppendFile(this.filePath, line, "utf8");
        await this.pruneIfNeeded();
      });
    await this.queue;
    return event;
  }

  /**
   * Wait for every queued append to reach disk. Callers that record a tool call
   * without awaiting it (the tool dispatcher) use this to settle the ledger
   * before reading it back.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this.queue.catch(() => undefined);
  }

  async pruneIfNeeded() {
    const stats = await fs.stat(this.filePath).catch(() => null);
    if (!stats || stats.size <= this.maxBytes) return false;
    const lines = (await fs.readFile(this.filePath, "utf8")).split("\n").filter(Boolean);
    const kept = lines.slice(-this.keepLines);
    await atomicWriteFile(this.filePath, `${kept.join("\n")}\n`, "utf8");
    return true;
  }

  /**
   * Record one MCP tool invocation (name, duration, outcome, task/project hints).
   *
   * @param {{ tool: string, ok: boolean, durationMs: number, taskId?: string, projectPath?: string, error?: string, client?: string }} input
   */
  async recordToolCall({ tool, ok, durationMs, taskId = "", projectPath = "", error = "", client = "" }) {
    return this.append({
      at: now(),
      kind: "tool_call",
      tool: String(tool || ""),
      ok: Boolean(ok),
      duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      task_id: String(taskId || ""),
      project_path: String(projectPath || ""),
      error: String(error || "").slice(0, 300),
      client: String(client || "")
    });
  }

  /**
   * Record model usage reported by the client for a turn, task, or session.
   *
   * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number, costUsd?: number, durationMs?: number, turns?: number, taskId?: string, projectPath?: string, sessionId?: string, source?: string, note?: string }} input
   */
  async recordUsage(input = {}) {
    const inputTokens = finiteOrNull(input.inputTokens);
    const outputTokens = finiteOrNull(input.outputTokens);
    if (inputTokens === null && outputTokens === null && finiteOrNull(input.costUsd) === null) {
      throw new Error("record_usage needs input_tokens, output_tokens, or cost_usd.");
    }
    return this.append({
      at: now(),
      kind: "usage",
      model: String(input.model || "unknown"),
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
      cache_read_tokens: finiteOrNull(input.cacheReadTokens) ?? 0,
      cache_creation_tokens: finiteOrNull(input.cacheCreationTokens) ?? 0,
      cost_usd: finiteOrNull(input.costUsd) ?? 0,
      duration_ms: Math.max(0, Math.round(finiteOrNull(input.durationMs) ?? 0)),
      turns: Math.max(0, Math.round(finiteOrNull(input.turns) ?? 0)),
      task_id: String(input.taskId || ""),
      project_path: String(input.projectPath || ""),
      session_id: String(input.sessionId || ""),
      source: String(input.source || "client"),
      note: String(input.note || "").slice(0, 300)
    });
  }

  async readEvents() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return text.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Aggregate the ledger: per-tool call counts, failures, and latency; per-task
   * token and cost totals; and overall model usage, optionally filtered by
   * project path, task id, or a start timestamp.
   *
   * @param {{ projectPath?: string, taskId?: string, since?: string, limitTools?: number }} [filter]
   * @returns {Promise<object>} Report.
   */
  async report({ projectPath = "", taskId = "", since = "", limitTools = 15 } = {}) {
    const events = (await this.readEvents()).filter((event) => {
      if (taskId && event.task_id !== taskId) return false;
      if (projectPath && event.project_path && path.resolve(event.project_path) !== path.resolve(projectPath)) return false;
      if (projectPath && !event.project_path && !taskId) return false;
      if (since && String(event.at || "") < since) return false;
      return true;
    });
    const tools = new Map();
    const tasks = new Map();
    const usage = { events: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, duration_ms: 0, turns: 0 };
    const models = new Map();
    for (const event of events) {
      if (event.kind === "tool_call") {
        const entry = tools.get(event.tool) ?? { tool: event.tool, calls: 0, failures: 0, total_ms: 0, max_ms: 0 };
        entry.calls += 1;
        if (!event.ok) entry.failures += 1;
        entry.total_ms += Number(event.duration_ms) || 0;
        entry.max_ms = Math.max(entry.max_ms, Number(event.duration_ms) || 0);
        tools.set(event.tool, entry);
        if (event.task_id) {
          const task = tasks.get(event.task_id) ?? { task_id: event.task_id, tool_calls: 0, tool_failures: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
          task.tool_calls += 1;
          if (!event.ok) task.tool_failures += 1;
          tasks.set(event.task_id, task);
        }
      } else if (event.kind === "usage") {
        usage.events += 1;
        for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "duration_ms", "turns"]) {
          usage[key] += Number(event[key]) || 0;
        }
        const model = models.get(event.model) ?? { model: event.model, events: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        model.events += 1;
        model.input_tokens += Number(event.input_tokens) || 0;
        model.output_tokens += Number(event.output_tokens) || 0;
        model.cost_usd += Number(event.cost_usd) || 0;
        models.set(event.model, model);
        if (event.task_id) {
          const task = tasks.get(event.task_id) ?? { task_id: event.task_id, tool_calls: 0, tool_failures: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
          task.input_tokens += Number(event.input_tokens) || 0;
          task.output_tokens += Number(event.output_tokens) || 0;
          task.cost_usd += Number(event.cost_usd) || 0;
          tasks.set(event.task_id, task);
        }
      }
    }
    const toolRows = [...tools.values()]
      .map((item) => ({
        ...item,
        average_ms: item.calls ? Math.round(item.total_ms / item.calls) : 0,
        failure_rate: item.calls ? round(item.failures / item.calls, 4) : 0
      }))
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool))
      .slice(0, Math.max(1, Math.min(Number(limitTools) || 15, 200)));
    return {
      ledger_path: this.filePath,
      events: events.length,
      filter: { project_path: projectPath || null, task_id: taskId || null, since: since || null },
      tool_calls: events.filter((event) => event.kind === "tool_call").length,
      tools: toolRows,
      slowest_tools: [...tools.values()].sort((left, right) => right.max_ms - left.max_ms).slice(0, 5).map((item) => ({ tool: item.tool, max_ms: item.max_ms })),
      usage: { ...usage, cost_usd: round(usage.cost_usd, 4) },
      models: [...models.values()].map((item) => ({ ...item, cost_usd: round(item.cost_usd, 4) })),
      tasks: [...tasks.values()].map((item) => ({ ...item, cost_usd: round(item.cost_usd, 4) }))
        .sort((left, right) => right.cost_usd - left.cost_usd || right.tool_calls - left.tool_calls)
        .slice(0, 50)
    };
  }
}

/**
 * Pull the task id / project path hints out of tool arguments without storing
 * anything else from the call.
 *
 * @param {Record<string, unknown>} args
 * @returns {{ taskId: string, projectPath: string }}
 */
export function usageHintsFromArgs(args = {}) {
  return {
    taskId: typeof args?.task_id === "string" ? args.task_id : "",
    projectPath: typeof args?.project_path === "string" ? args.project_path : ""
  };
}
