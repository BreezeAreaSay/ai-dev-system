import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClientServerConfig,
  installLocalMcpClients,
  mergeClientDocument,
  portablePaths
} from "./install-local-mcp-clients.mjs";

const paths = {
  nodeExecutable: "C:\\runtime\\node.exe",
  serverPath: "C:\\vault\\server.mjs",
  linkedVaultRoot: "C:\\vault",
  pythonExecutable: "C:\\runtime\\python.exe"
};

test("client config uses stdio and shared local paths", () => {
  const vscode = buildClientServerConfig("vscode", paths);
  const gemini = buildClientServerConfig("gemini", paths);
  assert.equal(vscode.type, "stdio");
  assert.equal(gemini.type, undefined);
  assert.equal(vscode.command, paths.nodeExecutable);
  assert.deepEqual(vscode.args, [paths.serverPath]);
  assert.equal(vscode.env.AI_DEV_VAULT_ROOT, paths.linkedVaultRoot);
});

test("a checkout without a vault registers its own server and no vault root", (t) => {
  // The layout a new user has: this repository, cloned, and nothing else. The
  // server path used to be computed as `<vault>/09-mcp/ai-dev-mcp-server/…`,
  // which resolved to `<home>/09-mcp/…` and made `npm run clients:install` —
  // the one command the README gives — refuse to install anything.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-clients-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const resolved = portablePaths({ home: empty, vaultRoot: "" });
  const serverHere = path.resolve(fileURLToPath(new URL("../src/server.mjs", import.meta.url)));
  assert.equal(resolved.serverPath, serverHere);
  assert.ok(fs.existsSync(resolved.serverPath), "the entrypoint it registers has to exist");
  assert.equal(resolved.linkedVaultRoot, "");
  const config = buildClientServerConfig("claude", resolved);
  assert.deepEqual(config.args, [serverHere]);
  assert.equal("AI_DEV_VAULT_ROOT" in config.env, false, "no vault means no guess at one");
  assert.ok(config.env.AI_DEV_PYTHON);
});

test("a vault install keeps the vault's own copy of the server", (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vault-"));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const inVault = path.join(vault, "09-mcp", "ai-dev-mcp-server", "src");
  fs.mkdirSync(inVault, { recursive: true });
  fs.writeFileSync(path.join(inVault, "server.mjs"), "// vault copy\n");
  const resolved = portablePaths({ home: vault, vaultRoot: vault });
  assert.equal(resolved.serverPath, path.join(inVault, "server.mjs"));
  assert.equal(buildClientServerConfig("claude", resolved).env.AI_DEV_VAULT_ROOT, vault);
});

test("client document merge preserves existing servers", () => {
  const current = {
    mcpServers: {
      existing: { command: "existing.exe" }
    },
    unrelated: true
  };
  const merged = mergeClientDocument(
    "cursor",
    current,
    buildClientServerConfig("cursor", paths)
  );
  assert.equal(merged.unrelated, true);
  assert.equal(merged.mcpServers.existing.command, "existing.exe");
  assert.equal(merged.mcpServers["ai-dev-system"].command, paths.nodeExecutable);
});

test("VS Code uses its native servers root", () => {
  const merged = mergeClientDocument(
    "vscode",
    { inputs: [] },
    buildClientServerConfig("vscode", paths)
  );
  assert.deepEqual(merged.inputs, []);
  assert.equal(merged.servers["ai-dev-system"].type, "stdio");
});

test("the editor configuration tree is the one the platform actually uses", () => {
  // Д-74: this was the Windows answer on every platform, so `--apply` on macOS
  // created ~/AppData/Roaming/Code/User/ and VS Code never saw the server.
  const home = path.join(path.sep, "home", "tester");
  const darwin = portablePaths({ home, platform: "darwin" });
  assert.equal(darwin.appData, path.join(home, "Library", "Application Support"));

  const linux = portablePaths({ home, platform: "linux" });
  assert.equal(linux.appData, process.env.XDG_CONFIG_HOME || path.join(home, ".config"));

  const windows = portablePaths({ home, platform: "win32" });
  assert.equal(windows.appData, process.env.APPDATA || path.join(home, "AppData", "Roaming"));

  // AppData is a Windows idea; the other two must not borrow it.
  for (const resolved of [darwin, linux]) {
    assert.doesNotMatch(
      path.join(resolved.appData, "Code", "User", "mcp.json"),
      /AppData/,
      "only Windows may put the editor tree under AppData"
    );
  }
  assert.match(path.join(windows.appData, "Code", "User", "mcp.json"), /AppData|Roaming/);
});

/** A checkout-shaped home with the four client files a test wants in it. */
async function clientHome(t, files = {}) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mcp-clients-"));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(home, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, body, "utf8");
  }
  return home;
}

test("a client whose configuration file is empty is installed into, not refused", async (t) => {
  // Д-74: the Windows run met a zero-byte mcp.json and got "Unexpected end of
  // JSON input". An empty file is a client that has not written anything yet.
  const home = await clientHome(t, { ".cursor/mcp.json": "" });
  const result = await installLocalMcpClients({ home, apply: true, clients: ["cursor"] });
  assert.equal(result.status, "applied");
  assert.equal(result.clients[0].status, "updated");
  const written = JSON.parse(await fs.promises.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(written.mcpServers["ai-dev-system"], "the server should have been written in");
});

test("one unreadable configuration does not take the other clients down with it", async (t) => {
  // Д-74: the loop had no guard, so the first throw ended the run and nothing
  // was installed anywhere — the reader could not even tell which file it was.
  const home = await clientHome(t, {
    ".cursor/mcp.json": "{ this is not json",
    ".gemini/settings.json": "{}"
  });
  const result = await installLocalMcpClients({ home, apply: true, clients: ["cursor", "gemini"] });
  assert.equal(result.status, "partial");

  const cursor = result.clients.find((item) => item.client === "cursor");
  const gemini = result.clients.find((item) => item.client === "gemini");
  assert.equal(cursor.status, "failed");
  assert.match(cursor.error, /mcp\.json/, "the failure names the file it is about");
  assert.equal(gemini.status, "updated", "the healthy client is still installed");
});
