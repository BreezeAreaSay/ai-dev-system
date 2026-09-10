import path from "node:path";

export class CommandPolicyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CommandPolicyError";
    this.code = "COMMAND_POLICY_VIOLATION";
    this.details = details;
  }
}

const SHELL_EXECUTABLES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "wsl",
  "wsl.exe"
]);

const VERIFY_SCRIPT = /(?:^|[:._-])(test|lint|typecheck|type-check|check|validate|verify|build|format-check|audit|coverage|e2e|integration)(?:$|[:._-])/i;
const DEV_SCRIPT = /^(dev|start|serve|preview)(?::[\w.-]+)?$/i;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/;

// Flags that load or execute code, redirect output to an arbitrary file, or move
// the working package/directory out from under the policy. Two-character entries
// (`-c`, `-e`, …) are matched as a prefix so fused forms such as `-cimport os`
// are caught; longer entries must match the flag name exactly.
const DANGEROUS_FLAG_PREFIXES = [
  "-c", "-e", "-p", "-r", "-o", "-x",
  "--eval", "--print", "--require", "--import", "--loader", "--experimental-loader",
  "--experimental-vm-modules", "--experimental-network-imports",
  "--test-reporter", "--test-reporter-destination",
  "--config", "--configfile", "--rcfile", "--rc", "--plugin", "--resolve-plugins-relative-to",
  "--prefix", "--dir", "--cwd", "--filter", "--workspace", "--workspace-root",
  "--output", "--out-file", "--exec", "--rustc", "--ldflags", "--toolexec"
];
// A plain flag: one/two dashes, a leading letter, letters/digits/dashes, and an
// optional `=value` restricted to path/identifier characters (no whitespace, no
// shell metacharacters).
const SAFE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*(?:=[A-Za-z0-9@._:/\\*?,+-]*)?$/;
// A plain operand: a path or identifier. `..` is allowed by the character class
// but rejected explicitly by the traversal check below.
const SAFE_OPERAND = /^[A-Za-z0-9@._][A-Za-z0-9@._:/\\*?,+-]*$/;

function executableName(executable) {
  return path.basename(executable).toLowerCase();
}

/**
 * Split a command string into argv tokens while rejecting anything that implies
 * a shell: operators (`; | & > < \``), `$(...)`/`${...}` interpolation, control
 * characters, newlines, and unclosed quotes. Throws {@link CommandPolicyError}.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Non-empty argv token list (`tokens[0]` is the executable).
 */
export function tokenizeCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new CommandPolicyError("Command must be a non-empty string.");
  }
  if (/[\0\r\n]/.test(command)) {
    throw new CommandPolicyError("Control characters and multiline commands are forbidden.");
  }

  const tokens = [];
  let token = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (!quote && (char === "'" || char === "\"")) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    if (!quote && [";", "|", "&", ">", "<", "`"].includes(char)) {
      throw new CommandPolicyError(`Shell operator '${char}' is forbidden.`);
    }
    if (!quote && char === "$" && (next === "(" || next === "{")) {
      throw new CommandPolicyError("Shell interpolation is forbidden.");
    }
    if (char === "\\" && quote === "\"" && next === "\"") {
      token += "\"";
      index += 1;
      continue;
    }
    token += char;
  }
  if (quote) throw new CommandPolicyError("Unclosed quote in command.");
  if (token) tokens.push(token);
  if (!tokens.length) throw new CommandPolicyError("Command contains no executable.");
  return tokens;
}

function isDangerousFlag(arg, allowFlags) {
  const flag = arg.toLowerCase().split("=", 1)[0];
  if (allowFlags.includes(flag)) return false;
  return DANGEROUS_FLAG_PREFIXES.some((prefix) => (
    prefix.length <= 2 ? flag.startsWith(prefix) : flag === prefix
  ));
}

/**
 * Positively allowlist every argument of a policy command: reject PowerShell
 * command flags, code-loading / output-redirecting flags, values containing
 * shell metacharacters or whitespace, absolute paths, and `..` traversal. When
 * `projectRoot` is given, path-shaped operands must resolve inside it.
 */
function assertSafeArguments(args, { projectRoot, allowFlags = [] } = {}) {
  for (const arg of args) {
    if (arg === "--") continue; // argv separator, inert
    if (arg === "--%" || /^-(?:command|encodedcommand|ec|e|enc)$/i.test(arg)) {
      throw new CommandPolicyError(`Forbidden command flag: ${arg}`);
    }
    if (arg.startsWith("-")) {
      if (!SAFE_FLAG.test(arg)) {
        throw new CommandPolicyError(`Argument is not allowed in policy commands: ${arg}`);
      }
      if (isDangerousFlag(arg, allowFlags)) {
        throw new CommandPolicyError(`Flag is not allowed in policy commands: ${arg}`);
      }
      continue;
    }
    if (path.isAbsolute(arg)) {
      throw new CommandPolicyError(`Path argument must stay inside the project: ${arg}`);
    }
    if (!SAFE_OPERAND.test(arg)) {
      throw new CommandPolicyError(`Argument is not allowed in policy commands: ${arg}`);
    }
    const segments = arg.split(/[\\/]/);
    if (segments.includes("..")) {
      throw new CommandPolicyError(`Path argument must not traverse upwards: ${arg}`);
    }
    if (projectRoot && /[\\/]/.test(arg)) {
      const bare = arg.replace(/[*?].*$/, "");
      const resolved = path.resolve(projectRoot, bare);
      const relative = path.relative(path.resolve(projectRoot), resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new CommandPolicyError(`Path argument escapes the project: ${arg}`);
      }
    }
  }
}

