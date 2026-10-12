import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DAEMON_PROTOCOL,
  acceptHandshake,
  behaviourEnvironment,
  clientProof,
  controlRequest,
  daemonBuild,
  newNonce,
  newSecret,
  openChannel,
  readDaemonInfo,
  readLine,
  removeDaemonInfo,
  sameProof,
  serverProof,
  writeDaemonInfo,
  writeLine
} from "./daemon-channel.mjs";
import { randomDaemonName } from "./runtime-paths.mjs";

/** A fresh local address: a short socket path, or a pipe on Windows. */
async function localAddress(t) {
  if (process.platform === "win32") return `\\\\.\\pipe\\${randomDaemonName()}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dc-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "s.sock");
}

/** A listener that runs `handle` for each connection, closed — with its connections — when the test ends. */
async function listen(t, address, handle) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    Promise.resolve(handle(socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return server;
}

const daemonInfo = (address, secret, pid = process.pid) => ({ protocol: DAEMON_PROTOCOL, pid, address, secret });

test("each side's proof is bound to both nonces, and a proof of one side is not the other's", () => {
  const secret = newSecret();
  const [server, client] = [newNonce(), newNonce()];
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.match(server, /^[0-9a-f]{32}$/);
  const proof = clientProof(secret, server, client);
  assert.equal(proof, clientProof(secret, server, client));
  assert.notEqual(proof, clientProof(secret, newNonce(), client), "another daemon nonce, another proof: nothing to replay");
  assert.notEqual(proof, clientProof(newSecret(), server, client));
  assert.notEqual(serverProof(secret, server, client, 7), proof);
  assert.notEqual(serverProof(secret, server, client, 7), serverProof(secret, server, client, 8), "the daemon's pid is in its proof");
  assert.equal(sameProof(proof, proof), true);
  assert.equal(sameProof(proof, proof.slice(1)), false);
  assert.equal(sameProof("", ""), false);
  assert.equal(sameProof(undefined, proof), false);
});

test("a client with the secret is let in, both ways proven, and the MCP bytes after the handshake are not lost", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  let accepted;
  await listen(t, address, async (socket) => {
    accepted = await acceptHandshake(socket, { secret, pid: process.pid, version: "9.9.9", build: "b1", welcome: ({ mode, profiles }) => ({ tools_listed: 3, echo: `${mode}:${profiles}` }) });
    const { message } = await readLine(socket, { buffered: accepted.rest });
    await writeLine(socket, { got: message });
  });
  const channel = await openChannel(daemonInfo(address, secret), { mode: "mcp", profiles: "core" });
  t.after(() => channel.socket.destroy());
  assert.equal(channel.welcome.ok, true);
  assert.equal(channel.welcome.version, "9.9.9");
  assert.equal(channel.welcome.build, "b1");
  assert.equal(channel.welcome.tools_listed, 3);
  assert.equal(channel.welcome.echo, "mcp:core");
  await writeLine(channel.socket, { jsonrpc: "2.0", id: 1, method: "ping" });
  const { message } = await readLine(channel.socket, { buffered: channel.rest });
  assert.deepEqual(message.got, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(accepted.mode, "mcp");
  assert.equal(accepted.profiles, "core");
});

test("a client without the secret is refused before it is served, and learns nothing it can reuse", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  const refused = [];
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b" }).catch((error) => {
    refused.push(error.message);
  }));
  await assert.rejects(openChannel(daemonInfo(address, newSecret())), /refused the connection: Authentication failed/);
  assert.deepEqual(refused, ["Authentication failed: the proof does not match this daemon's secret."]);
});

test("a handshake of another protocol, or none at all, is refused", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  const refused = [];
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b", timeoutMs: 500 }).catch((error) => {
    refused.push(error.message);
  }));
  const raw = async (line) => {
    const socket = net.connect(address);
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.once("connect", resolve));
    const hello = await readLine(socket);
    assert.equal(hello.message.ai_dev_daemon, DAEMON_PROTOCOL);
    if (line !== null) socket.write(line);
    const answer = await readLine(socket, { timeoutMs: 2_000 }).catch((error) => ({ message: { closed: error.message } }));
    socket.destroy();
    return answer.message;
  };
  assert.match((await raw(`${JSON.stringify({ protocol: 99, nonce: newNonce(), proof: "x" })}\n`)).error, /protocol 1, not 99/);
  assert.match((await raw(`${JSON.stringify({ protocol: 1 })}\n`)).error, /no nonce/);
  // An MCP client talking straight to the socket, as a 2.x probe would.
  assert.ok((await raw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)).error);
  assert.match(String((await raw("not json\n")).closed ?? ""), /closed|handshake/);
  await raw(null);
  assert.equal(refused.length, 5);
  assert.ok(refused.some((reason) => /No handshake within 500 ms/.test(reason)), refused.join(" | "));
});

test("something else at the daemon's address cannot pass for it (a stale address taken over)", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  // It speaks the protocol, but does not hold the secret.
  await listen(t, address, (socket) => acceptHandshake(socket, { secret: newSecret(), pid: process.pid, version: "1", build: "b" }).catch(() => undefined));
  await assert.rejects(openChannel(daemonInfo(address, secret)), /refused the connection|cannot prove/);

  const quiet = await localAddress(t);
  await listen(t, quiet, () => undefined);
  await assert.rejects(openChannel(daemonInfo(quiet, secret), { timeoutMs: 300 }), /No handshake within 300 ms/);

  const chatty = await localAddress(t);
  await listen(t, chatty, (socket) => socket.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n`));
  await assert.rejects(openChannel(daemonInfo(chatty, secret)), /not a daemon of this version/);
});

