/**
 * What the page may ask the main process for. The preload exposes exactly
 * these channels; the main process answers only these, only from the app's
 * own page, and calls only the tools named here — a page that something
 * managed to run script in still cannot reach a tool the interface has no
 * button for.
 */

/** Every channel the page invokes, and what it does. */
export const INVOKE_CHANNELS = Object.freeze({
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  call: "ai-dev:call",
  cancel: "ai-dev:cancel",
  chooseFolder: "ai-dev:choose-folder",
  setLanguage: "ai-dev:set-language"
});

/** Every channel the main process sends the page. */
export const EVENT_CHANNELS = Object.freeze({
  state: "ai-dev:state-changed",
  progress: "ai-dev:progress"
});

/**
 * The tools the interface calls. The rest of the control API (`model_remove`,
 * `clients_remove`) and the agent's tools are not here: phase 11's tool
 * console calls them behind a confirmation the main process shows itself.
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
  "rebuild_search_index"
]);

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ARGUMENT_BYTES = 64 * 1024;

/** Why a call from the page is refused, or null when it may go on. */
export function refuseCall(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  const { tool, args = {}, id } = request;
  if (typeof tool !== "string" || !PAGE_TOOLS.includes(tool)) return `The interface does not call ${JSON.stringify(String(tool)).slice(0, 80)}.`;
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
