// The page's only way out: a few functions on `window.aiDev`, each one
// channel of the main process (src/main/ipc-policy.mjs). A sandboxed preload
// can require nothing but `electron`'s renderer modules, so the channel names
// are written out here; a test checks they match the policy's.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = {
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  call: "ai-dev:call",
  cancel: "ai-dev:cancel",
  chooseFolder: "ai-dev:choose-folder",
  setLanguage: "ai-dev:set-language"
};
const events = {
  state: "ai-dev:state-changed",
  progress: "ai-dev:progress"
};

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("A callback is a function.");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aiDev", Object.freeze({
  /** The connection to the daemon, the platform, the language. */
  state: () => ipcRenderer.invoke(invoke.state),
  /** Reach the daemon, starting it when `start` is true. */
  connect: (start) => ipcRenderer.invoke(invoke.connect, { start: start === true }),
  /** Call one of the interface's tools; `id` names the call for progress and cancel. */
  call: (tool, args, id) => ipcRenderer.invoke(invoke.call, { tool, args, id }),
  /** Cancel a call by its id. */
  cancel: (id) => ipcRenderer.invoke(invoke.cancel, id),
  /** The folder the person picks in the system's dialog, or null. */
  chooseFolder: (purpose) => ipcRenderer.invoke(invoke.chooseFolder, { purpose: String(purpose ?? "") }),
  /** Show the tray and menus in this language too. */
  setLanguage: (language) => ipcRenderer.invoke(invoke.setLanguage, String(language ?? "")),
  onState: (callback) => subscribe(events.state, callback),
  onProgress: (callback) => subscribe(events.progress, callback)
}));
