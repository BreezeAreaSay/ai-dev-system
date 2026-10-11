#!/usr/bin/env node
/**
 * `npm run upgrade:test` — does a 2.x install keep working after an upgrade?
 *
 * The test installs the production 2.x line from a commit (default `8f647df`,
 * production `main` when the 3.0 program started) into a git worktree, uses
 * the 2.x server to create the state a real user has — a task with a
 * checkpoint, a decision, an instinct, a session handoff, the search index,
 * agent hooks in a repository, client configurations in both 2.x formats — and
 * then upgrades that same checkout to the working tree in front of it the way a
 * user does: `git pull` (here: a copy of the tracked and untracked files) and
 * `npm ci`. The current server is then started through the command the 2.x
 * client configuration holds, and has to find all of it.
 *
 * Each user's 2.x index also carries dense vectors, written by the 2.x helper
 * the way its ONNX path writes real ones (`dense-plan`, then `rebuild
 * --dense-vectors-json`), from synthetic numbers since no model is needed to
 * check that they survive: the upgraded server must find the index current
 * without rebuilding it, keep every vector byte for byte through a refresh, and
 * search it (program phase 3).
 *
 * Three users are simulated: one with the defaults; one who set
 * `AI_DEV_HOME`, whose 2.x data sits one level deeper than documented
 * (docs/DEFECTS.md, Д-90) and must be migrated without loss; and the layout of
 * the Docker image's /data volume — `AI_DEV_HOME` under the home plus explicit
 * state, index and artifact roots, the environment the Dockerfile sets — run
 * here without a container.
 *
 * The container half itself — pulling the 2.x image, keeping its volume, the
 * launchers the clients hold — cannot run where the published image is not
 * pullable; `docs/UPGRADE-TEST.md` describes it for CI.
 *
 * Usage: npm run upgrade:test [-- --base <commit>] [--keep]
 *
 * Not named `upgrade-test.mjs`: `node --test` picks up `*-test.mjs` by its own
 * patterns, and every `npm test` ran this whole scenario as a unit test
 * (docs/DEFECTS.md, Д-112).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";
import { resolvePythonCommand } from "../src/core/python-command.mjs";
import { openDatabase, sqliteSupport } from "../src/core/search-sqlite.mjs";

export const DEFAULT_BASE_COMMIT = "8f647df";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(serverRoot, "..");

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE_COMMIT, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") options.base = String(argv[++index] || "");
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.base) throw new Error("--base needs a commit.");
  return options;
}

function run(command, args, { cwd, env = process.env, allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true, shell: false, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}:\n${(result.stderr || result.stdout || "").slice(-4000)}`);
  }
  return result;
}

/** npm without a shell: on Windows `npm` is a `.cmd`, which the spawn adapter rewrites to `node npm-cli.js`. */
const npmPlan = await resolveSpawnInvocation("npm", []);
function npm(args, options) {
  return run(npmPlan.executable, [...npmPlan.args, ...args], options);
}

