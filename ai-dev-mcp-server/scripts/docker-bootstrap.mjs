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
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readDenseManifest } from "../src/core/dense-manifest.mjs";
import { defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { acquireFileLock } from "../src/core/file-lock.mjs";
import { planFirstRun, renderFirstRunReport } from "../src/core/first-run.mjs";
import { frontendQaInstalled } from "../src/core/frontend-qa-install.mjs";
import { restorePreparedTimes } from "../src/core/image-data.mjs";
import { dockerCommand } from "../src/core/install-layout.mjs";
import { modelStatus } from "../src/core/model-manager.mjs";
import { QA_ROOT, frontendQaStatus } from "../src/core/setup-runner.mjs";
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

/**
 * A start waits for another one building the same volume — a 2.x volume's first
 * start takes 15–20 s — and serves what is built once it has waited this long.
 * The holder beats every 3 s, and one that has not for 20 s is taken for killed:
 * a fifth of a CPU left 6 s between two beats, a tenth 11 s, as the index is
 * built in one piece (docs/DEFECTS.md, Д-326, Д-336).
 */
const FIRST_RUN_LOCK = Object.freeze({ timeoutMs: 180_000, staleMs: 20_000, heartbeatMs: 3_000 });

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
 * The optional steps as `setup` finds them: the model checked against its
 * manifest, the vectors by the index's own count, the browser where the runner
 * looks for it — so a start says what this volume has, not what it might
 * (docs/DEFECTS.md, Д-332).
 */
async function optionalState(indexStatus) {
  const env = process.env;
  const modelDir = defaultOnnxModelDir({ env });
  const qaDependencies = existsSync(path.join(QA_ROOT, "node_modules"));
  return {
    modelDir,
    qaDependencies,
    present: {
      frontend_qa: frontendQaInstalled({ dependencies: qaDependencies, status: qaDependencies ? await frontendQaStatus(vaultRoot, { launch: false }) : null }),
      dense_model: (await modelStatus({ manifest: readDenseManifest(), dir: modelDir, env })).installed,
      dense_index: Number(indexStatus?.dense_documents || 0) > 0
    },
    // Documents indexed since the last embedding run have no vector yet.
    stale: { dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0 }
  };
}

/**
 * The optional steps in the image's words: it has no setup flags. The model
 * goes into the volume with one run of its own, which embeds the documents too;
 * the browser comes with the `-browser` variant (docs/DEFECTS.md, Д-328, Д-332).
 */
function imageReason({ modelDir, qaDependencies }) {
  const install = dockerCommand("model install");
  return (step, state) => {
    if (step.id === "frontend_qa") {
      if (state !== "missing") return "comes with the image";
      return qaDependencies
        ? "its packages are here but not the browser they want: this -browser image is not whole"
        : "not in this image — its -browser variant carries it";
    }
    if (step.id === "dense_model") return state === "present" ? `installed in ${modelDir}` : `not installed — \`${install}\` puts it in this volume`;
    if (state === "stale") return `documents indexed since have none — \`${install}\` embeds them`;
    return state === "present" ? "every indexed document has one" : `none yet — \`${install}\` embeds the documents`;
  };
}

/** The steps, one start at a time: what the first start built, the next finds built. */
async function firstRunSteps() {
  const paths = requiredArtefactPaths({ vaultRoot, searchIndexPath });
  const required = await readRequiredState({
    paths,
    callTool,
    serverRoot,
    skillRoutingEvalCasesPath
  });
  const optional = await optionalState(required.indexStatus);
  // What goes out of date is rebuilt at the next start: there is nothing to force.
  const plan = planFirstRun({
    present: { ...required.present, ...optional.present },
    stale: { ...required.stale, ...optional.stale },
    optionalReason: imageReason(optional),
    builtReason: "already built"
  });
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
  let release = null;
  try {
    release = await acquireFileLock(path.join(path.dirname(vaultRoot), ".ai-dev-first-run"), FIRST_RUN_LOCK);
  } catch (error) {
    // A volume this start cannot write is said as that. A start still building
    // after all this wait is let be: a session on what is built so far beats
    // none, which is what an error here left the client (Д-336).
    if (error?.code) throw error;
    process.stderr.write(`→ Waited ${FIRST_RUN_LOCK.timeoutMs / 60_000} min for another start building this volume: `
      + "this one serves what is built so far, and a later start finishes the rest.\n");
  }
  let results = [];
  if (release) {
    try {
      results = await firstRunSteps();
    } finally {
      await release();
    }
    process.stderr.write(`${renderFirstRunReport(results)}\n`);
  }
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ restored, results, waited_out: !release })}\n`);
} finally {
  shutdownBgeWorkers();
}
