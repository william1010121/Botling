#!/usr/bin/env bash
# Run desktop unit tests for a commit on a Linux test host instead of this Mac.
#
#   desktop/scripts/remote-test.sh <branch-or-sha> [vitest args...]      npm run build, then npx vitest run <args>
#   desktop/scripts/remote-test.sh <branch-or-sha> --changed <base>      npm run test:changed -- <base> (typecheck too)
#   desktop/scripts/remote-test.sh <branch-or-sha> --unit [vitest args]  npm run test:unit (the full unit suite)
#   desktop/scripts/remote-test.sh <branch-or-sha> --typecheck [...]    typecheck first (npm run typecheck = tsc --noEmit),
#                                                                       then the mode above; a type error fails the run
#   desktop/scripts/remote-test.sh <branch-or-sha> --typecheck-only     only the typecheck, no tests (use this, not tsc on the Mac)
#   desktop/scripts/remote-test.sh <branch-or-sha> --fresh [...]        run for real even if the same run already passed (see "Memo")
#   desktop/scripts/remote-test.sh <branch-or-sha> --repeat N [...]     run the tests N times (2-50) in one slot and one connection
#   desktop/scripts/remote-test.sh --setup [host]                        one-time host setup (Node 24, bare repo)
#
# --typecheck / --typecheck-only / --repeat N come right after the commit, in any order; --fresh may stand anywhere. The typecheck reports
# PASS or FAIL with its time and, on failure, every error (the whole output is also in the saved log); tests after a
# failed typecheck are not run. With --changed it is redundant (test:changed typechecks) and ignored.
#
# What it does: picks the host (the primary, or the fallback when that one does not answer), pushes the
# commit over ssh to a code-only bare repo there, waits its turn for a slot, checks the commit out in the slot's
# worktree, links the dependency install cached per desktop lockfile, runs the tests with Node 24 from the host's tools
# folder, streams the output here, saves it and prints a short summary. Only committed code reaches the host: commit
# (or make a WIP commit) first. Nothing under .bot/, no data and no secrets are copied.
#
# Slots keep their worktree between runs (<dir>/slots/<n>): the next run switches it to its commit (git checkout
# --detach, untracked files removed) and keeps desktop/.cache/tsc (the tsc incremental cache), desktop/.cache/vite and
# desktop/out, so a second run in the same slot starts warm. A slot left dirty by a crashed run is reset; if that fails
# it is recreated (cold). BOTLING_REMOTE_KEEP=1 uses a throw-away per-run worktree instead, and keeps it.
#
# Queue: runs start in the order they arrived (a ticket per run in <dir>/queue; the ticket of a dead run is dropped).
# A short run (1-5 test files, or --typecheck-only) may also use the last 2 slots, which longer runs never take, so
# short runs do not wait behind long ones; a longer run also waits while the host load is at or above 75% of its
# threads (after 5 minutes of that it starts anyway). While waiting, "remote-test: queued: position N ..." lines say
# where the run stands. The lowest free slot of its kind is taken, so a run usually lands
# on the slot the previous one used.
#   BOTLING_REMOTE_RESERVE  slots kept for short runs (default 2; 0 when the host has fewer than 4 slots)
#   BOTLING_REMOTE_SMALL    most test files a short run has (default 5)
#   BOTLING_REMOTE_LOADMAX  load (load1, or runnable threads) at which longer runs stop starting (default 75% of nproc)
#
# Memo: a run is keyed by (commit, mode, base, typecheck flag, test filters and options, worker count, the forwarded
# *_RUNS/_SEED variables). A PASS is remembered on the host for 7 days: asking for the same run again prints
# "remote-test: cached result from <log> ..." with the saved summary lines and exits 0 without running anything. If the
# same run is in progress right now, this one waits for it and takes its result (it runs itself when that one fails).
# FAIL results are never reused, and a real FAIL deletes an earlier PASS of the same key. --fresh (or BOTLING_REMOTE_FRESH=1)
# runs for real and skips the memo. Hunting a flaky test: one `--repeat 20 <file>` run (one slot, one connection, 20
# rounds in the same worktree, the first failing round ends it; vitest itself has no --repeat flag), never twenty
# separate runs. --repeat ignores the memo and does not write one.
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
#   BOTLING_REMOTE_KEEP=1   run in a per-run worktree and keep it after the run (for poking at a failure; remove it by hand)
#   BOTLING_REMOTE_FRESH=1  same as --fresh
# Run counts and the seed of the seeded property tests are forwarded to the host when set here, digits only (nothing else is):
#   KERNEL_ACCEPTANCE_RUNS=10000 desktop/scripts/remote-test.sh <sha> test/unit/plugin-kernel-acceptance.test.ts
#   (KERNEL_ACCEPTANCE_SEED replays one seed; PLUGIN_FEED_RUNS sets the plugin feed's random view sequences; SWAP_OUTBOX_RUNS sets the swap outbox property's run count)
#
# Test filters (vitest args that are file names): one argument per file, relative to desktop/ ("test/unit/a.test.ts" or the
# short name "a"). A leading "desktop/" or "./" is stripped; an argument with a space or comma is refused (exit 2). After the
# run, a filter that matched no test file fails the run (exit 1) and is named in the summary.
#
# Exit status: the typecheck's or test command's status; 1 when a test filter matched no test file; 2 for a usage or setup error.
set -euo pipefail

