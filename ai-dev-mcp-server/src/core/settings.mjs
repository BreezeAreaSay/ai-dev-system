/**
 * The settings a person changes in the interface — and with `settings_set` —
 * kept in `config.json` in the AI Dev home (`~/.ai-dev/config.json`).
 *
 * Most of them stand for an environment variable the server has always read:
 * the file is the default, a variable set in the environment still wins. So a
 * mirror chosen in the interface reaches the model download, a capability
 * profile reaches every client that sets none, and a person who sets the
 * variable by hand keeps the last word. `applySettingsToEnvironment` puts the
 * file's values into the environment of a process when it starts — the CLI
 * and the daemon it runs — for every variable the environment leaves unset.
 *
 * The rest (`projects_root`, `daemon_autostart`, `language`) are the
 * interface's own; the server stores and validates them.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { withExclusiveFile } from "./atomic-files.mjs";
import { parseProfileSetting } from "./tool-profiles.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** The file's format. A file of a newer one is read for the keys this version knows. */
export const SETTINGS_SCHEMA_VERSION = 1;

const nonEmpty = (value) => String(value ?? "").trim();

function absolutePath(name) {
  return (value) => {
    const text = nonEmpty(value);
    if (!text) return "";
    if (!path.isAbsolute(text)) throw new Error(`${name} must be an absolute path, not ${JSON.stringify(text)}.`);
    return path.resolve(text);
  };
}

/**
 * Every setting: its type, default, how a value is checked, and the variable
 * it stands for, when it stands for one.
 */
export const SETTINGS = Object.freeze({
  projects_root: {
    type: "string",
    default: "",
    description: "The folder your projects are in; the interface opens and lists projects from it.",
    validate: absolutePath("projects_root")
  },
  profiles: {
    type: "string",
    default: "",
    env: "AI_DEV_PROFILES",
    description: "Capability profiles listed to a client that sets no AI_DEV_PROFILES of its own; empty lists every tool.",
    validate(value) {
      const text = nonEmpty(value);
      if (!text) return "";
      const parsed = parseProfileSetting(text);
      if (parsed.unknown.length) throw new Error(`profiles names ${parsed.unknown.map((name) => JSON.stringify(name)).join(", ")}, which ${parsed.unknown.length === 1 ? "is not a profile" : "are not profiles"}.`);
      return parsed.all ? "" : parsed.ids.join(",");
    }
  },
  model_mirror: {
    type: "string",
    default: "",
    env: "AI_DEV_MODEL_MIRROR",
    description: "A Hugging Face mirror the local model is downloaded from first, such as https://hf-mirror.com.",
    validate(value) {
      const text = nonEmpty(value).replace(/\/+$/, "");
      if (!text) return "";
      let url;
      try {
        url = new URL(text);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`model_mirror must be an http(s) address, not ${JSON.stringify(text)}.`);
      if (url.username || url.password) throw new Error("model_mirror must not carry a user name or password: the file is not a place for credentials.");
      return text;
    }
  },
  model_dir: {
    type: "string",
    default: "",
    env: "BGE_M3_ONNX_DIR",
    description: "Where the local model lives; empty is <AI Dev home>/models/bge-m3-onnx.",
    validate: absolutePath("model_dir")
  },
  daemon_idle_minutes: {
    type: "number",
    default: 30,
    env: "AI_DEV_IDLE_TIMEOUT_MS",
    toEnv: (minutes) => String(Math.round(minutes * 60_000)),
    description: "How long the daemon stays without a client, in minutes; 0 keeps it until it is stopped.",
    validate(value) {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) throw new Error("daemon_idle_minutes must be a number of minutes from 0 to 10080 (a week).");
      return minutes;
    }
  },
  daemon_autostart: {
    type: "boolean",
    default: true,
    description: "Whether the desktop app starts the daemon when it starts.",
    validate(value) {
      if (typeof value !== "boolean") throw new Error("daemon_autostart must be true or false.");
      return value;
    }
  },
  language: {
    type: "string",
    default: "",
    description: "The interface's language: ru, en, or empty for the system's.",
    validate(value) {
      const text = nonEmpty(value).toLowerCase();
      if (!["", "ru", "en"].includes(text)) throw new Error(`language must be ru, en or empty, not ${JSON.stringify(value)}.`);
      return text;
    }
  }
});

