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

test("a command that died is named by its error, not by Node's version, its stack or its code (Д-169)", async () => {
  const stderrs = [
    [[
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '/old/clone/ai-dev-mcp-server/src/server.mjs'",
      "    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "    at node:internal/main/run_main_module:36:49 {",
      "  code: 'MODULE_NOT_FOUND',",
      "  requireStack: []",
      "}",
      "",
      "Node.js v22.22.0",
      ""
    ], "Error: Cannot find module '/old/clone/ai-dev-mcp-server/src/server.mjs'"],
    [[
      "file:///opt/ai-dev/src/server.mjs:3",
      "throw new Error(\"vault missing\");",
      "^",
      "",
      "Error: vault missing",
      "    at file:///opt/ai-dev/src/server.mjs:3:7",
      "  [cause]: Error: ENOENT: no such file or directory, stat '/vault'",
      "",
      "Node.js v24.1.0"
    ], "Error: vault missing"],
    [["Warning: something", "  [errors]: [ AggregateError: two failed ]"], "[errors]: [ AggregateError: two failed ]"],
    [["Traceback (most recent call last):", "  File \"x.py\", line 1, in <module>", "ModuleNotFoundError: No module named 'mcp'"], "ModuleNotFoundError: No module named 'mcp'"],
    [["docker: Error response from daemon: pull access denied for ai-dev.", "See 'docker run --help'."], "docker: Error response from daemon: pull access denied for ai-dev."],
    [["ai-dev: the vault folder /v does not exist.", "Set AI_DEV_VAULT_ROOT to it."], "Set AI_DEV_VAULT_ROOT to it."],
    [["", "Node.js v22.22.0", ""], ""]
  ];
  for (const [lines, said] of stderrs) {
    const result = await checkServerCommand({ command: "node", args: [] }, {
      spawnProcess: fakeSpawn((child) => {
        child.stderr.write(lines.join("\r\n"));
        setImmediate(() => child.emit("close", 1, null));
      })
    });
    assert.equal(result.error, `it exited with code 1 before answering${said ? `: ${said}` : ""}`, lines.join("\n"));
  }
  const moved = await checkServerCommand({ command: process.execPath, args: ["/old/clone/ai-dev-mcp-server/src/server.mjs"] });
  assert.equal(moved.ok, false);
  assert.match(moved.error, /^it exited with code 1 before answering: Error: Cannot find module '\/old\/clone\/ai-dev-mcp-server\/src\/server\.mjs'/);
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
