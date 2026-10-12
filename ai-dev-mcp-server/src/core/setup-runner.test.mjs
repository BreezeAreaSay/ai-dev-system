import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { frontendQaStatus } from "./setup-runner.mjs";

test("a stop during the Frontend QA check is a stop, not a runner that did not start (Д-238)", async () => {
  await assert.rejects(frontendQaStatus(os.tmpdir(), { launch: false, signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
  // Without a signal it answers with a status, whatever the runner finds.
  const status = await frontendQaStatus(os.tmpdir(), { launch: false });
  assert.equal(typeof status.playwright_available, "boolean");
});
