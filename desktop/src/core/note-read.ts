// Reading and changing a note by id (the app_note_* tools): moved out of note-db.ts unchanged. `NoteDb` is a type-only
// import, so there is no import cycle at run time (note-db.ts re-exports every name here).
import { noteTree, classifyLines, type BlockKind, type TreeBlock } from "./note-cells";
import {
  Model, NoteConflict, ROOT, evenKeys, keyBetween,
  type BlockRow, type ModelItem, type NoteMode, type NotePathStep, type OutlineItem, type RouteRow,
} from "./note-tree";
import type { NoteDb } from "./note-db";

/** The cells a piece of text makes when it stands alone (an edit, an insert): no forks in it. */
function piecesOf(text: string): string[] {
  const tree = noteTree(text);
  if (tree.items.some((item) => item.type === "fork")) throw new Error("The text has branch / route / end branch lines: use app_note_branch to make or change branches.");
  const blocks = tree.items as TreeBlock[];
  return blocks.length ? blocks.map((block) => block.text) : [""];
}

// ---- reading and changing a note by id (the app_note_* tools) ----

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 120);

export function outline(note: NoteDb): { mode: NoteMode; note_rev: number; items: OutlineItem[] } {
  const model = note.model();
  const walk = (items: ModelItem[]): OutlineItem[] => items.map((item) => item.type === "block"
    ? { id: item.row.id, kind: item.row.kind as BlockKind, rev: item.row.rev, first: firstLine(item.row.text), lines: item.row.text.split("\n").length }
    : { id: item.row.id, kind: "branch", name: item.row.name ?? "", rev: item.row.rev, routes: item.routes.map((route) => ({ id: route.row.id, name: route.row.name, rev: route.row.rev, items: walk(route.items) })) });
  return { mode: note.mode, note_rev: model.noteRev, items: walk(model.tree()) };
}

type ReadEntry =
  | { id: string; kind: BlockKind; rev: number; path: string; text: string }
  | { id: string; kind: "branch"; rev: number; path: string; name: string; routes: { id: string; name: string }[] }
  | { id: string; deleted: true; deleted_rev: number | null; rev: number; text: string };

const pathText = (path: readonly NotePathStep[]) => path.map((step) => `${step.fork} › ${step.route}`).join(" › ");

export function read(note: NoteDb, what: { ids?: string[]; route?: string }): { mode: NoteMode; note_rev: number; cells: ReadEntry[] } {
  const model = note.model();
  const entry = (row: BlockRow): ReadEntry => {
    if (row.deleted_at !== null) return { id: row.id, deleted: true, deleted_rev: row.deleted_rev, rev: row.rev, text: row.text };
    if (row.kind === "branch") return { id: row.id, kind: "branch", rev: row.rev, path: pathText(model.path(row)), name: row.name ?? "", routes: model.routesOf(row.id).map((route) => ({ id: route.id, name: route.name })) };
    return { id: row.id, kind: row.kind, rev: row.rev, path: pathText(model.path(row)), text: row.text };
  };
  const all = (items: ModelItem[], out: ReadEntry[] = []) => {
    for (const item of items) {
      out.push(entry(item.row));
      if (item.type === "fork") for (const route of item.routes) all(route.items, out);
    }
    return out;
  };
  let cells: ReadEntry[];
  if (what.ids?.length) {
    cells = what.ids.map((id) => {
      const row = model.blocks.get(id);
      if (row) return entry(row);
      const route = model.routes.get(id);
      if (route && route.deleted_at === null) throw new Error(`${id} is a route: read it with route.`);
      throw new Error(`No cell ${id} in this note (see app_note_outline).`);
    });
  } else if (what.route) {
    const route = model.routes.get(what.route) ?? findRoute(model, what.route);
    if (!route || route.deleted_at !== null) throw new Error(`No route ${what.route} in this note (a route id, or "fork › route" by name; see app_note_outline).`);
    cells = all(model.tree(route.id));
  } else {
    cells = all(model.tree());
  }
  return { mode: note.mode, note_rev: model.noteRev, cells };
}

