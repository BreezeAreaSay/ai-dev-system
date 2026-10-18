import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleFingerprint, currentLink, parseBundle, pointCurrent, provisionBundle, stableLaunch } from "./app-bundle.mjs";
import { APP_MARKER, installAppHome } from "./app-home.mjs";

const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-app-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A runtime as the installer ships one: the package, a dependency, a Node, and the bundle.json that lists them. */
async function writeBundle(root, { version = "3.0.0", tag = "a", extra = {} } = {}) {
  const files = {
    "distribution.json": JSON.stringify({ name: "@stonebridgeway/ai-dev-system", version, files: [] }),
    "package.json": JSON.stringify({ name: "@stonebridgeway/ai-dev-system", version }),
    "ai-dev-mcp-server/bin/ai-dev.mjs": `// cli ${tag}\n`,
    "node_modules/zod/index.js": "export {};\n",
    "node/node.exe": `node ${tag}`,
    "ai-dev.cmd": "@echo off\r\n",
    ...extra
  };
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const marker = {
    schema_version: 1,
    name: "@stonebridgeway/ai-dev-system",
    version,
    platform: "win32",
    arch: "x64",
    node: { version: "24.22.0", file: "node/node.exe", sha256: sha(files["node/node.exe"]) },
    fingerprint: bundleFingerprint(entries),
    files: entries
  };
  await fs.writeFile(path.join(root, "bundle.json"), JSON.stringify(marker));
  return { root, marker };
}

const clock = (start = Date.parse("2026-10-18T10:00:00Z")) => {
  let at = start;
  return () => new Date((at += 60_000));
};

test("the shipped runtime is copied into the app home once, file by file, and the stable link points at the copy", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot, marker } = await writeBundle(path.join(root, "resources", "runtime"));
  const now = clock();
  const progress = [];
  const first = await provisionBundle({ bundleRoot, runtimeRoot: runtime, now, onProgress: (step) => progress.push(step) });
  assert.equal(first.status, "installed");
  assert.equal(first.folder, path.join(runtime, "app", `3.0.0-${marker.fingerprint.slice(0, 8)}`));
  assert.equal(first.current, currentLink(runtime));
  assert.equal(first.node, path.join(runtime, "app", "current", "node", "node.exe"), "the config names the link, never the versioned copy");
  assert.equal(first.cli, path.join(runtime, "app", "current", "ai-dev-mcp-server", "bin", "ai-dev.mjs"));
  assert.equal(first.serverRoot, path.join(runtime, "app", "current", "ai-dev-mcp-server"));
  assert.equal(first.moved, true);
  assert.equal(await fs.realpath(first.current), await fs.realpath(first.folder));
  assert.equal(await fs.readFile(first.cli, "utf8"), "// cli a\n", "the CLI is reached through the link");
  assert.equal(await fs.readFile(path.join(first.folder, "node", "node.exe"), "utf8"), "node a");
  const copied = JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8"));
  assert.equal(copied.kind, "bundle");
  assert.equal(copied.content_fingerprint, marker.fingerprint);
  assert.equal(progress.at(-1).progress, progress.at(-1).total, "the progress ends at the whole runtime");
  await fs.access(path.join(first.folder, "bundle.json"));

  const again = await provisionBundle({ bundleRoot, runtimeRoot: runtime, now });
  assert.equal(again.status, "present", "a runtime already copied is not copied again");
  assert.equal(again.moved, false);
  const chosen = JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8"));
  assert.ok(Date.parse(chosen.chosen_at) > Date.parse(copied.chosen_at), "chosen again, so a prune keeps it");
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), ["3.0.0-" + marker.fingerprint.slice(0, 8), "current"].sort(),
    "nothing left behind: no staging folder, no spare link");
});

test("a file that is not what the installer shipped stops the copy, and leaves neither a copy nor a link", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot, marker } = await writeBundle(path.join(root, "runtime"));
  await fs.writeFile(path.join(bundleRoot, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "// changed after the build\n");
  await assert.rejects(provisionBundle({ bundleRoot, runtimeRoot: runtime }), /ai-dev-mcp-server\/bin\/ai-dev\.mjs .* is not the file the installer shipped; run the installer again/);
  const left = await fs.readdir(path.join(runtime, "app")).catch(() => []);
  assert.deepEqual(left, [], `no partial copy and no link: ${left.join(", ")}`);
  assert.equal(marker.files.length, 6);
});

