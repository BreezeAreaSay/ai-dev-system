import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleFingerprint, provisionBundle } from "./app-bundle.mjs";
import { APP_MARKER } from "./app-home.mjs";
import { refuseDataRemoval, runsBundle, uninstallBundle } from "./bundle-uninstall.mjs";

const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-uninstall-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeBundle(root) {
  const files = {
    "distribution.json": "{}",
    "ai-dev-mcp-server/bin/ai-dev.mjs": "// cli\n",
    "node/node.exe": "node"
  };
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  await fs.writeFile(path.join(root, "bundle.json"), JSON.stringify({
    schema_version: 1, version: "3.0.0", node: { version: "24.22.0", file: "node/node.exe" }, fingerprint: bundleFingerprint(entries), files: entries
  }));
  return root;
}

/** A home with the Windows install provisioned, an npx copy beside it, and two clients: one runs the install, one a clone. */
async function stageHome(t) {
  const root = await scratch(t);
  const home = path.join(root, "home");
  const runtime = path.join(home, ".ai-dev");
  const env = { HOME: home, USERPROFILE: home, AI_DEV_HOME: runtime, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData", "Roaming") };
  const provisioned = await provisionBundle({ bundleRoot: await writeBundle(path.join(root, "resources", "runtime")), runtimeRoot: runtime });
  const npx = path.join(runtime, "app", "3.0.0-0badcafe");
  await fs.mkdir(npx, { recursive: true });
  await fs.writeFile(path.join(npx, APP_MARKER), JSON.stringify({ schema_version: 1, content_fingerprint: "0badcafe", chosen_at: new Date().toISOString() }));
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "decisions.json"), "[]");
  const claude = path.join(home, ".claude.json");
  await fs.writeFile(claude, JSON.stringify({
    mcpServers: {
      "ai-dev": { type: "stdio", command: provisioned.node, args: [provisioned.cli, "mcp"] },
      other: { command: "other-server" }
    }
  }, null, 2));
  const cursor = path.join(home, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(cursor), { recursive: true });
  const cloneEntry = { command: "/usr/bin/node", args: ["/src/ai-dev-system/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"] };
  await fs.writeFile(cursor, JSON.stringify({ mcpServers: { "ai-dev": cloneEntry } }, null, 2));
  return { root, home, runtime, env, provisioned, npx, claude, cursor, cloneEntry };
}

const noDaemons = async () => ({ daemons: [] });

test("without --yes the uninstaller only says what it would take out", async (t) => {
  const staged = await stageHome(t);
  const before = await fs.readFile(staged.claude, "utf8");
  const result = await uninstallBundle({ env: staged.env, home: staged.home, clients: true, apply: false, stop: async () => assert.fail("a dry run stops no daemon") });
  assert.deepEqual(result.copies.removed, [staged.provisioned.folder]);
  assert.equal(result.link, "would-remove");
  assert.deepEqual(result.clients.map((client) => [client.client, client.status]), [["claude-code", "would-remove"]]);
  assert.equal(await fs.readFile(staged.claude, "utf8"), before);
  await fs.access(staged.provisioned.folder);
  await fs.access(staged.provisioned.current);
});

test("the uninstaller takes out what the Windows install made, and nothing of any other install", async (t) => {
  const staged = await stageHome(t);
  const stopped = [];
  const result = await uninstallBundle({ env: staged.env, home: staged.home, clients: true, apply: true, stop: async ({ env }) => { stopped.push(env.AI_DEV_HOME); return noDaemons(); } });
  assert.deepEqual(stopped, [staged.runtime], "the daemons go first: on Windows they hold the copy's files");
  assert.deepEqual(result.copies.removed, [staged.provisioned.folder]);
  assert.deepEqual(result.copies.left, []);
  assert.equal(result.link, "removed");
  await assert.rejects(fs.lstat(staged.provisioned.current), { code: "ENOENT" });
  await assert.rejects(fs.access(staged.provisioned.folder), { code: "ENOENT" });
  await fs.access(staged.npx);
  const claude = JSON.parse(await fs.readFile(staged.claude, "utf8"));
  assert.equal(claude.mcpServers["ai-dev"], undefined, "the entry that ran the install is gone");
  assert.deepEqual(claude.mcpServers.other, { command: "other-server" }, "another server in the same file stays");
  const cursor = JSON.parse(await fs.readFile(staged.cursor, "utf8"));
  assert.deepEqual(cursor.mcpServers["ai-dev"], staged.cloneEntry, "a clone's entry is not the install's to take");
  // The person's data stays unless asked.
  await fs.access(path.join(staged.runtime, "state", "decisions.json"));
  assert.deepEqual(result.data, { asked: false, removed: false });
});

test("--data deletes the runtime home, and only a folder that is plainly one", async (t) => {
  const staged = await stageHome(t);
  const result = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true);
  await assert.rejects(fs.access(staged.runtime), { code: "ENOENT" });

  const root = await scratch(t);
  assert.match(await refuseDataRemoval(root, { home: path.join(root, "me") }), /holds the home folder/);
  assert.match(await refuseDataRemoval(path.parse(root).root, { home: root }), /root of a drive/);
  const photos = path.join(root, "photos");
  await fs.mkdir(photos);
  await fs.writeFile(path.join(photos, "cat.jpg"), "");
  assert.match(await refuseDataRemoval(photos, { home: path.join(root, "me") }), /does not look like an AI Dev runtime home/);
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  assert.equal(await refuseDataRemoval(empty, { home: path.join(root, "me") }), "");

  const wrong = await stageHome(t);
  wrong.env.AI_DEV_HOME = photos;
  const refused = await uninstallBundle({ env: wrong.env, home: wrong.home, data: true, apply: true, stop: noDaemons });
  assert.equal(refused.data.removed, false);
  assert.match(refused.data.reason, /does not look like an AI Dev runtime home/);
  await fs.access(path.join(photos, "cat.jpg"));
});

test("an entry runs the install when its command or an argument lies under the link or in one of its copies", () => {
  const appsRoot = path.resolve("/home/me/.ai-dev/app");
  const copies = [path.join(appsRoot, "3.0.0-abcdef12")];
  const where = { appsRoot, copies, platform: "linux" };
  assert.equal(runsBundle({ command: path.join(appsRoot, "current", "node", "node.exe"), args: [] }, where), true);
  assert.equal(runsBundle({ command: "node", args: [path.join(copies[0], "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "mcp"] }, where), true);
  assert.equal(runsBundle({ command: "node", args: [path.join(appsRoot, "3.0.0-0badcafe", "ai-dev-mcp-server", "bin", "ai-dev.mjs")] }, where), false, "an npx copy");
  assert.equal(runsBundle({ command: "docker", args: ["run", "-i", "ghcr.io/stonebridgeway/ai-dev-system"] }, where), false);
  assert.equal(runsBundle({ command: path.join(appsRoot, "CURRENT", "node", "node.exe") }, { ...where, platform: "win32" }), true, "Windows reads names without case");
  assert.equal(runsBundle({ command: path.join(appsRoot, "CURRENT", "node", "node.exe") }, where), false);
  assert.equal(runsBundle(undefined, where), false);
  assert.equal(runsBundle({ command: path.join(appsRoot, "..", "app-other", "x") }, where), false);
});
