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
 *   (2.x's `AI_DEV_MODEL_PATH`) — its `bge-m3-onnx` link at {@link CONTAINER_MODEL_DIR}
 *   when it is one ({@link modelMount}); otherwise the model is the volume's.
 *
 * The container runs as the image's user, uid 1000, as 2.x did: one owner for
 * everything in the volume, whichever launcher — a 3.0 entry or a 2.x one —
 * started the session. The host's state folder is shared only where that user
 * is the host's ({@link sharesHostState}): on Linux a file the server wrote as
 * uid 1000 with the image's umask is another user's to read, and one the hooks
 * wrote is not the server's to append to.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, lstatSync, readlinkSync, rmSync, statSync } from "node:fs";
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

/** Where the server in the image looks for a host's model (`DOCKER_MOUNTED_MODEL_DIR` in dense-backend.mjs). */
export const CONTAINER_MODEL_DIR = `${CONTAINER_MODELS}/bge-m3-onnx`;

/**
 * Files that make a folder a model folder itself rather than the one holding
 * `bge-m3-onnx/`: the value 2.x documented before Д-62, refused by every copy.
 */
export const MODEL_FOLDER_MARKERS = Object.freeze(["pytorch_model.bin", "modules.json", "config.json", "onnx"]);

/**
 * Docker reads a `--mount` value as one CSV record: a comma splits it, and a
 * double quote outside a quoted field fails every session ("bare \" in
 * non-quoted-field"; docs/DEFECTS.md, Д-328).
 */
function mountable(label, folder) {
  const bad = [",", "\""].find((character) => folder.includes(character));
  if (bad) throw new Error(`The ${label} folder ${folder} has ${bad === "," ? "a comma" : "a double quote"} in its path, which a docker --mount cannot hold. Choose a folder without one.`);
  return folder;
}

/**
 * The arguments of `docker run` for one client session.
 *
 * @param {object} input
 * @param {string} input.image
 * @param {string} [input.volume]
 * @param {string} [input.projects] - The host's projects folder.
 * @param {string | { source: string, target: string }} [input.model] - A host folder holding `bge-m3-onnx/`
 *   (mounted at {@link CONTAINER_MODELS}), or the mount {@link modelMount} chose for one.
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
  if (model) {
    const mount = typeof model === "string" ? { source: model, target: CONTAINER_MODELS } : model;
    args.push("--mount", `type=bind,source=${mountable("model", mount.source)},target=${mount.target},readonly`);
  }
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
 * Whether the image's user may share the host's state folder, tried rather than
 * inferred: a container of the image, as its user, makes a file there, and the
 * file must be the host user's. Where Docker maps the container's uid 1000 to
 * another host uid — rootless Docker, userns-remap, Podman — that container
 * cannot write the folder at all, and a state the server cannot write is worse
 * than one kept apart in the volume, as 2.x kept it (docs/DEFECTS.md, Д-322).
 *
 * A Docker that did not run the image — an engine that does not answer, an
 * image not here yet, which the probe does not pull — has tried nothing:
 * `tried` says so, so that is not taken for a remapping host (Д-331).
 *
 * @param {{ docker?: string, image: string, state: string, uid?: number, run?: typeof spawnSync }} input
 * @returns {{ shared: boolean, tried: boolean, reason: string }}
 */
export function probeStateSharing({ docker = "docker", image, state, uid = process.getuid?.(), run = spawnSync }) {
  const name = `.ai-dev-share-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const probe = path.join(state, name);
  const result = run(docker, [
    "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "touch",
    "--mount", `type=bind,source=${mountable("state", state)},target=${CONTAINER_STATE_ROOT}`, image, `${CONTAINER_STATE_ROOT}/${name}`
  ], { encoding: "utf8", shell: false, timeout: 120_000 });
  try {
    const said = String(result.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (result.status !== 0 || result.error) {
      // `touch` in the container answers "cannot touch"; anything else is Docker's own.
      const refused = said.find((line) => /cannot touch/i.test(line));
      if (refused && !result.error) return { shared: false, tried: true, reason: `the image's user could not write your state folder (${refused})` };
      const why = result.error?.message || said.find((line) => !/^Run 'docker run --help'/.test(line)) || `exit ${result.status}`;
      return { shared: false, tried: false, reason: `Docker did not run ${image} to try it (${why})` };
    }
    const owner = statSync(probe, { throwIfNoEntry: false })?.uid;
    if (owner === uid) return { shared: true, tried: true, reason: "" };
    return {
      shared: false,
      tried: true,
      reason: owner === undefined
        ? "what the image's user wrote into your state folder did not reach it"
        : `what the image's user writes into your state folder is uid ${owner}'s, not yours (uid ${uid}): Docker maps the container's users here (rootless Docker, userns-remap or Podman)`
    };
  } finally {
    rmSync(probe, { force: true });
  }
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
 * The mount a host model folder gets: the folder at {@link CONTAINER_MODELS} —
 * or, when its `bge-m3-onnx` is a link, that link at {@link CONTAINER_MODEL_DIR}.
 * A link inside a mounted folder is read in the container, where an absolute
 * target, or a relative one that leaves the folder, leads nowhere: the model
 * was "not installed" (docs/DEFECTS.md, Д-368). Docker resolves a mount's own
 * source on the host, so the link mounted itself is the folder it leads to.
 *
 * Where this runs on the host (`verify`), a link that leads nowhere here either
 * is refused: Docker would start no session over it. In the image, writing for
 * the host, the link's target is not to be seen; bootstrap.sh checks it first.
 *
 * @param {string} folder - A model folder {@link checkModelFolder} took.
 * A link to another disk is noted (`note`): Docker starts no session while
 * that disk is away.
 *
 * @param {{ verify?: boolean, join?: (...parts: string[]) => string, lstat?: typeof lstatSync, stat?: typeof statSync, readlink?: typeof readlinkSync }} [options]
 * @returns {{ source: string, target: string, note?: string }}
 */
