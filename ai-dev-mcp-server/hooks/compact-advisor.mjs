#!/usr/bin/env node
// PreToolUse (Edit|Write): strategic-compaction advisor. Two signals: the real
// context size from the transcript's latest usage record (primary) and a
// per-session tool-call counter (secondary). Suggests /compact at a logical
// boundary; never blocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitContext, hooksDisabled, loadPolicy, normalizeInput, profileAllows, projectRootOf, readStdin } from "./lib.mjs";

const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

function latestUsage(transcriptPath) {
  let text = "";
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    text = buffer.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const usage = entry.message?.usage || entry.usage;
      if (!usage || typeof usage.input_tokens !== "number") continue;
      const tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      return { tokens, model: String(entry.message?.model || entry.model || "") };
    } catch {
      continue;
    }
  }
  return null;
}

function windowFor(model, tokens) {
  const override = Number(process.env.AI_DEV_CONTEXT_WINDOW_TOKENS || process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || 0);
  if (override > 0) return override;
  // Large-window models advertise it in the model id suffix ("[1m]"); anything
  // else is inferred from the observed token count or the env override above.
  if (model.includes("[1m]")) return LARGE_WINDOW;
  return tokens > STANDARD_WINDOW ? LARGE_WINDOW : STANDARD_WINDOW;
}

function counter(file) {
  let count = 1;
  try {
    count = (Number.parseInt(fs.readFileSync(file, "utf8"), 10) || 0) + 1;
  } catch {
    count = 1;
  }
  try {
    fs.writeFileSync(file, String(count));
  } catch {
    // Counter is best-effort.
  }
  return count;
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("pre:edit:compact-advisor")) process.exit(0);
  const input = normalizeInput(raw);
  const policy = loadPolicy(projectRootOf(input.cwd));
  if (!profileAllows(policy.profile, ["standard", "strict"])) process.exit(0);
  const messages = [];
  const usage = input.transcriptPath ? latestUsage(input.transcriptPath) : null;
  if (usage) {
    const window = windowFor(usage.model, usage.tokens);
    const threshold = Number(policy.compact_context_threshold || (window >= LARGE_WINDOW ? 250_000 : 160_000));
    const interval = Number(policy.compact_context_interval || 60_000);
    if (threshold > 0 && usage.tokens >= threshold) {
      const bucket = Math.floor((usage.tokens - threshold) / interval);
      const bucketFile = path.join(os.tmpdir(), `ai-dev-context-bucket-${input.sessionId}`);
      let last = -1;
      try {
        last = Number.parseInt(fs.readFileSync(bucketFile, "utf8"), 10);
      } catch {
        last = -1;
      }
      if (bucket > last) {
        try { fs.writeFileSync(bucketFile, String(bucket)); } catch { /* best-effort */ }
        messages.push(`[ai-dev compact] Context ~${Math.round(usage.tokens / 1000)}k tokens (${Math.round((usage.tokens / window) * 100)}% of ${Math.round(window / 1000)}k). Finish the current edit, checkpoint_task, save_session, then /compact at this phase boundary.`);
      }
    }
  }
  const threshold = Number(policy.compact_tool_threshold || 50);
  const count = counter(path.join(os.tmpdir(), `ai-dev-tool-count-${input.sessionId}`));
  if (count === threshold) messages.push(`[ai-dev compact] ${threshold} tool calls in this session; if you are between phases, save_session and /compact.`);
  else if (count > threshold && (count - threshold) % 25 === 0) messages.push(`[ai-dev compact] ${count} tool calls; good checkpoint for /compact if the context is stale.`);
  if (messages.length) emitContext("PreToolUse", messages.join("\n"));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev compact] error: ${error.message}\n`);
  process.exit(0);
});
