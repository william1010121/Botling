#!/bin/sh
# A stand-in for ssh in tests (remote workers): drops ssh's options, then runs the remote command on this machine
# with HOME=$FAKE_SSH_HOME, as the host's login would. FAKE_SSH_LOG: a file it appends each host (and command) to.
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
host="$1"; shift
[ -n "$FAKE_SSH_LOG" ] && printf '%s %s\n' "$host" "$(printf '%s' "$*" | head -c 60 | tr '\n' ' ')" >> "$FAKE_SSH_LOG"
[ -n "$FAKE_SSH_FAIL" ] && { echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; }
HOME="${FAKE_SSH_HOME:?FAKE_SSH_HOME is not set}" exec sh -c "$*"
