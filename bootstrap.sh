#!/bin/sh
# The Docker path in one command: check Docker, pull the image, write the AI
# clients' configs. The configs run the image themselves — `docker run -i --rm …`
# — and the image writes them: `ai-dev clients install --docker`, run in the
# image with nothing of this machine mounted but each client's config folder and
# the state folder. Node is not needed here.
#
# 2.x installed Docker itself, kept a long-lived "runtime container", answered
# the MCP handshake in a launcher instead of the server, and mounted the whole
# home folder to write the configs (docs/DEFECTS.md, Д-89, Д-103, Д-105).
set -eu

project_path="${HOME}/AI-Dev-Projects"
image="${AI_DEV_IMAGE:-ghcr.io/stonebridgeway/ai-dev-system:latest}"
image_set=0
clients="all"
skip_smoke=0
skip_client_install=0
allow_stale_image=0
stale_warning=""
build_local=0
plan=0
node_image="${AI_DEV_BOOTSTRAP_NODE_IMAGE:-node:24-bookworm-slim}"
data_volume="${AI_DEV_DATA_VOLUME:-ai-dev-system-data}"
model_path="${AI_DEV_MODEL_PATH:-}"

usage() {
  cat <<'EOF'
Usage: sh ./bootstrap.sh [options]

Options:
  --project-path PATH       The projects folder the server sees, at the same path (default: ~/AI-Dev-Projects).
  --model-path PATH         A folder holding bge-m3-onnx/, mounted read-only as /models
                            (default: AI_DEV_MODEL_PATH; unset: the model is the volume's —
                            `docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev model install`).
  --image NAME              Docker image (default: ghcr.io/stonebridgeway/ai-dev-system:latest).
  --clients LIST            all (every client found here; the default), or some of
                            claude-code, claude-desktop, cursor, vscode, codex, gemini (claude = both).
  --build-local             Build ai-dev-system:local from this checkout.
  --skip-smoke              Skip the MCP handshake check.
  --allow-stale-image       Install the cached image when the registry pull fails.
  --skip-client-install     Do not write the AI clients' configs.
  --plan                    Print the plan as JSON without doing anything.

Environment: AI_DEV_IMAGE, AI_DEV_DATA_VOLUME and AI_DEV_MODEL_PATH (the defaults of
--image, the data volume and --model-path); AI_DEV_STATE_ROOT or AI_DEV_HOME (the state
folder, found as the agent hooks find it); AI_DEV_INSTALLER_IMAGE (an image of 3.0 or later
that writes the configs when --image names a 2.x one; ghcr.io/stonebridgeway/ai-dev-system:latest).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-path) project_path="$2"; shift 2 ;;
    --model-path) model_path="$2"; shift 2 ;;
    --image) image="$2"; image_set=1; shift 2 ;;
    --clients) clients="$2"; shift 2 ;;
    --build-local) build_local=1; shift ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --allow-stale-image) allow_stale_image=1; shift ;;
    --skip-client-install) skip_client_install=1; shift ;;
    --plan) plan=1; shift ;;
    --install-prerequisites)
      printf '%s\n' "--install-prerequisites: bootstrap.sh no longer installs Docker. Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/" >&2
      shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '%s\n' "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ "$build_local" -eq 1 ] && [ "$image_set" -eq 0 ]; then
  image="ai-dev-system:local"
fi

# A misspelled client is a mistake, not "nothing to do"; and so is none at all
# (docs/DEFECTS.md, Д-328, Д-336).
case "$clients" in
  *[!,]*) ;;
  *) printf '%s\n' "--clients: name at least one client, or all." >&2; exit 64 ;;
esac
set -f
old_ifs=$IFS
IFS=','
for client_name in $clients; do
  case "$client_name" in
    all|claude|claude-code|claude-desktop|cursor|vscode|codex|gemini) ;;
    *)
      IFS=$old_ifs
      printf '%s\n' "--clients: \"${client_name}\" is no client here (all, claude, claude-code, claude-desktop, cursor, vscode, codex, gemini)." >&2
      exit 64 ;;
  esac
