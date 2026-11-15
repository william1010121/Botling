// botling.note, branches inside one note.md.
//
// A fork is written as plain HTML comments, which Markdown never shows:
//
//   <!-- branch: 學習率 -->        opens a fork (the name is optional)
//   <!-- route: lr=3e-4 -->        starts one route of the innermost open fork
//   <!-- end branch -->            closes the innermost open fork; what follows is shared again
//
// Forks may nest. A fork without `end branch` runs to the end of the file. Lines between `branch` and
// the first `route` form an unnamed first route. A `route` / `end branch` outside any fork, and any
// marker inside a code fence or a $$ block, is plain text. Everything here is pure: it reads the lines
// and returns positions or edits them in place; nothing depends on the DOM.

import { isCellLine, isBranchMarker } from "../../../src/core/note-cells.ts";
// Reading the markers (parseBranches) is the app's one copy of the rules, desktop/src/core/note-cells.ts; the edits are here.
import { parseBranches, cleanName, branchLine, routeLine, END_LINE, DEFAULT_FORK, IMPLICIT_ROUTE } from "../../../src/core/note-cells.ts";
export { parseBranches, cleanName, branchLine, routeLine, END_LINE };

export const chosenRoute = (fork, sel) => fork.routes.find((r) => r.name === sel[fork.key]) ?? fork.routes[0];

export const pathVisible = (path, sel) => path.every((e) => chosenRoute(e.fork, sel) === e.route);

export const routeIsEmpty = (lines, route) => {
  for (let i = route.start; i < route.end; i++) if (lines[i].trim() && !isCellLine(lines[i])) return false;
  return true;
};

// Forks directly inside a route (route === null: top level).
export const childForks = (meta, route) =>
  meta.forks.filter((f) => (route ? f.parentPath.length && f.parentPath[f.parentPath.length - 1].route === route : f.parentPath.length === 0));

// ---- edits (in place on `lines`) ----

// Start of the block a line belongs to (a fence or a $$ block is one block).
export const blockRange = (info, i) => {
  const k = info[i];
  return k && (k.kind === "fence" || k.kind === "code" || k.kind === "mathb") ? [k.start, k.end] : [i, i];
};

// Branch from line `i` downward: from there to the end of its container becomes the first route, a new
// empty route follows, then `end branch`. Returns the new fork's start line and the blank line of the new route.
export function branchFrom(lines, meta, info, i) {
  i = blockRange(info, i)[0];
  const path = meta.at[i].path;
  let end = path.length ? path[path.length - 1].route.end : lines.length;
  let tailNl = false;
  if (end === lines.length && lines[end - 1] === "") {
    if (end - 1 > i) end -= 1; // keep the file's final newline outside the fork
    else tailNl = true;
  }
  const names = new Set(meta.forks.map((f) => f.name));
  let n = 1;
  let forkName = DEFAULT_FORK;
  while (names.has(forkName)) forkName = `${DEFAULT_FORK} ${++n}`;
  lines.splice(end, 0, routeLine("路線 2"), "", END_LINE, ...(tailNl ? [""] : []));
  lines.splice(i, 0, branchLine(forkName), routeLine("路線 1"));
  return { start: i, forkName, firstRoute: "路線 1", newRoute: "路線 2", blank: end + 3 };
}

// A new empty route at the end of a fork. Returns { name, blank }.
export function addRoute(lines, fork) {
  let at = fork.endLine;
  if (at === lines.length && at - 1 > fork.start && lines[at - 1] === "") at -= 1;
  const taken = new Set(fork.routes.map((r) => r.name));
  let n = fork.routes.length + 1;
  while (taken.has(`路線 ${n}`)) n++;
  const name = `路線 ${n}`;
  lines.splice(at, 0, routeLine(name), "");
  return { name, blank: at + 1 };
}

// Make sure the fork is closed and there is a line after it for shared content. Returns that line's index.
export function endFork(lines, fork) {
  if (fork.endLine < lines.length) {
    const next = fork.endLine + 1;
    if (next >= lines.length) lines.push("");
    return next;
  }
  let at = lines.length;
  if (at - 1 > fork.start && lines[at - 1] === "") at -= 1;
  lines.splice(at, 0, END_LINE);
  if (at + 1 >= lines.length) lines.push("");
  return at + 1;
}

export function renameFork(lines, fork, name) {
  lines[fork.start] = branchLine(name);
}

export function renameRoute(lines, fork, route, name) {
  if (route.marker >= 0) lines[route.marker] = routeLine(name);
  else lines.splice(fork.start + 1, 0, routeLine(name));
}

// Delete one route with its lines; the last route of a fork takes the whole fork with it.
export function deleteRoute(lines, fork, route) {
  if (fork.routes.length <= 1) {
    const last = fork.endLine < lines.length ? fork.endLine + 1 : lines.length;
    lines.splice(fork.start, last - fork.start);
  } else {
    lines.splice(route.marker >= 0 ? route.marker : route.start, route.end - (route.marker >= 0 ? route.marker : route.start));
  }
  if (!lines.length) lines.push("");
}

// For the overview: what is in a route.
export function routeFacts(lines, route) {
  let cards = 0;
  let todos = 0;
  let content = 0;
  for (let i = route.start; i < route.end; i++) {
    const t = lines[i].trim();
    if (!t || isBranchMarker(lines[i]) || isCellLine(lines[i])) continue;
    content++;
    if (/^<show\b/i.test(t)) cards++;
    else if (/^[-*+]\s+\[ \]/.test(t)) todos++;
  }
  return { cards, todos, content };
}
