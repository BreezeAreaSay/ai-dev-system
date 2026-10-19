import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The bootstrap scripts of the Docker path, against a `docker` that writes down
// every call and answers what each step needs. 3.0 cut them down to three steps
// (program phase 13): check Docker, pull the image, write the client configs —
// the configs run `docker run -i --rm …` themselves, written by the image on
// Linux and macOS and by the checkout's own CLI on Windows.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const bootstrap = path.join(repositoryRoot, "bootstrap.sh");
const bootstrapPowerShell = path.join(repositoryRoot, "bootstrap.ps1");
const shell = process.platform === "win32"
  ? [
      process.env.AI_DEV_TEST_SH,
      "C:\\Program Files\\Git\\bin\\sh.exe",
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
    ].find((candidate) => candidate && existsSync(candidate)) || "sh"
  : "sh";

// AI_DEV_MODEL_PATH is blanked: both installers read it as the default model
// folder, and a developer who has it set is not what these plans are about.
function plan(args, home, env = {}) {
  return spawnSync(shell, [bootstrap, "--plan", "--project-path", path.join(home, "projects"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", AI_DEV_HOME: "", AI_DEV_STATE_ROOT: "", ...env }
  });
}

test("Unix bootstrap defaults to the published image without a local build", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-"));
  try {
    const result = plan([], home);
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image, "ghcr.io/stonebridgeway/ai-dev-system:latest");
    assert.equal(output.build_local, 0);
    assert.equal(output.node_on_host_required, false);
    assert.equal(output.clients, "all");
    assert.equal(output.state_path, path.join(home, ".ai-dev", "state"));
    // Д-69: the model folder is optional, and an absent option leaves the plan exactly as it was.
    assert.equal("model_path" in output, false);
    assert.equal("runtime_container" in output, false, "3.0 keeps no long-lived container");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Unix bootstrap keeps local source builds explicit, and --model-path shows up in the plan only when given", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-"));
  try {
    const result = plan(["--build-local"], home);
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image, "ai-dev-system:local");
    assert.equal(output.build_local, 1);
    const withModels = plan(["--model-path", path.join(home, "models")], home);
    assert.equal(JSON.parse(withModels.stdout).model_path, path.join(home, "models"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// bootstrap.sh is run by sh, the entrypoint by the image, the 2.x launcher by
// configs that name it. All were committed as 100644 once (docs/DEFECTS.md
// Д-58); the repository does store the bit, so the mode is asserted rather than
// trusted.
test("the shell scripts that get executed are committed as executable", async (context) => {
  const executables = ["bootstrap.sh", "docker/run-mcp.sh", "docker/entrypoint.sh"];
  const result = spawnSync("git", ["ls-files", "-s", "--", ...executables], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    context.skip("git is unavailable on this host");
    return;
  }
  if (result.status !== 0) {
    context.skip(`git ls-files failed: ${result.stderr.trim()}`);
    return;
  }
  const modes = new Map(result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [meta, file] = line.split("\t");
    return [file, meta.split(" ")[0]];
  }));
  for (const file of executables) assert.equal(modes.get(file), "100755", `${file} is not committed as executable`);
});

/**
 * A `docker` that logs each call (one line, the arguments joined by tabs) and
 * answers as a working engine would: the version, a pull (or a failed one, with
 * a cached copy of the image), the handshake with the server's instructions, and
 * for `ai-dev clients entry` an entry as JSON. PULL=fail makes the pull fail;
 * SMOKE=bad answers the handshake with something that is not the server's;
 * NO_CLI names the images without the 3.0 installer (2.x ones), space-separated;
 * INSTALL=fail makes the installer fail as one client it could not write does.
 * The probe of the state folder writes nothing, as where Docker maps the
 * container's users; PROBE=shared writes the file as this user, PROBE=refused
 * is the container's own `touch` refused, and PROBE=broken a Docker that did
 * not run the image at all. MOUNT_DENY names a folder Docker refuses to mount,
 * as Docker Desktop refuses one outside its file sharing — with MOUNT_DENY_SAYS=
 * desktop in Docker Desktop's words, over lines ending in CRLF. TRUE_FAIL fails
 * the throwaway runs (`--entrypoint true`) as a failing engine does: `deadline`
 * (a timeout), `overlay` (a storage driver error that names a mount), `silent`
 * (exit 137, nothing said), `once` (only the first one: a passing flake), `bare`
 * (only the one with no folder: the engine check, flaking).
 */
