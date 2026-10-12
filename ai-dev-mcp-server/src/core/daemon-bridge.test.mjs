import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { StdioBridge, lineReader, socketUpstream } from "./daemon-bridge.mjs";

/** An upstream that answers every request with `{ echo: method }`, and can be made to die. */
function fakeUpstream(name, { answer = true } = {}) {
  const upstream = {
    name,
    sent: [],
    closed: false,
    onMessage: null,
    onClose: null,
    start(onMessage, onClose) {
      upstream.onMessage = onMessage;
      upstream.onClose = onClose;
    },
    send(message) {
      upstream.sent.push(message);
      if (answer && message.id !== undefined && message.method) {
        setImmediate(() => upstream.onMessage?.({ jsonrpc: "2.0", id: message.id, result: { echo: message.method, by: name } }));
      }
      return Promise.resolve();
    },
    close() {
      upstream.closed = true;
    },
    die(reason = "killed") {
      upstream.onClose?.(reason);
    }
  };
  return upstream;
}

/** A bridge over in-memory streams; `lines()` is what the client has read so far. */
function bridgeOver(first, connect) {
  const input = new PassThrough();
  const output = new PassThrough();
  const notes = [];
  let read = "";
  output.on("data", (chunk) => {
    read += chunk;
  });
  const bridge = new StdioBridge({ input, output, note: (line) => notes.push(line), connect });
  const done = bridge.run(first);
  return {
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    lines: () => read.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    notes,
    done,
    end: () => input.end()
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("lines are read whole however they are cut, CRLF and blank lines included", () => {
  const messages = [];
  const invalid = [];
  const read = lineReader((message) => messages.push(message), (line) => invalid.push(line));
  read('{"a":');
  read("1}\r\n\n{\"b\":2}\nnot json\n{\"c\"");
  read(":3}\n");
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(invalid, ["not json"]);
});

test("MCP passes through both ways, the handshake included", async () => {
  const upstream = fakeUpstream("daemon-1");
  const client = bridgeOver(upstream, async () => assert.fail("no reconnect expected"));
  client.send(INITIALIZE);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await settle();
  upstream.onMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
  await settle();
  assert.deepEqual(upstream.sent.map((message) => message.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(client.lines().map((message) => message.result?.echo ?? message.method), ["initialize", "tools/list", "notifications/message"]);
  client.end();
  await client.done;
  assert.equal(upstream.closed, true, "the client's end closes the daemon connection");
});

test("a daemon that dies answers its open requests with an error, and the next request goes to a new one, introduced first", async () => {
  const first = fakeUpstream("daemon-1", { answer: false });
  const second = fakeUpstream("daemon-2");
  const connects = [];
  const client = bridgeOver(first, async (context) => {
    connects.push(context);
    return second;
  });
  client.send(INITIALIZE);
  await settle();
  first.onMessage({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ai-dev-system" } } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rebuild_search_index" } });
  await settle();
  first.die("the daemon (pid 1) closed the connection");
  await settle();
  const failed = client.lines().find((message) => message.id === 2);
  assert.equal(failed.error.code, -32603);
  assert.match(failed.error.message, /went away while tools\/call ran \(the daemon \(pid 1\) closed the connection\)\. The next request starts a new one/);
  assert.equal(connects.length, 0, "nothing reconnects until the client asks for something");

  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_all" } });
  await settle();
  await settle();
  assert.deepEqual(connects, [{ reconnect: true }]);
  // Introduced as the first daemon was, under the bridge's own id; then the request.
  assert.equal(second.sent[0].method, "initialize");
  assert.match(String(second.sent[0].id), /^ai-dev-bridge-/);
  assert.deepEqual(second.sent[0].params, INITIALIZE.params);
  assert.equal(second.sent[1].method, "notifications/initialized");
  assert.equal(second.sent[2].id, 3);
  const lines = client.lines();
  assert.ok(!lines.some((message) => String(message.id).startsWith("ai-dev-bridge-")), "the replayed answer is the bridge's, not the client's");
  assert.deepEqual(lines.find((message) => message.id === 3).result, { echo: "tools/call", by: "daemon-2" });
  assert.ok(client.notes.some((note) => /lost the daemon/.test(note)));
  client.end();
  await client.done;
});

test("a server lost again while it is being introduced is replaced again", async () => {
  const first = fakeUpstream("daemon-1");
  const dying = fakeUpstream("daemon-2", { answer: false });
  const third = fakeUpstream("daemon-3");
  const queue = [dying, third];
  const client = bridgeOver(first, async () => queue.shift());
  client.send(INITIALIZE);
  await settle();
  first.die();
  client.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await settle();
  dying.die("died during the introduction");
  await settle();
  await settle();
  assert.deepEqual(client.lines().find((message) => message.id === 2).result, { echo: "ping", by: "daemon-3" });
  assert.equal(third.sent[0].method, "initialize");
  client.end();
  await client.done;
});

test("a request that came before the first initialize was forwarded is not answered twice", async () => {
  const first = fakeUpstream("daemon-1");
  const second = fakeUpstream("daemon-2");
  const client = bridgeOver(first, async () => second);
  first.die("gone before the client said anything");
  client.send(INITIALIZE);
  await settle();
  await settle();
  assert.deepEqual(second.sent.map((message) => message.id), [1], "the client's own initialize, not a replay of it as well");
  assert.equal(client.lines().filter((message) => message.id === 1).length, 1);
  client.end();
  await client.done;
});

test("a socket upstream reads what came with the handshake first, then the socket, and says when it closes", async (t) => {
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\ai-dev-bridge-test-${process.pid}`
    : path.join(await fs.mkdtemp(path.join(os.tmpdir(), "db-")), "s.sock");
  let far;
  const server = net.createServer((socket) => {
    far = socket;
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const socket = net.connect(address);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.pause();
  const upstream = socketUpstream({ socket, rest: Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'), describe: "the daemon (pid 9)" });
  const messages = [];
  const closed = new Promise((resolve) => upstream.start((message) => messages.push(message), resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const received = new Promise((resolve) => far.once("data", resolve));
  await upstream.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(String(await received), '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  far.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(messages.map((message) => message.id), [0, 1]);
  far.destroy();
  assert.equal(await closed, "the daemon (pid 9) closed the connection");
  await assert.rejects(upstream.send({ jsonrpc: "2.0", method: "x" }), /closed/);
});
