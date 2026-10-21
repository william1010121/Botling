import { describe, expect, it } from "vitest";
import { arrange, cellFor, clampTarget, drop, overlaps, pushDown, resize, trailingCell, type Tile } from "../src/board-layout";

const tile = (id: string, col: number, row: number, w = 1, h = 1): Tile => ({ id, col, row, w, h });
const at = (tiles: Tile[]) => Object.fromEntries(tiles.map((t) => [t.id, [t.col, t.row, t.w, t.h]]));
const noOverlaps = (tiles: Tile[]) => tiles.every((a, i) => tiles.every((b, j) => i === j || !overlaps(a, b)));

describe("arranging the Board", () => {
  it("tiles without a place are packed as the old dense grid drew them (migration changes nothing)", () => {
    // 4 columns: a 4×2, then a 2×1, a 1×2 and a 1×1 fill in row by row, gaps first.
    const items = [{ id: "A", w: 4, h: 2 }, { id: "B", w: 2, h: 1 }, { id: "C", w: 1, h: 2 }, { id: "D", w: 1, h: 1 }];
    expect(at(arrange(items, 4))).toEqual({ A: [0, 0, 4, 2], B: [0, 2, 2, 1], C: [2, 2, 1, 2], D: [3, 2, 1, 1] });
    // Dense fills an earlier hole: a 3×1 leaves one cell that the later 1×1 takes.
    expect(at(arrange([{ id: "A", w: 3, h: 1 }, { id: "B", w: 2, h: 1 }, { id: "C", w: 1, h: 1 }], 4))).toEqual({ A: [0, 0, 3, 1], B: [0, 1, 2, 1], C: [3, 0, 1, 1] });
    // A tile wider than the Board spans all its columns.
    expect(at(arrange([{ id: "A", w: 4, h: 2 }], 2))).toEqual({ A: [0, 0, 2, 2] });
  });

  it("kept places stay where they are, gaps and all; new tiles take the first free cells", () => {
    const tiles = arrange([{ id: "A", w: 2, h: 2, at: { col: 2, row: 1 } }, { id: "B", w: 1, h: 1, at: { col: 0, row: 3 } }, { id: "N", w: 1, h: 1 }], 4);
    expect(at(tiles)).toEqual({ A: [2, 1, 2, 2], B: [0, 3, 1, 1], N: [0, 0, 1, 1] });
  });

  it("a place past a narrower Board's edge moves left just enough; a clash goes to the next free cells", () => {
    expect(at(arrange([{ id: "A", w: 2, h: 1, at: { col: 5, row: 0 } }], 4))).toEqual({ A: [2, 0, 2, 1] });
    const tiles = arrange([{ id: "A", w: 2, h: 1, at: { col: 0, row: 0 } }, { id: "B", w: 2, h: 1, at: { col: 1, row: 0 } }], 3);
    expect(at(tiles)).toEqual({ A: [0, 0, 2, 1], B: [0, 1, 2, 1] });
    expect(noOverlaps(tiles)).toBe(true);
  });
});

