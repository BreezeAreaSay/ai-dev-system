import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SETTINGS, applySettingsToEnvironment, readSettings, settingsPath, writeSettings } from "./settings.mjs";

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { AI_DEV_HOME: root };
}

test("with no file every setting is its default, and says so", async (t) => {
  const env = await home(t);
  const current = readSettings({ env });
  assert.equal(current.file, path.join(env.AI_DEV_HOME, "config.json"));
  assert.deepEqual(current.settings, Object.fromEntries(Object.entries(SETTINGS).map(([name, setting]) => [name, setting.default])));
  assert.ok(Object.values(current.sources).every((source) => source === "default"));
  assert.deepEqual(current.problems, []);
});

test("a change is checked, stored with mode 0600, and a null puts the default back", async (t) => {
  const env = await home(t);
  const result = await writeSettings({ model_mirror: "https://hf-mirror.com/", profiles: "git,core", daemon_idle_minutes: 5, language: "RU" }, { env });
  assert.deepEqual(result.changed.sort(), ["daemon_idle_minutes", "language", "model_mirror", "profiles"]);
  assert.equal(result.settings.model_mirror, "https://hf-mirror.com");
  assert.equal(result.settings.profiles, "core,git", "in the profiles' own order");
  // `all` alone is no setting at all; the desktop app's opt-in profile is not
  // put into what every agent client gets (Д-223).
  assert.equal((await writeSettings({ profiles: "all" }, { env })).settings.profiles, "");
  await assert.rejects(writeSettings({ profiles: "control, all" }, { env }), /profiles cannot name control/);
  await assert.rejects(writeSettings({ profiles: "control" }, { env }), /AI_DEV_PROFILES=control itself/);
  await writeSettings({ profiles: "git,core" }, { env });
  assert.equal(result.settings.language, "ru");
  const stored = JSON.parse(await fs.readFile(settingsPath(env), "utf8"));
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.daemon_idle_minutes, 5);
  if (process.platform !== "win32") assert.equal((await fs.stat(settingsPath(env))).mode & 0o777, 0o600);
  assert.deepEqual((await writeSettings({ model_mirror: "https://hf-mirror.com" }, { env })).changed, [], "the same value again changes nothing");
  await writeSettings({ model_mirror: null }, { env });
  assert.equal(readSettings({ env }).settings.model_mirror, "");
  assert.equal(readSettings({ env }).sources.profiles, "file");
});

test("a wrong value is refused with what is wrong, and nothing of the change is written", async (t) => {
  const env = await home(t);
  await writeSettings({ language: "en" }, { env });
  const before = await fs.readFile(settingsPath(env), "utf8");
  const refused = [
    [{ model_mirror: "ftp://mirror" }, /model_mirror must be an http\(s\) address/],
    [{ model_mirror: "https://user:secret@mirror.example" }, /must not carry a user name or password/],
    [{ profiles: "core,nonsense" }, /profiles names "nonsense", which is not a profile/],
    [{ model_dir: "relative/models" }, /model_dir must be an absolute path/],
    [{ daemon_idle_minutes: -1 }, /daemon_idle_minutes must be a number of minutes/],
    [{ daemon_idle_minutes: "abc" }, /daemon_idle_minutes must be a number/],
    // Not numbers, whatever they convert to, and not a fraction of a minute (Д-221).
    [{ daemon_idle_minutes: "" }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: "5" }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: true }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: [7] }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: 0.0001 }, /from 1 to 10080/],
    [{ daemon_idle_minutes: 10081 }, /from 1 to 10080/],
    [{ model_dir: `${path.resolve("/models")}\u0000evil` }, /must not hold a NUL character/],
    [{ daemon_autostart: "yes" }, /daemon_autostart must be true or false/],
    [{ language: "de" }, /language must be ru, en or empty/],
    [{ colour: "blue" }, /There is no setting "colour"/],
    [{ language: "ru", model_mirror: "nope" }, /model_mirror must be an http/]
  ];
  for (const [change, message] of refused) await assert.rejects(writeSettings(change, { env }), message, JSON.stringify(change));
  await assert.rejects(writeSettings([], { env }), /takes an object/);
  assert.equal(await fs.readFile(settingsPath(env), "utf8"), before);
});

