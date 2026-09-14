import crypto from "node:crypto";
import path from "node:path";

export const RUNTIME_PROFILE_SCHEMA_VERSION = 1;

/**
 * Build the default local-first runtime profile: stdio transport, remote
 * foundation disabled, paths expressed as `${VAR}` placeholders.
 *
 * @param {{ vaultRoot?: string, nodeExecutable?: string }} [options]
 * @returns {object} Runtime profile (schema {@link RUNTIME_PROFILE_SCHEMA_VERSION}).
 */
export function createLocalRuntimeProfile({
  vaultRoot = "${AI_DEV_VAULT_ROOT}",
  nodeExecutable = "${AI_DEV_NODE}"
} = {}) {
  return {
    schema_version: RUNTIME_PROFILE_SCHEMA_VERSION,
    mode: "local-first",
    vault_root: vaultRoot,
    node_executable: nodeExecutable,
    transport: {
      type: "stdio",
      remote_enabled: false
    },
    state: {
      root: "${AI_DEV_HOME}/state",
      cache: "${AI_DEV_HOME}/cache",
      artifacts: "${AI_DEV_HOME}/artifacts"
    },
    remote_foundation: {
      status: "disabled",
      bind: "127.0.0.1",
      tls: { mode: "required-before-enable" },
      authentication: {
        mode: "bearer",
        token_env: "AI_DEV_MCP_BEARER_TOKEN"
      },
      allowed_clients: [],
      rate_limit_per_minute: 60,
      trust_proxy: false
    }
  };
}

/**
 * Where the Docker image keeps the application tree (`docker/Dockerfile`
 * WORKDIR, `docker/entrypoint.sh`). Commands reported from inside the container
 * have to name it: the container's working directory is `/workspace`.
 */
export const DOCKER_APP_ROOT = "/opt/ai-dev/app";

/**
 * Runtime flavors the distribution manifest is built for.
 */
export const RUNTIME_FLAVORS = ["windows", "posix", "docker"];

/**
 * Pick the runtime flavor a distribution manifest describes.
 *
 * `AI_DEV_RUNTIME=docker` (set by `docker/Dockerfile`) wins over the platform
 * check: a container reports `linux`, but it ships neither the POSIX checkout's
 * launcher nor its test suite, and its data lives on the `/data` volume.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {"windows"|"posix"|"docker"}
 */
export function runtimeFlavor({ platform = "", env = {} } = {}) {
  if (String(env?.AI_DEV_RUNTIME ?? "").trim().toLowerCase() === "docker") return "docker";
  return platform === "win32" ? "windows" : "posix";
}

// Labels are shared by the expectations and the rendered document so a flavor
// that drops a command drops its line too, instead of printing `undefined`.
const COMMAND_LABELS = {
  start: "Start",
  doctor: "Doctor",
  acceptance: "Full acceptance",
  backup: "Backup"
};

const EXPECTATIONS = {
  windows: {
    files: {
      entrypoint: { root: "server", segments: ["src", "server.mjs"] },
      local_launcher: { root: "server", segments: ["scripts", "start-local.ps1"] },
      cli: { root: "server", segments: ["scripts", "ai-dev.mjs"] },
      config_example: { root: "server", segments: ["config", "runtime.example.json"] },
      acceptance: { root: "vault", segments: ["09-mcp", "scripts", "run-acceptance.ps1"] },
      backup: { root: "vault", segments: ["09-mcp", "scripts", "backup-ai-dev-system.ps1"] },
      restore: { root: "vault", segments: ["09-mcp", "scripts", "restore-ai-dev-system.ps1"] }
    },
    commands: {
      start: "powershell -File scripts/start-local.ps1",
      doctor: "node scripts/ai-dev.mjs doctor",
      acceptance: "node scripts/ai-dev.mjs acceptance",
      backup: "node scripts/ai-dev.mjs backup <label>"
    },
    recovery: {
      backup_script: "09-mcp/scripts/backup-ai-dev-system.ps1",
      restore_script: "09-mcp/scripts/restore-ai-dev-system.ps1"
    }
  },
  posix: {
    files: {
      entrypoint: { root: "server", segments: ["src", "server.mjs"] },
      local_launcher: { reason: "`npm start` runs the entry point directly; no launcher script ships for this platform." },
      cli: { root: "server", segments: ["scripts", "ai-dev.mjs"] },
      config_example: { root: "server", segments: ["config", "runtime.example.json"] },
      acceptance: { root: "server", segments: ["scripts", "acceptance.mjs"] },
      backup: { reason: "No cross-platform backup script ships with this runtime; the PowerShell one is Windows-only." },
      restore: { reason: "No cross-platform restore script ships with this runtime; the PowerShell one is Windows-only." }
    },
    commands: {
      start: "npm start",
      doctor: "node scripts/ai-dev.mjs doctor",
      acceptance: "node scripts/acceptance.mjs"
    },
    recovery: {
      reason: "No cross-platform backup or restore script ships with this runtime. Copy the vault and the AI Dev home (AI_DEV_HOME) instead."
    }
  },
  docker: {
    files: {
      entrypoint: { root: "server", segments: ["src", "server.mjs"] },
      local_launcher: { reason: "The launcher (docker/run-mcp.sh) runs on the host, outside the image." },
      cli: { root: "server", segments: ["scripts", "ai-dev.mjs"] },
      config_example: { root: "server", segments: ["config", "runtime.example.json"] },
      acceptance: { reason: "Acceptance runs in a source checkout; the image ships neither the tests nor the dev dependencies." },
      backup: { reason: "The /data volume is the backup unit; see docker/README.md." },
      restore: { reason: "The /data volume is the backup unit; see docker/README.md." }
    },
    commands: {
      start: "sh docker/run-mcp.sh",
      doctor: `node ${DOCKER_APP_ROOT}/scripts/ai-dev.mjs doctor`
    },
    command_context: "`Start` runs on the host; the rest run inside the container.",
    recovery: {
      reason: "Back up and restore the /data volume; see docker/README.md."
    }
  }
};

