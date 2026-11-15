#!/usr/bin/env node
// where.mjs: "where is this symbol" for workers, one call instead of a chain of greps.
//
//   node desktop/scripts/where.mjs <name>                 where <name> is defined and who references it
//   node desktop/scripts/where.mjs <name> --json          the same as JSON
//   node desktop/scripts/where.mjs --exports <file>       the exports of one file
//   node desktop/scripts/where.mjs <name> --root <dir>    scan <dir> instead of the whole checkout
//
// Read only: it never writes a file, never runs the build and starts no process. TypeScript and TSX are parsed
// with the compiler API in desktop/node_modules (syntax only, no type check, no language server). A reference is an
// identifier with the same name, so it is by name, not resolved by type: a common name lists unrelated uses.
// Plain .js / .mjs / .cjs files (the Note plugin's ui.js) are searched by whole word for a definition pattern.
// Exit codes: 0 found, 1 not found (with up to five close names), 2 bad arguments or file, 3 typescript missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");
const REF_CAP = 40; // references listed; the rest is only counted
const DEF_CAP = 25; // definitions listed (a name like `id` is declared in hundreds of places)
const MAX_FILE_BYTES = 2 * 1024 * 1024; // bigger files are generated bundles
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "coverage", "release"]);
const IDENT = /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*$/u;

class Usage extends Error {}

const HELP = `where.mjs: where is this symbol defined and used (read only, no build).

  node desktop/scripts/where.mjs <name>               definitions (file:line, kind, signature) and up to ${REF_CAP} references
  node desktop/scripts/where.mjs <Class.member>       the same for "member", definitions inside Class first
  node desktop/scripts/where.mjs --exports <file>     the exports of one file
  options: --json (JSON output)   --root <dir> (scan only <dir>; default: the whole checkout, every .ts .tsx .js .mjs)

TypeScript is parsed with the compiler API (syntax only). References are identifiers with the same name (not resolved
by type), listed non-test files first. Plain .js files are searched by whole word for a definition pattern.
Exit: 0 found, 1 not found (prints up to five close names), 2 bad arguments, 3 typescript missing.`;

