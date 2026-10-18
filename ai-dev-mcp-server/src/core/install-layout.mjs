/**
 * Where this install keeps its app, its content and its data, however it was
 * installed — and how its commands are spelled there.
 *
 * The server grew up inside an Obsidian vault (`<vault>/09-mcp/ai-dev-mcp-server`)
 * and found everything relative to that; a clone of the repository was taught
 * to fall back to its `docker/public-seed`. An installed package has neither:
 * its folder is someone else's to replace on the next update, so its seed is
 * copied into a vault of the user's own, `~/.ai-dev/vault`, and kept current by
 * the seed's sha256 manifest (`seed-sync.mjs`).
 *
 * `kind` is how the code got here, and decides how commands are spelled and
 * whether a copy must be made to outlive npx's cache:
 *
 * - `vault`   — inside a full vault, two levels above the server;
 * - `clone`   — a checkout of this repository: the content is its `docker/public-seed`;
 * - `package` — `npm run dist`'s folder, the npm package, the Windows install:
 *               `distribution.json` beside the server, the seed in `seed/`;
 * - `docker`  — the image (`AI_DEV_RUNTIME=docker`): since 3.0 the same
 *               distribution in `/opt/ai-dev`, its seed synced into the volume.
 *
 * `AI_DEV_VAULT_ROOT` names the content root and nothing else: a full vault of
 * the user's own is read where it is, whatever installed the code — and a
 * package's seed is not copied into it. Deciding the kind by that variable
 * made a package npx ran look like a vault, so its client configs pointed into
 * npx's cache (docs/DEFECTS.md, Д-177).
 *
 * A package run by `npx` sits in npm's cache, which npm may clear at any time;
 * `ephemeral` says so, and `setup` copies it somewhere that stays.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** The npm package's name (owner decision D4). */
export const PACKAGE_NAME = "@stonebridgeway/ai-dev-system";

/** The file `npm run dist` writes beside the server: what was built, with the sha256 of each file. */
export const DISTRIBUTION_MARKER = "distribution.json";

/** Where the seed's manifest sits in a seed folder. */
export const SEED_MANIFEST = "public-seed.manifest.json";

/**
 * The file the Windows installer's build writes beside `distribution.json`:
 * the runtime it ships — the package, its dependencies, its own Node — with
 * the sha256 of each file (`app-bundle.mjs`).
 */
export const BUNDLE_MARKER = "bundle.json";

/** The command an install of the Windows installer is run by from a terminal: `<runtime>/app/current/ai-dev.cmd`. */
export const BUNDLE_COMMAND = "ai-dev.cmd";

