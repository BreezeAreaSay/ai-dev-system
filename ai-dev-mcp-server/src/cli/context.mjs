/**
 * What every `ai-dev` command shares: where the install is, how it talks to
 * the person running it, and the command line clients are given to start it.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { APP_MARKER, appCli, appFolder } from "../core/app-home.mjs";
import { EXIT } from "../core/cli-args.mjs";
import { DISTRIBUTION_MARKER, PACKAGE_NAME, currentInstallLayout } from "../core/install-layout.mjs";
import { explicitRuntimeHome } from "../core/runtime-home.mjs";

/** `ai-dev-mcp-server/` of this install. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI's own file: what client configs run, with `mcp`. */
export const CLI_PATH = path.join(SERVER_ROOT, "bin", "ai-dev.mjs");

/** The version in this install's package.json. */
export function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * @typedef {object} CliIo
 * @property {(line?: string) => void} out - A line on stdout.
 * @property {(line?: string) => void} err - A line on stderr.
 * @property {NodeJS.WritableStream & { isTTY?: boolean, columns?: number }} stdout
 * @property {NodeJS.ProcessEnv} env
 * @property {boolean} interactive - A person at a terminal can be asked.
 * @property {(question: string, fallback: boolean) => Promise<boolean>} ask - A yes/no
 *   question; the fallback is the answer to a bare Enter, and to anything when nobody can be asked.
 */

let pipeWatched = false;

/**
 * A reader that stops early (`ai-dev clients list | head -3`, a client that
 * went away) closes stdout; the next write is EPIPE, which Node raises as an
 * uncaught error with a stack trace. The output was not wanted any more: stop.
 */
function quietOnClosedPipe(stream) {
  if (stream !== process.stdout || pipeWatched) return;
  pipeWatched = true;
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") throw error;
    process.exit(process.exitCode ?? 0);
  });
}

/**
 * The real terminal, or the streams a test hands in.
 *
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream, env?: NodeJS.ProcessEnv, interactive?: boolean }} [streams]
 * @returns {CliIo}
 */
export function createIo({
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
} = {}) {
  quietOnClosedPipe(stdout);
  return {
    stdout,
    env,
    interactive,
    out: (line = "") => stdout.write(`${line}\n`),
    err: (line = "") => stderr.write(`${line}\n`),
    async ask(question, fallback) {
      if (!interactive) return fallback;
      const prompt = readline.createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await prompt.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (!answer) return fallback;
        return answer === "y" || answer === "yes" || answer === "д" || answer === "да";
      } catch (error) {
        // Ctrl-C at a question is the same stop as Ctrl-C anywhere else: 130,
        // not a failure with readline's "Aborted with Ctrl+C" (docs/DEFECTS.md, Д-172).
        if (error?.code !== "ABORT_ERR" && error?.name !== "AbortError") throw error;
        stdout.write("\n");
        throw Object.assign(new Error("Stopped with Ctrl-C at a question, before anything was changed."), { exitCode: EXIT.interrupted });
      } finally {
        prompt.close();
      }
    }
  };
}

/** A path as a person reads it: the home directory as `~`. */
export function tildify(target, home = os.homedir()) {
  if (!home || !target) return target;
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return `~${path.sep}${relative}`;
}

/** The Obsidian vault this server sits in, if it sits in one (`<vault>/09-mcp/ai-dev-mcp-server`). */
function vaultAround(serverRoot) {
  const candidate = path.resolve(serverRoot, "..", "..");
  return existsSync(path.join(candidate, "03-skills-catalog")) || existsSync(path.join(candidate, "01-system")) ? candidate : "";
}

/**
 * The command line a client starts this install with: this Node, by its full
 * path, so a client that does not inherit the shell's PATH (Claude Desktop on
 * macOS, any GUI app launched from the Dock) still finds it; this CLI's file;
 * `mcp`. A vault install passes its vault on, as 2.x did, and a runtime folder
 * named by `AI_DEV_HOME` goes with it too: a client started from the Dock does
 * not see the shell's variables, and its server would look for the index,
 * the state and a package's vault in ~/.ai-dev instead (docs/DEFECTS.md, Д-176).
 *
 * A package npx runs from its cache is launched from the copy `setup`
 * installed in the app home, never from the cache npm may clear.
 *
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, cliPath?: string, serverRoot?: string, layout?: import("../core/install-layout.mjs").InstallLayout, appCliPath?: () => string }} [options]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function localLaunch({ env = process.env, execPath = process.execPath, cliPath = CLI_PATH, serverRoot = SERVER_ROOT, layout = currentInstallLayout(), appCliPath = () => installedAppCli(layout) } = {}) {
  const vault = env.AI_DEV_VAULT_ROOT ? path.resolve(env.AI_DEV_VAULT_ROOT) : vaultAround(serverRoot);
  const runtimeHome = explicitRuntimeHome(env);
  let cli = cliPath;
  if (layout.kind === "package" && layout.ephemeral) {
    cli = appCliPath();
    if (!cli) {
      throw Object.assign(new Error(`This copy runs from npx's cache (${layout.root}), which npm may clear, so a client config must not name it. `
        + `Run \`npx ${PACKAGE_NAME} setup\` first: it installs a copy that stays, and connects the clients to it.`), { exitCode: EXIT.failed });
    }
  }
  return {
    command: execPath,
    args: [cli, "mcp"],
    env: { ...(vault ? { AI_DEV_VAULT_ROOT: vault } : {}), ...(runtimeHome ? { AI_DEV_HOME: runtimeHome } : {}) }
  };
}

/** The CLI of the copy `setup` installed in the app home for this very package, or "". */
function installedAppCli(layout) {
  try {
    const distribution = JSON.parse(readFileSync(path.join(layout.root, DISTRIBUTION_MARKER), "utf8"));
    const folder = appFolder(layout.runtimeRoot, distribution);
    const marker = JSON.parse(readFileSync(path.join(folder, APP_MARKER), "utf8"));
    return marker.content_fingerprint === distribution.content_fingerprint && existsSync(appCli(folder)) ? appCli(folder) : "";
  } catch {
    return "";
  }
}
