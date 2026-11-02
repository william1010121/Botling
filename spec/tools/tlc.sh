#!/bin/sh
# Runs TLC (the TLA+ model checker) on one model: `spec/tools/tlc.sh spec/models/restart/Restart.tla [TLC flags]`.
# The checker is a pinned tla2tools.jar, fetched once into $BOTLING_SPEC_CACHE and checked against its sha256.
set -eu
version=1.7.4
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
cache=${BOTLING_SPEC_CACHE:-$HOME/.cache/botling-spec}
jar="$cache/tla2tools-$version.jar"
if [ ! -f "$jar" ]; then
  mkdir -p "$cache"
  curl -sSfL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
  mv "$jar.part" "$jar"
fi
echo "$sha  $jar" | shasum -a 256 -c - >/dev/null || { echo "tlc.sh: $jar does not match the pinned sha256" >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: spec/tools/tlc.sh <Model.tla> [TLC flags]" >&2; exit 2; }
model=$1; shift
dir=$(cd "$(dirname "$model")" && pwd)
name=$(basename "$model" .tla)
cd "$dir"
# -deadlock is off by default in our cfgs' sense only when a model says so; workers pass their own flags.
exec java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -metadir "$dir/states" -config "$name.cfg" "$@" "$name.tla"