test("a stored value that is no longer valid is reported and replaced by its default; a file that is not JSON stops the read", async (t) => {
  const env = await home(t);
  await fs.writeFile(settingsPath(env), JSON.stringify({ language: "fr", daemon_idle_minutes: 12, future_setting: 1 }));
  const current = readSettings({ env });
  assert.equal(current.settings.language, "");
  assert.equal(current.settings.daemon_idle_minutes, 12);
  assert.match(current.problems.join(" "), /language: language must be ru, en or empty/);
  await fs.writeFile(settingsPath(env), "{ not json");
  assert.throws(() => readSettings({ env }), /is not JSON\. Fix or remove it/);
  await assert.rejects(writeSettings({ language: "en" }, { env }), /is not JSON/);
});

test("the file sets the variables the environment leaves unset, and never one set by hand", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://hf-mirror.com", daemon_idle_minutes: 2, profiles: "core", model_dir: path.resolve("/models/bge") }, { env });
  const process1 = { ...env, BGE_M3_ONNX_DIR: "/mine" };
  assert.deepEqual(applySettingsToEnvironment(process1), ["AI_DEV_IDLE_TIMEOUT_MS", "AI_DEV_MODEL_MIRROR", "AI_DEV_PROFILES"]);
  assert.equal(process1.AI_DEV_MODEL_MIRROR, "https://hf-mirror.com");
  assert.equal(process1.AI_DEV_IDLE_TIMEOUT_MS, "120000");
  assert.equal(process1.AI_DEV_PROFILES, "core");
  assert.equal(process1.BGE_M3_ONNX_DIR, "/mine", "set by hand: the file does not override it");
  const sources = readSettings({ env: process1 }).sources;
  assert.equal(sources.model_mirror, "file", "a variable the file set still counts as the file's");
  assert.equal(sources.model_dir, "environment (BGE_M3_ONNX_DIR)");

  // The file changes while the process runs: what came from it follows, the rest stays.
  await writeSettings({ model_mirror: null, profiles: "" }, { env });
  applySettingsToEnvironment(process1);
  assert.equal(process1.AI_DEV_MODEL_MIRROR, undefined);
  assert.equal(process1.AI_DEV_PROFILES, undefined, "empty profiles: every tool, as no variable");
  assert.equal(process1.AI_DEV_IDLE_TIMEOUT_MS, "120000");
  assert.equal(process1.BGE_M3_ONNX_DIR, "/mine");

  const broken = { ...env };
  await fs.writeFile(settingsPath(env), "{");
  assert.deepEqual(applySettingsToEnvironment(broken), [], "a broken file leaves a starting process as it is");
});

test("the file is replaced whole through a link to it, and one a newer version wrote is left alone (Д-222, Д-223)", async (t) => {
  const env = await home(t);
  // Settings kept in a dotfiles repository, linked into the AI Dev home.
  const dotfiles = path.join(env.AI_DEV_HOME, "dotfiles");
  await fs.mkdir(dotfiles);
  const real = path.join(dotfiles, "ai-dev.json");
  await fs.writeFile(real, JSON.stringify({ schema_version: 1, language: "en", trusted_projects: ["/work/a"] }));
  try {
    await fs.symlink(real, settingsPath(env));
  } catch (error) {
    if (process.platform === "win32") return t.skip(`no symbolic links here: ${error.code}`);
    throw error;
  }
  await writeSettings({ language: "ru" }, { env });
  assert.equal((await fs.lstat(settingsPath(env))).isSymbolicLink(), true, "the link stays");
  const written = JSON.parse(await fs.readFile(real, "utf8"));
  assert.deepEqual([written.language, written.trusted_projects], ["ru", ["/work/a"]], "the linked file holds the change and keeps what it had");
  if (process.platform !== "win32") assert.equal((await fs.stat(real)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dotfiles)).sort(), ["ai-dev.json"], "no temporary file is left");

  const newer = JSON.stringify({ schema_version: 2, language: "en", future: { kept: true } });
  await fs.writeFile(real, newer);
  await assert.rejects(writeSettings({ language: "ru" }, { env }), /written by a newer AI Dev \(settings schema 2/);
  assert.equal(await fs.readFile(real, "utf8"), newer);
});

test("the value in force is a variable's where one overrides the file (Д-223)", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://from-file.example", daemon_idle_minutes: 5 }, { env });
  const current = readSettings({ env: { ...env, AI_DEV_MODEL_MIRROR: "https://from-env.example", AI_DEV_IDLE_TIMEOUT_MS: "90000" } });
  assert.deepEqual([current.settings.model_mirror, current.sources.model_mirror], ["https://from-env.example", "environment (AI_DEV_MODEL_MIRROR)"]);
  assert.deepEqual([current.settings.daemon_idle_minutes, current.stored.daemon_idle_minutes], [1.5, 5], "in minutes, and the file's own beside it");
});
