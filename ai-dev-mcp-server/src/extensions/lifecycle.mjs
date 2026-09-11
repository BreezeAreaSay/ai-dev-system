/**
 * The MCP surface over the task lifecycle.
 *
 * Four tools, one arc: `begin_task` opens a task against a compiled context
 * pack and at most three routed skills, `checkpoint_task` records progress
 * against its acceptance criteria, `verify_task` runs the checks that could
 * prove the work, and `complete_task` closes it and writes down what happened.
 *
 * Everything the arc touches arrives through `host`: the task store, project
 * identity and detection, project state capture, the frontend product state,
 * the Archify receipt store and the project-card writers. The four sibling
 * tools it drives — `recommend_skills`, `run_quality_gate`, `run_frontend_qa`
 * and `prepare_pull_request` — arrive the same way, as host wrappers over the
 * registry, so each stays the single implementation of its own job and none of
 * these calls is counted twice in the usage ledger.
 *
 * The judgements are pure and live in `src/core`: whether a run passed and
 * what it proves in `task-verification.mjs`, the completion note and what to
 * do next with the branch in `task-completion.mjs`.
 */
import crypto from "node:crypto";
import { POLICY_RELATIVE_PATH } from "../core/agent-hooks.mjs";
import {
  archifyDeliveryReceiptMarkdown,
  validateArchifyDeliveryReceipt,
  validateArchifyVisualCheckEvidence
} from "../core/archify-receipt.mjs";
import { verifyChangeHygiene } from "../core/change-hygiene.mjs";
import {
  completionClaimFailure,
  completionClaimSignals,
  lintCompletionClaims,
  parseCompletionClaimPolicy
} from "../core/completion-claims.mjs";
import { compileContextPack } from "../core/context-compiler.mjs";
import { loadContextExtras } from "../core/context-extras.mjs";
import { bindEvidence } from "../core/evidence.mjs";
import { evaluateFrontendProductGate } from "../core/frontend-product-quality.mjs";
import { taskLooksFrontendProduct } from "../core/skill-recommendation.mjs";
import {
  activeWorktree,
  completionNextSteps,
  taskCompletionMarkdown
} from "../core/task-completion.mjs";
import { withPlanGateWarning } from "../core/task-plans.mjs";
import {
  metAcceptanceCriteria,
  verificationCheckSummary,
  verificationPassed
} from "../core/task-verification.mjs";

/** What an agent should do with a freshly opened task. */
const BEGIN_TASK_NEXT_ACTIONS = [
  "Confirm or refine acceptance criteria with checkpoint_task before broad implementation.",
  "Use the compiled context pack, then read only routed skills and direct dependencies of selected files.",
  "After edits, checkpoint changed files, then run verify_task.",
  "Call complete_task only after every acceptance criterion is met or explicitly waived."
];

/** How much of the repository one task's context pack may carry. */
const CONTEXT_PACK_LIMITS = Object.freeze({ maxSourceFiles: 12, maxChars: 20_000 });

/**
 * The Archify deliverables a task may offer as evidence. Shared by `verify_task`
 * and `complete_task`, which both accept them and both hand them to the same
 * receipt validator.
 */
const ARCHIFY_EVIDENCE_SCHEMA = {
  type: "array",
  default: [],
  description: "Archify deliverables backing acceptance criteria. Pass the `evidence` object returned by archify_deliver / archify_visual_check verbatim.",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["archify_deliver", "archify_visual_check"] },
      html_path: { type: "string" },
      spec_sha256: { type: "string" },
      artifact_sha256: { type: "string" },
      quality: { type: "string" },
      errors: { type: "number" },
      warnings: { type: "number" },
      checks_passed: { type: "number" },
      check_count: { type: "number" },
      status: { type: "string" },
      containment_status: { type: "string" }
    },
    required: ["kind", "html_path"]
  }
};

/**
 * Open a task: detect the project, route skills, compile a context pack and
 * bind a baseline of the working tree to compare later runs against.
 */
