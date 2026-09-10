import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger, usageHintsFromArgs } from "./usage-ledger.mjs";

test("usage ledger records tool calls and usage, then aggregates a report", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const project = path.join(stateRoot, "project");

  await ledger.recordToolCall({ tool: "begin_task", ok: true, durationMs: 120, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "verify_task", ok: false, durationMs: 900, taskId: "task-1", projectPath: project, error: "quality gate failed" });
  await ledger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 300, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "search_knowledge", ok: true, durationMs: 10 });
  await ledger.recordUsage({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 200, costUsd: 0.05, taskId: "task-1", projectPath: project, turns: 3 });
  await ledger.recordUsage({ model: "claude-sonnet-5", inputTokens: 500, outputTokens: 50, costUsd: 0.01, taskId: "task-2", projectPath: project });
  await assert.rejects(ledger.recordUsage({ model: "x" }), /needs input_tokens/);

  const all = await ledger.report();
  assert.equal(all.events, 6);
  assert.equal(all.tool_calls, 4);
  assert.equal(all.tools[0].tool, "verify_task");
  assert.equal(all.tools[0].failures, 1);
  assert.equal(all.tools[0].failure_rate, 0.5);
  assert.equal(all.tools[0].average_ms, 600);
  assert.equal(all.slowest_tools[0].tool, "verify_task");
  assert.equal(all.usage.input_tokens, 1500);
  assert.equal(all.usage.cost_usd, 0.06);
  assert.equal(all.models.length, 2);

  const task = await ledger.report({ taskId: "task-1" });
  assert.equal(task.events, 4);
  assert.equal(task.tasks[0].tool_calls, 3);
  assert.equal(task.tasks[0].cost_usd, 0.05);

  const scoped = await ledger.report({ projectPath: project });
  assert.equal(scoped.events, 5, "events without a project path are excluded from a project report");

  const future = await ledger.report({ since: "2999-01-01T00:00:00.000Z" });
  assert.equal(future.events, 0);
  assert.deepEqual(usageHintsFromArgs({ task_id: "t", project_path: "/p", other: 1 }), { taskId: "t", projectPath: "/p" });
  assert.deepEqual(usageHintsFromArgs({ task_id: 5 }), { taskId: "", projectPath: "" });
});

test("usage ledger prunes to the newest lines when the file grows past the cap", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-prune-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot, maxBytes: 600, keepLines: 5 });
  for (let index = 0; index < 12; index += 1) {
    await ledger.recordToolCall({ tool: `tool_${index}`, ok: true, durationMs: index });
  }
  const events = await ledger.readEvents();
  assert.ok(events.length <= 6 && events.length >= 1, `unexpected ${events.length} events after prune`);
  assert.equal(events.at(-1).tool, "tool_11");
  await fs.writeFile(ledger.filePath, "not json\n{\"kind\":\"tool_call\",\"tool\":\"kept\",\"ok\":true,\"at\":\"2026-01-01T00:00:00.000Z\"}\n");
  const report = await ledger.report();
  assert.equal(report.events, 1);
});
