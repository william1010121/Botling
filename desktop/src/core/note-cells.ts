// How a note.md is cut into cells, branches and routes: the one copy of the rules the Note tab (botling.note's
// cells.js / branch.js / classify in ui.js, cardsrc.js, table.js) and the app (note.db, the app_note_* tools) both follow.
// It has no imports and touches nothing but its arguments, so a plugin's bundler can take it as it is.
//
// - A cell is a whole chunk of Markdown, cut by a line on its own: `<!-- cell -->`, or `<!-- cell: <id> -->` (the app's
//   export: the id note.db gives that cell, never changed). Branch, route and end-branch lines also bound cells.
// - A card (`<show name="…">JSON</show>`, on its own lines) is a cell of its own even where no cell line sets it apart
//   (a "soft" cut, no line in the file); blank lines next to it go with it.
// - `<!-- branch: name -->` opens a fork, `<!-- route: name -->` starts a route of the innermost open fork,
//   `<!-- end branch -->` closes it. Lines between a branch and its first route are an unnamed first route ("主線").
//   A fork without end branch runs to the end of the file. A route / end branch outside any fork is text.
// - Anything inside a ``` fence, a $$ block or a card is text: no marker there.

export const CELL_LINE = "<!-- cell -->";
const CELL_RE = /^\s*<!--\s*cell(?:\s*:\s*([A-Za-z0-9_-]{1,32}))?\s*-->\s*$/i;
/** A cell line, with or without an id. */
export const isCellLine = (line: string | undefined): boolean => CELL_RE.test(line ?? "");
/** The id a cell line carries (`<!-- cell: b7k3f9 -->`), or null. */
export const cellLineId = (line: string | undefined): string | null => CELL_RE.exec(line ?? "")?.[1] ?? null;
export const cellIdLine = (id: string): string => `<!-- cell: ${id} -->`;

const blank = (line: string | undefined) => !String(line ?? "").trim();

// ---- cards (cardsrc.js) ----

