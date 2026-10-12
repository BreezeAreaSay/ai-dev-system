/**
 * The last lines of AI Dev's logs, for `logs_tail` and the desktop app's log
 * view. A log is read from its end, so a large one costs what is shown.
 *
 * Only the logs in the runtime home's `logs` folder can be named, by file
 * name: `daemon` is `daemon.log`, `daemon.1` the part the daemon set aside
 * when the log passed 1 MB.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** The most lines one answer carries. */
export const MAX_TAIL_LINES = 1000;

/** Read at most this much from a log's end, whatever its lines' length. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;

/** A log name: a file name in the logs folder, with or without `.log`. */
const LOG_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The file a log name stands for, or an error that says what may be named.
 *
 * @param {string} logsFolder
 * @param {string} [name] - `daemon` (the default), `daemon.1`, or another
 *   `*.log` file's name in the folder.
 * @returns {{ log: string, file: string }}
 */
export function resolveLogFile(logsFolder, name = "daemon") {
  const wanted = String(name ?? "").trim() || "daemon";
  if (!LOG_NAME.test(wanted) || wanted.includes("..")) {
    throw new Error(`"${wanted}" is not a log name: name a file in ${logsFolder}, such as daemon or daemon.1.`);
  }
  const rotated = /^(.*)\.(\d+)$/.exec(wanted);
  const base = rotated ? rotated[1] : wanted;
  const fileName = base.endsWith(".log")
    ? `${base}${rotated ? `.${rotated[2]}` : ""}`
    : `${base}.log${rotated ? `.${rotated[2]}` : ""}`;
  return { log: wanted, file: path.join(logsFolder, fileName) };
}

/**
 * The last `lines` lines of a file.
 *
 * @param {string} file
 * @param {{ lines?: number, links?: boolean }} [options] - `links: false` refuses a file that is a link,
 *   or that has another name elsewhere (a hard link).
 * @returns {Promise<{ exists: boolean, size: number, lines: string[], truncated: boolean }>}
 *   `truncated`: the file holds earlier lines than these.
 */
export async function tailLines(file, { lines = 200, links = true } = {}) {
  const wanted = Math.max(1, Math.min(MAX_TAIL_LINES, Math.trunc(Number(lines)) || 200));
  const refuse = () => new Error(`${path.basename(file)} is a link: only the logs folder's own files are read.`);
  if (!links) {
    // A link in the logs folder would read whatever it points at (docs/DEFECTS.md, Д-223).
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isSymbolicLink()) throw refuse();
  }
  let handle;
  try {
    // Opened without following a link put in its place since (Д-233).
    handle = await fs.open(file, links ? "r" : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, size: 0, lines: [], truncated: false };
    if (!links && (error?.code === "ELOOP" || error?.code === "EMLINK")) throw refuse();
    throw error;
  }
  try {
    const stat = await handle.stat();
    // A hard link is a second name for a file elsewhere, as good as a link (Д-233).
    if (!links && (!stat.isFile() || stat.nlink > 1)) throw refuse();
    const { size } = stat;
    let position = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;
    // One newline more than the lines wanted: the first line read may be cut.
    while (position > 0 && newlines <= wanted && size - position < MAX_TAIL_BYTES) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
      buffer = Buffer.concat([chunk, buffer]);
    }
    // Decoded whole, so a character cut by a chunk's edge lands in the line
    // that is dropped below as cut, never in one that is shown.
    const all = buffer.toString("utf8").split(/\r?\n/);
    if (all.at(-1) === "") all.pop();
    if (position > 0) all.shift();
    return { exists: true, size, lines: all.slice(-wanted), truncated: position > 0 || all.length > wanted };
  } finally {
    await handle.close();
  }
}
