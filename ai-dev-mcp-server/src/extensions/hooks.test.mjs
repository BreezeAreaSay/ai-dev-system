import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createHookTools } from "./hooks.mjs";

test("hook tools install and report agent hooks through the host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hook-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const host = {
    serverRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createHookTools]);
  const before = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(before.installed, false);
  const installed = await registry.handlers.get("install_agent_hooks")({ project_path: projectRoot, targets: ["claude", "cursor"], profile: "strict" });
  assert.equal(installed.action, "hooks_installed");
  assert.ok(installed.written.includes(".claude/settings.json"));
  assert.ok(installed.written.includes(".cursor/hooks.json"));
  const after = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(after.installed, true);
  assert.equal(after.profile, "strict");
  assert.ok(after.claude_entries >= 6);
  assert.ok(after.cursor_entries >= 5);
});
