// Read-only size gate for product code (M7-S00).
//   node scripts/check-lines.mjs [--root <repo>] [--baseline <file>] [--limit 800]
//
// A product file (code or CSS, tests and docs not counted) must have at most LIMIT lines. The files that are over
// today are listed in scripts/line-baseline.json with the size they had; a listed file fails when it grows past its
// number, an unlisted file fails when it is over the limit. A listed file that is at or under the limit, or gone,
// fails too: the card that gets it there removes its entry (the last card of a file removes it). Every other card
// ends by lowering its own entry; a file smaller than its entry is reported as a note and does not fail.
// A file may also be frozen (line-baseline.json `frozen`: path -> reason). It is never split: it fails when it grows
// past its recorded size (the message names the reason), passes when it shrinks, and its entry may not be removed.
// Lines are counted like `wc -l` (a last line without a newline counts too). Tracked files and untracked files that
// git does not ignore are looked at, from the working tree.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIMIT = 800;
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css)$/;
const NOT_PRODUCT_DIR = /(?:^|\/)(?:test|tests|__tests__|fixtures|spec|specs|docs|node_modules|out|dist|\.bot|\.cache)\//;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;

/** True for code and CSS that is not a test, a fixture, a spec or a doc. `path` is repo-relative with `/`. */
export function isProductFile(path) {
  return CODE_EXT.test(path) && !NOT_PRODUCT_DIR.test(path) && !TEST_FILE.test(path);
}

/** Lines of a Buffer or string as `wc -l` counts them, plus a last line that has no newline. */
export function countLines(content) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const byte of bytes) if (byte === 0x0a) n += 1;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/**
 * `sizes` is a Map from repo-relative product path to line count (only existing files), `baseline` the `files` object
 * of line-baseline.json, `frozen` its `frozen` object (path -> reason). Returns { errors, notes } (errors fail the check).
 */
export function checkSizes(sizes, baseline, limit = LIMIT, frozen = {}) {
  const errors = [];
  const notes = [];
  for (const [path, lines] of [...sizes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const recorded = Object.hasOwn(baseline, path) ? baseline[path] : undefined;
    const reason = Object.hasOwn(frozen, path) ? frozen[path] : undefined;
    if (reason !== undefined) {
      if (recorded === undefined) errors.push(`${path}: frozen (${reason}) but its entry is gone from the baseline; put it back, no card removes it`);
      else if (lines > recorded) errors.push(`${path}: frozen (${reason}); grew to ${lines} lines, its baseline is ${recorded}`);
      else if (lines < recorded) notes.push(`${path}: frozen (${reason}); ${lines} lines, baseline says ${recorded}; the entry is not lowered`);
      else notes.push(`${path}: frozen (${reason}); ${lines} lines`);
      continue;
    }
    if (recorded === undefined) {
      if (lines > limit) errors.push(`${path}: ${lines} lines is over ${limit} and the file is not in the baseline (split it; do not add it to line-baseline.json)`);
    } else if (lines > recorded) {
      errors.push(`${path}: grew to ${lines} lines, its baseline is ${recorded}`);
    } else if (lines <= limit) {
      errors.push(`${path}: ${lines} lines is at or under ${limit}; remove its entry from line-baseline.json`);
    } else if (lines < recorded) {
      notes.push(`${path}: ${lines} lines, baseline says ${recorded}; lower the entry to ${lines}`);
    }
  }
  for (const path of Object.keys(baseline).sort()) {
    if (!sizes.has(path)) errors.push(`${path}: in the baseline but not a product file that exists; remove its entry from line-baseline.json`);
  }
  return { errors, notes };
}

/** Product files of a checkout with their line counts: tracked and untracked-not-ignored, as the working tree has them. */
export function productSizes(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 256 * 1024 * 1024 });
  const sizes = new Map();
  for (const path of out.toString('utf8').split('\0')) {
    if (!path || !isProductFile(path)) continue;
    const file = resolve(root, path);
    if (!existsSync(file)) continue; // tracked but deleted in the working tree
    sizes.set(path, countLines(readFileSync(file)));
  }
  return sizes;
}

const BRIDGE_DIR = /^desktop\/src\/core\/bot\/[^/]+\.ts$/;
const SET_ACCESSOR = /^\s*(?:(?:private|public|protected)\s+)?set\s+[A-Za-z_$][\w$]*\s*\(/;

/**
 * The `set` accessors in the collaborators under desktop/src/core/bot/ (M7-S59). A bridge block forwards a field to its owner;
 * a write through the bridge is a foreign write, so the owner gives it a named transition instead and no setter is left.
 * `files` is a Map from repo-relative path to text. Returns "path:line: text" for each accessor found.
 */
export function bridgeSetters(files) {
  const found = [];
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!BRIDGE_DIR.test(path)) continue;
    text.split('\n').forEach((line, i) => { if (SET_ACCESSOR.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`); });
  }
  return found;
}

function main(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(value('--root') ?? resolve(here, '..', '..'));
  const baselineFile = resolve(value('--baseline') ?? resolve(here, 'line-baseline.json'));
  const limit = value('--limit') === undefined ? LIMIT : Number(value('--limit'));
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).files ?? {};
  const sizes = productSizes(root);
  const frozen = JSON.parse(readFileSync(baselineFile, 'utf8')).frozen ?? {};
  const { errors, notes } = checkSizes(sizes, baseline, limit, frozen);
  const sources = new Map();
  for (const path of sizes.keys()) if (BRIDGE_DIR.test(path)) sources.set(path, readFileSync(resolve(root, path), 'utf8'));
  for (const found of bridgeSetters(sources)) errors.push(`${found}: a set accessor in a bridge block; give the owner a named transition`);
  const over = [...sizes].filter(([, lines]) => lines > limit).sort(([, a], [, b]) => b - a);
  console.log(`check-lines: ${sizes.size} product files, ${over.length} over ${limit} lines, ${Object.keys(baseline).length} in the baseline`);
  for (const [path, lines] of over) console.log(`  ${String(lines).padStart(6)}  ${path}`);
  for (const note of notes) console.log(`note: ${note}`);
  for (const error of errors) console.error(`FAIL: ${error}`);
  if (errors.length) {
    console.error(`check-lines: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    process.exitCode = 1;
  } else console.log('check-lines: ok');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`check-lines: ${error.message}`); process.exitCode = 2; }
}
