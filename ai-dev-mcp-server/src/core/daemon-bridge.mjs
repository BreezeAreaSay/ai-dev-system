/**
 * `ai-dev mcp` as a bridge: the AI client's stdin and stdout on one side, the
 * daemon on the other (docs/DEFECTS.md, Д-97).
 *
 * MCP passes through untouched, one JSON-RPC message per line — the
 * handshake too, so the client gets the daemon's own `initialize` answer with
 * its instructions. The bridge keeps only what it needs when the daemon goes
 * away mid-session (a crash, `kill -9`, `ai-dev daemon stop`):
 *
 * - the client's `initialize`, to replay to the next daemon, so the session
 *   goes on without the client noticing more than one failed call;
 * - the requests the daemon has not answered: each gets an error saying what
 *   happened, instead of hanging until the client's timeout.
 *
 * The next message from the client reconnects — to a daemon started for it,
 * or, when none can be, to a server in this process.
 */

/** Ids the bridge gives its own requests, so their answers are not passed to the client. */
const BRIDGE_ID = "ai-dev-bridge-";

/** How long a replayed `initialize` may take before the session goes on without it. */
const REPLAY_TIMEOUT_MS = 60_000;

const isRequest = (message) => typeof message?.method === "string" && message.id !== undefined && message.id !== null;
const isResponse = (message) => message?.method === undefined && message?.id !== undefined;

/**
 * Split a byte stream into JSON-RPC messages, one per line.
 *
 * Bytes are kept as they come and a line is decoded only once it is whole: a
 * pipe hands over 64 KB at a time, and a character cut by a chunk's edge,
 * decoded on its own, became two U+FFFD that `JSON.parse` took without a word —
 * a Russian note of a few hundred kilobytes came out changed, on disk too
 * (docs/DEFECTS.md, Д-188). Each byte is looked at once and each line joined
 * once, so a line of many megabytes costs what its size does.
 *
 * @param {(message: object) => void} onMessage
 * @param {(line: string, error: Error) => void} onInvalid
 * @returns {(chunk: Buffer | string) => void}
 */
export function lineReader(onMessage, onInvalid) {
  const parts = [];
  let length = 0;
  return (chunk) => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a)) {
      parts.push(bytes.subarray(0, end));
      const line = Buffer.concat(parts, length + end).toString("utf8").replace(/\r$/, "");
      parts.length = 0;
      length = 0;
      bytes = bytes.subarray(end + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        onInvalid(line, error);
        continue;
      }
      onMessage(message);
    }
    if (bytes.length) {
      parts.push(bytes);
      length += bytes.length;
    }
  };
}

/**
 * An upstream over a socket the daemon handshake left paused.
 *
 * @param {{ socket: import("node:net").Socket, rest?: Buffer, describe?: string }} channel
 */
export function socketUpstream({ socket, rest, describe = "the daemon" }) {
  let closed = false;
  return {
    describe,
    start(onMessage, onClose) {
      const read = lineReader(onMessage, () => undefined);
      socket.on("data", read);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        closed = true;
        onClose(`${describe} closed the connection`);
      });
      if (rest?.length) read(rest);
      socket.resume();
    },
    send(message) {
      if (closed) return Promise.reject(new Error("closed"));
      return new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
      });
    },
    close() {
      closed = true;
      socket.end();
    }
  };
}

/**
 * Relay one client's MCP session to an upstream that may change under it.
 */
export class StdioBridge {
  #input;
  #output;
  #note;
  #connect;
  #upstream = null;
  #generation = 0;
  #connecting = null;
  #queue = [];
  #initialize = null;
  #initializeForwarded = false;
  #initialized = false;
  #inFlight = new Map();
  #own = new Map();
  #nextOwn = 0;
  #ended = false;
  #done;

  /**
   * @param {object} options
   * @param {NodeJS.ReadableStream} options.input - The client's messages (stdin).
   * @param {NodeJS.WritableStream} options.output - Where the client reads (stdout).
   * @param {(line: string) => void} options.note - A line for the client's log (stderr).
   * @param {(context: { reconnect: boolean }) => Promise<object>} options.connect - A started-or-found upstream; never rejects.
   */
  constructor({ input, output, note, connect }) {
    this.#input = input;
    this.#output = output;
    this.#note = note;
    this.#connect = connect;
  }

