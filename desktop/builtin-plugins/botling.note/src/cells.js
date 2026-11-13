// botling.note, cells inside one note.md (like Jupyter's cells, but the file stays plain Markdown).
//
// A cell is a whole chunk of Markdown: headings, lists and paragraphs together. Cells are cut by a line on its own
//
//   <!-- cell -->
//
// (an HTML comment, as `<!-- branch: … -->` / `<!-- route: … -->` / `<!-- end branch -->` are; Markdown never shows
// it). Branch, route and end-branch lines also bound cells, so a `cell` line inside a route cuts cells inside that
// route. A note without `cell` lines is one cell per region (top, each route, after a fork) and nothing here ever
// rewrites it: only the edits below (split, merge, insert, move, delete, change type) add or remove `cell` lines.
// A `cell` line inside a code fence or a $$ block is plain text. Everything here is pure and works in place on `lines`.

// What a cell is (cellRuns, cellType, the cell line, with or without the app's id) is the app's one copy of the rules,
// desktop/src/core/note-cells.ts (imported from the app itself). The edits are here.
import { CELL_LINE, isCellLine, cellRuns, cellType } from "../../../src/core/note-cells.ts";
export { CELL_LINE, isCellLine, cellRuns, cellType };

const blank = (l) => !String(l ?? "").trim();
const FENCE = /^(\s*)(```+)(.*)$/;

// Split the cell at the cursor (line i, caret position). Returns { at, caret } for the cursor, or { error }.
export function splitCell(lines, info, r, i, caret) {
  const line = lines[i] ?? "";
  const pos = Math.max(0, Math.min(caret, line.length));
  const before = line.slice(0, pos);
  const after = line.slice(pos);
  const k = info[i];
  if (k.kind === "mathb") return { error: "數學區塊裡不能切開；把游標移到區塊外面再切" };
  if (k.kind === "fence") return { error: "游標在 ``` 那一行；移到程式碼裡面或外面再切" };
  if (k.kind === "code") {
    // A code block is cut into two code blocks: close the fence, cut, open it again (same language).
    const open = lines[k.start];
    const close = `${FENCE.exec(open)?.[1] ?? ""}${FENCE.exec(open)?.[2] ?? "```"}`;
    if (pos === 0) {
      lines.splice(i, 0, close, CELL_LINE, open);
      return { at: i + 3, caret: 0 };
    }
    lines.splice(i, 1, before, close, CELL_LINE, open, after);
    return { at: i + 4, caret: 0 };
  }
  if (pos === 0) {
    if (i === r.start) {
      lines.splice(i, 0, "", CELL_LINE); // at the very top: a new empty cell above
      return { at: i + 2, caret: 0 };
    }
    lines.splice(i, 0, CELL_LINE);
    return { at: i + 1, caret: 0 };
  }
  if (pos >= line.length) {
    if (i === r.end) {
      lines.splice(i + 1, 0, CELL_LINE, ""); // at the very end: a new empty cell below
      return { at: i + 2, caret: 0 };
    }
    lines.splice(i + 1, 0, CELL_LINE);
    return { at: i + 2, caret: 0 };
  }
  lines.splice(i, 1, before, CELL_LINE, after);
  return { at: i + 2, caret: 0 };
}

// Merge the cell with the one below (only across a `cell` line). Returns { at, caret } or { error }.
export function mergeBelow(lines, r) {
  if (r.softBelow) return { error: "卡片自成一格，不能和文字合併" };
  if (!r.belowCell) return { error: r.below >= lines.length ? "這已經是最後一格" : "下面是分支的邊界，不能合併" };
  lines.splice(r.below, 1);
  const at = r.last >= 0 ? r.last : r.end;
  return { at, caret: (lines[at] ?? "").length };
}

// A new empty cell right under this one. Returns { at, caret }.
export function insertCellBelow(lines, r) {
  lines.splice(r.end + 1, 0, CELL_LINE, "");
  return { at: r.end + 2, caret: 0 };
}

