#!/bin/sh
# Installed by ai-dev-system (install_agent_hooks). Runs one hook script with
# Node, wherever this machine keeps it:
#
#   /bin/sh .ai-dev/hooks/with-node.sh <script.mjs> [arguments...]
#
# A bare `node` in a hook command is looked up on the PATH of whatever starts
# the hook, and an editor or a Git client opened from the Dock, a launcher or
# the Start menu does not have the shell's PATH: Node from nvm, fnm, Volta or
# Homebrew is not on it, and the hook failed with "node: not found" while the
# guard, the session handoff and the Stop check silently did nothing
# (docs/DEFECTS.md, Д-103).
#
# Node is taken from, in order: AI_DEV_NODE; the Node this repository's hooks
# were installed with on this machine (.node-path next to this file, which
# git ignores); `node` on PATH; the places installers put it.

# The folder of this file, without `dirname`: the PATH may hold nothing.
case $0 in
  */*) dir=${0%/*} ;;
  *) dir=. ;;
esac
script=$1
if [ -z "$script" ]; then
  echo "ai-dev hook: with-node.sh needs the hook script to run" >&2
  exit 2
fi
shift

recorded=""
if [ -r "$dir/.node-path" ]; then
  IFS= read -r recorded < "$dir/.node-path" || true
fi

for candidate in "$AI_DEV_NODE" "$recorded"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$dir/$script" "$@"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec node "$dir/$script" "$@"
fi

for candidate in \
  "$HOME/.volta/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node \
  "$HOME/.asdf/shims/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$HOME/.local/bin/node"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$dir/$script" "$@"
  fi
done

echo "ai-dev hook: no Node found to run $script. Set AI_DEV_NODE to it, or run install_agent_hooks again from the machine's own Node." >&2
exit 127
