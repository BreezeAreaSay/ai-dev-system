import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function readReceipt(receiptsDir, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(receiptsDir, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Persist a trustworthy `archify_deliver` receipt keyed by the delivered
 * artifact's SHA-256. Only the real `archify_deliver` tool — which actually
 * runs the renderer and validator — calls this; `verify_task` reads it back
 * instead of trusting client-supplied quality numbers.
 *
 * @param {string} receiptsDir - Server-owned receipt directory.
 * @param {{ artifact_sha256: string, spec_sha256?: string, quality?: string, errors?: number, warnings?: number, checks_passed?: number, check_count?: number, html_path?: string }} receipt
 */
export async function storeDeliveryReceipt(receiptsDir, receipt) {
  if (!receiptsDir) throw new Error("Archify receipt store is not configured.");
  if (!isSha256(receipt?.artifact_sha256)) {
    throw new Error("A delivery receipt requires a SHA-256 artifact hash.");
  }
  await fs.mkdir(receiptsDir, { recursive: true });
  await atomicWriteJson(path.join(receiptsDir, `${receipt.artifact_sha256.toLowerCase()}.json`), {
    kind: "archify_deliver",
    artifact_sha256: receipt.artifact_sha256.toLowerCase(),
    spec_sha256: isSha256(receipt.spec_sha256) ? receipt.spec_sha256.toLowerCase() : null,
    quality: receipt.quality ?? null,
    errors: finiteNumber(receipt.errors),
    warnings: finiteNumber(receipt.warnings),
    checks_passed: finiteNumber(receipt.checks_passed),
    check_count: finiteNumber(receipt.check_count),
    html_path: receipt.html_path ?? null,
    recorded_at: new Date().toISOString()
  });
}

/**
 * Persist an `archify_visual_check` receipt keyed by the checked artifact's
 * SHA-256.
 */
export async function storeVisualCheckReceipt(receiptsDir, receipt) {
  if (!receiptsDir) throw new Error("Archify receipt store is not configured.");
  if (!isSha256(receipt?.artifact_sha256)) {
    throw new Error("A visual-check receipt requires a SHA-256 artifact hash.");
  }
  await fs.mkdir(receiptsDir, { recursive: true });
  await atomicWriteJson(path.join(receiptsDir, `visual-${receipt.artifact_sha256.toLowerCase()}.json`), {
    kind: "archify_visual_check",
    artifact_sha256: receipt.artifact_sha256.toLowerCase(),
    containment_status: receipt.containment_status ?? null,
    status: receipt.status ?? null,
    recorded_at: new Date().toISOString()
  });
}

/**
 * Validate an `archify_deliver` acceptance-criterion claim. The artifact on disk
 * is hashed and matched against a **server-recorded** receipt from a real
 * `archify_deliver` run; the client's own quality / error / check numbers are
 * ignored entirely. A missing receipt or an unmet bar is returned as
 * `{ ok: false, problems: [...] }`; only a malformed call throws.
 *
 * @param {{ kind?: string, html_path?: string }} evidence - Client evidence entry (only `kind` / path matter).
 * @param {string} artifactPath - Resolved path to the delivered artifact.
 * @param {{ receiptsDir?: string }} [options]
 */
export async function validateArchifyDeliveryReceipt(evidence, artifactPath, { receiptsDir } = {}) {
  if (!evidence || evidence.kind !== "archify_deliver") {
    throw new Error("Only archify_deliver evidence is supported.");
  }
  if (!receiptsDir) {
    throw new Error("Archify receipt store is not configured.");
  }

  const artifactSha256 = await sha256File(artifactPath);
  const stored = await readReceipt(receiptsDir, artifactSha256);
  if (!stored) {
    return {
      ok: false,
      status: "failed",
      kind: "archify_deliver",
      html_path: artifactPath,
      artifact_sha256: artifactSha256,
      problems: [
        "no archify_deliver receipt is recorded for this artifact hash; run archify_deliver so the server can verify it"
      ]
    };
  }

  const quality = String(stored.quality || "");
  const errors = finiteNumber(stored.errors);
  const warnings = finiteNumber(stored.warnings);
  const checksPassed = finiteNumber(stored.checks_passed);
  const checkCount = finiteNumber(stored.check_count);

  const problems = [];
  if (quality !== "showcase") {
    problems.push(`quality profile is "${quality || "unknown"}", expected "showcase"`);
  }
  if (errors === null || errors > 0) {
    problems.push(`${stored.errors ?? "unknown"} composition error(s)`);
  }
  if (warnings === null || warnings > 0) {
    problems.push(`${stored.warnings ?? "unknown"} composition warning(s)`);
  }
  if (checkCount === null || checkCount < 9) {
    problems.push(`${stored.check_count ?? "unknown"} artifact checks (showcase acceptance needs 9)`);
  }
  if (checksPassed === null || checkCount === null || checksPassed < checkCount) {
    problems.push(`${stored.checks_passed ?? "unknown"}/${stored.check_count ?? "unknown"} artifact checks passed`);
  }

  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? "passed" : "failed",
    kind: "archify_deliver",
    html_path: artifactPath,
    spec_sha256: stored.spec_sha256 || null,
    artifact_sha256: artifactSha256,
    quality,
    errors,
    warnings,
    checks_passed: checksPassed,
    check_count: checkCount,
    recorded_at: stored.recorded_at || null,
    problems
  };
}

/**
 * Validate an `archify_visual_check` acceptance-criterion claim against a
 * server-recorded receipt from a real `archify_visual_check` run. Passes only
 * when the recorded browser containment check reported no overflow.
 *
 * @param {{ kind?: string, html_path?: string }} entry
 * @param {string} artifactPath
 * @param {{ receiptsDir?: string }} [options]
 */
export async function validateArchifyVisualCheckEvidence(entry, artifactPath, { receiptsDir } = {}) {
  if (!entry || entry.kind !== "archify_visual_check") {
    throw new Error("Only archify_visual_check evidence is supported.");
  }
  if (!receiptsDir) {
    throw new Error("Archify receipt store is not configured.");
  }
  const artifactSha256 = await sha256File(artifactPath);
  const stored = await readReceipt(receiptsDir, `visual-${artifactSha256}`);
  if (!stored) {
    return {
      ok: false,
      status: "failed",
      kind: "archify_visual_check",
      html_path: artifactPath,
      artifact_sha256: artifactSha256,
      containment_status: "unrecorded",
      visual_check_status: "unrecorded"
    };
  }
  const containment = String(stored.containment_status || "");
  const overall = String(stored.status || "");
  const ok = containment === "pass" && (overall === "" || overall === "pass");
  return {
    ok,
    status: ok ? "passed" : "failed",
    kind: "archify_visual_check",
    html_path: artifactPath,
    artifact_sha256: artifactSha256,
    containment_status: containment || "unknown",
    visual_check_status: overall || "unknown"
  };
}

export function archifyDeliveryReceiptMarkdown(receipts) {
  const lines = [
    "# Archify Diagram Deliveries",
    "",
    "| HTML | Quality | Errors | Warnings | Checks | Artifact SHA-256 |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const receipt of receipts) {
    lines.push(`| ${receipt.html_path} | ${receipt.quality || "—"} | ${receipt.errors ?? "—"} | ${receipt.warnings ?? "—"} | ${receipt.checks_passed ?? "—"}/${receipt.check_count ?? "—"} | ${receipt.artifact_sha256} |`);
  }
  return lines.join("\n");
}
