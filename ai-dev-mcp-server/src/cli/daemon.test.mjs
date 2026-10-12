import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The daemon as a client meets it: `ai-dev mcp`, the command every client
// config runs, with nothing but the environment the client gives it
// (docs/DEFECTS.md, Д-97). Real processes: the bridges, the daemon they start.

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
    // Whatever happens to this test, the daemon leaves within a minute.
    AI_DEV_IDLE_TIMEOUT_MS: "60000"
  };
  const run = path.join(home, ".ai-dev", "run");
  t.after(async () => {
    await ai(env, ["daemon", "stop"]).catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, vault, env, run };
}

/** `ai-dev <args>`: exit code and output. */
function ai(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: serverRoot, env, windowsHide: true });
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
async function client(t, env, name = "test") {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: serverRoot, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const session = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await session.connect(transport);
  t.after(() => session.close().catch(() => undefined));
  return { session, transport, stderr: () => stderr };
}

const daemonInfo = (run) => JSON.parse(readFileSync(path.join(run, "daemon.json"), "utf8"));
const text = (result) => result.content.find((item) => item.type === "text")?.text ?? "";

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
  const info = await until(() => existsSync(path.join(run, "daemon.json")) && daemonInfo(run).sessions === 3 && daemonInfo(run), "three sessions in daemon.json");
  assert.match(info.address, process.platform === "win32" ? /^\\\\\.\\pipe\\ai-dev-[0-9a-f]{24}$/ : /ai-dev-[0-9a-f]{24}\.sock$/);
  if (process.platform !== "win32") {
    assert.ok(Buffer.byteLength(info.address) <= 100, info.address);
    assert.equal((await fs.stat(path.join(run, "daemon.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(info.address))).mode & 0o777, 0o700);
  }
  assert.match(clients[0].stderr(), /started the daemon \(pid \d+\)/);

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
  assert.equal(reported.secret, undefined, "status never prints the secret");

  const stopped = await ai(env, ["daemon", "stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`Stopped: pid ${info.pid}, 3 session\\(s\\) ended with it\\.`));
  assert.equal(existsSync(path.join(run, "daemon.json")), false);
  // A client whose daemon was stopped is served by a new one at its next request.
  const answer = await clients[1].session.callTool({ name: "search_index_status", arguments: {} });
  assert.equal(answer.isError, false);
  assert.notEqual(daemonInfo(run).pid, info.pid);
});

test("kill -9 of the daemon: the next request starts a new one and the session goes on", async (t) => {
  const { env, run } = await stage(t);
  const { session, stderr } = await client(t, env);
  const first = await until(() => existsSync(path.join(run, "daemon.json")) && daemonInfo(run), "the daemon");
  process.kill(first.pid, "SIGKILL");
  await until(() => {
    try {
      process.kill(first.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the killed daemon to go");
  const found = await session.callTool({ name: "search_all", arguments: { query: "postgres schema", limit: 1 } });
  assert.match(text(found), /Storage/);
  const second = daemonInfo(run);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.sessions, 1);
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
  assert.equal(daemonInfo(run).sessions, 2, "one daemon for both: the profile belongs to the session");

  await ai(env, ["daemon", "stop"]);
  const own = await client(t, { ...env, AI_DEV_DAEMON: "0" });
  assert.ok(own.session.getInstructions().length > 500);
  assert.equal((await own.session.listTools()).tools.length, everything);
  assert.equal(existsSync(path.join(run, "daemon.json")), false, "no daemon was started");
});

test("a client of another build retires the daemon; the retired one keeps its session until that client closes", async (t) => {
  const { env, run, vault } = await stage(t);
  const old = await client(t, env);
  const first = await until(() => existsSync(path.join(run, "daemon.json")) && daemonInfo(run), "the first daemon");
  // Another AI_DEV_VAULT_ROOT is another build: its daemon must not serve the first client's vault.
  const otherVault = `${vault}-other`;
  await fs.cp(vault, otherVault, { recursive: true });
  const fresh = await client(t, { ...env, AI_DEV_VAULT_ROOT: otherVault });
  const second = daemonInfo(run);
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.build, first.build);
  assert.match(fresh.stderr(), new RegExp(`the one of another build \\(pid ${first.pid}\\) steps aside`));
  // The first client is still served — by the retired daemon, which nobody else can reach now.
  const answer = await old.session.callTool({ name: "search_index_status", arguments: {} });
  assert.equal(answer.isError, false);
  await old.session.close();
  await until(() => {
    try {
      process.kill(first.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the retired daemon to leave after its last session");
});

test("when no daemon can start, the client is served in its own process and stderr says why", async (t) => {
  const { env, run } = await stage(t);
  // The runtime's run/ is a file: no lock, no descriptor, no daemon.
  await fs.mkdir(path.dirname(run), { recursive: true });
  await fs.writeFile(run, "not a directory");
  const { session, stderr } = await client(t, { ...env, AI_DEV_DAEMON_START_TIMEOUT_MS: "5000" });
  assert.ok(session.getInstructions().length > 500);
  assert.match(stderr(), /no daemon can serve this client \(.*\); serving it in this process instead\./s);
  const found = await session.callTool({ name: "search_all", arguments: { query: "postgres", limit: 1 } });
  assert.match(text(found), /Storage/);
});