// Text that comes from a file or a path reaches the terminal as one clean line: control characters are escaped.
function clean(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, (c) =>
    c.charCodeAt(0) <= 0xff ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u${c.charCodeAt(0).toString(16)}`);
}
function squash(s, cap = 160) {
  const t = clean(s.replace(/\s+/g, " ").trim());
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}
const posix = (p) => p.split(path.sep).join("/");
const isTestPath = (rel) => /(^|\/)(test|tests|e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
const escapeRe = (s) => s.replace(/[$\\^.*+?()[\]{}|/-]/g, "\\$&");

function parseArgs(argv) {
  const o = { name: null, json: false, exportsFile: null, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--exports" || a === "--root") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Usage(`${a} needs a value`);
      if (a === "--exports") o.exportsFile = v; else o.root = v;
    } else if (a.startsWith("-")) throw new Usage(`unknown option ${clean(a)}`);
    else if (o.name === null) o.name = a;
    else throw new Usage("one name only");
  }
  if (o.help) return o;
  if (o.name === null && o.exportsFile === null) throw new Usage("give a name, or --exports <file>");
  if (o.name !== null && o.exportsFile !== null) throw new Usage("give a name or --exports <file>, not both");
  return o;
}

// ---- files -----------------------------------------------------------------------------------------------------

// Every source file under root, sorted by path. Symlinks are never followed; dot folders, node_modules and build
// output are skipped; files over MAX_FILE_BYTES are skipped.
function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // a Dirent from readdir is lstat-based: a symlink is neither isDirectory() nor isFile(), so no link is followed
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!TS_EXT.has(ext) && !JS_EXT.has(ext)) continue;
        if (/\.min\.[cm]?js$/.test(e.name)) continue;
        try { if (fs.lstatSync(full).size > MAX_FILE_BYTES) continue; } catch { continue; }
        out.push({ full, rel: posix(path.relative(root, full)), ts: TS_EXT.has(ext), tsx: ext === ".tsx" });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function readText(full) {
  try { return fs.readFileSync(full, "utf8"); } catch { return null; }
}

// ---- TypeScript ------------------------------------------------------------------------------------------------

function parseTs(ts, file, text) {
  return ts.createSourceFile(file.full, text, ts.ScriptTarget.Latest, true, file.tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function isTopLevelVar(ts, node) {
  const list = node.parent;
  const stmt = list && list.parent;
  return !!stmt && ts.isVariableDeclarationList(list) && ts.isVariableStatement(stmt)
    && (ts.isSourceFile(stmt.parent) || ts.isModuleBlock(stmt.parent));
}

// What a node declares, cheaply: { kind, nameNode } or null. Locals of a function are not declarations here
// (a `const i` inside a body would drown the answers); local named functions and classes are.
function declHead(ts, node) {
  let kind = null;
  if (ts.isFunctionDeclaration(node)) kind = "function";
  else if (ts.isClassDeclaration(node)) kind = "class";
  else if (ts.isInterfaceDeclaration(node)) kind = "interface";
  else if (ts.isTypeAliasDeclaration(node)) kind = "type";
  else if (ts.isEnumDeclaration(node)) kind = "enum";
  else if (ts.isModuleDeclaration(node)) kind = "namespace";
  else if (ts.isEnumMember(node)) kind = "enum member";
  else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) kind = "method";
  else if (ts.isPropertyDeclaration(node)) kind = "property";
  else if (ts.isPropertySignature(node) && ts.isInterfaceDeclaration(node.parent)) kind = "property";
  else if (ts.isGetAccessorDeclaration(node)) kind = "getter";
  else if (ts.isSetAccessorDeclaration(node)) kind = "setter";
  else if (ts.isVariableDeclaration(node) && isTopLevelVar(ts, node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) kind = "function";
    else kind = node.parent.flags & ts.NodeFlags.Const ? "const" : node.parent.flags & ts.NodeFlags.Let ? "let" : "var";
  } else return null;
  const n = node.name;
  if (!n || !ts.isIdentifier(n)) return null;
  return { kind, nameNode: n };
}

function isExported(ts, node) {
  try { return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0; } catch { return false; }
}

// One line: the declaration up to its body (a class up to its `{`), whitespace squashed, capped.
function signatureOf(ts, sf, node, head) {
  const start = node.getStart(sf);
  let end = node.end;
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) end = node.members.pos - 1;
  else if (ts.isModuleDeclaration(node) && node.body) end = node.body.getStart(sf);
  else if (node.body && !ts.isModuleDeclaration(node)) end = node.body.getStart(sf);
  let prefix = "";
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) end = init.body.getStart(sf);
    prefix = `${isExported(ts, node) ? "export " : ""}${node.parent.flags & ts.NodeFlags.Const ? "const" : node.parent.flags & ts.NodeFlags.Let ? "let" : "var"} `;
  }
  return squash(prefix + sf.text.slice(start, Math.max(start, end)));
}

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

// Declarations named `name` (or every declaration when name is null) and, with name, every identifier spelled `name`.
function scanTs(ts, sf, name, wantRefs) {
  const defs = [];
  const idents = [];
  const lineStarts = sf.getLineStarts();
  const lineText = (line) => sf.text.slice(lineStarts[line - 1], lineStarts[line] ?? sf.text.length);
  const visit = (node, container) => {
    const head = declHead(ts, node);
    if (head && (name === null || head.nameNode.text === name)) {
      defs.push({
        name: head.nameNode.text, kind: head.kind, line: lineOf(sf, head.nameNode.getStart(sf)), pos: head.nameNode.getStart(sf),
        exported: ["function", "class", "interface", "type", "enum", "namespace", "const", "let", "var"].includes(head.kind) && isExported(ts, node),
        container: container ?? undefined,
        signature: name === null ? "" : signatureOf(ts, sf, node, head),
      });
    }
    if (wantRefs && ts.isIdentifier(node) && node.text === name) idents.push(node.getStart(sf));
    let next = container;
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
      && node.name && ts.isIdentifier(node.name)) next = node.name.text;
    ts.forEachChild(node, (c) => visit(c, next));
  };
  visit(sf, null);
  const defPos = new Set(defs.map((d) => d.pos));
  const refs = [];
  const seen = new Set();
  for (const pos of idents) {
    if (defPos.has(pos)) continue;
    const line = lineOf(sf, pos);
    if (seen.has(line)) continue;
    seen.add(line);
    refs.push({ line, text: squash(lineText(line), 100) });
  }
  return { defs, refs };
}

// ---- plain JavaScript --------------------------------------------------------------------------------------------

function jsDefinitionPatterns(name) {
  const n = escapeRe(name);
  return [
    [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}(?![\\w$])`), "function"],
    [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?class\\s+${n}(?![\\w$])`), "class"],
    [new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}(?![\\w$])\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`), "function"],
    [new RegExp(`^\\s*(?:export\\s+)?(const|let|var)\\s+${n}(?![\\w$])`), null],
    [new RegExp(`^\\s*(?:(?:static|async|get|set)\\s+)*\\*?\\s*${n}\\s*\\(.*\\)\\s*\\{`), "method"],
    [new RegExp(`^\\s*${n}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`), "function"],
    [new RegExp(`(?:^|[^\\w$])\\.${n}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`), "function"],
  ];
}

