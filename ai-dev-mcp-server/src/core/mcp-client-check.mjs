/**
 * Start the command an MCP client would start, ask it `initialize`, and say
 * what came back.
 *
 * A config can name a Node that has since been uninstalled, a checkout that
 * moved, or a server that prints a banner on stdout and breaks the protocol;
 * the client then shows a red dot and nothing else. This runs the same
 * command line the same way a client does (no shell, the entry's `env` on top
 * of the environment) and reads the answer as a client would: one JSON-RPC
 * message per line on stdout.
 */
import { spawn } from "node:child_process";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-dev clients doctor", version: "1" } }
};

/** What Node prints around an uncaught error that says nothing about it. */
const NOISE = [
  /^Node\.js v\d/, // the version, printed last
  /^\s+at\s/, // the stack
  /^\s*\^+\s*$/, // the caret under the line that threw
  /^\s*[{}]\s*$/, // the error's own properties…
  /^\s+[\w$]+: /, // …one per line
  /^(?:node:|file:\/\/)\S+:\d+$/ // where it was thrown
];

/**
 * The line of a command's stderr that says why it stopped: the last one that
 * names an error — one not indented first, as Node prints the error itself
 * and indents its causes — else the last that is not noise. The last line
 * itself was Node's version, and a moved clone was reported as "Node.js
 * v22.22.0" (docs/DEFECTS.md, Д-169).
 */
function errorLine(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !NOISE.some((pattern) => pattern.test(line)));
  const named = (line) => /\b(?:error|exception)\b/i.test(line);
  return (lines.findLast((line) => named(line) && !/^\s/.test(line)) ?? lines.findLast(named) ?? lines.at(-1) ?? "").trim().slice(0, 300);
}

/**
 * @typedef {object} CommandCheck
 * @property {boolean} ok - It answered `initialize` with instructions.
 * @property {number} ms
 * @property {{ name?: string, version?: string }} [server]
 * @property {string} [protocolVersion]
 * @property {number} [instructions] - Length of the instructions it sent.
 * @property {string} [error] - What went wrong, in a sentence.
 */

/**
 * @param {{ command: string, args?: unknown[], env?: Record<string, string> }} entry
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn }} [options]
 * @returns {Promise<CommandCheck>}
 */
export function checkServerCommand(entry, { timeoutMs = 30_000, env = process.env, spawnProcess = spawn } = {}) {
  const started = Date.now();
  const command = String(entry?.command ?? "");
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      resolve({ ...result, ms: Date.now() - started });
    };
    if (!command) {
      finish({ ok: false, error: "the entry names no command" });
      return;
    }
    try {
      child = spawnProcess(command, args, {
        env: { ...env, ...(entry.env && typeof entry.env === "object" ? entry.env : {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      finish({ ok: false, error: `${command} could not be started: ${error.message}` });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, error: `no answer to initialize within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (let newline = stdout.indexOf("\n"); newline >= 0 && !settled; newline = stdout.indexOf("\n")) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, error: `it printed something other than MCP on stdout, which clients cannot read: ${line.slice(0, 120)}` });
          return;
        }
        if (message?.id !== 1) continue;
        if (message.error) {
          finish({ ok: false, error: `it refused initialize: ${message.error.message ?? JSON.stringify(message.error)}` });
          return;
        }
        const result = message.result ?? {};
        const instructions = typeof result.instructions === "string" ? result.instructions.length : 0;
        finish({
          ok: instructions > 0,
          server: result.serverInfo,
          protocolVersion: result.protocolVersion,
          instructions,
          ...(instructions > 0 ? {} : { error: "it answered initialize without instructions" })
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.stdin.on("error", () => undefined); // a command that died early closed it; `close` says why
    child.on("error", (error) => {
      finish({ ok: false, error: error?.code === "ENOENT" ? `${command} does not exist` : `${command} could not be started: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      const why = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      const said = errorLine(stderr);
      finish({ ok: false, error: `it ${why} before answering${said ? `: ${said}` : ""}` });
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  });
}
