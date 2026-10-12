import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readAllowlist, verifyDistribution } from "../src/core/distribution-build.mjs";
import { buildDistribution } from "./build-dist.mjs";
import { createDockerContext } from "./prepare-docker-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where a file of one target lands in the other, by the allowlist's `to`: the longest matching prefix wins. */
function translate(allowlist, from, to, file) {
  const routes = allowlist.groups
    .filter((group) => group.to?.[from] !== undefined && group.to?.[to] !== undefined)
    .map((group) => ({ from: group.to[from] === "." ? "" : `${group.to[from]}/`, to: group.to[to] === "." ? "" : `${group.to[to]}/` }))
    .sort((left, right) => right.from.length - left.from.length);
  const route = routes.find((item) => file.startsWith(item.from));
  return route ? route.to + file.slice(route.from.length) : null;
}

// One build for the file: the tests run in order, and the last one may change it.
const dist = path.join(repositoryRoot, "dist", `.test-${process.pid}`);
const docker = path.join(repositoryRoot, ".docker", `test-context-${process.pid}`);
let built;
test.before(async () => {
  built = await buildDistribution({ output: dist, deps: false });
  await createDockerContext({ output: docker });
});
test.after(() => Promise.all([dist, docker].map((folder) => fs.rm(folder, { recursive: true, force: true }))));

test("the package and the Docker build context are made from one allowlist: the same files, byte for byte", async () => {
  assert.equal(built.name, "@stonebridgeway/ai-dev-system");
  assert.equal((await verifyDistribution(dist)).ok, true);

  const allowlist = await readAllowlist(repositoryRoot);
  const distFiles = new Map(JSON.parse(await fs.readFile(path.join(dist, "distribution.json"), "utf8")).files.map((file) => [file.path, file.sha256]));
  const dockerFiles = new Map(JSON.parse(await fs.readFile(path.join(docker, "distribution-manifest.json"), "utf8")).files.map((file) => [file.path, file.sha256]));
  // What each target makes for itself, rather than takes from the allowlist.
  const ownDist = new Set(["package.json", "npm-shrinkwrap.json"]);
  const ownDocker = new Set([".dockerignore", "Dockerfile", "container/entrypoint.sh"]);

  let compared = 0;
  for (const [file, sha] of distFiles) {
    if (ownDist.has(file)) continue;
    const there = translate(allowlist, "dist", "docker", file);
    assert.ok(there && dockerFiles.has(there), `${file} ships in the package but not in the image (${there})`);
    assert.equal(dockerFiles.get(there), sha, `${file} differs between the two`);
    compared += 1;
  }
  for (const file of dockerFiles.keys()) {
    if (ownDocker.has(file)) continue;
    const there = translate(allowlist, "docker", "dist", file);
    assert.ok(there && distFiles.has(there), `${file} ships in the image but not in the package (${there})`);
  }
  assert.ok(compared > 1500, `${compared} files compared`);

  const manifest = JSON.parse(await fs.readFile(path.join(dist, "package.json"), "utf8"));
  await fs.access(path.join(dist, manifest.bin["ai-dev"]));
  assert.deepEqual(Object.keys(manifest.optionalDependencies).sort(), ["@huggingface/transformers", "onnxruntime-node"],
    "the model runtime is optional: its postinstall failing does not fail an install (Д-174)");
  const shrinkwrap = JSON.parse(await fs.readFile(path.join(dist, "npm-shrinkwrap.json"), "utf8"));
  assert.equal(shrinkwrap.packages[""].name, manifest.name);
  assert.equal(shrinkwrap.packages["node_modules/onnxruntime-node"].optional, true);
});

test("a distribution changed after it was built does not verify, so it is never packed", async () => {
  await fs.appendFile(path.join(dist, "seed", "PUBLIC_SEED.md"), "edited\n");
  await fs.writeFile(path.join(dist, "ai-dev-mcp-server", "stray.mjs"), "");
  await fs.rm(path.join(dist, "search-eval", "search_eval_cases.json"));
  await fs.mkdir(path.join(dist, "frontend-qa", "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(dist, "frontend-qa", "node_modules", "x", "i.js"), "");
  const check = await verifyDistribution(dist);
  assert.equal(check.ok, false);
  assert.deepEqual(check.changed, ["seed/PUBLIC_SEED.md"]);
  assert.deepEqual(check.extra, ["ai-dev-mcp-server/stray.mjs"], "installed dependencies are not part of the build; a stray file is");
  assert.deepEqual(check.missing, ["search-eval/search_eval_cases.json"]);
});

test("the output stays below dist/", async () => {
  await assert.rejects(buildDistribution({ output: path.join(repositoryRoot, "ai-dev-mcp-server"), deps: false }), /must stay below/);
});