function scanJs(text, name) {
  const defs = [];
  const refs = [];
  const word = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);
  const pats = jsDefinitionPatterns(name);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!word.test(line)) continue;
    let hit = null;
    for (const [re, kind] of pats) {
      const m = re.exec(line);
      if (m) { hit = kind ?? m[1]; break; }
    }
    if (hit) defs.push({ name, kind: hit, line: i + 1, exported: /^\s*export\b/.test(line), signature: squash(line) });
    else refs.push({ line: i + 1, text: squash(line, 100) });
  }
  return { defs, refs };
}

function declaredNamesJs(text) {
  const out = [];
  for (const m of text.matchAll(/(?:function\s*\*?|class|const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/gu)) out.push(m[1]);
  return out;
}

// ---- close names ---------------------------------------------------------------------------------------------

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function closeNames(name, candidates) {
  const lower = name.toLowerCase();
  const maxD = Math.max(2, Math.floor(name.length / 3));
  const scored = [];
  for (const c of new Set(candidates)) {
    if (c === name) continue;
    const lc = c.toLowerCase();
    let score = null;
    if (lc === lower) score = 0;
    else if (lc.startsWith(lower) || (lc.length >= 4 && lower.startsWith(lc))) score = 1 + Math.abs(lc.length - lower.length) / 100;
    else if (lc.includes(lower) || (lc.length >= 4 && lower.includes(lc))) score = 2 + Math.abs(lc.length - lower.length) / 100;
    else {
      const d = levenshtein(lc, lower, maxD);
      if (d <= maxD) score = 3 + d;
    }
    if (score !== null) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.slice(0, 5).map((s) => s[1]);
}

// ---- exports of one file ---------------------------------------------------------------------------------------

function bindingNames(ts, name, out) {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(ts, el.name, out);
}

function exportsTs(ts, sf) {
  const out = [];
  const add = (name, kind, pos, signature, isDefault = false) => out.push({ name, kind, line: lineOf(sf, pos), signature, ...(isDefault ? { default: true } : {}) });
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      const sig = squash(st.getText(sf));
      if (!st.exportClause) add("*", "re-export", st.getStart(sf), sig);
      else if (ts.isNamespaceExport(st.exportClause)) add(st.exportClause.name.text, "re-export", st.getStart(sf), sig);
      else for (const sp of st.exportClause.elements) add(sp.name.text, st.moduleSpecifier ? "re-export" : "export", sp.getStart(sf), sig);
    } else if (ts.isExportAssignment(st)) {
      add(st.isExportEquals ? "export=" : "default", "default", st.getStart(sf), squash(st.getText(sf)), !st.isExportEquals);
    } else if (ts.canHaveModifiers(st) && (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export)) {
      const isDefault = (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Default) !== 0;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const names = [];
          bindingNames(ts, d.name, names);
          for (const n of names) {
            const head = ts.isIdentifier(d.name) ? declHead(ts, d) : null;
            add(n.text, head ? head.kind : "const", n.getStart(sf), ts.isIdentifier(d.name) ? signatureOf(ts, sf, d, head) : squash(st.getText(sf)));
          }
        }
      } else {
        const head = declHead(ts, st);
        const name = head ? head.nameNode.text : st.name && ts.isIdentifier(st.name) ? st.name.text : "default";
        add(name, head ? head.kind : "declaration", head ? head.nameNode.getStart(sf) : st.getStart(sf), head ? signatureOf(ts, sf, st, head) : squash(st.getText(sf)), isDefault);
      }
    }
  }
  return out;
}