const SHOW = /^\s*<show((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(?:\/>|>\s*([\s\S]*?)\s*<\/show>)[ \t]*$/;
const ATTR = /([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CARD_MAX_LINES = 400;

export function showAttributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of String(text ?? "").matchAll(ATTR)) {
    found[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  return found;
}

/** refresh="10m" in seconds (1 s to 1 h); null: none or not readable. */
export function cardRefreshSeconds(text: string | undefined): number | null {
  let value = String(text ?? "").replace(/^[` ]+|[` ]+$/g, "").toLowerCase();
  if (value.startsWith("every ")) value = value.slice(6).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = ["", "s", "sec", "secs", "second", "seconds"].includes(m[2]!) ? 1
    : ["ms", "millisecond", "milliseconds"].includes(m[2]!) ? 0.001
    : ["m", "min", "mins", "minute", "minutes"].includes(m[2]!) ? 60 : null;
  if (unit === null) return null;
  const s = n * unit;
  return s > 3600 ? null : Math.max(s, 1);
}

export interface CardAt { end: number; name: string; command: string | null; refresh: number | null; body: string; attrs: Record<string, string> }

/** Does a card start at line i (its tag opening the line, closing at the end of this or a later line)? */
export function cardAt(lines: readonly string[], i: number): CardAt | null {
  const first = lines[i];
  if (typeof first !== "string" || !/^\s*<show[\s/>]/.test(first)) return null;
  let joined = "";
  const last = Math.min(lines.length, i + CARD_MAX_LINES);
  for (let end = i; end < last; end++) {
    const line = lines[end]!;
    if (end > i && (/^\s*```/.test(line) || /^\s*<show[\s/>]/.test(line))) return null;
    joined += (end > i ? "\n" : "") + line;
    if (!/<\/show>[ \t]*$|\/>[ \t]*$/.test(line)) continue;
    const m = SHOW.exec(joined);
    if (!m) continue;
    const attrs = showAttributes(m[1] ?? "");
    const name = attrs.name?.trim() ?? "";
    if (!name) return null;
    const body = m[2] ?? "";
    if (body) {
      try { JSON.parse(body); } catch { return null; }
    }
    return { end, name, command: attrs.command?.trim() || null, refresh: attrs.refresh !== undefined ? cardRefreshSeconds(attrs.refresh) : null, body, attrs };
  }
  return null;
}

// ---- tables (table.js) ----

const DELIM_CELL = /^:?-+:?$/;

export function splitRow(line: string): string[] {
  let s = String(line ?? "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") { cur += "\\|"; k++; }
    else if (ch === "|") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export const isRowLine = (line: string | undefined): boolean => {
  const l = String(line ?? "");
  return l.includes("|") && !!l.trim() && !/^\s*<!--/.test(l) && !/^\s*```/.test(l) && !/^\s*\$\$/.test(l) && !/^ {4,}/.test(l);
};

export function isDelimLine(line: string | undefined): boolean {
  const l = String(line ?? "");
  if (!l.includes("|")) return false;
  const cells = splitRow(l);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

/** Does a table start at line i? Its last line, or -1. */
export function tableAt(lines: readonly string[], i: number): number {
  if (!isRowLine(lines[i]) || i + 1 >= lines.length || !isDelimLine(lines[i + 1])) return -1;
  if (splitRow(lines[i]!).length !== splitRow(lines[i + 1]!).length) return -1;
  let end = i + 1;
  while (end + 1 < lines.length && isRowLine(lines[end + 1])) end++;
  return end;
}

// ---- what each line is (ui.js classify) ----

export type LineInfo =
  | { kind: "text" }
  | { kind: "fence" | "code"; start: number; end: number; lang: string; empty: boolean; open: boolean }
  | { kind: "card"; start: number; end: number; card: CardAt }
  | { kind: "table"; start: number; end: number }
  | { kind: "mathb"; start: number; end: number };

export function classifyLines(lines: readonly string[]): LineInfo[] {
  const info: LineInfo[] = lines.map(() => ({ kind: "text" }));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      let end = i + 1;
      while (end < lines.length && !/^\s*```/.test(lines[end]!)) end++;
      const closed = end < lines.length;
      if (!closed) end = lines.length - 1;
      const lang = line.trim().replace(/^```\s*/, "");
      const empty = lines.slice(i + 1, closed ? end : end + 1).every((l) => !l.trim());
      for (let k = i; k <= end; k++) info[k] = { kind: k === i || (closed && k === end) ? "fence" : "code", start: i, end, lang, empty, open: k === i };
      i = end + 1;
      continue;
    }
    const card = cardAt(lines, i);
    if (card) {
      for (let k = i; k <= card.end; k++) info[k] = { kind: "card", start: i, end: card.end, card };
      i = card.end + 1;
      continue;
    }
    const tEnd = tableAt(lines, i);
    if (tEnd > i) {
      for (let k = i; k <= tEnd; k++) info[k] = { kind: "table", start: i, end: tEnd };
      i = tEnd + 1;
      continue;
    }
    const t = line.trim();
    if (t.startsWith("$$") && !t.slice(2).includes("$$")) {
      let end = i + 1;
      while (end < lines.length && !lines[end]!.includes("$$") && !/^\s*```/.test(lines[end]!)) end++;
      if (end < lines.length && lines[end]!.includes("$$")) {
        for (let k = i; k <= end; k++) info[k] = { kind: "mathb", start: i, end };
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return info;
}

// ---- branches (branch.js) ----

const MARKER = /^\s*<!--\s*(end[\s_-]*branch|branch|route)\s*(?::\s*([\s\S]*?))?\s*-->\s*$/i;
export const cleanName = (s: string | undefined): string => String(s ?? "").replace(/\s+/g, " ").replace(/-->/g, "→").replace(/<!--/g, "‹!--").trim();
export const DEFAULT_FORK = "分支";
export const IMPLICIT_ROUTE = "主線";
export const branchLine = (name: string): string => `<!-- branch: ${cleanName(name) || DEFAULT_FORK} -->`;
export const routeLine = (name: string): string => `<!-- route: ${cleanName(name) || "路線"} -->`;
export const END_LINE = "<!-- end branch -->";

export interface BranchRoute { name: string; marker: number; start: number; end: number; fork: BranchFork; implicit: boolean }
export interface BranchFork { name: string; start: number; endLine: number; routes: BranchRoute[]; parentPath: BranchStep[]; depth: number; key: string }
export interface BranchStep { fork: BranchFork; route: BranchRoute }
export type LineBranch = { marker: "branch" | "route" | "end"; fork: BranchFork; path: BranchStep[] } | { marker: null; path: BranchStep[] };

export function parseBranches(lines: readonly string[], info: readonly LineInfo[]): { forks: BranchFork[]; at: LineBranch[] } {
  const forks: BranchFork[] = [];
  const at: LineBranch[] = new Array(lines.length);
  const stack: BranchFork[] = [];
  const seen = new Map<string, number>();
  const path = (): BranchStep[] => stack.map((f) => ({ fork: f, route: f.routes[f.routes.length - 1]! }));
  for (let i = 0; i < lines.length; i++) {
    const m = info[i]!.kind === "text" ? MARKER.exec(lines[i]!) : null;
    const word = m ? m[1]!.toLowerCase().replace(/[\s_-]+/g, " ") : "";
    if (word === "branch") {
      const parentPath = path();
      const name = cleanName(m![2]) || DEFAULT_FORK;
      const parent = parentPath[parentPath.length - 1];
      const base = parent ? `${parent.fork.key}/${parent.route.name}>` : "";
      const count = (seen.get(base + name) ?? 0) + 1;
      seen.set(base + name, count);
      const fork: BranchFork = { name, start: i, endLine: -1, routes: [], parentPath, depth: parentPath.length, key: `${base}${name}#${count}` };
      fork.routes.push({ name: IMPLICIT_ROUTE, marker: -1, start: i + 1, end: -1, fork, implicit: true });
      forks.push(fork);
      at[i] = { marker: "branch", fork, path: parentPath };
      stack.push(fork);
    } else if (word === "route" && stack.length) {
      const fork = stack[stack.length - 1]!;
      const prev = fork.routes[fork.routes.length - 1]!;
      prev.end = i;
      if (prev.implicit && prev.start === i) fork.routes.pop();
      const name = cleanName(m![2]) || `路線 ${fork.routes.length + 1}`;
      fork.routes.push({ name, marker: i, start: i + 1, end: -1, fork, implicit: false });
      at[i] = { marker: "route", fork, path: fork.parentPath };
    } else if (word === "end branch" && stack.length) {
      const fork = stack.pop()!;
      fork.endLine = i;
      fork.routes[fork.routes.length - 1]!.end = i;
      at[i] = { marker: "end", fork, path: fork.parentPath };
    } else {
      at[i] = { marker: null, path: path() };
    }
  }
  for (const fork of stack) {
    fork.endLine = lines.length;
    fork.routes[fork.routes.length - 1]!.end = lines.length;
  }
  return { forks, at };
}

// ---- cells (cells.js) ----

export type CellType = "markdown" | "code" | "math" | "table" | "card";
export interface CellRun {
  start: number; end: number; above: number; below: number;
  softAbove: boolean; softBelow: boolean; aboveCell: boolean; belowCell: boolean;
  first: number; last: number; empty: boolean; type: CellType;
  /** The id on the cell line right above it (`<!-- cell: id -->`), or null. */
  id: string | null;
}

/** The cells: `at[i]` is the run of line i, -1 on a boundary line. */
export function cellRuns(lines: readonly string[], info: readonly LineInfo[], meta: { at: readonly LineBranch[] }): { runs: CellRun[]; at: number[] } {
  type Piece = { start: number; end: number; above: number; softAbove?: boolean; softBelow?: boolean };
  const runs: Piece[] = [];
  let cur: Piece | null = null;
  for (let i = 0; i < lines.length; i++) {
    const isText = info[i]!.kind === "text";
    if (isText && (isCellLine(lines[i]) || meta.at[i]!.marker)) { cur = null; continue; }
    if (!cur) { cur = { start: i, end: i, above: i - 1 }; runs.push(cur); }
    else cur.end = i;
  }
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!;
    const cards: [number, number][] = [];
    for (let i = r.start; i <= r.end; i++) {
      const at = info[i]!;
      if (at.kind === "card" && at.start === i) cards.push([i, Math.min(at.end, r.end)]);
    }
    if (!cards.length) continue;
    const cuts: number[] = [];
    for (const [cs, ce] of cards) cuts.push(cs, ce + 1);
    const pieces: { start: number; end: number; card: boolean }[] = [];
    let from = r.start;
    for (const c of [...cuts, r.end + 1]) {
      if (c > from && c <= r.end + 1) pieces.push({ start: from, end: c - 1, card: cards.some(([cs]) => cs === from) });
      from = Math.max(from, c);
    }
    const isBlank = (p: { start: number; end: number }) => lines.slice(p.start, p.end + 1).every((l) => blank(l));
    for (let q = 0; q < pieces.length; q++) {
      const p = pieces[q]!;
      if (p.card || !isBlank(p)) continue;
      const nb = pieces[q - 1]?.card ? q - 1 : pieces[q + 1]?.card ? q + 1 : -1;
      if (nb < 0) continue;
      pieces[nb]!.start = Math.min(pieces[nb]!.start, p.start);
      pieces[nb]!.end = Math.max(pieces[nb]!.end, p.end);
      pieces.splice(q, 1);
      q--;
    }
    if (pieces.length < 2) continue;
    const made = pieces.map((p, q) => ({ start: p.start, end: p.end, above: q === 0 ? r.above : p.start - 1, softAbove: q > 0, softBelow: q < pieces.length - 1 }));
    runs.splice(k, 1, ...made);
    k += made.length - 1;
  }
  const at = new Array<number>(lines.length).fill(-1);
  const out: CellRun[] = runs.map((p, k) => {
    for (let i = p.start; i <= p.end; i++) at[i] = k;
    const softAbove = !!p.softAbove;
    const softBelow = !!p.softBelow;
    const below = p.end + 1;
    let first = -1;
    let last = -1;
    for (let i = p.start; i <= p.end; i++) {
      if (blank(lines[i])) continue;
      if (first < 0) first = i;
      last = i;
    }
    const aboveCell = !softAbove && p.above >= 0 && isCellLine(lines[p.above]);
    const run: CellRun = {
      start: p.start, end: p.end, above: p.above, below, softAbove, softBelow, aboveCell,
      belowCell: !softBelow && below < lines.length && isCellLine(lines[below]),
      first, last, empty: first < 0, type: "markdown", id: aboveCell ? cellLineId(lines[p.above]) : null,
    };
    run.type = cellType(lines, info, run);
    return run;
  });
  return { runs: out, at };
}

/** markdown | code | math | table | card: code / math / table / card when the cell's content is exactly one such block. */
export function cellType(lines: readonly string[], info: readonly LineInfo[], r: { first: number; last: number }): CellType {
  if (r.first < 0) return "markdown";
  const a = info[r.first]!;
  const b = info[r.last]!;
  if ((a.kind === "fence" || a.kind === "code") && a.start === r.first && "start" in b && b.start === a.start && b.end === r.last) return "code";
  if (a.kind === "mathb" && a.start === r.first && "start" in b && b.start === a.start && a.end === r.last) return "math";
  if (a.kind === "table" && a.start === r.first && a.end === r.last) return "table";
  if (a.kind === "card" && a.start === r.first && a.end === r.last) return "card";
  if (r.first === r.last) {
    const t = lines[r.first]!;
    if (/^\s*\$\$.+\$\$\s*$/.test(t)) return "math";
    if (/^\s*<show\b/i.test(t)) return "card";
  }
  return "markdown";
}

// ---- the whole note as a tree (what note.db keeps) ----

export type BlockKind = "text" | "card" | "image";
export interface TreeBlock {
  type: "block";
  /** From its `<!-- cell: id -->` line; null without one. */
  id: string | null;
  kind: BlockKind;
  cell: CellType;
  text: string;
  /** Its first and last line (0-based, inclusive). */
  start: number;
  end: number;
}
export interface TreeRoute { name: string; implicit: boolean; marker: number; start: number; end: number; items: TreeItem[] }
export interface TreeFork { type: "fork"; name: string; key: string; start: number; endLine: number; routes: TreeRoute[] }
export type TreeItem = TreeBlock | TreeFork;
export interface NoteTree { lines: string[]; items: TreeItem[] }

const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

/** A cell's kind: a card, a lone picture line (a frozen card or a pasted image), else text. */
export function blockKind(text: string, cell: CellType): BlockKind {
  if (cell === "card") return "card";
  const content = text.split("\n").filter((line) => line.trim());
  return content.length === 1 && IMAGE_LINE.test(content[0]!) ? "image" : "text";
}

/** The note cut into cells, forks and routes, in file order. */
export function noteTree(text: string): NoteTree {
  const lines = text.split("\n");
  const info = classifyLines(lines);
  const meta = parseBranches(lines, info);
  const cells = cellRuns(lines, info, meta);
  const routes = new Map<BranchRoute, TreeRoute>();
  const forks = new Map<BranchFork, TreeFork>();
  for (const fork of meta.forks) {
    const made: TreeFork = { type: "fork", name: fork.name, key: fork.key, start: fork.start, endLine: fork.endLine, routes: [] };
    for (const route of fork.routes) {
      const r: TreeRoute = { name: route.name, implicit: route.implicit, marker: route.marker, start: route.start, end: route.end, items: [] };
      routes.set(route, r);
      made.routes.push(r);
    }
    forks.set(fork, made);
  }
  const root: TreeItem[] = [];
  const container = (path: readonly BranchStep[]): TreeItem[] => {
    const last = path[path.length - 1];
    return last ? routes.get(last.route)!.items : root;
  };
  const entries: { line: number; place: () => void }[] = [];
  for (const fork of meta.forks) entries.push({ line: fork.start, place: () => container(fork.parentPath).push(forks.get(fork)!) });
  for (const run of cells.runs) {
    const body = lines.slice(run.start, run.end + 1).join("\n");
    const block: TreeBlock = { type: "block", id: run.id, kind: blockKind(body, run.type), cell: run.type, text: body, start: run.start, end: run.end };
    entries.push({ line: run.start, place: () => container(meta.at[run.start]!.path).push(block) });
  }
  entries.sort((a, b) => a.line - b.line);
  for (const entry of entries) entry.place();
  return { lines, items: root };
}

/** A fork's routes as they count: an empty unnamed first route beside named ones is no route (the editor drops it too). */
export function routesThatCount<R extends { implicit: boolean; items: readonly unknown[] }>(routes: readonly R[]): R[] {
  return routes.filter((route, index) => !(route.implicit && index === 0 && route.items.length === 0 && routes.length > 1));
}

/** What a tree holds, without positions: two notes with the same shape read the same in the Note tab. */
export function treeShape(items: readonly TreeItem[], withIds = false): unknown[] {
  return items.map((item) => item.type === "block"
    ? (withIds ? { id: item.id, kind: item.kind, text: item.text } : { kind: item.kind, text: item.text })
    : { fork: item.name, routes: routesThatCount(item.routes).map((route) => ({ name: route.name, implicit: route.implicit, items: treeShape(route.items, withIds) })) });
}

/** Something exportable: blocks with text (and an id for the app's export), forks with routes. */
export type ExportItem =
  | { type: "block"; id?: string | null; text: string }
  | { type: "fork"; name: string; routes: { name: string; implicit: boolean; items: ExportItem[] }[] };

/**
 * The note.md text of a tree. `ids`: every cell starts with its `<!-- cell: id -->` line (the app's export, so an edit
 * made in the file comes back by id); else cells are cut by plain `<!-- cell -->` lines only where one is needed.
 * A note that is one empty cell is the empty file.
 */
export function exportNote(items: readonly ExportItem[], options: { ids?: boolean } = {}): string {
  const only = items.length === 1 ? items[0] : undefined;
  if (!items.length || (only?.type === "block" && only.text === "")) return "";
  const out: string[] = [];
  const emit = (list: readonly ExportItem[]) => {
    let previous: ExportItem | null = null;
    for (const item of list) {
      if (item.type === "block") {
        if (options.ids && item.id) out.push(cellIdLine(item.id));
        else if (previous?.type === "block") out.push(CELL_LINE);
        out.push(...item.text.split("\n"));
      } else {
        out.push(branchLine(item.name));
        item.routes.forEach((route, index) => {
          if (!(route.implicit && index === 0)) out.push(routeLine(route.name));
          emit(route.items);
        });
        out.push(END_LINE);
      }
      previous = item;
    }
  };
  emit(items);
  return out.join("\n");
}