/**
 * Where the settings are kept: `config.json` in the AI Dev home.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function settingsPath(env = process.env) {
  return path.join(path.resolve(resolveRuntimeStateRoot("", env)), "config.json");
}

/** The file as stored, or an empty object; a file that is not JSON is reported, never overwritten silently. */
function readStored(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  let stored;
  try {
    stored = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error(`${file} is not JSON. Fix or remove it; the settings are not read until then.`);
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error(`${file} does not hold a settings object.`);
  return stored;
}

/**
 * The settings: each stored value checked, defaults for the rest, and where
 * the value in force comes from — the environment overrides the file.
 *
 * @param {{ env?: NodeJS.ProcessEnv, file?: string }} [options]
 * @returns {{ file: string, schema_version: number, settings: Record<string, unknown>, stored: Record<string, unknown>, sources: Record<string, string>, problems: string[] }}
 */
export function readSettings({ env = process.env, file = settingsPath(env) } = {}) {
  const stored = readStored(file);
  const settings = {};
  const kept = {};
  const sources = {};
  const problems = [];
  for (const [name, setting] of Object.entries(SETTINGS)) {
    let value = setting.default;
    let source = "default";
    if (Object.hasOwn(stored, name)) {
      try {
        value = setting.validate(stored[name]);
        kept[name] = value;
        source = "file";
      } catch (error) {
        problems.push(`${name}: ${error.message} The default is used.`);
      }
    }
    if (setting.env && nonEmpty(env[setting.env]) && !(env.__AI_DEV_SETTINGS_APPLIED ?? "").split(",").includes(setting.env)) {
      source = `environment (${setting.env})`;
    }
    settings[name] = value;
    sources[name] = source;
  }
  return { file, schema_version: SETTINGS_SCHEMA_VERSION, settings, stored: kept, sources, problems };
}

/**
 * Change some settings: each value checked first, nothing written when one is
 * wrong; `null` puts a setting back to its default. The file is rewritten
 * whole, under a lock, with mode 0600.
 *
 * @param {Record<string, unknown>} changes
 * @param {{ env?: NodeJS.ProcessEnv, file?: string }} [options]
 * @returns {Promise<{ changed: string[], settings: Record<string, unknown> }>}
 */
export async function writeSettings(changes, { env = process.env, file = settingsPath(env) } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("settings_set takes an object of settings to change.");
  const unknown = Object.keys(changes).filter((name) => !Object.hasOwn(SETTINGS, name));
  if (unknown.length) throw new Error(`There is no setting ${unknown.map((name) => JSON.stringify(name)).join(", ")}. The settings are ${Object.keys(SETTINGS).join(", ")}.`);
  const checked = {};
  for (const [name, value] of Object.entries(changes)) checked[name] = value === null ? null : SETTINGS[name].validate(value);
  return withExclusiveFile(file, async () => {
    const stored = readStored(file);
    const next = { ...stored, schema_version: SETTINGS_SCHEMA_VERSION };
    const changed = [];
    for (const [name, value] of Object.entries(checked)) {
      const before = Object.hasOwn(stored, name) ? stored[name] : undefined;
      if (value === null) delete next[name];
      else next[name] = value;
      if (JSON.stringify(before) !== JSON.stringify(value === null ? undefined : value)) changed.push(name);
    }
    if (changed.length) {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return { changed, settings: readSettings({ env, file }).settings };
  });
}

/**
 * Put the file's values into `env` for every variable it leaves unset, and
 * remember which ones came from the file, so a later change of the file can
 * replace them and a variable set by hand is never touched.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} the variables set from the file
 */
export function applySettingsToEnvironment(env = process.env) {
  let current;
  try {
    current = readSettings({ env });
  } catch {
    // A broken file is reported where settings are read on purpose; a process
    // starting up goes on with its environment as it is.
    return [];
  }
  const ours = new Set(String(env.__AI_DEV_SETTINGS_APPLIED ?? "").split(",").filter(Boolean));
  for (const [name, setting] of Object.entries(SETTINGS)) {
    if (!setting.env) continue;
    const explicit = nonEmpty(env[setting.env]) && !ours.has(setting.env);
    if (explicit) continue;
    if (Object.hasOwn(current.stored, name)) {
      const value = current.stored[name];
      const text = setting.toEnv ? setting.toEnv(value) : String(value);
      if (text === "" && setting.type === "string") {
        delete env[setting.env];
        ours.delete(setting.env);
      } else {
        env[setting.env] = text;
        ours.add(setting.env);
      }
    } else if (ours.has(setting.env)) {
      delete env[setting.env];
      ours.delete(setting.env);
    }
  }
  if (ours.size) env.__AI_DEV_SETTINGS_APPLIED = [...ours].sort().join(",");
  else delete env.__AI_DEV_SETTINGS_APPLIED;
  return [...ours].sort();
}