function exportsJs(text) {
  const out = [];
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  for (const m of text.matchAll(/^[ \t]*export\s+(default\s+)?(?:async\s+)?(function\s*\*?|class|const|let|var)\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)?/gmu)) {
    const kind = m[2].startsWith("function") ? "function" : m[2];
    out.push({ name: m[3] ?? "default", kind, line: lineAt(m.index), signature: squash(text.slice(m.index, text.indexOf("\n", m.index) === -1 ? undefined : text.indexOf("\n", m.index))), ...(m[1] ? { default: true } : {}) });
  }
  for (const m of text.matchAll(/^[ \t]*export\s*\{([^}]*)\}(?:\s*from\s*["'][^"']*["'])?/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split(/\s+as\s+/).pop();
      if (t) out.push({ name: t, kind: m[0].includes("from") ? "re-export" : "export", line: lineAt(m.index), signature: squash(m[0]) });
    }
  }
  for (const m of text.matchAll(/^[ \t]*export\s+default\s+(?!(?:async\s+)?(?:function|class)\b)/gm)) {
    out.push({ name: "default", kind: "default", line: lineAt(m.index), signature: squash(text.slice(m.index, m.index + 120)), default: true });
  }
  for (const m of text.matchAll(/^[ \t]*(?:module\.)?exports\.([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*=/gmu)) {
    out.push({ name: m[1], kind: "export", line: lineAt(m.index), signature: squash(m[0]) });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---- commands --------------------------------------------------------------------------------------------------

async function loadTs() {
  try { return (await import("typescript")).default; } catch {
    process.stderr.write("where.mjs: the typescript package is not installed here (desktop/node_modules). Run desktop/scripts/link-deps.sh once in this worktree.\n");
    process.exit(3);
  }
}

function emit(o, text) {
  process.stdout.write(o.json ? `${JSON.stringify(text.json)}\n` : `${text.lines.join("\n")}\n`);
}

async function runExports(o, root) {
  const ts = await loadTs();
  let full = path.resolve(process.cwd(), o.exportsFile);
  if (!fs.existsSync(full)) full = path.resolve(root, o.exportsFile);
  let st;
  try { st = fs.statSync(full); } catch { throw new Usage(`no such file: ${clean(o.exportsFile)}`); }
  if (!st.isFile()) throw new Usage(`not a file: ${clean(o.exportsFile)}`);
  if (st.size > MAX_FILE_BYTES) throw new Usage(`file too large: ${clean(o.exportsFile)}`);
  const ext = path.extname(full);
  if (!TS_EXT.has(ext) && !JS_EXT.has(ext)) throw new Usage(`not a TypeScript or JavaScript file: ${clean(o.exportsFile)}`);
  const text = readText(full);
  if (text === null) throw new Usage(`cannot read: ${clean(o.exportsFile)}`);
  const rel = posix(path.relative(root, full));
  const shown = clean(rel.startsWith("..") ? full : rel);
  const list = TS_EXT.has(ext) ? exportsTs(ts, parseTs(ts, { full, tsx: ext === ".tsx" }, text)) : exportsJs(text);
  emit(o, {
    json: { file: shown, exports: list },
    lines: [`${shown}: ${list.length} export${list.length === 1 ? "" : "s"}`, ...list.map((e) => `  :${e.line}  ${e.kind}  ${clean(e.name)}${e.default ? " (default)" : ""}  ${e.signature}`)],
  });
  return 0;
}

async function runWhere(o, root) {
  const started = process.hrtime.bigint();
  let member = o.name;
  let owner = null;
  if (o.name.includes(".")) {
    const parts = o.name.split(".");
    member = parts.pop();
    owner = parts.pop() ?? null;
  }
  if (!IDENT.test(member) || (owner !== null && !IDENT.test(owner)) || member.length > 120) throw new Usage(`"${clean(o.name.slice(0, 60))}" is not an identifier (a name, or Class.member)`);
  const files = listFiles(root);
  const needsTs = files.some((f) => f.ts);
  const ts = needsTs ? await loadTs() : null;

  const defs = [];
  const refs = [];
  const unreadable = [];
  for (const f of files) {
    const text = readText(f.full);
    if (text === null) { unreadable.push(f.rel); continue; }
    if (!text.includes(member)) continue;
    const r = f.ts ? scanTs(ts, parseTs(ts, f, text), member, true) : scanJs(text, member);
    const test = isTestPath(f.rel);
    for (const d of r.defs) defs.push({ file: clean(f.rel), line: d.line, kind: d.kind, signature: d.signature, exported: d.exported, ...(d.container ? { container: d.container } : {}), test });
    for (const x of r.refs) refs.push({ file: clean(f.rel), line: x.line, text: x.text, test });
  }
  // files come sorted by path; non-test code first, the owner's own members first when Class.member was asked
  const rank = (d) => (owner && d.container === owner ? 0 : 1) * 2 + (d.test ? 1 : 0);
  defs.sort((a, b) => rank(a) - rank(b));
  refs.sort((a, b) => Number(a.test) - Number(b.test));
  const strip = ({ test, ...rest }) => rest;
  const scannedFiles = files.length;
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  if (defs.length === 0 && refs.length === 0) {
    const names = [];
    for (const f of files) {
      const text = readText(f.full);
      if (text === null) continue;
      if (f.ts) for (const d of scanTs(ts, parseTs(ts, f, text), null, false).defs) names.push(d.name);
      else names.push(...declaredNamesJs(text));
    }
    const close = closeNames(member, names);
    emit(o, {
      json: { name: o.name, found: false, closeNames: close, scannedFiles },
      lines: [`not found: ${clean(o.name)} (scanned ${scannedFiles} files)`, ...(close.length ? [`close names: ${close.map(clean).join(", ")}`] : [])],
    });
    return 1;
  }

  const shownDefs = defs.slice(0, DEF_CAP).map(strip);
  const shownRefs = refs.slice(0, REF_CAP).map(strip);
  const lines = [`${clean(o.name)}: ${defs.length} definition${defs.length === 1 ? "" : "s"}, ${refs.length} reference line${refs.length === 1 ? "" : "s"} (by name, not resolved by type)`];
  if (defs.length === 0) lines.push("Definitions: none in the scanned files (an import from a package, or declared outside the scan)");
  else {
    lines.push("Definitions:");
    for (const d of shownDefs) lines.push(`  ${d.file}:${d.line}  ${d.kind}${d.container ? ` of ${clean(d.container)}` : ""}  ${d.signature}`);
    if (defs.length > DEF_CAP) lines.push(`  ... and ${defs.length - DEF_CAP} more definitions not shown`);
  }
  if (refs.length > 0) {
    lines.push(refs.length > REF_CAP ? `References (first ${REF_CAP} of ${refs.length}):` : "References:");
    for (const r of shownRefs) lines.push(`  ${r.file}:${r.line}  ${r.text}`);
    if (refs.length > REF_CAP) lines.push(`  ... and ${refs.length - REF_CAP} more not shown`);
  }
  lines.push(`(scanned ${scannedFiles} files in ${seconds.toFixed(2)} s)`);
  emit(o, {
    json: {
      name: o.name, found: true,
      definitions: shownDefs, definitionsOmitted: Math.max(0, defs.length - DEF_CAP),
      references: { total: refs.length, omitted: Math.max(0, refs.length - REF_CAP), items: shownRefs },
      scannedFiles,
    },
    lines,
  });
  return 0;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.help) { process.stdout.write(`${HELP}\n`); return 0; }
    let root = DEFAULT_ROOT;
    if (o.root !== null) {
      root = path.resolve(process.cwd(), o.root);
      let st = null;
      try { st = fs.statSync(root); } catch { /* reported below */ }
      if (!st || !st.isDirectory()) throw new Usage(`--root is not a folder: ${clean(o.root)}`);
    }
    return o.exportsFile !== null ? await runExports(o, root) : await runWhere(o, root);
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`where.mjs: ${e.message}\n(node desktop/scripts/where.mjs --help)\n`);
      return 2;
    }
    throw e;
  }
}

process.exitCode = await main();