const stubDocker = [
  "#!/bin/sh",
  "{ first=1; for a in \"$@\"; do if [ $first = 1 ]; then printf '%s' \"$a\"; first=0; else printf '\\t%s' \"$a\"; fi; done; printf '\\n'; } >> \"$STUB_LOG\"",
  'sub="$1"',
  "shift",
  'case "$sub" in',
  "  version) echo 27.0.0; exit 0 ;;",
  '  pull) if [ "${PULL:-}" = fail ]; then echo "Error response from daemon: unauthorized" >&2; exit 1; fi; exit 0 ;;',
  "  image)",
  '    for a in "$@"; do',
  '      case "$a" in',
  "        *Created*) echo 2019-01-02T03:04:05.000000000Z; exit 0 ;;",
  "        *RepoDigests*) echo ghcr.io/example/ai-dev-system@sha256:cafebabe; exit 0 ;;",
  "      esac",
  "    done",
  "    exit 0 ;;",
  '  inspect) [ -n "${OLD_RUNTIME:-}" ] && { echo true; exit 0; }; exit 1 ;;',
  "  rm) exit 0 ;;",
  "  run)",
  '    if [ -n "${MOUNT_DENY:-}" ]; then for a in "$@"; do case "$a" in *"source=${MOUNT_DENY},"*)',
  '      if [ "${MOUNT_DENY_SAYS:-}" = desktop ]; then printf "docker: Error response from daemon: Mounts denied: \\r\\nThe path %s is not shared from the host and is not known to Docker.\\r\\nYou can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.\\r\\n" "$MOUNT_DENY" >&2;',
  '      else echo "docker: Error response from daemon: Mounts denied: the path ${MOUNT_DENY} is not shared from the host." >&2; fi; exit 125 ;; esac; done; fi',
  '    if [ -n "${TRUE_FAIL:-}" ]; then prev=""; for a in "$@"; do',
  '      if [ "$prev" = --entrypoint ] && [ "$a" = true ]; then',
  '        case "$TRUE_FAIL" in',
  '          silent) exit 137 ;;',
  '          overlay) echo "docker: Error response from daemon: error creating overlay mount to /var/lib/docker/overlay2/3f9c1a-init/merged: no such file or directory." >&2; exit 125 ;;',
  '          once) [ "$(grep -c -e "$(printf \'%s\\t%s\' --entrypoint true)" "$STUB_LOG")" -gt 1 ] && break ;;',
  '          bare) for m in "$@"; do [ "$m" = --mount ] && break 2; done ;;',
  '        esac',
  '        echo "docker: Error response from daemon: failed to create task for container: context deadline exceeded" >&2; exit 125',
  '      fi',
  '      prev=$a',
  '    done; fi',
  '    for a in "$@"; do [ "$a" = "command -v ai-dev" ] && { for i in "$@"; do case " ${NO_CLI:-} " in *" $i "*) exit 1 ;; esac; done; exit 0; }; done',
  '    for a in "$@"; do',
  '      [ "$a" = touch ] || continue',
  '      case "${PROBE:-}" in',
  '        shared) for m in "$@"; do case "$m" in type=bind,source=*,target=/ai-dev-state) s="${m#type=bind,source=}"; s="${s%,target=/ai-dev-state}" ;; esac; f="$m"; done; touch "$s/${f#/ai-dev-state/}" ;;',
  '        refused) echo "touch: cannot touch \'/ai-dev-state/probe\': Permission denied" >&2; exit 1 ;;',
  '        broken) echo "docker: Error response from daemon: failed to connect to the docker API." >&2; echo "Run \'docker run --help\' for more information" >&2; exit 125 ;;',
  '      esac',
  '      exit 0',
  '    done',
  '    for a in "$@"; do [ "$a" = entry ] && { echo \'{"type":"stdio","command":"/usr/bin/docker","args":["run","-i","--rm","stub"]}\'; exit 0; }; done',
  '    for a in "$@"; do [ "$a" = install ] && { [ "${INSTALL:-}" = fail ] && { echo "  Cursor   FAILED  ~/.cursor/mcp.json: EACCES" >&2; exit 1; }; echo "  Cursor   added   ~/.cursor/mcp.json"; exit 0; }; done',
  '    cat > /dev/null',
  '    if [ "${SMOKE:-}" = bad ]; then echo \'{"result":{"serverInfo":{"name":"made-up"}}}\'; else echo \'{"result":{"serverInfo":{"name":"ai-dev-system"},"instructions":"Begin with begin_task."}}\'; fi',
  "    exit 0 ;;",
  "esac",
  "exit 0",
  ""
].join("\n");

/** A `claude` CLI that writes down what it was asked. */
const stubClaude = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CLAUDE_LOG\"\n";

/** A PATH folder with the host's tools, minus a docker or a claude of its own: only the stubs answer to those names. */
async function hostToolsWithout(directory, hidden = ["docker", "claude"]) {
  await fs.mkdir(directory, { recursive: true });
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (hidden.includes(name) || existsSync(path.join(directory, name))) continue;
      await fs.symlink(path.join(folder, name), path.join(directory, name)).catch(() => {});
    }
  }
  return directory;
}

/**
 * Run bootstrap.sh in a home of its own with the stubs first on PATH; `folders`, `files` and `links` are made in
 * that home first — `links` as written, `absoluteLinks` to a path of the home, `rootLinks` to the path given.
 */
async function runBootstrap(t, args, { env = {}, folders = [], files = {}, links = {}, absoluteLinks = {}, rootLinks = {}, claude = false, docker = true, homeSuffix = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  for (const folder of folders) await fs.mkdir(path.join(home, folder), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), content);
  }
  for (const [link, target] of Object.entries(links)) await fs.symlink(target, path.join(home, link));
  for (const [link, target] of Object.entries(absoluteLinks)) await fs.symlink(path.join(home, target), path.join(home, link));
  for (const [link, target] of Object.entries(rootLinks)) await fs.symlink(target, path.join(home, link));
  if (docker) await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  if (claude) await fs.writeFile(path.join(bin, "claude"), stubClaude, { mode: 0o755 });
  const log = path.join(root, "docker.log");
  const claudeLog = path.join(root, "claude.log");
  const hostPath = await hostToolsWithout(path.join(root, "tools"));
  const result = spawnSync(shell, [bootstrap, "--project-path", path.join(home, "projects"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env, HOME: `${home}${homeSuffix}`, XDG_CONFIG_HOME: "", CODEX_HOME: "", AI_DEV_HOME: "", AI_DEV_MODEL_PATH: "",
      AI_DEV_STATE_ROOT: "", STUB_LOG: log, CLAUDE_LOG: claudeLog, PATH: `${bin}${path.delimiter}${hostPath}`, ...env
    }
  });
  if (result.error?.code === "ENOENT") {
    t.skip("sh is unavailable on this host");
    return null;
  }
  const calls = (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => line.split("\t"));
  return { ...result, home, calls, claude: await fs.readFile(claudeLog, "utf8").catch(() => "") };
}

const mounts = (call) => call.flatMap((argument, index) => (call[index - 1] === "--mount" ? [argument] : []));

test("without Docker nothing is installed: the script says where Docker comes from", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, [], { docker: false });
  if (!result) return;
  assert.equal(result.status, 69, result.stderr);
  assert.match(result.stderr, /Docker is required: install Docker Desktop \(macOS\) or Docker Engine \(Linux\) — https:\/\/docs\.docker\.com\/get-docker\//);
  const old = await runBootstrap(t, ["--install-prerequisites"], { docker: false });
  assert.match(old.stderr, /--install-prerequisites: bootstrap\.sh no longer installs Docker/, "a 2.x command line is told, not refused");
});

test("a failed pull with a cached image stops instead of installing it; --allow-stale-image goes on and keeps saying so", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const stopped = await runBootstrap(t, ["--skip-smoke", "--skip-client-install"], { env: { PULL: "fail" } });
  if (!stopped) return;
  assert.equal(stopped.status, 69, `stdout: ${stopped.stdout}\nstderr: ${stopped.stderr}`);
  assert.match(stopped.stderr, /2019-01-02T03:04:05/, "the age of the cached image is not reported");
  assert.match(stopped.stderr, /sha256:cafebabe/, "the digest of the cached image is not reported");
  assert.match(stopped.stderr, /--allow-stale-image/, "the override is not offered");
  assert.equal(stopped.calls.filter((call) => call[0] === "run").length, 0, "nothing ran on an image of unknown age");

  const allowed = await runBootstrap(t, ["--skip-smoke", "--skip-client-install", "--allow-stale-image"], { env: { PULL: "fail" } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /Installed from a stale image\. Registry pull failed\. The cached copy .* 2019-01-02T03:04:05/);
});

