/**
 * The acceptance criterion this project works to, as something that can be run.
 *
 * The rule is older than any code here: a session ends with ten consecutive
 * `npm run check` runs and the line "N падений из 10", because one green run has
 * twice hidden a failure that appears in two runs out of ten (docs/DEFECTS.md,
 * Д-11). Kept as an agreement it was honoured about half the time
 * (Д-4); kept as a command it is honoured by running the command.
 *
 * The two kinds of failure are not the same thing and the report must not blur
 * them: a run where a test failed is the suite telling you something, and a run
 * that exited non-zero with `# fail 0` is Д-11 — the coverage reporter falling
 * over on a partially written file, which says nothing about the code.
 */

/**
 * The failure count a `node --test` run reported, or null when it said nothing.
 *
 * Two spellings, because the runner changed one: Node 22 writes TAP comments
 * (`# fail 2`), Node 24 writes an info line (`\u2139 fail 2`). Reading only the
 * first turned every Node 24 run into "failed before the tests" — measured on
 * Windows with Node 24.19, where ten runs each carrying two real test failures
 * were all reported as having failed before any test ran, hiding what the suite
 * was actually saying.
 *
 * @param {string} output - Combined stdout and stderr of the run.
 * @returns {number|null}
 */
export function testFailureCount(output) {
  const match = /^[#\u2139]\s*fail\s+(\d+)\s*$/m.exec(String(output ?? ""));
  return match ? Number(match[1]) : null;
}

/** Whether the coverage reporter is what failed, rather than a test. */
export function coverageReporterFailed(output) {
  return /Could not report code coverage/i.test(String(output ?? ""));
}

/**
 * What one run of the gate means.
 *
 * @param {{ exitCode: number, output: string }} run
 * @returns {{ ok: boolean, test_failures: number|null, coverage_reporter_failed: boolean, kind: "passed" | "tests failed" | "coverage reporter" | "failed before the tests" }}
 */
export function summarizeAcceptanceRun({ exitCode, output }) {
  const failures = testFailureCount(output);
  const reporter = coverageReporterFailed(output);
  const ok = exitCode === 0;
  let kind = "passed";
  if (!ok) {
    if (failures !== null && failures > 0) kind = "tests failed";
    else if (reporter) kind = "coverage reporter";
    else kind = "failed before the tests";
  }
  return { ok, test_failures: failures, coverage_reporter_failed: reporter, kind };
}

/**
 * The report a session ends with, in the shape the project's own rule states.
 *
 * @param {Array<{ ok: boolean, kind: string, test_failures: number|null, duration_ms?: number }>} runs
 * @returns {string}
 */
export function renderAcceptanceReport(runs) {
  const lines = runs.map((run, index) => {
    const seconds = Number.isFinite(run.duration_ms) ? ` (${(run.duration_ms / 1000).toFixed(0)}s)` : "";
    const detail = run.ok
      ? "passed"
      : `${run.kind}${run.test_failures ? `: ${run.test_failures}` : ""}`;
    return `${run.ok ? "✓" : "✗"} run ${String(index + 1).padStart(2)}${seconds}: ${detail}`;
  });
  const failed = runs.filter((run) => !run.ok);
  const realFailures = failed.filter((run) => run.kind === "tests failed");
  lines.push("");
  lines.push(`${failed.length} падений из ${runs.length}`);
  if (failed.length && !realFailures.length) {
    lines.push(`Ни одно падение не про тесты: ${failed.map((run) => run.kind).join(", ")}.`);
  }
  if (realFailures.length) {
    lines.push(`Из них с упавшими тестами: ${realFailures.length}. Это то, что надо чинить.`);
  }
  return lines.join("\n");
}

/**
 * The verdict a caller exits on: a run whose tests failed is a failure of the
 * code, anything else is a failure of the run.
 *
 * @param {Array<{ ok: boolean, kind: string }>} runs
 * @returns {{ passed: boolean, failed_runs: number, failing_tests: number }}
 */
export function acceptanceVerdict(runs) {
  const failed = runs.filter((run) => !run.ok);
  const failingTests = failed.filter((run) => run.kind === "tests failed");
  return { passed: failed.length === 0, failed_runs: failed.length, failing_tests: failingTests.length };
}
