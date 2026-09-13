#!/usr/bin/env node
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertCleanDistribution,
  auditDistributionTree,
  distributionContentFingerprint,
  findDanglingImports,
  ownerUsername
} from "../src/core/public-distribution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const target = path.resolve(process.argv[2] || path.join(repositoryRoot, ".docker", "build-context"));

if (!existsSync(target)) {
  process.stderr.write(
    `Docker build context not found: ${target}\n` +
    "Run `npm run docker:prepare` first to generate the allowlisted context.\n"
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
const dangling = await findDanglingImports(path.join(target, "app"));
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
