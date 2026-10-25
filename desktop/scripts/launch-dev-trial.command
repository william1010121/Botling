#!/bin/sh
# Manual user launch only; packaging/tests never invoke a real app through this shortcut.
set -eu
umask 077
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
trial_app=${1:-"$base/Botling 2.app"}
if [ ! -d "$trial_app" ] && [ -d "$base/mac-arm64/Botling 2.app" ]; then
  trial_app="$base/mac-arm64/Botling 2.app"
fi
binary="$trial_app/Contents/MacOS/Botling 2"
if [ ! -x "$binary" ]; then
  echo 'Put this shortcut beside Botling 2.app in a writable trial folder, or pass its app path.' >&2
  exit 1
fi
export BOTLING_DATA_DIR="$base/trial-data"
export BOTLING_IMPORT_FROM="$BOTLING_DATA_DIR/empty-import"
export CODEX_HOME="$BOTLING_DATA_DIR/codex"
export CLAUDE_CONFIG_DIR="$BOTLING_DATA_DIR/claude"
export TMPDIR="$BOTLING_DATA_DIR/tmp"
# Keep BOTLING_1X_DIR unchanged: its read-only project lock check must not be bypassed.
mkdir -p "$BOTLING_IMPORT_FROM" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$TMPDIR" "$BOTLING_DATA_DIR/projects"
exec "$binary"