// Swap the cell with its neighbour (only across a `cell` line). Returns { start } of the moved cell, or { error }.
export function moveCell(lines, runs, idx, dir) {
  const r = runs[idx];
  const n = runs[idx + (dir < 0 ? -1 : 1)];
  const ok = dir < 0 ? r.aboveCell && n && n.below === r.above : r.belowCell && n && n.above === r.below;
  if (!ok && (dir < 0 ? r.softAbove : r.softBelow)) return { error: "卡片和旁邊的文字之間沒有 cell 線；用拖曳移動它" };
  if (!ok) return { error: dir < 0 ? "已經是最上面一格（或上面是分支）" : "已經是最下面一格（或下面是分支）" };
  const [a, b] = dir < 0 ? [n, r] : [r, n]; // a is above b, one `cell` line between them
  const A = lines.slice(a.start, a.end + 1);
  const B = lines.slice(b.start, b.end + 1);
  lines.splice(a.start, b.end - a.start + 1, ...B, lines[a.below], ...A);
  return { start: dir < 0 ? a.start : a.start + B.length + 1 };
}

// Delete the cell with one of its `cell` lines; a cell alone in its region is emptied instead. Returns { at }.
export function deleteCell(lines, r) {
  if (r.belowCell) {
    lines.splice(r.start, r.below - r.start + 1);
    return { at: r.start };
  }
  if (r.aboveCell) {
    lines.splice(r.above, r.end - r.above + 1);
    return { at: Math.max(0, r.above - 1) };
  }
  lines.splice(r.start, r.end - r.start + 1, "");
  if (!lines.length) lines.push("");
  return { at: r.start };
}

// The cell's source without the fence / $$ that made it a code / math cell.
function sourceOf(lines, r) {
  const seg = lines.slice(r.first, r.last + 1);
  if (r.type === "code") return seg.slice(1, FENCE.test(seg[seg.length - 1]) && seg.length > 1 ? -1 : undefined);
  if (r.type === "math") {
    if (seg.length === 1) return [seg[0].replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim()];
    const out = seg.slice();
    out[0] = out[0].replace(/^\s*\$\$/, "");
    out[out.length - 1] = out[out.length - 1].replace(/\$\$.*$/, "");
    if (out.length > 1 && blank(out[0])) out.shift();
    if (out.length > 1 && blank(out[out.length - 1])) out.pop();
    return out;
  }
  return seg;
}

// Change the whole cell's type (markdown | code | math); its text is kept, blank lines around it stay where they are.
export function convertCell(lines, r, to) {
  if (to === r.type) return { at: r.first >= 0 ? r.first : r.start, caret: 0 };
  if (r.empty) {
    const next = to === "code" ? ["```", "", "```"] : to === "math" ? ["$$", "", "$$"] : [""];
    lines.splice(r.start, r.end - r.start + 1, ...next);
    return { at: r.start + (next.length > 1 ? 1 : 0), caret: 0 };
  }
  const src = sourceOf(lines, r);
  const body = src.length ? src : [""];
  const next = to === "code" ? ["```", ...body, "```"] : to === "math" ? ["$$", ...body, "$$"] : body;
  lines.splice(r.first, r.last - r.first + 1, ...next);
  return { at: r.first + (to === "markdown" ? 0 : 1), caret: 0 };
}