test("the handshake check wants the server's own answer, instructions and all (Д-89)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const good = await runBootstrap(t, ["--skip-client-install"]);
  if (!good) return;
  assert.equal(good.status, 0, good.stderr);
  const smoke = good.calls.find((call) => call[0] === "run");
  assert.ok(smoke.includes("--network") && smoke[smoke.indexOf("--network") + 1] === "none");
  assert.ok(mounts(smoke).includes("type=volume,source=ai-dev-system-data,target=/data"), "the check fills the data volume as a session would");
  const bad = await runBootstrap(t, ["--skip-client-install"], { env: { SMOKE: "bad" } });
  assert.equal(bad.status, 70, "a serverInfo with no instructions is what a 2.x launcher made up");
  assert.match(bad.stderr, /did not answer the MCP handshake/);
});

test("the image writes the configs with each client's own folder mounted, and nothing else of the home", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke"], { folders: [".cursor", ".config/Claude", ".codex", ".unrelated"] });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.ok(install, JSON.stringify(result.calls));
  const home = await fs.realpath(result.home).catch(() => result.home);
  const sources = mounts(install).map((mount) => mount.split(",").find((part) => part.startsWith("source="))?.slice("source=".length));
  // The state folder by its real path, as `--state` below: the temp folder can be a link (docs/DEFECTS.md, Д-373).
  const state = await fs.realpath(path.join(result.home, ".ai-dev", "state"));
  assert.deepEqual(sources.sort(), [state, path.join(result.home, ".codex"), path.join(result.home, ".config", "Claude"), path.join(result.home, ".cursor")].sort());
  assert.ok(!sources.includes(result.home) && !sources.includes(home), "the home itself is not mounted");
  for (const mount of mounts(install)) {
    const [source, target] = ["source=", "target="].map((key) => mount.split(",").find((part) => part.startsWith(key)).slice(key.length));
    assert.equal(target, source, "each folder at its own path, so the configs name the host's paths");
  }
  // What the configs will run: the image, the projects at their own path, the state, the host user.
  const word = (name) => install.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  assert.equal(word("clients"), "claude-desktop,cursor,codex", "the clients found here; Claude Code goes through its own CLI");
  assert.equal(word("image"), "ghcr.io/stonebridgeway/ai-dev-system:latest");
  assert.equal(word("projects"), await fs.realpath(path.join(result.home, "projects")));
  assert.equal(word("state"), state);
  assert.equal(word("home"), result.home);
  assert.ok(install.includes("--docker") && install.includes("ai-dev") && install.includes("clients"));
  assert.ok(install.includes("--network") && install[install.indexOf("--network") + 1] === "none");
  // The installer runs as the host user (the configs are theirs); the configs run the image's.
  assert.equal(install[install.indexOf("--user") + 1], `${process.getuid()}:${process.getgid()}`);
  assert.equal(word("user"), undefined);
  assert.match(result.stdout, /AI Dev is ready/);
});

test("with every client the default and none here, nothing is written and that is said, not that clients need a restart (Д-406)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke"], { folders: [".unrelated"] });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.find((call) => call[0] === "run" && call.includes("install")), undefined, "no installer run, nothing written");
  assert.match(result.stdout, /No AI client found here \(Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI\)\. Name one to write its config anyway, --clients cursor,vscode,…, or install one and run bootstrap\.sh again\./);
  assert.match(result.stdout, /AI Dev is ready; no AI client is connected to it yet\.\n$/);
  assert.doesNotMatch(result.stdout, /Restart the AI clients/);
  // A client found: the usual last line, and no word of a missing one.
  const found = await runBootstrap(t, ["--skip-smoke"], { folders: [".cursor"] });
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /AI Dev is ready\. Restart the AI clients to load ai-dev\.\n$/);
  assert.doesNotMatch(found.stdout, /No AI client found here/);
});

test("the last line says what was done to the clients: left as they were, written, or none found — and a client found is never one missing (Д-415, Д-417)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  // --skip-client-install with a client here: nothing written, and no restart asked for.
  const skipped = await runBootstrap(t, ["--skip-smoke", "--skip-client-install"], { folders: [".cursor"] });
  if (!skipped) return;
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.calls.find((call) => call[0] === "run" && (call.includes("install") || call.includes("entry"))), undefined, "no installer run");
  assert.match(skipped.stdout, /\nAI Dev is ready; the AI clients' configs were left as they were\.\n$/);
  assert.doesNotMatch(skipped.stdout, /Restart the AI clients|No AI client found here/);

  // Only Claude Code here, written by its own CLI: the installer writes nothing, and a client was still connected.
  const claudeOnly = await runBootstrap(t, ["--skip-smoke"], { folders: [".claude", ".unrelated"], claude: true });
  assert.equal(claudeOnly.status, 0, claudeOnly.stderr);
  assert.equal(claudeOnly.calls.find((call) => call[0] === "run" && call.includes("install")), undefined);
  assert.match(claudeOnly.stdout, /Claude Code {13}added through `claude mcp add-json`\nAI Dev is ready\. Restart the AI clients to load ai-dev\.\n$/);
  assert.doesNotMatch(claudeOnly.stdout, /No AI client found here/);

  // The one client here was refused by Docker: a client that failed, not none found, and the exit says so.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unshared-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const unshared = await fs.realpath(root);
  await fs.writeFile(path.join(unshared, "mcp.json"), "{}");
  const refused = await runBootstrap(t, ["--skip-smoke"], { env: { MOUNT_DENY: unshared }, folders: [".cursor"], rootLinks: { ".cursor/mcp.json": path.join(unshared, "mcp.json") } });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Cursor: Docker did not take a folder its config leads to .*: not configured\.\nSome AI clients were not configured/);
  assert.equal(refused.calls.find((call) => call[0] === "run" && call.includes("install")), undefined);
  assert.doesNotMatch(`${refused.stdout}${refused.stderr}`, /No AI client found here|AI Dev is ready/);
});