test("the daemon must be the pid daemon.json names", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid + 1, version: "1", build: "b" }));
  await assert.rejects(openChannel(daemonInfo(address, secret)), /is pid \d+, not the pid \d+ daemon\.json names/);
});

test("a control request gets one answer", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  await listen(t, address, async (socket) => {
    const accepted = await acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b" });
    const { message } = await readLine(socket, { buffered: accepted.rest });
    await writeLine(socket, { ok: true, mode: accepted.mode, asked: message.control });
    socket.end();
  });
  assert.deepEqual(await controlRequest(daemonInfo(address, secret), "status"), { ok: true, mode: "control", asked: "status" });
  await assert.rejects(controlRequest({ ...daemonInfo(address, secret), address: `${address}.gone` }, "status"), /Cannot reach the daemon/);
});

test("daemon.json is written whole with mode 0600, read only in this version's form, removed only by its own daemon", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dc-info-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "daemon.json");
  assert.equal(await readDaemonInfo(file), null);
  const info = { ...daemonInfo("/tmp/x.sock", newSecret(), 4242), sessions: 2 };
  await writeDaemonInfo(file, info);
  assert.deepEqual(await readDaemonInfo(file), info);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["daemon.json"], "no temp file left beside it");

  // What a 2.x daemon wrote: no protocol, no secret.
  await fs.writeFile(file, JSON.stringify({ pid: 1, version: "2.0.0", address: "/x/ai-dev.sock", sessions: 0 }));
  assert.equal(await readDaemonInfo(file), null);
  await fs.writeFile(file, "{ torn");
  assert.equal(await readDaemonInfo(file), null);

  await writeDaemonInfo(file, info);
  assert.equal(await removeDaemonInfo(file, 1), false, "another daemon's descriptor stays");
  assert.ok(await readDaemonInfo(file));
  assert.equal(await removeDaemonInfo(file, 4242), true);
  assert.equal(await readDaemonInfo(file), null);
});

test("what a daemon must share with a client: the code, its version, and the variables that change what it does", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dc-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "src", "a.mjs"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "a.test.mjs"), "// a test\n");
  const env = { HOME: "/home/ivan", PATH: "/usr/bin", AI_DEV_VAULT_ROOT: "/v" };
  const build = await daemonBuild({ serverRoot: root, version: "3.0.0", env });
  assert.match(build, /^[0-9a-f]{16}$/);
  assert.equal(await daemonBuild({ serverRoot: root, version: "3.0.0", env }), build);
  assert.equal(await daemonBuild({ serverRoot: root, version: "3.0.0", env: { ...env, PATH: "/elsewhere", AI_DEV_PROFILES: "core", AI_DEV_IDLE_TIMEOUT_MS: "5" } }), build,
    "PATH, the session's profiles and the daemon's own timeout do not make another build");
  assert.notEqual(await daemonBuild({ serverRoot: root, version: "3.0.1", env }), build);
  assert.notEqual(await daemonBuild({ serverRoot: root, version: "3.0.0", env: { ...env, AI_DEV_VAULT_ROOT: "/w" } }), build);
  assert.notEqual(await daemonBuild({ serverRoot: root, version: "3.0.0", env: { ...env, HTTPS_PROXY: "http://proxy:3128" } }), build);
  await fs.writeFile(path.join(root, "src", "a.test.mjs"), "// a longer test file\n");
  assert.equal(await daemonBuild({ serverRoot: root, version: "3.0.0", env }), build, "a test file is not the code a daemon runs");
  await fs.writeFile(path.join(root, "src", "a.mjs"), "export const a = 2; // edited\n");
  assert.notEqual(await daemonBuild({ serverRoot: root, version: "3.0.0", env }), build, "a git pull that changes the code");
  assert.deepEqual(behaviourEnvironment({ B: "1", AI_DEV_HOME: "/h", AI_DEV_DAEMON: "1", BGE_M3_ONNX_DIR: "/m", HOME: "/home/i", no_proxy: "x" }),
    [["AI_DEV_HOME", "/h"], ["BGE_M3_ONNX_DIR", "/m"], ["HOME", "/home/i"], ["no_proxy", "x"]]);
});
