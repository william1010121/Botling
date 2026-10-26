#!/bin/sh
# Link this checkout's desktop/node_modules (and Web/node_modules) to the shared dependency install,
# so a new worktree needs no install of its own: `desktop/scripts/link-deps.sh` (or `npm run link-deps`
# once something is linked). Run it once per worktree, and again after package-lock.json changes.
#
# The shared installs live in $BOTLING_DEPS_DIR (default /Volumes/My-SSD/botling-work/deps), one per
# lockfile: desktop-<first 12 hex of the lockfile's sha256>/node_modules, made with `npm ci` the first
# time a lockfile is seen. Worktrees on an older lockfile keep their own install untouched.
# A real desktop/node_modules directory is left alone unless you pass --replace.
set -eu

desktop=$(cd "$(dirname "$0")/.." && pwd)
web="$desktop/../Web"
deps=${BOTLING_DEPS_DIR:-/Volumes/My-SSD/botling-work/deps}
replace=0
[ "${1:-}" = "--replace" ] && replace=1

[ -d "$(dirname "$deps")" ] || { echo "link-deps: $(dirname "$deps") is not there (external disk not mounted?). Set BOTLING_DEPS_DIR." >&2; exit 1; }
hash=$(shasum -a 256 "$desktop/package-lock.json" | cut -c1-12)
target="$deps/desktop-$hash"

if [ ! -f "$target/.complete" ]; then
  mkdir -p "$deps"
  lock="$deps/.desktop-$hash.lock"
  until mkdir "$lock" 2>/dev/null; do echo "link-deps: waiting for another install of $hash ($lock)"; sleep 5; done
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT
  if [ ! -f "$target/.complete" ]; then
    echo "link-deps: installing desktop dependencies for lockfile $hash into $target (npm ci)"
    rm -rf "$target"
    mkdir -p "$target" "$deps/.npm-cache" "$deps/.electron-cache"
    cp "$desktop/package.json" "$desktop/package-lock.json" "$target/"
    (cd "$target" && npm_config_cache="$deps/.npm-cache" electron_config_cache="$deps/.electron-cache" \
      npm ci --no-audit --no-fund && node node_modules/electron/install.js) # Electron's binary is otherwise fetched on first use
    shasum -a 256 "$desktop/package-lock.json" > "$target/.complete"
  fi
fi

link() { # link <path> <target>
  if [ -L "$1" ]; then rm "$1"
  elif [ -e "$1" ]; then
    [ "$replace" = 1 ] || { echo "link-deps: $1 is a real directory; pass --replace to remove it and link instead." >&2; exit 1; }
    rm -rf "$1"
  fi
  ln -s "$2" "$1"
  echo "link-deps: $1 -> $2"
}
link "$desktop/node_modules" "$target/node_modules"
# Web/ takes its packages from desktop/node_modules (see build.mjs), through its own link.
[ -d "$web" ] && { [ -L "$web/node_modules" ] || [ ! -e "$web/node_modules" ]; } && link "$web/node_modules" ../desktop/node_modules
exit 0
