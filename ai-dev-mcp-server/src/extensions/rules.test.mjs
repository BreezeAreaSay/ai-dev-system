import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createRulesTools } from "./rules.mjs";

test("rules tools detect packs from the stack and install projections", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirty = [];
  const host = {
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ stack: ["Python", "FastAPI", "Docker"], project_types: ["backend", "api"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createRulesTools]);
  const listed = await registry.handlers.get("list_rule_packs")({ project_path: root });
  assert.deepEqual(listed.detected.packs, ["python", "fastapi", "docker"]);
  assert.ok(listed.common.length >= 5);
  assert.ok(listed.targets.includes("claude-md"));
  assert.equal(listed.default_targets.includes("claude-md"), false);

  const dry = await registry.handlers.get("install_project_rules")({ project_path: root, dry_run: true });
  assert.equal(dry.action, "rules_planned");
  assert.equal(dirty.length, 0);

  const installed = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["ai-dev", "agents-md"] });
  assert.equal(installed.action, "rules_installed");
  assert.deepEqual(installed.packs, ["python", "fastapi", "docker"]);
  assert.ok(installed.written.includes(".ai-dev/rules/python.md"));
  assert.ok(installed.written.includes(".ai-dev/rules/fastapi.md"));
  assert.ok(installed.written.includes("AGENTS.md"));
  assert.equal(installed.written.some((item) => item.startsWith(".claude/")), false);
  assert.equal(dirty.length, 1);
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /## Engineering Rules/);
  assert.deepEqual(installed.warnings, []);

  const imported = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["claude-md"] });
  assert.ok(imported.written.includes("CLAUDE.md"));
  assert.match(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), /@\.ai-dev\/rules\/common\/security\.md/);
  assert.deepEqual(imported.warnings, []);

  const both = await registry.handlers.get("install_project_rules")({ project_path: root, targets: ["claude", "claude-md"] });
  assert.match(both.warnings[0], /Keep one/);
});
