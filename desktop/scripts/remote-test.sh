#!/usr/bin/env bash
# Run desktop unit tests for a commit on a Linux test host instead of this Mac.
#
#   desktop/scripts/remote-test.sh <branch-or-sha> [vitest args...]      npm run build, then npx vitest run <args>
#   desktop/scripts/remote-test.sh <branch-or-sha> --changed <base>      npm run test:changed -- <base> (typecheck too)
#   desktop/scripts/remote-test.sh <branch-or-sha> --unit [vitest args]  npm run test:unit (the full unit suite)
#   desktop/scripts/remote-test.sh <branch-or-sha> --typecheck [...]    typecheck first (npm run typecheck = tsc --noEmit),
#                                                                       then the mode above; a type error fails the run
#   desktop/scripts/remote-test.sh <branch-or-sha> --typecheck-only     only the typecheck, no tests (use this, not tsc on the Mac)
#   desktop/scripts/remote-test.sh --setup [host]                        one-time host setup (Node 24, bare repo)
#
# --typecheck / --typecheck-only come right after the commit. The typecheck reports PASS or FAIL with its time and, on
# failure, the first errors; tests after a failed typecheck are not run. With --changed it is redundant (test:changed
# typechecks) and ignored.
#
# What it does: picks the host (the primary, or the fallback when that one does not answer), pushes the
# commit over ssh to a code-only bare repo there, waits for a free slot, checks the commit out in a per-run worktree,
# links the dependency install cached per desktop lockfile, runs the tests with Node 24 from the host's tools folder,
# streams the output here, saves it, prints a short summary and removes the worktree. Only committed code reaches the
# host: commit (or make a WIP commit) first. Nothing under .bot/, no data and no secrets are copied.
#
# Tests that only mean something on the Mac (case-insensitive disk, APFS clones, macOS sandbox, Electron windows; the
# macOnly list in vitest.config.mts) are skipped or excluded on Linux. The summary lists them under "run on the Mac:"
# with the command to run them here; do that before calling a change tested.
#
# Hosts: no host is built in. Set them in the environment or in remote-test.local.env (KEY=value lines, not tracked
# by git; copy remote-test.local.env.example). The file is looked up at $BOTLING_TEST_CONFIG, next to this script,
# then in the main checkout's desktop/scripts/; the environment wins over the file.
#   BOTLING_TEST_HOST             ssh host name of the primary test host (required)
#   BOTLING_TEST_HOST_SLOTS       runs allowed at once there; later runs wait for a slot (default 2)
#   BOTLING_TEST_FALLBACK         used when the primary does not answer ssh within 8 s (optional)
#   BOTLING_TEST_FALLBACK_SLOTS   runs allowed at once on the fallback (default 2)
# Other settings (environment):
#   BOTLING_REMOTE_SLOTS    overrides the slot count of whichever host is used
#   BOTLING_REMOTE_DIR      folder on the host, relative to its home (default botling-test)
#   BOTLING_REMOTE_WORKERS  vitest --maxWorkers per run (default: vitest.config.mts, 2)
#   BOTLING_REMOTE_TIMEOUT  seconds before a run is stopped (default 3600)
#   BOTLING_REMOTE_LOGS     local folder for the saved output (default <main checkout>/.bot/remote-test-logs)
#   BOTLING_REMOTE_KEEP=1   keep the host worktree after the run (for poking at a failure; remove it by hand)
#
# Exit status: the typecheck's or test command's status; 2 for a usage or setup error.
set -euo pipefail

NODE_VERSION=v24.22.3 # the Node 24 that --setup installs (CI's desktop jobs use Node 24)
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 1 ] || usage
case "$1" in -h|--help) usage ;; esac

