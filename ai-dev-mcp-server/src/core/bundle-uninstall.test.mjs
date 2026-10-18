import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleFingerprint, provisionBundle } from "./app-bundle.mjs";
import { APP_MARKER } from "./app-home.mjs";
import { exitStatus } from "../cli/uninstall.mjs";
import { inspectDataFolder, refuseDataRemoval, runsBundle, uninstallBundle } from "./bundle-uninstall.mjs";

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
  const provisioned = await provisionBundle({ bundleRoot: await writeBundle(path.join(root, "resources", "runtime")), runtimeRoot: runtime, env, home });
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
  // A link an update that stopped half-way left beside `current` (Д-306, п. 7).
  const stale = path.join(staged.runtime, "app", "current.4242.abcdef12.next");
  await fs.symlink(staged.provisioned.folder, stale, "dir");
  const stopped = [];
  const result = await uninstallBundle({ env: staged.env, home: staged.home, clients: true, apply: true, stop: async ({ env }) => { stopped.push(env.AI_DEV_HOME); return noDaemons(); } });
  assert.deepEqual(stopped, [staged.runtime], "the daemons go first: on Windows they hold the copy's files");
  assert.deepEqual(result.copies.removed, [staged.provisioned.folder]);
  assert.deepEqual(result.copies.left, []);
  assert.equal(result.link, "removed");
  assert.deepEqual(result.stale_links, [stale]);
  await assert.rejects(fs.lstat(stale), { code: "ENOENT" });
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
  assert.equal(exitStatus(result), 0);
});

test("--data deletes the runtime home, and only a folder that holds nothing but what AI Dev makes", async (t) => {
  const staged = await stageHome(t);
  // What AI Dev leaves at the top of its home besides its folders: the settings, their lock, a write
  // that stopped, the locks of its moves, what Windows puts in an opened folder, the 2.x tree.
  const own = ["config.json", "config.json.lock", "config.json.lock.break", `.config.json.4242.${crypto.randomUUID()}.tmp`, "codex-migration.lock", ".ai-dev.lock", "desktop.ini", "Thumbs.db"];
  for (const name of own) await fs.writeFile(path.join(staged.runtime, name), "");
  await fs.mkdir(path.join(staged.runtime, ".ai-dev", "state"), { recursive: true });
  for (const name of ["cache", "models", "logs", "run", "vault", "backups", "artifacts", "python"]) await fs.mkdir(path.join(staged.runtime, name));
  const result = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true, JSON.stringify(result.data));
  await assert.rejects(fs.access(staged.runtime), { code: "ENOENT" });
  assert.equal(exitStatus(result), 0);

  const root = await scratch(t);
  assert.match(await refuseDataRemoval(root, { home: path.join(root, "me") }), /holds the home folder/);
  assert.match(await refuseDataRemoval(path.parse(root).root, { home: root }), /root of a drive/);
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  assert.equal(await refuseDataRemoval(empty, { home: path.join(root, "me") }), "");
});

test("--data keeps a folder the person keeps other things in, whole, and says what is not AI Dev's (Д-297)", async (t) => {
  const staged = await stageHome(t);
  // AI_DEV_HOME set to Documents: AI Dev made its folders there beside the person's files.
  const documents = path.join(staged.home, "Documents");
  await fs.mkdir(path.join(documents, "Taxes 2025"), { recursive: true });
  await fs.writeFile(path.join(documents, "Taxes 2025", "return.pdf"), "precious");
  await fs.writeFile(path.join(documents, "thesis.docx"), "precious");
  await fs.mkdir(path.join(documents, "logs"));
  await fs.mkdir(path.join(documents, "state"));
  const env = { ...staged.env, AI_DEV_HOME: documents };
  const result = await uninstallBundle({ env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, false);
  assert.equal(result.data.refused, true);
  assert.match(result.data.reason, /also holds what AI Dev did not make \(Taxes 2025, thesis\.docx\)/);
  for (const kept of ["thesis.docx", "Taxes 2025/return.pdf", "logs", "state"]) await fs.access(path.join(documents, kept));
  assert.equal(exitStatus(result), 4, "the uninstaller says the data was kept");
  // A dry run says the same, and stops no daemon.
  const dry = await uninstallBundle({ env, home: staged.home, data: true, apply: false, stop: async () => assert.fail("a dry run stops no daemon") });
  assert.equal(dry.data.refused, true);
  // Six names and more are counted, not listed.
  for (const name of ["a", "b", "c", "d", "e"]) await fs.writeFile(path.join(documents, name), "");
  assert.match((await inspectDataFolder(documents, { home: staged.home })).reason, /\(Taxes 2025, a, b, c, d, and 2 more\)/);
});

test("--data through a runtime home that is a link deletes the folder it points at, then the link (Д-306, п. 3)", async (t) => {
  const staged = await stageHome(t);
  const real = path.join(staged.root, "elsewhere", "ai-dev-data");
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.rename(staged.runtime, real);
  await fs.symlink(real, staged.runtime, "dir");
  const result = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true, JSON.stringify(result.data));
  assert.equal(result.data.target, real);
  await assert.rejects(fs.access(real), { code: "ENOENT" });
  await assert.rejects(fs.lstat(staged.runtime), { code: "ENOENT" });
  await fs.access(path.dirname(real));
});

test("the exit status: in use before failed before data kept, so Retry is offered whenever it can help", () => {
  const base = { apply: true, daemons: [], clients: [], copies: { removed: [], left: [] }, data: { asked: false, removed: false } };
  assert.equal(exitStatus(base), 0);
  assert.equal(exitStatus({ ...base, copies: { removed: [], left: [{ folder: "x", reason: "in use", busy: true }] } }), 3);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, busy: true, reason: "some of its files are in use" } }), 3);
  assert.equal(exitStatus({ ...base, daemons: [{ pid: 1, stopped: false }] }), 1);
  assert.equal(exitStatus({ ...base, copies: { removed: [], left: [{ folder: "x", reason: "EIO", busy: false }] } }), 1);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true, reason: "…" } }), 4);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true }, daemons: [{ pid: 1, stopped: false }] }), 1);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true }, copies: { removed: [], left: [{ folder: "x", reason: "in use", busy: true }] } }), 3);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, reason: "the link could not be removed" } }), 1);
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

test("a bare word of an entry names no folder, whatever folder the uninstall runs in (Д-298)", async (t) => {
  const root = await scratch(t);
  const appsRoot = path.join(root, ".ai-dev", "app");
  const copy = path.join(appsRoot, "3.0.0-abcdef12");
  await fs.mkdir(copy, { recursive: true });
  await fs.symlink(copy, path.join(appsRoot, "current"), "dir");
  const where = { appsRoot, copies: [copy], platform: process.platform };
  const clone = { command: "/usr/bin/node", args: ["/src/ai-dev-system/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"] };
  const docker = { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/stonebridgeway/ai-dev-system"] };
  const before = process.cwd();
  t.after(() => process.chdir(before));
  for (const folder of [root, path.join(appsRoot, "current"), copy]) {
    process.chdir(folder);
    assert.equal(runsBundle(clone, where), false, `a clone's entry, from ${folder}`);
    assert.equal(runsBundle(docker, where), false, `Docker's entry, from ${folder}`);
    assert.equal(runsBundle({ command: "current/node/node.exe", args: ["mcp"] }, where), false, "a relative path is not taken for the link");
  }
});