test("a client named on the command line gets its folder made and mounted; Claude Code is written by its own CLI", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "gemini,claude"], { claude: true, files: { ".claude.json": "{}" } });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  await fs.access(path.join(result.home, ".gemini"));
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.ok(mounts(install).some((mount) => mount.includes(`source=${path.join(result.home, ".gemini")},`)));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=claude-desktop,gemini");
  assert.ok(result.calls.some((call) => call[0] === "run" && call.includes("entry") && call.includes("claude-code")));
  const lines = result.claude.trim().split("\n");
  assert.deepEqual(lines.slice(0, 2), ["mcp remove ai-dev --scope user", "mcp remove ai-dev-system --scope user"]);
  assert.match(lines[2], /^mcp add-json ai-dev \{"type":"stdio","command":"\/usr\/bin\/docker",.*\} --scope user$/);
  const backups = (await fs.readdir(result.home)).filter((name) => name.startsWith(".claude.json.backup-"));
  assert.equal(backups.length, 1, "the file the CLI rewrites is kept first");
  // Without the CLI, the command is printed for the person to run.
  const without = await runBootstrap(t, ["--skip-smoke", "--clients", "claude-code"], { files: { ".claude.json": "{}" } });
  assert.match(without.stderr, /Claude Code: its CLI is not on PATH here\. Add the entry with:\n {2}claude mcp add-json ai-dev '\{"type":"stdio"/);
});

test("the 2.x runtime container is removed once the configs that named it are rewritten, not before (Д-328)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke"], { env: { OLD_RUNTIME: "1" }, folders: [".cursor"] });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const removed = result.calls.findIndex((call) => call[0] === "rm" && call.includes("-f") && call.at(-1) === `ai-dev-system-runtime-${process.getuid()}`);
  const installed = result.calls.findIndex((call) => call[0] === "run" && call.includes("install"));
  assert.ok(removed > installed && installed >= 0, JSON.stringify(result.calls.map((call) => call.slice(0, 3))));
  assert.match(result.stdout, /Removing the 2\.x runtime container/);
  const kept = await runBootstrap(t, ["--skip-smoke", "--skip-client-install"], { env: { OLD_RUNTIME: "1" } });
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(!kept.calls.some((call) => call[0] === "rm"), "configs not rewritten still name it");
});

test("a client that is not one, no client at all, or a folder a mount cannot hold stops the script before anything runs (Д-328, Д-336)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const typo = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,cursr"]);
  if (!typo) return;
  assert.equal(typo.status, 64, typo.stderr);
  assert.match(typo.stderr, /--clients: "cursr" is no client here \(all, claude, claude-code, claude-desktop, cursor, vscode, codex, gemini\)/);
  assert.equal(typo.calls.filter((call) => call[0] === "pull" || call[0] === "run").length, 0);
  for (const none of ["", ","]) {
    const empty = await runBootstrap(t, ["--skip-smoke", "--clients", none], { env: { OLD_RUNTIME: "1" } });
    assert.equal(empty.status, 64, `--clients "${none}": ${empty.stderr}`);
    assert.match(empty.stderr, /--clients: name at least one client, or all\./);
    assert.ok(!empty.calls.some((call) => call[0] === "rm" || call[0] === "pull"), "nothing is written, and nothing removed");
  }
  const quoted = await runBootstrap(t, ["--skip-smoke", "--project-path", path.join(os.tmpdir(), 'my "quoted" projects')]);
  assert.equal(quoted.status, 64, quoted.stderr);
  assert.match(quoted.stderr, /has a comma or a double quote, which a docker --mount cannot hold/);
});

