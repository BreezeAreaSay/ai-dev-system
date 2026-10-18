import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { circlePng } from "../../src/main/tray-icon.mjs";
import {
  BUNDLE_SHIM,
  RELEASES,
  builderConfig,
  compositionProblems,
  compositionReport,
  danglingDependencies,
  icoFrom,
  listFiles,
  trimRuntime,
  writeBundleMarker
} from "../../scripts/windows-bundle.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverRoot = path.resolve(desktopRoot, "..", "ai-dev-mcp-server");
const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-windows-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
}

test("the runtime's dependencies lose what win32-x64 never loads, and keep what it does", async (t) => {
  const runtime = folder(t);
  const binaries = "node_modules/onnxruntime-node/bin/napi-v6";
  write(runtime, {
    [`${binaries}/darwin/arm64/onnxruntime_binding.node`]: "mac",
    [`${binaries}/linux/x64/onnxruntime_binding.node`]: "linux",
    [`${binaries}/win32/arm64/onnxruntime_binding.node`]: "arm",
    [`${binaries}/win32/x64/onnxruntime_binding.node`]: "x64",
    "node_modules/onnxruntime-node/package.json": "{}",
    "node_modules/onnxruntime-web/dist/ort.min.js": "web",
    "node_modules/@img/sharp-wasm32/lib/sharp.wasm": "wasm",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": "linux",
    "node_modules/@img/sharp-win32-x64/lib/sharp.node": "win",
    "node_modules/@img/colour/index.js": "colour",
    "node_modules/@emnapi/runtime/index.js": "emnapi",
    "node_modules/tslib/tslib.js": "tslib",
    "node_modules/zod/index.js": "zod"
  });
  fs.mkdirSync(path.join(runtime, "node_modules", ".bin"));
  fs.symlinkSync("../zod/index.js", path.join(runtime, "node_modules", ".bin", "zod"));
  const removed = await trimRuntime(runtime);
  assert.deepEqual(removed.map((item) => item.path).sort(), [
    "node_modules/.bin",
    "node_modules/@emnapi/runtime",
    "node_modules/@img/sharp-linux-x64",
    "node_modules/@img/sharp-wasm32",
    `${binaries}/darwin`,
    `${binaries}/linux`,
    `${binaries}/win32/arm64`,
    "node_modules/onnxruntime-web",
    "node_modules/tslib"
  ].sort());
  assert.ok(removed.every((item) => item.why), "each cut says why");
  const left = (await listFiles(runtime)).map((file) => file.path);
  assert.deepEqual(left, [
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-win32-x64/lib/sharp.node",
    `${binaries}/win32/x64/onnxruntime_binding.node`,
    "node_modules/onnxruntime-node/package.json",
    "node_modules/zod/index.js"
  ]);
  assert.deepEqual(await trimRuntime(runtime), [], "a second pass has nothing to cut");
});

test("a cut that went too far is found: a dependency nothing ships any more", async (t) => {
  const modules = path.join(folder(t), "node_modules");
  write(modules, {
    "sharp/package.json": JSON.stringify({ dependencies: { "@img/colour": "^1", "detect-libc": "^2" } }),
    "@img/colour/package.json": "{}",
    "@huggingface/transformers/package.json": JSON.stringify({ dependencies: { "onnxruntime-web": "1", "onnxruntime-node": "1" } }),
    "onnxruntime-node/package.json": "{}",
    "@huggingface/transformers/node_modules/inner/package.json": "{}",
    "with-nested/package.json": JSON.stringify({ dependencies: { inner: "1" } }),
    "with-nested/node_modules/inner/package.json": "{}"
  });
  assert.deepEqual(await danglingDependencies(modules), [{ package: "sharp", missing: "detect-libc" }],
    "onnxruntime-web is cut on purpose; a nested dependency is found where it is");
});

test("the files of a runtime: sorted, each with its size and sha256, and a link refused", async (t) => {
  const root = folder(t);
  write(root, { "b.txt": "bee", "a/c.txt": "sea" });
  assert.deepEqual(await listFiles(root), [
    { path: "a/c.txt", bytes: 3, sha256: sha("sea") },
    { path: "b.txt", bytes: 3, sha256: sha("bee") }
  ]);
  fs.symlinkSync(path.join(root, "b.txt"), path.join(root, "link.txt"));
  await assert.rejects(listFiles(root), /link\.txt is a link; the runtime ships files only/);
});

test("bundle.json, as the build writes it, is what the server's provisioning reads", async (t) => {
  const runtime = folder(t);
  write(runtime, {
    "distribution.json": "{}",
    "ai-dev-mcp-server/bin/ai-dev.mjs": "// cli\n",
    "node/node.exe": "node",
    "node/LICENSE": "MIT",
    "ai-dev.cmd": BUNDLE_SHIM
  });
  const { bundleFingerprint, parseBundle } = await import(pathToFileURL(path.join(serverRoot, "src", "core", "app-bundle.mjs")).href);
  const marker = await writeBundleMarker({ runtimeDir: runtime, name: "@stonebridgeway/ai-dev-system", version: "3.0.0", node: { version: "24.22.0", sha256: sha("node") }, fingerprintOf: bundleFingerprint });
  const read = parseBundle(fs.readFileSync(path.join(runtime, "bundle.json"), "utf8"), "bundle.json");
  assert.equal(read.fingerprint, marker.fingerprint);
  assert.deepEqual(read.node, { version: "24.22.0", file: "node/node.exe", sha256: sha("node") });
  assert.equal(read.files.some((file) => file.path === "bundle.json"), false, "it does not list itself");
  assert.equal(BUNDLE_SHIM, "@echo off\r\n\"%~dp0node\\node.exe\" \"%~dp0ai-dev-mcp-server\\bin\\ai-dev.mjs\" %*\r\n",
    "the shim names the Node and CLI beside it, quoted for a profile with a space");
});