function packageScript(tokens, purpose) {
  const manager = executableName(tokens[0]).replace(/\.cmd$/, "");
  let script;
  if (manager === "npm" || manager === "pnpm" || manager === "bun") {
    if (tokens[1] === "run") script = tokens[2];
    else if (tokens[1] === "test") script = "test";
  } else if (manager === "yarn") {
    script = tokens[1] === "run" ? tokens[2] : tokens[1];
  }
  if (!script || !SAFE_NAME.test(script) || script.includes("..")) {
    throw new CommandPolicyError("Only named package scripts are allowed.");
  }
  if (purpose === "quality" && !VERIFY_SCRIPT.test(`-${script}`)) {
    throw new CommandPolicyError(`Package script '${script}' is not a verification script.`);
  }
  if (purpose === "development" && !DEV_SCRIPT.test(script)) {
    throw new CommandPolicyError(`Package script '${script}' is not a development server script.`);
  }
  return { kind: purpose === "development" ? "development" : "verification", script };
}

function pythonCommand(tokens, purpose) {
  if (purpose !== "quality") {
    throw new CommandPolicyError("Python commands are not allowed for this purpose.");
  }
  const args = tokens.slice(1);
  if (args.some((arg) => /^-c/i.test(arg) || arg.toLowerCase() === "-" || arg.toLowerCase() === "-m pip")) {
    throw new CommandPolicyError("Inline Python and package installation are forbidden.");
  }
  if (args[0] === "-m") {
    const moduleName = String(args[1] ?? "").toLowerCase();
    if (!["pytest", "unittest", "compileall", "ruff", "mypy"].includes(moduleName)) {
      throw new CommandPolicyError(`Python module '${moduleName}' is not a verification tool.`);
    }
    return { kind: "verification", adapter: `python:${moduleName}` };
  }
  const script = String(args[0] ?? "").replaceAll("\\", "/");
  if (!/^(?:[\w.-]+\/)*(check|test|lint|validate)[\w.-]*\.py$/i.test(script)) {
    throw new CommandPolicyError("Only project verification scripts may run through Python.");
  }
  return { kind: "verification", adapter: "python:script", projectFile: script };
}

function directTool(tokens, purpose) {
  if (purpose !== "quality") {
    throw new CommandPolicyError("Direct verification tools are not development servers.");
  }
  const name = executableName(tokens[0]).replace(/\.exe$/, "");
  const adapters = new Map([
    ["pytest", "python:pytest"],
    ["ruff", "python:ruff"],
    ["mypy", "python:mypy"],
    ["pyright", "python:pyright"],
    ["eslint", "js:eslint"],
    ["tsc", "js:tsc"],
    ["vitest", "js:vitest"],
    ["jest", "js:jest"]
  ]);
  if (adapters.has(name)) return { kind: "verification", adapter: adapters.get(name) };
  if (name === "node" && ["--test", "--check"].includes(tokens[1])) {
    return { kind: "verification", adapter: `node:${tokens[1].slice(2)}` };
  }
  if (name === "cargo" && ["test", "check", "clippy", "fmt"].includes(tokens[1])) {
    return { kind: "verification", adapter: `rust:${tokens[1]}` };
  }
  if (name === "go" && ["test", "vet"].includes(tokens[1])) {
    return { kind: "verification", adapter: `go:${tokens[1]}` };
  }
  if (name === "dotnet" && ["test", "build", "format"].includes(tokens[1])) {
    return { kind: "verification", adapter: `dotnet:${tokens[1]}` };
  }
  if (name === "git" && tokens[1] === "diff" && tokens.includes("--check")) {
    const allowed = new Set(["diff", "--check", "--cached", "--staged", "HEAD"]);
    if (tokens.slice(1).every((token) => allowed.has(token))) {
      return { kind: "verification", adapter: "git:diff-check" };
    }
    throw new CommandPolicyError("Only `git diff --check [--cached] [HEAD]` is allowed.");
  }
  throw new CommandPolicyError(`Executable '${name}' is not approved for quality gates.`);
}