export function modelMount(folder, { verify = true, join = path.join, lstat = lstatSync, stat = statSync, readlink = readlinkSync } = {}) {
  const model = join(folder, "bge-m3-onnx");
  let link = false;
  try {
    link = lstat(model).isSymbolicLink();
  } catch {
    // Not there yet: the folder is mounted, and the model is put there later.
  }
  if (!link) return { source: folder, target: CONTAINER_MODELS };
  if (!verify) return { source: model, target: CONTAINER_MODEL_DIR };
  let leadsTo = "";
  try {
    leadsTo = readlink(model);
  } catch {
    // Said without it.
  }
  let found;
  try {
    found = stat(model);
  } catch (error) {
    throw new Error(`${model} is a link${leadsTo ? ` to ${leadsTo}` : ""} that leads nowhere here (${error?.code ?? error?.message}): connect the disk it leads to, or name another model folder. Docker would start no session that mounts it.`);
  }
  // Docker refuses a mount whose source is gone, and the whole session with it: a disk the link leads to that is
  // unplugged later takes AI Dev out of every client, where a folder mounted above the link took dense search
  // only. So it is said when the entries are written, and `clients doctor` says it when it happens (Д-385).
  let note = "";
  try {
    if (found.dev !== stat(folder).dev) {
      note = `${model} leads to ${leadsTo || "another folder"}, on another disk: every session mounts it from there, so while that disk is away Docker starts no session at all — \`ai-dev clients doctor\` names the entry then.`;
    }
  } catch {
    // The folder was checked a moment ago; a folder that went meanwhile is said by Docker.
  }
  return { source: model, target: CONTAINER_MODEL_DIR, ...(note ? { note } : {}) };
}

/**
 * The `--mount type=bind,source=…` folders of a `docker run` command line
 * that are not there: Docker refuses to start a container over one, so a
 * client that runs the entry gets no server at all (Д-385).
 *
 * @param {string[]} args
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {Array<{ source: string, target: string }>}
 */
export function missingBindSources(args, { exists = existsSync } = {}) {
  const missing = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length - 1; index += 1) {
    if (list[index] !== "--mount") continue;
    const fields = Object.fromEntries(String(list[index + 1]).split(",").map((field) => {
      const at = field.indexOf("=");
      return at < 0 ? [field, ""] : [field.slice(0, at), field.slice(at + 1)];
    }));
    const source = fields.source ?? fields.src ?? "";
    if (fields.type === "bind" && source && !exists(source)) missing.push({ source, target: fields.target ?? fields.dst ?? fields.destination ?? "" });
  }
  return missing;
}

/**
 * The command line a client config gets for the image.
 *
 * @param {object} input
 * @param {string} [input.docker] - The Docker CLI, by full path ({@link resolveDockerCommand}).
 * @param {string} [input.image]
 * @param {string} [input.volume]
 * @param {string} [input.projects]
 * @param {string | { source: string, target: string }} [input.model]
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
