import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * MCP's line-delimited JSON transport, carried over a local socket.
 *
 * The stdio transport the server normally uses frames messages the same way,
 * so this reuses the SDK's own buffer and serialiser and only swaps the pipe:
 * a Unix socket, or a named pipe on Windows. That is what lets one daemon
 * serve many clients while each still speaks plain MCP.
 */
export class SocketServerTransport {
  #socket;
  #buffer = new ReadBuffer();
  #buffered;
  #started = false;
  #closed = false;

  onclose;
  onerror;
  onmessage;

  /**
   * @param {import("node:net").Socket} socket - An already-connected socket.
   * @param {{ buffered?: Buffer }} [options] - Bytes read past the daemon's
   *   handshake: the start of the MCP stream, which must not be lost.
   */
  constructor(socket, { buffered } = {}) {
    this.#socket = socket;
    this.#buffered = buffered;
  }

  /**
   * Begin reading messages. Called by the SDK during `server.connect`.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#started) {
      throw new Error("SocketServerTransport is already started.");
    }
    this.#started = true;
    this.#socket.on("data", (chunk) => {
      try {
        this.#buffer.append(chunk);
      } catch (error) {
        // Ten megabytes without a line break is not a client to keep reading.
        this.onerror?.(error);
        this.#socket.destroy();
        return;
      }
      this.#drain();
    });
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#notifyClosed());
    if (this.#buffered?.length) {
      this.#buffer.append(this.#buffered);
      this.#buffered = null;
      this.#drain();
    }
    // The handshake leaves the socket paused, so nothing arrives before the
    // listeners above are there to take it.
    this.#socket.resume();
  }

  /** Hand every complete message in the buffer to the server. */
  #drain() {
    for (;;) {
      let message;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        // The bad line is already out of the buffer: report it and go on with
        // the next one, as the SDK's stdio transport does.
        this.onerror?.(error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  /**
   * @param {unknown} message - A JSON-RPC message to frame and write.
   * @returns {Promise<void>}
   */
  async send(message) {
    if (this.#closed) return;
    await new Promise((resolve, reject) => {
      this.#socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    this.#buffer.clear();
    this.#socket.end();
    this.#notifyClosed();
  }

  /** Fire `onclose` exactly once, however the socket went away. */
  #notifyClosed() {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}
