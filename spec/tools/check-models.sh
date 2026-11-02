#!/bin/sh
# Model-checks every spec/models/*/*.tla that has a .cfg beside it; fails on the first violation.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for cfg in "$root"/models/*/*.cfg; do
  [ -e "$cfg" ] || continue
  tla="${cfg%.cfg}.tla"
  [ -f "$tla" ] || continue
  echo "== $(basename "$tla")"
  "$root/tools/tlc.sh" "$tla" || status=1
done
exit $status
