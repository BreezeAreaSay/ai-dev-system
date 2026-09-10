import path from "node:path";
import {
  TASK_BRANCH_PREFIX,
  WORKTREES_DIR,
  createTaskWorktree,
  listTaskWorktrees,
  removeTaskWorktree,
  worktreeName
} from "../core/task-worktrees.mjs";

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected tool result: ${text.slice(0, 200)}`);
  }
}

/**
 * Task worktree tools: one git worktree + branch per task so parallel tasks
 * never share a working tree, and the task record remembers where its code lives.
 *
 * @param {{ callTool: Function, taskStore: { read: Function, update: Function }, resolveProjectIdentity: Function }} host
 */
export function createWorktreeTools(host) {
  return {
    definitions: [
      {
        name: "begin_task_in_worktree",
        description: "Create an isolated git worktree and branch (task/<name> under .worktrees/) from base_ref, copy the agent handoff files into it, then start begin_task inside the worktree. Use for parallel or risky work so the main checkout stays untouched.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path of the main repository (or any of its worktrees)." },
            task: { type: "string" },
            project_name: { type: "string" },
            acceptance_criteria: { type: "array", items: { type: "string" }, default: [] },
            base_ref: { type: "string", default: "HEAD", description: "Commit, branch, or tag the task branch starts from." },
            name: { type: "string", description: "Optional worktree/branch slug; derived from the task text when omitted." }
          },
          required: ["project_path", "task"]
        }
      },
      {
        name: "list_task_worktrees",
        description: "List task worktrees of a repository with branch, dirty state, and commits ahead of the main checkout.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_status: { type: "boolean", default: true }
          },
          required: ["project_path"]
        }
      },
      {
        name: "remove_task_worktree",
        description: "Remove a task worktree after its branch was merged or abandoned. Refuses while uncommitted changes exist unless force=true; optionally deletes the task branch.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task whose worktree is removed (from its record)." },
            worktree_path: { type: "string", description: "Explicit worktree path when no task id is available." },
            force: { type: "boolean", default: false },
            delete_branch: { type: "boolean", default: false }
          }
        }
      }
    ],
    handlers: {
      async begin_task_in_worktree(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const stamp = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
        const name = args.name ? worktreeName(args.name) : `${worktreeName(args.task, 36)}-${stamp}`;
        const worktree = await createTaskWorktree({
          projectRoot: identity.project_root,
          name,
          baseRef: args.base_ref || "HEAD"
        });
        const begun = parseToolText(await host.callTool("begin_task", {
          project_path: worktree.path,
          task: args.task,
          project_name: args.project_name || "",
          acceptance_criteria: args.acceptance_criteria || []
        }));
        const record = await host.taskStore.update(begun.id, (current) => {
          current.context = {
            ...current.context,
            worktree: {
              path: worktree.path,
              branch: worktree.branch,
              base_ref: worktree.base_ref,
              main_root: worktree.main_root,
              created: worktree.created
            }
          };
          return current;
        });
        return {
          ...begun,
          context: record.context,
          worktree,
          next_actions: [
            `Work only inside ${worktree.path} (branch ${worktree.branch}); commit there.`,
            ...(begun.next_actions ?? []),
            "After complete_task, merge or open a PR from the task branch, then call remove_task_worktree."
          ]
        };
      },
      async list_task_worktrees(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const listed = await listTaskWorktrees({
          projectRoot: identity.project_root,
          includeStatus: args.include_status !== false
        });
        return {
          ...listed,
          worktrees_dir: WORKTREES_DIR,
          branch_prefix: TASK_BRANCH_PREFIX,
          count: listed.worktrees.length
        };
      },
      async remove_task_worktree(args) {
        let worktreePath = args.worktree_path ? path.resolve(args.worktree_path) : "";
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          worktreePath = record.context?.worktree?.path || worktreePath;
          if (!worktreePath) throw new Error(`Task ${args.task_id} has no recorded worktree.`);
          if (record.status !== "complete" && !args.force) {
            throw new Error(`Task ${args.task_id} is ${record.status}; complete it first or pass force=true.`);
          }
        }
        if (!worktreePath) throw new Error("task_id or worktree_path is required.");
        const projectRoot = record?.context?.worktree?.main_root || path.dirname(path.dirname(worktreePath));
        const removed = await removeTaskWorktree({
          projectRoot,
          worktreePath,
          force: Boolean(args.force),
          deleteBranch: Boolean(args.delete_branch)
        });
        if (record) {
          await host.taskStore.update(record.id, (current) => {
            current.context = { ...current.context, worktree: { ...current.context.worktree, removed_at: new Date().toISOString() } };
            return current;
          });
        }
        return { action: "worktree_removed", task_id: record?.id || null, ...removed };
      }
    },
    readOnly: ["list_task_worktrees"]
  };
}