done
IFS=$old_ifs
set +f

# The state folder the agent hooks keep theirs in, found as they find it:
# AI_DEV_STATE_ROOT, else AI_DEV_HOME's — unless it names the home itself, which
# keeps 2.x's meaning — else ~/.ai-dev/state (Д-328).
state_path="${HOME}/.ai-dev/state"
if [ -n "${AI_DEV_STATE_ROOT:-}" ]; then
  state_path="$AI_DEV_STATE_ROOT"
elif [ -n "${AI_DEV_HOME:-}" ]; then
  ai_dev_home_real=$(CDPATH= cd -- "$AI_DEV_HOME" 2>/dev/null && pwd -P || printf '%s' "$AI_DEV_HOME")
  home_real=$(CDPATH= cd -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")
  if [ "$ai_dev_home_real" != "$home_real" ]; then
    state_path="${AI_DEV_HOME}/state"
  fi
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
platform=$(uname -s)
installer_platform="linux"
app_data="${XDG_CONFIG_HOME:-${HOME}/.config}"
if [ "$platform" = "Darwin" ]; then
  installer_platform="darwin"
  app_data="${HOME}/Library/Application Support"
fi
uid=$(id -u)
gid=$(id -g)

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$plan" -eq 1 ]; then
  plan_model=""
  if [ -n "$model_path" ]; then
    plan_model=",\"model_path\":\"$(json_escape "$model_path")\""
  fi
  printf '{"repository":"%s","project_path":"%s","image":"%s","clients":"%s","data_volume":"%s","state_path":"%s"%s,"build_local":%s,"node_on_host_required":false}\n' \
    "$(json_escape "$repo_root")" "$(json_escape "$project_path")" "$(json_escape "$image")" "$(json_escape "$clients")" \
    "$(json_escape "$data_volume")" "$(json_escape "$state_path")" "$plan_model" "$build_local"
  exit 0
fi

# Docker: there and running. Installing it is the platform's business.
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is required: install Docker Desktop (macOS) or Docker Engine (Linux) — https://docs.docker.com/get-docker/ — then run bootstrap.sh again." >&2
  exit 69
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  if [ "$platform" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    open -a Docker >/dev/null 2>&1 || true
    attempt=0
    while [ "$attempt" -lt 24 ] && ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
      sleep 5
      attempt=$((attempt + 1))
    done
  fi
  if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    printf '%s\n' "Docker is installed but its engine is not running (or this user may not use it). Start Docker Desktop/Engine and run bootstrap.sh again." >&2
    exit 69
  fi
fi
docker_command=$(command -v docker)

for folder_value in "$project_path" "$state_path" "$model_path"; do
  case "$folder_value" in
    *,*|*\"*) printf '%s\n' "${folder_value} has a comma or a double quote, which a docker --mount cannot hold. Choose a folder without one." >&2; exit 64 ;;
  esac
done
mkdir -p "$project_path" "$state_path"
project_path=$(CDPATH= cd -- "$project_path" && pwd -P)
state_path=$(CDPATH= cd -- "$state_path" && pwd -P)
if [ -n "$model_path" ]; then
  if [ ! -d "$model_path" ]; then
    printf '%s\n' "Model path does not exist: ${model_path}" >&2
    exit 64
  fi
  model_path=$(CDPATH= cd -- "$model_path" && pwd -P)
  # The folder above the model, holding bge-m3-onnx/ (docs/DEFECTS.md Д-62, Д-69):
  # one that holds model files itself is the pre-Д-62 value and leaves the model
  # a level too deep (Д-68); a lone bge-m3/ is the removed Python backend's weights (Д-158).
  for marker in pytorch_model.bin modules.json config.json onnx; do
    if [ -e "${model_path}/${marker}" ]; then
      printf '%s\n' "--model-path names the folder above the models, and ${model_path} holds model files itself (${marker}). Point it at the parent folder that contains bge-m3-onnx/ (docs/INSTALL.md)." >&2
      exit 64
    fi
  done
  if [ ! -d "${model_path}/bge-m3-onnx" ]; then
    printf '%s\n' "${model_path} holds no bge-m3-onnx/ yet; dense search will report that it is not set up until a model is put there." >&2
  fi
fi

if [ "$build_local" -eq 1 ]; then
  printf '%s\n' "Preparing the Docker context with a temporary Node.js 24..."
  docker run --rm --user "${uid}:${gid}" \
    --mount "type=bind,source=${repo_root},target=${repo_root}" \
    --workdir "${repo_root}/ai-dev-mcp-server" \
    "$node_image" sh -c 'node scripts/prepare-docker-context.mjs && node scripts/audit-docker-context.mjs'
  printf '%s\n' "Building ${image}..."
  docker build --tag "$image" "${repo_root}/.docker/build-context"
else
  printf '%s\n' "Pulling ${image}..."
  if ! docker pull "$image"; then
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      printf '%s\n' "Could not pull ${image}, and no cached copy exists." >&2
      exit 69
    fi
    # Installing whatever happened to be in the cache produced bug reports
    # about defects already fixed upstream (docs/DEFECTS.md Д-60), so the age
    # of that copy is stated and using it is a deliberate choice.
    stale_created=$(docker image inspect --format '{{.Created}}' "$image" 2>/dev/null || true)
    stale_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || true)
    [ -n "$stale_created" ] || stale_created="unknown"
    [ -n "$stale_digest" ] || stale_digest="none (image was built locally)"
    stale_warning="Registry pull failed. The cached copy of ${image} was created ${stale_created} (digest: ${stale_digest}) and is missing anything released since."
    printf '%s\n' "$stale_warning" >&2
    if [ "$allow_stale_image" -ne 1 ]; then
      printf '%s\n' "Stopping rather than installing an image of unknown age. Restore the registry connection and run again, or re-run with --allow-stale-image." >&2
      exit 69
    fi
  fi
fi

if [ "$skip_smoke" -ne 1 ]; then
  printf '%s\n' "Checking the MCP handshake..."
  # The server's own answer, instructions and all: 2.x checked for a serverInfo
  # its launcher wrote itself (docs/DEFECTS.md Д-89).
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
  if ! printf '%s\n' "$init" | docker run --rm -i --read-only --tmpfs /tmp:rw,exec,nosuid,size=512m --network none \
      --security-opt no-new-privileges:true --cap-drop ALL \
      --mount "type=volume,source=${data_volume},target=/data" "$image" 2>/dev/null | grep -q '"instructions"'; then
    printf '%s\n' "The server in ${image} did not answer the MCP handshake." >&2
    exit 70
  fi
fi

install_status=0
if [ "$skip_client_install" -ne 1 ]; then
  # The configs are written by the image's own installer. A 2.x image has none —
  # the way back to :2 is still a 3.0 entry, which runs it — so an image of 3.0
  # writes them then: AI_DEV_INSTALLER_IMAGE, pulled as the image is, and used
  # only once it is seen to have one (docs/DEFECTS.md, Д-323, Д-329).
  has_installer() {
    docker run --rm --pull never --network none --entrypoint sh "$1" -c 'command -v ai-dev' >/dev/null 2>&1
  }
  installer_image="$image"
  if ! has_installer "$image"; then
    installer_image="${AI_DEV_INSTALLER_IMAGE:-ghcr.io/stonebridgeway/ai-dev-system:latest}"
    printf '%s\n' "${image} has no installer of its own (a 2.x image): ${installer_image} writes the configs that run it."
    if ! docker pull "$installer_image" && ! docker image inspect "$installer_image" >/dev/null 2>&1; then
      printf '%s\n' "Could not pull ${installer_image}, and no copy of it is here: name an image of 3.0 or later with AI_DEV_INSTALLER_IMAGE." >&2
      exit 69
    fi
    if ! has_installer "$installer_image"; then
      printf '%s\n' "${installer_image} has no installer either (a 2.x image too): name an image of 3.0 or later with AI_DEV_INSTALLER_IMAGE." >&2
      exit 69
    fi
  fi

  # Whether the image's user may share the state folder, tried on Linux whatever
  # the uid: where Docker maps the container's uid 1000 to another host user —
  # rootless Docker, userns-remap, Podman — it cannot write the folder, and the
  # server keeps its state in the volume, as 2.x did (Д-322). A Docker that did
  # not run the image tried nothing, and is not taken for one (Д-331). Docker
  # Desktop on macOS gives what the container writes to the user.
  shared_state=yes
  if [ "$platform" != "Darwin" ]; then
    probe=".ai-dev-share-probe-$$"
    if probe_error=$(docker run --rm --pull never --network none --entrypoint touch \
        --mount "type=bind,source=${state_path},target=/ai-dev-state" "$image" "/ai-dev-state/${probe}" 2>&1 >/dev/null); then
      if [ -O "${state_path}/${probe}" ]; then shared_state=yes; else shared_state=no; fi
    else
      case "$probe_error" in
        *"cannot touch"*) shared_state=no ;;
        *)
          shared_state=untried
          printf '%s\n' "Could not try sharing ${state_path} with ${image}: ${probe_error}" >&2 ;;
      esac
    fi
    rm -f "${state_path}/${probe}" 2>/dev/null || true
  fi

  # The image writes the configs, given each client's own folder and nothing
  # else of this machine. A client named on the command line gets its folder
  # made, as the installer would write it anyway. A config that is a link — a
  # dotfiles repository — is written through it: each folder on its way is
  # mounted too, at its own path (Д-335).
  codex_home="${CODEX_HOME:-${HOME}/.codex}"
  wants() {
    case ",${clients}," in
      *,all,*|*",$1,"*) return 0 ;;
      *,claude,*) [ "$1" = "claude-desktop" ] || [ "$1" = "claude-code" ] ;;
      *) return 1 ;;
    esac
  }
  # One folder a line: "Application Support" has a space in it.
  nl='
