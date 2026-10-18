import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OWN_SERVER_ROOT, PACKAGE_NAME, hint, isEphemeralInstall, resolveInstallLayout, runtimeRepairHint } from "./install-layout.mjs";

const home = path.resolve("/home/me");
const env = (extra = {}) => ({ HOME: home, USERPROFILE: "", ...extra });

/** A filesystem of the given paths, for `exists`. */
function only(...paths) {
  const present = new Set(paths.map((item) => path.resolve(item)));
  return (target) => present.has(path.resolve(target));
}

test("a checkout of this repository is a clone: its content is the bundled seed", () => {
  const layout = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env() });
  assert.equal(layout.kind, "clone");
  assert.equal(layout.contentRoot, path.join(path.dirname(OWN_SERVER_ROOT), "docker", "public-seed"));
  assert.equal(layout.seedRoot, "", "a clone's seed is its content: nothing to sync");
  assert.equal(layout.runtimeRoot, path.join(home, ".ai-dev"));
});

test("a full vault two levels above the server is a vault; AI_DEV_VAULT_ROOT moves the content, not the kind", () => {
  const server = path.resolve("/vault/09-mcp/ai-dev-mcp-server");
  const inVault = resolveInstallLayout({ serverRoot: server, env: env(), exists: only("/vault/03-skills-catalog") });
  assert.equal(inVault.kind, "vault");
  assert.equal(inVault.contentRoot, path.resolve("/vault"));
  const named = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env({ AI_DEV_VAULT_ROOT: "/elsewhere/notes" }) });
  assert.equal(named.kind, "clone", "the code is still a clone, and its commands are still npm run");
  assert.equal(named.contentRoot, path.resolve("/elsewhere/notes"));
});

