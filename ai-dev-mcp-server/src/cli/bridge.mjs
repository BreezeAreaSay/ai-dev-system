/**
 * `ai-dev mcp`: what every client config runs. It hands the client's stdio to
 * the daemon (`src/core/daemon-bridge.mjs`) and starts the daemon when none
 * runs; when no daemon can serve — it does not start, the runtime home is not
 * writable, `AI_DEV_DAEMON=0` — the server runs here, in this process, as in
 * 2.x, and stderr says why.
 */
import process from "node:process";
import { StdioBridge, socketUpstream } from "../core/daemon-bridge.mjs";
import { connectDaemon } from "../core/daemon-client.mjs";
import { CLI_PATH, SERVER_ROOT, packageVersion } from "./context.mjs";

/**
 * What the stdio server says on stderr when capability profiles narrow its
 * tool list, said by the bridge for the session the daemon serves.
 */
function profileNotes({ tools_listed: listed, tools_total: total, profiles = [], unknown_profiles: unknown = [] }, note) {
  if (Number.isInteger(listed) && Number.isInteger(total) && listed < total) {
    note(`ai-dev: capability profiles ${profiles.join(", ")} — ${listed} of ${total} tools listed. Unset AI_DEV_PROFILES for all of them.`);
  }
  for (const name of unknown) note(`ai-dev: AI_DEV_PROFILES names "${name}", which is not a capability profile; ignoring it.`);
}

/** The server in this process, as the bridge's upstream. */
async function inProcessUpstream(note) {
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome();
  const { createAiDevServer, sessionToolCounts } = await import("../server.mjs");
  profileNotes(sessionToolCounts(null), note);
  const server = createAiDevServer();
  let deliver = () => undefined;
  const transport = {
    async start() {},
    async send(message) {
      deliver(message);
    },
    async close() {
      transport.onclose?.();
    }
  };
  await server.connect(transport);
  return {
    describe: "this process",
    start(onMessage) {
      deliver = onMessage;
    },
    send(message) {
      transport.onmessage?.(message);
      return Promise.resolve();
    },
    close() {
      server.close().catch(() => undefined);
      import("../mcp-stdio.mjs").then((module) => module.shutdownBgeWorkers()).catch(() => undefined);
    }
  };
}

/**
 * Bridge this process's stdin and stdout to the daemon until the client closes them.
 *
 * @param {{ env?: NodeJS.ProcessEnv, note?: (line: string) => void }} [options]
 * @returns {Promise<void>}
 */
export async function runMcpBridge({ env = process.env, note = (line) => process.stderr.write(`${line}\n`) } = {}) {
  // Each session says its own profiles; empty is every profile.
  const profiles = String(env.AI_DEV_PROFILES ?? "");
  let first = true;
  const connect = async ({ reconnect }) => {
    try {
      const channel = await connectDaemon({ serverRoot: SERVER_ROOT, cliPath: CLI_PATH, version: packageVersion(), env, mode: "mcp", profiles });
      if (channel.started) {
        note(`ai-dev: started the daemon (pid ${channel.info.pid})${channel.replaced ? `; the one of another build (pid ${channel.replaced}) steps aside` : ""}.`);
      } else if (reconnect) {
        note(`ai-dev: reconnected to the daemon (pid ${channel.info.pid}).`);
      }
      if (first) profileNotes(channel.welcome, note);
      first = false;
      return socketUpstream({ socket: channel.socket, rest: channel.rest, describe: `the daemon (pid ${channel.info.pid})` });
    } catch (error) {
      note(`ai-dev: no daemon can serve this client (${error.message}); serving it in this process instead.`);
      first = false;
      return inProcessUpstream(note);
    }
  };
  const upstream = await connect({ reconnect: false });
  const bridge = new StdioBridge({ input: process.stdin, output: process.stdout, note, connect });
  const stop = (code) => {
    upstream.close?.();
    process.exit(code);
  };
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
  await bridge.run(upstream);
}