'
  mounted="$nl"
  mount_folder() {
    case "$1" in
      *,*|*\"*|*"$nl"*) printf '%s\n' "${1} has a comma, a double quote or a line break, which a docker --mount cannot hold; skipped." >&2; return 1 ;;
    esac
    case "$mounted" in
      *"${nl}${1}${nl}"*) return 0 ;;
    esac
    mounted="${mounted}${1}${nl}"
  }
  install_clients=""
  for pair in "claude-desktop:${app_data}/Claude:claude_desktop_config.json" "cursor:${HOME}/.cursor:mcp.json" \
      "vscode:${app_data}/Code/User:mcp.json" "codex:${codex_home}:config.toml" "gemini:${HOME}/.gemini:settings.json"; do
    client="${pair%%:*}"
    rest="${pair#*:}"
    folder="${rest%:*}"
    file="${rest##*:}"
    wants "$client" || continue
    case ",${clients}," in
      *,all,*) [ -d "$folder" ] || continue ;;
      *) mkdir -p "$folder" ;;
    esac
    mount_folder "$folder" || continue
    link="${folder}/${file}"
    hops=0
    while [ -L "$link" ] && [ "$hops" -lt 8 ]; do
      target=$(readlink "$link")
      case "$target" in
        /*) ;;
        *) target="$(dirname "$link")/${target}" ;;
      esac
      link_dir=$(CDPATH= cd -- "$(dirname "$target")" 2>/dev/null && pwd -P) || break
      mount_folder "$link_dir" || break
      link="${link_dir}/$(basename "$target")"
      hops=$((hops + 1))
    done
    install_clients="${install_clients}${install_clients:+,}${client}"
  done
  set -- run --rm --network none --user "${uid}:${gid}" --read-only --tmpfs /tmp:rw,size=64m \
    --env "HOME=${HOME}" --env "XDG_CONFIG_HOME=${app_data}" --env "CODEX_HOME=${codex_home}"
  set -f
  old_ifs=$IFS
  IFS=$nl
  for folder in $mounted; do
    set -- "$@" --mount "type=bind,source=${folder},target=${folder}"
  done
  IFS=$old_ifs
  set +f
  set -- "$@" --mount "type=bind,source=${state_path},target=${state_path}"
  if [ -n "$model_path" ]; then
    set -- "$@" --mount "type=bind,source=${model_path},target=${model_path},readonly"
  fi
  set -- "$@" "$installer_image" ai-dev clients
  if [ -n "$install_clients" ]; then
    printf '%s\n' "Writing the AI clients' configs (${install_clients})..."
    # One client that cannot be written does not stop the others, nor Claude Code below.
    if ! docker "$@" install --clients="$install_clients" \
        --docker --image="$image" --projects="$project_path" --state="$state_path" --shared-state="$shared_state" --volume="$data_volume" \
        --home="$HOME" --platform="$installer_platform" --docker-command="$docker_command" \
        ${model_path:+"--model=$model_path"}; then
      install_status=1
    fi
  fi
  # Claude Code keeps its servers in ~/.claude.json, a file in the home, which
  # the image is not given: its own CLI writes the entry the image prints.
  if wants claude-code && { [ -e "${HOME}/.claude.json" ] || [ -d "${HOME}/.claude" ] || [ "$clients" != "all" ]; }; then
    if entry=$(docker "$@" entry claude-code \
        --docker --image="$image" --projects="$project_path" --state="$state_path" --shared-state="$shared_state" --volume="$data_volume" \
        --home="$HOME" --platform="$installer_platform" --docker-command="$docker_command" \
        ${model_path:+"--model=$model_path"}); then
      if command -v claude >/dev/null 2>&1; then
        if [ -f "${HOME}/.claude.json" ]; then
          cp "${HOME}/.claude.json" "${HOME}/.claude.json.backup-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
        fi
        claude mcp remove ai-dev --scope user >/dev/null 2>&1 || true
        claude mcp remove ai-dev-system --scope user >/dev/null 2>&1 || true
        if claude mcp add-json ai-dev "$entry" --scope user; then
          printf '%s\n' "  Claude Code             added through \`claude mcp add-json\`"
        else
          install_status=1
        fi
      else
        printf '%s\n' "Claude Code: its CLI is not on PATH here. Add the entry with:" >&2
        printf "  claude mcp add-json ai-dev '%s' --scope user\n" "$entry" >&2
      fi
    else
      install_status=1
    fi
  fi
fi

# 2.x kept a long-lived container per user; 3.0 runs one per session. It goes
# once the configs that named it are rewritten, not before (Д-328).
old_runtime="ai-dev-system-runtime-${uid}"
if [ "$skip_client_install" -ne 1 ] && [ "$install_status" -eq 0 ] \
    && [ "$(docker inspect --format '{{index .Config.Labels "ai-dev.system.runtime"}}' "$old_runtime" 2>/dev/null || true)" = "true" ]; then
  printf '%s\n' "Removing the 2.x runtime container ${old_runtime}: each session runs the image now."
  docker rm -f "$old_runtime" >/dev/null
fi

if [ -n "$stale_warning" ]; then
  printf '%s\n' "Installed from a stale image. ${stale_warning}" >&2
fi
if [ "$install_status" -ne 0 ]; then
  printf '%s\n' "Some AI clients were not configured: see above. The others are; run bootstrap.sh again once that is fixed." >&2
  exit 1
fi
printf '%s\n' "AI Dev is ready. Restart the AI clients to load ai-dev."
