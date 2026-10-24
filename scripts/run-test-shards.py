#!/usr/bin/env python3
"""Runs the Swift tests as several serial test processes at once.

Each shard is its own process running its tests with `--no-parallel`, the way CI runs the whole
suite: a test keeps a main actor and a process to itself, so nothing that holds the main actor (a
blocking child process, a busy fake) can starve another test's short wait in that process. Work
is spread over the shards by how long it took last time (kept in .build/test-timings.json); a
suite much longer than its share is split into its tests.

Used by scripts/test-fast.sh; expects the tests to be built already. The shards start the test
runner `swift test` would start (swiftpm-testing-helper) directly: concurrent `swift test`
processes wait for one another on the lock of .build, so they would run one after another.
Only Swift Testing tests run here; scripts/test-all.sh is the reference run.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TIMINGS = ROOT / ".build" / "test-timings.json"
LOGS = ROOT / ".build" / "test-shards"
UNKNOWN_SUITE_SECONDS = 0.5
UNKNOWN_TEST_SECONDS = 0.05


def output(command):
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def list_tests():
    out = subprocess.run(["swift", "test", "list", "--skip-build"], cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        sys.exit("swift test list failed (build the tests first)")
    return [line.strip() for line in out.stdout.splitlines() if "/" in line]


def runner():
    """The test runner and the environment `swift test` gives it."""
    swift = Path(output(["xcrun", "--find", "swift"])).resolve()
    helper = swift.parent.parent / "libexec" / "swift" / "pm" / "swiftpm-testing-helper"
    platform = output(["xcrun", "--show-sdk-platform-path"])
    bundle = Path(output(["swift", "build", "--show-bin-path"])) / "botlingPackageTests.xctest" / "Contents" / "MacOS" / "botlingPackageTests"
    for needed in (helper, bundle):
        if not needed.exists():
            sys.exit(f"missing {needed}")
    env = dict(os.environ)
    env["DYLD_FRAMEWORK_PATH"] = f"{platform}/Developer/Library/Frameworks:{platform}/Developer/Library/PrivateFrameworks"
    env["DYLD_LIBRARY_PATH"] = f"{platform}/Developer/usr/lib"
    return helper, bundle, env


def suite_of(test_id):
    return test_id.split("/", 1)[0]


def record_timings(text, suite_names, timings, split):
    """Suite and test times from a serial run's output (a test's lines sit inside its suite's)."""
    suite_start = re.compile(r"^◇ Suite (\S+) started")
    suite_end = re.compile(r"^. Suite (\S+) (?:passed|failed) after ([0-9.]+) seconds")
    test_end = re.compile(r"^. Test (\S+?)(?: with \d+ test cases?)? (?:passed|failed) after ([0-9.]+) seconds")
    current = None
    for line in text.splitlines():
        if m := suite_start.match(line):
            current = suite_names.get(m.group(1))
        elif m := suite_end.match(line):
            if m.group(1) in suite_names and suite_names[m.group(1)] not in split:
                timings["suites"][suite_names[m.group(1)]] = float(m.group(2))
            current = None
        elif current and (m := test_end.match(line)):
            timings["tests"][f"{current}/{m.group(1)}"] = float(m.group(2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", "-j", type=int, default=0)
    parser.add_argument("--filter", action="append", default=[],
                        help="regex on test ids (Module.Suite/test()); repeatable, any matches")
    parser.add_argument("--skip", action="append", default=[], help="regex of test ids to leave out")
    parser.add_argument("--verbose", "-v", action="store_true", help="print every shard's full output")
    args = parser.parse_args()

    tests = list_tests()
    helper, bundle, env = runner()
    if any("import XCTest" in f.read_text(errors="replace") for f in (ROOT / "Tests").glob("*Tests/*.swift")):
        print("note: XCTest tests are not run here (only Swift Testing); scripts/test-all.sh runs them")
    selected = [t for t in tests
                if (not args.filter or any(re.search(f, t) for f in args.filter))
                and not any(re.search(s, t) for s in args.skip)]
    if not selected:
        sys.exit("no tests match")

    by_suite, chosen = {}, {}
    for t in tests:
        by_suite.setdefault(suite_of(t), []).append(t)
    for t in selected:
        chosen.setdefault(suite_of(t), []).append(t)

    try:
        timings = json.loads(TIMINGS.read_text())
        timings["suites"], timings["tests"]
    except (OSError, ValueError, KeyError, TypeError):
        timings = {"suites": {}, "tests": {}}

    def test_weight(t):
        return timings["tests"].get(t, UNKNOWN_TEST_SECONDS)

    def suite_weight(suite):
        if suite in timings["suites"] and len(chosen[suite]) == len(by_suite[suite]):
            return timings["suites"][suite]
        if suite not in timings["suites"]:
            return UNKNOWN_SUITE_SECONDS * len(chosen[suite]) / len(by_suite[suite])
        return sum(test_weight(t) for t in chosen[suite])

    jobs = args.jobs or min(8, max(2, (os.cpu_count() or 4) // 2 + 1))
    total = sum(suite_weight(s) for s in chosen)
    # A unit is a whole suite (one filter) or, for a suite much longer than a shard's share, one test.
    units, split = [], set()
    for suite in chosen:
        if suite_weight(suite) > total / jobs / 2 and len(chosen[suite]) > 1:
            split.add(suite)
            units += [(test_weight(t), "^" + re.escape(t) + "(/|$)") for t in chosen[suite]]
        elif len(chosen[suite]) == len(by_suite[suite]):
            units.append((suite_weight(suite), "^" + re.escape(suite) + "/"))
        else:
            units.append((suite_weight(suite), "|".join("^" + re.escape(t) + "(/|$)" for t in chosen[suite])))
    jobs = max(1, min(jobs, len(units)))

    # Longest first onto the least loaded shard.
    shards = [{"filters": [], "load": 0.0} for _ in range(jobs)]
    for weight, pattern in sorted(units, key=lambda u: u[0], reverse=True):
        shard = min(shards, key=lambda s: s["load"])
        shard["filters"].append(pattern)
        shard["load"] += weight

    LOGS.mkdir(parents=True, exist_ok=True)
    for old in LOGS.glob("*.log"):
        old.unlink()
    started = time.monotonic()
    running = []
    for index, shard in enumerate(shards):
        command = [str(helper), "--test-bundle-path", str(bundle), "--no-parallel"]
        for pattern in shard["filters"]:
            command += ["--filter", pattern]
        command += [str(bundle), "--testing-library", "swift-testing"]
        log = LOGS / f"shard-{index}.log"
        handle = log.open("w")
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=handle, stderr=subprocess.STDOUT)
        running.append({"index": index, "process": process, "log": log, "handle": handle, "begin": time.monotonic()})
    for r in running:
        r["process"].wait()
        r["handle"].close()
        r["took"] = time.monotonic() - r["begin"]
    wall = time.monotonic() - started

    run_line = re.compile(r"Test run with (\d+) tests? in \d+ suites? (passed|failed)")
    suite_names = {s.split(".", 1)[-1]: s for s in by_suite}
    ran, failed, issues = 0, [], []
    for r in running:
        text = r["log"].read_text(errors="replace")
        counts = run_line.findall(text)
        if counts:
            ran += int(counts[-1][0])
        if r["process"].returncode != 0 or not counts or counts[-1][1] != "passed":
            failed.append(r)
            issues += [line for line in text.splitlines()
                       if line.startswith("✘") or "error:" in line or "Fatal error" in line]
            if not counts:
                issues += text.splitlines()[-15:]
        record_timings(text, suite_names, timings, split)
        if args.verbose:
            sys.stdout.write(text)
    # A split suite ran in pieces: its time is the sum of its tests'.
    for suite in split:
        known = [timings["tests"][t] for t in by_suite[suite] if t in timings["tests"]]
        if len(known) == len(by_suite[suite]):
            timings["suites"][suite] = sum(known)
    TIMINGS.write_text(json.dumps(timings, indent=0, sort_keys=True))

    slowest = max(running, key=lambda r: r["took"])
    print(f"{len(running)} shards, slowest {slowest['took']:.1f}s; logs in {LOGS.relative_to(ROOT)}/")
    if issues:
        print("\n".join(issues[:200]))
    if failed:
        print(f"FAILED: {ran} of {len(selected)} tests ran, failures in "
              f"{', '.join(r['log'].name for r in failed)} ({wall:.1f}s)")
        return 1
    if ran != len(selected):
        print(f"FAILED: {len(selected)} tests selected but {ran} ran")
        return 1
    print(f"PASSED: {ran} of the package's {len(tests)} tests in {wall:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
