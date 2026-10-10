import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  explicitRuntimeHome,
  legacyDoubledRuntimeRoot,
  resolveRuntimeStateRoot,
  resolveUserHome
} from "./runtime-home.mjs";
import * as hookLib from "../../hooks/lib.mjs";

const HOME = path.resolve(path.join(path.sep, "tmp", "home-of-someone"));

test("without AI_DEV_HOME the runtime tree is <home>/.ai-dev", () => {
  assert.equal(resolveRuntimeStateRoot("", { HOME }), path.join(HOME, ".ai-dev"));
  assert.equal(resolveRuntimeStateRoot("", { USERPROFILE: HOME, HOME: "/elsewhere" }), path.join(HOME, ".ai-dev"), "USERPROFILE first, as on Windows");
  assert.equal(legacyDoubledRuntimeRoot({ HOME }), "");
});

test("AI_DEV_HOME is the runtime folder itself, as the documentation always said (Д-90)", () => {
  const env = { HOME, AI_DEV_HOME: "/data/runtime-home/.ai-dev" };
  assert.equal(resolveRuntimeStateRoot("", env), path.resolve("/data/runtime-home/.ai-dev"));
  assert.equal(legacyDoubledRuntimeRoot(env), path.join(path.resolve("/data/runtime-home/.ai-dev"), ".ai-dev"));
  assert.equal(resolveRuntimeStateRoot("", { HOME, AI_DEV_HOME: "relative/runtime" }), path.resolve("relative/runtime"));
  assert.equal(resolveRuntimeStateRoot("", { HOME, AI_DEV_HOME: "   " }), path.join(HOME, ".ai-dev"), "blank is unset");
});

test("AI_DEV_HOME naming the home directory keeps its 2.x meaning instead of scattering the tree", () => {
  for (const env of [{ HOME, AI_DEV_HOME: HOME }, { USERPROFILE: HOME, AI_DEV_HOME: `${HOME}${path.sep}` }]) {
    assert.equal(explicitRuntimeHome(env), "");
    assert.equal(resolveRuntimeStateRoot("", env), path.join(HOME, ".ai-dev"));
    assert.equal(legacyDoubledRuntimeRoot(env), "", "nothing to migrate: 2.x used <home>/.ai-dev too");
  }
});

test("the vault's parent is the home only when nothing names one", () => {
  assert.equal(resolveUserHome("/vaults/main", { HOME }), HOME);
  assert.equal(resolveUserHome("/vaults/main", {}), path.resolve("/vaults"));
  assert.equal(resolveUserHome("", {}), os.homedir());
});

function withEnvironment(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the hooks' copy names the same runtime tree as the server in every case (rule 3)", () => {
  const cases = [
    { AI_DEV_HOME: undefined, USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "/data/runtime-home/.ai-dev", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "/opt/ai-dev-data", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: HOME, USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: "relative/runtime", USERPROFILE: undefined, HOME },
    { AI_DEV_HOME: undefined, USERPROFILE: HOME, HOME: "/elsewhere" }
  ];
  for (const env of cases) {
    withEnvironment(env, () => {
      assert.equal(hookLib.runtimeStateRoot(), resolveRuntimeStateRoot(), JSON.stringify(env));
      assert.equal(hookLib.explicitRuntimeHome(), explicitRuntimeHome(), JSON.stringify(env));
    });
  }
});
