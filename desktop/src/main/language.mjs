/**
 * The language the person chose, kept in the settings file (docs/DESKTOP.md,
 * "Languages"). A choice the file cannot take yet holds for the app and
 * waits: it is written once the file takes it — looked for twice a second,
 * and once more at the tray's Quit. Writes go one at a time, in the order the
 * choices came, so an earlier choice never lands over a later one
 * (docs/DEFECTS.md, Д-271, п. 4; Д-276, п. 2, 3; Д-279).
 */

/** How often a waiting language is looked at again. */
export const LOOK_EVERY_MS = 500;

/**
 * How long a write waits for the settings file's lock. Another writer that
 * holds it longer is waited for at the next look, not here: Quit and the
 * choice itself never hang on it.
 */
export const LOCK_WAIT_MS = 1_000;

/**
 * @param {{ server: () => ({ readSettings: Function, writeSettings: Function, SETTINGS_SCHEMA_VERSION: number } | null), env: NodeJS.ProcessEnv, lookEveryMs?: number, lockWaitMs?: number }} options
 *   `server`: the install's control-client module once the app has loaded it, or null.
 */
export function createLanguageKeeper({ server, env, lookEveryMs = LOOK_EVERY_MS, lockWaitMs = LOCK_WAIT_MS }) {
  // The choice that waits. `unreadable`: the file could not be read when it
  // was made (null: not known yet — no server to read it with); a language
  // the file names afterwards was the person's, and wins over it. `newer`: a
  // newer AI Dev wrote the file, which this version never writes; the choice
  // holds for this run only.
  let waiting = null;
  let queue = Promise.resolve();
  let looking = null;
  let attempt = null;

  // One write at a time, in the order asked.
  const serial = (job) => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };

  /** The file now: whether it can be read (null: nothing to read it with), and whether a newer AI Dev wrote it. */
  const look = () => {
    const module = server();
    if (!module) return { readable: null, newer: false };
    try {
      const read = module.readSettings({ env });
      return { readable: true, newer: read.schema_version > module.SETTINGS_SCHEMA_VERSION };
    } catch {
      return { readable: false, newer: false };
    }
  };

  const stopLooking = () => {
    clearInterval(looking);
    looking = null;
  };

  /** Try to write `choice`: true once it no longer waits — written, given way to the file's own, or to a later choice. */
  const write = (choice) => serial(async () => {
    // Settled meanwhile, or a later choice is on its way: that one is written.
    if (waiting !== choice) return true;
    const module = server();
    if (!module) return false;
    if (choice.unreadable === null) choice.unreadable = look().readable === false;
    let written;
    try {
      // Decided under the file's lock: a language the file names by then
      // stays, when the choice was made while the file could not be read.
      written = await module.writeSettings({ language: choice.language }, { env, unsetOnly: choice.unreadable, lockTimeoutMs: lockWaitMs });
    } catch {
      if (look().newer) choice.newer = true;
      return false;
    }
    if (waiting === choice) waiting = null;
    // What this app wrote is no language of the person's: a choice made since,
    // while the file could not be read, is written over it.
    else if (waiting && written.changed.length) waiting.unreadable = false;
    return true;
  });

  /** One write of whatever waits, and the looking goes on while something waits that may yet be written. */
  const settle = async () => {
    const choice = waiting;
    const settled = choice ? await write(choice) : true;
    if (!waiting || waiting.newer) stopLooking();
    else if (!looking) {
      looking = setInterval(() => {
        attempt ??= settle().finally(() => {
          attempt = null;
        });
      }, lookEveryMs);
      looking.unref?.();
    }
    return settled;
  };

  return {
    /**
     * The person chose `language`: written to the file, or held until the
     * file takes it. Resolves whether it was written.
     */
    choose(language) {
      const { readable } = look();
      waiting = { language, unreadable: readable === null ? null : !readable, newer: false };
      return settle();
    },

    /**
     * At start-up, with the file read (`stored`: the values it holds that this
     * version reads): the language to use, or null for the file's own. A
     * choice made while the file could not be read gives way to a language
     * the file names now — the empty one, the system's, too (Д-276, п. 2).
     */
    atStart(stored) {
      const choice = waiting;
      if (!choice) return null;
      choice.unreadable ??= false;
      if (choice.unreadable && Object.hasOwn(stored, "language")) {
        waiting = null;
        stopLooking();
        return null;
      }
      return choice.language;
    },

    /** The tray's Quit: one more write of what waits. */
    settle,

    /** The language that waits to be written, or null. */
    waiting: () => waiting?.language ?? null,

    /** Stop looking (the app quits). */
    stop: stopLooking
  };
}
