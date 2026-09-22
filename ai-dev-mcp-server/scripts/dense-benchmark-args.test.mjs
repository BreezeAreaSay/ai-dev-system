import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DEFAULT_MAX_CASES, parseBenchmarkArgs } from "./dense-benchmark-args.mjs";

test("the dense-eval workflow's own command line is read whole", () => {
  const options = parseBenchmarkArgs(
    ["--label", "onnx", "--out", "/tmp/dense-onnx.json", "--max-cases", "20"],
    { AI_DEV_DENSE_BACKEND: "onnx" }
  );
  assert.deepEqual(options, { out: "/tmp/dense-onnx.json", label: "onnx", maxCases: 20 });
});

test("the label falls back to the backend the environment asks for, then to auto", () => {
  assert.equal(parseBenchmarkArgs([], { AI_DEV_DENSE_BACKEND: "python" }).label, "python");
  assert.equal(parseBenchmarkArgs([]).label, "auto");
  assert.equal(parseBenchmarkArgs(["--label", "onnx"], { AI_DEV_DENSE_BACKEND: "python" }).label, "onnx");
});

test("a dispatch that names no case count scores the default rather than nothing", () => {
  // `--max-cases "${{ inputs.max_cases }}"` with the input unset arrives here
  // as an empty string; the run must still score the golden cases.
  for (const value of [undefined, "", "   ", "all", "0", "-5", "1.5"]) {
    assert.equal(
      parseBenchmarkArgs(["--max-cases", value]).maxCases,
      DEFAULT_MAX_CASES,
      `"${value}" should have fallen back to the default`
    );
  }
});

test("a trailing flag with no value does not swallow the option before it", () => {
  const options = parseBenchmarkArgs(["--max-cases", "12", "--out"]);
  assert.equal(options.out, "");
  assert.equal(options.maxCases, 12);
});

// The defect was not in the parsing but in the wiring: the workflow offered the
// input and no one passed it on. These two read the files the dispatch actually
// runs, because nothing else can — the benchmark needs the weights to run at
// all, and that is the one thing CI pays 600 MB for (docs/DEFECTS.md, Д-62).
const repoRoot = new URL("../../", import.meta.url);
const denseEval = await fs.readFile(new URL(".github/workflows/dense-eval.yml", repoRoot), "utf8");
const benchmark = await fs.readFile(new URL("dense-benchmark.mjs", import.meta.url), "utf8");

test("every dense-eval measurement is handed the case count the dispatch asked for", () => {
  const invocations = denseEval.match(/node scripts\/dense-benchmark\.mjs[^\n]*/g) ?? [];
  assert.equal(invocations.length, 2, "one measurement per backend");
  for (const invocation of invocations) {
    assert.match(invocation, /--max-cases "\$\{\{ inputs\.max_cases \}\}"/, invocation);
  }
});

test("the benchmark scores the count it was given, not a number of its own", () => {
  assert.match(benchmark, /run_search_eval", \{ include_dense: true, max_cases: options\.maxCases \}/);
});

test("the sha this workflow prints has somewhere to go", () => {
  // The other half of Д-62 point 1. The wiring inside the server was already
  // there — `BGE_M3_PYTHON_REVISION` reaches `snapshot_download` and the index
  // records `unpinned` when it is empty — but the workflow that prints the sha
  // never defined the variable it told the owner to set, and the cache key read
  // it from an environment where nothing had put it. A pin could be written
  // down and still not be used by anything.
  const python = denseEval.slice(denseEval.indexOf("\n  python:"), denseEval.indexOf("\n  compare:"));

  assert.match(
    python,
    /^ {4}env:\n {6}BGE_M3_PYTHON_REVISION: \$\{\{ inputs\.python_revision \|\| vars\.BGE_M3_PYTHON_REVISION \}\}$/m,
    "the legacy job defines the pin, from the dispatch or from the repository variable"
  );
  assert.match(python, /key: bge-m3-torch-\$\{\{ env\.BGE_M3_PYTHON_REVISION/, "the cache is keyed on it");
  assert.match(denseEval, /^ {6}python_revision:$/m, "and one dispatch can try a pin without a settings page");
});
