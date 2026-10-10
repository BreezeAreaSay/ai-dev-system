import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createExtensionTools } from "../tool-extensions.mjs";
import { GALAXY_OUTPUT_PATH } from "../core/galaxy.mjs";
import { createGalaxyTools } from "./galaxy.mjs";

const run = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const searchCli = path.resolve(serverRoot, "..", "search-index", "search_cli.py");

/** The first Python on PATH that answers, or "" (the helper tests skip the same way). */
function findPython() {
  for (const candidate of process.env.AI_DEV_PYTHON ? [process.env.AI_DEV_PYTHON] : ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "";
}

/** A host whose search half is the real Python helper on a throwaway vault. */
async function hostFor(root, python) {
  const vault = path.join(root, "My Vault");
  const index = path.join(root, "cache", "index.sqlite");
  const notes = {
    "02-knowledge/Postgres Vacuum.md": "# Postgres Vacuum\n\nAutovacuum, bloat and dead tuples in postgres tables. See [[Postgres Indexes]].\n",
    "02-knowledge/Postgres Indexes.md": "# Postgres Indexes\n\nB-tree and GIN indexes in postgres, and when the planner uses them.\n",
    "02-knowledge/Postgres Locks.md": "# Postgres Locks\n\nRow locks, deadlocks and lock queues in postgres.\n",
    "02-knowledge/React Hooks.md": "# React Hooks\n\nuseEffect, useMemo and the rules of hooks in React components.\n",
    "02-knowledge/React State.md": "# React State\n\nLifting state, reducers and context in React components.\n",
    "02-knowledge/React Suspense.md": "# React Suspense\n\nSuspense boundaries and lazy React components.\n"
  };
  for (const [relative, text] of Object.entries(notes)) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), text, "utf8");
  }
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]\n", "utf8");
  const calls = { ensureFresh: 0, exports: [] };
  const writes = new Map();
  return {
    calls,
    writes,
    vault,
    host: {
      vaultRoot: vault,
      searchIndexPath: index,
      search: {
        ensureFresh: async () => {
          calls.ensureFresh += 1;
          await fs.mkdir(path.dirname(index), { recursive: true });
          await run(python, [searchCli, "rebuild", "--vault-root", vault, "--index-path", index]);
          return { action: "rebuilt" };
        },
        exportGalaxy: async ({ outDir }) => {
          calls.exports.push(outDir);
          const { stdout } = await run(python, [searchCli, "galaxy-export", "--index-path", index, "--out-dir", outDir]);
          return JSON.parse(stdout);
        }
      },
      safePath: (relative) => path.join(vault, relative),
      writeText: async (relative, text) => {
        writes.set(relative, text);
        await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
        await fs.writeFile(path.join(vault, relative), text, "utf8");
      }
    }
  };
}

const python = existsSync(searchCli) ? findPython() : "";

test("render_knowledge_galaxy draws the vault the Python helper exported", { skip: python ? false : "needs Python and search-index/search_cli.py" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galaxy-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { host, calls, writes, vault } = await hostFor(root, python);
  const tools = createExtensionTools(host, [createGalaxyTools]);
  assert.deepEqual(tools.readOnly, [], "it writes a file into the vault");

  const result = await tools.handlers.get("render_knowledge_galaxy")({ neighbors: 3 });
  assert.equal(result.status, "written");
  assert.equal(result.vault_path, GALAXY_OUTPUT_PATH);
  assert.equal(result.path, path.join(vault, GALAXY_OUTPUT_PATH));
  assert.ok(result.url.startsWith("file://"));
  assert.equal(result.index, "rebuilt");
  assert.equal(result.documents, 6);
  assert.equal(result.space, "sparse");
  assert.equal(result.link_edges, 1);
  assert.equal(result.isolated_documents, 0);
  assert.equal(calls.ensureFresh, 1);
  // The export's scratch directory does not outlive the call.
  assert.equal(existsSync(calls.exports[0]), false);

  const html = writes.get(GALAXY_OUTPUT_PATH);
  assert.equal(Buffer.byteLength(html, "utf8"), result.bytes);
  assert.match(html, /<title>Knowledge Galaxy — My Vault<\/title>/);
  assert.match(html, /export function bootGalaxy\(/);
  const model = JSON.parse(html.match(/id="galaxy-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(model.obsidian_vault, "My Vault");
  assert.deepEqual(model.nodes.title.slice().sort(), [
    "Postgres Indexes", "Postgres Locks", "Postgres Vacuum", "React Hooks", "React State", "React Suspense"
  ]);
  // Two topics, two constellations, and no note in the wrong one.
  const byTopic = new Map();
  model.nodes.title.forEach((title, index) => {
    const topic = title.split(" ")[0];
    byTopic.set(topic, new Set([...(byTopic.get(topic) ?? []), model.nodes.cluster[index]]));
  });
  assert.equal(byTopic.get("Postgres").size, 1);
  assert.equal(byTopic.get("React").size, 1);
  assert.notDeepEqual([...byTopic.get("Postgres")], [...byTopic.get("React")]);

  const again = await tools.handlers.get("render_knowledge_galaxy")({
    refresh_index: false,
    scopes: ["knowledge"],
    obsidian_vault: "Work"
  });
  assert.equal(again.index, "skipped");
  assert.equal(calls.ensureFresh, 1);
  assert.equal(JSON.parse(writes.get(GALAXY_OUTPUT_PATH).match(/id="galaxy-data">([\s\S]*?)<\/script>/)[1]).obsidian_vault, "Work");
  await assert.rejects(
    tools.handlers.get("render_knowledge_galaxy")({ refresh_index: false, scopes: ["skills"] }),
    /No documents to draw/
  );
});

test("a failed export leaves no scratch directory behind", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galaxy-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let scratch = "";
  const host = {
    vaultRoot: root,
    searchIndexPath: path.join(root, "index.sqlite"),
    search: {
      ensureFresh: async () => ({ action: "current" }),
      exportGalaxy: async ({ outDir }) => {
        scratch = outDir;
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, "nodes.json"), "{\"schema\": 99}", "utf8");
        await fs.writeFile(path.join(outDir, "semantic.f32"), "");
        return {};
      }
    },
    safePath: (relative) => path.join(root, relative),
    writeText: async () => assert.fail("nothing is written when the export is wrong")
  };
  const tools = createExtensionTools(host, [createGalaxyTools]);
  await assert.rejects(tools.handlers.get("render_knowledge_galaxy")({}), /schema 99/);
  assert.ok(scratch.startsWith(root));
  assert.equal(existsSync(scratch), false);
});
