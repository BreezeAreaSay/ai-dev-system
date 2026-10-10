import os from "node:os";
import path from "node:path";

/**
 * The user's home directory: where `.ai-dev` lives when `AI_DEV_HOME` is not set.
 *
 * Modules that know `vaultRoot` pass it so its parent is the last resort;
 * modules that do not (e.g. project-identity) fall back to `os.homedir()`.
 *
 * @param {string} [vaultRoot] - Absolute vault root, when the caller knows it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} Absolute home directory.
 */
export function resolveUserHome(vaultRoot = "", env = process.env) {
  return env.USERPROFILE
    || env.HOME
    || (vaultRoot ? path.dirname(path.resolve(vaultRoot)) : os.homedir());
}

/**
 * `AI_DEV_HOME`, when it names a runtime folder rather than the home itself.
 *
 * `AI_DEV_HOME` is the runtime folder (owner decision D2; docs/DEFECTS.md,
 * Д-90). One value cannot mean that: the home directory itself, which some
 * 2.x setups used because 2.x appended `.ai-dev` to the variable. Taken at its
 * word it would scatter `state/`, `cache/` and `models/` across the home, so it
 * keeps meaning what 2.x made of it — `<home>/.ai-dev`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path, or "" when the variable is unset or names the home
 */
export function explicitRuntimeHome(env = process.env) {
  const raw = String(env.AI_DEV_HOME ?? "").trim();
  if (!raw) return "";
  const resolved = path.resolve(raw);
  const homes = [env.USERPROFILE, env.HOME, os.homedir()].filter(Boolean).map((home) => path.resolve(home));
  return homes.includes(resolved) ? "" : resolved;
}

/**
 * Absolute path of the runtime state root: `AI_DEV_HOME` itself, else `<home>/.ai-dev`.
 *
 * This is the single definition; the hooks carry a copy (`runtimeStateRoot` in
 * `hooks/lib.mjs`) that must give the same answer (AGENTS.md, rule 3).
 *
 * @param {string} [vaultRoot]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRuntimeStateRoot(vaultRoot = "", env = process.env) {
  return explicitRuntimeHome(env) || path.join(resolveUserHome(vaultRoot, env), ".ai-dev");
}

/**
 * Where 2.x put the runtime tree for someone who set `AI_DEV_HOME`:
 * `<AI_DEV_HOME>/.ai-dev`. Empty when the variable is unset.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function legacyDoubledRuntimeRoot(env = process.env) {
  const explicit = explicitRuntimeHome(env);
  return explicit ? path.join(explicit, ".ai-dev") : "";
}
