import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { checkServerCommand } from "./mcp-client-check.mjs";

/** A child process that answers its first line on stdin with `reply`. */
function fakeSpawn(reply, { calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit("close", null, "SIGTERM");
    };
    child.stdin.once("data", (chunk) => setImmediate(() => reply(child, JSON.parse(String(chunk)))));
    return child;
  };
}

test("an answer with instructions passes, with the server's name and the time it took", async () => {
  const calls = [];
  const result = await checkServerCommand(
    { command: "/usr/bin/node", args: ["/opt/ai-dev/bin/ai-dev.mjs", "mcp"], env: { AI_DEV_VAULT_ROOT: "/v" } },
    {
      env: { PATH: "/bin" },
      spawnProcess: fakeSpawn((child, request) => {
        assert.equal(request.method, "initialize");
        child.stdout.write("\n");
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n`);
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "ai-dev-system", version: "3.0.0" }, instructions: "x".repeat(900) } }).slice(0, 40));
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "ai-dev-system", version: "3.0.0" }, instructions: "x".repeat(900) } }).slice(40)}\n`);
      }, { calls })
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.server, { name: "ai-dev-system", version: "3.0.0" });
  assert.equal(result.instructions, 900);
  assert.ok(result.ms >= 0);
  assert.deepEqual(calls[0].options.env, { PATH: "/bin", AI_DEV_VAULT_ROOT: "/v" }, "the entry's env on top of the environment");
  assert.equal(calls[0].options.shell, false);
});

test("each way a client would see a red dot is named", async () => {
  const cases = [
    [(child) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x" } })}\n`), /answered initialize without instructions/],
    [(child) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } })}\n`), /refused initialize: bad/],
    [(child) => child.stdout.write("Starting server v1...\n"), /printed something other than MCP on stdout, which clients cannot read: Starting server/],
    [(child) => {
      child.stderr.write("Error: Cannot find module '/old/clone/src/server.mjs'\n");
      child.emit("close", 1, null);
    }, /exited with code 1 before answering: Error: Cannot find module/]
  ];
  for (const [reply, said] of cases) {
    const result = await checkServerCommand({ command: "node", args: [] }, { spawnProcess: fakeSpawn(reply) });
    assert.equal(result.ok, false);
    assert.match(result.error, said);
  }
});

test("a command that does not exist, an empty one, and one that never answers", async () => {
  const missing = await checkServerCommand({ command: "/nonexistent/node-that-is-not-there", args: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /\/nonexistent\/node-that-is-not-there does not exist/);
  assert.match((await checkServerCommand({ args: [] })).error, /names no command/);
  const silent = await checkServerCommand({ command: "node", args: [] }, { timeoutMs: 50, spawnProcess: fakeSpawn(() => undefined) });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /no answer to initialize within 0 s/);
  const thrown = await checkServerCommand({ command: "node" }, { spawnProcess: () => { throw new Error("EACCES"); } });
  assert.match(thrown.error, /node could not be started: EACCES/);
});