test("the state folder is the one the hooks use: AI_DEV_STATE_ROOT, AI_DEV_HOME's, ~/.ai-dev/state (Д-328)", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-"));
  try {
    const read = (env) => JSON.parse(plan([], home, env).stdout).state_path;
    const first = plan([], home);
    if (first.error?.code === "ENOENT") return context.skip("sh is unavailable on this host");
    assert.equal(read({}), path.join(home, ".ai-dev", "state"));
    assert.equal(read({ AI_DEV_HOME: home }), path.join(home, ".ai-dev", "state"), "AI_DEV_HOME naming the home keeps 2.x's meaning (D2)");
    assert.equal(read({ AI_DEV_HOME: path.join(home, "runtime") }), path.join(home, "runtime", "state"));
    assert.equal(read({ AI_DEV_STATE_ROOT: path.join(home, "elsewhere"), AI_DEV_HOME: path.join(home, "runtime") }), path.join(home, "elsewhere"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a 2.x image, the way back, gets its configs from the 3.0 installer, pulled and seen to have one (Д-323, Д-329)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke", "--image", "example/ai-dev-system:2"], { env: { NO_CLI: "example/ai-dev-system:2", AI_DEV_INSTALLER_IMAGE: "example/installer:3" }, folders: [".cursor"] });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /example\/ai-dev-system:2 has no installer of its own \(a 2\.x image\): example\/installer:3 writes the configs that run it/);
  assert.ok(result.calls.some((call) => call[0] === "pull" && call[1] === "example/installer:3"), "a cached installer may be a 2.x one: it is pulled");
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.ok(install.includes("example/installer:3"), "the installer runs from the 3.0 image");
  assert.ok(install.includes("--image=example/ai-dev-system:2"), "and the configs run the image asked for");
  for (const check of result.calls.filter((call) => call.includes("command -v ai-dev"))) {
    // Both images are here by then; a Docker CLI before 20.10 knows no --pull (Д-344).
    assert.ok(!check.includes("--pull"), check.join(" "));
  }

  // An installer image that is a 2.x one too is refused, by name, before any config is written.
  const both = await runBootstrap(t, ["--skip-smoke", "--image", "example/ai-dev-system:2"], { env: { NO_CLI: "example/ai-dev-system:2 example/installer:2", AI_DEV_INSTALLER_IMAGE: "example/installer:2" }, folders: [".cursor"] });
  assert.equal(both.status, 69, both.stderr);
  assert.match(both.stderr, /example\/installer:2 has no installer either \(a 2\.x image too\): name an image of 3\.0 or later with AI_DEV_INSTALLER_IMAGE/);
  assert.ok(!both.calls.some((call) => call[0] === "run" && call.includes("install")));
});

test("the state folder is shared only where the image's user wrote it as this user; a Docker that did not run it tried nothing (Д-322, Д-331)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const shared = (call) => call.find((argument) => argument.startsWith("--shared-state="))?.slice("--shared-state=".length);
  const linux = process.platform !== "darwin";
  const written = await runBootstrap(t, ["--skip-smoke"], { env: { PROBE: "shared" }, folders: [".cursor"] });
  if (!written) return;
  assert.equal(written.status, 0, written.stderr);
  const probe = written.calls.find((call) => call[0] === "run" && call.includes("touch"));
  assert.equal(Boolean(probe), linux, "tried on Linux whatever the uid; Docker Desktop on macOS gives the files to the user");
  if (probe) {
    // The image is here by then: no --pull, which a Docker CLI before 20.10 does not know (Д-351).
    assert.deepEqual(probe.slice(0, 6), ["run", "--rm", "--network", "none", "--entrypoint", "touch"]);
    assert.ok(probe.includes("ghcr.io/stonebridgeway/ai-dev-system:latest"), "with the image the configs run");
  }
  assert.equal(shared(written.calls.find((call) => call[0] === "run" && call.includes("install"))), "yes");
  assert.deepEqual((await fs.readdir(path.join(written.home, ".ai-dev", "state"))).filter((name) => name.startsWith(".ai-dev-share-probe")), [], "the probe's file is taken away");
  if (!linux) return;

  // Written, but not as this user (a remapping Docker), or refused: the volume keeps the state, and
  // bootstrap says why once — the installer it runs does not say it again (Д-342, Д-344).
  for (const env of [{}, { PROBE: "refused" }]) {
    const kept = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,claude-code"], { env, folders: [".cursor"], files: { ".claude.json": "{}" } });
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(shared(kept.calls.find((call) => call[0] === "run" && call.includes("install"))), "no", JSON.stringify(env));
    assert.equal(kept.stderr.split("The agent hooks keep their state apart from the server's").length - 1, 1, kept.stderr);
  }
  // Docker did not run the image: nothing was tried, and it is said why — with a step bootstrap's user has.
  const untried = await runBootstrap(t, ["--skip-smoke"], { env: { PROBE: "broken" }, folders: [".cursor"] });
  assert.equal(untried.status, 0, untried.stderr);
  assert.equal(shared(untried.calls.find((call) => call[0] === "run" && call.includes("install"))), "untried");
  assert.match(untried.stderr, /Could not try sharing .* with ghcr\.io\/stonebridgeway\/ai-dev-system:latest: docker: Error response from daemon: failed to connect/);
  assert.match(untried.stderr, /Run bootstrap\.sh again once Docker runs the image/);
});

test("a config that is a link into dotfiles is written through it: each folder on the way is mounted where the link spells it (Д-335, Д-338)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  // Two clients whose links end in one folder: Docker refuses a target mounted twice.
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini"], {
    folders: [".cursor", ".gemini", "dotfiles/cursor", "dotfiles/shared"],
    files: { "dotfiles/shared/mcp.json": "{}", "dotfiles/shared/settings.json": "{}" },
    links: { ".cursor/mcp.json": "../dotfiles/cursor/mcp.json", "dotfiles/cursor/mcp.json": "../shared/mcp.json", ".gemini/settings.json": "../dotfiles/shared/settings.json" }
  });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  const pairs = mounts(install).map((mount) => ["source=", "target="].map((key) => mount.split(",").find((part) => part.startsWith(key)).slice(key.length)));
  const real = await fs.realpath(result.home);
  const expected = [
    [path.join(result.home, ".cursor"), path.join(result.home, ".cursor")],
    [path.join(result.home, ".gemini"), path.join(result.home, ".gemini")],
    [path.join(real, "dotfiles", "cursor"), path.join(result.home, "dotfiles", "cursor")],
    [path.join(real, "dotfiles", "shared"), path.join(result.home, "dotfiles", "shared")]
  ];
  for (const [source, target] of expected) {
    assert.equal(pairs.filter((pair) => pair[1] === target).length, 1, `${target} mounted once: ${JSON.stringify(pairs)}`);
    assert.deepEqual(pairs.find((pair) => pair[1] === target), [source, target]);
  }
});

test("a dotfiles folder that is itself a link is mounted at the path the config's link spells, from where it really is (Д-338)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini"], {
    folders: [".cursor", ".gemini", "src/dotfiles/cursor", "src/dotfiles/gemini"],
    files: { "src/dotfiles/cursor/mcp.json": "{}", "src/dotfiles/gemini/settings.json": "{}" },
    links: { dotfiles: "src/dotfiles", ".gemini/settings.json": "../dotfiles/gemini/settings.json" },
    absoluteLinks: { ".cursor/mcp.json": "dotfiles/cursor/mcp.json" }
  });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  const real = await fs.realpath(result.home);
  for (const client of ["cursor", "gemini"]) {
    const mount = `type=bind,source=${path.join(real, "src", "dotfiles", client)},target=${path.join(result.home, "dotfiles", client)}`;
    assert.ok(mounts(install).includes(mount), `${mount} not in ${mounts(install).join(" ")}`);
  }
});

test("a link into the home, a folder above it or the root is not followed: that client alone is not configured (Д-339)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini,vscode"], {
    env: { OLD_RUNTIME: "1" },
    folders: [".cursor", ".gemini", ".config/Code/User"],
    files: { "cursor-mcp.json": "{}" },
    links: { ".cursor/mcp.json": "../cursor-mcp.json" },
    absoluteLinks: {},
    rootLinks: { ".gemini/settings.json": "/gemini-settings.json" }
  });
  if (!result) return;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Cursor: its config leads to .*cursor-mcp\.json, and bootstrap does not hand the installer .* whole/);
  assert.match(result.stderr, /Gemini CLI: its config leads to \/gemini-settings\.json, and bootstrap does not hand the installer \/ whole/);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=vscode", "the others are written");
  const targets = mounts(install).map((mount) => mount.split(",").find((part) => part.startsWith("target=")).slice("target=".length));
  assert.ok(!targets.includes(result.home) && !targets.includes("/"), targets.join(" "));
  assert.match(result.stderr, /Some AI clients were not configured: see above for which, and why/);
  assert.ok(!result.calls.some((call) => call[0] === "rm"), "the 2.x container stays while a config that names it may be left");
});

