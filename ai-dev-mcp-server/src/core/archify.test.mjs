import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ARCHIFY_TYPES, archifyCliPath, runArchify } from "./archify.mjs";
import {
  storeDeliveryReceipt,
  storeVisualCheckReceipt,
  validateArchifyDeliveryReceipt,
  validateArchifyVisualCheckEvidence
} from "./archify-receipt.mjs";
import { vaultRoot } from "../mcp-stdio.mjs";

const cliPath = archifyCliPath(vaultRoot);
const available = existsSync(cliPath);

test("Archify core exposes all supported diagram types and resolves its vendored CLI path", () => {
  assert.deepEqual(ARCHIFY_TYPES, ["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
  assert.equal(cliPath, path.join(vaultRoot, "03-skills-catalog", "sources", "external", "archify", "bin", "archify.mjs"));
});

test("Archify core runs doctor shell-free", { skip: available ? false : "vendored Archify is unavailable" }, async () => {
  const result = await runArchify({ vaultRoot, args: ["doctor"], cwd: path.dirname(cliPath) });
  assert.equal(result.ok, true, result.stderr || result.stdout);
  assert.match(result.stdout, /Archify is ready\./);
});

test("delivery receipt validation trusts only the server-recorded receipt", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archify-receipt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, "receipts");
  const htmlPath = path.join(dir, "diagram.html");
  const sha = async () => crypto.createHash("sha256").update(await fs.readFile(htmlPath)).digest("hex");
  const evidence = { kind: "archify_deliver", html_path: htmlPath };

  await fs.writeFile(htmlPath, "<html>diagram</html>", "utf8");

  // A forged claim with no server receipt fails without throwing.
  const forged = await validateArchifyDeliveryReceipt(evidence, htmlPath, { receiptsDir });
  assert.equal(forged.ok, false);
  assert.match(forged.problems.join(" "), /no archify_deliver receipt/i);

  // A genuine showcase receipt passes.
  await storeDeliveryReceipt(receiptsDir, {
    artifact_sha256: await sha(), spec_sha256: "a".repeat(64),
    quality: "showcase", errors: 0, warnings: 0, checks_passed: 9, check_count: 9
  });
  assert.equal((await validateArchifyDeliveryReceipt(evidence, htmlPath, { receiptsDir })).ok, true);

  // Editing the artifact after delivery breaks the hash → no matching receipt.
  await fs.writeFile(htmlPath, "<html>tampered</html>", "utf8");
  assert.equal((await validateArchifyDeliveryReceipt(evidence, htmlPath, { receiptsDir })).ok, false);

  // A recorded sub-showcase receipt is reported, not the caller's numbers.
  await fs.writeFile(htmlPath, "<html>v3</html>", "utf8");
  await storeDeliveryReceipt(receiptsDir, {
    artifact_sha256: await sha(), quality: "standard", errors: 0, warnings: 2, checks_passed: 9, check_count: 9
  });
  const standard = await validateArchifyDeliveryReceipt(evidence, htmlPath, { receiptsDir });
  assert.equal(standard.ok, false);
  assert.match(standard.problems.join(" "), /quality profile|warning/);
});

test("visual-check evidence trusts only the server-recorded receipt", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archify-visual-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const receiptsDir = path.join(dir, "receipts");
  const htmlPath = path.join(dir, "x.html");
  await fs.writeFile(htmlPath, "<html>x</html>", "utf8");
  const artifactSha = crypto.createHash("sha256").update(await fs.readFile(htmlPath)).digest("hex");
  const evidence = { kind: "archify_visual_check", html_path: htmlPath, status: "pass", containment_status: "pass" };

  assert.equal((await validateArchifyVisualCheckEvidence(evidence, htmlPath, { receiptsDir })).ok, false);

  await storeVisualCheckReceipt(receiptsDir, { artifact_sha256: artifactSha, status: "pass", containment_status: "pass" });
  assert.equal((await validateArchifyVisualCheckEvidence(evidence, htmlPath, { receiptsDir })).ok, true);

  await storeVisualCheckReceipt(receiptsDir, { artifact_sha256: artifactSha, status: "fail", containment_status: "fail" });
  assert.equal((await validateArchifyVisualCheckEvidence(evidence, htmlPath, { receiptsDir })).ok, false);
});
