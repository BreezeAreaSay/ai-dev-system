import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionStore,
  estimateContextBudget,
  normalizeSessionRecord,
  renderHandoffMarkdown,
  renderResumeBriefing,
  sessionSubstanceScore,
  writeHandoffProjection
} from "./session-memory.mjs";

test("session records normalize, score substance, and render handoff + briefing", () => {
  assert.throws(() => normalizeSessionRecord({}), /topic or building is required/);
  const record = normalizeSessionRecord({
    building: "JWT auth with httpOnly cookies for the Next.js app.",
    worked: [{ item: "register endpoint", evidence: "POST returns 200 in Postman" }, "password hashing"],
    failed: [{ approach: "Next-Auth", reason: "conflicts with the Prisma adapter" }],
    untried: ["set cookie in login route"],
    files: [{ path: "app/api/login/route.ts", status: "In Progress", notes: "token not set yet" }, "lib/auth.ts", { path: "x.ts", status: "weird" }],
    decisions: [{ decision: "httpOnly cookie over localStorage", reason: "prevents XSS" }],
    blockers: ["does cookies().set() work in route handlers?"],
    next_step: "Set the cookie in login route and test with Postman."
  });
  assert.equal(record.topic, "JWT auth with httpOnly cookies for the Next.js app.");
  assert.equal(record.worked[1].item, "password hashing");
  assert.equal(record.files[0].status, "in_progress");
  assert.equal(record.files[1].status, "in_progress");
  assert.equal(record.files[2].status, "in_progress");
  assert.ok(sessionSubstanceScore(record) >= 8);
  assert.equal(sessionSubstanceScore({ topic: "x", next_step: "[next step goes here]" }), 0);

  const markdown = renderHandoffMarkdown({ ...record, saved_at: "2026-09-10T12:00:00.000Z", project_name: "my-app", branch: "main" });
  assert.match(markdown, /## What Did NOT Work \(and why\)\n\n- \*\*Next-Auth\*\* — failed because: conflicts/);
  assert.match(markdown, /\| `app\/api\/login\/route\.ts` \| In Progress \|/);
  assert.match(markdown, /## Exact Next Step\n\nSet the cookie/);

  const briefing = renderResumeBriefing({
    record: { ...record, id: "session-1", saved_at: "2026-01-01T00:00:00.000Z", project_name: "my-app" },
    tasks: [{ id: "task-1", status: "active", task: "Finish auth", plan_policy: { plan_required: true }, plan: null }],
    git: { branch: "main", dirty: true, dirty_files: ["a"] },
    freshness: { compiled: true, fresh: false },
    now: "2026-02-01T00:00:00.000Z"
  });
  assert.match(briefing, /HISTORICAL REFERENCE ONLY/);
  assert.match(briefing, /WARNING: 31 days ago/);
  assert.match(briefing, /WHAT NOT TO RETRY:\n- Next-Auth — conflicts/);
  assert.match(briefing, /task-1 \[active\] Finish auth \(plan required, not recorded\)/);
  assert.match(briefing, /GIT: branch main, 1 uncommitted file/);
  assert.match(briefing, /CONTEXT PACK: stale/);
  assert.match(renderResumeBriefing({ record: null }), /NO SAVED SESSION/);
});

test("session store saves, lists newest-first with substance filter, and writes the projection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ stateRoot: path.join(root, "state") });
  const placeholder = await store.save({ projectId: "project-a", projectPath: root, topic: "empty", now: "2026-01-01T00:00:00.000Z" });
  const real = await store.save({
    projectId: "project-a",
    projectPath: root,
    projectName: "fixture",
    taskId: "task-1",
    branch: "feature/x",
    building: "Real work on the login flow with several moving parts.",
    worked: [{ item: "login endpoint", evidence: "tests pass" }],
    next_step: "Wire the cookie into the middleware and run verify_task.",
    now: "2026-01-02T00:00:00.000Z"
  });
  assert.match(real.path, /20260102000000-real-work-on-the-login-flow/);
  const all = await store.list("project-a");
  assert.deepEqual(all.map((item) => item.id), [real.record.id, placeholder.record.id]);
  const latest = await store.latest("project-a");
  assert.equal(latest.id, real.record.id);
  assert.equal(latest.task_id, "task-1");
  assert.equal(await store.latest("project-b"), null);
  assert.equal((await store.read("project-a", placeholder.record.id)).topic, "empty");
  await assert.rejects(store.read("project-a", "nope"), /Unknown session/);

  const projection = await writeHandoffProjection(root, real.record);
  assert.equal(projection, ".ai-dev/context/handoff.md");
  assert.match(await fs.readFile(path.join(root, ".ai-dev", "context", "handoff.md"), "utf8"), /Wire the cookie/);
});

test("estimateContextBudget reports static overhead and boundary compaction hints", () => {
  const healthy = estimateContextBudget({ contextPackChars: 20_000, skillChars: 12_000, rulesChars: 8_000, agentsChars: 4_000 });
  assert.equal(healthy.static_tokens, 11_000);
  assert.equal(healthy.compaction_hint, "none");
  assert.match(healthy.advice[0], /healthy/);
  const heavy = estimateContextBudget({ contextPackChars: 120_000, skillChars: 100_000, checkpoints: 6, verifications: 3, windowTokens: 200_000 });
  assert.equal(heavy.compaction_hint, "boundary");
  assert.ok(heavy.advice.some((item) => /Static overhead is/.test(item)));
  assert.ok(heavy.advice.some((item) => /Five or more checkpoints/.test(item)));
  assert.ok(heavy.advice.some((item) => /verification rounds/.test(item)));
});
