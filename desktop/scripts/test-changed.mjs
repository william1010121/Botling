// The quick check for day-to-day work: `npm run test:changed [-- <base-ref>]`.
// Typecheck, then only the unit tests related to the files changed since <base-ref> (default HEAD,
// i.e. uncommitted work; staged, unstaged and untracked files always count). Related means:
//   - a changed test file itself;
//   - a unit test that imports a changed file, directly or not (vitest's module graph);
//   - a unit test named after a changed source file (src/core/groups.ts → test/unit/groups*.test.ts),
//     which catches the tests that drive the built core over core-harness.ts instead of importing it;
//   - a unit test whose text names a changed file (electron-builder.config.cjs, build.mjs, …), for
//     files that tests read or run rather than import.
// out/ is rebuilt first (well under a second) because many unit tests run the built core.
// The full suite (`npm test`) is for a release candidate, not for every change.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] || process.env.BOTLING_TEST_BASE || "HEAD";
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: desktop, encoding: "utf8" });
  if (result.status !== 0) { console.error(result.stderr.trim() || `git ${args.join(" ")} failed`); process.exit(2); }
  return result.stdout.split("\n").filter(Boolean);
};
const root = git("rev-parse", "--show-toplevel")[0];
const changed = [...new Set([
  ...git("diff", "--name-only", "--no-renames", base, "--"),
  // ls-files lists relative to the current directory (desktop/) by default; --full-name and the
  // top-level pathspec give whole-repo paths from the root, as diff does (Web/ included).
  ...git("ls-files", "--others", "--exclude-standard", "--full-name", ":/"),
].map((path) => (path.startsWith("/") ? path : join(root, path))))].filter(existsSync);
// What the desktop app is built from: its own sources and tests, and Web/'s chat page, host, plugins and component kit.
const sources = changed.filter((path) => {
  const rel = relative(root, path);
  return /\.(ts|tsx|mts|mjs|cjs|js)$/.test(rel) && /^(desktop\/(src|test|scripts)\/|desktop\/(build\.mjs|electron-builder\.config\.cjs)$|Web\/(src|host|plugins|kit)\/)/.test(rel);
});

if (process.env.BOTLING_TEST_CHANGED_LIST) { // print the selection only (for test/unit/test-changed.test.ts)
  for (const path of sources) console.log(`  ${relative(root, path)}`);
  process.exit(0);
}

const step = (label, command, args) => {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { cwd: desktop, stdio: "inherit" });
  console.log(`  ${label}: ${result.status === 0 ? "ok" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result.status === 0;
};
const bin = (name) => join(desktop, "node_modules", ".bin", name);

console.log(`test:changed against ${base}: ${changed.length} changed file(s), ${sources.length} relevant to desktop/`);
let ok = step("typecheck", bin("tsc"), ["--noEmit", "-p", "tsconfig.json"]);

if (sources.length) {
  const unit = join(desktop, "test", "unit");
  const tests = readdirSync(unit).filter((name) => name.endsWith(".test.ts"));
  const texts = new Map(tests.map((name) => [name, readFileSync(join(unit, name), "utf8")]));
  const named = new Set();
  for (const path of sources) {
    if (path.startsWith(unit + "/")) { named.add(path); continue; }
    const stem = basename(path).replace(/\.(ts|tsx|mts|mjs|cjs|js)$/, "");
    if (stem === "main" || stem === "index" || stem.length < 3) continue; // too common to name a test after
    for (const name of tests) if (name === `${stem}.test.ts` || name.startsWith(`${stem}-`)) named.add(join(unit, name));
    for (const name of tests) if (texts.get(name).includes(basename(path))) named.add(join(unit, name));
  }
  ok = step("build out/", process.execPath, [join(desktop, "build.mjs")]) && ok;
  // `vitest related` takes source files and runs the tests that depend on them; a test file passed
  // in counts as its own dependent, so the name-matched tests ride along.
  const files = [...new Set([...sources, ...named])].map((path) => relative(desktop, path));
  ok = step(`unit tests related to ${files.length} file(s)`, bin("vitest"), ["related", "--run", "--passWithNoTests", "--exclude", "test/live/**", ...files]) && ok;
} else {
  console.log("\nNo changed desktop source or test files: nothing to unit test.");
}
console.log(ok ? "\ntest:changed passed." : "\ntest:changed FAILED.");
process.exit(ok ? 0 : 1);
