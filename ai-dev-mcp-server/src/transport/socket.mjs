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
  #started = false;
  #closed = false;

  onclose;
  onerror;
  onmessage;

  /** @param {import("node:net").Socket} socket - An already-connected socket. */
  constructor(socket) {
    this.#socket = socket;
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
      this.#buffer.append(chunk);
      for (;;) {
        let message;
        try {
          message = this.#buffer.readMessage();
        } catch (error) {
          // A malformed frame poisons the buffer: stop draining and report it
          // rather than spinning on the same bytes.
          this.onerror?.(error);
          return;
        }
        if (message === null) return;
        this.onmessage?.(message);
      }
    });
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#notifyClosed());
  }

  /**
   * @param {unknown} message - A JSON-RPC message to frame and write.
   * @returns {Promise<void>}
   */
  async send(message) {
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
