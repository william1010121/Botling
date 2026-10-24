#!/bin/bash
# Fast inner loop for the Swift tests: an incremental build of just the test bundle, then every
# test (or the ones you filter to) in several serial `swift test` processes at once.
#
#   scripts/test-fast.sh                      # build, run all tests sharded
#   scripts/test-fast.sh Conductor            # only tests whose id matches (regex, repeatable)
#   scripts/test-fast.sh -j 4 --skip Live     # 4 shards, leave out ids matching Live
#   scripts/test-fast.sh --no-build -v        # reuse the last build, print all output
#   scripts/test-fast.sh --full-build         # also rebuild the app first
#
# Test ids look like ClaudeCodeBotCoreTests.SuiteName/testName(). The app itself is only rebuilt
# when Sources/ClaudeCodeBot changed since its last build (WindowLayoutTests launch it).
# scripts/test-all.sh is the reference run: a full build and one serial process, as CI does.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=1
FULL_BUILD=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --full-build) FULL_BUILD=1 ;;
    -j|--jobs) ARGS+=(--jobs "$2"); shift ;;
    --skip) ARGS+=(--skip "$2"); shift ;;
    --filter) ARGS+=(--filter "$2"); shift ;;
    -v|--verbose) ARGS+=(--verbose) ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) ARGS+=(--filter "$1") ;;
  esac
  shift
done

if [[ "$BUILD" == 1 ]]; then
  started=$SECONDS
  LOG=.build/test-fast-build.log
  mkdir -p .build
  APP="$(swift build --show-bin-path)/botling"
  # Only WindowLayoutTests launch the app; rebuild it when its own sources changed (or asked).
  if [[ "$FULL_BUILD" == 1 || ! -x "$APP" || -n "$(find Sources/ClaudeCodeBot -newer "$APP" -type f -print -quit)" ]]; then
    what="tests and app"; command=(swift build --build-tests)
  else
    what="tests"; command=(swift build --product botlingPackageTests)
  fi
  if ! "${command[@]}" > "$LOG" 2>&1; then
    grep -E "error:" "$LOG" | head -40 || tail -40 "$LOG"
    echo "build failed (full log: $LOG)"
    exit 1
  fi
  echo "build ($what): $((SECONDS - started))s"
fi

exec python3 scripts/run-test-shards.py ${ARGS[@]+"${ARGS[@]}"}