/** This module's own server folder: `<server>/src/core/install-layout.mjs`. */
export const OWN_SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function realOrSelf(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Whether a folder is one a package manager made for a single run: npm's
 * `npx` cache, pnpm's and yarn's `dlx`, bun's `bunx`.
 *
 * @param {string} folder
 * @returns {boolean}
 */
export function isEphemeralInstall(folder) {
  const parts = path.resolve(folder).split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.includes("_npx") || parts.some((part) => part === "dlx" || part.startsWith("dlx-")) || parts.includes(".bunx") || parts.some((part) => part.startsWith("bunx-"));
}

/**
 * @typedef {object} InstallLayout
 * @property {"vault"|"clone"|"package"|"docker"} kind - How the code is installed.
 * @property {string} serverRoot - `ai-dev-mcp-server/`.
 * @property {string} root - The folder that holds the server and its helpers (`frontend-qa/`, `search-eval/`).
 * @property {string} contentRoot - The vault the server reads and writes.
 * @property {string} seedRoot - The seed shipped with this install, or "" when there is none to sync.
 * @property {string} runtimeRoot - `~/.ai-dev`, or `AI_DEV_HOME`.
 * @property {boolean} ephemeral - Run from a package manager's one-run cache.
 * @property {boolean} appHome - A copy `setup` made under `<runtime>/app/` to outlive that cache.
 * @property {boolean} bundle - The Windows installer's runtime (`bundle.json` beside the package): its own Node, no npm.
 */

/**
 * @param {{ serverRoot?: string, env?: NodeJS.ProcessEnv, exists?: (target: string) => boolean }} [options]
 * @returns {InstallLayout}
 */
export function resolveInstallLayout({ serverRoot = OWN_SERVER_ROOT, env = process.env, exists = existsSync } = {}) {
  const server = path.resolve(serverRoot);
  const root = path.dirname(server);
  const runtimeRoot = resolveRuntimeStateRoot("", env);
  const ephemeral = isEphemeralInstall(realOrSelf(server));
  const appHome = isInside(path.join(runtimeRoot, "app"), server);
  const explicit = String(env.AI_DEV_VAULT_ROOT ?? "").trim();
  const vault = path.dirname(root);
  const repositorySeed = path.join(root, "docker", "public-seed");
  const shipped = path.join(root, "seed");
  let kind = "package";
  let ownContent = path.join(runtimeRoot, "vault");
  if (String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() === "docker") {
    [kind, ownContent] = ["docker", "/data/ai-dev-system"];
  } else if (exists(path.join(vault, "03-skills-catalog")) || exists(path.join(vault, "01-system"))) {
    [kind, ownContent] = ["vault", vault];
  } else if (exists(repositorySeed)) {
    [kind, ownContent] = ["clone", repositorySeed];
  }
  const distributed = exists(path.join(root, DISTRIBUTION_MARKER)) && exists(path.join(shipped, SEED_MANIFEST));
  // The image names its vault itself (AI_DEV_VAULT_ROOT is in its ENV), and
  // that vault is the seed's to keep current whatever it is called: 2.x's
  // entrypoint copied the seed into it with `cp -n`, which never updated a file
  // (docs/DEFECTS.md, Д-99). A 2.x image has no distribution and syncs nothing.
  const ownSeed = distributed && (kind === "docker" || (kind === "package" && !explicit)) ? shipped : "";
  return {
    serverRoot: server,
    root,
    runtimeRoot,
    ephemeral,
    appHome,
    bundle: kind === "package" && exists(path.join(root, BUNDLE_MARKER)),
    kind,
    contentRoot: path.resolve(explicit || ownContent),
    seedRoot: ownSeed
  };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

let own = null;

/** This process's layout, for the messages that name a command. */
export function currentInstallLayout() {
  own ??= resolveInstallLayout();
  return own;
}

/** What `npm run <alias> --` stands for, in `ai-dev` words. */
const ALIASES = new Map([
  ["setup", "setup"],
  ["doctor", "doctor"],
  ["model", "model"],
  ["dense:doctor", "model doctor"],
  ["clients:install", "clients install"],
  ["dashboard", "dashboard"],
  ["galaxy", "galaxy"],
  ["refresh", "refresh"],
  ["backup", "backup"],
  ["distribution", "distribution"],
  ["ai-dev", ""]
]);

/**
 * A command as the user of this layout types it. Hints are written in a
 * clone's words — `npm run setup -- --model` — which do not exist outside a
 * clone: a package's user runs `ai-dev setup --model`, or through `npx`.
 *
 * @param {string} command - `npm run <alias> [-- args]`, as a clone types it.
 * @param {Pick<InstallLayout, "kind"|"ephemeral"|"appHome"> & { serverRoot?: string, bundle?: boolean, runtimeRoot?: string }} [layout]
 * @returns {string}
 */
export function hint(command, layout = currentInstallLayout()) {
  if (layout.kind === "clone" || layout.kind === "vault") return command;
  const match = /^npm run ([\w:-]+)(?: -- ?(.*))?$/.exec(command.trim());
  if (!match || !ALIASES.has(match[1])) return command;
  const words = [ALIASES.get(match[1]), match[2] ?? ""].filter(Boolean).join(" ").trim();
  // The image puts no `ai-dev` on PATH: inside it the CLI is run by its path.
  if (layout.kind === "docker") return `node ${path.posix.join(layout.serverRoot || "/opt/ai-dev/app", "bin", "ai-dev.mjs")} ${words}`.trim();
  // The Windows installer puts nothing on PATH either: its command is the
  // shim beside the runtime's stable link — or in the copy itself, on a drive
  // that holds no link — which names the runtime's own Node. A path of
  // letters, digits and `_-.:\/` runs as it is in cmd and PowerShell both; any
  // other is written for PowerShell, the shell Windows Terminal opens: in
  // single quotes, which it does not expand, `'` doubled, run with `&`
  // (docs/DEFECTS.md, Д-306, п. 2; Д-310, п. 2).
  if (layout.bundle && layout.runtimeRoot) {
    const linked = path.join(layout.runtimeRoot, "app", "current", BUNDLE_COMMAND);
    const shim = existsSync(linked) || !layout.root ? linked : path.join(layout.root, BUNDLE_COMMAND);
    return (/^[\p{L}\p{N}_\-.:\\/]+$/u.test(shim) ? `${shim} ${words}` : `& '${shim.replaceAll("'", "''")}' ${words}`).trim();
  }
  // `ai-dev` is on PATH for a global install; a copy npx left behind, or one
  // setup made in the app home, is reached through npx.
  return layout.ephemeral || layout.appHome ? `npx ${PACKAGE_NAME} ${words}`.trim() : `ai-dev ${words}`.trim();
}

/**
 * How this install gets the local model's runtime (onnxruntime-node and
 * transformers) back. Both are optional dependencies: an install whose
 * onnxruntime-node postinstall failed — on Linux x64 it fetches a CUDA provider
 * the server never loads, and a proxy or a closed api.nuget.org stops it —
 * goes on without them (docs/DEFECTS.md, Д-174). "Run npm ci" is right only
 * in a clone.
 *
 * @param {Pick<InstallLayout, "kind"|"ephemeral"|"appHome"|"root"> & { bundle?: boolean }} [layout]
 * @param {{ platform?: string, arch?: string }} [machine]
 * @returns {string}
 */
export function runtimeRepairHint(layout = currentInstallLayout(), { platform = process.platform, arch = process.arch } = {}) {
  if (layout.kind === "clone" || layout.kind === "vault") return "run `npm ci` in ai-dev-mcp-server/";
  if (layout.kind === "docker") return "pull or rebuild the image, which is built with it";
  // The installer ships the runtime with its dependencies; there is no npm to
  // run. The app checks its copy at every start and puts back what went
  // missing, from the installer's own copy (Д-300).
  if (layout.bundle) return "quit AI Dev and start it again — it puts back the files of its runtime that went missing — and, if it says the installer's copy is damaged too, run the AI Dev installer again";
  if (layout.ephemeral) return `run \`npx ${PACKAGE_NAME} setup\`, which installs a copy with it`;
  if (layout.appHome) return `run \`npm ci --omit=dev --ignore-scripts\` in ${layout.root}`;
  return platform === "linux" && arch === "x64"
    ? `install the package again, without the CUDA download its postinstall tries here: ONNXRUNTIME_NODE_INSTALL=skip npm install -g ${PACKAGE_NAME}`
    : `install the package again: npm install -g ${PACKAGE_NAME}`;
}
