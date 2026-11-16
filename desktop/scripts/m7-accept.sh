#!/usr/bin/env bash
# M7 acceptance (M7-30): plan-change-plugin-kernel.md §4.3 checks 1-8 in one headless run on the Linux test host, no window.
#
#   desktop/scripts/m7-accept.sh <sha> [check ...]     checks are 1..8 (default: all of 1-8 except the browser airplane, see below)
#   desktop/scripts/m7-accept.sh <sha> 1a 2 3 4 5 6 7 8 1b
#
# Each check is one remote-test.sh run over the existing tests that prove it (the table is in `checks` below and in
# .bot/artifacts/v3-m7/M7-30.md). The first run also typechecks. Run counts are small unless the caller sets them:
#   KERNEL_ACCEPTANCE_RUNS (default 200)  PLUGIN_FEED_RUNS (default 200)  SWAP_OUTBOX_RUNS (default 500)
# Check 1b is M7-08's real-browser airplane harness (acceptance config, needs a chromium that can start on the host).
# Prints one line per check (PASS/FAIL, tests, the remote-test log) and exits 1 when any check failed.
set -uo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
sha=$1; shift
export KERNEL_ACCEPTANCE_RUNS=${KERNEL_ACCEPTANCE_RUNS:-200} PLUGIN_FEED_RUNS=${PLUGIN_FEED_RUNS:-200} SWAP_OUTBOX_RUNS=${SWAP_OUTBOX_RUNS:-500}

declare -A files=(
  [1a]="test/unit/shell-alone.test.ts test/unit/shell-fallback.test.ts"
  [2]="test/unit/slot-owners.test.ts test/unit/plugin-owned-slots.test.ts test/unit/m7-surfaces-2x.test.ts test/unit/browser-pane-plugin.test.ts"
  [3]="test/unit/hot-update-acceptance.test.ts test/unit/kernel-swap-outbox.property.test.ts"
  [4]="test/unit/shell-version-check.test.ts"
  [5]="test/unit/shell-fallback.test.ts test/unit/shell-alone.test.ts"
  [6]="test/unit/page-plugins-needs-shell.test.ts"
  [7]="test/unit/inpage-loader.test.ts"
  [8]="test/unit/plugin-kernel-acceptance.test.ts test/unit/renderer-plugin-feed.test.ts"
)
[ $# -gt 0 ] || set -- 1a 2 3 4 5 6 7 8
status=0
typecheck=--typecheck
for check in "$@"; do
  if [ "$check" = 1b ]; then
    args=(-c test/acceptance/vitest.config.mts test/acceptance/web-v3/shell-alone-airplane.test.ts)
  else
    [ -n "${files[$check]:-}" ] || { echo "m7-accept: no check $check" >&2; exit 2; }
    read -r -a args <<<"${files[$check]}"
  fi
  out=$(scripts/remote-test.sh "$sha" $typecheck "${args[@]}" 2>&1); code=$?
  typecheck=
  summary=$(printf '%s\n' "$out" | grep -E '^remote-test: (PASS|FAIL|files|exit)' | tr '\n' ' ')
  log=$(printf '%s\n' "$out" | sed -n 's/.*output saved to //p' | tail -1)
  echo "check $check: exit $code | $summary| log ${log:-?}"
  [ "$code" -eq 0 ] || status=1
done
exit $status
