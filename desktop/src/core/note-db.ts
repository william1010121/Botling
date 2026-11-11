// A bot's Note kept in SQLite (note-sqlite design, phase 1): `note.db` beside `note.md`, the app's core process its only
// writer. Every cell (block) has an id that never changes and a rev that goes up with each change of its text; a fork is
// a block too (kind "branch") and its routes are rows of their own, so cells nest in routes to any depth. A deleted
// cell stays as a tombstone (its last text, the note rev it went at). Each change is one transaction that bumps the
// note's rev and logs what it did (`ops`).
//
// note.md stays: after each change it is written again with `<!-- cell: <id> -->` before every cell (note-cells.ts
// `exportNote`), so people, git and bots reading the file see the ids, and an edit made in the file comes back by id
// (`sync`). An edit made against an older copy (a cell's text in the file is one it had before) is not taken: the file
// is kept as note.conflict-<time>.md and note.md is written again from the database.
//
// Moving in (`migrate`): note.md is copied to note.md.pre-sqlite-<date>, cut into cells by the Note tab's own rules,
// written to the database, exported and read back; anything that does not read back the same keeps the note in file
// mode (note.md as before, nothing rewritten) with the reason. A note in file mode is read and saved as a plain file;
// switching it back to file mode writes a note.md without ids.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readNote, writeNote, type NoteState, type NoteWrite } from "./bot-note";
import {
  exportNote, noteTree, routesThatCount, treeShape, type BlockKind, type ExportItem, type TreeBlock, type TreeFork, type TreeItem, type TreeRoute, classifyLines,
} from "./note-cells";

export const NOTE_SCHEMA = 1;
export const ROOT = "root";
export type NoteMode = "db" | "file";

interface BlockRow {
  id: string; parent: string; sort_key: string; kind: BlockKind | "branch"; text: string; name: string | null;
  rev: number; deleted_at: number | null; deleted_rev: number | null;
}
interface RouteRow { id: string; branch_id: string; name: string; sort_key: string; rev: number; implicit: number; deleted_at: number | null }
interface NoteRow { id: string; bot: string; rev: number; schema_version: number; mode: NoteMode; mode_reason: string | null; exported_text: string | null; exported_mtime: number | null; migrated_at: number | null }

/** A step of where an item sits: the fork and the route of it the item is in. */
export interface NotePathStep { fork: string; forkId: string; route: string; routeId: string }
export interface OutlineBlock { id: string; kind: BlockKind; rev: number; first: string; lines: number }
export interface OutlineFork { id: string; kind: "branch"; name: string; rev: number; routes: { id: string; name: string; rev: number; items: OutlineItem[] }[] }
export type OutlineItem = OutlineBlock | OutlineFork;

/** A refusal that carries what is there now, for the caller to read again and retry. */
export class NoteConflict extends Error {
  constructor(message: string, readonly current: Record<string, unknown>) {
    super(`${message} ${JSON.stringify({ conflict: true, ...current })}`);
  }
}

export interface NoteDbHooks {
  log?: (message: string) => void;
  /** An edit made in note.md could not be taken; the file was kept as `file`. */
  conflict?: (file: string, reason: string) => void;
  /** note.md was written by the app (its new mtime): a watcher should not take it for someone else's edit. */
  exported?: (mtime: number) => void;
  now?: () => number;
}

// ---- ids and order ----

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const VALID_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A sort key strictly between `a` and `b` (null: open end); keys never end in "0", so there is always room. */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? "";
  if (b !== null && lo >= b) throw new Error(`No key between ${a} and ${b}.`);
  return midpoint(lo, b);
}
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}
/** `n` keys spread evenly (all one width before trailing zeros go). */
export function evenKeys(n: number): string[] {
  if (n <= 0) return [];
  let width = 1;
  while (36 ** width < n + 1) width++;
  width++;
  const step = Math.floor(36 ** width / (n + 1));
  return Array.from({ length: n }, (_, i) => ((i + 1) * step).toString(36).padStart(width, "0").replace(/0+$/, ""));
}

