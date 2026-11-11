#!/bin/sh
# Packs `botling run` (docs/headless-run.md) into DEST: the built core, plugin host, built-in plugins and the run
# command, plus a `botling` launcher. Plain Node 22+ runs it on Linux or macOS; nothing in it needs Electron.
#   scripts/pack-headless.sh DEST        (run `npm run build` first, or pass --build)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
build=0
dest=""
for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    *) dest=$arg ;;
  esac
done
[ -n "$dest" ] || { echo "usage: scripts/pack-headless.sh [--build] DEST" >&2; exit 2; }
[ "$build" = 1 ] && (cd "$here" && node build.mjs)
[ -f "$here/out/cli/run.cjs" ] || { echo "out/cli/run.cjs is missing: run npm run build first" >&2; exit 1; }
mkdir -p "$dest/out"
for part in core host cli; do rm -rf "$dest/out/$part"; cp -R "$here/out/$part" "$dest/out/$part"; done
rm -rf "$dest/out/builtin-plugins"
mkdir -p "$dest/out/builtin-plugins"
# The terminal plugin carries a native PTY build for the desktop; a headless run has no terminal pane.
for plugin in "$here/out/builtin-plugins"/*; do
  [ "$(basename "$plugin")" = "botling.terminal" ] && continue
  cp -R "$plugin" "$dest/out/builtin-plugins/"
done
find "$dest/out" -name '*.map' -delete
cat > "$dest/botling" <<'LAUNCH'
#!/bin/sh
# botling run --task instruction.md --out DIR [options]   (docs/headless-run.md)
here=$(cd "$(dirname "$0")" && pwd)
[ "${1:-}" = "run" ] && shift
exec node "$here/out/cli/run.cjs" "$@"
LAUNCH
chmod +x "$dest/botling"
echo "packed botling run into $dest ($(du -sh "$dest" | cut -f1))"
