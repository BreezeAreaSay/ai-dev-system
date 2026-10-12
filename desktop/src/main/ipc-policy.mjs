/**
 * What the page may ask the main process for. The preload exposes exactly
 * these channels; the main process answers only these, only from the app's
 * own page. The screens call only the tools named here; any other tool goes
 * through the tool console, where one that changes something runs only after
 * the person confirms it in the main process (console-policy.mjs) — a page
 * that something managed to run script in still cannot change anything the
 * person did not agree to.
 */

/** Every channel the page invokes, and what it does. */
export const INVOKE_CHANNELS = Object.freeze({
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  call: "ai-dev:call",
  cancel: "ai-dev:cancel",
  chooseFolder: "ai-dev:choose-folder",
  setLanguage: "ai-dev:set-language",
  tools: "ai-dev:tools",
  consoleCall: "ai-dev:console-call",
  reconnect: "ai-dev:reconnect"
});

/** Every channel the main process sends the page. */
export const EVENT_CHANNELS = Object.freeze({
  state: "ai-dev:state-changed",
  progress: "ai-dev:progress"
});

/**
 * The tools the screens call: the control API's buttons and the read-only
 * tools the data screens show. The rest of the control API (`model_remove`,
 * `clients_remove`) and the agent's tools that change something are not here:
 * the tool console calls them behind a confirmation the main process shows.
 */
export const PAGE_TOOLS = Object.freeze([
  "system_status",
  "setup_run",
  "model_install",
  "model_import",
  "model_verify",
  "clients_list",
  "clients_install",
  "logs_tail",
  "settings_get",
  "settings_set",
  "workspace_overview",
  "rebuild_search_index",
  "list_projects",
  "read_project",
  "list_tasks",
  "epic_status",
  "list_decisions",
  "list_sessions",
  "usage_report",
  "search_skills",
  "read_skill",
  "list_skill_groups",
  "browse_skill_group"
]);

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ARGUMENT_BYTES = 64 * 1024;

/** Why a call from a screen is refused, or null when it may go on. */
export function refuseCall(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  if (typeof request.tool !== "string" || !PAGE_TOOLS.includes(request.tool)) return `The interface does not call ${JSON.stringify(String(request.tool)).slice(0, 80)}.`;
  return refuseRequest(request);
}

/** Why a call is malformed — its id, its arguments — or null; which tool it names is the caller's rule. */
export function refuseRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  const { tool, args = {}, id } = request;
  if (typeof tool !== "string" || !tool) return "A call names a tool.";
  if (typeof id !== "string" || !CALL_ID.test(id)) return "A call's id is 1 to 64 letters, digits, - or _.";
  if (!args || typeof args !== "object" || Array.isArray(args)) return "A call's arguments are an object.";
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(args));
  } catch {
    return "A call's arguments must be plain JSON.";
  }
  if (size > MAX_ARGUMENT_BYTES) return `A call's arguments are at most ${MAX_ARGUMENT_BYTES} bytes.`;
  return null;
}

/** Whether a call id is well formed (cancel, progress). */
export function validCallId(id) {
  return typeof id === "string" && CALL_ID.test(id);
}
