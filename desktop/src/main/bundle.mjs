/**
 * The runtime the Windows installer ships (docs/DESKTOP.md, "The Windows
 * install"): the server with its dependencies and a Node of its own, in the
 * install's `resources/runtime`. The app does not run it there — a client
 * holding a file of it would stop the next update — but copies it into the
 * app home and points the stable link AI clients run at the copy
 * (`ai-dev-mcp-server/src/core/app-bundle.mjs`). It does so at every start: a
 * runtime already copied is found, not copied again.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where the installer put the runtime: `resources/runtime` of the packaged
 * app on Windows; `AI_DEV_DESKTOP_BUNDLE` names one for the end-to-end tests.
 * Null everywhere else: a checkout runs the server beside it.
 *
 * @param {{ env: NodeJS.ProcessEnv, packaged: boolean, platform: string, resourcesPath?: string }} where
 * @returns {string | null}
 */
export function shippedRuntime({ env, packaged, platform, resourcesPath }) {
  if (env.AI_DEV_DESKTOP_BUNDLE) return path.resolve(env.AI_DEV_DESKTOP_BUNDLE);
  return packaged && platform === "win32" && resourcesPath ? path.join(resourcesPath, "runtime") : null;
}

/**
 * Copy the shipped runtime into the app home, once per runtime, and make it
 * the one AI clients run. The code that does it is the runtime's own: the
 * app holds no second copy of it.
 *
 * @param {{ bundleRoot: string, env: NodeJS.ProcessEnv, onProgress?: (progress: { progress: number, total: number }) => void }} options
 * @returns {Promise<{ status: string, version: string, folder: string, serverRoot: string, node: string, cli: string }>}
 */
export async function prepareRuntime({ bundleRoot, env, onProgress }) {
  const load = (name) => import(pathToFileURL(path.join(bundleRoot, "ai-dev-mcp-server", "src", "core", name)).href);
  const [{ provisionBundle }, { resolveRuntimeStateRoot }] = await Promise.all([load("app-bundle.mjs"), load("runtime-home.mjs")]);
  return provisionBundle({ bundleRoot, runtimeRoot: resolveRuntimeStateRoot("", env), onProgress });
}
