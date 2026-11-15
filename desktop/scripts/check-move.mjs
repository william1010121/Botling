// Read-only check that a commit range only moves code (M7-S00).
//   node scripts/check-move.mjs <base>..<head> [--max-changed N] [--all] [--json] [--root <repo>] [-- <git pathspec>...]
//
// Compares the lines the range deletes with the lines it adds, over all product files (code and CSS, tests and docs
// not counted; --all counts every file):
//   moved-in   an added line that was deleted somewhere in the range (same text, indentation ignored)
//   moved-out  a deleted line that was added somewhere in the range
//   changed    deleted lines that were not moved: edited or dropped (per hunk)
//   added      added lines that were not moved and replace no deleted line (per hunk)
//   ignored    blank lines, import statements and `export ... from` re-exports, on both sides; never counted
// A line is matched once: the same text deleted twice and added once moves once. A line with no letter or digit (`}`,
// `});`) counts as moved only next to a moved line, so a lone brace does not hide an edit. Exits 1 when the total of
// "changed" is above --max-changed (default 0: a card that edits moved code states how many lines it may change).
// Renames are read as a delete plus an add (--no-renames), which is what makes a moved file show as moved.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProductFile } from './check-lines.mjs';

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const IMPORT_START = /^import(?:\s|\{|\*|['"])(?!\s*\()/;
const EXPORT_FROM_START = /^export\s+(?:type\s+)?(?:\*|\{)/;
const STATEMENT_END = /(?:\bfrom\s*|^import\s*)(['"])[^'"]*\1\s*(?:with\s*\{[^}]*\}\s*)?;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;
const MAX_STATEMENT_LINES = 200;

/** Splits text into lines (a trailing newline does not make an extra line; CR is dropped). */
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.replace(/\r$/, ''));
}

/** For each line of a file: true when it is blank or part of an import or `export ... from` statement (code files only). */
export function ignoredFlags(lines, path) {
  const flags = lines.map((line) => line.trim() === '');
  if (!CODE_FILE.test(path)) return flags;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!IMPORT_START.test(text) && !EXPORT_FROM_START.test(text)) continue;
    const joined = [];
    for (let j = i; j < lines.length && j < i + MAX_STATEMENT_LINES; j += 1) {
      const part = lines[j].trim();
      joined.push(part);
      if (STATEMENT_END.test(part)) {
        for (let k = i; k <= j; k += 1) flags[k] = true;
        i = j;
        break;
      }
      if (/;\s*(?:\/\/.*)?$/.test(part)) break; // a statement that ends without a module specifier is no import
    }
  }
  return flags;
}

/** Parses `git diff -U0` text into [{ path, oldPath, newPath, binary, hunks: [{ del: [{n, text}], add: [{n, text}] }] }]. */
export function parseDiff(text) {
  const files = [];
  const lines = text.split('\n');
  let file = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      file = { path: '', oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(file);
      i += 1;
    } else if (!file) {
      i += 1;
    } else if (line.startsWith('--- ')) {
      file.oldPath = line === '--- /dev/null' ? null : line.slice(6);
      i += 1;
    } else if (line.startsWith('+++ ')) {
      file.newPath = line === '+++ /dev/null' ? null : line.slice(6);
      i += 1;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      i += 1;
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Error(`Cannot read hunk header: ${line}`);
      let oldN = Number(m[1]), oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newN = Number(m[3]), newLeft = m[4] === undefined ? 1 : Number(m[4]);
      const hunk = { del: [], add: [] };
      i += 1;
      while ((oldLeft > 0 || newLeft > 0) && i < lines.length) {
        const body = lines[i];
        if (body.startsWith('-')) { hunk.del.push({ n: oldN, text: body.slice(1) }); oldN += 1; oldLeft -= 1; }
        else if (body.startsWith('+')) { hunk.add.push({ n: newN, text: body.slice(1) }); newN += 1; newLeft -= 1; }
        else if (!body.startsWith('\\')) throw new Error(`Unexpected line in hunk: ${body}`);
        i += 1;
      }
      file.hunks.push(hunk);
    } else {
      i += 1;
    }
  }
  for (const f of files) f.path = f.newPath ?? f.oldPath ?? '';
  return files.filter((f) => f.path);
}

const norm = (text) => text.trim().replace(/\r$/, '');
const trivial = (text) => !/[\p{L}\p{N}]/u.test(text);

/**
 * `files` from parseDiff; `oldLines(path)` and `newLines(path)` give a file's lines at the base and at the head.
 * Returns { rows: [{ path, movedIn, movedOut, changed, added, ignored }], total }.
 */
export function analyze(files, oldLines, newLines) {
  const hunks = [];
  const rows = new Map();
  const row = (path) => {
    if (!rows.has(path)) rows.set(path, { path, movedIn: 0, movedOut: 0, changed: 0, added: 0, ignored: 0 });
    return rows.get(path);
  };
  for (const file of files) {
    if (file.binary) continue;
    const r = row(file.path);
    const oldFlags = file.oldPath ? ignoredFlags(oldLines(file.oldPath), file.oldPath) : [];
    const newFlags = file.newPath ? ignoredFlags(newLines(file.newPath), file.newPath) : [];
    for (const hunk of file.hunks) {
      const del = [], add = [];
      for (const d of hunk.del) { if (oldFlags[d.n - 1]) r.ignored += 1; else del.push({ text: norm(d.text), matched: false }); }
      for (const a of hunk.add) { if (newFlags[a.n - 1]) r.ignored += 1; else add.push({ text: norm(a.text), matched: false }); }
      hunks.push({ row: r, del, add });
    }
  }
  const pool = new Map(); // text -> deleted lines not yet matched
  for (const h of hunks) for (const d of h.del) pool.set(d.text, (pool.get(d.text) ?? 0) + 1);
  const take = (line) => {
    const left = pool.get(line.text) ?? 0;
    if (left === 0) return false;
    pool.set(line.text, left - 1);
    line.matched = true;
    return true;
  };
  for (const h of hunks) for (const a of h.add) if (!trivial(a.text)) take(a);
  for (let changedAny = true; changedAny;) { // a brace joins the move of the line next to it, which can free the next brace
    changedAny = false;
    for (const h of hunks) {
      h.add.forEach((a, idx) => {
        if (a.matched || !trivial(a.text)) return;
        if ((h.add[idx - 1]?.matched || h.add[idx + 1]?.matched) && take(a)) changedAny = true;
      });
    }
  }
  // Which deleted lines were used: for each text, as many as were taken, first come first.
  const takenCount = new Map();
  for (const h of hunks) for (const a of h.add) if (a.matched) takenCount.set(a.text, (takenCount.get(a.text) ?? 0) + 1);
  for (const h of hunks) {
    for (const d of h.del) {
      const left = takenCount.get(d.text) ?? 0;
      if (left > 0) { takenCount.set(d.text, left - 1); d.matched = true; }
    }
  }
  for (const h of hunks) {
    const r = h.row;
    r.movedIn += h.add.filter((a) => a.matched).length;
    r.movedOut += h.del.filter((d) => d.matched).length;
    const unDel = h.del.filter((d) => !d.matched).length;
    const unAdd = h.add.filter((a) => !a.matched).length;
    r.changed += unDel;
    r.added += Math.max(0, unAdd - unDel);
  }
  const list = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const total = { movedIn: 0, movedOut: 0, changed: 0, added: 0, ignored: 0 };
  for (const r of list) for (const key of Object.keys(total)) total[key] += r[key];
  return { rows: list, total };
}

const git = (root, args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');

function resolveCommit(root, rev) {
  if (!rev || rev.startsWith('-') || /\s/.test(rev)) throw new Error(`Not a revision: ${JSON.stringify(rev)}`);
  return git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
}

/** Runs the check on a repository: returns { base, head, rows, total, skipped }. */
export function checkMove(root, range, { all = false, pathspec = [] } = {}) {
  const m = /^([^.\s][^\s]*?)\.\.([^.\s][^\s]*)$/.exec(range);
  if (!m) throw new Error('Expected <base>..<head>');
  const base = resolveCommit(root, m[1]);
  const head = resolveCommit(root, m[2]);
  const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, head, '--', ...pathspec]);
  const parsed = parseDiff(diff);
  const files = all ? parsed : parsed.filter((f) => isProductFile(f.path));
  const cache = new Map();
  const lines = (rev, path) => {
    const key = `${rev}:${path}`;
    if (!cache.has(key)) {
      let text = '';
      try { text = git(root, ['show', `${rev}:${path}`]); } catch { /* the file is not in that revision */ }
      cache.set(key, splitLines(text));
    }
    return cache.get(key);
  };
  const result = analyze(files, (path) => lines(base, path), (path) => lines(head, path));
  return { base, head, ...result, skipped: parsed.length - files.length };
}