test("the composition check names what must not ship, what is missing, a Node that is not the pinned one, and a runtime over its budget", () => {
  const file = (relative, bytes = 1, content = relative) => ({ path: relative, bytes, sha256: sha(content) });
  const complete = [
    "distribution.json", "ai-dev.cmd", "node/LICENSE", "ai-dev-mcp-server/bin/ai-dev.mjs", "ai-dev-mcp-server/src/core/app-bundle.mjs",
    "seed/public-seed.manifest.json", "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node", "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
    "node_modules/@img/sharp-win32-x64/package.json", "node_modules/@huggingface/transformers/package.json"
  ].map((relative) => file(relative));
  const node = file("node/node.exe", 1, "node");
  assert.deepEqual(compositionProblems([...complete, node], { nodeSha256: sha("node") }), []);
  const problems = compositionProblems([
    ...complete.filter((item) => item.path !== "ai-dev.cmd"),
    file("node/node.exe", 1, "another node"),
    file("node_modules/onnxruntime-web/dist/ort.js"),
    file("node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node"),
    file("node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node"),
    file("node_modules/@img/sharp-wasm32/lib/sharp.wasm")
  ], { nodeSha256: sha("node"), budget: 5 });
  assert.equal(problems.filter((problem) => /must not ship/.test(problem)).length, 4, problems.join("\n"));
  assert.ok(problems.includes("ai-dev.cmd is missing"));
  assert.ok(problems.some((problem) => /node\/node\.exe has sha256 .* not the pinned/.test(problem)));
  assert.ok(problems.some((problem) => /over its budget of 5/.test(problem)));
  const report = compositionReport([...complete, node, file("node_modules/@img/sharp-win32-x64/lib/libvips-42.dll", 100)]);
  assert.equal(report.files, complete.length + 2);
  assert.deepEqual(Object.keys(report.groups)[0], "node_modules/@img/sharp-win32-x64", "inside node_modules, by package, heaviest first");
  assert.equal(report.largest[0].path, "node_modules/@img/sharp-win32-x64/lib/libvips-42.dll");
});

test("the app's icon is an ICO of PNG images, drawn at build time", () => {
  const images = [256, 32].map((size) => ({ size, data: circlePng([46, 160, 67], size) }));
  const ico = icoFrom(images);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "type 1: icon");
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 0, "256 pixels are written as 0");
  assert.equal(ico[6 + 16], 32);
  const first = ico.readUInt32LE(6 + 12);
  assert.equal(first, 6 + 32);
  assert.deepEqual(ico.subarray(first, first + 8), images[0].data.subarray(0, 8), "the PNG signature where the directory says");
  assert.equal(ico.readUInt32LE(6 + 16 + 12), first + images[0].data.length);
  assert.throws(() => icoFrom([{ size: 512, data: Buffer.alloc(1) }]), /512 pixels/);
});

test("electron-builder's configuration: NSIS for the current user without an administrator, the runtime in resources, updates from the production releases", () => {
  const config = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.ico", output: "/x/out", env: {} });
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false, "per user: no administrator");
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, true, "Electron's own cache; AI Dev's data is asked about");
  assert.ok(fs.existsSync(config.nsis.include), "the uninstaller's questions are part of the build");
  assert.deepEqual(config.nsis.installerLanguages, ["en_US", "ru_RU"], "the strings installer.nsh defines (1033, 1049)");
  assert.deepEqual(config.publish, [RELEASES]);
  assert.deepEqual(RELEASES, { provider: "github", owner: "stonebridgeway", repo: "ai-dev-system", releaseType: "release" });
  assert.deepEqual(config.extraResources, [
    { from: "/x/runtime", to: "runtime", filter: ["**/*"] },
    { from: path.join("/x/runtime", "node_modules"), to: "runtime/node_modules", filter: ["**/*"] }
  ], "electron-builder leaves out a node_modules at the top of what it copies: the dependencies are an entry of their own");
  assert.deepEqual(config.files, ["package.json", "src/**/*"], "no tests, no scripts, no build files in the app");
  assert.equal(config.asar, true);
  assert.equal(config.win.azureSignOptions, undefined, "unsigned unless the environment names a signer");
  const signed = builderConfig({ desktopRoot, runtimeDir: "/x", icon: "/x.ico", output: "/o", env: { AI_DEV_SIGN_AZURE_ENDPOINT: "https://eus.codesigning.azure.net", AI_DEV_SIGN_AZURE_ACCOUNT: "acct", AI_DEV_SIGN_AZURE_PROFILE: "prof" } });
  assert.deepEqual(signed.win.azureSignOptions, { publisherName: "stonebridgeway", endpoint: "https://eus.codesigning.azure.net", codeSigningAccountName: "acct", certificateProfileName: "prof" });
});

test("the Node the installer ships is pinned: the LTS line, a version, the zip's sha256 and node.exe's", () => {
  const pin = JSON.parse(fs.readFileSync(path.join(desktopRoot, "build", "node-win-x64.json"), "utf8"));
  assert.match(pin.version, /^24\.\d+\.\d+$/, "Node 24 LTS until 26 is LTS (end of October 2026)");
  assert.equal(pin.url, `https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-win-x64.zip`);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.match(pin.node_exe_sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.entry, `node-v${pin.version}-win-x64/node.exe`);
  assert.equal(pin.license, `node-v${pin.version}-win-x64/LICENSE`);
});
