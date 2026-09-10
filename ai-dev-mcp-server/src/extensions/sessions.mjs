import fs from "node:fs/promises";
import path from "node:path";
import { contextPackFreshness } from "../core/context-compiler.mjs";
import {
  FILE_STATUSES,
  HANDOFF_RELATIVE_PATH,
  estimateContextBudget,
  renderHandoffMarkdown,
  renderResumeBriefing,
  writeHandoffProjection
} from "../core/session-memory.mjs";

async function sizeOf(target) {
  try {
    return (await fs.stat(target)).size;
  } catch {
    return 0;
  }
}

async function directoryChars(directory) {
  let total = 0;
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) total += await sizeOf(target);
    }
  }
  await walk(directory);
  return total;
}

/**
 * Session memory tools: save a structured handoff, resume from the latest one
 * with a briefing, and estimate the static context budget of a task.
 *
 * @param {{ sessionStore: import("../core/session-memory.mjs").SessionStore, taskStore: { read: Function, list: Function, checkpoint: Function }, resolveProjectIdentity: Function, captureProjectState: Function, detectProject?: Function, vaultRoot?: string, instinctStore?: { rankForContext: Function } }} host
 */
export function createSessionTools(host) {
  async function projectFor({ project_path, task_id }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      const identity = await host.resolveProjectIdentity(record.project.path);
      return { identity, record };
    }
    if (!project_path) throw new Error("project_path or task_id is required.");
    return { identity: await host.resolveProjectIdentity(project_path), record: null };
  }

  return {
    definitions: [
      {
        name: "save_session",
        description: "Save a structured session handoff (what we are building, what worked with evidence, what failed and why, untried ideas, file states, decisions, blockers, exact next step). Stored under ~/.ai-dev/state/sessions and projected to .ai-dev/context/handoff.md so the next session (or a compaction) resumes from facts.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            topic: { type: "string", description: "One line: what this session was about." },
            building: { type: "string", description: "1-3 paragraphs a person with zero memory could act on." },
            worked: { type: "array", items: { type: "object", properties: { item: { type: "string" }, evidence: { type: "string" } }, required: ["item"] }, default: [] },
            failed: { type: "array", items: { type: "object", properties: { approach: { type: "string" }, reason: { type: "string" } }, required: ["approach"] }, default: [] },
            untried: { type: "array", items: { type: "string" }, default: [] },
            files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, status: { type: "string", enum: FILE_STATUSES }, notes: { type: "string" } }, required: ["path"] }, default: [] },
            decisions: { type: "array", items: { type: "object", properties: { decision: { type: "string" }, reason: { type: "string" } }, required: ["decision"] }, default: [] },
            blockers: { type: "array", items: { type: "string" }, default: [] },
            next_step: { type: "string", description: "The single most important thing to do when resuming." },
            environment: { type: "string" },
            client: { type: "string", description: "claude-code, cursor, codex, ..." },
            session_id: { type: "string" }
          }
        }
      },
      {
        name: "resume_session",
        description: "Load the latest substantive session handoff for a project (or a specific session id) and return a resume briefing: what not to retry, blockers, next step, open tasks, git state, context-pack freshness, and relevant learned instincts. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            session_id: { type: "string" },
            limit_history: { type: "number", default: 5 }
          },
          required: ["project_path"]
        }
      },
      {
        name: "context_budget_status",
        description: "Estimate the static context overhead of a task (compiled pack, routed skills, rules, AGENTS.md) against the model window and advise when to compact: at phase boundaries after checkpoint/verify, never mid-edit.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            window_tokens: { type: "number", default: 200000 }
          },
          required: ["task_id"]
        }
      }
    ],
    handlers: {
      async save_session(args) {
        const { identity, record } = await projectFor(args);
        const state = await host.captureProjectState(identity.project_root);
        const saved = await host.sessionStore.save({
          projectId: identity.project_id,
          projectPath: identity.project_root,
          projectName: record?.project?.name || path.basename(identity.project_root),
          taskId: record?.id || "",
          branch: state.branch || "",
          worktree: identity.project_root,
          client: args.client,
          sessionId: args.session_id,
          source: "agent",
          topic: args.topic,
          building: args.building,
          worked: args.worked,
          failed: args.failed,
          untried: args.untried,
          files: args.files,
          decisions: args.decisions,
          blockers: args.blockers,
          next_step: args.next_step,
          environment: args.environment
        });
        const handoffPath = await writeHandoffProjection(identity.project_root, saved.record);
        let checkpoint = null;
        if (record && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Session saved: ${saved.record.topic}`,
            changedFiles: [],
            notes: `Handoff: ${saved.path}\nNext step: ${saved.record.next_step || "not set"}`
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        return {
          action: "session_saved",
          session_id: saved.record.id,
          path: saved.path,
          handoff_path: handoffPath,
          project_id: identity.project_id,
          markdown: renderHandoffMarkdown(saved.record),
          checkpoint,
          next_step: saved.record.next_step
            ? "Safe to compact or end the session; resume_session restores this handoff."
            : "Record an exact next step so the next session does not have to rediscover it."
        };
      },
      async resume_session(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const record = args.session_id
          ? await host.sessionStore.read(identity.project_id, args.session_id)
          : await host.sessionStore.latest(identity.project_id);
        const history = await host.sessionStore.list(identity.project_id, { limit: args.limit_history || 5 });
        const tasks = (await host.taskStore.list({ projectPath: identity.project_root, limit: 20 }))
          .filter((task) => ["active", "verified"].includes(task.status));
        const state = await host.captureProjectState(identity.project_root);
        let freshness = null;
        try {
          const latest = JSON.parse(await fs.readFile(path.join(identity.project_root, ".ai-dev", "context", "latest.json"), "utf8"));
          freshness = { compiled: true, ...contextPackFreshness(latest, state) };
        } catch {
          freshness = { compiled: false, fresh: false };
        }
        let instincts = "";
        if (host.instinctStore) {
          const detected = host.detectProject ? await host.detectProject(identity.project_root).catch(() => null) : null;
          const ranked = await host.instinctStore.rankForContext({
            projectId: identity.project_id,
            stack: detected?.stack ?? [],
            task: record?.next_step || record?.topic || ""
          });
          instincts = ranked.markdown || "";
        }
        return {
          project_id: identity.project_id,
          project_path: identity.project_root,
          session: record,
          history: history.map((item) => ({ id: item.id, saved_at: item.saved_at, topic: item.topic, task_id: item.task_id, substance_score: item.substance_score })),
          open_tasks: tasks.map((task) => ({ id: task.id, status: task.status, task: task.task, plan_required: Boolean(task.plan_policy?.plan_required), plan_recorded: Boolean(task.plan) })),
          git: { branch: state.branch || "", dirty: Boolean(state.dirty), dirty_files: state.dirty_files ?? [] },
          context_pack: freshness,
          handoff_path: HANDOFF_RELATIVE_PATH,
          briefing: renderResumeBriefing({ record, tasks, git: state, freshness, instincts })
        };
      },
      async context_budget_status(args) {
        const record = await host.taskStore.read(args.task_id);
        const identity = await host.resolveProjectIdentity(record.project.path);
        let skillChars = 0;
        for (const skill of record.skills ?? []) {
          if (skill.path && host.vaultRoot) skillChars += await sizeOf(path.join(host.vaultRoot, ...String(skill.path).split("/")));
        }
        const budget = estimateContextBudget({
          contextPackChars: String(record.context?.compiled_context || "").length,
          skillChars,
          rulesChars: await directoryChars(path.join(identity.project_root, ".ai-dev", "rules")),
          agentsChars: await sizeOf(path.join(identity.project_root, "AGENTS.md")),
          checkpoints: record.checkpoints?.length ?? 0,
          verifications: record.verifications?.length ?? 0,
          windowTokens: args.window_tokens
        });
        return { task_id: record.id, status: record.status, ...budget };
      }
    },
    readOnly: ["resume_session", "context_budget_status"]
  };
}
