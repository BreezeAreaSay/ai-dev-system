import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordDecision, listDecisions } from "./decision-ledger.mjs";
import { SessionStore, renderResumeBriefing } from "./session-memory.mjs";
import { InstinctStore } from "./instincts.mjs";
import { loadContextExtras } from "./context-extras.mjs";

test("decision, handoff, and instinct state are durable and become bounded context extras", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await recordDecision(root, { title: "Keep local state", context: "One machine", decision: "Use a JSON-backed local store.", tags: ["state"] });
  assert.equal((await listDecisions(root, { tag: "state" }))[0].id, "ADR-0001");
  const stateRoot = path.join(root, "state");
  const sessions = new SessionStore({ stateRoot });
  const saved = await sessions.save({ projectId: "fixture", projectPath: root, building: "Durable task handoffs with a verified next step.", failed: [{ approach: "Unstructured chat recall", reason: "lost context" }], next_step: "Run the focused tests." });
  assert.match(renderResumeBriefing({ record: saved.record }), /HISTORICAL REFERENCE ONLY/);
  const instincts = new InstinctStore({ stateRoot });
  const instinct = await instincts.record({ projectId: "fixture", trigger: "when retrying jobs", action: "use idempotency keys", domain: "architecture", confidence: .8 });
  assert.equal((await instincts.rankForContext({ projectId: "fixture", task: "Fix retrying jobs" })).instincts[0].id, instinct.instinct.id);
  const extras = await loadContextExtras({ projectRoot: root, stateRoot, projectId: "fixture", task: "Fix retrying jobs" });
  assert.deepEqual(extras.sections.map((section) => section.id), ["decisions", "handoff", "instincts"]);
});
