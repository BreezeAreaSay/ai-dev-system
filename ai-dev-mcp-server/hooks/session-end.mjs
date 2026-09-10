#!/usr/bin/env node
// Stop / SessionEnd / PreCompact: distill the transcript into a session record
// (user requests, files modified, tools used) so resume_session and the next
// SessionStart have something even when the agent forgot to call save_session.
import fs from "node:fs";
import path from "node:path";
import { git, hooksDisabled, normalizeInput, projectIdOf, projectRootOf, readStdin, stateRoot } from "./lib.mjs";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((item) => item && item.type === "text").map((item) => item.text || "").join(" ");
  return "";
}

function extract(transcriptPath) {
  let text = "";
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size > MAX_TRANSCRIPT_BYTES) return null;
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const userMessages = [];
  const tools = new Set();
  const files = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.type || entry.message?.role || entry.role;
    if (role === "user") {
      const content = entry.message?.content ?? entry.content;
      if (Array.isArray(content) && content.some((item) => item && item.type === "tool_result")) continue;
      const cleaned = textOf(content).replace(/\s+/g, " ").trim();
      if (cleaned && !/^<(local-command|command-|system-reminder|task-notification)/i.test(cleaned)) userMessages.push(cleaned.slice(0, 240));
    }
    if (role === "assistant" && Array.isArray(entry.message?.content)) {
      for (const blockItem of entry.message.content) {
        if (blockItem?.type !== "tool_use") continue;
        if (blockItem.name) tools.add(blockItem.name);
        const filePath = blockItem.input?.file_path;
        if (filePath && ["Edit", "Write", "MultiEdit"].includes(blockItem.name)) files.add(String(filePath));
      }
    }
  }
  if (userMessages.length === 0) return null;
  return { userMessages, tools: [...tools].slice(0, 20), files: [...files].slice(0, 30) };
}

async function main() {
  const compact = process.argv.includes("--compact");
  const { raw } = await readStdin();
  if (hooksDisabled(compact ? "pre:compact" : "session:end")) process.exit(0);
  const input = normalizeInput(raw);
  if (input.payload.stop_hook_active) process.exit(0);
  if (!input.transcriptPath) process.exit(0);
  const summary = extract(input.transcriptPath);
  if (!summary || summary.userMessages.length < 2) process.exit(0);
  const projectRoot = projectRootOf(input.cwd);
  const projectId = projectIdOf(projectRoot, Boolean(git(projectRoot, ["rev-parse", "--show-toplevel"])));
  const directory = path.join(stateRoot(), "sessions", projectId);
  fs.mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    schema_version: 1,
    id: `session-hook-${input.sessionId}`,
    saved_at: now,
    project_id: projectId,
    project_path: projectRoot,
    project_name: path.basename(projectRoot),
    task_id: "",
    branch: git(projectRoot, ["branch", "--show-current"]),
    worktree: projectRoot,
    source: "hook",
    client: process.argv.includes("--cursor") ? "cursor" : "claude-code",
    session_id: input.sessionId,
    topic: summary.userMessages[0].slice(0, 120),
    building: `Requests in this session (${summary.userMessages.length}):\n${summary.userMessages.slice(-8).map((item) => `- ${item}`).join("\n")}`,
    worked: [],
    failed: [],
    untried: [],
    files: summary.files.map((filePath) => ({ path: path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath, status: "in_progress", notes: "touched this session (hook capture)" })),
    decisions: [],
    blockers: [],
    next_step: "",
    environment: "",
    tools_used: summary.tools,
    captured_by: compact ? "pre-compact" : "stop"
  };
  const target = path.join(directory, `hook-${input.sessionId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev session-end] error: ${error.message}\n`);
  process.exit(0);
});