test("a folder Docker will not mount costs its own client alone; Claude Code's entry needs no client folder (Д-339)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unshared-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const unshared = await fs.realpath(root);
  await fs.writeFile(path.join(unshared, "mcp.json"), "{}");
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini,claude-code"], {
    env: { MOUNT_DENY: unshared },
    claude: true,
    folders: [".cursor", ".gemini"],
    files: { ".claude.json": "{}" },
    rootLinks: { ".cursor/mcp.json": path.join(unshared, "mcp.json") }
  });
  if (!result) return;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Cursor: Docker did not take a folder its config leads to \(docker: Error response from daemon: Mounts denied/);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=gemini");
  assert.match(result.claude, /mcp add-json ai-dev /, "Claude Code is still written");
  const entry = result.calls.find((call) => call[0] === "run" && call.includes("entry"));
  assert.deepEqual(mounts(entry), [], "the entry is printed, not written: no folder of the client's");
});

test("every client's folders are looked at in one run; a folder Docker refuses, link or not, costs its own client alone (Д-352)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unshared-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  await fs.mkdir(codexHome);
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,codex"], { env: { MOUNT_DENY: codexHome, CODEX_HOME: codexHome }, folders: [".cursor"] });
  if (!result) return;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Codex: Docker did not take a folder its config leads to \(docker: Error response from daemon: Mounts denied/);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=cursor");
  const looks = result.calls.filter((call) => call[0] === "run" && call.includes("--entrypoint") && call[call.indexOf("--entrypoint") + 1] === "true");
  assert.equal(looks.filter((call) => call.includes("--mount")).length, 3, "one look at all, then one at each client");
  assert.equal(looks.filter((call) => !call.includes("--mount")).length, 0, "Cursor's look passing shows Docker runs the image: no run without folders (Д-362)");
  const fine = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,codex"], { env: { CODEX_HOME: codexHome }, folders: [".cursor"] });
  assert.equal(fine.status, 0, fine.stderr);
  assert.equal(fine.calls.filter((call) => call[0] === "run" && call.includes("--entrypoint") && call[call.indexOf("--entrypoint") + 1] === "true").length, 1, "Docker took them all: one look");
});

test("a look at the folders that fails while Docker runs nothing at all blames no folder: it is said once, and the install goes on (Д-358, Д-360)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const says = {
    deadline: "docker: Error response from daemon: failed to create task for container: context deadline exceeded",
    overlay: "docker: Error response from daemon: error creating overlay mount to /var/lib/docker/overlay2/3f9c1a-init/merged: no such file or directory.",
    silent: "exit status 137"
  };
  for (const [mode, said] of Object.entries(says)) {
    const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini"], { env: { TRUE_FAIL: mode }, folders: [".cursor", ".gemini"] });
    if (!result) return;
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Docker did not take a folder/, mode);
    const line = `Docker could not look at the clients' folders first (${said}): the install goes on, and says what fails.`;
    assert.equal(result.stderr.split("\n").filter((text) => text === line).length, 1, `${mode}: ${result.stderr}`);
    const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
    assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=cursor,gemini", mode);
  }

  // A look that failed once, on a Docker that then runs the image: each client is looked at, and none is lost.
  const flake = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini"], { env: { TRUE_FAIL: "once" }, folders: [".cursor", ".gemini"] });
  assert.equal(flake.status, 0, flake.stderr);
  assert.doesNotMatch(flake.stderr, /Docker did not take a folder|could not look/);
  const install = flake.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=cursor,gemini");
});

test("a refused folder is told from a failing engine by the looks that pass, not by one check; Docker Desktop's words come whole (Д-362, Д-366)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unshared-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  await fs.mkdir(codexHome);
  // The engine check would flake; it is not asked, since Cursor's look passed.
  const flaky = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,codex"], {
    env: { MOUNT_DENY: codexHome, MOUNT_DENY_SAYS: "desktop", CODEX_HOME: codexHome, TRUE_FAIL: "bare" }, folders: [".cursor"]
  });
  if (!flaky) return;
  assert.equal(flaky.status, 1, flaky.stderr);
  assert.doesNotMatch(flaky.stderr, /could not look/);
  const install = flaky.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(install.find((argument) => argument.startsWith("--clients=")), "--clients=cursor");
  // The path Docker Desktop names on its second line, and no carriage return.
  const line = flaky.stderr.split("\n").find((text) => text.startsWith("Codex: "));
  assert.equal(line, `Codex: Docker did not take a folder its config leads to (docker: Error response from daemon: Mounts denied: The path ${codexHome} is not shared from the host and is not known to Docker.): not configured.`);

  // Every client refused, and the engine check flaking: then it is taken for the engine, and the install says what fails.
  const alone = await runBootstrap(t, ["--skip-smoke", "--clients", "codex"], { env: { MOUNT_DENY: codexHome, CODEX_HOME: codexHome, TRUE_FAIL: "bare" } });
  assert.equal(alone.status, 1, alone.stderr);
  assert.match(alone.stderr, /Docker could not look at the clients' folders first \(docker: Error response from daemon: failed to create task for container: context deadline exceeded\)/);
  // Every client refused, on an engine that runs: each is named, and no install runs.
  const refused = await runBootstrap(t, ["--skip-smoke", "--clients", "codex"], { env: { MOUNT_DENY: codexHome, CODEX_HOME: codexHome } });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Codex: Docker did not take a folder its config leads to/);
  assert.equal(refused.calls.filter((call) => call[0] === "run" && call.includes("install")).length, 0);
});

test("a HOME spelled with a slash at its end mounts each folder once; a link into a folder not there is named (Д-353)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const slashed = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor"], {
    folders: [".cursor"], files: { ".cursor/real.json": "{}" }, links: { ".cursor/mcp.json": "real.json" }, homeSuffix: "/"
  });
  if (!slashed) return;
  assert.equal(slashed.status, 0, slashed.stderr);
  const install = slashed.calls.find((call) => call[0] === "run" && call.includes("install"));
  const targets = mounts(install).map((mount) => mount.split(",").find((part) => part.startsWith("target=")).slice("target=".length));
  assert.equal(targets.filter((target) => target.endsWith("/.cursor")).length, 1, targets.join(" "));
  assert.ok(!targets.some((target) => target.includes("//")), targets.join(" "));

  const dangling = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,gemini"], { folders: [".cursor", ".gemini"], links: { ".cursor/mcp.json": "../dotfiles/cursor/mcp.json" } });
  assert.equal(dangling.status, 1, dangling.stderr);
  assert.match(dangling.stderr, /Cursor: its config leads to .*\/dotfiles\/cursor\/mcp\.json, in a folder that is not there: not configured/);
  const written = dangling.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.equal(written.find((argument) => argument.startsWith("--clients=")), "--clients=gemini");
});

