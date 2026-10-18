/**
 * The command a client starts the server in Docker with: `docker run -i --rm …`,
 * written into the client's config by `ai-dev clients install --docker`.
 *
 * 2.x wrote a launcher into the config instead — `docker/run-mcp.sh`,
 * `run-mcp.ps1`, or on Windows for Claude a C# proxy compiled on the user's
 * machine — and the launchers answered `initialize` themselves while the
 * container came up, so the server's instructions never reached the client
 * (docs/DEFECTS.md, Д-89, Д-105). The image answers in about a second, so the
 * client runs Docker itself and the server answers its own handshake.
 *
 * What the command mounts:
 * - the volume (`/data`): the vault, the index, the model;
 * - the host's state folder at {@link CONTAINER_STATE_ROOT}, named to the server
 *   by `AI_DEV_STATE_ROOT`: the one the agent hooks on the host keep their state
 *   in, so tasks, handoffs and the usage ledger are one (Д-103);
 * - the projects folder at its own path on Linux and macOS, so a path the agent
 *   names is the path the server opens (Д-312); on Windows, whose paths a Linux
 *   container cannot hold, at {@link CONTAINER_WORKSPACE}, as 2.x did;
 * - a host model folder, read-only at {@link CONTAINER_MODELS}, when one is named
 *   (2.x's `AI_DEV_MODEL_PATH`); otherwise the model is the volume's.
 *
 * The container runs as the image's user, uid 1000, as 2.x did: one owner for
 * everything in the volume, whichever launcher — a 3.0 entry or a 2.x one —
 * started the session. The host's state folder is shared only where that user
 * is the host's ({@link sharesHostState}): on Linux a file the server wrote as
 * uid 1000 with the image's umask is another user's to read, and one the hooks
 * wrote is not the server's to append to.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** The image a client runs unless told otherwise (owner decision D9: `:latest` is the released line). */
export const DEFAULT_DOCKER_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest";

/** The named volume the data lives in; 2.x's name, so an upgrade keeps it. */
export const DEFAULT_DOCKER_VOLUME = "ai-dev-system-data";

/** Where the host's state folder is in the container. */
export const CONTAINER_STATE_ROOT = "/ai-dev-state";

/** Where the projects are in the container on Windows (2.x's place for them). */
export const CONTAINER_WORKSPACE = "/workspace";

/** Where a host model folder is mounted, read-only. */
export const CONTAINER_MODELS = "/models";

/**
 * Files that make a folder a model folder itself rather than the one holding
 * `bge-m3-onnx/`: the value 2.x documented before Д-62, refused by every copy.
 */
export const MODEL_FOLDER_MARKERS = Object.freeze(["pytorch_model.bin", "modules.json", "config.json", "onnx"]);

/** Docker splits a `--mount` value at commas: a path holding one cannot be mounted by it. */
function mountable(label, folder) {
  if (folder.includes(",")) throw new Error(`The ${label} folder ${folder} has a comma in its path, which a docker --mount cannot hold. Choose a folder without one.`);
  return folder;
}

/**
 * The arguments of `docker run` for one client session.
 *
 * @param {object} input
 * @param {string} input.image
 * @param {string} [input.volume]
 * @param {string} [input.projects] - The host's projects folder.
 * @param {string} [input.model] - A host folder holding `bge-m3-onnx/`.
 * @param {string} [input.state] - The host's state folder.
 * @param {string} [input.platform] - The host's platform.
 * @returns {string[]}
 */