// ---- moving a cell anywhere: drag and drop, and move up / down across branch lines ----
//
// A region is the lines between two branch / route / end-branch lines (or the file's ends). Each region offers a gap
// before, between and after its shown cells, or one gap when it has none (an empty route). A gap:
//   { g, s, e, path, prev, next }  g: where it sits in line units (a `cell` line, or s - .5 / e - .5), so gaps sort
//   in file order and the UI can find the drawn pieces around it; s / e: its region; path: the forks / routes it is in
//   (as parseBranches' path: [{ fork, route }], [] = shared text); prev / next: the run index above / below (-1: none).
export function cellGaps(lines, meta, cells) {
  const gaps = [];
  const shown = (r) => !r.empty || r.aboveCell || r.belowCell || cells.runs.length === 1;
  const bounds = [];
  for (let i = 0; i < lines.length; i++) if (meta.at[i].marker) bounds.push(i);
  bounds.push(lines.length);
  let top = -1; // the boundary line above the region
  let ri = 0;
  for (const b of bounds) {
    const s = top + 1;
    const e = b;
    let path = [];
    let skip = false;
    if (top >= 0) {
      const at = meta.at[top];
      const fork = at.fork;
      if (at.marker === "branch") {
        const route = fork.routes[0]?.implicit && fork.routes[0].start === s ? fork.routes[0] : null;
        if (route) path = [...fork.parentPath, { fork, route }];
        else skip = true; // nothing between `branch` and its first `route`: no region there
      } else if (at.marker === "route") {
        const route = fork.routes.find((r) => r.marker === top);
        path = [...fork.parentPath, { fork, route }];
      } else path = fork.parentPath;
    }
    const mine = [];
    while (ri < cells.runs.length && cells.runs[ri].start < e) {
      if (cells.runs[ri].start >= s && shown(cells.runs[ri])) mine.push(ri);
      ri++;
    }
    if (!skip) {
      if (!mine.length) gaps.push({ g: s - 0.5, s, e, path, prev: -1, next: -1 });
      for (let k = 0; k <= mine.length && mine.length; k++) {
        const g = k === 0 ? s - 0.5 : k === mine.length ? e - 0.5 : cells.runs[mine[k]].above;
        gaps.push({ g, s, e, path, prev: k > 0 ? mine[k - 1] : -1, next: k < mine.length ? mine[k] : -1 });
      }
    }
    top = b;
  }
  return gaps;
}

// The gap is right next to the cell: dropping there changes nothing.
export const gapTouches = (gap, idx) => gap.prev === idx || gap.next === idx;

// Move cell `idx` into `gap` (from cellGaps on the same lines). Its Markdown (without the blank lines at its top / bottom)
// goes to the gap with a `cell` line on the side that has a neighbour; where it left, one `cell` line goes with it, so
// cells stay separate and branch / route / end-branch lines are never touched. Returns { start, end } of the moved
// cell, { same } for a gap next to it, or { error }.
export function moveCellTo(lines, runs, idx, gap) {
  const r = runs[idx];
  if (!r || !gap) return { error: "找不到這一格" };
  if (gapTouches(gap, idx)) return { same: true, start: r.start, end: r.end };
  const core = r.empty ? [""] : lines.slice(r.first, r.last + 1);
  let ra;
  let rb;
  if (r.aboveCell && r.belowCell) [ra, rb] = [r.above, r.end];
  else if (r.aboveCell) [ra, rb] = [r.above, r.empty ? r.end : r.last]; // blank lines before the next branch line stay
  else if (r.belowCell) [ra, rb] = [r.empty ? r.start : r.first, r.below];
  else if (!r.empty) [ra, rb] = [r.first, r.last]; // alone in its region: the region keeps its blank lines
  else return { error: "這一格是空的" };
  let ins;
  let add;
  let lead = 0;
  if (gap.prev < 0 && gap.next < 0) {
    ins = gap.s;
    add = core;
  } else if (gap.prev < 0) {
    const n = runs[gap.next];
    ins = n.empty ? n.start : n.first;
    add = [...core, CELL_LINE];
  } else {
    const p = runs[gap.prev];
    ins = (p.empty ? p.end : p.last) + 1;
    add = [CELL_LINE, ...core];
    lead = 1;
  }
  const cut = rb - ra + 1;
  let start;
  if (ins > rb) {
    lines.splice(ins, 0, ...add);
    lines.splice(ra, cut);
    start = ins - cut + lead;
  } else {
    lines.splice(ra, cut);
    lines.splice(ins, 0, ...add);
    start = ins + lead;
  }
  if (!lines.length) lines.push("");
  return { start, end: start + core.length - 1 };
}
