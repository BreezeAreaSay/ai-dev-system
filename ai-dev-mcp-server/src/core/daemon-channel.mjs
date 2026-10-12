/**
 * The channel between AI Dev's daemon and whoever talks to it: the `ai-dev mcp`
 * bridge an AI client starts, and `ai-dev daemon status|stop`.
 *
 * Three things keep the channel this user's (docs/DEFECTS.md, Д-97, Д-107):
 *
 * - the address is drawn at random on every start and published only in
 *   `daemon.json`, written with mode 0600 inside the user's runtime home — so
 *   no other process can create the pipe first and wait for clients on it;
 * - a Unix socket lives in a directory of mode 0700 that belongs to the user;
 * - the first line each side sends proves it holds the secret in `daemon.json`,
 *   without sending the secret: the client answers the daemon's nonce with an
 *   HMAC, and the daemon answers the client's with another. A process that
 *   reached the socket anyway learns nothing it can reuse, and a client that
 *   reached something other than the daemon — a stale address another process
 *   took over — finds out before it sends a single MCP message.
 *
 * After the handshake the connection carries MCP exactly as stdio does, one
 * JSON-RPC message per line; or, on a control connection, one request and one
 * answer.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { renameOver } from "./atomic-files.mjs";

/** The handshake's version. A daemon that speaks another is replaced, never half-understood. */
export const DAEMON_PROTOCOL = 1;

/** How long one side waits for the other's handshake line. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** A handshake line longer than this is not a handshake. */
const HANDSHAKE_LINE_BYTES = 16 * 1024;

const HEX_SECRET = /^[0-9a-f]{64}$/;
const HEX_NONCE = /^[0-9a-f]{32}$/;

/** A failure of the channel itself — refused, unanswered, unproven — as opposed to a bug. */
export class ChannelError extends Error {
  constructor(message, { code = "EDAEMONCHANNEL", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChannelError";
    this.code = code;
  }
}

/** A secret for one daemon's lifetime: 256 random bits, as hex. */
export const newSecret = () => crypto.randomBytes(32).toString("hex");

/** A nonce for one handshake: 128 random bits, as hex. */
export const newNonce = () => crypto.randomBytes(16).toString("hex");

function mac(secret, parts) {
  return crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(parts.join("\n")).digest("hex");
}

/** What a client sends to prove it holds the secret: bound to both nonces. */
export const clientProof = (secret, serverNonce, clientNonce) => mac(secret, ["ai-dev client", serverNonce, clientNonce]);

/** What the daemon sends back to prove the same: bound to both nonces and its pid. */
export const serverProof = (secret, serverNonce, clientNonce, pid) => mac(secret, ["ai-dev daemon", serverNonce, clientNonce, String(pid)]);

/** Compare two proofs in constant time. */
export function sameProof(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * Read one handshake line. What arrived after its newline is the start of the
 * stream that follows and is handed back, never dropped; the socket is left
 * paused, so nothing more is read until the next reader is attached.
 *
 * @param {import("node:net").Socket} socket
 * @param {{ timeoutMs?: number, buffered?: Buffer }} [options]
 * @returns {Promise<{ message: Record<string, unknown>, rest: Buffer }>}
 */
export function readLine(socket, { timeoutMs = HANDSHAKE_TIMEOUT_MS, buffered = Buffer.alloc(0) } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = buffered;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const take = () => {
      const end = buffer.indexOf(0x0a);
      if (end < 0) {
        if (buffer.length > HANDSHAKE_LINE_BYTES) finish(new ChannelError("The other side sent a handshake line longer than any handshake."));
        return;
      }
      const text = buffer.subarray(0, end).toString("utf8").replace(/\r$/, "");
      const rest = buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        finish(new ChannelError("The other side did not answer with a handshake: its first line is not JSON."));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new ChannelError("The other side did not answer with a handshake."));
        return;
      }
      finish(null, { message, rest });
    };
    const onData = (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      take();
    };
    const onError = (error) => finish(new ChannelError(`The connection failed during the handshake: ${error.code ?? error.message}.`, { code: error.code, cause: error }));
    const onClose = () => finish(new ChannelError("The other side closed the connection during the handshake.", { code: "ECONNRESET" }));
    const timer = setTimeout(() => finish(new ChannelError(`No handshake within ${timeoutMs} ms.`, { code: "ETIMEDOUT" })), timeoutMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.resume();
    if (buffer.length) take();
  });
}

