import assert from "node:assert/strict";
import test from "node:test";
import { execFileWithInput } from "./input-process-runner.mjs";

test("stdin subprocess capture keeps UTF-8 intact across output chunks", async () => {
  const text = "Привет, мир! ".repeat(25_000);
  const program = [
    "const value = Buffer.from('Привет, мир! '.repeat(25000));",
    "process.stdout.write(value.subarray(0, 1));",
    "setTimeout(() => process.stdout.end(value.subarray(1)), 10);"
  ].join("\n");

  const result = await execFileWithInput(
    process.execPath,
    ["-e", program],
    "",
    { cwd: process.cwd(), maxOutputBytes: 1024 * 1024, timeoutMs: 10_000 }
  );

  assert.equal(result.stdout, text);
  assert.equal(result.stdout.includes("\uFFFD"), false);
});

test("stdin subprocess capture rejects bounded output", async () => {
  await assert.rejects(
    execFileWithInput(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      "",
      { cwd: process.cwd(), maxOutputBytes: 1024, timeoutMs: 10_000 }
    ),
    /output exceeded 1024 bytes/
  );
});

test("stdin subprocess capture terminates on timeout", async () => {
  await assert.rejects(
    execFileWithInput(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      "",
      { cwd: process.cwd(), timeoutMs: 50 }
    ),
    /timed out after 50ms/
  );
});