async function beginTask(host, {
  project_path,
  task,
  project_name = "",
  acceptance_criteria = []
}) {
  const identity = await host.resolveProjectIdentity(project_path);
  const projectRoot = identity.project_root;
  const detected = {
    ...await host.detectProject(projectRoot, project_name),
    project_id: identity.project_id,
    repository_id: identity.repository_id,
    canonical_project_path: identity.canonical_path,
    project_aliases: identity.aliases
  };
  const [skills, baseline, agents, brief, projectMap, qualityGate] = await Promise.all([
    host.recommendSkills({
      task,
      project_path: projectRoot,
      limit: 3,
      membrane_policy: "exclude"
    }),
    host.captureProjectState(projectRoot),
    host.readProjectTextIfExists(projectRoot, "AGENTS.md"),
    host.readProjectTextIfExists(projectRoot, ".ai-dev/project-brief.md"),
    host.readProjectTextIfExists(projectRoot, ".ai-dev/project-map.md"),
    host.readProjectTextIfExists(projectRoot, ".ai-dev/quality-gate.md")
  ]);
  const contextPack = await compileContextPack({
    projectRoot,
    task,
    project: detected,
    identity,
    acceptanceCriteria: acceptance_criteria,
    skills,
    projectState: baseline,
    agentRules: agents,
    projectBrief: brief,
    projectMap,
    qualityGate,
    extras: await loadContextExtras({ projectRoot, stateRoot: host.taskStateRoot, repositoryId: identity.repository_id, projectId: identity.project_id, task, stack: detected.stack }),
    maxSourceFiles: 12,
    maxChars: 20_000
  });
  const record = await host.taskStore.begin({
    task,
    project: detected,
    skills,
    acceptanceCriteria: acceptance_criteria,
    baseline,
    context: {
      bounded: true,
      context_pack_id: contextPack.id,
      compiled_context: contextPack.markdown,
      selected_files: contextPack.selected_files.map((file) => ({
        path: file.path,
        score: file.score,
        reasons: file.reasons,
        sha256: file.sha256
      })),
      context_unknowns: contextPack.unknowns,
      project_brief_path: ".ai-dev/project-brief.md",
      project_map_path: ".ai-dev/project-map.md",
      quality_gate_path: ".ai-dev/quality-gate.md",
      components: detected.components ?? [],
      architecture: detected.architecture ?? {},
      project_identity: identity
    }
  });
  return {
    ...record,
    next_actions: [
      "Confirm or refine acceptance criteria with checkpoint_task before broad implementation.",
      "Use the compiled context pack, then read only routed skills and direct dependencies of selected files.",
      "After edits, checkpoint changed files, then run verify_task.",
      "Call complete_task only after every acceptance criterion is met or explicitly waived."
    ]
  };
}

/**
 * Hold a report to the evidence behind it: a rationalization ("pre-existing
 * issue", "skipping tests for now", "should work") is refused when the check
 * that would have settled it did not pass. Throws with the reason and the ways
 * out; returns the lint result so a non-blocking finding stays visible.
 *
 * Refusal happens before anything is written, so a rationalized checkpoint
 * records nothing at all.
 *
 * @param {object} host
 * @param {object} record - Task record the report belongs to.
 * @param {{ summary?: string, notes?: string, projectState?: object }} report
 * @returns {Promise<object>} `lintCompletionClaims` result.
 */
async function auditCompletionClaims(host, record, { summary = "", notes = "", projectState = null } = {}) {
  const result = lintCompletionClaims({
    summary,
    notes,
    signals: completionClaimSignals(record, { projectState }),
    policy: parseCompletionClaimPolicy(await host.readProjectTextIfExists(record.project.path, POLICY_RELATIVE_PATH).catch(() => ""))
  });
  if (result.status === "blocked") throw new Error(completionClaimFailure(result));
  return result;
}

