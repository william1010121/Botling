#!/bin/bash
# End-to-end check of web capture on FIXTURE pages (server.mjs), not on the real sites:
# for Gemini, ChatGPT and Claude it records a fixture page in a real web bot page
# (`--capture-test`), checks the capture masks the fixture's secrets, writes the expected answer
# as Maintainer would, and replays it with `--test-extractor`. A page drawn from older data than
# its traffic ("stale") must be caught as a mismatch and fail.
#
#   swift build && Tests/WebCaptureFixtures/run.sh [path to the ClaudeCodeBot binary]
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="${1:-$repo/.build/debug/ClaudeCodeBot}"
port="${CCB_FIXTURE_PORT:-8766}"
work="$(mktemp -d -t ccb-capture-e2e)"
failures=0

node "$here/server.mjs" "$port" >"$work/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1

check() { # message, condition (exit status of the last command)
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}

expected() { # pack folder
  node -e '
    const [folder] = process.argv.slice(1);
    const turns = [
      ["user", "Why is a hash table O(1) on average?"],
      ["assistant", "Each slot holds about **n/m** keys on average.\n\n- Hash the key.\n- Probe until a match."],
      ["user", "And in the worst case?"],
      ["assistant", "Every key can land in one slot, so a lookup is **O(n)** in the worst case."],
    ].map(([role, text]) => ({ role, text }));
    require("fs").writeFileSync(folder + "/expected.json", JSON.stringify({ title: "Hash table load factor", turns, confirmed: false }, null, 2));
  ' "$1"
}

for entry in gemini:app/fixture0001 chatgpt:c/fixture-0002 claude:chat/fixture-0003; do
  site="${entry%%:*}"
  page="${entry#*:}"
  cat "$repo/Sources/ClaudeCodeBot/Resources/web-extractors/$site.js" "$here/extractors/$site-network.js" >"$work/$site.js"
  out="$("$app" --capture-test "http://127.0.0.1:$port/$page" --site "$site" --seconds 5 --out "$work/run" --extractor "$work/$site.js" 2>&1)"
  echo "$out" | sed 's/^/     /'
  pack="$(echo "$out" | sed -n 's/^Capture: //p')"
  [ -d "$pack" ]; check "$site: capture written" $?
  echo "$out" | grep -q "Bot's last check: page and traffic agree"; check "$site: the bot's page and traffic readings agree" $?
  echo "$out" | grep -q "Saved by the bot: .*(4 messages)"; check "$site: the bot saved 4 messages" $?
  for file in manifest.json events.jsonl network.har dom.html outline.json screenshot.png "extractor/$site.js" extractor/output.json; do
    [ -s "$pack/$file" ] || { echo "     missing $file"; false; }
  done
  check "$site: every file of the capture" $?
  ! grep -rqE "AFixtureXsrf|fixture\.user@|eyJhbGci|0b5e2a8c|csrf-fixture|device-fixture|gAAAAABfixture|fixture-cookie|user-fixture-123|Fixture User" "$pack"
  check "$site: no secret of the fixture is left in the capture" $?
  expected "$pack"
  "$app" --test-extractor "$pack" --extractor "$work/$site.js" | sed 's/^/     /'
  check "$site: --test-extractor passes" "${PIPESTATUS[0]}"
done

# A page drawn from older data than its traffic: caught, and the test fails.
out="$("$app" --capture-test "http://127.0.0.1:$port/app/fixture0001?variant=stale" --site gemini --seconds 5 --out "$work/run" --extractor "$work/gemini.js" 2>&1)"
echo "$out" | sed 's/^/     /'
echo "$out" | grep -q "Bot's last check: mismatch"; check "stale page: the bot sees a mismatch" $?
pack="$(echo "$out" | sed -n 's/^Capture: //p')"
expected "$pack"
"$app" --test-extractor "$pack" --extractor "$work/gemini.js" | sed 's/^/     /'
[ "${PIPESTATUS[0]}" -ne 0 ]; check "stale page: --test-extractor fails" $?

# Every capture of a site at once (the stale one fails it).
"$app" --test-extractor "$work/run/captures/gemini" --extractor "$work/gemini.js" | tail -1 | grep -q "Passed 1, failed 1, skipped 0"
check "a site's folder: each capture tested" $?

echo
[ "$failures" -eq 0 ] && echo "All passed ($work)" || echo "$failures failed ($work)"
exit "$failures"