/** Which of `news` is which of `olds`: the longest common run of equal ones, then equal ones anywhere, then the rest in order within each gap. */
export function align<O, N>(olds: readonly O[], news: readonly N[], same: (o: O, n: N) => boolean, positional = true): (number | null)[] {
  const match: (number | null)[] = news.map(() => null);
  const used = new Set<number>();
  let head = 0;
  while (head < olds.length && head < news.length && same(olds[head]!, news[head]!)) { match[head] = head; used.add(head); head++; }
  let tail = 0;
  while (tail < olds.length - head && tail < news.length - head && same(olds[olds.length - 1 - tail]!, news[news.length - 1 - tail]!)) {
    match[news.length - 1 - tail] = olds.length - 1 - tail; used.add(olds.length - 1 - tail); tail++;
  }
  const oMid = olds.length - head - tail;
  const nMid = news.length - head - tail;
  if (oMid > 0 && nMid > 0 && oMid * nMid <= 4_000_000) {
    const width = nMid + 1;
    const table = new Uint32Array((oMid + 1) * width);
    for (let i = oMid - 1; i >= 0; i--) {
      for (let j = nMid - 1; j >= 0; j--) {
        table[i * width + j] = same(olds[head + i]!, news[head + j]!) ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oMid && j < nMid) {
      if (same(olds[head + i]!, news[head + j]!)) { match[head + j] = head + i; used.add(head + i); i++; j++; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
      else j++;
    }
  }
  // Equal ones moved elsewhere.
  for (let j = 0; j < news.length; j++) {
    if (match[j] !== null) continue;
    for (let i = 0; i < olds.length; i++) if (!used.has(i) && same(olds[i]!, news[j]!)) { match[j] = i; used.add(i); break; }
  }
  if (!positional) return match;
  // The rest, in order, within the gap between two matched ones on both sides.
  let lastOld = -1;
  let j = 0;
  while (j < news.length) {
    if (match[j] !== null) { lastOld = Math.max(lastOld, match[j]!); j++; continue; }
    let k = j;
    while (k < news.length && match[k] === null) k++;
    const nextOld = k < news.length ? match[k]! : olds.length;
    const free: number[] = [];
    for (let i = lastOld + 1; i < nextOld; i++) if (!used.has(i)) free.push(i);
    for (let n = j, f = 0; n < k && f < free.length; n++, f++) { match[n] = free[f]!; used.add(free[f]!); }
    j = k;
  }
  return match;
}

// ---- the note in memory, for one transaction ----

type ModelItem = { type: "block"; row: BlockRow } | { type: "fork"; row: BlockRow; routes: { row: RouteRow; items: ModelItem[] }[] };

/** A cell's kind and cell type when its text stands alone. */
function kindOf(text: string): BlockKind {
  const tree = noteTree(text);
  const only = tree.items.length === 1 ? tree.items[0] : undefined;
  return only?.type === "block" ? only.kind : "text";
}

class Model {
  readonly blocks = new Map<string, BlockRow>();
  readonly routes = new Map<string, RouteRow>();
  private readonly dirtyBlocks = new Set<string>();
  private readonly dirtyRoutes = new Set<string>();
  readonly ops: { op: string; target: string | null; before: unknown; after: unknown }[] = [];

  constructor(blocks: BlockRow[], routes: RouteRow[], readonly noteRev: number, readonly now: number) {
    for (const row of blocks) this.blocks.set(row.id, row);
    for (const row of routes) this.routes.set(row.id, row);
  }

  newId(): string {
    for (;;) {
      const bytes = randomBytes(6);
      let id = ID_CHARS[bytes[0]! % 26]!;
      for (let i = 1; i < 6; i++) id += ID_CHARS[bytes[i]! % 36];
      if (!this.blocks.has(id) && !this.routes.has(id) && id !== ROOT) return id;
    }
  }
  taken(id: string) { return this.blocks.has(id) || this.routes.has(id) || id === ROOT; }

  /** Live items of a container (ROOT or a route id), in order. */
  children(parent: string): BlockRow[] {
    return [...this.blocks.values()].filter((row) => row.parent === parent && row.deleted_at === null).sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
  }
  routesOf(fork: string): RouteRow[] {
    return [...this.routes.values()].filter((row) => row.branch_id === fork && row.deleted_at === null).sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
  }
  tree(parent = ROOT): ModelItem[] {
    return this.children(parent).map((row) => row.kind === "branch"
      ? { type: "fork" as const, row, routes: this.routesOf(row.id).map((route) => ({ row: route, items: this.tree(route.id) })) }
      : { type: "block" as const, row });
  }
  exportItems(items = this.tree()): ExportItem[] {
    return items.map((item) => item.type === "block"
      ? { type: "block" as const, id: item.row.id, text: item.row.text }
      : { type: "fork" as const, name: item.row.name ?? "", routes: item.routes.map((route) => ({ name: route.row.name, implicit: route.row.implicit === 1, items: this.exportItems(route.items) })) });
  }
  shape(items = this.tree(), withIds = true): unknown[] {
    return items.map((item) => item.type === "block"
      ? (withIds ? { id: item.row.id, kind: item.row.kind, text: item.row.text } : { kind: item.row.kind, text: item.row.text })
      : { fork: item.row.name, routes: routesThatCount(item.routes.map((route) => ({ ...route, implicit: route.row.implicit === 1 })))
        .map((route) => ({ name: route.row.name, implicit: route.row.implicit === 1, items: this.shape(route.items, withIds) })) });
  }

  live(id: string, what = "cell"): BlockRow {
    const row = this.blocks.get(id);
    if (!row) throw new Error(`No ${what} ${id} in this note (see app_note_outline).`);
    if (row.deleted_at !== null) throw new NoteConflict(`Cell ${id} was deleted at note rev ${row.deleted_rev}.`, { id, deleted: true, deleted_rev: row.deleted_rev, rev: row.rev, text: row.text });
    return row;
  }
  liveRoute(id: string): RouteRow {
    const row = this.routes.get(id);
    if (!row || row.deleted_at !== null) throw new Error(`No route ${id} in this note (see app_note_outline).`);
    return row;
  }
  setBlock(row: BlockRow) { this.blocks.set(row.id, row); this.dirtyBlocks.add(row.id); }
  setRoute(row: RouteRow) { this.routes.set(row.id, row); this.dirtyRoutes.add(row.id); }
  log(op: string, target: string | null, before: unknown, after: unknown) { this.ops.push({ op, target, before, after }); }

  /** Changes a cell's text (its rev goes up when the text changes). */
  writeText(row: BlockRow, text: string, op = "edit") {
    if (row.text === text) return;
    this.log(op, row.id, { text: row.text, rev: row.rev }, { text, rev: row.rev + 1 });
    this.setBlock({ ...row, text, kind: kindOf(text), rev: row.rev + 1 });
  }
  addBlock(parent: string, key: string, text: string, id = this.newId()): BlockRow {
    const row: BlockRow = { id, parent, sort_key: key, kind: kindOf(text), text, name: null, rev: 1, deleted_at: null, deleted_rev: null };
    this.setBlock(row);
    this.log("insert", id, null, { text, parent });
    return row;
  }
  /** Deletes a cell, or a fork with everything in it (tombstones). */
  remove(row: BlockRow) {
    if (row.deleted_at !== null) return;
    if (row.kind === "branch") for (const route of this.routesOf(row.id)) this.removeRoute(route);
    this.log("delete", row.id, { text: row.text, rev: row.rev, name: row.name }, null);
    this.setBlock({ ...row, deleted_at: this.now, deleted_rev: this.noteRev });
  }
  removeRoute(route: RouteRow) {
    for (const child of this.children(route.id)) this.remove(child);
    this.log("delete_route", route.id, { name: route.name, branch: route.branch_id }, null);
    this.setRoute({ ...route, deleted_at: this.now });
  }
  move(row: BlockRow, parent: string, key: string) {
    if (row.parent === parent && row.sort_key === key) return;
    if (row.parent !== parent) this.log("move", row.id, { parent: row.parent }, { parent });
    this.setBlock({ ...row, parent, sort_key: key });
  }

  /** The key for a new item at a place: after / before an item, at the start or end of a route (or of the note). */
  place(at: { after?: string; before?: string; route?: string; start?: boolean }): { parent: string; key: string } {
    if (at.after || at.before) {
      const anchor = this.live((at.after ?? at.before)!, "cell or branch");
      const siblings = this.children(anchor.parent);
      const index = siblings.findIndex((row) => row.id === anchor.id);
      if (at.after) return { parent: anchor.parent, key: keyBetween(anchor.sort_key, siblings[index + 1]?.sort_key ?? null) };
      return { parent: anchor.parent, key: keyBetween(siblings[index - 1]?.sort_key ?? null, anchor.sort_key) };
    }
    const parent = at.route ? this.liveRoute(at.route).id : ROOT;
    const siblings = this.children(parent);
    if (at.start) return { parent, key: keyBetween(null, siblings[0]?.sort_key ?? null) };
    return { parent, key: keyBetween(siblings[siblings.length - 1]?.sort_key ?? null, null) };
  }
  /** Keys for `n` items in a row at a place. */
  placeMany(at: Parameters<Model["place"]>[0], n: number): { parent: string; keys: string[] } {
    const first = this.place(at);
    const siblings = this.children(first.parent);
    const next = siblings.find((row) => row.sort_key > first.key)?.sort_key ?? null;
    const keys: string[] = [];
    let previous: string | null = siblings.filter((row) => row.sort_key < first.key).pop()?.sort_key ?? null;
    for (let i = 0; i < n; i++) { previous = keyBetween(previous, next); keys.push(previous); }
    return { parent: first.parent, keys };
  }

  /** The routes (and forks) holding an item, outermost first. */
  path(row: BlockRow): NotePathStep[] {
    const steps: NotePathStep[] = [];
    let parent = row.parent;
    while (parent !== ROOT) {
      const route = this.routes.get(parent);
      if (!route) break;
      const fork = this.blocks.get(route.branch_id);
      if (!fork) break;
      steps.unshift({ fork: fork.name ?? "", forkId: fork.id, route: route.name, routeId: route.id });
      parent = fork.parent;
    }
    return steps;
  }
  /** Is `id` (a block or route) inside fork `fork`? */
  inside(container: string, fork: string): boolean {
    let parent = container;
    while (parent !== ROOT) {
      const route = this.routes.get(parent);
      if (!route) return false;
      if (route.branch_id === fork) return true;
      parent = this.blocks.get(route.branch_id)?.parent ?? ROOT;
    }
    return false;
  }

  /** The note never ends up with nothing in it, nor with an empty unnamed first route beside named ones (the file cannot hold either). */
  tidy() {
    for (const fork of [...this.blocks.values()].filter((row) => row.kind === "branch" && row.deleted_at === null)) {
      const routes = this.routesOf(fork.id);
      const first = routes[0];
      if (first && first.implicit === 1 && routes.length > 1 && this.children(first.id).length === 0) this.setRoute({ ...first, deleted_at: this.now });
    }
    if (!this.children(ROOT).length) this.addBlock(ROOT, keyBetween(null, null), "");
  }

  save(db: DatabaseSync) {
    const block = db.prepare("INSERT INTO blocks (id, parent, sort_key, kind, text, name, rev, deleted_at, deleted_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent, sort_key=excluded.sort_key, kind=excluded.kind, text=excluded.text, name=excluded.name, rev=excluded.rev, deleted_at=excluded.deleted_at, deleted_rev=excluded.deleted_rev");
    for (const id of this.dirtyBlocks) {
      const r = this.blocks.get(id)!;
      block.run(r.id, r.parent, r.sort_key, r.kind, r.text, r.name, r.rev, r.deleted_at, r.deleted_rev);
    }
    const route = db.prepare("INSERT INTO routes (id, branch_id, name, sort_key, rev, implicit, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET branch_id=excluded.branch_id, name=excluded.name, sort_key=excluded.sort_key, rev=excluded.rev, implicit=excluded.implicit, deleted_at=excluded.deleted_at");
    for (const id of this.dirtyRoutes) {
      const r = this.routes.get(id)!;
      route.run(r.id, r.branch_id, r.name, r.sort_key, r.rev, r.implicit, r.deleted_at);
    }
  }
  get changed() { return this.dirtyBlocks.size + this.dirtyRoutes.size > 0; }
  changedBlocks(): string[] { return [...this.dirtyBlocks]; }
}

// ---- taking a parsed note (a whole save, or an edit made in note.md) into the model ----

interface Taken { blocks: Map<TreeBlock, string>; forks: Map<TreeFork, string>; routes: Map<TreeRoute, string> }

function flattenTree(items: readonly TreeItem[], blocks: TreeBlock[] = [], forks: TreeFork[] = []) {
  for (const item of items) {
    if (item.type === "block") blocks.push(item);
    else { forks.push(item); for (const route of item.routes) flattenTree(route.items, blocks, forks); }
  }
  return { blocks, forks };
}
function flattenModel(items: readonly ModelItem[], blocks: BlockRow[] = [], forks: BlockRow[] = []) {
  for (const item of items) {
    if (item.type === "block") blocks.push(item.row);
    else { forks.push(item.row); for (const route of item.routes) flattenModel(route.items, blocks, forks); }
  }
  return { blocks, forks };
}

/** Which ids the parts of a parsed note are: the ids its cell lines carry (once each), else the closest old cell, fork, route. */
function matchTree(model: Model, tree: readonly TreeItem[]): Taken {
  const fresh = flattenTree(tree);
  const old = flattenModel(model.tree());
  const taken: Taken = { blocks: new Map(), forks: new Map(), routes: new Map() };
  const claimed = new Set<string>();
  for (const block of fresh.blocks) {
    const id = block.id;
    if (!id || !VALID_ID.test(id) || claimed.has(id)) continue;
    const row = model.blocks.get(id);
    if (row ? row.kind === "branch" : model.routes.has(id) || id === ROOT) continue;
    taken.blocks.set(block, id);
    claimed.add(id);
  }
  const oldFree = old.blocks.filter((row) => !claimed.has(row.id));
  const newFree = fresh.blocks.filter((block) => !taken.blocks.has(block));
  // A text that carries ids says which cells it kept: one whose id is gone was removed, so a new cell never takes its
  // place by position (only the same text, a cell whose id line was lost, is the same cell).
  align(oldFree, newFree, (o, n) => o.text === n.text, claimed.size === 0).forEach((index, j) => {
    if (index !== null) { taken.blocks.set(newFree[j]!, oldFree[index]!.id); claimed.add(oldFree[index]!.id); }
  });
  align(old.forks, fresh.forks, (o, n) => o.name === n.name).forEach((index, j) => {
    if (index !== null) taken.forks.set(fresh.forks[j]!, old.forks[index]!.id);
  });
  for (const fork of fresh.forks) {
    const forkId = taken.forks.get(fork);
    if (!forkId) continue;
    const oldRoutes = model.routesOf(forkId);
    const used = new Set<string>();
    for (const route of fork.routes) {
      const same = oldRoutes.find((row) => !used.has(row.id) && row.name === route.name && (row.implicit === 1) === route.implicit);
      if (same) { taken.routes.set(route, same.id); used.add(same.id); }
    }
    const left = oldRoutes.filter((row) => !used.has(row.id));
    for (const route of fork.routes) {
      if (taken.routes.has(route)) continue;
      const next = left.shift();
      if (next) taken.routes.set(route, next.id);
    }
  }
  return taken;
}

/** Makes the model hold `tree`: matched cells keep their ids (and revs, unless their text changed), the rest are new or tombstoned. */
function applyTree(model: Model, tree: readonly TreeItem[]): void {
  const taken = matchTree(model, tree);
  const keep = new Set<string>();
  const placeItems = (items: readonly TreeItem[], parent: string) => {
    const keys = evenKeys(items.length);
    items.forEach((item, index) => {
      const key = keys[index]!;
      if (item.type === "block") {
        const id = taken.blocks.get(item) ?? model.newId();
        keep.add(id);
        const row = model.blocks.get(id);
        if (!row) { model.addBlock(parent, key, item.text, id); return; }
        let next = row;
        if (row.deleted_at !== null) { model.log("restore", id, null, null); next = { ...row, deleted_at: null, deleted_rev: null }; model.setBlock(next); }
        model.move(next, parent, key);
        model.writeText(model.blocks.get(id)!, item.text);
        return;
      }
      const id = taken.forks.get(item) ?? model.newId();
      keep.add(id);
      const row = model.blocks.get(id);
      if (!row) {
        model.setBlock({ id, parent, sort_key: key, kind: "branch", text: "", name: item.name, rev: 1, deleted_at: null, deleted_rev: null });
        model.log("branch", id, null, { name: item.name });
      } else {
        model.move(row, parent, key);
        const now = model.blocks.get(id)!;
        if (now.name !== item.name) { model.log("rename", id, { name: now.name }, { name: item.name }); model.setBlock({ ...now, name: item.name, rev: now.rev + 1 }); }
      }
      const routeKeys = evenKeys(item.routes.length);
      item.routes.forEach((route, r) => {
        const routeId = taken.routes.get(route) ?? model.newId();
        keep.add(routeId);
        const old = model.routes.get(routeId);
        const implicit = route.implicit ? 1 : 0;
        if (!old) model.setRoute({ id: routeId, branch_id: id, name: route.name, sort_key: routeKeys[r]!, rev: 1, implicit, deleted_at: null });
        else if (old.name !== route.name || old.sort_key !== routeKeys[r] || old.implicit !== implicit || old.branch_id !== id || old.deleted_at !== null) {
          model.setRoute({ ...old, branch_id: id, name: route.name, sort_key: routeKeys[r]!, implicit, deleted_at: null, rev: old.name !== route.name ? old.rev + 1 : old.rev });
        }
        placeItems(route.items, routeId);
      });
    });
  };
  placeItems(tree, ROOT);
  // Whatever the new note no longer has goes (cells first, then empty forks and routes).
  for (const row of [...model.blocks.values()]) if (row.deleted_at === null && row.kind !== "branch" && !keep.has(row.id)) model.remove(row);
  for (const row of [...model.routes.values()]) if (row.deleted_at === null && !keep.has(row.id)) model.removeRoute(row);
  for (const row of [...model.blocks.values()]) if (row.deleted_at === null && row.kind === "branch" && !keep.has(row.id)) model.remove(row);
}

/** The cells a piece of text makes when it stands alone (an edit, an insert): no forks in it. */
function piecesOf(text: string): string[] {
  const tree = noteTree(text);
  if (tree.items.some((item) => item.type === "fork")) throw new Error("The text has branch / route / end branch lines: use app_note_branch to make or change branches.");
  const blocks = tree.items as TreeBlock[];
  return blocks.length ? blocks.map((block) => block.text) : [""];
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Where a note's database is: note.db beside note.md. */
export function noteDbPath(noteFile: string): string {
  return join(dirname(noteFile), `${basename(noteFile).replace(/\.md$/i, "")}.db`);
}

// ---- one note ----

export interface NoteTx<T> { (model: Model): T }
export interface WriteResult { note_rev: number; changed: { id: string; rev: number; deleted?: true }[]; conflict_file?: string }

export class NoteDb {
  private db: DatabaseSync | null = null;

  constructor(readonly file: string, readonly bot: string, private readonly hooks: NoteDbHooks = {}) {}

  private now() { return this.hooks.now?.() ?? Date.now(); }
  private log(message: string) { this.hooks.log?.(`note ${this.bot}: ${message}`); }

  /** Opens note.db, moving the note in first when there is none. */
  open(): DatabaseSync {
    if (this.db) return this.db;
    const path = noteDbPath(this.file);
    const fresh = !existsSync(path);
    if (fresh) readNote(this.file);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;");
      db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, bot TEXT NOT NULL, rev INTEGER NOT NULL, schema_version INTEGER NOT NULL, mode TEXT NOT NULL, mode_reason TEXT, exported_text TEXT, exported_mtime REAL, migrated_at INTEGER);
        CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, parent TEXT NOT NULL, sort_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, name TEXT, rev INTEGER NOT NULL, deleted_at INTEGER, deleted_rev INTEGER);
        CREATE INDEX IF NOT EXISTS blocks_parent ON blocks(parent, sort_key);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, name TEXT NOT NULL, sort_key TEXT NOT NULL, rev INTEGER NOT NULL, implicit INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
        CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, note_rev INTEGER NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, target TEXT, before TEXT, after TEXT, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ops_target ON ops(target);`);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    if (fresh || !this.row()) this.migrate();
    return db;
  }

  close() { this.db?.close(); this.db = null; }

  private row(): NoteRow | null {
    return (this.db!.prepare("SELECT * FROM notes WHERE id = 'note'").get() as NoteRow | undefined) ?? null;
  }
  private setRow(fields: Partial<NoteRow>) {
    const keys = Object.keys(fields);
    this.db!.prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 'note'`).run(...keys.map((k) => (fields as Record<string, never>)[k]));
  }
  private load(rev: number): Model {
    const blocks = this.db!.prepare("SELECT * FROM blocks").all() as unknown as BlockRow[];
    const routes = this.db!.prepare("SELECT * FROM routes").all() as unknown as RouteRow[];
    return new Model(blocks.map((row) => ({ ...row })), routes.map((row) => ({ ...row })), rev, this.now());
  }

  get mode(): NoteMode { this.open(); return this.row()!.mode; }
  get modeReason(): string | null { this.open(); return this.row()!.mode_reason; }
  get rev(): number { this.open(); return this.row()!.rev; }

  /** The model at this rev, for reading. */
  model(): Model { this.open(); this.sync(); return this.load(this.row()!.rev); }

  /** Moves note.md in (see the file's head). */
  private migrate() {
    const db = this.db!;
    const now = this.now();
    const text = readFileSync(this.file, "utf8");
    db.prepare("INSERT OR REPLACE INTO notes (id, bot, rev, schema_version, mode, mode_reason, exported_text, exported_mtime, migrated_at) VALUES ('note', ?, 0, ?, 'file', NULL, NULL, NULL, NULL)").run(this.bot, NOTE_SCHEMA);
    if (text.trim()) {
      let backup = `${this.file}.pre-sqlite-${stamp(now).slice(0, 8)}`;
      for (let n = 2; existsSync(backup); n++) backup = `${this.file}.pre-sqlite-${stamp(now).slice(0, 8)}-${n}`;
      copyFileSync(this.file, backup);
    }
    const reason = this.takeIn(text, "migrate");
    if (reason) {
      this.setRow({ mode: "file", mode_reason: reason });
      this.log(`stays in file mode: ${reason}`);
    } else {
      this.setRow({ migrated_at: now });
    }
  }

  /**
   * Takes `text` into the database as the whole note (moving in, switching back to database mode, an edit made in the
   * file, a whole save) and exports it. Null when done; else why it could not (nothing changed then).
   */
  private takeIn(text: string, actor: string): string | null {
    const tree = noteTree(text);
    let done: string | null = null;
    try {
      this.transaction(actor, (model) => {
        applyTree(model, tree.items);
        // What was read must read back the same once exported, with or without ids.
        const plain = exportNote(model.exportItems(), { ids: false });
        if (JSON.stringify(treeShape(noteTree(plain).items)) !== JSON.stringify(treeShape(tree.items))) throw new Error("the note does not read back the same once written again");
      }, { mode: "db" });
    } catch (error) {
      done = (error as Error).message;
    }
    return done;
  }

  /**
   * One change: a transaction on the model that must read back the same once exported with ids; the note's rev goes up,
   * the ops are logged and note.md is written again. A note in file mode refuses (unless `mode` makes it db).
   */
  transaction<T>(actor: string, change: NoteTx<T>, options: { mode?: NoteMode } = {}): T & WriteResult {
    const db = this.open();
    const conflict = options.mode ? null : this.sync();
    const current = this.row()!;
    if (current.mode !== "db" && options.mode !== "db") throw new Error(`This note is in file mode${current.mode_reason ? ` (${current.mode_reason})` : ""}: read and edit ${this.file} directly.`);
    const rev = current.rev + 1;
    db.exec("BEGIN IMMEDIATE");
    let open = true;
    let result: T;
    let model: Model;
    try {
      model = this.load(rev);
      result = change(model);
      model.tidy();
      const text = exportNote(model.exportItems(), { ids: true });
      // The empty note is the empty file, which has no id line to read back.
      const withIds = text !== "";
      if (JSON.stringify(treeShape(noteTree(text).items, withIds)) !== JSON.stringify(model.shape(model.tree(), withIds))) {
        throw new Error("That change would not read back the same from note.md (a ``` fence, $$ block or <show> card left open swallows what follows it, or a card shares a cell with text). Nothing was changed.");
      }
      if (!model.changed && current.mode === "db") {
        db.exec("ROLLBACK");
        open = false;
        return { ...(result as object), note_rev: current.rev, changed: [], ...(conflict ? { conflict_file: conflict } : {}) } as T & WriteResult;
      }
      model.save(db);
      const op = db.prepare("INSERT INTO ops (note_rev, actor, op, target, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const entry of model.ops) op.run(rev, actor, entry.op, entry.target, entry.before === null ? null : JSON.stringify(entry.before), entry.after === null ? null : JSON.stringify(entry.after), model.now);
      this.setRow({ rev, mode: "db", mode_reason: null, exported_text: text });
      // note.md before the commit: should the commit fail, the file holds the change and comes back in as an edit made there.
      writeNote(this.file, text);
      db.exec("COMMIT");
      open = false;
    } catch (error) {
      if (open) db.exec("ROLLBACK");
      throw error;
    }
    this.fileWritten();
    const changed = model.changedBlocks().map((id) => {
      const row = model.blocks.get(id)!;
      return row.deleted_at !== null ? { id, rev: row.rev, deleted: true as const } : { id, rev: row.rev };
    });
    return { ...(result as object), note_rev: rev, changed, ...(conflict ? { conflict_file: conflict } : {}) } as T & WriteResult;
  }

  private writeFile(text: string) {
    writeNote(this.file, text);
    this.fileWritten();
  }
  private fileWritten() {
    const mtime = statSync(this.file).mtimeMs;
    this.setRow({ exported_mtime: mtime });
    this.hooks.exported?.(mtime);
  }

  /**
   * Takes in an edit someone made in note.md since the app last wrote it. Cells come back by id; an edit made against an
   * older copy of a cell (its text one it had before, or a deleted cell back) is not taken: the file is kept as
   * note.conflict-<time>.md and note.md is written again. Returns the conflict file, if any.
   */
  sync(): string | null {
    this.open();
    const row = this.row()!;
    if (row.mode !== "db") return null;
    let mtime: number | null = null;
    try { mtime = statSync(this.file).mtimeMs; } catch { /* removed */ }
    if (mtime === null) { this.writeFile(row.exported_text ?? ""); return null; }
    if (mtime === row.exported_mtime) return null;
    const text = readFileSync(this.file, "utf8");
    if (text === row.exported_text) { this.setRow({ exported_mtime: mtime }); return null; }
    const stale = this.staleIn(text);
    if (stale) return this.conflict(text, stale);
    const reason = this.takeIn(text, "file");
    if (reason) return this.conflict(text, reason);
    return null;
  }

  /** Why `text` (note.md as someone left it) is an older copy, or null. */
  private staleIn(text: string): string | null {
    const model = this.load(this.row()!.rev);
    const history = this.db!.prepare("SELECT before FROM ops WHERE target = ? AND before IS NOT NULL");
    for (const block of flattenTree(noteTree(text).items).blocks) {
      if (!block.id || !block.text.trim()) continue;
      const row = model.blocks.get(block.id);
      if (!row || row.kind === "branch") continue;
      if (row.deleted_at !== null) return `cell ${block.id} was deleted at note rev ${row.deleted_rev}`;
      if (row.text === block.text) continue;
      const older = (history.all(block.id) as { before: string }[]).some((entry) => { try { return (JSON.parse(entry.before) as { text?: string }).text === block.text; } catch { return false; } });
      if (older) return `cell ${block.id} has an older text than its rev ${row.rev}`;
    }
    return null;
  }

  private conflict(text: string, reason: string): string {
    let file = join(dirname(this.file), `note.conflict-${stamp(this.now())}.md`);
    for (let n = 2; existsSync(file); n++) file = join(dirname(this.file), `note.conflict-${stamp(this.now())}-${n}.md`);
    writeFileSync(file, text);
    this.writeFile(this.row()!.exported_text ?? "");
    this.log(`an edit made in note.md was not taken (${reason}); kept as ${file}`);
    this.hooks.conflict?.(file, reason);
    return file;
  }

  // ---- the Note tab (notes.read / notes.write), unchanged for it ----

  /** The note as the Note tab reads it: without ids; mtime is note.md's, the base of its next save. */
  readPlain(): NoteState {
    this.open();
    this.sync();
    const row = this.row()!;
    if (row.mode !== "db") return readNote(this.file);
    const model = this.load(row.rev);
    return { path: this.file, text: exportNote(model.exportItems(), { ids: false }), mtime: row.exported_mtime ?? 0 };
  }

  /** A whole save from the Note tab: refused (with the note now) when it was based on an older note. */
  writePlain(text: string, base?: number): NoteWrite {
    this.open();
    this.sync();
    const row = this.row()!;
    if (row.mode !== "db") return writeNote(this.file, text, base);
    const now = this.readPlain();
    if (base !== undefined && base !== now.mtime) return { saved: false, text: now.text, mtime: now.mtime };
    if (text === now.text) return { saved: true, mtime: now.mtime };
    try {
      this.transaction("editor", (model) => applyTree(model, noteTree(text).items));
    } catch (error) {
      // Never lose the user's words: the note goes back to file mode with them.
      const reason = (error as Error).message;
      this.log(`a save could not be kept in note.db (${reason}); the note is in file mode now`);
      this.setRow({ mode: "file", mode_reason: reason });
      return writeNote(this.file, text);
    }
    return { saved: true, mtime: this.row()!.exported_mtime ?? 0 };
  }

  /** Switches the note: "file" writes note.md without ids and leaves note.db as it is; "db" takes note.md in again. */
  setMode(mode: NoteMode): { mode: NoteMode; reason: string | null } {
    this.open();
    const row = this.row()!;
    if (mode === row.mode) return { mode, reason: row.mode_reason };
    if (mode === "file") {
      this.sync();
      const plain = this.readPlain().text;
      this.setRow({ mode: "file", mode_reason: "switched to file mode" });
      writeNote(this.file, plain);
      this.log("switched to file mode");
      return { mode: "file", reason: "switched to file mode" };
    }
    const reason = this.takeIn(readNote(this.file).text, "mode");
    if (reason) { this.setRow({ mode_reason: reason }); return { mode: "file", reason }; }
    this.log("switched to database mode");
    return { mode: "db", reason: null };
  }

  /**
   * Ids for the Note tab's cells and forks, with their lines (0-based) in the text it has: `text` (the editor's words,
   * saved or not: cells matched the way a save would, null for a new one) or, without, the note as notes.read gives it.
   */
  outlineLines(text?: string) {
    const model = this.model();
    const row = this.row()!;
    if (row.mode !== "db") {
      const note = readNote(this.file);
      return { mode: row.mode, reason: row.mode_reason, rev: row.rev, mtime: note.mtime, ...(text === undefined ? { text: note.text } : {}), cells: [], forks: [] };
    }
    const plain = text ?? exportNote(model.exportItems(), { ids: false });
    const tree = noteTree(plain);
    const taken = matchTree(model, tree.items);
    const cells: unknown[] = [];
    const forks: unknown[] = [];
    const walk = (items: readonly TreeItem[], path: NotePathStep[]) => {
      for (const item of items) {
        if (item.type === "block") {
          const id = taken.blocks.get(item) ?? null;
          const known = id ? model.blocks.get(id) : undefined;
          cells.push({ id, rev: known && known.deleted_at === null && known.text === item.text ? known.rev : null, kind: item.kind, type: item.cell, start: item.start, end: item.end, path, label: label(id, path) });
        } else {
          const id = taken.forks.get(item) ?? null;
          forks.push({
            id, name: item.name, start: item.start, end: item.endLine, path,
            routes: item.routes.map((route) => ({ id: taken.routes.get(route) ?? null, name: route.name, implicit: route.implicit, start: route.marker >= 0 ? route.marker : route.start, end: route.end })),
          });
          for (const route of item.routes) walk(route.items, [...path, { fork: item.name, forkId: id ?? "", route: route.name, routeId: taken.routes.get(route) ?? "" }]);
        }
      }
    };
    walk(tree.items, []);
    return { mode: row.mode, reason: row.mode_reason, rev: row.rev, mtime: row.exported_mtime ?? 0, ...(text === undefined ? { text: plain } : {}), cells, forks };
  }
}

/** "Note #b7k3f9 · Loading › Lazy load": how a quote names a cell. */
export function label(id: string | null, path: readonly NotePathStep[]): string {
  const where = path.map((step) => `${step.fork} › ${step.route}`).join(" › ");
  return `Note${id ? ` #${id}` : ""}${where ? ` · ${where}` : ""}`;
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
