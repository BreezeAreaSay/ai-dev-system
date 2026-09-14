#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertCleanDistribution,
  auditDistributionTree,
  buildContextStaleness,
  distributionContentFingerprint,
  findDanglingImports,
  ownerUsername
} from "../src/core/public-distribution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const target = path.resolve(process.argv[2] || path.join(repositoryRoot, ".docker", "build-context"));

/**
 * The newest modification time below any of `roots`, or NaN when none is readable.
 *
 * @param {string[]} roots
 * @returns {Promise<number>}
 */
async function newestSourceMtime(roots) {
  let newest = Number.NaN;
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stats = await stat(path.join(entry.parentPath ?? entry.path ?? root, entry.name)).catch(() => null);
      if (!stats) continue;
      if (!Number.isFinite(newest) || stats.mtimeMs > newest) newest = stats.mtimeMs;
    }
  }
  return newest;
}

if (!existsSync(target)) {
  process.stderr.write(
    `Docker build context not found: ${target}\n` +
    "Run `npm run docker:prepare` first to generate the allowlisted context.\n"
  );
  process.exit(1);
}
// The context is local build output, so it can predate the tree being audited.
// Saying so beats reporting its dangling imports as defects of the sources.
const manifestPath = path.join(target, "distribution-manifest.json");
const contextManifest = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => null);
const staleness = buildContextStaleness({
  generatedAt: contextManifest?.generated_at,
  newestSourceMs: await newestSourceMtime([
    path.join(repositoryRoot, "ai-dev-mcp-server", "src"),
    path.join(repositoryRoot, "ai-dev-mcp-server", "scripts")
  ])
});
if (staleness.stale) {
  process.stderr.write(
    `Docker build context is stale: ${staleness.reason}.\n` +
    "Run `npm run docker:prepare` and audit again; findings from a stale context describe a tree that no longer exists.\n"
  );
  process.exit(1);
}

const audit = assertCleanDistribution(
  await auditDistributionTree(target, {
    forbiddenTerms: [
      os.homedir(),
      ...(process.env.CI ? [] : [ownerUsername()])
    ]
  }),
  "Docker build context"
);

// What the allowlist left out is only discovered when something imports it, and
// by then the image is built and its server dies on startup.
//
// `runtime/` is walked as well as `app/`. It was not, and the Frontend QA
// runner shipped for months importing two server modules by a relative path
// that resolves nowhere inside the image — the audit was green because it never
// looked there (docs/DEFECTS.md, Д-56). The Dockerfile copies `runtime/*` to
// `/opt/ai-dev/*` and `app/` to `/opt/ai-dev/app`, with
// `/opt/ai-dev/ai-dev-mcp-server` symlinked onto the latter, so from inside
// `runtime/` the server is `../ai-dev-mcp-server`.
const dangling = [
  ...await findDanglingImports(path.join(target, "app")),
  ...await findDanglingImports(path.join(target, "runtime"), {
    aliases: [[path.join(target, "runtime", "ai-dev-mcp-server"), path.join(target, "app")]]
  })
];
if (dangling.length) {
  process.stderr.write(
    `Docker build context imports ${dangling.length} module(s) it does not carry:\n` +
    dangling.map((item) => `  ${item.file} imports ${item.specifier} (${item.resolved})\n`).join("") +
    "Either ship the file or stop importing it; the allowlist is in scripts/prepare-docker-context.mjs.\n"
  );
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  target,
  files: audit.total_files,
  bytes: audit.total_bytes,
  fingerprint: distributionContentFingerprint(audit.files)
}, null, 2)}\n`);