export function formatReport({ base, head, rows, total, skipped }, maxChanged) {
  const out = [`check-move: ${base.slice(0, 8)}..${head.slice(0, 8)} (product files${skipped ? `, ${skipped} other file${skipped === 1 ? '' : 's'} not counted` : ''})`];
  const cols = ['moved-in', 'moved-out', 'changed', 'added', 'ignored'];
  const width = Math.max(4, ...rows.map((r) => r.path.length));
  out.push(`${'file'.padEnd(width)}  ${cols.map((c) => c.padStart(9)).join(' ')}`);
  const cells = (r) => [r.movedIn, r.movedOut, r.changed, r.added, r.ignored].map((n) => String(n).padStart(9)).join(' ');
  for (const r of rows) out.push(`${r.path.padEnd(width)}  ${cells(r)}`);
  out.push(`${'total'.padEnd(width)}  ${cells(total)}`);
  out.push(total.changed > maxChanged ? `FAIL: ${total.changed} lines changed, the limit is ${maxChanged}` : `ok: ${total.changed} lines changed, the limit is ${maxChanged}`);
  return out.join('\n');
}

function main(argv) {
  const split = argv.indexOf('--');
  const args = split < 0 ? argv : argv.slice(0, split);
  const pathspec = split < 0 ? [] : argv.slice(split + 1);
  const value = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const valued = new Set(['--max-changed', '--root']);
  const range = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  if (range.length !== 1) throw new Error('Usage: check-move.mjs <base>..<head> [--max-changed N] [--all] [--json] [--root <repo>] [-- <pathspec>...]');
  const maxChanged = value('--max-changed') === undefined ? 0 : Number(value('--max-changed'));
  if (!Number.isInteger(maxChanged) || maxChanged < 0) throw new Error('--max-changed must be a whole number, 0 or more');
  const root = resolve(value('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const result = checkMove(root, range[0], { all: args.includes('--all'), pathspec });
  const failed = result.total.changed > maxChanged;
  console.log(args.includes('--json') ? JSON.stringify({ ...result, maxChanged, ok: !failed }, null, 2) : formatReport(result, maxChanged));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`check-move: ${error.message}`); process.exitCode = 2; }
}
