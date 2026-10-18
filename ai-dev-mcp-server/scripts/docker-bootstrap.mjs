/**
 * What the container entrypoint does before the server answers its first call.
 *
 * The same required steps `npm run setup` runs — the skill registry, the search
 * index and the routing benchmark — plus the two artefacts only a container
 * builds. They are all idempotent, so this runs on every container start and
 * rebuilds nothing on the second one.
 *
 * It used to run the registry alone, which left a fresh container with no index
 * and no benchmark: four critical health checks failed, every search tool
 * refused, and the first thing a new user saw was `Health: fail` on a correct
 * install (docs/DEFECTS.md, Д-57).
 *
 * The image builds all of it into its own /data, which Docker copies into a new
 * volume (`scripts/docker-prepare-data.mjs`): on such a volume's first start the
 * skill folders get back the time the copy took from them, and nothing is rebuilt
 * (`src/core/image-data.mjs`).
 *
 *   node scripts/docker-bootstrap.mjs [--json]    --json: the steps' results on stdout
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { planFirstRun, renderFirstRunReport } from "../src/core/first-run.mjs";
import { restorePreparedTimes } from "../src/core/image-data.mjs";
import {
  createRequiredActions,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan
} from "./first-run-steps.mjs";
import {
  callTool,
  searchIndexPath,
  shutdownBgeWorkers,
  skillRoutingEvalCasesPath
} from "../src/mcp-stdio.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = path.resolve(process.env.AI_DEV_VAULT_ROOT || "/data/ai-dev-system");

async function tool(name, arguments_ = {}) {
  const result = await callTool(name, arguments_);
  if (result?.isError) {
    throw new Error(`${name}: ${result.content?.[0]?.text || "tool failed"}`);
  }
}

async function exists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

try {
  const restored = await restorePreparedTimes({ dataRoot: path.dirname(vaultRoot), vaultRoot });
  if (restored.restored) {
    process.stderr.write(restored.refused
      ? `→ A new volume from the image's data, run as another user than the image's: the skill folders keep the copy's time (${restored.refused}), so what reads them is rebuilt once.\n`
      : `→ A new volume from the image's data: ${restored.dated} skill folder(s) given back the time they were built with.\n`);
  }
  for (const relative of [
    "01-system",
    "02-knowledge/Projects",
    "02-knowledge/Task Runs",
    "03-skills-catalog/registries",
    "09-mcp",
    "10-inbox",
    "99-archive"
  ]) {
    await fs.mkdir(path.join(vaultRoot, relative), { recursive: true });
  }

  const paths = requiredArtefactPaths({ vaultRoot, searchIndexPath });
  const { present, stale } = await readRequiredState({
    paths,
    callTool,
    serverRoot,
    skillRoutingEvalCasesPath
  });
  const plan = planFirstRun({ present, stale });
  const actions = createRequiredActions({ callTool });
  const announce = (step) => process.stderr.write(`→ ${step.title}: ${step.detail}\n`);

  // The registry first, because the dashboard below reports what is in it.
  const results = await runFirstRunPlan(plan.filter((step) => step.id === "skill_registry"), actions, announce);

  // Container-only artefacts: a vault a person browses has a dashboard note,
  // and the runtime distribution manifest is written once per volume. Both are
  // written before the index rather than after it — a note that appears after
  // the index was built leaves it stale the moment the entrypoint finishes, and
  // the next container start rebuilt it for nothing.
  if (!await exists(path.join(vaultRoot, "01-system", "System Dashboard.md"))) {
    await tool("rebuild_system_dashboard");
  }
  if (!await exists(path.join(vaultRoot, "09-mcp", "runtime-distribution.json"))) {
    await tool("prepare_runtime_distribution");
  }

  results.push(...await runFirstRunPlan(plan.filter((step) => step.id !== "skill_registry"), actions, announce));
  process.stderr.write(`${renderFirstRunReport(results)}\n`);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ restored, results })}\n`);
} finally {
  shutdownBgeWorkers();
}