test("an update copies the new runtime beside the old, moves the link, and keeps the old copy for clients still running it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const now = clock();
  const one = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "r1"), { version: "3.0.0", tag: "one" })).root, runtimeRoot: runtime, now });
  const two = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "r2"), { version: "3.0.1", tag: "two" })).root, runtimeRoot: runtime, now });
  assert.equal(two.status, "installed");
  assert.equal(two.moved, true);
  assert.equal(two.current, one.current, "the path clients run did not change");
  assert.equal(await fs.readFile(two.cli, "utf8"), "// cli two\n", "and now runs the new runtime");
  assert.equal(await fs.readFile(path.join(one.folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "utf8"), "// cli one\n",
    "the old copy is untouched: a client started before the update still reads it");
  const three = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "r3"), { version: "3.0.2", tag: "three" })).root, runtimeRoot: runtime, now });
  assert.deepEqual(three.removed, [one.folder], "two copies stay: the current one and the one before it");
  await fs.access(two.folder);
  assert.equal(await fs.readFile(three.cli, "utf8"), "// cli three\n");
});

test("the copy the link names is never pruned, however many npx copies come after it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const now = clock();
  const bundle = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime, now });
  for (const tag of ["b", "c", "d"]) {
    const pkg = path.join(root, `npx-${tag}`);
    const content = `// npx ${tag}\n`;
    await fs.mkdir(path.join(pkg, "ai-dev-mcp-server", "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), content);
    await fs.writeFile(path.join(pkg, "distribution.json"), JSON.stringify({
      name: "@stonebridgeway/ai-dev-system",
      version: "3.0.0",
      content_fingerprint: sha(tag),
      files: [{ path: "ai-dev-mcp-server/bin/ai-dev.mjs", bytes: Buffer.byteLength(content), sha256: sha(content) }]
    }));
    await installAppHome({ packageRoot: pkg, runtimeRoot: runtime, runNpm: async () => undefined, now });
  }
  await fs.access(bundle.folder);
  assert.equal(await fs.realpath(bundle.current), await fs.realpath(bundle.folder));
  const folders = (await fs.readdir(path.join(runtime, "app"))).filter((name) => name !== "current");
  assert.equal(folders.length, 2, `the linked copy and the newest npx copy: ${folders.join(", ")}`);
});

test("on Windows the link is a junction, and the old one goes aside before the new one takes its name", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const made = [];
  // A junction is a Windows link; here the spy records the kind asked for and makes a symbolic link.
  const symlink = async (target, link, type) => {
    made.push({ target, link: path.basename(link).replace(/\.\d+\.[0-9a-f]{8}\./, ".<tag>."), type });
    await fs.symlink(target, link, "dir");
  };
  const now = clock();
  const one = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "r1"), { tag: "one" })).root, runtimeRoot: runtime, now, platform: "win32", symlink });
  const two = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "r2"), { version: "3.0.1", tag: "two" })).root, runtimeRoot: runtime, now, platform: "win32", symlink });
  assert.deepEqual(made.map((entry) => [entry.link, entry.type]), [["current.<tag>.next", "junction"], ["current.<tag>.next", "junction"]]);
  assert.equal(made[1].target, await fs.realpath(two.folder), "the junction names the copy's real path");
  assert.equal(await fs.readFile(two.cli, "utf8"), "// cli two\n");
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).filter((name) => name.startsWith("current")), ["current"], "the old link was removed after the move");
  await fs.access(one.folder);
});

test("links a stopped move left behind are cleared, and a real folder named current is not taken for the link", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const folder = path.join(runtime, "app", "3.0.0-abcdef12");
  await fs.mkdir(folder, { recursive: true });
  await fs.symlink(folder, path.join(runtime, "app", "current.123.0a1b2c3d.next"), "dir");
  await fs.symlink(folder, path.join(runtime, "app", "current.456.0a1b2c3d.old"), "dir");
  assert.equal(await pointCurrent({ runtimeRoot: runtime, folder }), true);
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), ["3.0.0-abcdef12", "current"]);
  assert.equal(await pointCurrent({ runtimeRoot: runtime, folder }), false, "already there: nothing moves");

  const other = path.join(root, "other");
  await fs.mkdir(path.join(other, "app", "current"), { recursive: true });
  await fs.mkdir(path.join(other, "app", "x"), { recursive: true });
  await assert.rejects(pointCurrent({ runtimeRoot: other, folder: path.join(other, "app", "x") }), /is not the link AI Dev keeps there; move it aside/);
  await fs.access(path.join(other, "app", "current"));
});

