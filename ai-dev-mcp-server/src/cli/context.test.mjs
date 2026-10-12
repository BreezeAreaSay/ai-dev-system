import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EXIT } from "../core/cli-args.mjs";
import { localLaunch } from "./context.mjs";

const clone = { kind: "clone", ephemeral: false, appHome: false, root: "/src/ai-dev-system" };
const home = path.resolve("/home/me");

test("a runtime folder named by AI_DEV_HOME goes into the client's entry; the home itself does not (Д-176)", () => {
  const named = localLaunch({ env: { HOME: home, AI_DEV_HOME: "/data/ai" }, execPath: "/usr/bin/node", cliPath: "/src/cli.mjs", serverRoot: "/src/x", layout: clone });
  assert.deepEqual(named, { command: "/usr/bin/node", args: ["/src/cli.mjs", "mcp"], env: { AI_DEV_HOME: path.resolve("/data/ai") } });
  const homeItself = localLaunch({ env: { HOME: home, AI_DEV_HOME: home }, execPath: "/usr/bin/node", cliPath: "/src/cli.mjs", serverRoot: "/src/x", layout: clone });
  assert.deepEqual(homeItself.env, {}, "AI_DEV_HOME naming the home keeps its 2.x meaning, <home>/.ai-dev (Д-90)");
  const vault = localLaunch({ env: { HOME: home, AI_DEV_VAULT_ROOT: "/vault", AI_DEV_HOME: "/data/ai" }, execPath: "/usr/bin/node", cliPath: "/c", serverRoot: "/s", layout: clone });
  assert.deepEqual(vault.env, { AI_DEV_VAULT_ROOT: path.resolve("/vault"), AI_DEV_HOME: path.resolve("/data/ai") });
});

test("a package npx runs from its cache is launched from the app home, or not at all", () => {
  const npx = { kind: "package", ephemeral: true, appHome: false, root: "/home/me/.npm/_npx/1/node_modules/@stonebridgeway/ai-dev-system" };
  const installed = localLaunch({ env: { HOME: home }, execPath: "/usr/bin/node", layout: npx, appCliPath: () => "/home/me/.ai-dev/app/3.0.0-abc/ai-dev-mcp-server/bin/ai-dev.mjs" });
  assert.deepEqual(installed.args, ["/home/me/.ai-dev/app/3.0.0-abc/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"]);
  assert.throws(() => localLaunch({ env: { HOME: home }, layout: npx, appCliPath: () => "" }), (error) => (
    error.exitCode === EXIT.failed
    && /runs from npx's cache .* which npm may clear/.test(error.message)
    && /Run `npx @stonebridgeway\/ai-dev-system setup` first/.test(error.message)
  ));
});
