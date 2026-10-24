#!/bin/bash
# The reference Swift test run: build everything (app and tests), then every test in one serial
# process, the way CI and the release workflow run them. Slower than scripts/test-fast.sh, which
# runs the same tests split over several serial processes; use this one before a pull request.
#
#   scripts/test-all.sh           # Swift build + all Swift tests, serially
#   scripts/test-all.sh --web     # and the web chat's typecheck and tests (needs Web/node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."

swift build --build-tests
swift test --skip-build --no-parallel

if [[ "${1:-}" == "--web" ]]; then
  (cd Web && npm run typecheck && npm test)
fi