# Host settings from remote-test.local.env: only the known keys, never run as shell; the environment wins.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
for conf in "${BOTLING_TEST_CONFIG:-}" "$(dirname "$0")/remote-test.local.env" "${common:+$(dirname "$common")/desktop/scripts/remote-test.local.env}"; do
  [ -n "$conf" ] && [ -f "$conf" ] || continue
  while IFS='=' read -r key value; do
    case "$key" in
      BOTLING_TEST_HOST|BOTLING_TEST_HOST_SLOTS|BOTLING_TEST_FALLBACK|BOTLING_TEST_FALLBACK_SLOTS)
        value=${value%%#*}; value=${value//[[:space:]\"\']/}
        [ -n "${!key+set}" ] || printf -v "$key" '%s' "$value" ;;
    esac
  done < "$conf"
  break
done
[ -n "${BOTLING_TEST_HOST:-}" ] || {
  echo "remote-test: no test host configured. Set BOTLING_TEST_HOST (and optionally BOTLING_TEST_FALLBACK, *_SLOTS), or copy" >&2
  echo "  desktop/scripts/remote-test.local.env.example to desktop/scripts/remote-test.local.env and fill it in." >&2
  exit 2; }

rdir=${BOTLING_REMOTE_DIR:-botling-test}
ssh_opts=(-o BatchMode=yes -o ServerAliveInterval=30)
quote() { printf '%q ' "$@"; }
remote_part() { sed -n '/^#==REMOTE==$/,$p' "$0"; }
# Runs the host part over ssh: the script up to an end line (read whole before it starts), then a newline a second for
# as long as this side lives. The host part reads those on its stdin; when they stop (this side killed, connection
# gone; ssh connection sharing hides that from the host's process tree) it stops its tests and cleans up.
on_host() {
  local h=$1; shift
  ( trap '' PIPE; remote_part; echo '#==END=='; while sleep 1; do echo || exit 0; done ) 2>/dev/null |
    ssh "${ssh_opts[@]}" "$h" "bash -c 'script=\$(sed \"/^#==END==\\\$/q\"); exec bash -c \"\$script\" remote-test \"\$@\"' _ $(quote "$@")"
  return "${PIPESTATUS[1]}"
}

if [ "$1" = --setup ]; then
  h=${2:-$BOTLING_TEST_HOST}
  on_host "$h" "$rdir" "" "" setup "$NODE_VERSION" 0 0 0 "" 0
  exit
fi

ref=$1; shift
mode=vitest; base=; tc=0
case "${1:-}" in
  --typecheck) tc=1; shift ;;
  --typecheck-only) tc=only; shift ;;
esac
case "${1:-}" in
  --changed) [ $# -ge 2 ] || usage; mode=changed; base=$2; shift 2 ;;
  --unit) mode=unit; shift ;;
