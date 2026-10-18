#!/usr/bin/env node
/**
 * `npm run dist:win` — the Windows installer, in one command (brief, phase
 * 12; docs/DESKTOP.md, "The Windows install"):
 *
 *   node scripts/build-windows.mjs [--dir] [--check]
 *
 * 1. the server's distribution (`ai-dev-mcp-server/scripts/build-dist.mjs`,
 *    phase 7) into `dist/windows/runtime`;
 * 2. its production dependencies for win32-x64 (`npm ci --os=win32
 *    --cpu=x64`, so a Linux or macOS machine builds the same tree), less what
 *    the runtime never loads there (`windows-bundle.mjs`, `TRIMMED`);
 * 3. Node 24 LTS for Windows, by the version and sha256 pinned in
 *    `build/node-win-x64.json`, and the `ai-dev.cmd` beside it;
 * 4. `bundle.json`: every file with its sha256, which the app checks as it
 *    copies the runtime;
 * 5. electron-builder: the app in `app.asar`, the runtime in
 *    `resources/runtime`, an NSIS installer for the current user —
 *    `dist/windows/installer/AI-Dev-Setup-<version>.exe` — or, with `--dir`,
 *    only the unpacked app;
 * 6. the runtime as it landed in the packed app, checked against `bundle.json`.
 *
 * `--check` stops after step 4 and prints the runtime's composition.
 * On Linux and macOS electron-builder needs Wine (32-bit too) for the NSIS
 * installer: its uninstaller is made by running the installer. Nothing is
 * published: a release is the owner's (brief, section 2).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { circlePng, TRAY_COLOURS } from "../src/main/tray-icon.mjs";
import {
  BUNDLE_SHIM,
  builderConfig,
  compositionProblems,
  compositionReport,
  danglingDependencies,
  icoFrom,
  listFiles,
  trimRuntime,
  writeBundleMarker
} from "./windows-bundle.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const serverRoot = path.join(repositoryRoot, "ai-dev-mcp-server");
const windowsRoot = path.join(repositoryRoot, "dist", "windows");
const runtimeDir = path.join(windowsRoot, "runtime");
const cacheDir = path.join(windowsRoot, "cache");
const output = path.join(windowsRoot, "installer");

const fromServer = (relative) => import(pathToFileURL(path.join(serverRoot, ...relative.split("/"))).href);
const say = (line) => process.stderr.write(`${line}\n`);
const megabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function parseArgs(argv) {
  const options = { dir: false, check: false };
  for (const argument of argv) {
    if (argument === "--dir") options.dir = true;
    else if (argument === "--check") options.check = true;
    else throw new Error(`Unknown argument: ${argument}. It takes --dir and --check.`);
  }
  return options;
}

/** Run a command without a shell; npm and node through the server's adapter, which turns npm's `.cmd` shim into `node <npm-cli.js>` on Windows. */
async function run(command, args, { cwd }) {
  const { resolveSpawnInvocation } = await fromServer("src/core/process-runner.mjs");
  const invocation = await resolveSpawnInvocation(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code} in ${cwd}.`))));
  });
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Fetch `url` into `file` over HTTPS, following redirects, unless it is there with the pinned sha256. */
async function download(url, file, sha256) {
  if (await sha256Of(file).then((sum) => sum === sha256, () => false)) return "cached";
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  const fetchTo = (address, hops = 0) => new Promise((resolve, reject) => {
    https.get(address, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && hops < 5) {
        response.resume();
        resolve(fetchTo(new URL(response.headers.location, address).href, hops + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${address} answered HTTP ${response.statusCode}.`));
        return;
      }
      pipeline(response, createWriteStream(partial)).then(resolve, reject);
    }).on("error", reject);
  });
  await fetchTo(url);
  const sum = await sha256Of(partial);
  if (sum !== sha256) {
    await fs.rm(partial, { force: true });
    throw new Error(`${url} has sha256 ${sum}, not the pinned ${sha256}: not the file build/node-win-x64.json names.`);
  }
  await fs.rename(partial, file);
  return "downloaded";
}

/** Node for Windows, by its pin: the zip's sha256, then node.exe's own, as it lands in the runtime. */
async function addNode(pin) {
  const { openZipEntry, readZipEntries } = await fromServer("src/core/model-archive.mjs");
  const zip = path.join(cacheDir, path.basename(new URL(pin.url).pathname));
  say(`Node ${pin.version} for Windows: ${await download(pin.url, zip, pin.sha256)}.`);
  const entries = await readZipEntries(zip);
  for (const [entry, target] of [[pin.entry, "node.exe"], [pin.license, "LICENSE"]]) {
    const found = entries.get(entry);
    if (!found) throw new Error(`${zip} has no ${entry}.`);
    await fs.mkdir(path.join(runtimeDir, "node"), { recursive: true });
    await pipeline(await openZipEntry(zip, found), createWriteStream(path.join(runtimeDir, "node", target)));
  }
  const nodeSum = await sha256Of(path.join(runtimeDir, "node", "node.exe"));
  if (nodeSum !== pin.node_exe_sha256) throw new Error(`node.exe from ${zip} has sha256 ${nodeSum}, not the pinned ${pin.node_exe_sha256}.`);
}