/** Write one handshake line. */
export function writeLine(socket, message) {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The daemon's side of the handshake: send a nonce, check the client's proof,
 * prove itself in return. A client that fails is told so and disconnected.
 *
 * @param {import("node:net").Socket} socket
 * @param {object} daemon
 * @param {string} daemon.secret
 * @param {number} daemon.pid
 * @param {string} daemon.version
 * @param {string} daemon.build
 * @param {(request: { mode: string, profiles: string | null }) => Promise<object> | object} [daemon.welcome] - Extra fields for the answer.
 * @param {number} [daemon.timeoutMs]
 * @returns {Promise<{ mode: "mcp" | "control", profiles: string | null, rest: Buffer }>}
 */
export async function acceptHandshake(socket, { secret, pid, version, build, welcome = () => ({}), timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  const serverNonce = newNonce();
  await writeLine(socket, { ai_dev_daemon: DAEMON_PROTOCOL, nonce: serverNonce });
  const { message, rest } = await readLine(socket, { timeoutMs });
  const refuse = async (reason) => {
    await writeLine(socket, { ok: false, error: reason }).catch(() => undefined);
    socket.end();
    throw new ChannelError(reason, { code: "EAUTH" });
  };
  if (message.protocol !== DAEMON_PROTOCOL) return refuse(`This daemon speaks handshake protocol ${DAEMON_PROTOCOL}, not ${JSON.stringify(message.protocol ?? null)}.`);
  if (typeof message.nonce !== "string" || !HEX_NONCE.test(message.nonce)) return refuse("The handshake carries no nonce.");
  if (!sameProof(message.proof, clientProof(secret, serverNonce, message.nonce))) return refuse("Authentication failed: the proof does not match this daemon's secret.");
  const mode = message.mode === "control" ? "control" : "mcp";
  const profiles = typeof message.profiles === "string" ? message.profiles : null;
  const extra = await welcome({ mode, profiles });
  await writeLine(socket, { ...extra, ok: true, proof: serverProof(secret, serverNonce, message.nonce, pid), pid, version, build });
  return { mode, profiles, rest };
}

/**
 * Connect to the daemon `info` describes and prove each side to the other.
 *
 * @param {object} info - What `daemon.json` holds.
 * @param {{ mode?: "mcp" | "control", profiles?: string | null, timeoutMs?: number }} [options]
 * @returns {Promise<{ socket: import("node:net").Socket, welcome: Record<string, any>, rest: Buffer }>}
 */
export async function openChannel(info, { mode = "mcp", profiles = null, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  const socket = net.connect(info.address);
  // A reset after the handshake reaches whoever reads the socket next as a
  // `close`; without a listener of its own here it would end the process.
  socket.on("error", () => undefined);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ChannelError(`The daemon did not accept a connection within ${timeoutMs} ms.`, { code: "ETIMEDOUT" })), timeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new ChannelError(`Cannot reach the daemon at ${info.address}: ${error.code ?? error.message}.`, { code: error.code, cause: error }));
      });
    });
    const { message: hello, rest: early } = await readLine(socket, { timeoutMs });
    if (hello.ai_dev_daemon !== DAEMON_PROTOCOL || typeof hello.nonce !== "string" || !HEX_NONCE.test(hello.nonce)) {
      throw new ChannelError(`What answers at ${info.address} is not a daemon of this version.`, { code: "EPROTO" });
    }
    const nonce = newNonce();
    await writeLine(socket, { protocol: DAEMON_PROTOCOL, nonce, proof: clientProof(info.secret, hello.nonce, nonce), mode, profiles });
    const { message: welcome, rest } = await readLine(socket, { timeoutMs, buffered: early });
    if (welcome.ok !== true) throw new ChannelError(`The daemon refused the connection: ${welcome.error ?? "no reason given"}.`, { code: "EAUTH" });
    if (!sameProof(welcome.proof, serverProof(info.secret, hello.nonce, nonce, welcome.pid))) {
      throw new ChannelError(`What answers at ${info.address} cannot prove it is this user's daemon.`, { code: "EAUTH" });
    }
    if (Number(welcome.pid) !== Number(info.pid)) {
      throw new ChannelError(`The daemon at ${info.address} is pid ${welcome.pid}, not the pid ${info.pid} daemon.json names.`, { code: "EAUTH" });
    }
    return { socket, welcome, rest };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * One control request — `status`, `stop`, `retire` — and its answer.
 *
 * @param {object} info
 * @param {string} command
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function controlRequest(info, command, { timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  const { socket, rest } = await openChannel(info, { mode: "control", timeoutMs });
  try {
    await writeLine(socket, { control: command });
    const { message } = await readLine(socket, { timeoutMs, buffered: rest });
    return message;
  } finally {
    socket.destroy();
  }
}

/**
 * What `daemon.json` says, or null when there is none or it is not one this
 * version wrote — a 2.x daemon's descriptor has no protocol and no secret.
 *
 * @param {string} file
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readDaemonInfo(file) {
  let info;
  try {
    info = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (!info || typeof info !== "object") return null;
  if (info.protocol !== DAEMON_PROTOCOL || !Number.isInteger(info.pid) || typeof info.address !== "string") return null;
  if (typeof info.secret !== "string" || !HEX_SECRET.test(info.secret)) return null;
  return info;
}

/**
 * Publish `daemon.json`: written whole under another name with mode 0600, then
 * renamed over the old one, so a reader sees one complete descriptor or the
 * previous one, and nobody else can read the secret in it.
 *
 * @param {string} file
 * @param {object} info
 * @returns {Promise<void>}
 */
export async function writeDaemonInfo(file, info) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await renameOver(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Remove `daemon.json` only while it still describes daemon `pid`: a daemon on
 * its way out must not take its successor's descriptor with it.
 *
 * @param {string} file
 * @param {number} pid
 * @returns {Promise<boolean>} whether it was removed
 */
export async function removeDaemonInfo(file, pid) {
  const info = await readDaemonInfo(file);
  if (info && info.pid !== pid) return false;
  await fs.rm(file, { force: true });
  return true;
}

/** Environment variables that change what the server does, so a daemon serves only clients that set them the same way. */
const BEHAVIOUR_VARIABLES = /^(?:AI_DEV_|BGE_|HF_|PLAYWRIGHT_|ONNXRUNTIME_)|^(?:HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR)$/;

/** Variables that belong to one session or to the daemon's own lifetime, not to what it serves. */
const SESSION_VARIABLES = new Set(["AI_DEV_PROFILES", "AI_DEV_DAEMON", "AI_DEV_DAEMON_START_TIMEOUT_MS", "AI_DEV_IDLE_TIMEOUT_MS"]);

/**
 * The variables of `env` a daemon must share with a client to serve it, sorted.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<[string, string]>}
 */
export function behaviourEnvironment(env) {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && BEHAVIOUR_VARIABLES.test(name) && !SESSION_VARIABLES.has(name))
    .map(([name, value]) => [name, String(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** What stands for the code: every source file's path, size and time. */
async function sourceFingerprint(serverRoot) {
  const hash = crypto.createHash("sha256");
  const walk = async (relative) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(serverRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(child);
      } else if (/\.(?:mjs|js|json)$/.test(entry.name) && !entry.name.endsWith(".test.mjs")) {
        const stat = await fs.stat(path.join(serverRoot, child)).catch(() => null);
        if (stat) hash.update(`${child.replaceAll("\\", "/")}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
      }
    }
  };
  for (const top of ["src", "bin", "hooks"]) await walk(top);
  const manifest = await fs.stat(path.join(serverRoot, "package.json")).catch(() => null);
  if (manifest) hash.update(`package.json:${manifest.size}:${Math.trunc(manifest.mtimeMs)}\n`);
  return hash.digest("hex");
}

/**
 * Which build of the server a daemon is: its version, where its code is and
 * what that code is now, and the environment that shapes what it does. A
 * client whose own build differs — a `git pull`, a new package, another
 * `AI_DEV_VAULT_ROOT` — gets a daemon of its own build instead of being served
 * by a stale one.
 *
 * @param {{ serverRoot: string, version: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<string>}
 */
export async function daemonBuild({ serverRoot, version, env = process.env }) {
  const root = await fs.realpath(serverRoot).catch(() => path.resolve(serverRoot));
  const source = await sourceFingerprint(root);
  return crypto.createHash("sha256")
    .update(JSON.stringify({ version, root, source, env: behaviourEnvironment(env) }))
    .digest("hex")
    .slice(0, 16);
}