/**
 * Parse and allowlist a command for a specific purpose. Only named package
 * scripts (npm/pnpm/yarn/bun), a small set of verification tools (pytest, ruff,
 * mypy, eslint, tsc, `node --test/--check`, cargo/go/dotnet subcommands, …), and
 * whitelisted Python verification scripts are permitted; shells, `npx`, and
 * network fetchers are always rejected. Every argument is positively
 * allowlisted, and — when `projectRoot` is given — path-shaped operands must
 * resolve inside it. Throws {@link CommandPolicyError}.
 *
 * @param {string} command - Raw command line.
 * @param {{ purpose?: "quality" | "development", projectRoot?: string }} [options] - Intended use and, optionally, the directory path operands must stay inside.
 * @returns {{ executable: string, args: string[], display: string, purpose: string, kind: string, script?: string, adapter?: string, projectFile?: string }}
 */
export function parseSafeCommand(command, { purpose = "quality", projectRoot } = {}) {
  if (!["quality", "development"].includes(purpose)) {
    throw new CommandPolicyError(`Unknown command purpose: ${purpose}`);
  }
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];
  const args = tokens.slice(1);
  const name = executableName(executable);
  if (executable.split(/[\\/]/).includes("..")) {
    throw new CommandPolicyError(`Executable path must not traverse upwards: ${executable}`);
  }
  if (SHELL_EXECUTABLES.has(name)) {
    throw new CommandPolicyError("Shell interpreters are forbidden.");
  }
  if (["npx", "npx.cmd", "npm-exec", "curl", "curl.exe", "wget", "wget.exe"].includes(name)) {
    throw new CommandPolicyError(`Dynamic or network executable '${name}' is forbidden.`);
  }

  let classification;
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe"].includes(name)) {
    classification = packageScript(tokens, purpose);
  } else if (/^(python|python3|py)(?:\.exe)?$/.test(name) || /python(?:3)?\.exe$/.test(name)) {
    classification = pythonCommand(tokens, purpose);
  } else {
    classification = directTool(tokens, purpose);
  }

  assertSafeArguments(args, { projectRoot, allowFlags: classification.allowFlags ?? [] });

  return {
    executable,
    args,
    display: [executable, ...args].join(" "),
    purpose,
    ...classification
  };
}

/**
 * Guard that an executable path lives inside `projectRoot`. Bare executable
 * names (resolved from `PATH`) pass through; anything containing a path
 * separator must resolve inside the project. Throws {@link CommandPolicyError}.
 *
 * @param {{ executable: string }} parsed - Result of {@link parseSafeCommand}.
 * @param {string} projectRoot - Directory the executable must be under.
 * @returns {typeof parsed} The same object, on success.
 */
export function validateProjectExecutable(parsed, projectRoot) {
  const executable = parsed.executable;
  if (!/[\\/]/.test(executable)) return parsed;
  const root = path.resolve(projectRoot);
  const resolved = path.isAbsolute(executable) ? path.resolve(executable) : path.resolve(root, executable);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CommandPolicyError("Executable paths must live inside the project.", {
      executable: parsed.executable,
      projectRoot
    });
  }
  return parsed;
}

/**
 * Classify why a command is risky (file deletion, `git reset --hard`, dependency
 * mutation, deploy/migrate, system mutation, shell interpreter, …) for
 * confirmation prompts. Never throws.
 *
 * @param {string} command - Raw command line.
 * @returns {string} Short risk reason, or `""` when nothing risky was detected.
 */
export function commandRiskReason(command) {
  let tokens;
  try {
    tokens = tokenizeCommand(String(command ?? ""));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const executable = executableName(tokens[0]).replace(/\.(?:exe|cmd)$/, "");
  const lower = tokens.map((item) => item.toLowerCase());
  const joined = lower.join(" ");
  if (SHELL_EXECUTABLES.has(executable) || SHELL_EXECUTABLES.has(`${executable}.exe`)) {
    return "shell interpreter";
  }
  if (["rm", "del", "erase", "rmdir", "remove-item"].includes(executable)) return "file deletion";
  if (executable === "git" && lower[1] === "reset" && lower.includes("--hard")) return "destructive git reset";
  if (executable === "git" && lower[1] === "clean") return "destructive git clean";
  if (["npm", "pnpm", "yarn", "bun"].includes(executable) && /( install| add| remove| update| audit fix| ci)( |$)/.test(` ${joined}`)) {
    return "dependency mutation";
  }
  if (["pip", "pip3", "poetry", "uv"].includes(executable) && /( install| add| remove| sync| update)/.test(` ${joined}`)) {
    return "dependency or environment mutation";
  }
  if (executable === "python" && lower[1] === "-m" && lower[2] === "pip") return "dependency mutation";
  if (/(^| )(deploy|publish|release|migrate|migration|upgrade|rollback|seed|apply|destroy)( |$)/.test(joined)) {
    return "deployment, migration, or infrastructure mutation";
  }
  if (["shutdown", "diskpart", "format"].includes(executable)) return "system mutation";
  return "";
}
