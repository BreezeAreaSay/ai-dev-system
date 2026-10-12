import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The daemon as a client meets it: `ai-dev mcp`, the command every client
// config runs, with nothing but the environment the client gives it
// (docs/DEFECTS.md, Д-97). Real processes: the bridges, the daemons they start.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(serverRoot, "bin", "ai-dev.mjs");

/**
 * A home whose path is longer than any socket path can be — the case that
 * killed the 2.x daemon — with a small vault of its own.
 */
async function stage(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-daemon-"));
  const home = path.join(base, `home-${"h".repeat(60)}`, "x".repeat(40));
  const vault = path.join(base, "vault");
  await fs.mkdir(path.join(vault, "02-knowledge"), { recursive: true });
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.writeFile(path.join(vault, "02-knowledge", "storage.md"), "# Storage\n\nThe postgres schema keeps every table.\n");
  await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]");
  await fs.mkdir(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_OFFLINE: "1",
    // Whatever happens to this test, the daemons leave within a minute.
    AI_DEV_IDLE_TIMEOUT_MS: "60000"
  };
  const run = path.join(home, ".ai-dev", "run");
  t.after(async () => {
    await ai(env, ["daemon", "stop"]).catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { base, home, vault, env, run };
}

/** `ai-dev <args>`: exit code and output. */
function ai(env, args, { command = cli, cwd = serverRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A client the way a client config starts one. */
async function client(t, env, name = "test", command = cli) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [command, "mcp"], cwd: serverRoot, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const session = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await session.connect(transport);
  t.after(() => session.close().catch(() => undefined));
  return { session, transport, stderr: () => stderr };
}

/** The descriptors in `run`: one per build a daemon serves. */
const descriptors = (run) => (existsSync(run) ? readdirSync(run).filter((name) => /^daemon-[0-9a-f]{16}\.json$/.test(name)) : []);
const daemonInfo = (run, name = descriptors(run)[0]) => JSON.parse(readFileSync(path.join(run, name), "utf8"));
const text = (result) => result.content.find((item) => item.type === "text")?.text ?? "";
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function until(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("three clients share one daemon on a home too long for a socket, which counts them, and ai-dev daemon reports and stops it", async (t) => {
  const { env, run } = await stage(t);
  assert.ok(Buffer.byteLength(env.HOME) > 120, `HOME is ${Buffer.byteLength(env.HOME)} bytes`);
  assert.equal((await ai(env, ["daemon", "status"])).code, 1);

  const clients = [await client(t, env, "first"), await client(t, env, "second"), await client(t, env, "third")];
  for (const { session } of clients) assert.ok(session.getInstructions().length > 500, "the daemon's own initialize answer, instructions and all");
  const info = await until(() => descriptors(run).length === 1 && daemonInfo(run).sessions === 3 && daemonInfo(run), "three sessions in the descriptor");
  assert.match(info.address, process.platform === "win32" ? /^\\\\\.\\pipe\\ai-dev-[0-9a-f]{24}$/ : /ai-dev-[0-9a-f]{24}\.sock$/);
  if (process.platform !== "win32") {
    assert.ok(Buffer.byteLength(info.address) <= 100, info.address);
    assert.equal((await fs.stat(path.join(run, descriptors(run)[0]))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(info.address))).mode & 0o777, 0o700);
  }
  assert.match(clients[0].stderr(), /started the daemon \(pid \d+\)/);
  assert.doesNotMatch(clients[1].stderr() + clients[2].stderr(), /started the daemon/, "only the client that started it says so");

  const writes = 20;
  await Promise.all(clients.map(({ session }, index) => (async () => {
    for (let i = 0; i < writes; i += 1) await session.callTool({ name: "record_usage", arguments: { model: "t", input_tokens: 1, note: `d-${index}-${i}` } });
  })()));
  const ledger = path.join(env.HOME, ".ai-dev", "state", "usage", "events.jsonl");
  assert.equal(readFileSync(ledger, "utf8").split("\n").filter((line) => line.includes("\"d-")).length, clients.length * writes);

  const status = await ai(env, ["daemon", "status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const reported = JSON.parse(status.stdout);
  assert.equal(reported.running, true);
  assert.equal(reported.pid, info.pid);
  assert.equal(reported.sessions, 3);
  assert.deepEqual(reported.clients.map((entry) => entry.name).sort(), ["first", "second", "third"]);
  assert.equal(reported.current, true);
  assert.deepEqual(reported.others, []);
  assert.equal(reported.secret, undefined, "status never prints the secret");

  const stopped = await ai(env, ["daemon", "stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`Stopped: pid ${info.pid}, 3 session\\(s\\) ended with it\\.`));
  assert.deepEqual(descriptors(run), []);
  // A client whose daemon was stopped is served by a new one at its next request.
  const answer = await clients[1].session.callTool({ name: "search_index_status", arguments: {} });
  assert.equal(answer.isError, false);
  assert.notEqual(daemonInfo(run).pid, info.pid);
});

test("kill -9 of the daemon: the next request starts a new one and the session goes on", async (t) => {
  const { env, run } = await stage(t);
  const { session, stderr } = await client(t, env);
  const first = await until(() => descriptors(run).length && daemonInfo(run), "the daemon");
  process.kill(first.pid, "SIGKILL");
  await until(() => gone(first.pid), "the killed daemon to go");
  const found = await session.callTool({ name: "search_all", arguments: { query: "postgres schema", limit: 1 } });
  assert.match(text(found), /Storage/);
  const second = await until(() => daemonInfo(run).sessions === 1 && daemonInfo(run), "the new daemon's session in its descriptor");
  assert.notEqual(second.pid, first.pid);
  const tools = await session.listTools();
  assert.equal(tools.tools.length > 100, true);
  assert.match(stderr(), /lost the daemon .*the next request reconnects/s);
});

test("each session lists the tools of its own AI_DEV_PROFILES, and AI_DEV_DAEMON=0 serves in the client's own process", async (t) => {
  const { env, run } = await stage(t);
  const all = await client(t, env);
  const narrowed = await client(t, { ...env, AI_DEV_PROFILES: "core" });
  const everything = (await all.session.listTools()).tools.length;
  const core = (await narrowed.session.listTools()).tools.length;
  assert.ok(core < everything, `${core} < ${everything}`);
  assert.match(narrowed.stderr(), new RegExp(`capability profiles core — ${core} of ${everything} tools listed`));
  await until(() => descriptors(run).length === 1 && daemonInfo(run).sessions === 2, "one daemon for both: the profile belongs to the session");

  await ai(env, ["daemon", "stop"]);
  const own = await client(t, { ...env, AI_DEV_DAEMON: "0" });
  assert.ok(own.session.getInstructions().length > 500);
  assert.equal((await own.session.listTools()).tools.length, everything);
  assert.deepEqual(descriptors(run), [], "no daemon was started");
});

test("clients with their own PATH share one daemon, and each one's tools find that client's programs (Д-190)", { skip: process.platform === "win32" && "a POSIX shell script stands in for the scanner" }, async (t) => {
  const { base, env, run } = await stage(t);
  // A GUI app's PATH: no gitleaks. A terminal's: the user's own gitleaks.
  const fakebin = path.join(base, "fakebin");
  await fs.mkdir(fakebin);
  await fs.writeFile(path.join(fakebin, "gitleaks"), "#!/bin/sh\necho 8.18.0\n", { mode: 0o755 });
  const minimal = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
  const scanners = async (session) => {
    const result = await session.callTool({ name: "system_health_check", arguments: { include_search_smoke: false, include_embedding_status: false, include_registry: false, include_skill_cards: false, include_projects: false, include_auto_commands: false, include_presets: false } });
    const report = JSON.parse(text(result));
    return (report.checks ?? []).find((check) => check.name === "security_scanners")?.summary ?? "";
  };
  const gui = await client(t, { ...env, PATH: minimal, HTTPS_PROXY: "http://proxy.invalid:3128" }, "gui");
  const terminal = await client(t, { ...env, PATH: `${fakebin}${path.delimiter}${minimal}` }, "terminal");
  await until(() => descriptors(run).length === 1 && daemonInfo(run).sessions === 2, "another PATH, another proxy: the same daemon, two sessions");
  assert.match(await scanners(terminal.session), /installed: .*gitleaks/);
  assert.doesNotMatch(await scanners(gui.session), /gitleaks/, "the GUI app's session does not borrow the terminal's PATH");
  assert.match(await scanners(terminal.session), /gitleaks/, "nor the other way round");
});

test("clients of another vault get a daemon of their own; status shows both and says why; stop stops both (Д-191)", async (t) => {
  const { env, run, vault } = await stage(t);
  const first = await client(t, env, "first");
  const otherVault = `${vault}-other`;
  await fs.cp(vault, otherVault, { recursive: true });
  await fs.writeFile(path.join(otherVault, "02-knowledge", "storage.md"), "# Other storage\n\nThe postgres schema lives elsewhere here.\n");
  // Its own index folder too: one runtime home keeps one index, whichever vault
  // it was built from (docs/DEFECTS.md, Д-195).
  const second = await client(t, { ...env, AI_DEV_VAULT_ROOT: otherVault, AI_DEV_SEARCH_INDEX_DIR: path.join(otherVault, ".index") }, "second");
  const third = await client(t, env, "third");
  await until(() => descriptors(run).length === 2, "two descriptors");
  const [one, two] = descriptors(run).map((name) => daemonInfo(run, name));
  assert.notEqual(one.pid, two.pid);
  // Each is served from its own vault, and the first daemon kept its clients: nobody replaced anyone.
  assert.match(text(await first.session.callTool({ name: "search_all", arguments: { query: "postgres schema", limit: 1 } })), /# Storage|"Storage"/);
  assert.match(text(await second.session.callTool({ name: "search_all", arguments: { query: "postgres schema", limit: 1 } })), /Other storage/);
  assert.match(text(await third.session.callTool({ name: "search_all", arguments: { query: "postgres schema", limit: 1 } })), /# Storage|"Storage"/);
  await until(() => descriptors(run).map((name) => daemonInfo(run, name).sessions).sort().join() === "1,2", "two sessions with one daemon, one with the other");

  const status = await ai(env, ["daemon", "status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Running: pid \d+, ai-dev .*, 2 session\(s\)/);
  assert.match(status.stdout, /Also running: pid \d+, ai-dev [^,]+, 1 session\(s\) — another environment: AI_DEV_VAULT_ROOT, AI_DEV_SEARCH_INDEX_DIR differ\./);
  assert.doesNotMatch(status.stdout, /daemon start/, "no advice that would replace the other clients' daemon");

  const stopped = await ai(env, ["daemon", "stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal((stopped.stdout.match(/^Stopped: pid/gm) ?? []).length, 2, stopped.stdout);
  for (const info of [one, two]) await until(() => gone(info.pid), `pid ${info.pid} to stop`);
});

test("a git pull where the code lies: the next client gets a daemon of the new code, the old one finishes its session and goes", async (t) => {
  const { base, env, run } = await stage(t);
  // A copy of the server, so that its code can change under a running daemon.
  const copy = path.join(base, "server");
  for (const entry of ["bin", "config", "hooks", "models", "src", "package.json", "distribution.allowlist.json"]) {
    if (existsSync(path.join(serverRoot, entry))) await fs.cp(path.join(serverRoot, entry), path.join(copy, entry), { recursive: true, filter: (source) => !source.endsWith(".test.mjs") });
  }
  await fs.symlink(path.join(serverRoot, "node_modules"), path.join(copy, "node_modules"), "junction");
  const copyCli = path.join(copy, "bin", "ai-dev.mjs");
  const old = await client(t, env, "old", copyCli);
  const first = await until(() => descriptors(run).length && daemonInfo(run), "the first daemon");

  await fs.appendFile(path.join(copy, "src", "core", "session-env.mjs"), "\n// pulled\n");
  const fresh = await client(t, env, "new", copyCli);
  const second = await until(() => descriptors(run).length === 1 && daemonInfo(run).pid !== first.pid && daemonInfo(run), "the daemon of the new code alone");
  assert.notEqual(second.build, first.build);
  const retired = path.join(run, `retired-${first.pid}.json`);
  await until(() => existsSync(retired), "the old daemon's retired record");
  const status = JSON.parse((await ai(env, ["daemon", "status", "--json"], { command: copyCli })).stdout);
  assert.equal(status.pid, second.pid);
  assert.deepEqual(status.others.map((daemon) => [daemon.pid, daemon.retired, daemon.sessions]), [[first.pid, true, 1]]);
  // The old daemon still serves the session it had, and the new one the new session.
  assert.equal((await old.session.callTool({ name: "search_index_status", arguments: {} })).isError, false);
  assert.equal((await fresh.session.callTool({ name: "search_index_status", arguments: {} })).isError, false);
  await old.session.close();
  await until(() => gone(first.pid), "the retired daemon to leave after its last session");
  await until(() => !existsSync(retired), "its record to go with it");
});

test("requests piped in and the input closed still get their answers, cold and warm (Д-192)", async (t) => {
  const { env } = await stage(t);
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pipe", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ].map((message) => `${JSON.stringify(message)}\n`).join("");
  const piped = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "mcp"], { cwd: serverRoot, env, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, answers: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) }));
    child.stdin.end(lines);
  });
  for (const run of ["cold", "warm"]) {
    const { code, answers } = await piped();
    assert.equal(code, 0, run);
    assert.deepEqual(answers.map((answer) => answer.id), [1, 2], run);
    assert.ok(answers[1].result.tools.length > 100, run);
  }
});

test("a long-lived daemon sets its own log aside, and goes on writing to the same file (Д-194)", async (t) => {
  const { env, home } = await stage(t);
  const log = path.join(home, ".ai-dev", "logs", "daemon.log");
  await client(t, env, "first");
  await until(() => existsSync(log) && readFileSync(log, "utf8").includes("session 1 opened"), "the first session in the log");
  await fs.appendFile(log, `${"x".repeat(1024 * 1024)}\n`);
  await until(() => existsSync(`${log}.1`), "the log set aside", 15_000);
  await client(t, env, "second");
  await until(() => readFileSync(log, "utf8").includes("session 2 opened"), "the next line in the fresh log");
  assert.ok((await fs.stat(log)).size < 64 * 1024, "the fresh log holds only what came after");
  assert.ok((await fs.stat(`${log}.1`)).size > 1024 * 1024);
  assert.match(readFileSync(`${log}.1`, "utf8"), /session 1 opened/);
});

test("stop with only the descriptor of a daemon long gone says it is not running, and clears it (Д-194)", async (t) => {
  const { env, run } = await stage(t);
  await fs.mkdir(run, { recursive: true });
  const stale = path.join(run, "daemon-0123456789abcdef.json");
  await fs.writeFile(stale, JSON.stringify({ protocol: 1, pid: 4194305, address: "/nowhere.sock", secret: "a".repeat(64), build: "0123456789abcdef" }));
  const status = await ai(env, ["daemon", "status"]);
  assert.equal(status.code, 1);
  assert.match(status.stdout, /^Not running for this install and environment: a client started from here gets a daemon of its own\.$/m);
  assert.match(status.stdout, /^Pid 4194305 is gone and left its descriptor behind; `ai-dev daemon stop` clears it\.$/m);
  assert.doesNotMatch(status.stdout, /\.\./, "one full stop at a time");
  const stopped = await ai(env, ["daemon", "stop"]);
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(stopped.stdout.trim(), "Not running.");
  assert.equal(existsSync(stale), false);
});

test("ai-dev daemon start, status and stop take a relative AI_DEV_HOME as the folder they run in means it (Д-201)", async (t) => {
  const { base, env } = await stage(t);
  const project = path.join(base, "project");
  await fs.mkdir(project);
  const relative = { ...env, AI_DEV_HOME: "rel-home" };
  // Whatever happens below: the same home, named absolutely, from a folder that outlives the stage.
  t.after(() => ai({ ...env, AI_DEV_HOME: path.join(project, "rel-home") }, ["daemon", "stop"]));
  const started = await ai(relative, ["daemon", "start"], { cwd: project });
  assert.equal(started.code, 0, started.stdout + started.stderr);
  assert.match(started.stdout, /^Started: pid \d+\./);
  assert.equal(descriptors(path.join(project, "rel-home", "run")).length, 1, "the runtime home is the project's rel-home");
  assert.equal(existsSync(path.join(serverRoot, "rel-home")), false, "and not one inside the server's own tree");
  const status = await ai(relative, ["daemon", "status"], { cwd: project });
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, /^Running: pid \d+/);
  const stopped = await ai(relative, ["daemon", "stop"], { cwd: project });
  assert.match(stopped.stdout, /^Stopped: pid \d+/);
});

test("when no daemon can start, the client is served in its own process and stderr says why", async (t) => {
  const { env, run } = await stage(t);
  // The runtime's run/ is a file: no lock, no descriptor, no daemon.
  await fs.mkdir(path.dirname(run), { recursive: true });
  await fs.writeFile(run, "not a directory");
  const { session, stderr } = await client(t, { ...env, AI_DEV_DAEMON_START_TIMEOUT_MS: "5000" });
  assert.ok(session.getInstructions().length > 500);
  assert.match(stderr(), /no daemon can serve this client \(The daemon did not start: .*[^.]\); serving it in this process instead\./s);
  const found = await session.callTool({ name: "search_all", arguments: { query: "postgres", limit: 1 } });
  assert.match(text(found), /Storage/);
});
