/**
 * Where Board tiles sit: free placement on a grid of square cells. Every tile keeps its own
 * column and row (0-based, its top-left cell) and nothing is packed toward the left or the top,
 * so gaps a user leaves stay. Pure functions, no DOM: pins.ts draws what they say.
 *
 * The rules, the same everywhere:
 * - A tile without a place (a pin from before 1.14, or a new one) takes the first free cells
 *   reading row by row from the top-left, in pin order: exactly where the old packed Board
 *   (CSS `grid-auto-flow: dense`) drew it, so migrating changes nothing on screen.
 * - A place that no longer fits (a narrower Board: fewer columns) is drawn moved left just
 *   enough, or at the next free cells from its row; what is kept is not changed.
 * - Dropping a tile: on free cells it goes there. On cells taken by exactly one tile that fits
 *   in the cells the dragged tile left (inside the Board, overlapping nothing else), the two
 *   swap. Otherwise the tile goes there and every tile it overlaps is pushed straight down
 *   (and what those then overlap, and so on). Nothing ever moves up or sideways.
 * - Resizing a tile keeps its top-left cell and pushes what it now overlaps down, the same way.
 */

export interface Place {
  col: number;
  row: number;
}

export interface Tile extends Place {
  id: string;
  w: number;
  h: number;
}

/** A tile to lay out: its size in cells and its kept place, if it has one. */
export interface Item {
  id: string;
  w: number;
  h: number;
  at?: Place | null;
}

export function overlaps(a: Tile, b: Tile): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

const byPlace = (a: Tile, b: Tile) => a.row - b.row || a.col - b.col;

/** The first free cells for a `w`×`h` tile, row by row from `fromRow`. */
function firstFree(taken: Tile[], w: number, h: number, columns: number, fromRow: number): Place {
  for (let row = Math.max(0, fromRow); ; row++) {
    for (let col = 0; col + w <= columns; col++) {
      const tile = { id: "", w, h, col, row };
      if (!taken.some((t) => overlaps(t, tile))) return { col, row };
    }
  }
}

/** Every tile's cells on a Board `columns` wide (at least 1), in `items`' order. */
export function arrange(items: Item[], columns: number): Tile[] {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const sized = items.map((item, index) => ({ item, index, w: Math.min(Math.max(1, item.w), cols), h: Math.max(1, item.h) }));
  const out: Tile[] = new Array(items.length);
  const taken: Tile[] = [];
  // Kept places first, top to bottom (an earlier one wins a cell two claim), then the rest.
  const placed = sized.filter((s) => s.item.at).sort((a, b) => a.item.at!.row - b.item.at!.row || a.item.at!.col - b.item.at!.col || a.index - b.index);
  for (const s of placed) {
    const at = s.item.at!;
    let tile: Tile = { id: s.item.id, w: s.w, h: s.h, col: Math.max(0, Math.min(Math.floor(at.col), cols - s.w)), row: Math.max(0, Math.floor(at.row)) };
    if (taken.some((t) => overlaps(t, tile))) tile = { ...tile, ...firstFree(taken, s.w, s.h, cols, tile.row) };
    taken.push(tile);
    out[s.index] = tile;
  }
  for (const s of sized) {
    if (s.item.at) continue;
    const tile: Tile = { id: s.item.id, w: s.w, h: s.h, ...firstFree(taken, s.w, s.h, cols, 0) };
    taken.push(tile);
    out[s.index] = tile;
  }
  return out;
}

/**
 * `fixed` where it is and the others pushed straight down, each only as far as it must to clear
 * what is above it: tiles that overlap nothing do not move, so gaps stay.
 */
export function pushDown(others: Tile[], fixed: Tile): Tile[] {
  const settled: Tile[] = [fixed];
  const moved = new Map<string, Tile>();
  for (const tile of [...others].sort(byPlace)) {
    let next = tile;
    for (let hit = settled.find((t) => overlaps(t, next)); hit; hit = settled.find((t) => overlaps(t, next))) {
      next = { ...next, row: hit.row + hit.h };
    }
    settled.push(next);
    moved.set(tile.id, next);
  }
  return others.map((t) => moved.get(t.id)!);
}

