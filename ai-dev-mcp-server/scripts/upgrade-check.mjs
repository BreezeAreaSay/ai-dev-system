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
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";

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
  const env = { ...base, HOME: home, USERPROFILE: home };
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
    const status = await call(client, "search_index_status", {});
    return { taskId, documents: indexedDocuments(status) };
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

async function verifyUpgradedScenario({ label, baseRoot, env, project, expected, aiDevHome, doubledBefore = [] }) {
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
    const status = await call(client, "search_index_status", {});
    const documents = indexedDocuments(status);
    check(`${label}: the 2.x search index is read without a rebuild`, documents > 0 && documents === expected.documents, `${documents} document(s), 2.x had ${expected.documents}`);
    const found = await call(client, "search_all", { query: "code review" });
    const hits = Array.isArray(found) ? found.length : (found.results?.length ?? 0);
    check(`${label}: search answers on the upgraded install`, hits > 0, `${hits} result(s)`);
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
      await verifyUpgradedScenario({ ...scenario, baseRoot });
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