/**
 * The files and commands a runtime flavor is expected to have. A file the
 * flavor cannot have carries a `reason` instead of a location, so the status
 * tool reports it as not applicable rather than missing.
 *
 * @param {string} flavor - One of {@link RUNTIME_FLAVORS}; anything else falls back to `posix`.
 * @returns {{ files: object, commands: object, command_context?: string, recovery: object }}
 */
export function distributionExpectations(flavor) {
  return EXPECTATIONS[flavor] || EXPECTATIONS.posix;
}

/**
 * Resolve a flavor's expected files against the two roots that hold them.
 *
 * @param {string} flavor - Runtime flavor.
 * @param {{ serverRoot: string, vaultRoot: string }} roots - Absolute roots.
 * @returns {Record<string, { applicable: boolean, path?: string, reason?: string }>}
 */
export function distributionFilePlan(flavor, { serverRoot, vaultRoot }) {
  const roots = { server: serverRoot, vault: vaultRoot };
  return Object.fromEntries(Object.entries(distributionExpectations(flavor).files).map(([key, spec]) => [
    key,
    spec.reason
      ? { applicable: false, reason: spec.reason }
      : { applicable: true, path: path.join(roots[spec.root], ...spec.segments) }
  ]));
}

/**
 * Split a resolved file plan into what is missing and what does not apply here.
 * Readiness counts only applicable files: a Windows-only backup script absent
 * from a container is not an incomplete install.
 *
 * @param {Record<string, { applicable?: boolean, exists?: boolean, path?: string, reason?: string }>} files
 * @returns {{ missing: Array<{key: string, path: string}>, not_applicable: Array<{key: string, reason: string}>, ready: boolean }}
 */
export function summarizeDistributionFiles(files) {
  const entries = Object.entries(files || {});
  const missing = entries
    .filter(([, value]) => value?.applicable !== false && !value?.exists)
    .map(([key, value]) => ({ key, path: value?.path || "" }));
  const notApplicable = entries
    .filter(([, value]) => value?.applicable === false)
    .map(([key, value]) => ({ key, reason: value?.reason || "" }));
  return { missing, not_applicable: notApplicable, ready: missing.length === 0 };
}

function secretFieldPaths(value, current = "") {
  const paths = [];
  if (!value || typeof value !== "object") return paths;
  for (const [key, nested] of Object.entries(value)) {
    const fieldPath = current ? `${current}.${key}` : key;
    if (/^(token|password|secret|api_key|private_key)$/i.test(key) && typeof nested === "string" && nested) {
      paths.push(fieldPath);
    }
    paths.push(...secretFieldPaths(nested, fieldPath));
  }
  return paths;
}

