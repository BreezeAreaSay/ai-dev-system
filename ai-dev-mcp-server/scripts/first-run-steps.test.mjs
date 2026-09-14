import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FIRST_RUN_STEPS, planFirstRun } from "../src/core/first-run.mjs";
import {
  REQUIRED_STEP_IDS,
  createRequiredActions,
  parseToolResult,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan,
  summarizeToolResult
} from "./first-run-steps.mjs";

function toolResult(document) {
  return { content: [{ type: "text", text: JSON.stringify(document) }] };
}

/** A vault with only the files a test names in it. */
async function makeVault(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "first-run-steps-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, "utf8");
  }
  return root;
}

test("the required steps are exactly the ones no install can do without", () => {
  // Д-57: the container built the registry alone, so a fresh volume had no
  // search index and no routing benchmark, and four critical checks failed on
  // a correct install. Both commands now run this list.
  const required = FIRST_RUN_STEPS.filter((step) => !step.optional).map((step) => step.id);
  assert.deepEqual([...REQUIRED_STEP_IDS], required);
  assert.deepEqual(Object.keys(createRequiredActions({ callTool: async () => ({}) })), required);
});

test("each required step calls the tool that builds it, with the arguments that keep it offline", async () => {
  const calls = [];
  const actions = createRequiredActions({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return toolResult({
        total: 3227,
        indexed_document_count: 3442,
        summary: { passed: 37, total: 37 }
      });
    }
  });
  assert.equal(await actions.skill_registry(), "3227 skill(s) indexed");
  assert.equal(await actions.search_index(), "3442 document(s) indexed");
  assert.equal(await actions.routing_benchmark(), "37/37 cases pass");
  assert.deepEqual(calls.map((call) => call.name), [
    "rebuild_index", "rebuild_search_index", "run_skill_routing_eval"
  ]);
  // A container has no weights and a clone that has them has already embedded
  // with them: the index rebuild must neither drop the vectors nor make any.
  assert.deepEqual(calls[1].args, {
    include_external_project_files: true,
    dense_embeddings: false,
    preserve_dense: true
  });
});

test("a tool that answers with something other than JSON still reports", async () => {
  assert.equal(parseToolResult({ content: [{ type: "text", text: "not json" }] }), null);
  assert.equal(parseToolResult(undefined), null);
  assert.equal(summarizeToolResult({ content: [] }, () => "unused"), "done");
  const actions = createRequiredActions({ callTool: async () => ({ content: [] }) });
  assert.equal(await actions.routing_benchmark(), "done");
  const partial = createRequiredActions({ callTool: async () => toolResult({ nothing: true }) });
  assert.equal(await partial.skill_registry(), "? skill(s) indexed");
  assert.equal(await partial.search_index(), "? document(s) indexed");
  assert.equal(await partial.routing_benchmark(), "benchmark written");
});

test("an empty vault needs all three steps and a built one needs none", async (t) => {
  const empty = await makeVault(t);
  const paths = requiredArtefactPaths({
    vaultRoot: empty,
    searchIndexPath: path.join(empty, "cache", "ai-dev-search.sqlite")
  });
  assert.equal(paths.skillRegistryPath, path.join(empty, "03-skills-catalog", "registries", "skills.index.json"));

  const fresh = await readRequiredState({
    paths,
    callTool: async () => { throw new Error("the index does not exist yet"); },
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(empty, "cases.json")
  });
  assert.equal(fresh.indexStatus, null, "no index means no status call");
  assert.deepEqual(fresh.present, { skill_registry: false, search_index: false, routing_benchmark: false });
  const planned = planFirstRun({ present: fresh.present, stale: fresh.stale });
  assert.deepEqual(planned.filter((step) => step.run).map((step) => step.id), [...REQUIRED_STEP_IDS]);

  const built = await makeVault(t, {
    "03-skills-catalog/registries/skills.index.json": "[]",
    "03-skills-catalog/registries/skill-routing-eval.json": "{}",
    "cache/ai-dev-search.sqlite": "",
    "cases.json": "[]"
  });
  // The benchmark was written after the cases it was built from.
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(built, "03-skills-catalog", "registries", "skill-routing-eval.json"), future, future);
  const builtPaths = requiredArtefactPaths({
    vaultRoot: built,
    searchIndexPath: path.join(built, "cache", "ai-dev-search.sqlite")
  });
  const second = await readRequiredState({
    paths: builtPaths,
    callTool: async () => toolResult({ stale: false, dense_documents: 0 }),
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(built, "cases.json")
  });
  assert.deepEqual(second.present, { skill_registry: true, search_index: true, routing_benchmark: true });
  assert.deepEqual(second.stale, { search_index: false, routing_benchmark: false });
  // The second container start rebuilds nothing.
  assert.deepEqual(planFirstRun({ present: second.present, stale: second.stale })
    .filter((step) => step.run), []);
});

test("an index the vault has moved past, and a benchmark older than its cases, are rebuilt", async (t) => {
  const root = await makeVault(t, {
    "03-skills-catalog/registries/skills.index.json": "[]",
    "03-skills-catalog/registries/skill-routing-eval.json": "{}",
    "cache/ai-dev-search.sqlite": "",
    "cases.json": "[]"
  });
  const casesPath = path.join(root, "cases.json");
  const reportPath = path.join(root, "03-skills-catalog", "registries", "skill-routing-eval.json");
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(reportPath, past, past);

  const state = await readRequiredState({
    paths: requiredArtefactPaths({ vaultRoot: root, searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite") }),
    callTool: async () => toolResult({ stale: true }),
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: casesPath
  });
  assert.deepEqual(state.stale, { search_index: true, routing_benchmark: true });
  assert.deepEqual(
    planFirstRun({ present: state.present, stale: state.stale }).filter((step) => step.run).map((step) => step.id),
    ["search_index", "routing_benchmark"]
  );
});

test("running a plan reports every step, including the ones this caller cannot run", async () => {
  const announced = [];
  const plan = planFirstRun({ present: {}, stale: {}, want: { frontend_qa: true } });
  const results = await runFirstRunPlan(plan, {
    skill_registry: async () => "3227 skill(s) indexed",
    search_index: async () => { throw new Error("python is missing\nsecond line ignored"); },
    routing_benchmark: async () => "37/37 cases pass"
  }, (step) => announced.push(step.id));

  assert.deepEqual(announced, ["skill_registry", "search_index", "routing_benchmark"]);
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  assert.equal(byId.skill_registry.status, "done");
  assert.equal(byId.search_index.status, "failed");
  assert.equal(byId.search_index.error, "python is missing", "only the first line of a failure is kept");
  assert.equal(byId.routing_benchmark.status, "done", "a failed step does not stop the rest");
  // The container has no action for the optional steps and does not pretend to.
  assert.equal(byId.frontend_qa.status, "skipped");
  assert.equal(results.length, plan.length);
});
