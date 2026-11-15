// Read-only check that a commit range only moves code (M7-S00).
//   node scripts/check-move.mjs <base>..<head> [--max-changed N] [--all] [--json] [--root <repo>] [-- <git pathspec>...]
//
// Compares the lines the range deletes with the lines it adds, over all product files (code and CSS, tests and docs
// not counted; --all counts every file):
//   moved-in   an added line that was deleted somewhere in the range (same text, indentation ignored)
//   moved-out  a deleted line that was added somewhere in the range
//   changed    deleted lines that were not moved (edited or dropped), plus added lines put inside a moved block (per hunk)
//   added      added lines that were not moved and replace no deleted line (per hunk): wrappers, bridge blocks, delegates
//   ignored    blank lines, import statements and `export ... from` re-exports, on both sides; never counted
// Lines move in runs: consecutive added lines equal to consecutive deleted lines of one hunk, in the same order. A line is
// matched once. So these are NOT moves and count as changed: a reordered run (two statements swapped, a statement moved
// out of its block), a run of fewer than 3 lines that moves inside its own file, and an added line between two lines that
// were next to each other in the base (an insertion or a doubled line inside moved code). A line with no letter or digit
// (`}`, `});`) counts as moved only beside a moved line it followed or preceded in the base.
// Exits 1 when the total of "changed" is above --max-changed (default 0: a card that edits moved code states how many
// lines it may change). "added" is reported, never gated: the reviewer reads those lines.
// Known limits, by design or cost: indentation is ignored, also inside a multi-line template literal; an import line may
// change to another module (the typecheck, not this check, catches a missing name); a reordered pair of whole blocks of 3
// lines or more that git shows as separate hunks reads as a move. Renames are read as a delete plus an add
// (--no-renames), which is what makes a moved file show as moved.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProductFile } from './check-lines.mjs';

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const IMPORT_START = /^import(?:\s|\{|\*|['"])/; // `import(` (a call) does not start a statement
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

/** A run of moved lines inside one file counts only from this many lines: a swapped or re-placed line stays "changed". */
const MIN_SAME_FILE_RUN = 3;

/**
 * `files` from parseDiff; `oldLines(path)` and `newLines(path)` give a file's lines at the base and at the head.
 * Returns { rows: [{ path, movedIn, movedOut, changed, added, ignored }], total }.
 *
 * Lines are matched in runs, not one by one: a run is consecutive added lines (blank and import lines left out) equal to
 * consecutive deleted lines of one deleted hunk, in the same order. A reordered run, a line moved inside its own file
 * (a run shorter than MIN_SAME_FILE_RUN) and a line put between two lines that were next to each other in the base are
 * not moves: they count as changed.
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
      const h = { row: r, oldPath: file.oldPath, newPath: file.newPath, del, add, inserted: 0 };
      del.forEach((d, i) => { d.hunk = h; d.i = i; });
      hunks.push(h);
    }
  }
  const byText = new Map(); // text -> deleted lines, in range order
  for (const h of hunks) for (const d of h.del) { const list = byText.get(d.text); if (list) list.push(d); else byText.set(d.text, [d]); }
  const link = (a, d) => { a.src = d; a.matched = true; d.matched = true; };
  const unlink = (a) => { a.src.matched = false; a.src = null; a.matched = false; };

  // 1. Runs that contain at least one line with a letter or digit; the longest candidate wins, one in order wins a tie.
  const runs = [];
  for (const h of hunks) {
    let last = null;
    for (let i = 0; i < h.add.length; i += 1) {
      const a = h.add[i];
      if (a.matched || trivial(a.text)) continue;
      let best = null;
      for (const d of byText.get(a.text) ?? []) {
        if (d.matched) continue;
        let len = 0;
        while (i + len < h.add.length && d.i + len < d.hunk.del.length) {
          const x = h.add[i + len], y = d.hunk.del[d.i + len];
          if (x.matched || y.matched || x.text !== y.text) break;
          len += 1;
        }
        if (d.hunk.oldPath === h.newPath && len < MIN_SAME_FILE_RUN) continue;
        const inOrder = last !== null && d.hunk === last.hunk && d.i >= last.end;
        if (!best || len > best.len || (len === best.len && inOrder && !best.inOrder)) best = { d, len, inOrder };
      }
      if (!best) continue;
      for (let t = 0; t < best.len; t += 1) link(h.add[i + t], best.d.hunk.del[best.d.i + t]);
      runs.push({ add: h, start: i, del: best.d.hunk, di: best.d.i, len: best.len });
      last = { hunk: best.d.hunk, end: best.d.i + best.len };
      i += best.len - 1;
    }
  }

  // 2. Within one pair of hunks the runs must keep their order; keep the heaviest ordered set, the others are not moves.
  const pairs = new Map();
  for (const run of runs) {
    let byDel = pairs.get(run.add);
    if (!byDel) pairs.set(run.add, (byDel = new Map()));
    const list = byDel.get(run.del);
    if (list) list.push(run); else byDel.set(run.del, [run]);
  }
  for (const byDel of pairs.values()) {
    for (const list of byDel.values()) {
      const best = list.map(() => 0);
      const from = list.map(() => -1);
      let top = -1;
      list.forEach((run, i) => {
        best[i] = run.len;
        for (let j = 0; j < i; j += 1) if (list[j].di + list[j].len <= run.di && best[j] + run.len > best[i]) { best[i] = best[j] + run.len; from[i] = j; }
        if (top < 0 || best[i] > best[top]) top = i;
      });
      const keep = new Set();
      for (let i = top; i >= 0; i = from[i]) keep.add(i);
      list.forEach((run, i) => {
        if (keep.has(i)) return;
        for (let t = 0; t < run.len; t += 1) unlink(run.add.add[run.start + t]);
      });
    }
  }

  // 3. A brace or other line with no letter or digit is moved only beside a moved line it followed or preceded in the base.
  for (let again = true; again;) {
    again = false;
    for (const h of hunks) {
      h.add.forEach((a, i) => {
        if (a.matched || !trivial(a.text)) return;
        const prev = h.add[i - 1], next = h.add[i + 1];
        const after = prev?.matched ? prev.src.hunk.del[prev.src.i + 1] : undefined;
        const before = next?.matched ? next.src.hunk.del[next.src.i - 1] : undefined;
        const d = after && !after.matched && after.text === a.text ? after : before && !before.matched && before.text === a.text ? before : null;
        if (d) { link(a, d); again = true; }
      });
    }
  }

  // 4. New lines between two lines that were next to each other in the base are an edit of the moved code, not a wrapper.
  for (const h of hunks) {
    for (let i = 1; i < h.add.length; i += 1) {
      if (h.add[i].matched || !h.add[i - 1].matched) continue;
      let j = i;
      while (j < h.add.length && !h.add[j].matched) j += 1;
      const before = h.add[i - 1].src, after = h.add[j]?.src;
      if (after && after.hunk === before.hunk && after.i === before.i + 1) h.inserted += j - i;
      i = j;
    }
  }

  for (const h of hunks) {
    const r = h.row;
    r.movedIn += h.add.filter((a) => a.matched).length;
    r.movedOut += h.del.filter((d) => d.matched).length;
    const unDel = h.del.filter((d) => !d.matched).length;
    const unAdd = h.add.filter((a) => !a.matched).length;
    r.changed += unDel + h.inserted;
    r.added += Math.max(0, unAdd - h.inserted - unDel);
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