/** A route named as "fork › route" (nested: "outer › route › inner › route"), or by its name alone when that is unique. */
function findRoute(model: Model, name: string): RouteRow | undefined {
  const want = name.split(/\s*[›>\/]\s*/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const live = [...model.routes.values()].filter((route) => route.deleted_at === null);
  const named = (route: RouteRow) => {
    const fork = model.blocks.get(route.branch_id);
    if (!fork) return [];
    return [...model.path(fork).flatMap((step) => [step.fork, step.route]), fork.name ?? "", route.name].map((part) => part.toLowerCase());
  };
  const exact = live.filter((route) => { const parts = named(route); return parts.length >= want.length && parts.slice(-want.length).join("\u0000") === want.join("\u0000"); });
  return exact.length === 1 ? exact[0] : undefined;
}

export function search(note: NoteDb, query: string, limit: number): { id: string; rev: number; kind: string; path: string; line: number; excerpt: string }[] {
  const model = note.model();
  const needle = query.toLowerCase();
  const found: { id: string; rev: number; kind: string; path: string; line: number; excerpt: string }[] = [];
  const walk = (items: ModelItem[]) => {
    for (const item of items) {
      if (found.length >= limit) return;
      if (item.type === "block") {
        const lines = item.row.text.split("\n");
        lines.forEach((line, index) => {
          if (found.length >= limit || !line.toLowerCase().includes(needle)) return;
          found.push({ id: item.row.id, rev: item.row.rev, kind: item.row.kind, path: pathText(model.path(item.row)), line: index + 1, excerpt: line.trim().slice(0, 240) });
        });
      } else {
        if ((item.row.name ?? "").toLowerCase().includes(needle)) found.push({ id: item.row.id, rev: item.row.rev, kind: "branch", path: pathText(model.path(item.row)), line: 0, excerpt: item.row.name ?? "" });
        for (const route of item.routes) {
          if (route.row.name.toLowerCase().includes(needle) && found.length < limit) found.push({ id: route.row.id, rev: route.row.rev, kind: "route", path: pathText(model.path(item.row)), line: 0, excerpt: `${item.row.name} › ${route.row.name}` });
          walk(route.items);
        }
      }
    }
  };
  walk(model.tree());
  return found;
}

const conflictOf = (row: BlockRow, message: string) => new NoteConflict(message, { id: row.id, rev: row.rev, text: row.text });
function checkRev(row: BlockRow, rev: number | undefined, required: boolean) {
  if (rev === undefined) { if (required) throw new Error(`rev is required: read cell ${row.id} first (app_note_read) and give its rev.`); return; }
  if (rev !== row.rev) throw conflictOf(row, `Cell ${row.id} is at rev ${row.rev}, not ${rev}: someone changed it. Read it again and retry.`);
}
const editable = (model: Model, id: string) => {
  const row = model.live(id);
  if (row.kind === "branch") throw new Error(`${id} is a branch: change it with app_note_branch.`);
  return row;
};

export interface EditArgs { id: string; rev?: number; text?: string; old_text?: string; new_text?: string }
export function edit(note: NoteDb, actor: string, args: EditArgs) {
  return note.transaction(actor, (model) => {
    const row = editable(model, args.id);
    let text: string;
    if (args.text !== undefined) {
      if (args.old_text !== undefined || args.new_text !== undefined) throw new Error("Give either text (the whole cell, with rev) or old_text and new_text, not both.");
      checkRev(row, args.rev, true);
      text = args.text;
    } else {
      if (args.old_text === undefined || args.new_text === undefined) throw new Error("Give text (the whole cell, with rev), or old_text and new_text.");
      if (!args.old_text) throw new Error("old_text is empty.");
      const count = row.text.split(args.old_text).length - 1;
      if (count === 0) throw conflictOf(row, `old_text is not in cell ${row.id} (rev ${row.rev}).`);
      if (count > 1) throw conflictOf(row, `old_text is in cell ${row.id} ${count} times: give more of the text around it so it is there once.`);
      text = row.text.replace(args.old_text, () => args.new_text!);
    }
    const [first, ...rest] = piecesOf(text);
    model.writeText(row, first!);
    const made = rest.length ? model.placeMany({ after: row.id }, rest.length) : null;
    const added = rest.map((piece, index) => model.addBlock(made!.parent, made!.keys[index]!, piece).id);
    return { id: row.id, ...(added.length ? { added } : {}) };
  });
}

export interface PlaceArgs { after?: string; before?: string; route?: string; at?: "start" | "end" }
const placeOf = (args: PlaceArgs) => {
  const given = [args.after, args.before, args.route].filter((value) => value !== undefined).length;
  if (given > 1) throw new Error("Give one of after, before or route.");
  if ((args.after || args.before) && args.at) throw new Error("at goes with route (or with nothing: the note itself), not with after / before.");
  return { ...(args.after ? { after: args.after } : {}), ...(args.before ? { before: args.before } : {}), ...(args.route ? { route: args.route } : {}), start: args.at === "start" };
};

export function insert(note: NoteDb, actor: string, args: PlaceArgs & { text: string }) {
  return note.transaction(actor, (model) => {
    const pieces = piecesOf(args.text);
    const made = model.placeMany(placeOf(args), pieces.length);
    return { ids: pieces.map((piece, index) => model.addBlock(made.parent, made.keys[index]!, piece).id) };
  });
}

export function remove(note: NoteDb, actor: string, args: { id: string; rev?: number }) {
  return note.transaction(actor, (model) => {
    const row = editable(model, args.id);
    checkRev(row, args.rev, false);
    model.remove(row);
    return { id: row.id, deleted: true };
  });
}

export function move(note: NoteDb, actor: string, args: PlaceArgs & { id: string }) {
  return note.transaction(actor, (model) => {
    const row = model.live(args.id, "cell or branch");
    if (args.after === row.id || args.before === row.id) return { id: row.id };
    const to = model.place(placeOf(args));
    if (row.kind === "branch" && model.inside(to.parent, row.id)) throw new Error(`Branch ${row.id} cannot go inside itself.`);
    model.move(row, to.parent, to.key);
    return { id: row.id, path: pathText(model.path(model.blocks.get(row.id)!)) };
  });
}

/** Splits a cell before its line `line` (1-based): the lines before keep the id, the rest are a new cell right after it. */
export function split(note: NoteDb, actor: string, args: { id: string; rev?: number; line: number }) {
  return note.transaction(actor, (model) => {
    const row = editable(model, args.id);
    checkRev(row, args.rev, true);
    const lines = row.text.split("\n");
    if (!Number.isInteger(args.line) || args.line < 2 || args.line > lines.length) throw new Error(`line must be 2 to ${lines.length} (the first line of the new cell; cell ${row.id} has ${lines.length} lines).`);
    const at = args.line - 1;
    const info = classifyLines(lines);
    const here = info[at]!;
    const before = info[at - 1]!;
    if ((here.kind !== "text" && here.start !== at) || (before.kind !== "text" && before.end !== at - 1)) {
      throw new Error(`Line ${args.line} is inside a ${here.kind === "text" ? before.kind : here.kind === "fence" || here.kind === "code" ? "code block" : here.kind === "mathb" ? "math block" : here.kind}: split before or after it.`);
    }
    model.writeText(row, lines.slice(0, at).join("\n"), "split");
    const to = model.place({ after: row.id });
    const added = model.addBlock(to.parent, to.key, lines.slice(at).join("\n"));
    return { id: row.id, rev: model.blocks.get(row.id)!.rev, new_id: added.id };
  });
}

/** Merges a cell with the next one in its route (the next one goes; its text joins this one's). */
export function merge(note: NoteDb, actor: string, args: { id: string; rev?: number; next_rev?: number }) {
  return note.transaction(actor, (model) => {
    const row = editable(model, args.id);
    checkRev(row, args.rev, true);
    const siblings = model.children(row.parent);
    const next = siblings[siblings.findIndex((sibling) => sibling.id === row.id) + 1];
    if (!next) throw new Error(`Cell ${row.id} is the last one in its ${row.parent === ROOT ? "note" : "route"}: nothing to merge with.`);
    if (next.kind === "branch") throw new Error(`The next item after ${row.id} is a branch (${next.id}); only two cells merge.`);
    checkRev(next, args.next_rev, false);
    if (row.kind === "card" || next.kind === "card") throw new Error("A card stays a cell of its own: it does not merge with text.");
    model.writeText(row, `${row.text}\n${next.text}`, "merge");
    model.remove(next);
    return { id: row.id, rev: model.blocks.get(row.id)!.rev, merged: next.id };
  });
}

export interface BranchArgs {
  op: "create" | "add_route" | "rename" | "delete_route" | "dissolve" | "delete";
  ids?: string[]; name?: string; names?: string[]; branch?: string; route?: string; keep?: string; rev?: number;
  after?: string; before?: string; at?: "start" | "end";
}
export function branch(note: NoteDb, actor: string, args: BranchArgs) {
  return note.transaction(actor, (model) => {
    const forkRow = (id: string | undefined) => {
      if (!id) throw new Error("branch (the branch's id) is required.");
      const row = model.live(id, "branch");
      if (row.kind !== "branch") throw new Error(`${id} is a cell, not a branch.`);
      return row;
    };
    const revOf = (row: { id: string; rev: number }, current: Record<string, unknown>) => {
      if (args.rev !== undefined && args.rev !== row.rev) throw new NoteConflict(`${row.id} is at rev ${row.rev}, not ${args.rev}.`, current);
    };
    switch (args.op) {
      case "create": {
        const names = args.names?.length ? args.names : ["路線 1", "路線 2"];
        if (names.some((name) => !name.trim())) throw new Error("A route needs a name.");
        const ids = args.ids ?? [];
        let at: { parent: string; key: string };
        const rows = ids.map((id) => model.live(id, "cell or branch"));
        if (rows.length) {
          if (args.after || args.before || args.route) throw new Error("Give ids (what goes into the first route) or a place (after / before / route), not both.");
          const siblings = model.children(rows[0]!.parent);
          const index = siblings.findIndex((row) => row.id === rows[0]!.id);
          if (rows.some((row, k) => siblings[index + k]?.id !== row.id)) throw new Error("ids must be cells (or branches) next to each other in one route, in order.");
          at = { parent: rows[0]!.parent, key: rows[0]!.sort_key };
        } else {
          at = model.place(placeOf(args));
        }
        const id = model.newId();
        const name = (args.name ?? "").trim() || "分支";
        model.setBlock({ id, parent: at.parent, sort_key: at.key, kind: "branch", text: "", name, rev: 1, deleted_at: null, deleted_rev: null });
        model.log("branch", id, null, { name, routes: names });
        const keys = evenKeys(names.length);
        const routes = names.map((routeName, r) => {
          const routeId = model.newId();
          model.setRoute({ id: routeId, branch_id: id, name: routeName.trim(), sort_key: keys[r]!, rev: 1, implicit: 0, deleted_at: null });
          return { id: routeId, name: routeName.trim() };
        });
        const inner = evenKeys(rows.length);
        rows.forEach((row, k) => model.move(row, routes[0]!.id, inner[k]!));
        return { branch: id, routes };
      }
      case "add_route": {
        const fork = forkRow(args.branch);
        const name = (args.name ?? "").trim();
        if (!name) throw new Error("name (the new route's) is required.");
        const routes = model.routesOf(fork.id);
        const routeId = model.newId();
        model.setRoute({ id: routeId, branch_id: fork.id, name, sort_key: keyBetween(routes[routes.length - 1]?.sort_key ?? null, null), rev: 1, implicit: 0, deleted_at: null });
        model.log("add_route", routeId, null, { name, branch: fork.id });
        return { branch: fork.id, route: routeId };
      }
      case "rename": {
        const name = (args.name ?? "").trim();
        if (!name) throw new Error("name is required.");
        if (args.route) {
          const route = model.liveRoute(args.route);
          revOf(route, { id: route.id, rev: route.rev, name: route.name });
          model.log("rename_route", route.id, { name: route.name }, { name });
          model.setRoute({ ...route, name, implicit: 0, rev: route.rev + 1 });
          return { route: route.id };
        }
        const fork = forkRow(args.branch);
        revOf(fork, { id: fork.id, rev: fork.rev, name: fork.name });
        model.log("rename", fork.id, { name: fork.name }, { name });
        model.setBlock({ ...fork, name, rev: fork.rev + 1 });
        return { branch: fork.id };
      }
      case "delete_route": {
        if (!args.route) throw new Error("route (the route's id) is required.");
        const route = model.liveRoute(args.route);
        revOf(route, { id: route.id, rev: route.rev, name: route.name });
        if (model.routesOf(route.branch_id).length <= 1) throw new Error(`Route ${route.id} is its branch's last one: use op dissolve (keep it) or delete (the whole branch).`);
        model.removeRoute(route);
        return { route: route.id, deleted: true };
      }
      case "dissolve": {
        const fork = forkRow(args.branch);
        revOf(fork, { id: fork.id, rev: fork.rev, name: fork.name });
        const routes = model.routesOf(fork.id);
        const keep = routes.find((route) => route.id === args.keep);
        if (!keep) throw new Error(`keep must be one of branch ${fork.id}'s routes: ${routes.map((route) => `${route.id} (${route.name})`).join(", ")}.`);
        const items = model.children(keep.id);
        const siblings = model.children(fork.parent);
        const index = siblings.findIndex((row) => row.id === fork.id);
        let previous = siblings[index - 1]?.sort_key ?? null;
        const next = siblings[index + 1]?.sort_key ?? null;
        for (const item of items) { previous = keyBetween(previous, next); model.move(item, fork.parent, previous); }
        for (const route of routes) model.removeRoute(route);
        model.remove(model.blocks.get(fork.id)!);
        return { dissolved: fork.id, kept: items.map((row) => row.id) };
      }
      case "delete": {
        const fork = forkRow(args.branch);
        revOf(fork, { id: fork.id, rev: fork.rev, name: fork.name });
        model.remove(fork);
        return { branch: fork.id, deleted: true };
      }
      default:
        throw new Error("op must be create, add_route, rename, delete_route, dissolve or delete.");
    }
  });
}
