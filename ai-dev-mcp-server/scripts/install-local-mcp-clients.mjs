#!/usr/bin/env node
/**
 * The 2.x local client installer. It wrote the server as `ai-dev-system`,
 * while the Docker installer wrote `ai-dev`, so a machine that ran both listed
 * the server twice (docs/DEFECTS.md, Д-95). Both write through one module now
 * (`src/core/mcp-clients.mjs`), and this command is `ai-dev clients install`:
 * kept until 4.0 with a note on stderr, the same flags, and the same JSON on
 * stdout — dry run unless `--apply`.
 */
import { main } from "../src/cli/main.mjs";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const rest = argv.filter((argument) => argument !== "--apply");
if (rest.includes("--help") || rest.includes("-h")) {
  process.stdout.write("Usage: node scripts/install-local-mcp-clients.mjs [--apply] [--clients <names>]\n"
    + "Replaced by `ai-dev clients install` (npm run clients:install); see `ai-dev help clients`.\n");
} else {
  process.stderr.write("ai-dev: install-local-mcp-clients.mjs is `ai-dev clients install` now (npm run clients:install); "
    + "it writes the server as ai-dev and removes ai-dev-system. This path stays until 4.0.\n");
  process.exitCode = await main(["clients", "install", "--json", ...(apply ? [] : ["--dry-run"]), ...rest]);
}
