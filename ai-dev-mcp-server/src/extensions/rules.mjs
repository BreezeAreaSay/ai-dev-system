import {
  RULE_TARGETS,
  RULES_RELATIVE_DIR,
  describeRuleCatalog,
  installProjectRules
} from "../core/rules-library.mjs";
import { packsForStack } from "../core/rules-catalog.mjs";

/**
 * Engineering rules tools: install always-on common rules plus stack packs into
 * a repository as `.ai-dev/rules` (canonical), `.claude/rules` (Claude Code,
 * path-scoped), `.cursor/rules` (Cursor), and an AGENTS.md section.
 *
 * @param {{ resolveProjectIdentity: Function, detectProject: Function, markSearchIndexDirty?: Function }} host
 */
export function createRulesTools(host) {
  return {
    definitions: [
      {
        name: "list_rule_packs",
        description: "List the engineering rules catalog: always-on common rules and per-stack packs with the file globs they apply to.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Optional: also report which packs the detected stack would select." }
          }
        }
      },
      {
        name: "install_project_rules",
        description: "Install engineering rules into a repository: canonical .ai-dev/rules (common + packs chosen from the detected stack), Claude Code .claude/rules projections with paths frontmatter, Cursor .cursor/rules .mdc files, and an Engineering Rules section in AGENTS.md. Existing hand-edited files are kept unless overwrite=true.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            packs: { type: "array", items: { type: "string" }, default: [], description: "Explicit pack ids; auto-detected from the stack when empty." },
            targets: { type: "array", items: { type: "string", enum: RULE_TARGETS }, default: RULE_TARGETS },
            overwrite: { type: "boolean", default: false },
            dry_run: { type: "boolean", default: false }
          },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      async list_rule_packs(args) {
        const catalog = describeRuleCatalog();
        let detected = null;
        if (args.project_path) {
          const identity = await host.resolveProjectIdentity(args.project_path);
          const project = await host.detectProject(identity.project_root);
          detected = {
            project_path: identity.project_root,
            stack: project.stack ?? [],
            project_types: project.project_types ?? [],
            packs: packsForStack(project.stack ?? [], project.project_types ?? [])
          };
        }
        return { ...catalog, targets: RULE_TARGETS, canonical_dir: RULES_RELATIVE_DIR, detected };
      },
      async install_project_rules(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const project = await host.detectProject(identity.project_root);
        const result = await installProjectRules({
          projectRoot: identity.project_root,
          stack: project.stack ?? [],
          projectTypes: project.project_types ?? [],
          packs: args.packs?.length ? args.packs : undefined,
          targets: args.targets?.length ? args.targets : RULE_TARGETS,
          overwrite: Boolean(args.overwrite),
          dryRun: Boolean(args.dry_run)
        });
        if (!args.dry_run && (result.written.length || result.updated.length)) {
          host.markSearchIndexDirty?.("project rules installed");
        }
        return {
          action: args.dry_run ? "rules_planned" : "rules_installed",
          project_path: identity.project_root,
          detected_stack: project.stack ?? [],
          ...result,
          next_step: args.dry_run
            ? "Re-run without dry_run to write the files."
            : `Commit ${RULES_RELATIVE_DIR} (and the harness projections you use) so every agent session loads the same rules.`
        };
      }
    },
    readOnly: ["list_rule_packs"]
  };
}
