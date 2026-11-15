// The tree model of a Note kept in SQLite: ids and sort keys, the in-memory `Model` of one transaction, and taking a parsed
// note into it (`matchTree`, `applyTree`). Moved out of note-db.ts (M7-S14a); `NoteDb` stays there, and note-db.ts still
// exports every name it exported before.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { noteTree, routesThatCount, type BlockKind, type ExportItem, type TreeBlock, type TreeFork, type TreeItem, type TreeRoute } from "./note-cells";

export const NOTE_SCHEMA = 1;
export const ROOT = "root";
export type NoteMode = "db" | "file";

export interface BlockRow {
  id: string; parent: string; sort_key: string; kind: BlockKind | "branch"; text: string; name: string | null;
  rev: number; deleted_at: number | null; deleted_rev: number | null;
}
export interface RouteRow { id: string; branch_id: string; name: string; sort_key: string; rev: number; implicit: number; deleted_at: number | null }
export interface NoteRow { id: string; bot: string; rev: number; schema_version: number; mode: NoteMode; mode_reason: string | null; exported_text: string | null; exported_mtime: number | null; migrated_at: number | null }

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

export type ModelItem = { type: "block"; row: BlockRow } | { type: "fork"; row: BlockRow; routes: { row: RouteRow; items: ModelItem[] }[] };

/** A cell's kind and cell type when its text stands alone. */
function kindOf(text: string): BlockKind {
  const tree = noteTree(text);
  const only = tree.items.length === 1 ? tree.items[0] : undefined;
  return only?.type === "block" ? only.kind : "text";
}

export class Model {
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

export function flattenTree(items: readonly TreeItem[], blocks: TreeBlock[] = [], forks: TreeFork[] = []) {
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
/** A cell's text without the blank (or whitespace-only) lines before its first line and after its last. */
export function withoutBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "").replace(/^[ \t]+$/, "");
}

export function matchTree(model: Model, tree: readonly TreeItem[]): Taken {
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
  // Blank lines at a cell's edges do not count: the Note tab's drag leaves the blank lines around a cell line where they were.
  align(oldFree, newFree, (o, n) => o.text === n.text || withoutBlankEdges(o.text) === withoutBlankEdges(n.text), claimed.size === 0).forEach((index, j) => {
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
export function applyTree(model: Model, tree: readonly TreeItem[]): void {
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