export type DropMode = "free" | "swap" | "push";

export interface Drop {
  /** Where the dragged tile goes (kept inside the Board). */
  at: Place;
  mode: DropMode;
  /** Every tile afterwards, in `tiles`' order. */
  tiles: Tile[];
}

/** The cells a dragged tile may go to: inside the Board's columns, and no further down than just below every other tile. */
export function clampTarget(tiles: Tile[], id: string, target: Place, columns: number): Place {
  const tile = tiles.find((t) => t.id === id);
  if (!tile) return target;
  const bottom = tiles.reduce((most, t) => (t.id === id ? most : Math.max(most, t.row + t.h)), 0);
  return {
    col: Math.max(0, Math.min(Math.round(target.col), Math.max(1, columns) - tile.w)),
    row: Math.max(0, Math.min(Math.round(target.row), bottom)),
  };
}

/** What dropping tile `id` at `target` does (see the rules at the top). */
export function drop(tiles: Tile[], id: string, target: Place, columns: number): Drop {
  const moving = tiles.find((t) => t.id === id);
  if (!moving) return { at: target, mode: "free", tiles };
  const at = clampTarget(tiles, id, target, columns);
  const placed: Tile = { ...moving, ...at };
  const others = tiles.filter((t) => t.id !== id);
  const hits = others.filter((t) => overlaps(t, placed));
  const result = (mode: DropMode, changed: Tile[]): Drop => {
    const by = new Map(changed.map((t) => [t.id, t]));
    return { at, mode, tiles: tiles.map((t) => (t.id === id ? placed : by.get(t.id) ?? t)) };
  };
  if (hits.length === 0) return result("free", []);
  if (hits.length === 1) {
    const hit = hits[0];
    const swapped: Tile = { ...hit, col: moving.col, row: moving.row };
    const fits = swapped.col + swapped.w <= Math.max(1, columns) && !overlaps(swapped, placed) && !others.some((t) => t.id !== hit.id && overlaps(t, swapped));
    if (fits) return result("swap", [swapped]);
  }
  return result("push", pushDown(others, placed));
}

/** Tile `id` at `w`×`h` (no wider than the Board from where it is), top-left kept, what it overlaps pushed down. */
export function resize(tiles: Tile[], id: string, w: number, h: number, columns: number): Tile[] {
  const tile = tiles.find((t) => t.id === id);
  if (!tile) return tiles;
  const grown: Tile = { ...tile, w: Math.max(1, Math.min(w, Math.max(1, columns) - tile.col)), h: Math.max(1, h) };
  const others = tiles.filter((t) => t.id !== id);
  const pushed = new Map(pushDown(others, grown).map((t) => [t.id, t]));
  return tiles.map((t) => (t.id === id ? grown : pushed.get(t.id)!));
}

/**
 * The cell a dragged tile's top-left is nearest, from where it started (`from`) and how far the
 * pointer has moved in px; a pitch is a cell and a gap, across and down. Only arithmetic:
 * nothing is measured.
 */
export function cellFor(from: Place, dx: number, dy: number, pitchX: number, pitchY = pitchX): Place {
  return { col: Math.round(from.col + dx / pitchX), row: Math.round(from.row + dy / pitchY) };
}

/**
 * Where the Board's Add tile (one cell) goes: the first free cell after the last tile in reading
 * order (row by row), so it trails the tiles and never fills a gap a user left on purpose.
 */
export function trailingCell(tiles: Tile[], columns: number): Place {
  const cols = Math.max(1, columns);
  const last = tiles.reduce<Tile | null>((most, t) => (!most || t.row > most.row || (t.row === most.row && t.col > most.col) ? t : most), null);
  if (!last) return { col: 0, row: 0 };
  for (let row = last.row, col = last.col + last.w; ; col++) {
    if (col >= cols) {
      col = -1;
      row++;
      continue;
    }
    const cell: Tile = { id: "", col, row, w: 1, h: 1 };
    if (!tiles.some((t) => overlaps(t, cell))) return { col, row };
  }
}
