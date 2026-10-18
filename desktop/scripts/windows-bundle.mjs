/**
 * The parts of the Windows installer's build that can be checked without
 * building it (docs/DESKTOP.md, "The Windows install"): what is cut from the
 * runtime's dependencies, the runtime's `bundle.json`, its composition, the
 * app's icon and electron-builder's configuration. `build-windows.mjs`
 * (`npm run dist:win`) runs them in order.
 */
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * What the runtime never loads on win32-x64, cut from its `node_modules`
 * (brief, phase 12: "onnxruntime-web и sharp-wasm32 убрать, если импорт это
 * позволяет"). Checked on the code it ships: the dense model's end-to-end test
 * passes without them (docs/program/reports/phase-12.md).
 */
export const TRIMMED = Object.freeze([
  Object.freeze({ path: "onnxruntime-web", why: "transformers 4.3.0 carries the web runtime inside its own file; its Node build loads onnxruntime-node" }),
  Object.freeze({ path: "@img/sharp-wasm32", why: "sharp loads @img/sharp-win32-x64; npm installs the WebAssembly build only as a leftover nothing requires (npm ls: extraneous)" }),
  Object.freeze({ path: "@emnapi/runtime", why: "only @img/sharp-wasm32 requires it" }),
  Object.freeze({ path: "tslib", why: "only @emnapi/runtime requires it" }),
  Object.freeze({ path: ".bin", why: "npm's command links: the runtime runs none of them, and a link is not a file to ship" })
]);

/** Where onnxruntime-node keeps a native build per system and processor: only win32/x64 stays. */
export const ONNX_BINARIES = "onnxruntime-node/bin/napi-v6";

/** The Windows install's own command beside its stable link: its Node, its CLI, the arguments as given. */
export const BUNDLE_SHIM = "@echo off\r\n\"%~dp0node\\node.exe\" \"%~dp0ai-dev-mcp-server\\bin\\ai-dev.mjs\" %*\r\n";

/** What an installed runtime may weigh, unpacked; the build stops above it. */
export const RUNTIME_BUDGET_BYTES = 360 * 1024 * 1024;

async function bytesOf(target) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(target)) total += await bytesOf(path.join(target, entry));
  return total;
}

/**
 * Cut what the runtime never loads on win32-x64 from `<runtime>/node_modules`.
 *
 * @param {string} runtimeDir
 * @returns {Promise<Array<{ path: string, bytes: number, why: string }>>} what was cut
 */
export async function trimRuntime(runtimeDir) {
  const modules = path.join(runtimeDir, "node_modules");
  const removed = [];
  const cut = async (relative, why) => {
    const target = path.join(modules, ...relative.split("/"));
    const bytes = await bytesOf(target);
    if (!bytes && !await fs.lstat(target).then(() => true, () => false)) return;
    await fs.rm(target, { recursive: true, force: true });
    removed.push({ path: `node_modules/${relative}`, bytes, why });
  };
  for (const item of TRIMMED) await cut(item.path, item.why);
  // sharp's native builds of other systems, should a build machine have put any there.
  for (const name of await fs.readdir(path.join(modules, "@img")).catch(() => [])) {
    if (name.startsWith("sharp-") && name !== "sharp-win32-x64") await cut(`@img/${name}`, "a native sharp of another system");
  }
  const binaries = path.join(modules, ...ONNX_BINARIES.split("/"));
  for (const system of await fs.readdir(binaries).catch(() => [])) {
    if (system !== "win32") {
      await cut(`${ONNX_BINARIES}/${system}`, "onnxruntime-node for another system");
      continue;
    }
    for (const arch of await fs.readdir(path.join(binaries, system)).catch(() => [])) {
      if (arch !== "x64") await cut(`${ONNX_BINARIES}/${system}/${arch}`, "onnxruntime-node for another processor");
    }
  }
  return removed;
}

/**
 * Packages whose dependencies the trimmed tree no longer has — a cut that
 * went too far. `ignore` names the ones cut on purpose.
 *
 * @param {string} modules - `<runtime>/node_modules`.
 * @param {{ ignore?: string[] }} [options]
 * @returns {Promise<Array<{ package: string, missing: string }>>}
 */