test("a client folder with a space in its path is mounted whole: macOS keeps them under Application Support", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  // Linux finds the folders under XDG_CONFIG_HOME, given a space here; macOS has its own.
  const spaced = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-config "));
  t.after(() => fs.rm(spaced, { recursive: true, force: true }));
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "claude-desktop,vscode"], { env: { XDG_CONFIG_HOME: path.join(spaced, "my config") } });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const appData = process.platform === "darwin" ? path.join(result.home, "Library", "Application Support") : path.join(spaced, "my config");
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  const sources = mounts(install).map((mount) => mount.split(",").find((part) => part.startsWith("source=")).slice("source=".length));
  assert.ok(sources.includes(path.join(appData, "Claude")) && sources.includes(path.join(appData, "Code", "User")), sources.join(" | "));
});

test("one client that cannot be written does not stop the rest, and the exit says so (Д-335)", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const result = await runBootstrap(t, ["--skip-smoke", "--clients", "cursor,claude-code"], {
    env: { INSTALL: "fail", OLD_RUNTIME: "1" }, claude: true, folders: [".cursor"], files: { ".claude.json": "{}" }
  });
  if (!result) return;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.claude, /mcp add-json ai-dev /, "Claude Code is still written");
  assert.match(result.stderr, /Some AI clients were not configured: see above/);
  assert.doesNotMatch(result.stdout, /AI Dev is ready/);
  assert.ok(!result.calls.some((call) => call[0] === "rm"), "the 2.x container stays while a config that names it may be left");
});

test("a model folder is mounted read-only for the installer, checked, and handed to the configs", async (t) => {
  if (process.platform === "win32") return t.skip("the Unix script");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const models = await fs.realpath(root);
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  const result = await runBootstrap(t, ["--skip-smoke", "--model-path", models], { folders: [".cursor"] });
  if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const install = result.calls.find((call) => call[0] === "run" && call.includes("install"));
  assert.ok(mounts(install).includes(`type=bind,source=${models},target=${models},readonly`), install.join(" "));
  assert.ok(install.includes(`--model=${models}`));
  assert.doesNotMatch(result.stderr, /holds no bge-m3-onnx/);

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const warned = await runBootstrap(t, ["--skip-smoke", "--skip-client-install", "--model-path", empty]);
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /holds no bge-m3-onnx\/ yet; dense search will report that it is not set up/);

  // The pre-Д-62 value — the model directory itself — is refused with directions, before anything runs.
  const oldStyle = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bge-m3-"));
  t.after(() => fs.rm(oldStyle, { recursive: true, force: true }));
  await fs.writeFile(path.join(oldStyle, "pytorch_model.bin"), "");
  const refused = await runBootstrap(t, ["--skip-smoke", "--model-path", oldStyle]);
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(refused.stderr, /holds model files itself \(pytorch_model\.bin\)/);
  assert.match(refused.stderr, /bge-m3-onnx\//, "the message does not say what the folder should contain");
  assert.equal(refused.calls.filter((call) => call[0] === "pull" || call[0] === "run").length, 0);

  // A bge-m3-onnx that is a link which leads nowhere: the image writing the configs could not tell, and no session
  // would start over it, so it is refused here, before anything runs (Д-368).
  const linking = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-")));
  t.after(() => fs.rm(linking, { recursive: true, force: true }));
  await fs.symlink(path.join(linking, "unplugged", "bge-m3-onnx"), path.join(linking, "bge-m3-onnx"));
  const dangling = await runBootstrap(t, ["--skip-smoke", "--model-path", linking]);
  assert.equal(dangling.status, 64, dangling.stderr);
  assert.match(dangling.stderr, /\/bge-m3-onnx is a link to .*unplugged\/bge-m3-onnx that leads nowhere here: connect the disk it leads to, or point --model-path at another folder\./);
  assert.doesNotMatch(dangling.stderr, /holds no bge-m3-onnx/);
  assert.equal(dangling.calls.filter((call) => call[0] === "pull" || call[0] === "run").length, 0);
  // One that leads somewhere is handed on as the folder holding it: the image mounts the link itself.
  await fs.mkdir(path.join(linking, "unplugged", "bge-m3-onnx"), { recursive: true });
  const led = await runBootstrap(t, ["--skip-smoke", "--model-path", linking], { folders: [".cursor"] });
  assert.equal(led.status, 0, led.stderr);
  // And it is said that every session needs what it leads to: Docker starts none while that is away (Д-385).
  assert.match(led.stderr, /\/bge-m3-onnx is a link to .*unplugged\/bge-m3-onnx: every session mounts what it leads to, so if that is a disk you disconnect, Docker starts no session while it is away, and the AI client's log shows Docker's "bind source path does not exist"\./);
  assert.ok(led.calls.find((call) => call[0] === "run" && call.includes("install")).includes(`--model=${linking}`));
});

// The Windows installer, through pwsh where it exists (the ubuntu and macOS
// runners carry it too). `-Plan` failed on the first CI run because its
// document was stored in `$plan`, which is the switch itself under
// PowerShell's case-insensitive names (docs/DEFECTS.md Д-70); this is the
// test that would have said so before the Windows job did.

// pwsh renders a thrown message through its ConciseView: coloured even with no
// terminal, a gutter on every line, and wrapped at whatever width the host
// reports — 80 on the runner, wider here (docs/DEFECTS.md Д-71). The message is
// what is under test, so the view is taken back off before matching.
function powerShellMessage(rendered) {
  return rendered
    .replace(/\u001B\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:Line|\d+)?\s*\|\s?/, "").trim())
    .filter((line) => line && !/^~+$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
}

function runPowerShellBootstrap(args, home, env = {}) {
  return spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-File", bootstrapPowerShell, "-ProjectPath", path.join(home, "projects"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", ...env }
  });
}

