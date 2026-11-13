#!/bin/sh
# botling-agent-install.sh: installs botling-agent @VERSION@ under ~/.botling-agent, pairs this machine with Botling
# over the relay and keeps it connected (docs/remote-workers.md). Botling gives the line that runs it:
#   curl -fsSL <release>/botling-agent-install.sh | sh -s -- --sha <sha256> 'botling-machine1.…'
# The download is checked against --sha (the SHA-256 of the agent Botling itself ships) before it is run; without
# --sha, against the release's SHA256SUMS-agent.txt. Options: --name NAME, --no-start, --no-pair.
set -eu
VERSION="@VERSION@"
BASE="${BOTLING_AGENT_RELEASES:-@RELEASES@}"
BASE="${BASE%/}/v$VERSION"
ASSET="botling-agent-$VERSION.cjs"
d="$HOME/.botling-agent"

sha="" offer="" name="" start=1 pair=1
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) sha="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --no-start) start=0; shift ;;
    --no-pair) pair=0; shift ;;
    botling-machine1.*) offer="$1"; shift ;;
    *) echo "botling-agent-install: unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'botling-agent-install: %s\n' "$*" >&2; exit 1; }

# Node 18+, from the PATH or the login shell's PATH (nvm).
node="$(command -v node 2>/dev/null || true)"
if [ -z "$node" ] && [ -n "${SHELL:-}" ]; then
  p="$("$SHELL" -lc 'printf "\n__BOTLING_PATH__%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__BOTLING_PATH__//p' | tail -n 1)"
  [ -n "$p" ] && PATH="$p:$PATH" && export PATH && node="$(command -v node 2>/dev/null || true)"
fi
[ -n "$node" ] || die "Node.js was not found (Botling needs Node 18 or newer on this machine)."
major="$("$node" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] 2>/dev/null || die "Node $("$node" --version) is too old (Botling needs Node 18 or newer)."
command -v git >/dev/null 2>&1 || say "Note: git was not found; Botling needs it to send the project's files."

fetch() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "Neither curl nor wget is installed."; fi
}
# SHA-256 without running the download: sha256sum, shasum or openssl; else Node reads it as data.
sum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else "$node" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/botling-agent.XXXXXX")"
# Keep the exit status: macOS's sh (bash 3.2) would otherwise exit with the trap's own status, 0.
trap 'status=$?; rm -rf "$tmp"; exit $status' EXIT
trap 'exit 1' INT TERM
# ${VERSION} in braces: in a UTF-8 locale bash 3.2 reads the bytes of "…" as part of the name.
say "Downloading botling-agent ${VERSION}…"
fetch "$BASE/$ASSET" "$tmp/$ASSET" || die "Could not download $BASE/$ASSET."
if [ -z "$sha" ]; then
  fetch "$BASE/SHA256SUMS-agent.txt" "$tmp/SHA256SUMS" || die "Could not download the release's checksums."
  sha="$(grep " \*\{0,1\}$ASSET\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$sha" ] || die "The release's checksums do not list $ASSET."
  say "Note: no --sha given; checking against the release's checksums."
fi
got="$(sum "$tmp/$ASSET")"
[ "$got" = "$sha" ] || die "The download does not match (SHA-256 $got, expected $sha). Nothing was installed."

umask 077
"$node" "$tmp/$ASSET" install >/dev/null </dev/null || die "Could not install botling-agent."
say "Installed botling-agent $VERSION in $d."

if [ "$pair" = 1 ]; then
  [ -n "$offer" ] || die "No pairing code given (the line from Botling, Settings › Machines, ends with one)."
  # (stdin is this script when it comes through a pipe: nothing below may read it)
  if [ -n "$name" ]; then "$d/bin/botling-agent" pair "$offer" --name "$name" </dev/null; else "$d/bin/botling-agent" pair "$offer" </dev/null; fi
fi

[ "$start" = 1 ] || exit 0
# Keep it running: a systemd user service where there is one, a LaunchAgent on macOS, else in the background.
if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  unit="$HOME/.config/systemd/user/botling-agent.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=Botling agent (workers from Botling over the relay)
After=network-online.target

[Service]
ExecStart=$d/bin/botling-agent relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now botling-agent.service >/dev/null 2>&1 || die "Could not start the botling-agent service."
  systemctl --user restart botling-agent.service
  say "Started: systemctl --user status botling-agent (to keep it running after you log out: loginctl enable-linger $(id -un))."
elif [ "$(uname -s)" = Darwin ]; then
  plist="$HOME/Library/LaunchAgents/com.botling.agent.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.botling.agent</string>
  <key>ProgramArguments</key><array><string>$d/bin/botling-agent</string><string>relay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$d/relay.log</string>
</dict></plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"
  say "Started: launchctl list com.botling.agent"
else
  nohup "$d/bin/botling-agent" relay </dev/null >> "$d/relay.log" 2>&1 &
  say "Started in the background (log: $d/relay.log). Start it again after a reboot: $d/bin/botling-agent relay"
fi
