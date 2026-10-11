import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chooseSearchEngine, createSearchIndexRuntime } from "./search-index.mjs";
import { sqliteSupport } from "./search-sqlite.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

const PASSTHROUGH_RANKING = {
  repairSearchMojibake: (value) => value,
  prioritizeKnowledgeResults: (_query, results) => results,
  rerankSearchResults: (_query, results) => results,
  isSkillCatalogQuery: () => false,
  routeSkills: () => ({ skills: [] })
};

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A runtime over a real vault and index whose Python helper must never be needed unless a test says so. */
function createFixture(t, { describe = null, embed = null, helper = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  write(vaultRoot, "02-knowledge/deploy.md", "# Deploy runbook\n\nHow to deploy to production and roll back a database migration.");
  write(vaultRoot, "02-knowledge/review.md", "# Code review checklist\n\nWhat a reviewer checks before approving.");
  write(vaultRoot, "07-quality-gates/gate.md", "# Release gate\n\nTests, lint and typecheck before a release.");
  write(vaultRoot, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
    { name: "code-reviewer", source: "custom", categories: ["code-review"], description: "Reviews code for defects.", path: "sources/custom/code-reviewer/SKILL.md" },
    { name: "deploy-helper", source: "external/tools", categories: ["devops"], description: "Deploys services.", path: "sources/external/deploy-helper/SKILL.md" }
  ]));
  const calls = [];
  const searchIndexDir = path.join(root, "cache");
  const runtime = createSearchIndexRuntime({
    vaultRoot,
    searchCliPath: "/no/search_cli.py",
    searchIndexDir,
    searchIndexPath: path.join(searchIndexDir, "ai-dev-search.sqlite"),
    defaultModelDir: path.join(root, "models", "bge-m3"),
    pythonCommand: () => "python",
    embeddingPythonCommand: () => "embedding-python",
    pathExists: async () => true,
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (!helper) throw new Error(`the Python helper was called: ${args[1]}`);
      return { stdout: JSON.stringify(helper(args)), stderr: "" };
    },
    embedQuery: async (payload) => {
      calls.push({ command: "embedQuery", payload });
      return embed ? embed(payload) : { embeddings: [] };
    },
    denseIndexBackend: describe ? { describe } : undefined,
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    ranking: PASSTHROUGH_RANKING,
    env: {}
  });
  return { runtime, calls, vaultRoot, indexPath: path.join(searchIndexDir, "ai-dev-search.sqlite") };
}

test("the engine is Node's where node:sqlite has FTS5, the helper otherwise or when asked", () => {
  const yes = () => ({ available: true, reason: "" });
  const no = () => ({ available: false, reason: "no FTS5 here" });
  assert.deepEqual(chooseSearchEngine({ env: {}, support: yes }), { engine: "node", reason: "" });
  assert.deepEqual(chooseSearchEngine({ env: {}, support: no }), { engine: "python", reason: "no FTS5 here" });
  assert.deepEqual(chooseSearchEngine({ env: { AI_DEV_SEARCH_ENGINE: "Python " }, support: yes }), { engine: "python", reason: "AI_DEV_SEARCH_ENGINE=python" });
  assert.deepEqual(chooseSearchEngine({ env: { AI_DEV_SEARCH_ENGINE: "node" }, support: no }).engine, "python", "it cannot be forced onto a Node without FTS5");
});

test("status, the first search and its rebuild run without Python", needsSqlite, async (t) => {
  const { runtime, calls } = createFixture(t);
  const before = await runtime.status();
  assert.deepEqual([before.engine, before.index_exists, before.reasons], ["node", false, ["index_missing"]]);
  const results = await runtime.search({ query: "deploy production" });
  assert.equal(results[0].title, "Deploy runbook");
  assert.match(results[0].preview, /\[deploy\]/i);
  const after = await runtime.status();
  assert.deepEqual([after.stale, after.current_document_count, after.dirty_reason], [false, 5, ""]);
  assert.deepEqual(calls, []);
  assert.equal(runtime.engine().engine, "node");
});

test("a change marked dirty is picked up by rewriting just that document", needsSqlite, async (t) => {
  const { runtime, vaultRoot } = createFixture(t);
  await runtime.rebuild();
  write(vaultRoot, "02-knowledge/rollback.md", "# Rollback drill\n\nPractise the rollback.");
  runtime.markDirty("note written");
  const refreshed = await runtime.ensureFresh();
  assert.equal(refreshed.action, "rebuilt");
  assert.deepEqual([refreshed.rebuild.write_mode, refreshed.rebuild.rewritten_documents, refreshed.rebuild.engine], ["in_place", 1, "node"]);
  assert.equal((await runtime.search({ query: "rollback drill" }))[0].title, "Rollback drill");
  assert.equal((await runtime.ensureFresh()).action, "current");
});