NODE_VERSION=v24.22.3 # the Node 24 that --setup installs (CI's desktop jobs use Node 24)
usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
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
  on_host "$h" "$rdir" "" "" setup "$NODE_VERSION" 0 0 0 "" 0 "" 0 "" ""
  exit
fi

ref=$1; shift
mode=vitest; base=; tc=0; fresh=${BOTLING_REMOTE_FRESH:-0}; repeat=1
while :; do
  case "${1:-}" in
    --typecheck) tc=1; shift ;;
    --typecheck-only) tc=only; shift ;;
    --fresh) fresh=1; shift ;;
    --repeat) [[ ${2:-} =~ ^([2-9]|[1-4][0-9]|50)$ ]] || { echo "remote-test: --repeat takes a number from 2 to 50" >&2; exit 2; }; repeat=$2; shift 2 ;;
    *) break ;;
  esac
done
pargs=(); for a in "$@"; do if [ "$a" = --fresh ]; then fresh=1; else pargs+=("$a"); fi; done   # vitest has no --fresh: accept it anywhere
set -- "${pargs[@]+"${pargs[@]}"}"
[ "$fresh" = 1 ] || fresh=0
case "${1:-}" in
  --changed) [ $# -ge 2 ] || usage; mode=changed; base=$2; shift 2 ;;
  --unit) mode=unit; shift ;;