/**
 * Validate a runtime profile. Always rejects stored secret values (only
 * `*_env` references are allowed) and, when `transport.remote_enabled`, enforces
 * HTTP + TLS + bearer `token_env` + explicit allowlist + trusted-proxy rules.
 *
 * @param {object} profile - Runtime profile.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateRuntimeProfile(profile) {
  const errors = [];
  const warnings = [];
  if (profile?.schema_version !== RUNTIME_PROFILE_SCHEMA_VERSION) {
    errors.push(`Expected runtime profile schema ${RUNTIME_PROFILE_SCHEMA_VERSION}.`);
  }
  if (!["local-first", "remote"].includes(profile?.mode)) {
    errors.push("Runtime mode must be local-first or remote.");
  }
  if (!["stdio", "http"].includes(profile?.transport?.type)) {
    errors.push("Transport type must be stdio or http.");
  }
  const rawSecrets = secretFieldPaths(profile);
  if (rawSecrets.length) {
    errors.push(`Runtime profile must reference secret environment variables, not store values: ${rawSecrets.join(", ")}.`);
  }

  const remoteEnabled = profile?.transport?.remote_enabled === true;
  if (remoteEnabled) {
    if (profile.transport.type !== "http") errors.push("Remote mode requires the HTTP transport.");
    if (profile?.remote_foundation?.status !== "enabled") {
      errors.push("Remote foundation status must be enabled explicitly.");
    }
    if (!["native", "reverse-proxy"].includes(profile?.remote_foundation?.tls?.mode)) {
      errors.push("Remote mode requires native TLS or a TLS reverse proxy.");
    }
    if (profile?.remote_foundation?.authentication?.mode !== "bearer") {
      errors.push("Remote mode requires bearer authentication.");
    }
    if (!profile?.remote_foundation?.authentication?.token_env) {
      errors.push("Remote bearer authentication requires token_env.");
    }
    if (!Array.isArray(profile?.remote_foundation?.allowed_clients) || !profile.remote_foundation.allowed_clients.length) {
      errors.push("Remote mode requires an explicit allowed_clients list.");
    }
    if (profile?.remote_foundation?.bind === "0.0.0.0" && !profile?.remote_foundation?.trust_proxy) {
      errors.push("Public bind requires a trusted reverse proxy configuration.");
    }
  } else {
    if (profile?.mode !== "local-first") warnings.push("Remote mode is selected but transport.remote_enabled is false.");
    if (profile?.transport?.type !== "stdio") warnings.push("Local-first mode normally uses stdio.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic SHA-256 of a distribution manifest, ignoring `generated_at` and
 * any existing `fingerprint`, so freshness can be compared across runs.
 *
 * @param {object} manifest - Distribution manifest.
 * @returns {string} Hex digest.
 */
export function runtimeDistributionFingerprint(manifest) {
  const copy = { ...manifest };
  delete copy.generated_at;
  delete copy.fingerprint;
  return crypto.createHash("sha256").update(stableJson(copy)).digest("hex");
}

/**
 * Render the human-readable `Runtime Distribution.md` from a manifest.
 *
 * @param {object} manifest - Distribution manifest (mode, transport, commands, recovery, …).
 * @returns {string} Markdown document.
 */
export function renderRuntimeDistribution(manifest) {
  const flavorLine = manifest.runtime_flavor ? `\n- Runtime flavor: \`${manifest.runtime_flavor}\`` : "";
  const commandLines = Object.entries(COMMAND_LABELS)
    .filter(([key]) => manifest.commands?.[key])
    .map(([key, label]) => `- ${label}: \`${manifest.commands[key]}\``)
    .join("\n");
  const commandContext = manifest.command_context ? `\n\n${manifest.command_context}` : "";
  // A flavor without scripts states why instead of printing a PowerShell path
  // it does not have (docs/DEFECTS.md, Д-61).
  const recoveryLines = manifest.recovery?.backup_script
    ? [
      `- Backup script: \`${manifest.recovery.backup_script}\``,
      `- Restore script: \`${manifest.recovery.restore_script}\``,
      "- Backups include a manifest and SHA-256 sidecar while excluding disposable runtimes and indexes."
    ].join("\n")
    : `- ${manifest.recovery?.reason || "No backup or restore script ships with this runtime."}`;
  return `# Runtime Distribution

Generated: ${manifest.generated_at}

## Current Mode

- Mode: \`${manifest.profile.mode}\`
- Transport: \`${manifest.profile.transport.type}\`
- Remote enabled: ${manifest.profile.transport.remote_enabled ? "yes" : "no"}
- Entry point: \`${manifest.entrypoint}\`
- MCP tools: ${manifest.tools}${flavorLine}

## Local Commands

${commandLines}${commandContext}

## Local Data

- Vault content stays in the configured Obsidian vault.
- Runtime state, search cache, and QA artifacts stay under the AI Dev home (\`AI_DEV_HOME\`, default \`~/.ai-dev\`).
- Password notes are not exposed as fixed MCP Resources and are not copied into this manifest.

## Future VPS Boundary

Remote transport is deliberately disabled. Enabling it later requires all of the following:

1. official MCP HTTP transport;
2. TLS at the process or trusted reverse proxy;
3. bearer token supplied only through \`${manifest.profile.remote_foundation.authentication.token_env}\`;
4. explicit client allowlist;
5. rate limiting and audit logs;
6. a fresh threat review and remote acceptance run.

Do not expose the current stdio process directly to a public interface.

## Recovery

${recoveryLines}
`;
}
