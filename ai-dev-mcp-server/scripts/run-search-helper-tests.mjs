#!/usr/bin/env node
/**
 * Run the SQLite search helper's own test suite.
 *
 *   npm run test:search-helper
 *
 * `search-index/search_cli.py` is Python, so `node --test` never sees the
 * eight tests next to it — freshness detection, the rebuild lock, dense-vector
 * preservation on a fast rebuild, the candidate pool, and the collapse rules
 * that keep a skill card and its source from appearing twice. They passed and
 * gated nothing: no npm script and no CI job ran them, which is why this file
 * exists.
 *
 * Python is optional for this repository — a checkout that never builds the
 * embedding environment does not have it — so a missing interpreter is a skip
 * with the reason printed, never a failure. CI runs the same suite directly on
 * a runner that always has Python, so "skipped" here cannot hide a red suite
 * there.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = path.resolve(serverRoot, "..", "search-index");

if (!existsSync(path.join(helperDir, "test_search_freshness.py"))) {
  console.log(`skipped: no search helper tests at ${helperDir}`);
  process.exit(0);
}

/** The first interpreter on PATH that answers, or "" when none does. */
function findPython() {
  const candidates = process.env.AI_DEV_PYTHON
    ? [process.env.AI_DEV_PYTHON]
    : process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "";
}

const python = findPython();
if (!python) {
  // Which of the two it is matters: a machine without Python and a machine
  // whose named interpreter does not answer need different fixes.
  console.log(process.env.AI_DEV_PYTHON
    ? `skipped: AI_DEV_PYTHON is ${process.env.AI_DEV_PYTHON}, which did not answer \`--version\`.`
    : "skipped: no Python interpreter on PATH (set AI_DEV_PYTHON to choose one).");
  process.exit(0);
}

const result = spawnSync(python, ["-m", "unittest", "test_search_freshness"], {
  cwd: helperDir,
  stdio: "inherit",
  windowsHide: true
});
process.exitCode = result.status ?? 1;
