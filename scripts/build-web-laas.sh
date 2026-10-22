#!/bin/bash
# Builds web-laas (LaTeX snippets + live preview, by the same author, GPL-3.0-or-later) for the web
# bots' web views, into Sources/ClaudeCodeBot/Resources/web-laas, from a laas-copy checkout with
# its node_modules installed (`npm install` there). The built files are committed, so the app
# builds without laas-copy; run this again to take a newer web-laas.
#   scripts/build-web-laas.sh ~/tool/extension/laas-copy     (or WEB_LAAS_SOURCE=…)
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="${1:-${WEB_LAAS_SOURCE:-}}"
if [[ -z "$SOURCE" ]]; then
  echo "usage: scripts/build-web-laas.sh <path to a laas-copy (web-laas) checkout>" >&2
  exit 2
fi
if [[ ! -d "$SOURCE/node_modules/esbuild" ]]; then
  echo "No node_modules in $SOURCE: run npm install there first." >&2
  exit 1
fi
node scripts/web-laas/build.mjs "$SOURCE"