/** Record progress against the task's acceptance criteria. */
async function checkpointTask(host, {
  task_id,
  summary,
  changed_files = [],
  criteria = [],
  notes = ""
}) {
  const completionClaims = await auditCompletionClaims(host, await host.taskStore.read(task_id), { summary, notes });
  const record = withPlanGateWarning(await host.taskStore.checkpoint(task_id, {
    summary,
    changedFiles: changed_files,
    criteria,
    notes
  }), changed_files);
  return { ...record, completion_claims: completionClaims };
}

/** Turn supplied Archify evidence into checks, one per delivered artifact. */
async function validateArchifyDeliveryEvidence(host, entries, projectRoot) {
  if (!Array.isArray(entries)) throw new Error("evidence must be an array.");
  const checks = [];
  for (const entry of entries) {
    if (entry?.kind === "archify_visual_check") {
      const htmlPath = host.archifyProjectPath(projectRoot, entry.html_path, "html_path");
      checks.push({
        type: "archify_visual_check",
        result: await validateArchifyVisualCheckEvidence(entry, htmlPath, { receiptsDir: host.archifyReceiptsRoot })
      });
      continue;
    }
    const htmlPath = host.archifyProjectPath(projectRoot, entry.html_path, "html_path");
    checks.push({
      type: "archify_deliver",
      result: await validateArchifyDeliveryReceipt(entry, htmlPath, { receiptsDir: host.archifyReceiptsRoot })
    });
  }
  return checks;
}

/**
 * Run everything that could prove the work, then record the verdict.
 *
 * Each runner is optional and each failure is folded into a check rather than
 * thrown, so one unavailable tool cannot hide the result of the others.
 */