/** The runtime, ready to ship: steps 1 to 4. */
async function buildRuntime(pin) {
  await fs.rm(runtimeDir, { recursive: true, force: true });
  say("1. The server's distribution…");
  await run("node", [path.join(serverRoot, "scripts", "build-dist.mjs"), "--output", runtimeDir, "--no-deps"], { cwd: serverRoot });
  say("2. Its dependencies for win32-x64…");
  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--os=win32", "--cpu=x64", "--no-audit", "--no-fund"], { cwd: runtimeDir });
  const trimmed = await trimRuntime(runtimeDir);
  for (const item of trimmed) say(`   cut ${item.path} (${megabytes(item.bytes)}): ${item.why}`);
  const dangling = await danglingDependencies(path.join(runtimeDir, "node_modules"));
  if (dangling.length) throw new Error(`The cut went too far: ${dangling.map((item) => `${item.package} needs ${item.missing}`).join("; ")}.`);
  say("3. Node for Windows…");
  await addNode(pin);
  await fs.writeFile(path.join(runtimeDir, "ai-dev.cmd"), BUNDLE_SHIM);
  say("4. bundle.json…");
  const { bundleFingerprint } = await fromServer("src/core/app-bundle.mjs");
  const distribution = JSON.parse(await fs.readFile(path.join(runtimeDir, "distribution.json"), "utf8"));
  return { trimmed, marker: await writeBundleMarker({ runtimeDir, name: distribution.name, version: distribution.version, node: { version: pin.version, sha256: pin.node_exe_sha256 }, fingerprintOf: bundleFingerprint }) };
}

/** The runtime as it landed in the packed app: every file `bundle.json` lists, with its size. */
async function checkShipped(packed, marker) {
  const landed = new Map((await listFiles(packed)).map((file) => [file.path, file]));
  const missing = marker.files.filter((file) => landed.get(file.path)?.sha256 !== file.sha256).map((file) => file.path);
  if (missing.length) throw new Error(`${missing.length} runtime file(s) did not land in the app as built, such as ${missing.slice(0, 3).join(", ")}.`);
  return landed.size;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pin = JSON.parse(await fs.readFile(path.join(desktopRoot, "build", "node-win-x64.json"), "utf8"));
  const started = Date.now();
  const { trimmed, marker } = await buildRuntime(pin);
  const report = { runtime: compositionReport(marker.files), trimmed, fingerprint: marker.fingerprint, version: marker.version, node: marker.node };
  const problems = compositionProblems(marker.files, { nodeSha256: pin.node_exe_sha256 });
  if (problems.length) throw new Error(`The runtime is not what ships:\n- ${problems.join("\n- ")}`);
  if (!options.check) {
    say(`5. electron-builder (${options.dir ? "the unpacked app" : "the NSIS installer"})…`);
    const icon = path.join(windowsRoot, "build", "icon.ico");
    await fs.mkdir(path.dirname(icon), { recursive: true });
    await fs.writeFile(icon, icoFrom([256, 48, 32, 16].map((size) => ({ size, data: circlePng(TRAY_COLOURS.ok, size) }))));
    const builder = createRequire(import.meta.url)("electron-builder");
    const artifacts = await builder.build({
      projectDir: desktopRoot,
      targets: builder.Platform.WINDOWS.createTarget(options.dir ? ["dir"] : ["nsis"], builder.Arch.x64),
      config: builderConfig({ desktopRoot, runtimeDir, icon, output }),
      publish: "never"
    });
    say("6. The runtime in the packed app…");
    report.shipped_files = await checkShipped(path.join(output, "win-unpacked", "resources", "runtime"), marker);
    report.artifacts = [];
    for (const artifact of artifacts) report.artifacts.push({ file: path.relative(repositoryRoot, artifact), bytes: (await fs.stat(artifact)).size });
  }
  report.seconds = Math.round((Date.now() - started) / 1000);
  // electron-builder writes its own lines to stdout: the report is a file too.
  await fs.writeFile(path.join(windowsRoot, "build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  say(String(error?.stack ?? error));
  process.exitCode = 1;
});