export async function danglingDependencies(modules, { ignore = TRIMMED.map((item) => item.path) } = {}) {
  const packages = [];
  for (const name of await fs.readdir(modules).catch(() => [])) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const inner of await fs.readdir(path.join(modules, name)).catch(() => [])) packages.push(`${name}/${inner}`);
    } else packages.push(name);
  }
  const present = new Set(packages);
  const dangling = [];
  for (const name of packages) {
    const manifest = await fs.readFile(path.join(modules, ...name.split("/"), "package.json"), "utf8").then(JSON.parse, () => null);
    for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
      if (present.has(dependency) || ignore.includes(dependency)) continue;
      const nested = path.join(modules, ...name.split("/"), "node_modules", ...dependency.split("/"));
      if (!await fs.access(nested).then(() => true, () => false)) dangling.push({ package: name, missing: dependency });
    }
  }
  return dangling;
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Every file under `root`, by its `/`-separated path, with size and sha256,
 * sorted. Links are refused: the runtime is copied file by file, and a link
 * would be followed into whatever it names.
 *
 * @param {string} root
 * @param {{ skip?: (relative: string) => boolean }} [options]
 * @returns {Promise<Array<{ path: string, bytes: number, sha256: string }>>}
 */
export async function listFiles(root, { skip = () => false } = {}) {
  const files = [];
  const walk = async (folder, prefix) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip(relative)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${full} is a link; the runtime ships files only.`);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files.push({ path: relative, bytes: (await fs.stat(full)).size, sha256: await sha256Of(full) });
    }
  };
  await walk(root, "");
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Write `<runtime>/bundle.json`: what the installer ships, file by file, and
 * the fingerprint the app names its copy by.
 *
 * @param {{ runtimeDir: string, name: string, version: string, node: { version: string, sha256: string }, fingerprintOf: (files: Array<{ path: string, sha256: string }>) => string }} input
 */
export async function writeBundleMarker({ runtimeDir, name, version, node, fingerprintOf }) {
  const files = await listFiles(runtimeDir, { skip: (relative) => relative === "bundle.json" });
  const marker = {
    schema_version: 1,
    name,
    version,
    platform: "win32",
    arch: "x64",
    node: { version: node.version, file: "node/node.exe", sha256: node.sha256 },
    fingerprint: fingerprintOf(files),
    files
  };
  await fs.writeFile(path.join(runtimeDir, "bundle.json"), `${JSON.stringify(marker, null, 1)}\n`);
  return marker;
}

/** What a runtime holds, by top-level folder (and inside node_modules, by package): the composition the phase report asks for. */
export function compositionReport(files) {
  const groups = new Map();
  for (const file of files) {
    const parts = file.path.split("/");
    let key = parts.length > 1 ? parts[0] : "(top level)";
    if (parts[0] === "node_modules" && parts.length > 2) key = `node_modules/${parts[1].startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1]}`;
    const group = groups.get(key) ?? { files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += file.bytes;
    groups.set(key, group);
  }
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    groups: Object.fromEntries([...groups].sort((left, right) => right[1].bytes - left[1].bytes)),
    largest: [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 10).map(({ path: file, bytes }) => ({ path: file, bytes }))
  };
}

/** Paths a Windows runtime must not hold: the cuts above, made sure of. */
const FORBIDDEN = [
  /^node_modules\/onnxruntime-web\//,
  /^node_modules\/@img\/sharp-(?!win32-x64\/)/,
  /^node_modules\/onnxruntime-node\/bin\/napi-v6\/(?!win32\/)/,
  /^node_modules\/onnxruntime-node\/bin\/napi-v6\/win32\/(?!x64\/)/,
  /(?:^|\/)\.git\//
];

/** Files a Windows runtime cannot work without. */
const REQUIRED = [
  "distribution.json",
  "ai-dev.cmd",
  "node/node.exe",
  "node/LICENSE",
  "ai-dev-mcp-server/bin/ai-dev.mjs",
  "ai-dev-mcp-server/src/core/app-bundle.mjs",
  "seed/public-seed.manifest.json",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
  "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
  "node_modules/@img/sharp-win32-x64/package.json",
  "node_modules/@huggingface/transformers/package.json"
];

/**
 * What is wrong with a runtime's composition, in words; empty when nothing is.
 *
 * @param {Array<{ path: string, bytes: number, sha256: string }>} files
 * @param {{ nodeSha256: string, budget?: number }} expected
 * @returns {string[]}
 */
export function compositionProblems(files, { nodeSha256, budget = RUNTIME_BUDGET_BYTES }) {
  const problems = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const pattern of FORBIDDEN) {
    const found = files.filter((file) => pattern.test(file.path));
    if (found.length) problems.push(`${found.length} file(s) that must not ship, such as ${found[0].path}`);
  }
  for (const required of REQUIRED) {
    if (!byPath.has(required)) problems.push(`${required} is missing`);
  }
  const node = byPath.get("node/node.exe");
  if (node && node.sha256 !== nodeSha256) problems.push(`node/node.exe has sha256 ${node.sha256}, not the pinned ${nodeSha256}`);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > budget) problems.push(`the runtime weighs ${total} bytes, over its budget of ${budget}`);
  return problems;
}

/**
 * An `.ico` of PNG images (Windows Vista and later read PNG inside ICO): the
 * app's icon, drawn at build time — the repository keeps binaries out.
 *
 * @param {Array<{ size: number, data: Buffer }>} images - square PNGs, 256 at most
 * @returns {Buffer}
 */
export function icoFrom(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError(`an icon image of ${size} pixels`);
    const at = index * 16;
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

/** The production repository: where updates come from (owner decision D7). */
export const RELEASES = Object.freeze({ provider: "github", owner: "stonebridgeway", repo: "ai-dev-system", releaseType: "release" });

/**
 * electron-builder's configuration of the Windows installer: NSIS, for the
 * current user, no administrator. Signing comes from the environment: a
 * certificate file in `CSC_LINK` / `WIN_CSC_LINK` with its password, which
 * electron-builder reads itself, or Azure Trusted Signing named by the
 * `AI_DEV_SIGN_AZURE_*` variables. Without either the build is unsigned.
 *
 * @param {{ desktopRoot: string, runtimeDir: string, icon: string, output: string, env?: NodeJS.ProcessEnv }} input
 * @returns {object}
 */
export function builderConfig({ desktopRoot, runtimeDir, icon, output, env = process.env }) {
  const azure = env.AI_DEV_SIGN_AZURE_ENDPOINT
    ? {
      azureSignOptions: {
        publisherName: env.AI_DEV_SIGN_PUBLISHER || "stonebridgeway",
        endpoint: env.AI_DEV_SIGN_AZURE_ENDPOINT,
        codeSigningAccountName: env.AI_DEV_SIGN_AZURE_ACCOUNT,
        certificateProfileName: env.AI_DEV_SIGN_AZURE_PROFILE
      }
    }
    : {};
  return {
    appId: "com.stonebridgeway.ai-dev",
    productName: "AI Dev",
    executableName: "AI Dev",
    copyright: "Copyright © 2026 stonebridgeway",
    directories: { output, buildResources: path.join(desktopRoot, "build") },
    // The app's own code; its production dependencies (electron-updater) are added by electron-builder.
    files: ["package.json", "src/**/*"],
    // electron-builder leaves out a `node_modules` folder at the top of what
    // it copies, so the runtime's dependencies are a second entry of their own:
    // without it the installed runtime had none (docs/program/reports/phase-12.md).
    extraResources: [
      { from: runtimeDir, to: "runtime", filter: ["**/*"] },
      { from: path.join(runtimeDir, "node_modules"), to: "runtime/node_modules", filter: ["**/*"] }
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon,
      artifactName: "AI-Dev-Setup-${version}.${ext}",
      ...azure
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "AI Dev",
      // Electron's own cache in %APPDATA%; AI Dev's data is asked about (installer.nsh).
      deleteAppDataOnUninstall: true,
      include: path.join(desktopRoot, "build", "installer.nsh"),
      installerLanguages: ["en_US", "ru_RU"],
      multiLanguageInstaller: true
    },
    publish: [RELEASES]
  };
}