async function verifyTask(host, {
  task_id,
  run_quality = true,
  quality_labels = [],
  run_frontend = false,
  frontend_options = {},
  run_hygiene = true,
  hygiene_base_ref = "HEAD",
  evidence = []
}) {
  const record = await host.taskStore.read(task_id);
  if (record.status === "complete") throw new Error("Completed task cannot be verified again.");
  const projectIdentity = await host.resolveProjectIdentity(record.project.path);
  const projectRoot = projectIdentity.project_root;
  const checks = [];
  checks.push(...await validateArchifyDeliveryEvidence(host, evidence, projectRoot));

  if (run_quality) {
    try {
      checks.push({
        type: "quality_gate",
        result: await host.runQualityGate({
          project_path: projectRoot,
          labels: quality_labels,
          dry_run: false,
          update_registry: false,
          register_if_missing: false
        })
      });
    } catch (error) {
      checks.push({
        type: "quality_gate",
        result: {
          status: "unavailable",
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  if (run_frontend) {
    if (!record.project.types.includes("frontend")) {
      checks.push({
        type: "frontend_qa",
        result: {
          gate: "block",
          status: "not_frontend",
          error: "Task project is not detected as frontend."
        }
      });
    } else {
      try {
        checks.push({
          type: "frontend_qa",
          result: await host.runFrontendQa({
            ...frontend_options,
            project_path: projectRoot,
            project_name: record.project.name,
            update_registry: false,
            register_if_missing: false
          })
        });
      } catch (error) {
        checks.push({
          type: "frontend_qa",
          result: {
            gate: "block",
            status: "unavailable",
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  if (record.project.types.includes("frontend")) {
    const productState = await host.readFrontendProductState(projectRoot, { required: false });
    const frontendProductTask = taskLooksFrontendProduct(record.task);
    if (frontendProductTask) {
      if (!productState) {
        checks.push({
          type: "frontend_product",
          result: {
            ok: false,
            gate: "handoff",
            blockers: ["Frontend Product Quality v2 is not prepared for this visual task."]
          }
        });
      } else {
        const hashes = await host.frontendProductDocumentHashes(projectRoot).catch(() => ({}));
        const artifactStatus = await host.frontendReviewArtifactsCurrent(projectRoot, productState);
        checks.push({
          type: "frontend_product",
          result: {
            ...evaluateFrontendProductGate(productState, {
              gate: "handoff",
              currentDocumentHashes: hashes,
              reviewArtifactsCurrent: artifactStatus.current
            }),
            reviewed_artifacts: artifactStatus
          }
        });
      }
    }
  }

  if (run_hygiene) checks.push({ type: "change_hygiene", result: await verifyChangeHygiene(projectRoot, { baseRef: hygiene_base_ref }) });
  const projectState = await host.captureProjectState(projectRoot);
  const passed = verificationPassed(checks);
  const verification = {
    id: `verification-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    passed,
    checks,
    evidence: bindEvidence({
      type: "task-verification",
      result: { status: passed ? "passed" : "failed" },
      projectState,
      details: { checks: verificationCheckSummary(checks) }
    })
  };
  let updated = await host.taskStore.addVerification(task_id, verification);
  const skillOutcomes = await host.skillOutcomeStore.recordVerification({
    task: updated,
    verification,
    projectState,
    projectIdentity
  });

  if (passed) {
    const criteria = metAcceptanceCriteria({
      acceptanceCriteria: updated.acceptance_criteria,
      checks,
      verificationId: verification.id,
      frontendChecked: run_frontend
    });
    if (criteria.length) {
      updated = await host.taskStore.checkpoint(task_id, {
        summary: "Automated verification passed.",
        criteria,
        notes: `Evidence: ${verification.id}`
      });
    }
  }
  if (checks.some((check) => check.type === "archify_deliver")) {
    try {
      const card = await host.findProjectCard(projectRoot);
      const report = await host.updateProjectCard({ name: card.name, section: "Archify Diagram Deliveries", mode: "replace", content: archifyDeliveryReceiptMarkdown(checks.filter((check) => check.type === "archify_deliver").map((check) => check.result)), update_index: false });
      const synced = await host.syncProjectCard({ project_path: projectRoot, create_if_missing: false, update_index: true });
      verification.registry = { report, synced };
    } catch (error) {
      verification.registry = { action: "skipped", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    task: updated,
    verification,
    skill_outcomes: skillOutcomes,
    current_project_state: projectState
  };
}

/**
 * Turn a finished task's evidence into a pull request description. Completion
 * is the moment every input exists — criteria, checkpoints, the passing
 * verification, the decisions — so the text is prepared here and only linked
 * from `next_step`; nothing is pushed and no pull request is opened.
 */
async function preparePullRequestForTask(host, taskId) {
  try {
    const prepared = await host.preparePullRequest({ task_id: taskId });
    return {
      path: prepared.path,
      title: prepared.title,
      base_ref: prepared.base_ref,
      branch: prepared.branch,
      template: prepared.template?.path || "",
      outstanding: prepared.outstanding,
      commands: prepared.commands
    };
  } catch (error) {
    return { path: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Close the task, write down what happened, and say what is left to do. */
async function completeTask(host, {
  task_id,
  summary,
  allow_waived = false,
  write_report = true,
  prepare_pull_request = true,
  evidence = []
}) {
  if (evidence.length) await verifyTask(host, { task_id, run_quality: false, run_frontend: false, evidence });
  const existing = await host.taskStore.read(task_id);
  const projectIdentity = await host.resolveProjectIdentity(existing.project.path);
  const projectRoot = projectIdentity.project_root;
  const projectState = await host.captureProjectState(projectRoot);
  const completionClaims = await auditCompletionClaims(host, existing, { summary, projectState });
  const record = await host.taskStore.complete(task_id, {
    summary,
    projectState,
    allowWaived: allow_waived
  });
  const completionVerificationIds = new Set(record.completion?.verification_ids || []);
  const finalVerification = [...record.verifications]
    .reverse()
    .find((item) => completionVerificationIds.has(item.id) && item.passed);
  const skillOutcomes = await host.skillOutcomeStore.recordCompletion({
    task: record,
    verification: finalVerification,
    projectState,
    projectIdentity
  });
  let report = null;
  if (write_report) {
    report = await host.writeKnowledgeNote({
      path: `02-knowledge/Task Runs/${record.id}.md`,
      content: taskCompletionMarkdown(record),
      overwrite: true
    });
  }
  const worktree = activeWorktree(record);
  const pullRequest = prepare_pull_request && projectState.git ? await preparePullRequestForTask(host, record.id) : null;
  const nextSteps = completionNextSteps({
    pullRequestPath: pullRequest?.path ?? "",
    hasGit: Boolean(projectState.git),
    worktreeBranch: worktree?.branch ?? ""
  });
  return {
    task: record,
    report,
    skill_outcomes: skillOutcomes,
    completion_claims: completionClaims,
    ...(pullRequest ? { pull_request: pullRequest } : {}),
    ...(worktree ? { worktree } : {}),
    ...(nextSteps.length ? { next_step: nextSteps.join(" ") } : {})
  };
}

/**
 * @param {object} host - Shared runtime services (see `src/tool-extensions.mjs`).
 * @returns {{ definitions: Array<object>, handlers: object, readOnly: Array<string> }}
 */
export function createLifecycleTools(host) {
  return {
    definitions: [
      {
        name: "begin_task",
        description: "Start a bounded engineering task with a compiled task-specific context pack, at most three routed skills, explicit acceptance criteria, risk, and a Git-bound baseline.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            project_name: { type: "string" },
            task: { type: "string" },
            acceptance_criteria: {
              type: "array",
              items: { type: "string" },
              default: []
            }
          },
          required: ["project_path", "task"]
        }
      },
      {
        name: "checkpoint_task",
        description: "Record implementation progress, changed files, and acceptance-criterion evidence before verification. The summary and notes are linted for rationalizations (\"pre-existing issue\", \"skipping tests for now\", \"should work\"): one whose check did not pass is refused unless .ai-dev/policy.json waives that rule and the report states the reason.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            summary: { type: "string" },
            changed_files: {
              type: "array",
              items: { type: "string" },
              default: []
            },
            criteria: {
              type: "array",
              default: [],
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  status: { type: "string", enum: ["pending", "met", "blocked", "waived"] },
                  note: { type: "string" },
                  evidence: { type: "array", items: { type: "string" } }
                },
                required: ["id", "status"]
              }
            },
            notes: { type: "string" }
          },
          required: ["task_id", "summary"]
        }
      },
      {
        name: "verify_task",
        description: "Run the project quality gate and optional Frontend QA, then bind machine-readable evidence to the current Git state.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            run_quality: { type: "boolean", default: true },
            quality_labels: { type: "array", items: { type: "string" }, default: [] },
            run_frontend: { type: "boolean", default: false },
            frontend_options: { type: "object", additionalProperties: true, default: {} },
            run_hygiene: { type: "boolean", default: true, description: "Scan added lines for secrets, debug leftovers, focused/skipped tests, conflict markers, weakened lint configs, and missing test changes. A block finding fails verification." },
            hygiene_base_ref: { type: "string", default: "HEAD", description: "Git ref the hygiene scan diffs against; use the branch base (for example main) to include committed work." },
            evidence: ARCHIFY_EVIDENCE_SCHEMA
          },
          required: ["task_id"]
        }
      },
      {
        name: "complete_task",
        description: "Complete a task only when all acceptance criteria are resolved and passing verification matches the current project state. The summary is linted for rationalizations that no passing check backs (see checkpoint_task).",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            summary: { type: "string" },
            allow_waived: { type: "boolean", default: false },
            write_report: { type: "boolean", default: true },
            prepare_pull_request: { type: "boolean", default: true, description: "Also build the pull request description from the task evidence into .ai-dev/pr/<task_id>.md and link it from next_step." },
            evidence: ARCHIFY_EVIDENCE_SCHEMA
          },
          required: ["task_id", "summary"]
        }
      },
    ],
    handlers: {
      begin_task: (args) => beginTask(host, args),
      checkpoint_task: (args) => checkpointTask(host, args),
      verify_task: (args) => verifyTask(host, args),
      complete_task: (args) => completeTask(host, args)
    },
    readOnly: []
  };
}
