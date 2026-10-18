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
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../src/core/file-lock.mjs";
import { planFirstRun, renderFirstRunReport } from "../src/core/first-run.mjs";
import { restorePreparedTimes } from "../src/core/image-data.mjs";
import { dockerCommand } from "../src/core/install-layout.mjs";
import { FILE_CLOCK_MARGIN_MS } from "../src/core/skill-registry-freshness.mjs";
import {
  createRequiredActions,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan
} from "./first-run-steps.mjs";
import {
  callTool,
  searchIndexPath,
  seedSync,
  shutdownBgeWorkers,
  skillRoutingEvalCasesPath
} from "../src/mcp-stdio.mjs";

/** How long a start waits for another one building the same volume: a 2.x volume's first start takes 15–20 s. */
const BUILD_LOCK_TIMEOUT_MS = 180_000;

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

/**
 * The optional steps in the image's words: it has no setup flags. The model
 * goes into the volume with one run of its own, which embeds the documents too;
 * the browser comes with the `-browser` variant (docs/DEFECTS.md, Д-328).
 */
function imageReason(step, state) {
  const install = dockerCommand("model install");
  if (step.id === "frontend_qa") return state === "missing" ? "not in this image — its -browser variant carries it" : "comes with the image";
  if (state === "stale") return `out of date — \`${install}\` rebuilds it`;
  return state === "present" ? "installed in this volume" : `not installed — \`${install}\` puts it in this volume`;
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

  // Each client session is a container of its own, and three clients started
  // at once build one volume: the steps go one start at a time, and the next
  // finds built what the first built (docs/DEFECTS.md, Д-326).
  const results = await withFileLock(path.join(path.dirname(vaultRoot), ".ai-dev-first-run"), async () => {
    const paths = requiredArtefactPaths({ vaultRoot, searchIndexPath });
    const { present, stale } = await readRequiredState({
      paths,
      callTool,
      serverRoot,
      skillRoutingEvalCasesPath
    });
    // What goes out of date is rebuilt at the next start: there is nothing to force.
    const plan = planFirstRun({ present, stale, optionalReason: imageReason, builtReason: "already built" });
    const actions = createRequiredActions({ callTool });
    const announce = (step) => process.stderr.write(`→ ${step.title}: ${step.detail}\n`);

    // The registry is dated as far back as a file clock may lag (Д-135): built
    // within that much of a seed sync that changed the catalogue, it would read
    // as stale at the next start and be built again for nothing (Д-328).
    const changed = seedSync?.status === "synced" && (seedSync.added + seedSync.updated + seedSync.removed) > 0;
    if (changed && plan.some((step) => step.id === "skill_registry" && step.run)) await sleep(FILE_CLOCK_MARGIN_MS);

    // The registry first, because the dashboard below reports what is in it.
    const done = await runFirstRunPlan(plan.filter((step) => step.id === "skill_registry"), actions, announce);

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

    done.push(...await runFirstRunPlan(plan.filter((step) => step.id !== "skill_registry"), actions, announce));
    return done;
  }, { timeoutMs: BUILD_LOCK_TIMEOUT_MS, heartbeatMs: 10_000 });
  process.stderr.write(`${renderFirstRunReport(results)}\n`);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ restored, results })}\n`);
} finally {
  shutdownBgeWorkers();
}