describe("dropping a tile", () => {
  const board = () => [tile("A", 0, 0, 2, 2), tile("B", 2, 0), tile("C", 3, 0), tile("D", 0, 2, 1, 1)];

  it("goes onto any free cells, leaving gaps; nothing else moves", () => {
    const result = drop(board(), "A", { col: 2, row: 1 }, 4);
    expect(result.mode).toBe("free");
    expect(at(result.tiles)).toEqual({ A: [2, 1, 2, 2], B: [2, 0, 1, 1], C: [3, 0, 1, 1], D: [0, 2, 1, 1] });
  });

  it("swaps with the one tile there when that tile fits where the dragged one was", () => {
    const result = drop(board(), "D", { col: 3, row: 0 }, 4);
    expect(result.mode).toBe("swap");
    expect(at(result.tiles)).toEqual({ A: [0, 0, 2, 2], B: [2, 0, 1, 1], C: [0, 2, 1, 1], D: [3, 0, 1, 1] });
    // A 2×2 onto a 1×1: the 1×1 takes the 2×2's top-left cell.
    const big = drop([tile("A", 0, 0, 2, 2), tile("B", 2, 0)], "A", { col: 2, row: 0 }, 4);
    expect(big.mode).toBe("swap");
    expect(at(big.tiles)).toEqual({ A: [2, 0, 2, 2], B: [0, 0, 1, 1] });
  });

  it("otherwise pushes what it overlaps straight down, and what those then overlap", () => {
    // A 2×2 onto B and C (two tiles): both go down below it; D, out of the way, stays.
    const result = drop(board(), "A", { col: 2, row: 0 }, 4);
    expect(result.mode).toBe("push");
    expect(at(result.tiles)).toEqual({ A: [2, 0, 2, 2], B: [2, 2, 1, 1], C: [3, 2, 1, 1], D: [0, 2, 1, 1] });
    expect(noOverlaps(result.tiles)).toBe(true);
    // A chain: X lands on Y, Y pushed onto Z, Z pushed further.
    const chain = drop([tile("X", 0, 3, 2, 1), tile("Y", 0, 0, 2, 1), tile("Z", 0, 1, 2, 2), tile("W", 1, 3)], "X", { col: 0, row: 0 }, 2);
    expect(chain.mode).toBe("push");
    expect(at(chain.tiles)).toEqual({ X: [0, 0, 2, 1], Y: [0, 1, 2, 1], Z: [0, 2, 2, 2], W: [1, 4, 1, 1] });
    expect(noOverlaps(chain.tiles)).toBe(true);
  });

  it("a swap that would not fit pushes instead", () => {
    // B (2×1) would not fit in the last column D (1×1) left, so B is pushed down instead.
    const tiles = [tile("B", 0, 0, 2, 1), tile("D", 3, 0)];
    const result = drop(tiles, "D", { col: 0, row: 0 }, 4);
    expect(result.mode).toBe("push");
    expect(at(result.tiles)).toEqual({ B: [0, 1, 2, 1], D: [0, 0, 1, 1] });
  });

  it("keeps the target inside the Board and no further than just below every other tile", () => {
    const tiles = board();
    expect(clampTarget(tiles, "A", { col: 9, row: 40 }, 4)).toEqual({ col: 2, row: 3 });
    expect(clampTarget(tiles, "A", { col: -3, row: -2 }, 4)).toEqual({ col: 0, row: 0 });
    expect(drop(tiles, "A", { col: 9, row: 40 }, 4).at).toEqual({ col: 2, row: 3 });
  });
});

describe("resizing and pushing", () => {
  it("a resized tile keeps its top-left cell and pushes only what it now overlaps", () => {
    const tiles = [tile("A", 1, 1), tile("B", 2, 1), tile("C", 1, 2), tile("D", 0, 0)];
    const result = resize(tiles, "A", 2, 2, 4);
    expect(at(result)).toEqual({ A: [1, 1, 2, 2], B: [2, 3, 1, 1], C: [1, 3, 1, 1], D: [0, 0, 1, 1] });
    // Never wider than the Board from where it is.
    expect(at(resize(tiles, "A", 4, 1, 4)).A).toEqual([1, 1, 3, 1]);
  });

  it("pushing never moves a tile up or sideways, nor one that overlaps nothing", () => {
    const others = [tile("P", 0, 0), tile("Q", 3, 5)];
    expect(at(pushDown(others, tile("F", 0, 0, 2, 2)))).toEqual({ P: [0, 2, 1, 1], Q: [3, 5, 1, 1] });
  });

  it("the Add tile trails the last tile in reading order, never filling a gap left before it", () => {
    expect(trailingCell([], 4)).toEqual({ col: 0, row: 0 });
    expect(trailingCell([tile("A", 0, 0), tile("B", 2, 1, 2, 1)], 4)).toEqual({ col: 0, row: 2 });
    expect(trailingCell([tile("A", 0, 0, 1, 2), tile("B", 1, 1)], 4)).toEqual({ col: 2, row: 1 });
    // Its next cell taken by a tall tile from above: the one after.
    expect(trailingCell([tile("T", 2, 0, 1, 3), tile("B", 1, 1)], 4)).toEqual({ col: 3, row: 1 });
  });

  it("the pointer's move maps to the nearest cell by arithmetic alone", () => {
    expect(cellFor({ col: 1, row: 1 }, 164 * 2 + 60, -100, 164)).toEqual({ col: 3, row: 0 });
    expect(cellFor({ col: 0, row: 0 }, 81, 83, 164)).toEqual({ col: 0, row: 1 });
    // Columns may be a little wider than rows are tall (1fr of the Board's width).
    expect(cellFor({ col: 0, row: 0 }, 170, 170, 170, 164)).toEqual({ col: 1, row: 1 });
  });
});
