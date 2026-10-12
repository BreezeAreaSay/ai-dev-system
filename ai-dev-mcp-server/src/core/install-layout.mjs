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
 * - `vault`   — `AI_DEV_VAULT_ROOT`, or a full vault two levels above the server.
 * - `clone`   — a checkout of this repository: the content is its `docker/public-seed`.
 * - `package` — `npm run dist`'s folder, the npm package, the Windows install:
 *               `distribution.json` beside the server, the seed in `seed/`.
 * - `docker`  — the image (`AI_DEV_RUNTIME=docker`); its entrypoint seeds `/data`.
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
 * @property {"vault"|"clone"|"package"|"docker"} kind
 * @property {string} serverRoot - `ai-dev-mcp-server/`.
 * @property {string} root - The folder that holds the server and its helpers (`frontend-qa/`, `search-eval/`).
 * @property {string} contentRoot - The vault the server reads and writes.
 * @property {string} seedRoot - The seed shipped with this install, or "" when there is none to sync.
 * @property {string} runtimeRoot - `~/.ai-dev`, or `AI_DEV_HOME`.
 * @property {boolean} ephemeral - Run from a package manager's one-run cache.
 * @property {boolean} appHome - A copy `setup` made under `<runtime>/app/` to outlive that cache.
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
  const base = { serverRoot: server, root, runtimeRoot, ephemeral, appHome };
  if (String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() === "docker") {
    return { ...base, kind: "docker", contentRoot: path.resolve(explicit || "/data/ai-dev-system"), seedRoot: "" };
  }
  if (explicit) return { ...base, kind: "vault", contentRoot: path.resolve(explicit), seedRoot: "" };
  const vault = path.dirname(root);
  if (exists(path.join(vault, "03-skills-catalog")) || exists(path.join(vault, "01-system"))) {
    return { ...base, kind: "vault", contentRoot: vault, seedRoot: "" };
  }
  const repositorySeed = path.join(root, "docker", "public-seed");
  if (exists(repositorySeed)) {
    return { ...base, kind: "clone", contentRoot: repositorySeed, seedRoot: "" };
  }
  const shipped = path.join(root, "seed");
  return {
    ...base,
    kind: "package",
    contentRoot: path.join(runtimeRoot, "vault"),
    seedRoot: exists(path.join(root, DISTRIBUTION_MARKER)) && exists(path.join(shipped, SEED_MANIFEST)) ? shipped : ""
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
 * @param {Pick<InstallLayout, "kind"|"ephemeral"|"appHome">} [layout]
 * @returns {string}
 */
export function hint(command, layout = currentInstallLayout()) {
  if (layout.kind === "clone" || layout.kind === "vault") return command;
  const match = /^npm run ([\w:-]+)(?: -- ?(.*))?$/.exec(command.trim());
  if (!match || !ALIASES.has(match[1])) return command;
  const words = [ALIASES.get(match[1]), match[2] ?? ""].filter(Boolean).join(" ").trim();
  // `ai-dev` is on PATH for a global install; a copy npx left behind, or one
  // setup made in the app home, is reached through npx.
  return layout.ephemeral || layout.appHome ? `npx ${PACKAGE_NAME} ${words}`.trim() : `ai-dev ${words}`.trim();
}
