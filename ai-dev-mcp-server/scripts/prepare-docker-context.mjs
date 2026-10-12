#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertSeedMatchesManifest, planDistribution } from "../src/core/distribution-build.mjs";
import {
  assertCleanDistribution,
  auditDistributionTree,
  copyDistributionFile,
  distributionContentFingerprint,
  ownerUsername
} from "../src/core/public-distribution.mjs";
import { isDirectExecution } from "../src/core/direct-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const generatedRoot = path.join(repositoryRoot, ".docker");
const defaultOutput = path.join(generatedRoot, "build-context");

function parseArgs(argv) {
  const options = { output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      options.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function assertGeneratedTarget(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(generatedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Docker context must stay below ${generatedRoot}: ${resolved}`);
  }
  return resolved;
}

async function writeText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createDockerContext({ output }) {
  const outputRoot = assertGeneratedTarget(output);
  const stage = path.join(generatedRoot, `context-${process.pid}`);
  const publicSeed = path.join(repositoryRoot, "docker", "public-seed");
  const manifestFile = path.join(publicSeed, "public-seed.manifest.json");
  const seedManifest = await fs.readFile(manifestFile, "utf8").then(JSON.parse).catch(() => null);
  // The seed doubles as the vault a server without Obsidian runs against, so a
  // machine that has used the system has project cards and registries in it —
  // git ignores them, and the privacy audit rightly refused to ship them. The
  // allowlist ships what the seed's manifest lists, and that only.
  if (!seedManifest) throw new Error("Public seed is missing. Run npm run docker:seed first.");

  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  try {
    // The same allowlist `npm run dist` reads (distribution.allowlist.json): the
    // image gets the files the package gets, laid out as the Dockerfile expects
    // — the server in app/, its helpers in runtime/, the seed in public-seed/.
    for (const item of await planDistribution({ repositoryRoot, target: "docker" })) {
      await copyDistributionFile(item.source, path.join(stage, ...item.destination.split("/")));
    }
    await assertSeedMatchesManifest(path.join(stage, "public-seed"));
    await writeText(path.join(stage, ".dockerignore"), `**
!.dockerignore
!Dockerfile
!container/
!container/**
!app/
!app/**
!runtime/
!runtime/**
!public-seed/
!public-seed/**
!LICENSE
!README.md
!THIRD_PARTY_NOTICES.md
`);

    const forbiddenTerms = [
      os.homedir(),
      ...(process.env.CI ? [] : [ownerUsername()])
    ];
    const initialAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms }),
      "Docker build context"
    );
    const manifest = {
      schema_version: 1,
      policy: "generated from distribution.allowlist.json and the public-seed manifest",
      // Outside `content_fingerprint`, which is taken over `files` alone, so a
      // rebuild of the same tree still fingerprints identically. The audit
      // needs this to tell a context built from these sources from one left
      // over by an earlier tree.
      generated_at: new Date().toISOString(),
      docker_receives_only_allowlisted_files: true,
      total_files: initialAudit.total_files,
      total_bytes: initialAudit.total_bytes,
      content_fingerprint: distributionContentFingerprint(initialAudit.files),
      files: initialAudit.files
    };
    await writeText(
      path.join(stage, "distribution-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const finalAudit = assertCleanDistribution(
      await auditDistributionTree(stage, { forbiddenTerms }),
      "Docker build context"
    );

    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.rename(stage, outputRoot);
    return {
      status: "prepared",
      output: outputRoot,
      files: finalAudit.total_files,
      bytes: finalAudit.total_bytes,
      fingerprint: manifest.content_fingerprint
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

if (await isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await createDockerContext(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

export { createDockerContext };