  /**
   * Serve until the client closes its end.
   *
   * @param {object} upstream - The first upstream, connected before anything is read.
   * @returns {Promise<void>}
   */
  run(upstream) {
    this.#attach(upstream);
    return new Promise((resolve) => {
      this.#done = resolve;
      const read = lineReader(
        (message) => this.#fromClient(message),
        (line) => this.#note(`ai-dev: ignored a line from the client that is not JSON: ${line.slice(0, 80)}`)
      );
      this.#input.on("data", read);
      this.#input.on("end", () => this.#finish());
      this.#input.on("close", () => this.#finish());
      this.#input.resume?.();
    });
  }

  /** The upstream messages are going to now. */
  #attach(upstream) {
    const generation = ++this.#generation;
    this.#upstream = upstream;
    upstream.start(
      (message) => this.#fromUpstream(generation, message),
      (reason) => this.#lost(generation, reason)
    );
    return generation;
  }

  #fromClient(message) {
    if (this.#ended) return;
    if (isRequest(message) && message.method === "initialize") this.#initialize = message;
    if (message?.method === "notifications/initialized") this.#initialized = true;
    if (this.#upstream && !this.#connecting) {
      this.#forward(message);
      return;
    }
    this.#queue.push(message);
    this.#reconnect();
  }

  #forward(message) {
    if (!this.#upstream) {
      this.#queue.push(message);
      this.#reconnect();
      return;
    }
    if (isRequest(message)) {
      this.#inFlight.set(message.id, message.method);
      if (message.method === "initialize") this.#initializeForwarded = true;
    }
    this.#upstream.send(message).catch(() => undefined);
  }

  #fromUpstream(generation, message) {
    if (generation !== this.#generation) return;
    if (isResponse(message)) {
      const own = this.#own.get(message.id);
      if (own) {
        this.#own.delete(message.id);
        own(message);
        return;
      }
      this.#inFlight.delete(message.id);
    }
    this.#write(message);
  }

  /** The upstream is gone: every request it had gets an answer now, and the next message reconnects. */
  #lost(generation, reason) {
    if (generation !== this.#generation || this.#ended) return;
    this.#generation += 1;
    this.#upstream = null;
    for (const [id, method] of this.#inFlight) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `The ai-dev daemon went away while ${method} ran (${reason}). The next request starts a new one; repeat this call.` }
      });
    }
    this.#inFlight.clear();
    for (const settle of this.#own.values()) settle(null);
    this.#own.clear();
    this.#note(`ai-dev: lost the daemon (${reason}); the next request reconnects.`);
    if (this.#queue.length) this.#reconnect();
  }

  #reconnect() {
    if (this.#connecting || this.#ended) return;
    this.#connecting = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const upstream = await this.#connect({ reconnect: true });
        if (this.#ended) {
          upstream.close();
          return;
        }
        this.#attach(upstream);
        // The new server has not met this client: it is introduced the way the
        // first one was, and only then hears what the client sent meanwhile.
        if (this.#initialize && this.#initializeForwarded) await this.#replayInitialize();
        if (this.#upstream === upstream) {
          this.#connecting = null;
          for (const message of this.#queue.splice(0)) this.#forward(message);
          return;
        }
      }
      this.#refuseQueued("no server could be started for it");
    })().catch((error) => {
      this.#refuseQueued(error.message);
    }).finally(() => {
      this.#connecting = null;
    });
  }

  /** Answer every request still waiting for a server, when none can be had. */
  #refuseQueued(reason) {
    for (const message of this.#queue.splice(0)) {
      if (isRequest(message)) this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `ai-dev could not serve ${message.method}: ${reason}.` } });
    }
    this.#note(`ai-dev: could not reconnect: ${reason}.`);
  }

  async #replayInitialize() {
    const id = `${BRIDGE_ID}${++this.#nextOwn}`;
    const answered = new Promise((resolve) => {
      this.#own.set(id, resolve);
      setTimeout(() => resolve(null), REPLAY_TIMEOUT_MS).unref?.();
    });
    await this.#upstream.send({ ...this.#initialize, id }).catch(() => undefined);
    const answer = await answered;
    this.#own.delete(id);
    if (!answer || answer.error) {
      this.#note(`ai-dev: the new server did not take the session over (${answer?.error?.message ?? "no answer"}).`);
      return;
    }
    if (this.#initialized) await this.#upstream?.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  #write(message) {
    if (this.#ended) return;
    try {
      this.#output.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.#finish();
    }
  }

  #finish() {
    if (this.#ended) return;
    this.#ended = true;
    this.#upstream?.close();
    this.#upstream = null;
    this.#done?.();
  }
}