export function dockerRunArgs({ image, volume = DEFAULT_DOCKER_VOLUME, projects = "", model = "", state = "", platform = process.platform }) {
  if (!image) throw new Error("No image to run: name one with --image.");
  const args = [
    "run", "-i", "--rm",
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
    "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"
  ];
  args.push("--mount", `type=volume,source=${mountable("volume", volume)},target=/data`);
  if (state) {
    args.push("--mount", `type=bind,source=${mountable("state", state)},target=${CONTAINER_STATE_ROOT}`, "--env", `AI_DEV_STATE_ROOT=${CONTAINER_STATE_ROOT}`);
  }
  if (projects) {
    const target = platform === "win32" ? CONTAINER_WORKSPACE : projects;
    args.push("--mount", `type=bind,source=${mountable("projects", projects)},target=${target}`);
  }
  if (model) args.push("--mount", `type=bind,source=${mountable("model", model)},target=${CONTAINER_MODELS},readonly`);
  args.push(image);
  return args;
}

/** The image's user: the owner of everything the container writes. */
export const IMAGE_UID = 1000;

/**
 * Whether the container may share the host's state folder: Docker Desktop
 * (macOS, Windows) maps a bind mount's ownership to the host user; on Linux the
 * image's user must be the host user.
 *
 * @param {{ platform?: string, uid?: number }} [host]
 * @returns {boolean}
 */
export function sharesHostState({ platform = process.platform, uid = process.getuid?.() } = {}) {
  return platform !== "linux" || uid === IMAGE_UID;
}

/**
 * Where the Docker CLI is, by full path: a client started from the Dock or the
 * Start menu does not see the shell's PATH, and Docker Desktop on macOS puts the
 * CLI in /usr/local/bin, which such a client's PATH lacks. When none is found the
 * bare name is returned, for a machine whose client does find it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string, exists?: (file: string) => boolean }} [options]
 * @returns {string}
 */
export function resolveDockerCommand({ env = process.env, platform = process.platform, home = "", exists = isFile } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["docker.exe"] : ["docker"];
  const folders = String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform === "darwin") folders.push("/usr/local/bin", "/opt/homebrew/bin", ...(home ? [paths.join(home, ".docker", "bin")] : []), "/Applications/Docker.app/Contents/Resources/bin");
  if (platform === "win32") folders.push(paths.join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin"));
  for (const folder of folders) {
    for (const name of names) {
      const candidate = paths.join(folder, name);
      if (paths.isAbsolute(candidate) && exists(candidate)) return candidate;
    }
  }
  return "docker";
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuse a model folder that is not one: missing, or a model folder itself (2.x
 * documented that before Д-62, and the server never found the files under it).
 *
 * @param {string} folder
 * @param {{ exists?: (target: string) => boolean }} [options]
 * @returns {string}
 */
export function checkModelFolder(folder, { exists = existsSync } = {}) {
  if (!exists(folder)) throw new Error(`The model folder ${folder} does not exist.`);
  const marker = MODEL_FOLDER_MARKERS.find((name) => exists(path.join(folder, name)));
  if (marker) {
    throw new Error(`${folder} holds model files itself (${marker}). Name the folder above it, the one that holds bge-m3-onnx/.`);
  }
  return folder;
}

/**
 * The command line a client config gets for the image.
 *
 * @param {object} input
 * @param {string} [input.docker] - The Docker CLI, by full path ({@link resolveDockerCommand}).
 * @param {string} [input.image]
 * @param {string} [input.volume]
 * @param {string} [input.projects]
 * @param {string} [input.model]
 * @param {string} [input.state]
 * @param {string} [input.platform]
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function dockerLaunch({ docker = "docker", image = DEFAULT_DOCKER_IMAGE, ...rest } = {}) {
  return { command: docker, args: dockerRunArgs({ image, ...rest }), env: {} };
}

/**
 * Whether an entry starts the server in Docker by itself, as 3.0 writes one,
 * rather than through a 2.x launcher.
 *
 * @param {{ command?: unknown, args?: unknown }} entry
 * @returns {boolean}
 */
export function isDirectDockerEntry(entry) {
  const command = String(entry?.command ?? "");
  const name = command.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, "");
  return name === "docker" && Array.isArray(entry?.args) && entry.args[0] === "run";
}
