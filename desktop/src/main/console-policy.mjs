/**
 * The tool console's rule, kept in the main process: the page may call any
 * tool the daemon lists to the app's session, and one that changes something
 * runs only after the person confirms it in a dialog the main process shows.
 * Which tool only reads is the daemon's word — its `readOnlyHint` — never the
 * page's: a page that something managed to run script in can open the dialog,
 * but cannot answer it or skip it.
 */
import { refuseRequest } from "./ipc-policy.mjs";

/** How much of the arguments the confirmation dialog shows. */
const DETAIL_LIMIT = 1500;

/**
 * What the console knows of each tool the daemon lists: name, title,
 * description, input schema, and whether it only reads or deletes.
 *
 * @param {Array<{ name: string, title?: string, description?: string, inputSchema?: object, annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean } }>} listed
 */
export function consoleTools(listed) {
  return (Array.isArray(listed) ? listed : [])
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      name: tool.name,
      title: String(tool.title ?? tool.annotations?.title ?? tool.name),
      description: String(tool.description ?? ""),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * What to do with a call from the console: refuse it, run it, or ask first.
 *
 * @param {unknown} request - `{ tool, args, id }` from the page.
 * @param {ReturnType<typeof consoleTools>} tools - What the daemon lists.
 * @returns {{ refused: string } | { tool: object, args: object, id: string, confirm: boolean }}
 */
export function consoleDecision(request, tools) {
  const refused = refuseRequest(request);
  if (refused) return { refused };
  const tool = tools.find((entry) => entry.name === request.tool);
  if (!tool) return { refused: `The daemon lists no tool ${JSON.stringify(String(request.tool)).slice(0, 80)} to this app.` };
  return { tool, args: request.args ?? {}, id: request.id, confirm: !tool.readOnly };
}

/**
 * The confirmation the main process shows before a tool that changes
 * something runs: what runs, with what, and Cancel as the default.
 *
 * @param {{ name: string, title: string, destructive: boolean }} tool
 * @param {object} args
 * @param {(key: string, params?: object) => string} t
 */
export function confirmationDialog(tool, args, t) {
  let shown = JSON.stringify(args, null, 2);
  if (shown.length > DETAIL_LIMIT) shown = `${shown.slice(0, DETAIL_LIMIT)}\n…`;
  const lines = [t(tool.destructive ? "console.confirm.destructive" : "console.confirm.changes"), "", t("console.confirm.arguments"), shown];
  return {
    type: tool.destructive ? "warning" : "question",
    buttons: [t("console.confirm.run"), t("common.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t("console.confirm.title"),
    message: t("console.confirm.message", { tool: tool.name }),
    detail: lines.join("\n")
  };
}