esac
if [ "$tc" = only ]; then
  [ $# -eq 0 ] || { echo "remote-test: --typecheck-only takes no further arguments" >&2; usage; }
  mode=typecheck
elif [ "$mode" = changed ]; then tc=0 # test:changed typechecks already
fi

host=$BOTLING_TEST_HOST
fallback=${BOTLING_TEST_FALLBACK:-}
dslots=${BOTLING_TEST_HOST_SLOTS:-2}
if ! ssh "${ssh_opts[@]}" -o ConnectTimeout=8 "$host" true 2>/dev/null; then
  [ -n "$fallback" ] && [ "$fallback" != "$host" ] || { echo "remote-test: $host does not answer ssh and there is no fallback" >&2; exit 2; }
  echo "remote-test: $host does not answer ssh; using $fallback" >&2
  host=$fallback; dslots=${BOTLING_TEST_FALLBACK_SLOTS:-2}
fi
slots=${BOTLING_REMOTE_SLOTS:-$dslots}
workers=${BOTLING_REMOTE_WORKERS:-}
timeout=${BOTLING_REMOTE_TIMEOUT:-3600}
keep=${BOTLING_REMOTE_KEEP:-0}

sha=$(git rev-parse --verify --quiet "$ref^{commit}") || { echo "remote-test: '$ref' is not a commit here" >&2; exit 2; }
basesha=
if [ "$mode" = changed ]; then
  basesha=$(git rev-parse --verify --quiet "$base^{commit}") || { echo "remote-test: base '$base' is not a commit here" >&2; exit 2; }
fi
if [ "$(git rev-parse HEAD)" = "$sha" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "remote-test: note: uncommitted changes in this checkout are NOT tested (only commit ${sha:0:12} is)" >&2
fi

run="$(date +%Y%m%d-%H%M%S)-$$-${sha:0:8}"
logs=${BOTLING_REMOTE_LOGS:-$(dirname "$common")/.bot/remote-test-logs}
mkdir -p "$logs"
log="$logs/$run.log"

# Push straight to the host's bare repo: the run's own ref (removed on the host when the run ends), the base for
# --changed, and the branch itself when <ref> names a local branch. Never to GitHub.
refs=("+$sha:refs/runs/$run")
[ -n "$basesha" ] && refs+=("+$basesha:refs/runs/$run-base")
git show-ref --verify --quiet "refs/heads/$ref" && refs+=("+refs/heads/$ref:refs/heads/$ref")
echo "remote-test: run $run: ${mode}${base:+ against $base} at ${sha:0:12} on $host (log: $log)"
git push -q "$host:$rdir/repo.git" "${refs[@]}" || {
  echo "remote-test: push to $host failed; set the host up once with: desktop/scripts/remote-test.sh --setup $host" >&2; exit 2; }

set +e
on_host "$host" "$rdir" "$run" "$sha" "$mode" "$basesha" "$slots" "$timeout" "$keep" "$workers" "$tc" "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
echo "remote-test: exit $status on $host; output saved to $log"
exit "$status"

#==REMOTE==
# Runs on the host (bash 5), sent over ssh as one string; stdin carries the heartbeat (see on_host). Arguments: dir run sha mode base slots timeout
# keep workers typecheck(0|1|only) [vitest args...]; for mode "setup", base is the Node version. Node comes from <dir>/tools/node (no shell
# rc changes on the host). Paths here are the host's own.
set -uo pipefail
export LC_ALL=C
dir=$HOME/$1 run=$2 sha=$3 mode=$4 base=$5 slots=$6 timeout=$7 keep=$8 workers=$9 tc=${10}
shift 10
export PATH="$dir/tools/node/bin:$PATH"
repo=$dir/repo.git wt=$dir/runs/$run out=$dir/logs/$run
tmp=/tmp/botling-rt-$run
say() { echo "remote-test: $*"; }
# The heartbeat: a background reader of stdin marks the run gone at end of input; nothing else reads stdin.
hb=$(mktemp -u "/tmp/botling-rt-gone.XXXXXX")
exec 7<&0 0</dev/null
{ cat <&7 >/dev/null; : >"$hb"; } &
hbpid=$!
exec 7<&-
gone() { [ -e "$hb" ]; }

if [ "$mode" = setup ]; then # Node 24 from nodejs.org (checksum checked) into <dir>/tools, and the bare repo. No sudo.
  set -e
  mkdir -p "$dir/tools" "$dir/deps" "$dir/runs" "$dir/logs" "$dir/locks"
  if [ "$(node -v 2>/dev/null)" != "$base" ]; then
    f=node-$base-linux-x64.tar.xz dl=$(mktemp -d)
    curl -fsSL -o "$dl/$f" "https://nodejs.org/dist/$base/$f"
    curl -fsSL "https://nodejs.org/dist/$base/SHASUMS256.txt" | grep " $f\$" | (cd "$dl" && sha256sum -c -)
    tar -xJf "$dl/$f" -C "$dir/tools" && rm -rf "$dl"
    ln -sfn "node-$base-linux-x64" "$dir/tools/node"
  fi
  [ -d "$repo" ] || { git init -q --bare "$repo"; git -C "$repo" config gc.auto 0; }
  say "set up: node $(node -v), npm $(npm -v), bare repo ~/${repo#"$HOME"/}; $(df -h "$HOME" | awk 'NR==2{print $4}') free"
  command -v make >/dev/null && command -v g++ >/dev/null || say "no make/g++ here: node-pty's pty.node must be copied into ~/${dir#"$HOME"/}/tools/prebuilt/node-pty-<version>/ (see install_deps)"
  kill "$hbpid" 2>/dev/null; rm -f "$hb"
  exit 0
fi
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || { say "Node 24 missing in $dir/tools/node"; exit 2; }
mkdir -p "$dir/runs" "$dir/logs" "$dir/locks" "$out"

# Cleanup runs however this ends: while waiting, after a failure, on a dropped ssh.
cleanup() {
  [ -n "${tpid:-}" ] && kill -KILL -- "-$tpid" 2>/dev/null
  cp "$wt"/desktop/.cache/evidence/unit/*.json "$out/" 2>/dev/null
  if [ "$keep" = 1 ]; then say "kept the worktree: ~/${wt#"$HOME"/}"
  else git -C "$repo" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; fi
  git -C "$repo" update-ref -d "refs/runs/$run" 2>/dev/null
  [ -n "$base" ] && git -C "$repo" update-ref -d "refs/runs/$run-base" 2>/dev/null
  rm -rf "$tmp"
  kill "$hbpid" 2>/dev/null; rm -f "$hb"
}
trap cleanup EXIT
trap 'exit 143' TERM HUP INT

# A slot: one flock file per slot, held on fd 9 for the whole run (released when this shell exits, even if killed).
# While waiting, a closed ssh ends the wait.
start=$(date +%s); waited=0
while :; do
  gone && exit 143
  for i in $(seq 1 "$slots"); do
    exec 9>"$dir/locks/slot-$i"
    if flock -n 9; then slot=$i; break 2; fi
    exec 9>&-
  done
  [ $(( $(date +%s) - waited )) -ge 60 ] && { say "all $slots slots busy, waiting ($(( $(date +%s) - start ))s)"; waited=$(date +%s); }
  sleep 3
done
say "slot $slot/$slots after $(( $(date +%s) - start ))s; host load $(cut -d' ' -f1-3 /proc/loadavg), $(free -g | awk '/^Mem:/{print $7}') GB RAM free"

# Old runs left by a killed ssh (their slot is free again): drop worktrees and logs older than a day.
find "$dir/runs" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null
find "$dir/logs" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null
git -C "$repo" worktree prune

git -C "$repo" worktree add -q --detach "$wt" "$sha" || { say "worktree add failed"; exit 2; }
cd "$wt/desktop" || exit 2
# Dependencies: one install per desktop lockfile under <dir>/deps (the layout link-deps.sh uses), then link-deps.sh links
# it. A host without a compiler installs with --ignore-scripts and takes node-pty's pty.node (N-API, so any Node) from
# another install of the same node-pty version here, or from <dir>/tools/prebuilt/node-pty-<version>/.
install_deps() {
  local hash target ptyv src
  hash=$(sha256sum package-lock.json | cut -c1-12); target=$dir/deps/desktop-$hash
  [ -f "$target/.complete" ] && return 0
  exec 8>"$dir/deps/.desktop-$hash.flock"; flock 8
  [ -f "$target/.complete" ] && return 0
  say "installing dependencies for lockfile $hash (npm ci)"
  rm -rf "$target"; mkdir -p "$target" "$dir/deps/.npm-cache" "$dir/deps/.electron-cache"
  cp package.json package-lock.json "$target/"
  export npm_config_cache=$dir/deps/.npm-cache electron_config_cache=$dir/deps/.electron-cache
  if command -v make >/dev/null && command -v g++ >/dev/null; then
    (cd "$target" && npm ci --no-audit --no-fund) || return 1
  else
    (cd "$target" && npm ci --no-audit --no-fund --ignore-scripts) || return 1
    ptyv=$(node -p 'require(process.argv[1]).version' "$target/node_modules/node-pty/package.json")
    src=
    for f in "$dir"/deps/desktop-*/node_modules/node-pty/build/Release/pty.node "$dir/tools/prebuilt/node-pty-$ptyv/pty.node"; do
      [ -f "$f" ] || continue
      if [ "${f#"$dir/deps/"}" != "$f" ]; then
        [ "$(node -p 'require(process.argv[1]).version' "${f%/build/Release/pty.node}/package.json")" = "$ptyv" ] || continue
      fi
      src=$f; break
    done
    [ -n "$src" ] || { say "no compiler here and no pty.node for node-pty $ptyv: copy one from a host with make/g++ into ~/${dir#"$HOME"/}/tools/prebuilt/node-pty-$ptyv/"; return 1; }
    mkdir -p "$target/node_modules/node-pty/build/Release" && cp "$src" "$target/node_modules/node-pty/build/Release/pty.node"
  fi
  (cd "$target" && node node_modules/electron/install.js && node -e 'require("node-pty")') || return 1
  sha256sum package-lock.json > "$target/.complete"
}
install_deps >"$out/deps.log" 2>&1 || { cat "$out/deps.log"; say "dependency install failed"; exit 2; }
BOTLING_DEPS_DIR=$dir/deps sh scripts/link-deps.sh >>"$out/deps.log" 2>&1 || { cat "$out/deps.log"; say "link-deps failed"; exit 2; }
mkdir -p "$tmp"

json=$out/vitest.json
reporters=(--reporter=default --reporter=./test/failure-reporter.ts --reporter=json "--outputFile.json=$json")
extra=(); [ -n "$workers" ] && extra=(--maxWorkers="$workers")
case "$mode" in
  vitest)  cmd=(bash -c 'npm run build && exec npx vitest run "$@"' _ "${reporters[@]}" "${extra[@]}" "$@") ;;
  typecheck) cmd=(true) ;;
  unit)    cmd=(npm run test:unit -- "${reporters[@]}" "${extra[@]}" "$@") ;;
  changed) cmd=(npm run test:changed -- "$base") ;;
