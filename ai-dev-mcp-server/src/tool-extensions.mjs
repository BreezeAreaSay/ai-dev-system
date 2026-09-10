/**
 * Registry for MCP tool extensions that live outside `mcp-stdio.mjs`.
 *
 * Extension factories return MCP definitions, their handlers, and optional
 * read-only tool names. New extension modules must not import the runtime
 * module: shared services are received through `host` instead.
 */

import { createPlanTools } from "./extensions/plans.mjs";
import { createHygieneTools } from "./extensions/hygiene.mjs";
import { createDecisionTools } from "./extensions/decisions.mjs";
import { createInstinctTools } from "./extensions/instincts.mjs";
import { createSessionTools } from "./extensions/sessions.mjs";
import { createRulesTools } from "./extensions/rules.mjs";
import { createHookTools } from "./extensions/hooks.mjs";
import { createWorktreeTools } from "./extensions/worktrees.mjs";
import { createUsageTools } from "./extensions/usage.mjs";

export const EXTENSION_FACTORIES = [createDecisionTools, createHygieneTools, createInstinctTools, createPlanTools, createSessionTools, createRulesTools, createHookTools, createWorktreeTools, createUsageTools];

/**
 * Compose registered extensions into tool definitions, a dispatch map, and
 * read-only hints. Invalid contracts fail at startup before an MCP client can
 * discover a broken tool.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 * @param {Array<(host: object) => { definitions?: object[], handlers?: Record<string, Function>, readOnly?: string[] }>} [factories]
 * @returns {{ definitions: object[], handlers: Map<string, Function>, readOnly: string[] }}
 */
export function createExtensionTools(host, factories = EXTENSION_FACTORIES) {
  const definitions = [];
  const handlers = new Map();
  const readOnly = new Set();
  for (const factory of factories) {
    if (typeof factory !== "function") throw new Error("Extension factory must be a function.");
    const extension = factory(host) ?? {};
    for (const definition of extension.definitions ?? []) {
      const name = String(definition?.name || "");
      if (!name) throw new Error("Extension tool definition has no name.");
      if (handlers.has(name)) throw new Error(`Duplicate extension tool: ${name}`);
      const handler = extension.handlers?.[name];
      if (typeof handler !== "function") throw new Error(`Extension tool has no handler: ${name}`);
      if (definition.inputSchema?.type !== "object") {
        throw new Error(`Extension tool inputSchema must be an object schema: ${name}`);
      }
      definitions.push(definition);
      handlers.set(name, handler);
    }
    for (const name of extension.readOnly ?? []) {
      if (!handlers.has(name)) throw new Error(`readOnly names an unknown extension tool: ${name}`);
      readOnly.add(name);
    }
  }
  return { definitions, handlers, readOnly: [...readOnly] };
}