test("a bundle.json is refused before anything is copied by it when it names a file outside its folder or lies about its files", () => {
  const file = (relative, content = "x") => ({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  const base = [file("distribution.json"), file("ai-dev-mcp-server/bin/ai-dev.mjs"), file("node/node.exe")];
  const marker = (files, extra = {}) => JSON.stringify({ schema_version: 1, version: "3.0.0", node: { file: "node/node.exe" }, fingerprint: bundleFingerprint(files), files, ...extra });
  assert.equal(parseBundle(marker(base), "b.json").version, "3.0.0");
  for (const bad of ["../escape.txt", "/etc/passwd", "C:/Windows/x.dll", "a\\..\\b", "a//b", "./a"]) {
    assert.throws(() => parseBundle(marker([...base, file(bad)]), "b.json"), /a file outside the runtime/, bad);
  }
  assert.throws(() => parseBundle(marker([...base, file("Node/node.exe")]), "b.json"), /listed twice/, "Windows reads names without case");
  assert.throws(() => parseBundle(marker(base, { fingerprint: "0".repeat(64) }), "b.json"), /a fingerprint that is not its files'/);
  assert.throws(() => parseBundle(marker(base, { node: { file: "node/missing.exe" } }), "b.json"), /no Node among its files/);
  assert.throws(() => parseBundle(marker(base.slice(1)), "b.json"), /no distribution\.json/);
  assert.throws(() => parseBundle(marker(base, { schema_version: 2 }), "b.json"), /schema_version 2/);
  assert.throws(() => parseBundle("{", "b.json"), /b\.json is not JSON/);
});

test("the stable launch names the link's Node and CLI, and only for the Windows install", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const provisioned = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime });
  const layout = { kind: "package", bundle: true, root: provisioned.folder, runtimeRoot: runtime };
  assert.deepEqual(stableLaunch(layout), { command: provisioned.node, cli: provisioned.cli });
  assert.deepEqual(stableLaunch({ ...layout, root: path.join(root, "resources", "runtime") }), { command: provisioned.node, cli: provisioned.cli },
    "the installer's own runtime names the link too: it is what the app makes current");
  assert.equal(stableLaunch({ ...layout, bundle: false }), null, "an npx copy or a clone is launched as before");
  assert.equal(stableLaunch({ ...layout, runtimeRoot: path.join(root, "elsewhere") }), null, "no link: the copy is named as any install's is");
  await fs.rm(path.join(provisioned.folder, "bundle.json"));
  assert.equal(stableLaunch(layout), null, "a link to something that is not a runtime is not trusted");
});

test("a drive that cannot hold the link still runs the copy: the paths name the copy, and say why there is no link", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const refuse = async () => { throw Object.assign(new Error("operation not supported on socket, symlink"), { code: "ENOTSUP" }); };
  const provisioned = await provisionBundle({ bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime, symlink: refuse });
  assert.equal(provisioned.status, "installed");
  assert.equal(provisioned.current, "");
  assert.match(provisioned.linkError, /^ENOTSUP: operation not supported/);
  assert.equal(provisioned.node, path.join(provisioned.folder, "node", "node.exe"));
  assert.equal(await fs.readFile(provisioned.cli, "utf8"), "// cli a\n");
  assert.equal(stableLaunch({ kind: "package", bundle: true, root: provisioned.folder, runtimeRoot: runtime }), null, "no link: configs name the copy, as any install's do");
  const other = Object.assign(new Error("disk on fire"), { code: "EIO" });
  await assert.rejects(provisionBundle({ bundleRoot: path.join(root, "runtime"), runtimeRoot: path.join(root, "second"), symlink: async () => { throw other; } }), /disk on fire/,
    "any other failure stops the start: it is not a drive that cannot hold links");
});
