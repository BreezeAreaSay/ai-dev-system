import assert from "node:assert/strict";
import test from "node:test";
import { DaemonLink } from "../../src/main/daemon-link.mjs";

// The link against a stand-in for the server: a daemon that answers
// system_status as told, can go away, and can come back.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeServer() {
  const calls = [];
  const clients = [];
  const server = {
    down: false,
    retired: null,
    quick: { status: "ok", index: { exists: true, fresh: true, documents: 5 }, served_by: { pid: 11 } },
    checked: { status: "failed", index: { exists: true, fresh: true, documents: 5 }, served_by: { pid: 11 }, checks: [{ name: "skill_registry", status: "fail", critical: true }] },
    async openControlClient() {
      if (server.down) throw Object.assign(new Error("not running"), { code: "ENOTRUNNING" });
      const client = {
        onclose: null,
        closed: false,
        async callTool({ name, arguments: args }) {
          calls.push({ name, args });
          if (name === "system_status") {
            const answer = args?.checks === false ? server.quick : server.checked;
            // The daemon this session is on retired; a session opened after it is on the new one.
            return { structuredContent: { result: server.retired === client ? { ...answer, served_by: { pid: 11, retired: true } } : answer } };
          }
          return { structuredContent: { result: { done: name } } };
        },
        async close() {
          client.closed = true;
        }
      };
      clients.push(client);
      return { client, transport: {} };
    },
    async stopDaemons() {
      server.down = true;
      clients.at(-1)?.onclose?.();
      return { daemons: [{ pid: 11 }] };
    },
    async daemonLogTail() {
      return ["daemon: listening", "daemon: killed"];
    }
  };
  return { server, calls, clients };
}

function link(t, server, timing = {}) {
  const made = new DaemonLink({ env: {}, t: (key) => key, timing: { statusEveryMs: 15, checksEveryMs: 60_000, retryEveryMs: 15, ...timing } });
  made.attach({ server, execPath: "/node" });
  t.after(() => made.close());
  return made;
}

const checksCalls = (calls) => calls.filter((call) => call.name === "system_status" && call.args?.checks !== false).length;

test("the tray's verdict is the health checks' answer, and the quick poll does not overwrite it (Д-240)", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  assert.equal(daemon.state.phase, "online");
  assert.equal(daemon.status.status, "failed", "the checks' verdict, not the quick ok");
  await sleep(60);
  assert.equal(daemon.status.status, "failed");
  assert.equal(checksCalls(calls), 1, "the quick state did not move: no new checks");
  // The quick state moves: the checks run again and their verdict is the tray's.
  server.quick = { ...server.quick, index: { ...server.quick.index, documents: 9 } };
  server.checked = { ...server.checked, status: "degraded", index: { ...server.checked.index, documents: 9 } };
  await sleep(60);
  assert.equal(daemon.status.status, "degraded");
  assert.ok(checksCalls(calls) >= 2);
});

test("every system_status answer the window gets is the tray's, and a change runs the checks again", async (t) => {
  const { server, calls } = fakeServer();
  const daemon = link(t, server, { statusEveryMs: 60_000 });
  await daemon.connect({ start: true });
  const seen = [];
  daemon.on("status", (status) => seen.push(status?.status));
  server.checked = { ...server.checked, status: "ok" };
  assert.equal((await daemon.call("system_status", { checks: true }, { id: "call-1" })).ok, true);
  assert.deepEqual(seen, ["ok"], "the window's answer reached the tray");
  const before = checksCalls(calls);
  await daemon.call("setup_run", {}, { id: "call-2" });
  await sleep(20);
  assert.equal(checksCalls(calls), before + 1, "after a change, the checks again");
  await daemon.call("clients_list", {}, { id: "call-3" });
  await sleep(20);
  assert.equal(checksCalls(calls), before + 1, "not after a read");
});

test("a retired daemon is left for the daemon of the new code (Д-245)", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  const phases = [];
  daemon.on("state", (state) => phases.push(state.phase));
  server.retired = clients[0];
  server.quick = { ...server.quick, served_by: { pid: 12 } };
  server.checked = { ...server.checked, served_by: { pid: 12 } };
  await sleep(80);
  assert.equal(clients.length, 2, "a second session was opened");
  assert.equal(clients[0].closed, true, "and the first one closed, so the old daemon can finish");
  assert.equal(daemon.state.phase, "online");
  assert.ok(phases.includes("reconnecting") && !phases.includes("offline"), JSON.stringify(phases));
});

test("a daemon that goes away unasked: offline with its log; back when a client starts it again (Д-243)", async (t) => {
  const { server, clients } = fakeServer();
  const daemon = link(t, server);
  await daemon.connect({ start: true });
  server.down = true;
  clients[0].onclose();
  assert.equal(daemon.state.phase, "offline");
  assert.equal(daemon.state.error, "link.lost");
  await sleep(10);
  assert.deepEqual(daemon.state.log, ["daemon: listening", "daemon: killed"]);
  assert.equal(daemon.status, null);
  await sleep(50);
  assert.equal(daemon.state.phase, "offline", "nothing to come back to yet");
  server.down = false;
  await sleep(60);
  assert.equal(daemon.state.phase, "online", "a client started it: the app is back");
  assert.equal(clients.length, 2);
});

test("Stop from the tray: offline without an error; a call in flight ends with the link's words", async (t) => {
  const { server } = fakeServer();
  const daemon = link(t, server, { retryEveryMs: 60_000 });
  await daemon.connect({ start: true });
  assert.equal((await daemon.stopDaemon()).daemons.length, 1);
  assert.deepEqual([daemon.state.phase, daemon.state.error], ["offline", ""]);
  assert.deepEqual(await daemon.call("system_status", {}, { id: "call-9" }), { ok: false, error: "link.notConnected", cancelled: false });
});

test("without a Node there is nothing to connect to, and the state says why", async (t) => {
  const made = new DaemonLink({ env: {}, t: (key) => key });
  t.after(() => made.close());
  made.attach({ server: fakeServer().server, execPath: null, noNode: "No Node.js 22.16 or newer was found." });
  assert.deepEqual(made.state, { phase: "no-node", error: "No Node.js 22.16 or newer was found." });
  assert.deepEqual(await made.connect({ start: true }), made.state);
  made.fail({ error: "broken", hint: "fix it", restart: false });
  assert.deepEqual(made.state, { phase: "broken", error: "broken", hint: "fix it", restart: false });
});