const checks = [];
function check(label, condition, detail = "") {
  checks.push({ label, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function withServer({ command, args, env, cwd }, operation) {
  const transport = new StdioClientTransport({ command, args, env, cwd, stderr: "pipe" });
  const client = new Client({ name: "ai-dev-upgrade-test", version: "1.0.0" }, { capabilities: {} });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await client.connect(transport);
    return await operation(client);
  } catch (error) {
    error.message = `${error.message}\n--- server stderr ---\n${stderr.join("").slice(-3000)}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = (result.content || []).map((item) => item.text || "").join("\n");
  if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeRepository(root) {
  run("git", ["init", "-q", root]);
  return fs.writeFile(path.join(root, "README.md"), "# upgrade fixture\n", "utf8").then(() => {
    run("git", ["-C", root, "add", "."]);
    run("git", ["-C", root, "-c", "user.name=AI Dev Upgrade Test", "-c", "user.email=upgrade-test@example.invalid", "commit", "-qm", "fixture"]);
  });
}

/**
 * Make `target` hold exactly what the working tree at `source` holds — the
 * files git tracks plus the untracked ones it does not ignore — the way
 * `git pull` would leave a clone. Ignored files in `target` (node_modules, the
 * generated seed registries) stay, as they do for a user.
 */
async function syncWorkingTree(source, target) {
  const list = (cwd, extra) => run("git", ["-C", cwd, "ls-files", "-z", "--cached", ...extra])
    .stdout.split("\0").filter(Boolean);
  const wanted = new Set(list(source, ["--others", "--exclude-standard"]).filter((relative) => existsSync(path.join(source, relative))));
  // Like `git pull`: files the old revision tracked and the new one does not
  // are removed; untracked files of the user's own are left alone.
  for (const relative of list(target, [])) {
    if (!wanted.has(relative)) await fs.rm(path.join(target, relative), { force: true });
  }
  for (const relative of wanted) {
    const destination = path.join(target, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, relative), destination);
    const mode = (await fs.stat(path.join(source, relative))).mode;
    await fs.chmod(destination, mode & 0o777);
  }
  return wanted.size;
}

function scenarioEnv(base, { home, aiDevHome, explicitRoots }) {
  // Every directory a client installer derives its target from, inside the
  // scenario's home: on Windows the 2.x installers write VS Code's and Claude
  // Desktop's configuration under APPDATA and LOCALAPPDATA, not under HOME.
  const env = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local")
  };
  for (const key of Object.keys(env)) {
    if (/^(AI_DEV_|BGE_M3_)/.test(key)) delete env[key];
  }
  delete env.XDG_CONFIG_HOME;
  if (aiDevHome) env.AI_DEV_HOME = aiDevHome;
  if (explicitRoots) {
    // What docker/Dockerfile sets next to AI_DEV_HOME, in 2.x and now.
    env.AI_DEV_STATE_ROOT = path.join(aiDevHome, "state");
    env.AI_DEV_SEARCH_INDEX_DIR = path.join(aiDevHome, "cache", "search-index");
    env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT = path.join(aiDevHome, "artifacts", "frontend-qa");
  }
  return env;
}

/** Every file under `root`, relative to it; empty when it does not exist. */
async function listFiles(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

/**
 * One hash over the stored dense vectors and their ids, with their count, and
 * the same per vector — id to the hash of its row; empty where this Node
 * cannot read the file.
 */
function denseDigest(indexPath) {
  if (!sqliteSupport().available || !existsSync(indexPath)) return { count: 0, digest: "", byId: new Map() };
  const db = openDatabase(indexPath);
  try {
    const hash = crypto.createHash("sha256");
    const byId = new Map();
    const rows = db.prepare("SELECT id, vector, backend, revision, dtype, content_hash FROM dense_vectors ORDER BY id").all();
    for (const row of rows) {
      const head = `${row.id}\0${row.backend}\0${row.revision}\0${row.dtype}\0${row.content_hash}\0`;
      hash.update(head);
      hash.update(row.vector);
      byId.set(row.id, crypto.createHash("sha256").update(head).update(row.vector).digest("hex"));
    }
    return { count: rows.length, digest: hash.digest("hex"), byId };
  } finally {
    db.close();
  }
}

/** Documents in an index that get a dense vector: everything but Membrane's connectors (Д-91). */
function denseEligibleDocuments(indexPath) {
  if (!sqliteSupport().available || !existsSync(indexPath)) return 0;
  const db = openDatabase(indexPath);
  try {
    return db.prepare("SELECT count(*) AS n FROM documents WHERE lower(source) NOT LIKE '%membrane%'").get().n;
  } finally {
    db.close();
  }
}

/**
 * The skills a checkout of the working tree no longer has that `base` had —
 * what `git pull` deletes from a 2.x clone's catalogue — by name.
 */
function removedSkills(base) {
  const listed = run("git", ["-C", repoRoot, "diff", "--name-only", "--diff-filter=D", base, "--", "docker/public-seed/03-skills-catalog/sources"]).stdout;
  return listed.split("\n").filter((line) => line.endsWith("/SKILL.md")).map((line) => path.basename(path.dirname(line)));
}

/**
 * Dense vectors in the 2.x index, written by the 2.x helper exactly as its
 * ONNX path writes them; the numbers are synthetic, which is all a check of
 * their survival needs.
 */
function seedLegacyVectors({ baseRoot, env, indexPath }) {
  const helper = path.join(baseRoot, "search-index", "search_cli.py");
  const python = resolvePythonCommand({ env });
  const common = ["--vault-root", path.join(baseRoot, "docker", "public-seed"), "--index-path", indexPath, "--include-external-project-files"];
  const provenance = ["--dense-backend", "onnx", "--dense-revision", "upgrade-fixture", "--dense-dtype", "int8"];
  const plan = JSON.parse(run(python, [helper, "dense-plan", ...common, ...provenance], { env }).stdout);
  const vectors = plan.records.map((record, index) => ({
    id: record.id,
    content_hash: record.content_hash,
    vector: Array.from({ length: 1024 }, (_, position) => ((index * 7 + position) % 101) / 101 - 0.5)
  }));
  const file = path.join(path.dirname(indexPath), "upgrade-fixture-vectors.json");
  writeFileSync(file, JSON.stringify({ vectors }));
  try {
    const rebuilt = JSON.parse(run(python, [helper, "rebuild", ...common, "--dense-embeddings", "--dense-vectors-json", file, ...provenance], { env }).stdout);
    const stored = denseDigest(indexPath);
    return { vectors: rebuilt.dense_documents, digest: stored.digest, byId: stored.byId };
  } finally {
    rmSync(file, { force: true });
  }
}

/** Everything the 2.x server writes for one user, recorded so it can be found again. */
async function createLegacyState({ baseServer, env, project }) {
  return withServer({ command: process.execPath, args: [path.join(baseServer, "src", "server.mjs")], env, cwd: baseServer }, async (client) => {
    const begun = await call(client, "begin_task", { project_path: project, task: "Upgrade fixture: add CSV export" });
    const taskId = begun.task?.id || begun.task_id || begun.id;
    assert.ok(taskId, `begin_task returned no task id: ${JSON.stringify(begun).slice(0, 500)}`);
    await call(client, "checkpoint_task", { task_id: taskId, summary: "Wrote the exporter and its test.", changed_files: ["README.md"], snapshot: false });
    await call(client, "record_decision", { task_id: taskId, title: "Upgrade fixture decision", decision: "CSV is exported with a header row." });
    await call(client, "record_instinct", { project_path: project, trigger: "when exporting CSV for the upgrade fixture", action: "write a header row first" });
    await call(client, "save_session", { project_path: project, topic: "Upgrade fixture handoff", building: "A CSV export.", next_step: "Run verify_task." });
    await call(client, "install_agent_hooks", { project_path: project, targets: ["claude"] });
    const built = await call(client, "search_index_status", {});
    const dense = seedLegacyVectors({ baseRoot: path.resolve(baseServer, ".."), env, indexPath: built.index_path });
    const status = await call(client, "search_index_status", {});
    assert.equal(Number(status.dense_documents), dense.vectors, "2.x reports the vectors it was given");
    const registry = await readJson(path.join(baseServer, "..", "docker", "public-seed", "03-skills-catalog", "registries", "skills.index.json"));
    return { taskId, documents: indexedDocuments(status), skills: registry.length, dense };
  });
}

function writeLegacyClientConfigs({ baseRoot, env, project }) {
  const baseServer = path.join(baseRoot, "ai-dev-mcp-server");
  run(process.execPath, [path.join(baseServer, "scripts", "install-local-mcp-clients.mjs"), "--apply"], { cwd: baseServer, env });
  run(process.execPath, [
    path.join(baseServer, "scripts", "install-docker-mcp-clients.mjs"), "--apply",
    "--home", env.HOME,
    "--launcher", path.join(baseRoot, "docker", process.platform === "win32" ? "run-mcp.ps1" : "run-mcp.sh"),
    "--image", "ghcr.io/stonebridgeway/ai-dev-system:latest",
    "--project-path", project,
    "--runtime-container", "ai-dev-system-runtime-1000",
    "--platform", process.platform === "win32" ? "win32" : "linux"
  ], { cwd: baseServer, env });
}

/** `search_index_status` names the count of what is in the index `indexed_document_count`. */
function indexedDocuments(status) {
  return Number(status?.indexed_document_count ?? 0);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function verifyUpgradedScenario({ label, base, baseRoot, env, project, expected, aiDevHome, doubledBefore = [] }) {
  const cursor = await readJson(path.join(env.HOME, ".cursor", "mcp.json"));
  const local = cursor.mcpServers?.["ai-dev-system"];
  check(`${label}: the 2.x local client entry is still there`, local?.command && Array.isArray(local.args), JSON.stringify(local?.args ?? null));
  const docker = cursor.mcpServers?.["ai-dev"];
  check(`${label}: the 2.x Docker client entry still points at an existing launcher`, docker && existsSync(docker.args?.[0] ?? ""), docker?.args?.[0] ?? "missing");

  // Start the server exactly as the 2.x client configuration does.
  const serverEnv = { ...env, ...(local?.env || {}) };
  await withServer({ command: local.command, args: local.args, env: serverEnv, cwd: path.dirname(local.args[0]) }, async (client) => {
    check(`${label}: the server starts from the 2.x client entry and sends instructions`, (client.getInstructions() || "").length > 0, `${(client.getInstructions() || "").length} characters`);
    // get_task answers with the record itself; its `task` field is the request text.
    const record = await call(client, "get_task", { task_id: expected.taskId });
    check(`${label}: the 2.x task is found, with its checkpoint`, record?.id === expected.taskId && (record.checkpoints?.length ?? 0) >= 1, `status ${record?.status}, ${record?.checkpoints?.length ?? 0} checkpoint(s)`);
    const decisions = await call(client, "list_decisions", { project_path: project });
    const titles = JSON.stringify(decisions);
    check(`${label}: the 2.x decision is listed`, titles.includes("Upgrade fixture decision"));
    const instincts = JSON.stringify(await call(client, "list_instincts", { project_path: project }));
    check(`${label}: the 2.x instinct is listed`, instincts.includes("when exporting CSV for the upgrade fixture"));
    const sessions = JSON.stringify(await call(client, "list_sessions", { project_path: project }));
    check(`${label}: the 2.x session handoff is listed`, sessions.includes("Upgrade fixture handoff"));
    // The pull may have removed skills from the catalogue (the curation of
    // 2026-10-11 removed 2,614): the server has to notice, not go on routing
    // to them (Д-119). Status reads the index as 2.x left it and says so.
    const status = await call(client, "search_index_status", {});
    const documents = indexedDocuments(status);
    const pulledAway = removedSkills(base);
    check(`${label}: the 2.x search index is read as it is, nothing rewritten by a status call`, documents > 0 && documents === expected.documents, `${documents} document(s), 2.x had ${expected.documents}`);
    if (sqliteSupport().available) {
      check(`${label}: the Node engine answers, and sees what the pull changed in the catalogue`,
        status.engine === "node" && status.stale === (pulledAway.length > 0),
        `engine ${status.engine}, stale ${status.stale}${status.reasons?.length ? ` (${status.reasons.join(", ")})` : ""}, ${pulledAway.length} skill(s) removed by the pull`);
    }
    const registry = await readJson(path.join(baseRoot, "docker", "public-seed", "03-skills-catalog", "registries", "skills.index.json"));
    const listedGone = registry.filter((item) => pulledAway.includes(item.name) && String(item.source).includes("membrane"));
    check(`${label}: the skill registry follows the pulled catalogue`, listedGone.length === 0 && (pulledAway.length === 0 || registry.length < expected.skills),
      `${registry.length} skill(s), 2.x had ${expected.skills}; ${listedGone.length} removed one(s) still listed`);
    const { vectors, digest, byId } = expected.dense;
    check(`${label}: the 2.x dense vectors are all there`, vectors > 0 && Number(status.dense_documents) === vectors && status.dense_backend === "onnx",
      `${status.dense_documents} of ${vectors}, backend ${status.dense_backend}`);
    if (digest) {
      check(`${label}: the 2.x vectors are untouched, byte for byte`, denseDigest(status.index_path).digest === digest);
      const refreshed = await call(client, "rebuild_search_index", {});
      const after = denseDigest(status.index_path);
      // Every vector the rebuild keeps is a 2.x vector, unchanged; those of
      // documents gone or rewritten (Membrane's connectors, by Д-91, and the
      // group notes the smaller catalogue rewrote) are dropped and the
      // documents wait for an embedding run.
      const altered = [...after.byId].filter(([id, row]) => byId.get(id) !== row).length;
      const eligible = denseEligibleDocuments(status.index_path);
      check(`${label}: a rebuild keeps byte for byte every 2.x vector whose document it still has unchanged`,
        refreshed.dense_preserved === true && after.count > 0 && altered === 0 && refreshed.dense_documents === after.count
          && refreshed.dense_pending_documents === eligible - after.count,
        `${after.count} of ${vectors} kept, ${altered} altered, ${vectors - after.count} dropped with their documents gone or rewritten, `
          + `${refreshed.dense_pending_documents} pending of ${eligible}, engine ${refreshed.engine}`);
    }
    if (pulledAway.length > 0) {
      const gone = pulledAway[0];
      const found = await call(client, "search_skill_registry", { query: gone, limit: 20 });
      const stillThere = (Array.isArray(found) ? found : []).filter((item) => String(item.path || "").includes(`/skills/${gone}/`));
      check(`${label}: a skill the pull removed is not found any more`, stillThere.length === 0, `${gone}: ${stillThere.length} result(s)`);
    }
    const found = await call(client, "search_all", { query: "code review" });
    const hits = Array.isArray(found) ? found.length : (found.results?.length ?? 0);
    check(`${label}: search answers on the upgraded install`, hits > 0, `${hits} result(s)`);
    const hybrid = await call(client, "hybrid_search", { query: "code review checklist", dense_weight: 0 });
    const hybridHits = Array.isArray(hybrid) ? hybrid.length : (hybrid.results?.length ?? 0);
    check(`${label}: hybrid search (still the Python helper) reads the index the upgraded server keeps`, hybridHits > 0, `${hybridHits} result(s)`);
  });

  if (aiDevHome) {
    const left = await listFiles(path.join(aiDevHome, ".ai-dev"));
    check(`${label}: nothing is left one level too deep in AI_DEV_HOME`, left.length === 0, `${doubledBefore.length} file(s) there under 2.x, ${left.length} now`);
    const missing = doubledBefore.filter((relative) => !existsSync(path.join(aiDevHome, relative)));
    check(`${label}: every file 2.x put there is in AI_DEV_HOME itself now`, missing.length === 0, missing.slice(0, 3).join(", "));
    check(`${label}: the task now lives in AI_DEV_HOME itself`, existsSync(path.join(aiDevHome, "state", "tasks", `${expected.taskId}.json`)));
  }

  // The 2.x hook copy in the repository still runs against the upgraded state.
  const settings = await readJson(path.join(project, ".claude", "settings.json"));
  const sessionStart = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command || "";
  const [hookCommand, ...hookArgs] = sessionStart.split(" ");
  const hook = run(hookCommand === "node" ? process.execPath : hookCommand, hookArgs, {
    cwd: project,
    env,
    input: JSON.stringify({ session_id: `upgrade-${label}`, cwd: project, source: "startup" }),
    allowFailure: true
  });
  check(`${label}: the 2.x SessionStart hook runs`, hook.status === 0, `exit ${hook.status}`);
  if (!aiDevHome) {
    check(`${label}: the 2.x hook still sees the open task`, hook.stdout.includes(expected.taskId));
    return;
  }
  // A 2.x hook computes the old, doubled path, so it cannot see the migrated
  // task; re-installing the hooks with the upgraded server is the documented fix.
  await withServer({ command: local.command, args: local.args, env: serverEnv, cwd: path.dirname(local.args[0]) }, (client) => (
    call(client, "install_agent_hooks", { project_path: project, targets: ["claude"] })
  ));
  const refreshed = run(hookCommand === "node" ? process.execPath : hookCommand, hookArgs, {
    cwd: project,
    env,
    input: JSON.stringify({ session_id: `upgrade-${label}-refreshed`, cwd: project, source: "startup" }),
    allowFailure: true
  });
  check(`${label}: after install_agent_hooks the hook sees the migrated task`, refreshed.status === 0 && refreshed.stdout.includes(expected.taskId), `exit ${refreshed.status}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run upgrade:test [-- --base <commit>] [--keep]");
    return;
  }
  const started = Date.now();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-upgrade-"));
  const baseRoot = path.join(temp, "clone");
  const baseServer = path.join(baseRoot, "ai-dev-mcp-server");
  console.log(`Base: ${options.base} → working tree at ${repoRoot}`);
  console.log(`Scratch: ${temp}`);
  try {
    run("git", ["-C", repoRoot, "worktree", "add", "--detach", "--force", baseRoot, options.base]);
    npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: baseServer });

    const dockerHome = path.join(temp, "data", "runtime-home");
    const scenarios = [
      { label: "default", home: path.join(temp, "home-default") },
      { label: "AI_DEV_HOME", home: path.join(temp, "home-custom"), aiDevHome: path.join(temp, "home-custom", "ai-dev-data") },
      { label: "Docker volume layout", home: dockerHome, aiDevHome: path.join(dockerHome, ".ai-dev"), explicitRoots: true }
    ];
    for (const scenario of scenarios) {
      await fs.mkdir(scenario.home, { recursive: true });
      scenario.env = scenarioEnv(process.env, scenario);
      scenario.project = path.join(temp, `project-${scenario.label.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      await makeRepository(scenario.project);
      npm(["run", "setup", "--", "--no-health"], { cwd: baseServer, env: scenario.env });
      scenario.expected = await createLegacyState({ baseServer, env: scenario.env, project: scenario.project });
      writeLegacyClientConfigs({ baseRoot, env: scenario.env, project: scenario.project });
      if (scenario.aiDevHome) scenario.doubledBefore = await listFiles(path.join(scenario.aiDevHome, ".ai-dev"));
      if (scenario.aiDevHome && !scenario.explicitRoots) {
        check(`${scenario.label}: 2.x wrote its data one level too deep (the case to migrate)`, existsSync(path.join(scenario.aiDevHome, ".ai-dev", "state", "tasks")), `${scenario.doubledBefore.length} file(s)`);
      }
    }

    const copied = await syncWorkingTree(repoRoot, baseRoot);
    console.log(`Upgraded the clone in place: ${copied} file(s) from the working tree.`);
    const install = npm(["ci", "--no-audit", "--no-fund"], { cwd: baseServer, allowFailure: true });
    check("npm ci without --ignore-scripts succeeds on the upgraded clone", install.status === 0, `exit ${install.status}`);
    if (install.status !== 0) {
      // Keep going, so one failed install does not hide every later check.
      npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: baseServer });
    }

    for (const scenario of scenarios) {
      await verifyUpgradedScenario({ ...scenario, base: options.base, baseRoot });
    }
  } finally {
    run("git", ["-C", repoRoot, "worktree", "remove", "--force", baseRoot], { allowFailure: true });
    if (!options.keep) await fs.rm(temp, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
  if (failed.length) process.exitCode = 1;
}

await main();