test("search filters by scope, source and folder as the helper did", needsSqlite, async (t) => {
  const { runtime } = createFixture(t);
  await runtime.rebuild();
  const skills = await runtime.search({ query: "code review", scope: "skills" });
  assert.deepEqual(skills.map((item) => item.title), ["code-reviewer"]);
  const external = await runtime.search({ query: "deploy", source: ["external"] });
  assert.deepEqual(external.map((item) => item.title), ["deploy-helper"]);
  const quality = await runtime.search({ query: "release", scope: "quality" });
  assert.deepEqual(quality.map((item) => item.path), ["07-quality-gates/gate.md"]);
  const inFolder = await runtime.search({ query: "deploy", folders: "02-knowledge/" });
  assert.deepEqual(inFolder.map((item) => item.path), ["02-knowledge/deploy.md"]);
  assert.deepEqual(await runtime.search({ query: "  ", ensure_fresh: false }), []);
  await assert.rejects(() => runtime.search({ query: "" }), /query is required/);
});

test("a question with AND, OR or NOT in capitals still finds its documents (\u0414-117)", needsSqlite, async (t) => {
  const { runtime } = createFixture(t);
  await runtime.rebuild();
  assert.deepEqual((await runtime.search({ query: "deploy AND production" })).map((item) => item.title), ["Deploy runbook"]);
  assert.ok((await runtime.search({ query: "code review NOT approving" })).every((item) => item.score < 0));
});

test("searching an index that is not there says so", needsSqlite, async (t) => {
  const { runtime } = createFixture(t);
  await assert.rejects(() => runtime.search({ query: "deploy", ensure_fresh: false }), /Search index does not exist/);
});

test("ONNX vectors are planned, embedded and stored in one rebuild, without Python", needsSqlite, async (t) => {
  const provenance = { backend: "onnx", revision: "rev1", dtype: "int8", dimensions: 1024 };
  const { runtime, calls } = createFixture(t, {
    describe: async () => ({ backend: "onnx", available: true, provenance }),
    embed: ({ texts }) => ({ embeddings: texts.map((_, index) => Array.from({ length: 1024 }, (__, position) => ((index + position) % 7) / 7)) })
  });
  const rebuilt = await runtime.rebuild({ dense_embeddings: true });
  assert.deepEqual(
    [rebuilt.engine, rebuilt.dense_enabled, rebuilt.dense_backend, rebuilt.dense_planned_documents, rebuilt.dense_embedded_documents, rebuilt.dense_documents],
    ["node", true, "onnx", 5, 5, 5]
  );
  assert.ok(calls.every((call) => call.command === "embedQuery"));
  const again = await runtime.rebuild({ dense_embeddings: true });
  assert.deepEqual([again.dense_planned_documents, again.dense_reused_documents], [0, 5], "a second run reuses every vector");
  const refreshed = await runtime.rebuild();
  assert.deepEqual([refreshed.dense_preserved, refreshed.dense_documents], [true, 5]);
  assert.equal((await runtime.status()).dense_documents, 5);
});

test("the legacy Python dense backend and hybrid search still go to the helper", needsSqlite, async (t) => {
  const { runtime, calls } = createFixture(t, {
    describe: async () => ({ backend: "python", available: true, provenance: { backend: "python", revision: "unpinned", dtype: "fp32", dimensions: 1024 } }),
    helper: (args) => (args[1] === "hybrid" ? [{ title: "Deploy runbook", path: "02-knowledge/deploy.md", scope: "knowledge", score: 1 }] : { document_count: 5 })
  });
  await runtime.rebuild();
  const legacy = await runtime.rebuild({ dense_embeddings: true });
  assert.equal(legacy.engine, "node", "the engine is the process's; the helper only embedded and wrote");
  const rebuildCall = calls.find((call) => call.args?.[1] === "rebuild");
  assert.equal(rebuildCall.command, "embedding-python");
  assert.ok(rebuildCall.args.includes("--dense-embeddings"));
  const hybrid = await runtime.hybridSearch({ query: "deploy", dense_weight: 0 });
  assert.equal(hybrid[0].title, "Deploy runbook");
  assert.ok(calls.some((call) => call.args?.[1] === "hybrid"));
});
