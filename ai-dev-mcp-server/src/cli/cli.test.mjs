import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonc } from "../core/jsonc-edit.mjs";
import { createIo } from "./context.mjs";
import { parseSetupArgs } from "./setup.mjs";
import { PassThrough } from "node:stream";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(serverRoot, "bin", "ai-dev.mjs");
const INITIALIZE = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`;

/**
 * Every place a client keeps its config, inside `home`: on Windows VS Code's
 * and Claude Desktop's live under APPDATA and LOCALAPPDATA, not under HOME,
 * and a test that left them alone wrote to the developer's own files
 * (docs/DEFECTS.md, Д-170).
 */
function homeEnv(home, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: "",
    CLAUDE_CONFIG_DIR: "",
    AI_DEV_HOME: "",
    ...extra
  };
}

async function tempDir(t, prefix = "ai-dev-cli-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Run a script with node; resolve with its exit code and output. */
function runNode(args, { env = {}, input = "", untilLine = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (untilLine && untilLine.test(stdout)) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test("help, version and wrong usage answer with exit codes 0 and 2", async () => {
  const help = await runNode([cli, "help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^ai-dev \S+ — a local MCP server/);
  for (const name of ["setup", "clients", "model", "mcp", "doctor"]) assert.match(help.stdout, new RegExp(`\\n  ${name} `));
  const version = await runNode([cli, "--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^ai-dev \d+\.\d+\.\d+ \(Node \d+/);

  const cases = [
    [["statsu"], /There is no command "statsu"\. `ai-dev help` lists them\./],
    [["dcotor"], /Did you mean `ai-dev doctor`\?/],
    [["setup", "--forse"], /`ai-dev setup` has no option --forse\. Did you mean --force\?/],
    [["setup", "--clients=zed"], /`ai-dev setup`: Not a client: zed\./],
    [["setup", "--yes=1"], /--yes is a switch and takes no value/],
    [["clients", "isntall"], /Did you mean `ai-dev clients install`\?/],
    [["clients", "install", "--clients"], /--clients needs a value/],
    [["model", "import"], /needs a folder or a \.zip/],
    [["doctor", "extra"], /takes no argument, and was given "extra" as well/],
    [["help", "nope"], /There is no command "nope"/]
  ];
  for (const [args, said] of cases) {
    const result = await runNode([cli, ...args]);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, said, args.join(" "));
    assert.equal(result.stdout, "", `${args.join(" ")}: nothing on stdout`);
  }
});

test("a mistyped command touches no data: the 2.x runtime folder stays where it is (Д-161)", async (t) => {
  const home = await tempDir(t);
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(runtime, ".ai-dev", "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, ".ai-dev", "state", "instincts.json"), "{}\n");
  for (const args of [[cli, "statsu"], [cli, "setup", "--forse"], [path.join(serverRoot, "scripts", "ai-dev.mjs"), "statsu"]]) {
    const result = await runNode(args, { env: homeEnv(home, { AI_DEV_HOME: runtime }) });
    assert.equal(result.code, 2);
  }
  assert.deepEqual(await fs.readdir(runtime), [".ai-dev"]);
  assert.deepEqual(await fs.readdir(path.join(runtime, ".ai-dev", "state")), ["instincts.json"]);
});

test("`ai-dev mcp`, its synonym `start` and the 2.x `scripts/ai-dev.mjs start` serve MCP with instructions (Д-161)", async (t) => {
  const home = await tempDir(t);
  for (const args of [[cli, "mcp"], [cli, "start"], [path.join(serverRoot, "scripts", "ai-dev.mjs"), "start"], [path.join(serverRoot, "src", "server.mjs")]]) {
    const result = await runNode(args, { env: homeEnv(home), input: INITIALIZE, untilLine: /\n/ });
    const [line] = result.stdout.split("\n");
    const message = JSON.parse(line);
    assert.equal(message.id, 1, args.join(" "));
    assert.ok(message.result.instructions.length > 500, args.join(" "));
    assert.equal(message.result.serverInfo.name, "ai-dev-system");
    if (args[0].endsWith(path.join("scripts", "ai-dev.mjs"))) assert.match(result.stderr, /scripts\/ai-dev\.mjs is `ai-dev` now/);
  }
});

test("clients install, list, doctor and remove through the CLI, in a home with a client of each kind", async (t) => {
  const home = await tempDir(t);
  const original = "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"o\" }\n  }\n}\n";
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), original);
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n");
  const env = homeEnv(home);

  const install = await runNode([cli, "clients", "install", "--json"], { env });
  assert.equal(install.code, 0, install.stderr);
  const installed = JSON.parse(install.stdout).clients;
  assert.deepEqual(installed.filter((result) => result.status !== "skipped").map((result) => [result.client, result.status]), [["cursor", "added"], ["codex", "added"]]);
  assert.ok(installed.filter((result) => result.status === "skipped").every((result) => /^not installed \(no /.test(result.reason)));
  const entry = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.deepEqual(entry, { command: process.execPath, args: [cli, "mcp"] });

  const again = await runNode([cli, "clients", "install"], { env });
  assert.match(again.stdout, /No changes: every client already runs this install\./);

  const list = JSON.parse((await runNode([cli, "clients", "list", "--json"], { env })).stdout).clients;
  assert.deepEqual(list.filter((row) => row.current).map((row) => row.client), ["cursor", "codex"]);

  const doctor = await runNode([cli, "clients", "doctor", "--json"], { env });
  assert.equal(doctor.code, 0, doctor.stdout);
  const checked = JSON.parse(doctor.stdout).clients;
  assert.deepEqual(checked.map((item) => [item.client, item.ok]), [["cursor", true], ["codex", true]]);
  assert.ok(checked.every((item) => item.instructions > 500));

  const remove = await runNode([cli, "clients", "remove"], { env });
  assert.equal(remove.code, 0);
  assert.match(remove.stdout, /Cursor\s+restored/);
  assert.equal(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"), original);
  assert.equal(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8"), "model = \"gpt-5\"\n");
});

test("clients install --docker writes `docker run -i --rm …`, and list, entry and remove know it for what it is", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "docker.exe" : "docker"), "", { mode: 0o755 });
  const env = homeEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const flags = ["--docker", "--image=example/ai-dev:3", `--projects=${path.join(home, "Projects")}`];

  const install = await runNode([cli, "clients", "install", ...flags, "--json"], { env });
  assert.equal(install.code, 0, install.stderr);
  const written = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.equal(written.command, path.join(bin, process.platform === "win32" ? "docker.exe" : "docker"), "the CLI by its full path");
  assert.deepEqual([written.args[0], written.args.at(-1)], ["run", "example/ai-dev:3"]);
  const mounts = written.args.flatMap((argument, index) => (written.args[index - 1] === "--mount" ? [argument] : []));
  const state = path.join(home, ".ai-dev", "state");
  // Shared where the image's user (uid 1000) is this one, or Docker Desktop maps it.
  const shared = process.platform !== "linux" || process.getuid() === 1000;
  assert.equal(mounts.includes(`type=bind,source=${state},target=/ai-dev-state`), shared, mounts.join(" "));
  assert.ok(!written.args.includes("--user"));
  if (!shared) assert.match(JSON.parse(install.stdout).note, /the image's user \(uid 1000\) is not yours/);
  await fs.access(path.join(home, "Projects"));
  await fs.access(path.join(state, "mcp-clients.json"));

  const list = await runNode([cli, "clients", "list"], { env });
  assert.match(list.stdout, /Cursor\s+ai-dev → Docker: example\/ai-dev:3$/m, "a client run in Docker is not pointed back at a local install");

  const entry = await runNode([cli, "clients", "entry", "claude-code", ...flags], { env });
  assert.equal(entry.code, 0, entry.stderr);
  assert.deepEqual(JSON.parse(entry.stdout), { type: "stdio", ...written });
  const many = await runNode([cli, "clients", "entry", "claude", "--docker"], { env });
  assert.equal(many.code, 2);
  assert.match(many.stderr, /"claude" names 2 clients; name one: claude-code, claude-desktop/);
  const stray = await runNode([cli, "clients", "install", "--image=x"], { env });
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /--image is an option of --docker/);

  const remove = await runNode([cli, "clients", "remove", "--clients=cursor"], { env });
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Cursor\s+(restored|removed)/);
});

test("clients doctor names a config whose Node is gone, and exits 1", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: path.join(home, "gone", "node"), args: [cli, "mcp"] } } }));
  const doctor = await runNode([cli, "clients", "doctor"], { env: homeEnv(home) });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /Cursor\s+FAILED — .*gone[\\/]node does not exist/);
  for (const value of ["abc", "0", "-5"]) {
    const wrong = await runNode([cli, "clients", "doctor", `--timeout=${value}`], { env: homeEnv(home) });
    assert.equal(wrong.code, 2, value);
    assert.match(wrong.stderr, /--timeout takes the seconds each command has to answer, a number above 0/);
  }
});

test("setup's flags: --model, its 2.x names --dense and --dense-python, --all, --no-clients and --no-health", () => {
  assert.equal(parseSetupArgs([]).model, undefined, "unset: asked at a terminal, no elsewhere");
  for (const flags of [["--model"], ["--dense"], ["--dense-python"], ["--all"]]) assert.equal(parseSetupArgs(flags).model, true, flags.join(" "));
  assert.equal(parseSetupArgs(["--no-model"]).model, false);
  assert.equal(parseSetupArgs(["--all"]).frontendQa, true);
  assert.equal(parseSetupArgs(["--dense-python"]).densePython, true);
  assert.equal(parseSetupArgs(["--no-clients"]).clients, false);
  assert.equal(parseSetupArgs(["--clients", "cursor,claude"]).clients, "cursor,claude");
  assert.equal(parseSetupArgs(["--no-health"]).health, false);
  assert.equal(parseSetupArgs(["-y"]).yes, true);
});

test("Ctrl-C at a question stops with 130, as Ctrl-C anywhere else does (Д-172)", async () => {
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true, columns: 80, setRawMode() { return this; } });
  const ask = (typed, fallback) => {
    const stdin = terminal();
    const io = createIo({ stdin, stdout: terminal(), stderr: new PassThrough(), interactive: true });
    setTimeout(() => stdin.write(typed), 20);
    return io.ask("Connect ai-dev to Cursor?", fallback);
  };
  await assert.rejects(ask("\u0003", true), (error) => error.exitCode === 130 && error.message === "Stopped with Ctrl-C at a question, before anything was changed.");
  assert.equal(await ask("да\r", false), true);
  assert.equal(await ask("n\r", true), false);
  assert.equal(await ask("\r", true), true, "Enter takes the default");
});

test("`ai-dev backup` and `ai-dev restore` run on every system, and a restore asks for --confirm (Д-104)", async (t) => {
  const home = await tempDir(t);
  const vault = path.join(home, "vault");
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(vault, "01-system"), { recursive: true });
  await fs.writeFile(path.join(vault, "01-system", "Agent Rules.md"), "mine\n");
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "instincts.json"), "{}\n");
  // The state the server keeps under this runtime: the test setup's own AI_DEV_STATE_ROOT is not it.
  const env = homeEnv(home, { AI_DEV_HOME: runtime, AI_DEV_VAULT_ROOT: vault, AI_DEV_STATE_ROOT: "" });

  const made = await runNode([cli, "backup", "before", "--to", path.join(home, "b"), "--json"], { env });
  assert.equal(made.code, 0, made.stderr);
  const backup = JSON.parse(made.stdout);
  assert.equal(backup.status, "created");
  assert.equal(backup.files, 2);
  assert.match(path.basename(backup.archive), /^ai-dev-system_.+_before\.zip$/);

  const unconfirmed = await runNode([cli, "restore", backup.archive, "--to", path.join(home, "r")], { env });
  assert.equal(unconfirmed.code, 2);
  assert.match(unconfirmed.stderr, /add --confirm to go ahead/);
  await assert.rejects(fs.access(path.join(home, "r")));

  const inPlace = await runNode([cli, "restore", backup.archive, "--confirm"], { env });
  assert.equal(inPlace.code, 1, "the files are there: nothing is written over without --overwrite");
  assert.match(inPlace.stderr, /2 file\(s\) would be written over/);

  const restored = await runNode([cli, "restore", backup.archive, "--confirm", "--to", path.join(home, "r"), "--json"], { env });
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).restored, 2);
  assert.equal(await fs.readFile(path.join(home, "r", "vault", "01-system", "Agent Rules.md"), "utf8"), "mine\n");
});

test("`ai-dev uninstall` says what it would do, changes nothing without --yes, and refuses a typo", async (t) => {
  const home = await tempDir(t);
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "instincts.json"), "{}\n");
  const env = homeEnv(home, { AI_DEV_HOME: runtime, AI_DEV_STATE_ROOT: "" });
  const help = await runNode([cli, "help", "uninstall"], { env });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: ai-dev uninstall \[--clients\] \[--data\] \[--yes\] \[--json\]/);
  const dry = await runNode([cli, "uninstall", "--clients", "--data", "--json"], { env });
  assert.equal(dry.code, 0, dry.stderr);
  const said = JSON.parse(dry.stdout);
  assert.equal(said.apply, false);
  assert.equal(said.runtime_home, runtime);
  assert.deepEqual(said.data, { asked: true, removed: false });
  await fs.access(path.join(runtime, "state", "instincts.json"));
  // A runtime home that holds something AI Dev did not make is kept, and the exit status says so (Д-297, Д-302).
  await fs.writeFile(path.join(runtime, "notes.txt"), "mine\n");
  const kept = await runNode([cli, "uninstall", "--data", "--yes"], { env });
  assert.equal(kept.code, 4, kept.stderr);
  assert.match(kept.stdout, /Kept .*rt: .*also holds what AI Dev did not make \(notes\.txt\); delete AI Dev's own folders in it yourself\./);
  await fs.access(path.join(runtime, "notes.txt"));
  await fs.access(path.join(runtime, "state", "instincts.json"));
  const typo = await runNode([cli, "uninstall", "--date"], { env });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /`ai-dev uninstall` has no option --date\. Did you mean --data\?/);
});