esac
if [ "$tc" = only ]; then
  [ $# -eq 0 ] || { echo "remote-test: --typecheck-only takes no further arguments" >&2; usage; }
  [ "$repeat" = 1 ] || { echo "remote-test: --repeat does not apply to --typecheck-only" >&2; exit 2; }
  mode=typecheck
elif [ "$mode" = changed ]; then
  tc=0 # test:changed typechecks already
  [ "$repeat" = 1 ] || { echo "remote-test: --repeat does not apply to --changed" >&2; exit 2; }
fi

# Test filters. vitest runs in desktop/ and matches a filter as a substring of the file's path relative to desktop/, so a
# leading "desktop/" or "./" matches nothing (and the other filters would silently run alone): strip it. One argument
# holding several names ("a b", "a,b") is one filter that matches nothing: refuse it. Values of options are left alone.
nfilters=0
if [ "$mode" = vitest ] || [ "$mode" = unit ]; then
  valopt=" -t --testNamePattern -c --config -r --root --dir --project --reporter --shard --maxWorkers --pool --outputFile "
  fargs=(); isval=0
  for a in "$@"; do
    if [ "$isval" = 1 ]; then isval=0
    elif [[ $a == -* ]]; then [[ $a != *=* && $valopt == *" $a "* ]] && isval=1
    else
      nfilters=$(( nfilters + 1 ))
      o=$a
      while :; do case "$a" in ./*) a=${a#./} ;; desktop/*) a=${a#desktop/} ;; *) break ;; esac; done
      case "$a" in
        ""|*[[:space:],]*) echo "remote-test: test filter '$o' has a space or comma (or is empty): pass one argument per test file, e.g. test/unit/a.test.ts test/unit/b.test.ts (in zsh expand an array: \"\${files[@]}\")" >&2; exit 2 ;;
      esac
    fi
    fargs+=("$a")
  done
  set -- "${fargs[@]+"${fargs[@]}"}"
fi

# The replay knobs of the seeded property tests (see the header): only these names, only a number, else the run is refused.
envs=
for name in KERNEL_ACCEPTANCE_RUNS KERNEL_ACCEPTANCE_SEED PLUGIN_FEED_RUNS SWAP_OUTBOX_RUNS; do
  value=${!name:-}
  [ -n "$value" ] || continue
  [[ $value =~ ^[0-9]{1,9}$ ]] || { echo "remote-test: $name must be a number (got '$value')" >&2; exit 2; }
  envs+="$name=$value "
done

# Queue class: a short run (1..BOTLING_REMOTE_SMALL test files, or the typecheck alone) may use the reserved slots.
smallmax=${BOTLING_REMOTE_SMALL:-5}
[[ $smallmax =~ ^[0-9]{1,3}$ ]] || { echo "remote-test: BOTLING_REMOTE_SMALL must be a number (got '$smallmax')" >&2; exit 2; }
small=0
case "$mode" in
  typecheck) small=1 ;;
  vitest|unit) [ "$nfilters" -ge 1 ] && [ "$nfilters" -le "$smallmax" ] && small=1 ;;
esac
qopts="small=$small repeat=$repeat"
for name in BOTLING_REMOTE_RESERVE BOTLING_REMOTE_LOADMAX; do
  value=${!name:-}
  [ -n "$value" ] || continue
  [[ $value =~ ^[0-9]{1,3}$ ]] || { echo "remote-test: $name must be a number (got '$value')" >&2; exit 2; }
  qopts+=" $(printf %s "${name#BOTLING_REMOTE_}" | tr A-Z a-z)=$value"
done

host=$BOTLING_TEST_HOST
fallback=${BOTLING_TEST_FALLBACK:-}
dslots=${BOTLING_TEST_HOST_SLOTS:-2}
if ! ssh "${ssh_opts[@]}" -o ConnectTimeout=8 "$host" true 2>/dev/null; then
  [ -n "$fallback" ] && [ "$fallback" != "$host" ] || { echo "remote-test: $host does not answer ssh and there is no fallback" >&2; exit 2; }
  echo "remote-test: $host does not answer ssh; using $fallback" >&2
  host=$fallback; dslots=${BOTLING_TEST_FALLBACK_SLOTS:-2}
fi
slots=${BOTLING_REMOTE_SLOTS:-$dslots}
[[ $slots =~ ^[1-9][0-9]{0,2}$ ]] || { echo "remote-test: the slot count must be a number (got '$slots')" >&2; exit 2; }
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
on_host "$host" "$rdir" "$run" "$sha" "$mode" "$basesha" "$slots" "$timeout" "$keep" "$workers" "$tc" "$envs" "$fresh" "$log" "$qopts" "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
echo "remote-test: exit $status on $host; output saved to $log"
exit "$status"

#==REMOTE==
# Runs on the host (bash 5), sent over ssh as one string; stdin carries the heartbeat (see on_host). Arguments: dir run sha mode base slots timeout
# keep workers typecheck(0|1|only) envs (NAME=digits words) fresh(0|1) locallog (the log path on the Mac, for the memo) qopts (small=0|1 repeat=N
# reserve=N loadmax=N) [vitest args...]; for mode "setup", base is the Node version. Node comes from <dir>/tools/node (no shell
# rc changes on the host). Paths here are the host's own.
set -uo pipefail
export LC_ALL=C
dir=$HOME/$1 run=$2 sha=$3 mode=$4 base=$5 slots=$6 timeout=$7 keep=$8 workers=$9 tc=${10} envs=${11} fresh=${12} locallog=${13} qopts=${14}
shift 14
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
  mkdir -p "$dir/tools" "$dir/deps" "$dir/runs" "$dir/logs" "$dir/locks" "$dir/slots" "$dir/queue" "$dir/memo"
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
mkdir -p "$dir/runs" "$dir/logs" "$dir/locks" "$dir/slots" "$dir/queue" "$dir/memo" "$out" "$tmp"

small=0 repeat=1 reserve= loadmax=
for w in $qopts; do
  case "$w" in small=*) small=${w#small=} ;; repeat=*) repeat=${w#repeat=} ;; reserve=*) reserve=${w#reserve=} ;; loadmax=*) loadmax=${w#loadmax=} ;; esac
done
[ "$repeat" -ge 2 ] 2>/dev/null && fresh=1 || repeat=1   # --repeat skips the memo (and writes none, see finish)
ncpu=$(nproc 2>/dev/null || echo 4)
[ -n "$loadmax" ] || loadmax=$(( ncpu * 3 / 4 ))
[ "$loadmax" -ge 1 ] || loadmax=1
[ -n "$reserve" ] || reserve=2
[ "$slots" -ge 4 ] || reserve=0
[ "$reserve" -le $(( slots - 1 )) ] || reserve=$(( slots - 1 ))
general=$(( slots - reserve ))   # slots 1..general take any run; the last $reserve only short runs

tk= slot= persist=0 tpid= why= sumf=$tmp/summary
memo=
# Cleanup runs however this ends: while waiting, after a failure, on a dropped ssh.
cleanup() {
  [ -n "${tpid:-}" ] && kill -KILL -- "-$tpid" 2>/dev/null
  cp "$wt"/desktop/.cache/evidence/unit/*.json "$out/" 2>/dev/null
  cp "$tmp/typecheck.log" "$out/" 2>/dev/null
  if [ "$persist" = 1 ]; then : # the slot's worktree stays; the next run on it resets it
  elif [ "$keep" = 1 ] && [ -d "$wt" ]; then say "kept the worktree: ~/${wt#"$HOME"/}"
  else git -C "$repo" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; fi
  git -C "$repo" update-ref -d "refs/runs/$run" 2>/dev/null
  [ -n "$base" ] && git -C "$repo" update-ref -d "refs/runs/$run-base" 2>/dev/null
  [ -n "$tk" ] && rm -f "$tk"
  rm -f "$dir/queue/.new-$run"
  [ -n "$memo" ] && [ "$(cat "$memo.running" 2>/dev/null)" = "$run" ] && rm -f "$memo.running"
  rm -rf "$tmp"
  kill "$hbpid" 2>/dev/null; rm -f "$hb"
}
trap cleanup EXIT
trap 'exit 143' TERM HUP INT

# ---- Memo and dedupe: the same run (key) that already passed, or is running now, is not run again -------------------
key=$(printf '%s\0' "$sha" "$mode" "$base" "$tc" "$workers" "$envs" "$repeat" "$@" | sha256sum | cut -c1-24)
memo=$dir/memo/$key
find "$dir/memo" -type f -name '*.pass*' -mtime +7 -delete 2>/dev/null   # not the .lock files: deleting one a run holds would let a second identical run take a new lock
# memo file: run id, log path on the Mac, finish time (epoch), seconds, commit, then the summary lines as printed
memo_show() { # $1: how it came about; prints the cached summary and returns 0 when a PASS is remembered
  local m_run m_log m_at m_secs m_sha ago
  [ -f "$memo.pass" ] || return 1
  { IFS= read -r m_run; IFS= read -r m_log; IFS= read -r m_at; IFS= read -r m_secs; IFS= read -r m_sha; } <"$memo.pass" || return 1
  [[ $m_at =~ ^[0-9]+$ ]] || return 1
  ago=$(( $(date +%s) - m_at ))
  say "cached result from $m_log (run $m_run, PASS $(( ago / 60 )) min ago, commit ${m_sha:0:12}, took ${m_secs}s): $1; pass --fresh to run it for real"
  tail -n +6 "$memo.pass"
}
memo_store() {
  { echo "$run"; echo "$locallog"; date +%s; echo "$secs"; echo "$sha"; cat "$sumf"; } >"$memo.pass.$run" && mv -f "$memo.pass.$run" "$memo.pass"
}
# End of every run that got as far as running: remember a PASS, forget a PASS that a real FAIL contradicts.
finish() {
  local r=$1
  if [ -z "$why" ] && [ "$repeat" = 1 ]; then
    if [ "$r" = 0 ]; then memo_store; else rm -f "$memo.pass"; fi
  fi
  exit "$r"
}
if [ "$fresh" != 1 ]; then
  memo_show "nothing was run again" && exit 0
  exec 6>>"$memo.lock"
  if flock -n 6; then
    memo_show "it passed just now" && exit 0   # an identical run may have finished between the first look and the lock
  else
    say "an identical run ($(cat "$memo.running" 2>/dev/null || echo unknown)) of this commit and test set is in progress; waiting for its result instead of running it twice (--fresh runs it anyway)"
    dstart=$(date +%s) dlast=$(date +%s)
    until flock -w 3 6; do
      gone && exit 143
      [ $(( $(date +%s) - dlast )) -ge 60 ] && { say "still waiting for the identical run ($(( $(date +%s) - dstart ))s)"; dlast=$(date +%s); }
    done
    memo_show "it passed while this run waited $(( $(date +%s) - dstart ))s" && exit 0
    say "the identical run did not pass; running it here"
  fi
  echo "$run" >"$memo.running"
fi

# ---- Queue: first come, first served; a short run may also take the reserved slots; longer runs wait for host load ----
# A ticket is a file in <dir>/queue named <ns timestamp>-<run>, locked (flock) by its run for as long as the run lives, so
# a ticket nobody holds belongs to a dead run and is removed by whoever sees it. The decision is the same for everyone:
# walk the live tickets in order and hand each one a free slot (a short run the reserved ones first); a run starts when
# the walk reaches its own ticket with a slot in hand, then takes that slot's flock (one per slot, held on fd 9).
cls=large; [ "$small" = 1 ] && cls=small
tk=$dir/queue/$(date +%s%N)-$run
{ exec 5>"$dir/queue/.new-$run" && flock -n 5 && echo "$cls" >&5 && mv "$dir/queue/.new-$run" "$tk"; } || { say "cannot create a queue ticket in $dir/queue"; exit 2; }
live_tickets() {
  local f
  for f in "$dir"/queue/[0-9]*; do
    [ -e "$f" ] || continue
    if [ "$f" != "$tk" ] && ( flock -n 3 ) 2>/dev/null 3<"$f"; then rm -f "$f"; continue; fi   # nobody holds it: its run died
    [ -e "$f" ] && echo "$f"
  done
}
start=$(date +%s); lastmsg=0; lastpos=-1; loadsince=0; loadforce=0
while :; do
  gone && exit 143
  [ -e "$tk" ] || { say "this run's queue ticket disappeared"; exit 2; }
  now=$(date +%s)
  read -r load1 _ _ procs _ </proc/loadavg
  eff=${load1%%.*}; run_now=$(( ${procs%%/*} - 1 )); [ "$run_now" -gt "$eff" ] && eff=$run_now   # load1 lags; the runnable count does not
  loadok=0; { [ "$eff" -lt "$loadmax" ] || [ "$loadforce" = 1 ]; } && loadok=1
  fg=0 fr=0 busy=0
  for i in $(seq 1 "$slots"); do
    if ( flock -n 3 ) 2>/dev/null 3>"$dir/locks/slot-$i"; then
      if [ "$i" -le "$general" ]; then fg=$(( fg + 1 )); else fr=$(( fr + 1 )); fi
    else busy=$(( busy + 1 )); fi
  done
  pos=0 got= by=slot
  for f in $(live_tickets); do
    pos=$(( pos + 1 )); g=
    if [ "$(cat "$f" 2>/dev/null)" = small ]; then
      if [ "$fr" -gt 0 ]; then fr=$(( fr - 1 )); g=r; elif [ "$fg" -gt 0 ]; then fg=$(( fg - 1 )); g=g; fi
    elif [ "$fg" -gt 0 ] && [ "$loadok" = 1 ]; then fg=$(( fg - 1 )); g=g
    elif [ "$fg" -gt 0 ] && [ "$f" = "$tk" ]; then by=load
    fi
    [ "$f" = "$tk" ] && { got=$g; break; }
  done
  if [ -n "$got" ]; then
    if [ "$got" = r ]; then lo=$(( general + 1 )) hi=$slots; else lo=1 hi=$general; fi
    for i in $(seq "$lo" "$hi"); do
      exec 9>"$dir/locks/slot-$i"
      if flock -n 9; then slot=$i; break 2; fi
      exec 9>&-
    done
  fi
  if [ "$by" = load ] && [ "$pos" -gt 0 ]; then
    [ "$loadsince" = 0 ] && loadsince=$now
    if [ $(( now - loadsince )) -ge 300 ]; then loadforce=1; say "host load stayed at or above $loadmax for 5 minutes; starting anyway"; fi
  else loadsince=0; fi
  if { [ "$pos" != "$lastpos" ] && [ $(( now - lastmsg )) -ge 5 ]; } || [ $(( now - lastmsg )) -ge 60 ]; then
    if [ "$by" = load ]; then reason="a slot is free but host load $load1/$eff is at or above $loadmax"; else reason="$busy of $slots slots busy"; fi
    say "queued: position $pos ($(( pos - 1 )) ahead), $cls run; $reason; waited $(( now - start ))s"
    lastmsg=$now lastpos=$pos
  fi
  sleep 2
done
exec 5>&-; rm -f "$tk"; tk=
say "slot $slot/$slots after $(( $(date +%s) - start ))s; host load $(cut -d' ' -f1-3 /proc/loadavg), $(free -g | awk '/^Mem:/{print $7}') GB RAM free"

# Old runs left by a killed ssh (their slot is free again): drop worktrees and logs older than a day.
find "$dir/runs" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null
find "$dir/logs" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null
git -C "$repo" worktree prune

# The slot's worktree: switched to this commit with its caches kept (desktop/.cache/tsc, desktop/.cache/vite, desktop/out,
# the dependency links); everything else untracked goes. Reset or, when git cannot, recreated.
prep_slot() {
  local gd
  if [ -e "$wt/.git" ] && gd=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null); then
    rm -f "$gd/index.lock"   # a crashed run's; this slot's flock is ours
    if git -C "$wt" reset -q --hard HEAD && git -C "$wt" checkout -q -f --detach "$sha" &&
       git -C "$wt" clean -ffdxq -e /desktop/.cache/tsc/ -e /desktop/.cache/vite/ -e /desktop/out/ -e node_modules; then
      return 0
    fi
    say "slot $slot's worktree is in a bad state (a run that died?); recreating it, its caches start cold"
  fi
  git -C "$repo" worktree remove --force "$wt" 2>/dev/null; rm -rf "$wt"; git -C "$repo" worktree prune
  git -C "$repo" worktree add -q --detach "$wt" "$sha"
}
if [ "$keep" = 1 ]; then
  git -C "$repo" worktree add -q --detach "$wt" "$sha" || { say "worktree add failed"; exit 2; }
else
  wt=$dir/slots/$slot
  prep_slot || { say "worktree add failed"; exit 2; }
  persist=1
fi
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

json=$out/vitest.json
reporters=(--reporter=default --reporter=./test/failure-reporter.ts --reporter=json "--outputFile.json=$json")
extra=(); [ -n "$workers" ] && extra=(--maxWorkers="$workers")
case "$mode" in
  vitest)  cmd=(bash -c 'npm run build && exec npx vitest run "$@"' _ "${reporters[@]}" "${extra[@]}" "$@") ;;
  typecheck) cmd=(true) ;;
  unit)    cmd=(npm run test:unit -- "${reporters[@]}" "${extra[@]}" "$@") ;;
  changed) cmd=(npm run test:changed -- "$base") ;;
esac
# --repeat N: the same command N times in this slot; the first failing round ends the run (its status is the run's).
if [ "$repeat" -ge 2 ]; then
  cmd=(bash -c 'n=$1; shift; for i in $(seq 1 "$n"); do echo "remote-test: repeat $i/$n"; "$@"; r=$?; [ "$r" = 0 ] || { echo "remote-test: repeat $i/$n FAILED (exit $r)"; exit "$r"; }; done' _ "$repeat" "${cmd[@]}")
fi

# --typecheck: run npm run typecheck first inside the same process group; a failure skips the tests. Its verdict and every
# error are printed in the output; $tmp/tcfail marks it for the summary.
if [ "$tc" != 0 ]; then
  cmd=(bash -c '
    t=$(date +%s); echo "remote-test: typecheck: npm run typecheck"
    npm run typecheck >"$TMPDIR/typecheck.log" 2>&1; rc=$?; s=$(( $(date +%s) - t ))
    if [ "$rc" = 0 ]; then echo "remote-test: typecheck PASS in ${s}s"; exec "$@"; fi
    : >"$TMPDIR/tcfail"
    n=$(grep -c "error TS" "$TMPDIR/typecheck.log")
    echo "remote-test: typecheck FAIL (exit $rc, $n errors) in ${s}s; all errors:"
    sed "s/^/  /" "$TMPDIR/typecheck.log"
    exit "$rc"' _ "${cmd[@]}")
fi

# The tests run in their own process group (setsid, no fork here) so a timeout or a dropped ssh stops all of them.
t0=$(date +%s)
NO_COLOR=1 TMPDIR=$tmp setsid env $envs "${cmd[@]}" >"$out/output.log" 2>&1 </dev/null &
tpid=$!
tail -n +1 -f --pid="$tpid" "$out/output.log" &
tailpid=$!
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
  line="$([ "$rc" = 0 ] && echo PASS || echo FAIL) (exit $rc) in ${secs}s"
  say "$line"
  grep '^remote-test: typecheck \(PASS\|FAIL\)' "$out/output.log" >"$sumf" 2>/dev/null
  echo "remote-test: $line" >>"$sumf"
  finish "$rc"
fi

# Summary: vitest's JSON when there is one; the tests skipped here because they need the Mac. The lines are also kept in
# $sumf for the memo.
grep '^remote-test: typecheck \(PASS\|FAIL\)' "$out/output.log" >"$sumf" 2>/dev/null
SECS=$secs RC=$rc JSON=$json MODE=$mode node - "$@" <<'NODE' | tee -a "$sumf"
const fs = require("node:fs"), path = require("node:path");
const { SECS, RC, JSON: file, MODE } = process.env, args = process.argv.slice(2);
const line = (s) => console.log(`remote-test: ${s}`);
let report = null;
try { report = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const rel = (f) => path.relative(process.cwd(), f);
// Filters (arguments that are not options or option values) that matched no test file: vitest runs the others and still
// passes, so a review could claim tests ran that never did. A macOnly file counts as matched (it is listed below).
const valopt = new Set(["-t", "--testNamePattern", "-c", "--config", "-r", "--root", "--dir", "--project", "--reporter", "--shard", "--maxWorkers", "--pool", "--outputFile"]);
const filters = []; let isval = false;
for (const a of args) { if (isval) isval = false; else if (a.startsWith("-")) isval = !a.includes("=") && valopt.has(a); else filters.push(a); }
let macOnlyFiles = [];
try { macOnlyFiles = ((/const macOnly = \[([\s\S]*?)\]/.exec(fs.readFileSync("vitest.config.mts", "utf8"))?.[1] ?? "").match(/"[^"]+"/g) ?? []).map((n) => `test/unit/${n.slice(1, -1)}.test.ts`); } catch {}
const unmatched = !report || MODE === "changed" ? [] : filters.filter((f) => !report.testResults.some((r) => rel(r.name).includes(f)) && !macOnlyFiles.some((m) => m.includes(f)));
const rc = unmatched.length && RC === "0" ? "1" : RC;
line(`${rc === "0" ? "PASS" : "FAIL"} (exit ${rc}) in ${SECS}s`);
if (!report) { if (MODE !== "changed") line("no vitest JSON report (build or startup failed?); see the output above"); process.exit(0); }
if (unmatched.length) line(`FAIL: ${unmatched.length} of ${filters.length} test filter(s) matched no test file that vitest ran here (typo, not in the include list, excluded, or a desktop/ prefix): ${unmatched.join(" ")}`);
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
// Files a local Mac run skips because they are heavy there (heavyLocal in vitest.config.mts), listed only when they ran.
try {
  const list = /const heavyLocal = \[([\s\S]*?)\]/.exec(fs.readFileSync("vitest.config.mts", "utf8"))?.[1] ?? "";
  const heavy = new Set((list.match(/"[^"]+"/g) ?? []).map((n) => `test/unit/${n.slice(1, -1)}.test.ts`));
  const ran = report.testResults.map((r) => rel(r.name)).filter((f) => heavy.has(f));
  if (ran.length) {
    line(`heavy: ${ran.length} file(s) a local Mac run skips (heavyLocal) ran here, with their full case counts:`);
    for (const f of ran) line(`  ${f}`);
  }
} catch {}
if (mac.length) {
  line(`run on the Mac: ${mac.length} file(s) skip tests here that need macOS (case-insensitive disk, APFS, sandbox, windows):`);
  for (const m of mac) line(`  ${m}`);
  line(`  cd desktop && npm run build && npx vitest run ${[...new Set(mac.map((m) => path.basename(m.split(" ")[0], ".test.ts")))].join(" ")}`);
}
process.exit(unmatched.length ? 3 : 0);
NODE
nrc=${PIPESTATUS[0]}; [ "$rc" = 0 ] && [ "$nrc" = 3 ] && rc=1   # 3: a filter matched no test file
finish "$rc"
