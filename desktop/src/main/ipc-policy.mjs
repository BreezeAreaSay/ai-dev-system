/**
 * What the page may ask the main process for. The preload exposes exactly
 * these channels; the main process answers only these, only from the app's
 * own page, and calls only the tools named here with only the arguments the
 * interface sends — a page that something managed to run script in still
 * cannot do what the interface has no button for.
 */

/** Every channel the page invokes, and what it does. */
export const INVOKE_CHANNELS = Object.freeze({
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  retry: "ai-dev:retry",
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
 * The tools the interface calls, each with the arguments its buttons send:
 * `boolean`, `path` (an absolute path the system's dialog gave), `clients` (a
 * list of client names) or an object of named settings. The rest of the
 * control API (`model_remove`, `clients_remove`) and the agent's tools are not
 * here, and neither is any argument the interface does not send — another
 * setting, a forced rebuild, Frontend QA (docs/DEFECTS.md, Д-253).
 */
export const PAGE_TOOL_ARGUMENTS = Object.freeze({
  system_status: { checks: "boolean" },
  setup_run: { model: "boolean" },
  model_install: {},
  model_import: { source: "path" },
  clients_list: {},
  clients_install: { clients: "clients" },
  settings_get: {},
  settings_set: { settings: { projects_root: "path" } },
  rebuild_search_index: {}
});

/** The tools the interface calls. */
export const PAGE_TOOLS = Object.freeze(Object.keys(PAGE_TOOL_ARGUMENTS));

/**
 * A call's id from the page: `call-` and up to 59 letters, digits, - or _.
 * The main process names its own calls otherwise (`tray-rebuild`,
 * `language`), so the page can neither cancel them nor stand in for them.
 */
const CALL_ID = /^call-[A-Za-z0-9_-]{1,59}$/;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_TEXT = 4096;
const CLIENT_NAME = /^[a-z][a-z0-9-]{1,31}$/;

function refuseValue(kind, value, where) {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? null : `${where} is true or false.`;
    case "path":
      return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT ? null : `${where} is a path.`;
    case "clients":
      return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((name) => typeof name === "string" && CLIENT_NAME.test(name))
        ? null
        : `${where} is a list of client names.`;
    default: {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${where} is an object.`;
      const names = Object.keys(value);
      if (!names.length) return `${where} names something to change.`;
      for (const name of names) {
        if (!Object.hasOwn(kind, name)) return `The interface does not change ${JSON.stringify(name).slice(0, 80)}.`;
        const refused = refuseValue(kind[name], value[name], `${where}.${name}`);
        if (refused) return refused;
      }
      return null;
    }
  }
}

/** Why a call from the page is refused, or null when it may go on. */
export function refuseCall(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  const { tool, args = {}, id } = request;
  if (typeof tool !== "string" || !Object.hasOwn(PAGE_TOOL_ARGUMENTS, tool)) return `The interface does not call ${JSON.stringify(String(tool)).slice(0, 80)}.`;
  if (!validCallId(id)) return "A call's id is call- and 1 to 59 letters, digits, - or _.";
  if (!args || typeof args !== "object" || Array.isArray(args)) return "A call's arguments are an object.";
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(args));
  } catch {
    return "A call's arguments must be plain JSON.";
  }
  if (size > MAX_ARGUMENT_BYTES) return `A call's arguments are at most ${MAX_ARGUMENT_BYTES} bytes.`;
  const allowed = PAGE_TOOL_ARGUMENTS[tool];
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(allowed, name)) return `The interface does not send ${JSON.stringify(name).slice(0, 80)} to ${tool}.`;
    const refused = refuseValue(allowed[name], value, name);
    if (refused) return refused;
  }
  return null;
}

/** Whether a call id is one the page may use (call, cancel, progress). */
export function validCallId(id) {
  return typeof id === "string" && CALL_ID.test(id);
}