test("a package npx runs with AI_DEV_VAULT_ROOT set is still a package in npx's cache (Д-177)", () => {
  const root = path.resolve("/home/me/.npm/_npx/abc/node_modules/@stonebridgeway/ai-dev-system");
  const layout = resolveInstallLayout({
    serverRoot: path.join(root, "ai-dev-mcp-server"),
    env: env({ AI_DEV_VAULT_ROOT: "/home/me/notes" }),
    exists: only(path.join(root, "distribution.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.ephemeral, true, "so setup installs the app home, and clients are never pointed here");
  assert.equal(layout.contentRoot, path.resolve("/home/me/notes"));
  assert.equal(layout.seedRoot, "", "a vault of the user's own is not filled from the package's seed");
  assert.equal(hint("npm run setup -- --model", layout), `npx ${PACKAGE_NAME} setup --model`);
  assert.match(runtimeRepairHint(layout), /^run `npx @stonebridgeway\/ai-dev-system setup`/);
});

test("a package keeps its seed read-only and the user's vault under the runtime folder", () => {
  const root = path.resolve("/usr/lib/node_modules/@stonebridgeway/ai-dev-system");
  const server = path.join(root, "ai-dev-mcp-server");
  const layout = resolveInstallLayout({
    serverRoot: server,
    env: env(),
    exists: only(path.join(root, "distribution.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.root, root);
  assert.equal(layout.seedRoot, path.join(root, "seed"));
  assert.equal(layout.contentRoot, path.join(home, ".ai-dev", "vault"));
  assert.equal(layout.ephemeral, false);
  assert.equal(layout.appHome, false);

  const custom = resolveInstallLayout({ serverRoot: server, env: env({ AI_DEV_HOME: "/data/ai" }), exists: only() });
  assert.equal(custom.contentRoot, path.resolve("/data/ai/vault"), "AI_DEV_HOME is the runtime folder (D2)");
  assert.equal(custom.seedRoot, "", "no marker, no seed: nothing is copied from a folder that is not a distribution");
});

test("the image is docker, whatever the folders say", () => {
  const layout = resolveInstallLayout({ serverRoot: "/opt/ai-dev/app", env: env({ AI_DEV_RUNTIME: "Docker" }), exists: () => true });
  assert.equal(layout.kind, "docker");
  assert.equal(layout.contentRoot, path.resolve("/data/ai-dev-system"));
  const named = resolveInstallLayout({ serverRoot: "/opt/ai-dev/app", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/vault" }) });
  assert.equal(named.contentRoot, path.resolve("/data/vault"));
});

test("npx's cache, pnpm's and yarn's dlx and bunx are one-run folders; the app home is not", () => {
  assert.equal(isEphemeralInstall("/home/me/.npm/_npx/0123abcd/node_modules/@stonebridgeway/ai-dev-system/ai-dev-mcp-server"), true);
  assert.equal(isEphemeralInstall("C:\\Users\\Me\\AppData\\Local\\npm-cache\\_npx\\0123\\node_modules\\x"), true);
  assert.equal(isEphemeralInstall("/home/me/.cache/pnpm/dlx/abc/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/tmp/xfs-1234/dlx-5678/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/tmp/bunx-1000-x@latest/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/home/me/.ai-dev/app/3.0.0/ai-dev-mcp-server"), false);
  assert.equal(isEphemeralInstall("/home/me/src/npx-tools/ai-dev"), false, "a folder merely named like one is not");

  const server = path.join(home, ".ai-dev", "app", "3.0.0", "ai-dev-mcp-server");
  const layout = resolveInstallLayout({ serverRoot: server, env: env(), exists: only() });
  assert.equal(layout.appHome, true);
  assert.equal(layout.ephemeral, false);
});

test("hints are spelled the way each layout runs them", () => {
  const clone = { kind: "clone", ephemeral: false, appHome: false };
  const global = { kind: "package", ephemeral: false, appHome: false };
  const npx = { kind: "package", ephemeral: true, appHome: false };
  const appHome = { kind: "package", ephemeral: false, appHome: true };
  assert.equal(hint("npm run setup -- --model", clone), "npm run setup -- --model");
  assert.equal(hint("npm run setup -- --model", global), "ai-dev setup --model");
  assert.equal(hint("npm run setup -- --model", npx), `npx ${PACKAGE_NAME} setup --model`);
  assert.equal(hint("npm run setup", appHome), `npx ${PACKAGE_NAME} setup`);
  assert.equal(hint("npm run dense:doctor", global), "ai-dev model doctor");
  assert.equal(hint("npm run clients:install -- --clients all", global), "ai-dev clients install --clients all");
  assert.equal(hint("npm run ai-dev -- clients doctor", global), "ai-dev clients doctor");
  assert.equal(hint("npm run doctor", { kind: "docker", ephemeral: false, appHome: false, serverRoot: "/opt/ai-dev/app" }),
    "node /opt/ai-dev/app/bin/ai-dev.mjs doctor", "the image has no ai-dev on PATH (Д-185)");
  assert.equal(hint("npm run check", global), "npm run check", "a script only a checkout has stays as written");
  assert.equal(hint("git pull", global), "git pull");
  const windows = { kind: "package", ephemeral: false, appHome: true, bundle: true, runtimeRoot: path.join(home, ".ai-dev") };
  assert.equal(hint("npm run setup -- --model", windows), `${path.join(home, ".ai-dev", "app", "current", "ai-dev.cmd")} setup --model`,
    "the Windows installer puts nothing on PATH: its shim beside the stable link, unquoted, as cmd and PowerShell both run it");
  const spaced = path.resolve("/home/John Smith/.ai-dev");
  assert.equal(hint("npm run doctor", { ...windows, runtimeRoot: spaced }), `& "${path.join(spaced, "app", "current", "ai-dev.cmd")}" doctor`,
    "a path with a space is quoted, and PowerShell runs a quoted path only after & (Д-306, п. 2)");
});

test("without the stable link the Windows install's hint names the shim in the copy it runs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-hint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "rt");
  const copy = path.join(runtimeRoot, "app", "3.0.0-abcdef12");
  const layout = { kind: "package", ephemeral: false, appHome: true, bundle: true, runtimeRoot, root: copy };
  assert.equal(hint("npm run doctor", layout), `${path.join(copy, "ai-dev.cmd")} doctor`, "a drive that holds no link (Д-299)");
  await fs.mkdir(copy, { recursive: true });
  await fs.writeFile(path.join(copy, "ai-dev.cmd"), "");
  await fs.symlink(copy, path.join(runtimeRoot, "app", "current"), "dir");
  assert.equal(hint("npm run doctor", layout), `${path.join(runtimeRoot, "app", "current", "ai-dev.cmd")} doctor`);
});

test("the Windows installer's runtime is a package with a bundle, wherever it lies", () => {
  const root = path.join(home, ".ai-dev", "app", "3.0.0-abcdef12");
  const layout = resolveInstallLayout({
    serverRoot: path.join(root, "ai-dev-mcp-server"),
    env: env(),
    exists: only(path.join(root, "distribution.json"), path.join(root, "bundle.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.bundle, true);
  assert.equal(layout.appHome, true);
  assert.equal(layout.seedRoot, path.join(root, "seed"), "its seed fills the user's vault, as a package's does");
  assert.match(runtimeRepairHint(layout, { platform: "win32", arch: "x64" }), /^quit AI Dev and start it again — it puts back the files of its runtime that went missing — and, if it says the installer's copy is damaged too, run the AI Dev installer again$/,
    "a start puts back what went missing (Д-300); the installer only when its own copy is damaged");
  const npm = resolveInstallLayout({ serverRoot: path.join(root, "ai-dev-mcp-server"), env: env(), exists: only(path.join(root, "distribution.json")) });
  assert.equal(npm.bundle, false, "an npx copy has no bundle.json");
});

test("the model runtime's way back depends on how the package got here (Д-174)", () => {
  const linux = { platform: "linux", arch: "x64" };
  assert.equal(runtimeRepairHint({ kind: "clone" }, linux), "run `npm ci` in ai-dev-mcp-server/");
  assert.match(runtimeRepairHint({ kind: "package", ephemeral: true }, linux), /^run `npx @stonebridgeway\/ai-dev-system setup`/);
  assert.equal(runtimeRepairHint({ kind: "package", appHome: true, root: "/home/me/.ai-dev/app/3.0.0-abcdef12" }, linux),
    "run `npm ci --omit=dev --ignore-scripts` in /home/me/.ai-dev/app/3.0.0-abcdef12");
  assert.match(runtimeRepairHint({ kind: "package" }, linux), /ONNXRUNTIME_NODE_INSTALL=skip npm install -g @stonebridgeway\/ai-dev-system$/);
  assert.equal(runtimeRepairHint({ kind: "package" }, { platform: "win32", arch: "x64" }), `install the package again: npm install -g ${PACKAGE_NAME}`,
    "only Linux x64 has the CUDA download to skip");
  assert.match(runtimeRepairHint({ kind: "docker" }), /image/);
});
