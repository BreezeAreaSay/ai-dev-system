import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The `src/mcp-stdio.mjs` line budget. It lives in src/core so the System
// Dashboard reports the ceiling this gate enforces: the file shrinks one
// extraction at a time (docs/ecc-upgrades/PLAN.md, stage 1) and the ceiling is
// re-pinned to its actual size plus roughly 300 lines of working room after each
// step, so the file can be edited but not re-grown.
import { SYSTEM_LINE_CEILING } from "../src/core/system-health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const skipDirectories = new Set(["node_modules", ".git", "coverage"]);

// The same soft ceiling COMMON_RULES puts on user projects ("800 lines is the
// soft ceiling", src/core/rules-catalog.mjs) applied to our own modules.
const MODULE_LINE_CEILING = 800;

// Modules that were already over the ceiling when the rule landed. Each is
// pinned at its current size: it may shrink, never grow, and its entry has to be
// dropped once it is back under the ceiling. Both are the frontend pair that
// stage 1.3 of the plan splits when the frontend tools leave `mcp-stdio.mjs`;
// splitting them here would have mixed a refactor into a lint change.
const MODULE_LINE_EXCEPTIONS = new Map([
  ["src/core/frontend-product-quality.mjs", 1222],
  ["src/core/reference-factory.mjs", 812]
]);

function countLines(source) {
  return source.split(/\r?\n/).length;
}

async function sourceFiles(directory) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  await walk(directory);
  return files.sort();
}

const files = [
  ...await sourceFiles(path.join(root, "src")),
  ...await sourceFiles(path.join(root, "scripts"))
];
const findings = [];
const seenExceptions = new Set();
for (const file of files) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const syntax = spawnSync(node, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (syntax.status !== 0) {
    findings.push(`${relative}: syntax check failed: ${(syntax.stderr || syntax.stdout).trim()}`);
  }
  const source = await fs.readFile(file, "utf8");
  if (relative !== "scripts/static-quality.mjs") {
    if (/\beval\s*\(/.test(source)) findings.push(`${relative}: eval() is forbidden.`);
    if (/\bnew\s+Function\s*\(/.test(source)) findings.push(`${relative}: new Function() is forbidden.`);
    if (/\bshell\s*:\s*true\b/.test(source)) findings.push(`${relative}: shell:true is forbidden.`);
  }
  if (
    /from\s+["']node:child_process["']/.test(source) &&
    /import\s*\{[^}]*\bexec\b[^}]*\}/s.test(source)
  ) {
    findings.push(`${relative}: child_process.exec is forbidden; use argv-based execution.`);
  }
  if (relative.startsWith("src/core/") || relative.startsWith("src/extensions/")) {
    const moduleLines = countLines(source);
    const allowance = MODULE_LINE_EXCEPTIONS.get(relative);
    if (allowance === undefined) {
      if (moduleLines > MODULE_LINE_CEILING) {
        findings.push(`${relative}: ${moduleLines} lines exceeds the ${MODULE_LINE_CEILING}-line module ceiling. Split it, or pin it in MODULE_LINE_EXCEPTIONS with a reason.`);
      }
    } else {
      seenExceptions.add(relative);
      if (moduleLines <= MODULE_LINE_CEILING) {
        findings.push(`${relative}: ${moduleLines} lines is back under the ${MODULE_LINE_CEILING}-line ceiling; drop its MODULE_LINE_EXCEPTIONS entry.`);
      } else if (moduleLines > allowance) {
        findings.push(`${relative}: ${moduleLines} lines exceeds its pinned allowance of ${allowance}. A pinned module may only shrink.`);
      }
    }
  }
}
for (const relative of MODULE_LINE_EXCEPTIONS.keys()) {
  if (!seenExceptions.has(relative)) {
    findings.push(`${relative}: MODULE_LINE_EXCEPTIONS names a module that no longer exists; drop the entry.`);
  }
}

const runtimePath = path.join(root, "src", "mcp-stdio.mjs");
const runtimeLines = countLines(await fs.readFile(runtimePath, "utf8"));
if (runtimeLines > SYSTEM_LINE_CEILING) {
  findings.push(`src/mcp-stdio.mjs: ${runtimeLines} lines exceeds the ${SYSTEM_LINE_CEILING.toLocaleString("en-US")}-line modularity ceiling.`);
}
const definitionsPath = path.join(root, "src", "tool-definitions.mjs");
if (!await fs.stat(definitionsPath).then((item) => item.isFile()).catch(() => false)) {
  findings.push("src/tool-definitions.mjs: extracted tool metadata module is missing.");
}

const { tools } = await import("../src/mcp-stdio.mjs");
const names = new Set();
for (const tool of tools) {
  if (!tool?.name || typeof tool.name !== "string") findings.push("Tool without a valid name.");
  if (names.has(tool.name)) findings.push(`Duplicate MCP tool name: ${tool.name}.`);
  names.add(tool.name);
  if (tool?.inputSchema?.type !== "object") {
    findings.push(`${tool.name}: inputSchema must be an object schema.`);
  }
}

const { PROMPTS } = await import("../src/server.mjs");
const promptNames = new Set();
for (const prompt of PROMPTS) {
  if (!prompt?.name || typeof prompt.name !== "string") findings.push("Prompt without a valid name.");
  // GetPrompt resolves by `find`, so a duplicate name is dead weight, not an override.
  if (promptNames.has(prompt.name)) findings.push(`Duplicate MCP prompt name: ${prompt.name}.`);
  promptNames.add(prompt.name);
  if (typeof prompt?.render !== "function") findings.push(`${prompt.name}: prompt must define a render function.`);
}

if (findings.length) {
  console.error(["Static quality gate failed:", ...findings.map((item) => `- ${item}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "passed",
    checked_files: files.length,
    tools: tools.length,
    prompts: PROMPTS.length,
    runtime_lines: runtimeLines,
    modularity_ceiling: SYSTEM_LINE_CEILING,
    module_line_ceiling: MODULE_LINE_CEILING,
    pinned_modules: MODULE_LINE_EXCEPTIONS.size
  }, null, 2));
}