esac

# --typecheck: run npm run typecheck first inside the same process group; a failure skips the tests. Its verdict and the
# first errors are printed in the output; $tmp/tcfail marks it for the summary.
if [ "$tc" != 0 ]; then
  cmd=(bash -c '
    t=$(date +%s); echo "remote-test: typecheck: npm run typecheck"
    npm run typecheck >"$TMPDIR/typecheck.log" 2>&1; rc=$?; s=$(( $(date +%s) - t ))
    if [ "$rc" = 0 ]; then echo "remote-test: typecheck PASS in ${s}s"; exec "$@"; fi
    : >"$TMPDIR/tcfail"
    n=$(grep -c "error TS" "$TMPDIR/typecheck.log")
    echo "remote-test: typecheck FAIL (exit $rc, $n errors) in ${s}s; first errors:"
    grep -m10 "error TS" "$TMPDIR/typecheck.log" | sed "s/^/  /"
    [ "$n" = 0 ] && tail -n 15 "$TMPDIR/typecheck.log"
    exit "$rc"' _ "${cmd[@]}")
fi

# The tests run in their own process group (setsid, no fork here) so a timeout or a dropped ssh stops all of them.
t0=$(date +%s)
NO_COLOR=1 TMPDIR=$tmp setsid "${cmd[@]}" >"$out/output.log" 2>&1 </dev/null &
tpid=$!
tail -n +1 -f --pid="$tpid" "$out/output.log" &
tailpid=$!
why=
while kill -0 "$tpid" 2>/dev/null; do
  if gone; then why="ssh connection closed"; fi
  if [ $(( $(date +%s) - t0 )) -ge "$timeout" ]; then why="timeout after ${timeout}s"; fi
  if [ -n "$why" ]; then kill -TERM -- "-$tpid" 2>/dev/null; sleep 5; kill -KILL -- "-$tpid" 2>/dev/null; break; fi
  sleep 2
done
wait "$tpid"; rc=$?
wait "$tailpid" 2>/dev/null   # not a bare wait: the heartbeat reader runs until this side ends
kill -KILL -- "-$tpid" 2>/dev/null   # anything the tests left running
tpid=
secs=$(( $(date +%s) - t0 ))
[ -n "$why" ] && { say "stopped: $why"; rc=124; }
if [ "$mode" = typecheck ] || [ -e "$tmp/tcfail" ]; then
  say "$([ "$rc" = 0 ] && echo PASS || echo FAIL) (exit $rc) in ${secs}s"
  exit "$rc"
fi

# Summary: vitest's JSON when there is one; the tests skipped here because they need the Mac.
SECS=$secs RC=$rc JSON=$json MODE=$mode node - "$@" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const { SECS, RC, JSON: file, MODE } = process.env, args = process.argv.slice(2);
const line = (s) => console.log(`remote-test: ${s}`);
line(`${RC === "0" ? "PASS" : "FAIL"} (exit ${RC}) in ${SECS}s`);
let report = null;
try { report = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!report) { if (MODE !== "changed") line("no vitest JSON report (build or startup failed?); see the output above"); process.exit(0); }
const rel = (f) => path.relative(process.cwd(), f);
const files = report.testResults, bad = files.filter((r) => r.status === "failed").length;
line(`files ${files.length - bad} passed, ${bad} failed; tests ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests + (report.numTodoTests || 0)} skipped`);
const marker = /process\.platform\s*[!=]==?\s*["']darwin["']|caseInsensitive|case-insensitive|process\.env\.DISPLAY/;
const mac = [];
for (const r of report.testResults) {
  const failed = r.assertionResults.filter((a) => a.status === "failed");
  if (r.status === "failed") line(`  FAIL ${rel(r.name)}${failed.length ? `: ${failed.slice(0, 3).map((a) => a.fullName).join(" | ")}${failed.length > 3 ? ` (+${failed.length - 3})` : ""}` : `: ${(r.message || "").split("\n")[0].slice(0, 160)}`}`);
  const skipped = r.assertionResults.filter((a) => a.status === "pending" || a.status === "skipped");
  if (skipped.length && marker.test(fs.readFileSync(r.name, "utf8"))) mac.push(`${rel(r.name)} (${skipped.length} skipped)`);
}
// Files vitest.config.mts leaves out off macOS.
try {
  const list = /const macOnly = \[([\s\S]*?)\]/.exec(fs.readFileSync("vitest.config.mts", "utf8"))?.[1] ?? "";
  for (const name of list.match(/"[^"]+"/g) ?? []) {
    const n = name.slice(1, -1), f = `test/unit/${n}.test.ts`;
    if (!args.some((a) => !a.startsWith("-")) || args.some((a) => !a.startsWith("-") && f.includes(a))) mac.push(`${f} (macOnly, not run)`);
  }
} catch {}
if (mac.length) {
  line(`run on the Mac: ${mac.length} file(s) skip tests here that need macOS (case-insensitive disk, APFS, sandbox, windows):`);
  for (const m of mac) line(`  ${m}`);
  line(`  cd desktop && npm run build && npx vitest run ${[...new Set(mac.map((m) => path.basename(m.split(" ")[0], ".test.ts")))].join(" ")}`);
}
NODE
exit "$rc"
