#!/bin/sh
# Update a built-in plugin in the running app, with no rebuild and no restart:
#   desktop/scripts/push-builtin-plugin.sh botling.catchup
#   desktop/scripts/push-builtin-plugin.sh --remove botling.catchup      (the app's own copy runs again)
#   desktop/scripts/push-builtin-plugin.sh --data-dir <core data folder> botling.catchup
# See scripts/push-builtin-plugin.mjs and src/core/plugins/overrides.ts.
set -eu
exec node "$(dirname "$0")/push-builtin-plugin.mjs" "$@"