test("the PowerShell plan renders, and carries model_path only when -ModelPath is given", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-"));
  try {
    const bare = runPowerShellBootstrap(["-Plan"], home);
    if (bare.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return;
    }
    assert.equal(bare.status, 0, `stdout: ${bare.stdout}\nstderr: ${bare.stderr}`);
    const output = JSON.parse(bare.stdout);
    assert.equal(output.image, "ghcr.io/stonebridgeway/ai-dev-system:latest");
    assert.equal(output.build_local, false);
    assert.equal(output.clients, "all");
    assert.equal(output.installs_prerequisites_when_missing, false);
    assert.equal("model_path" in output, false);

    const withModels = runPowerShellBootstrap(["-Plan", "-ModelPath", path.join(home, "models")], home);
    assert.equal(withModels.status, 0, withModels.stderr);
    assert.equal(JSON.parse(withModels.stdout).model_path, path.join(home, "models"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the PowerShell installer refuses the pre-Д-62 model path before it looks for Docker", async (context) => {
  // A validation that let this through would go on to Assert-Docker, which on
  // Windows may start Docker Desktop; the refusal is asserted where it cannot.
  if (process.platform === "win32") {
    context.skip("Assert-Docker has side effects on Windows");
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-"));
  const oldStyle = path.join(home, "bge-m3");
  await fs.mkdir(oldStyle);
  await fs.writeFile(path.join(oldStyle, "pytorch_model.bin"), "");
  try {
    const result = runPowerShellBootstrap(["-SkipSmoke", "-SkipClientInstall", "-ModelPath", oldStyle], home);
    if (result.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const message = powerShellMessage(result.stderr);
    assert.match(message, /holds model files itself \(pytorch_model\.bin\)/);
    assert.match(message, /bge-m3-onnx/, "the message does not say what the folder should contain");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the PowerShell installer pulls, checks the server's own handshake and has the checkout's CLI write the configs", async (context) => {
  if (process.platform === "win32") {
    context.skip("the stub docker is a shell script");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-run-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const log = path.join(root, "docker.log");
  const result = runPowerShellBootstrap(["-Clients", "cursor"], home, {
    STUB_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_DEV_HOME: path.join(home, ".ai-dev")
  });
  if (result.error?.code === "ENOENT") {
    context.skip("pwsh is unavailable on this host");
    return;
  }
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const calls = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\t"))
    // On Linux the CLI tries the state folder's sharing with the image; Windows does not (Д-322).
    .filter((call) => !(process.platform === "linux" && call[0] === "run" && call.includes("touch") && call.includes("--rm")));
  assert.deepEqual(calls.map((call) => call[0]), ["version", "pull", "run"], "no proxy built, no container kept");
  // The checkout's CLI wrote a direct docker entry into the client's config.
  const config = JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.equal(config.args[0], "run");
  assert.equal(config.args.at(-1), "ghcr.io/stonebridgeway/ai-dev-system:latest");
  // A config written: the restart is asked for, in bootstrap.sh's words (Д-415).
  assert.match(result.stdout, /Writing the AI clients' configs\.\.\.\n[^]*\nAI Dev is ready\. Restart the AI clients to load ai-dev\.\n$/);
  assert.doesNotMatch(result.stdout, /No AI client found here/);
});

test("bootstrap.ps1 with no client here names its own -Clients and writes nothing; each of its endings is bootstrap.sh's (Д-415)", async (context) => {
  if (process.platform === "win32") {
    context.skip("the stub docker is a shell script");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-none-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(path.join(home, ".unrelated"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const log = path.join(root, "docker.log");
  const env = {
    STUB_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_DEV_HOME: path.join(home, ".ai-dev"), AI_DEV_STATE_ROOT: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: ""
  };
  const none = runPowerShellBootstrap(["-SkipSmoke"], home, env);
  if (none.error?.code === "ENOENT") {
    context.skip("pwsh is unavailable on this host");
    return;
  }
  assert.equal(none.status, 0, `stdout: ${none.stdout}\nstderr: ${none.stderr}`);
  // The script's own parameter, not the CLI's --clients=…, which PowerShell would take for the projects folder.
  assert.match(none.stdout, /\nNo AI client found here \(Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI\)\. Name one to write its config anyway, -Clients cursor,vscode,…, or install one and run bootstrap\.ps1 again\.\nAI Dev is ready; no AI client is connected to it yet\.\n$/);
  assert.doesNotMatch(none.stdout, /--clients|Writing the AI clients' configs|Restart the AI clients/);
  // Nothing written, and so nothing tried for it: Docker was asked for its version and the image, no more.
  const calls = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
  assert.deepEqual(calls, ["version", "pull"]);
  for (const folder of [".ai-dev", ".cursor", path.join(".config", "Claude")]) await assert.rejects(fs.access(path.join(home, folder)), /ENOENT/, folder);

  const skipped = runPowerShellBootstrap(["-SkipSmoke", "-SkipClientInstall"], home, env);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /\nAI Dev is ready; the AI clients' configs were left as they were\.\n$/);
  assert.doesNotMatch(skipped.stdout, /Restart the AI clients|No AI client found here/);
});

// Windows PowerShell 5.1 reads a script that has no BOM in the ANSI code page: a character past ASCII in a string
// would print as something else there, so the script spells such a character by its code (Д-415).
test("bootstrap.ps1 keeps its code to ASCII; only its comments go past it", async () => {
  const lines = (await fs.readFile(bootstrapPowerShell, "utf8")).split(/\r?\n/);
  const past = lines.flatMap((line, index) => (/[^\x00-\x7F]/.test(line.replace(/(^|\s)#.*$/, "")) ? [`${index + 1}: ${line.trim()}`] : []));
  assert.deepEqual(past, []);
});

// Windows PowerShell 5.1 turns a native command's redirected stderr into error
// records, which `$ErrorActionPreference = "Stop"` makes fatal; the image writes
// to stderr at every start (docs/DEFECTS.md, Д-320). No 5.1 runs here, so the
// rule is held on the text: a redirect of stderr only inside Invoke-Native.
test("bootstrap.ps1 throws a native command's stderr away only inside Invoke-Native (Д-320)", async () => {
  const lines = (await fs.readFile(bootstrapPowerShell, "utf8")).split(/\r?\n/);
  assert.ok(lines.some((line) => /^function Invoke-Native \{/.test(line)));
  let inside = false;
  const outside = [];
  for (const [index, line] of lines.entries()) {
    const code = line.replace(/(^|\s)#.*$/, "");
    const opens = /Invoke-Native \{/.test(code);
    if (/(?:\*|2)>\s*\$null|2>&1/.test(code) && !(inside || opens)) outside.push(`${index + 1}: ${line.trim()}`);
    inside = (inside || opens) && /`\s*$/.test(line);
  }
  assert.deepEqual(outside, []);
  assert.ok(lines.filter((line) => /Invoke-Native \{/.test(line)).length >= 5, "the handshake, the engine checks and the cached image's age");
});
