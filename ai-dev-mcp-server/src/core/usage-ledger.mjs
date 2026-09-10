import fs from "node:fs/promises";
import path from "node:path";
import { atomicAppendFile, atomicWriteFile } from "./atomic-files.mjs";

export const USAGE_EVENT_KINDS = ["tool_call", "usage"];

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rounded = (value, digits = 6) => Number(number(value).toFixed(digits));

/** Append-only, bounded JSONL telemetry for tool calls and client-reported usage. */
export class UsageLedger {
  constructor({ stateRoot, maxBytes = 8 * 1024 * 1024, keepLines = 20_000 }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "usage", "events.jsonl");
    this.maxBytes = maxBytes;
    this.keepLines = Math.max(1, number(keepLines, 20_000));
    this.queue = Promise.resolve();
  }
  async append(event) {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      await atomicAppendFile(this.filePath, `${JSON.stringify(event)}\n`);
      const stat = await fs.stat(this.filePath).catch(() => null);
      if (stat?.size > this.maxBytes) {
        const lines = (await fs.readFile(this.filePath, "utf8")).split("\n").filter(Boolean).slice(-this.keepLines);
        await atomicWriteFile(this.filePath, `${lines.join("\n")}\n`);
      }
    });
    await this.queue;
    return event;
  }
  recordToolCall({ tool, ok, durationMs, taskId = "", projectPath = "", error = "", client = "" }) {
    return this.append({ at: new Date().toISOString(), kind: "tool_call", tool: String(tool || ""), ok: Boolean(ok), duration_ms: Math.max(0, Math.round(number(durationMs))), task_id: String(taskId || ""), project_path: String(projectPath || ""), error: String(error || "").slice(0, 300), client: String(client || "") });
  }
  recordUsage(input = {}) {
    const inputTokens = Number(input.inputTokens); const outputTokens = Number(input.outputTokens); const costUsd = Number(input.costUsd);
    if (![inputTokens, outputTokens, costUsd].some(Number.isFinite)) throw new Error("record_usage needs input_tokens, output_tokens, or cost_usd.");
    return this.append({ at: new Date().toISOString(), kind: "usage", model: String(input.model || "unknown"), input_tokens: number(inputTokens), output_tokens: number(outputTokens), cache_read_tokens: number(input.cacheReadTokens), cache_creation_tokens: number(input.cacheCreationTokens), cost_usd: number(costUsd), duration_ms: Math.max(0, Math.round(number(input.durationMs))), turns: Math.max(0, Math.round(number(input.turns))), task_id: String(input.taskId || ""), project_path: String(input.projectPath || ""), session_id: String(input.sessionId || ""), source: String(input.source || "client"), note: String(input.note || "").slice(0, 300) });
  }
  async readEvents() { const text = await fs.readFile(this.filePath, "utf8").catch(e => e?.code === "ENOENT" ? "" : Promise.reject(e)); return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  async report({ projectPath = "", taskId = "", since = "", limitTools = 15 } = {}) {
    const events = (await this.readEvents()).filter(e => (!taskId || e.task_id === taskId) && (!projectPath || (e.project_path && path.resolve(e.project_path) === path.resolve(projectPath))) && (!since || String(e.at) >= since));
    const tools = new Map(), tasks = new Map(), models = new Map();
    const usage = { events: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, duration_ms: 0, turns: 0 };
    const task = id => tasks.get(id) ?? (tasks.set(id, { task_id:id, tool_calls:0, tool_failures:0, input_tokens:0, output_tokens:0, cost_usd:0 }), tasks.get(id));
    for (const e of events) if (e.kind === "tool_call") { const x=tools.get(e.tool) ?? { tool:e.tool,calls:0,failures:0,total_ms:0,max_ms:0 }; x.calls++; x.failures+=!e.ok; x.total_ms+=number(e.duration_ms); x.max_ms=Math.max(x.max_ms,number(e.duration_ms)); tools.set(e.tool,x); if(e.task_id){const t=task(e.task_id);t.tool_calls++;t.tool_failures+=!e.ok;} } else if(e.kind === "usage") { usage.events++; for(const k of ["input_tokens","output_tokens","cache_read_tokens","cache_creation_tokens","cost_usd","duration_ms","turns"]) usage[k]+=number(e[k]); const m=models.get(e.model) ?? {model:e.model,events:0,input_tokens:0,output_tokens:0,cost_usd:0}; m.events++;m.input_tokens+=number(e.input_tokens);m.output_tokens+=number(e.output_tokens);m.cost_usd+=number(e.cost_usd);models.set(e.model,m); if(e.task_id){const t=task(e.task_id);t.input_tokens+=number(e.input_tokens);t.output_tokens+=number(e.output_tokens);t.cost_usd+=number(e.cost_usd);} }
    const rows=[...tools.values()].map(x=>({...x,average_ms:x.calls?Math.round(x.total_ms/x.calls):0,failure_rate:x.calls?rounded(x.failures/x.calls,4):0})).sort((a,b)=>b.calls-a.calls||a.tool.localeCompare(b.tool));
    return { ledger_path:this.filePath, events:events.length, filter:{project_path:projectPath||null,task_id:taskId||null,since:since||null}, tool_calls:events.filter(e=>e.kind==="tool_call").length, tools:rows.slice(0,Math.max(1,Math.min(number(limitTools,15),200))), slowest_tools:[...tools.values()].sort((a,b)=>b.max_ms-a.max_ms).slice(0,5).map(({tool,max_ms})=>({tool,max_ms})), usage:{...usage,cost_usd:rounded(usage.cost_usd,4)}, models:[...models.values()].map(x=>({...x,cost_usd:rounded(x.cost_usd,4)})), tasks:[...tasks.values()].map(x=>({...x,cost_usd:rounded(x.cost_usd,4)})).sort((a,b)=>b.cost_usd-a.cost_usd||b.tool_calls-a.tool_calls).slice(0,50) };
  }
}
export const usageHintsFromArgs = (args = {}) => ({ taskId: typeof args?.task_id === "string" ? args.task_id : "", projectPath: typeof args?.project_path === "string" ? args.project_path : "" });
