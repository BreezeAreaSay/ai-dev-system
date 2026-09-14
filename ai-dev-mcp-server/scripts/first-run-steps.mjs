/**
 * The steps every install builds, shared by the two commands that build them.
 *
 * `scripts/first-run.mjs` is the npm path and `scripts/docker-bootstrap.mjs` is
 * the container path, and for a long time they built different things: the npm
 * path ran the skill registry, the search index and the routing benchmark,
 * while the container ran the registry alone. A fresh container therefore
 * started with no index and no benchmark, and the first thing its user saw was
 * `Health: fail` on a correct install, with every search tool refusing until
 * somebody called `rebuild_search_index` by hand (docs/DEFECTS.md, Д-57).
 *
 * So the three required steps of `FIRST_RUN_STEPS` live here — what decides
 * whether each is needed, what each one does, and how to run a plan — and both
 * commands call the same code. `src/core/first-run.mjs` still decides *what* to
 * run from what is on disk; this is the part that touches the disk and the
 * tools, which is why it is a script rather than a core module.
 *
 * Nothing here reaches the network and every step is idempotent: a second
 * container start finds all three present and current, and rebuilds nothing.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The steps of `FIRST_RUN_STEPS` that no install can do without.
 *
 * The other three — the Frontend QA dependencies, the BGE-M3 weights and the
 * dense vectors built from them — are opt-in, reach the network, and are never
 * run unasked. A container has no way to ask, so it runs exactly these.
 */
export const REQUIRED_STEP_IDS = Object.freeze(["skill_registry", "search_index", "routing_benchmark"]);

/**
 * Where the artefacts of the required steps live, given a vault.
 *
 * @param {object} input
 * @param {string} input.vaultRoot
 * @param {string} input.searchIndexPath
 * @returns {{ registriesDir: string, skillRegistryPath: string, searchIndexPath: string, routingReportPath: string }}
 */
export function requiredArtefactPaths({ vaultRoot, searchIndexPath }) {
  const registriesDir = path.join(vaultRoot, "03-skills-catalog", "registries");
  return {
    registriesDir,
    skillRegistryPath: path.join(registriesDir, "skills.index.json"),
    searchIndexPath,
    routingReportPath: path.join(registriesDir, "skill-routing-eval.json")
  };
}

/**
 * The text payload of a tool result, parsed, or `null` when it is not JSON.
 *
 * @param {{ content?: Array<{ type: string, text?: string }> }} result
 * @returns {object|null}
 */
export function parseToolResult(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One line about what a tool did, from its own JSON answer.
 *
 * @param {object} result - A tool result.
 * @param {(doc: object) => string} describe
 * @returns {string}
 */
export function summarizeToolResult(result, describe) {
  const doc = parseToolResult(result);
  return doc ? describe(doc) : "done";
}

/**
 * What each required step actually does. Every one of them is idempotent.
 *
 * @param {object} input
 * @param {(name: string, args: object) => Promise<object>} input.callTool
 * @returns {Record<string, () => Promise<string>>} Keyed by step id.
 */
export function createRequiredActions({ callTool }) {
  return {
    async skill_registry() {
      const result = await callTool("rebuild_index", {});
      return summarizeToolResult(result, (doc) => `${doc.total ?? doc.count ?? doc.skills ?? "?"} skill(s) indexed`);
    },
    async search_index() {
      const result = await callTool("rebuild_search_index", {
        include_external_project_files: true,
        // A container ships without the weights, and a clone that has them has
        // already embedded with them: neither wants this rebuild to drop the
        // vectors or to try to make new ones.
        dense_embeddings: false,
        preserve_dense: true
      });
      return summarizeToolResult(result, (doc) => (
        `${doc.indexed_document_count ?? doc.current_document_count ?? doc.documents ?? "?"} document(s) indexed`
      ));
    },
    async routing_benchmark() {
      const result = await callTool("run_skill_routing_eval", {});
      return summarizeToolResult(result, (doc) => {
        const passed = doc.summary?.passed ?? doc.passed;
        const total = doc.summary?.total ?? doc.total;
        return total === undefined ? "benchmark written" : `${passed}/${total} cases pass`;
      });
    }
  };
}

async function modifiedAt(target) {
  const stat = await fs.stat(target).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

/**
 * What of the required work is already on disk, and what of it is out of date.
 *
 * Existence was once the only question asked, so a vault whose notes had moved
 * on since the last build was told "already built" and then, two lines later by
 * the diagnostic in the same run, that its index and its benchmark were stale.
 * These are the signals the health check itself grades, asked before rather
 * than after.
 *
 * The index status walks the vault and needs a working Python helper. A machine
 * without one cannot answer it, and that is a reason to rebuild rather than to
 * stop before the first step.
 *
 * @param {object} input
 * @param {ReturnType<typeof requiredArtefactPaths>} input.paths
 * @param {(name: string, args: object) => Promise<object>} input.callTool
 * @param {string} input.serverRoot
 * @param {string} input.skillRoutingEvalCasesPath
 * @returns {Promise<{ indexStatus: object|null, present: Record<string, boolean>, stale: Record<string, boolean> }>}
 */
export async function readRequiredState({ paths, callTool, serverRoot, skillRoutingEvalCasesPath }) {
  const indexStatus = existsSync(paths.searchIndexPath)
    ? await callTool("search_index_status", { include_external_project_files: true })
      .then(parseToolResult)
      .catch(() => null)
    : null;
  const present = {
    skill_registry: existsSync(paths.skillRegistryPath),
    search_index: existsSync(paths.searchIndexPath),
    routing_benchmark: existsSync(paths.routingReportPath)
  };
  const stale = { search_index: Boolean(indexStatus?.stale) };
  if (present.routing_benchmark) {
    const report = await modifiedAt(paths.routingReportPath);
    const inputs = await Promise.all([
      modifiedAt(skillRoutingEvalCasesPath),
      modifiedAt(path.join(serverRoot, "src", "core", "skill-router.mjs"))
    ]);
    stale.routing_benchmark = report < Math.max(...inputs);
  }
  return { indexStatus, present, stale };
}

/**
 * Run the steps a plan says to run, and say what happened to each.
 *
 * A step with no action is reported as it was planned: `planFirstRun` knows
 * about optional steps this runner has no action for, and a caller that only
 * has the required actions still gets a full report.
 *
 * @param {Array<{ id: string, run: boolean }>} plan - From `planFirstRun`.
 * @param {Record<string, () => Promise<string>>} actions
 * @param {(line: string) => void} [onStep] - Called before each step that runs.
 * @returns {Promise<Array<object>>} The plan entries with `status` and timing.
 */
export async function runFirstRunPlan(plan, actions, onStep = () => {}) {
  const results = [];
  for (const step of plan) {
    if (!step.run || !actions[step.id]) {
      results.push({ ...step, status: "skipped" });
      continue;
    }
    onStep(step);
    const started = Date.now();
    try {
      const reason = await actions[step.id]();
      results.push({ ...step, status: "done", reason, duration_ms: Date.now() - started });
    } catch (error) {
      results.push({
        ...step,
        status: "failed",
        error: String(error?.message ?? error).split("\n")[0],
        duration_ms: Date.now() - started
      });
    }
  }
  return results;
}
