/**
 * A PATH with no Python on it, to prove that nothing needs one.
 *
 * Every GitHub runner carries Python, so for months nothing noticed that search
 * could not run without it: the first run failed on a clean machine with
 * "spawn python3 ENOENT", and CI stayed green (docs/DEFECTS.md, Д-85). The
 * check that closes the blind spot runs the install, the first run, the health
 * check and the protocol smoke on a PATH from which every interpreter is gone.
 *
 * A folder cannot simply be dropped: on Linux `/usr/bin` holds `python3` next
 * to `sh`, which npm runs scripts with, and `git`. So off Windows a folder with
 * an interpreter in it is replaced by a mirror — a fresh folder of links to
 * everything else in it. On Windows interpreters live in folders of their own
 * (the tool cache's Python, the Store's aliases, `C:\Windows` with the `py`
 * launcher), and links there need a privilege, so those folders are dropped.
 */

/** Interpreter names off Windows: `python`, `python3`, `python3.13`. */
const POSIX_PYTHON = /^python(?:\d+(?:\.\d+)*)?$/;

/**
 * Interpreter names on Windows, any case: the same names as `.exe`, `.cmd` or
 * `.bat` (pyenv-win's shims are batch files), `pythonw`, and the `py`
 * launcher. The Store's app execution aliases are listed as `python.exe` too.
 */
const WINDOWS_PYTHON = /^(?:pythonw?(?:\d+(?:\.\d+)*)?|pyw?)\.(?:exe|cmd|bat)$/i;

/**
 * Whether a file name is a Python interpreter, or a shim that starts one.
 *
 * @param {string} name - A bare file name.
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isPythonExecutable(name, platform = process.platform) {
  return (platform === "win32" ? WINDOWS_PYTHON : POSIX_PYTHON).test(String(name ?? ""));
}

/**
 * What to do with each PATH entry to leave no interpreter on it: keep it, drop
 * it, or (off Windows) replace it with a mirror of the names listed. A folder
 * that cannot be listed is dropped — a lookup may still find a file in a
 * folder it may not list, and what cannot be looked at cannot be vouched for.
 * Empty entries go too: on POSIX one means the current directory.
 *
 * @param {{ pathValue: string, platform?: string, listDirectory: (directory: string) => string[] }} options
 * @returns {Array<{ directory: string, action: "keep" } | { directory: string, action: "drop", reason: string } | { directory: string, action: "mirror", names: string[] }>}
 */
export function planPythonFreePath({ pathValue, platform = process.platform, listDirectory }) {
  const delimiter = platform === "win32" ? ";" : ":";
  const plan = [];
  for (const directory of String(pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    let names;
    try {
      names = listDirectory(directory);
    } catch {
      plan.push({ directory, action: "drop", reason: "cannot be listed" });
      continue;
    }
    const interpreters = names.filter((name) => isPythonExecutable(name, platform));
    if (!interpreters.length) plan.push({ directory, action: "keep" });
    else if (platform === "win32") plan.push({ directory, action: "drop", reason: `holds ${interpreters.join(", ")}` });
    else plan.push({ directory, action: "mirror", names: names.filter((name) => !interpreters.includes(name)) });
  }
  return plan;
}

/**
 * A child-process environment with `pathValue` as its only PATH and no
 * variable that names an interpreter. On Windows the variable is spelled
 * `Path` and environment names ignore case, so every spelling goes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} pathValue
 * @returns {NodeJS.ProcessEnv}
 */
export function environmentWithoutPython(env, pathValue) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") continue;
    if (["AI_DEV_PYTHON", "BGE_M3_PYTHON", "AI_DEV_EMBEDDINGS_PYTHON", "AI_DEV_PYTHON_BASE"].includes(upper)) continue;
    output[key] = value;
  }
  output.PATH = pathValue;
  return output;
}
