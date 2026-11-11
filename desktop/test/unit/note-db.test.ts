// A bot's Note in SQLite (note-db.ts, note-cells.ts): moving an existing note.md in reads back the same (branches,
// cards, frozen pictures, code), cells keep their ids through edits, a stale rev is refused with what is there now, an
// edit made in note.md comes back by id (an older copy is kept as a conflict file), and the Note tab's notes.read /
// notes.write keep working on plain text.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers";
import { NoteConflict, NoteDb, align, branch, edit, evenKeys, insert, keyBetween, merge, move, noteDbPath, outline, read, remove, search, split } from "../../src/core/note-db";
import { cellRuns, classifyLines, exportNote, noteTree, parseBranches, treeShape } from "../../src/core/note-cells";

const open: NoteDb[] = [];
afterEach(() => { for (const note of open.splice(0)) note.close(); });

function noteAt(text: string | null, name = "note"): { file: string; note: NoteDb } {
  const file = join(tempDir(name), ".bot", "note.md");
  mkdirSync(dirname(file), { recursive: true });
  if (text !== null) writeFileSync(file, text);
  const note = new NoteDb(file, "B1", { now: () => Date.UTC(2026, 10, 11, 9, 30) });
  open.push(note);
  note.open();
  return { file, note };
}
/** A later moment for the file's mtime, so an edit made "by someone else" is seen. */
function later(file: string, seconds = 5) { utimesSync(file, Date.now() / 1000 + seconds, Date.now() / 1000 + seconds); }

const REAL = [
  "# 專案筆記",
  "",
  "要先確認的事：",
  "- [ ] 跑 baseline",
  "- [x] 寫 loader",
  "<!-- cell -->",
  "```python",
  "# <!-- cell --> inside code is text",
  "<!-- branch: not a fork -->",
  "print('hi')",
  "```",
  "<!-- cell -->",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "<!-- branch: Loading -->",
  "<!-- route: Eager -->",
  "全部一次載入。",
  "<show name=\"stats\">{\"rows\": 3}</show>",
  "後面的說明",
  "<!-- route: Lazy load -->",
  "每個分頁第一次打開時才載入外掛……",
  "<!-- cell -->",
  "<!-- branch: Cache -->",
  "<!-- route: memory -->",
  "| 名稱 | 數量 |",
  "| :--- | ---: |",
  "| 蘋果 | 3 |",
  "<!-- route: disk -->",
  "![frozen card](note-assets/0123456789abcdef0123456789abcdef.png)",
  "<!-- end branch -->",
  "<!-- end branch -->",
  "",
  "<show name=\"gpu\" command=\"nvidia-smi\"",
  "  refresh=\"10m\"></show>",
  "",
  "結尾",
  "",
].join("\n");

describe("note-cells: the Note tab's rules, one copy", () => {
  it("cuts cells as the editor does: code and $$ hide markers, a card is a cell of its own, ids ride on cell lines", () => {
    const lines = REAL.split("\n");
    const info = classifyLines(lines);
    const meta = parseBranches(lines, info);
    expect(meta.forks.map((fork) => [fork.name, fork.key, fork.routes.map((route) => route.name)])).toEqual([
      ["Loading", "Loading#1", ["Eager", "Lazy load"]],
      ["Cache", "Loading#1/Lazy load>Cache#1", ["memory", "disk"]],
    ]);
    const { runs } = cellRuns(lines, info, meta);
    const texts = runs.map((run) => lines.slice(run.start, run.end + 1).join("\n"));
    expect(texts[1]).toContain("<!-- branch: not a fork -->");
    expect(runs.map((run) => run.type)).toEqual(["markdown", "code", "math", "markdown", "card", "markdown", "markdown", "table", "markdown", "card", "markdown"]);
    expect(runs[4]!.softAbove).toBe(true);
    const ided = cellRuns(["<!-- cell: b7k3f9 -->", "x", "<!-- cell -->", "y"], classifyLines(["", "x", "", "y"]), { at: [{ marker: null, path: [] }, { marker: null, path: [] }, { marker: null, path: [] }, { marker: null, path: [] }] });
    expect(ided.runs.map((run) => run.id)).toEqual(["b7k3f9", null]);
  });

  it("a tree exports back to the same shape, with or without ids", () => {
    const tree = noteTree(REAL);
    const plain = exportNote(tree.items);
    expect(treeShape(noteTree(plain).items)).toEqual(treeShape(tree.items));
    expect(exportNote(noteTree("a\n<!-- cell -->\nb\n").items)).toBe("a\n<!-- cell -->\nb\n");
    expect(exportNote(noteTree("").items)).toBe("");
  });

  it("sort keys always have room between; align keeps equal ones and pairs the rest in place", () => {
    let a: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) { a = keyBetween(a, null); keys.push(a); }
    expect([...keys].sort()).toEqual(keys);
    expect(keyBetween("a", "b") > "a" && keyBetween("a", "b") < "b").toBe(true);
    expect(keyBetween("a", "a1") > "a").toBe(true);
    const even = evenKeys(1000);
    expect(new Set(even).size).toBe(1000);
    expect([...even].sort()).toEqual(even);
    expect(align(["A", "B", "C"], ["A", "X", "C", "B"], (o, n) => o === n)).toEqual([0, null, 2, 1]);
    expect(align(["A", "B", "C"], ["A", "B2", "C"], (o, n) => o === n)).toEqual([0, 1, 2]);
  });
});

describe("moving a note in", () => {
  it("backs note.md up, gives every cell an id, writes note.md with <!-- cell: id --> and reads back the same", () => {
    const { file, note } = noteAt(REAL);
    expect(note.mode).toBe("db");
    expect(existsSync(noteDbPath(file))).toBe(true);
    const backups = readdirSync(dirname(file)).filter((name) => name.startsWith("note.md.pre-sqlite-"));
    expect(backups).toEqual(["note.md.pre-sqlite-20261111"]);
    expect(readFileSync(join(dirname(file), backups[0]!), "utf8")).toBe(REAL);
    const exported = readFileSync(file, "utf8");
    const ids = [...exported.matchAll(/<!-- cell: ([a-z0-9]{6}) -->/g)].map((m) => m[1]);
    expect(ids).toHaveLength(11);
    expect(new Set(ids).size).toBe(11);
    // The Note tab reads plain text with the same cells, branches, cards and pictures.
    const plain = note.readPlain().text;
    expect(treeShape(noteTree(plain).items)).toEqual(treeShape(noteTree(REAL).items));
    expect(plain).not.toContain("<!-- cell: ");
    const tree = outline(note);
    expect(tree.items.map((item) => item.kind)).toEqual(["text", "text", "text", "branch", "card", "text"]);
    const loading = tree.items[3] as Extract<typeof tree.items[number], { kind: "branch" }>;
    expect(loading.routes.map((route) => [route.name, route.items.map((item) => item.kind)])).toEqual([["Eager", ["text", "card", "text"]], ["Lazy load", ["text", "branch"]]]);
    const cache = loading.routes[1]!.items[1] as typeof loading;
    expect(cache.routes[1]!.items[0]).toMatchObject({ kind: "image" });
  });

  it("an empty note moves in as the empty file; a note whose ids are in the file keeps them (rebuilt from note.md)", () => {
    const { file, note } = noteAt(null);
    expect(note.mode).toBe("db");
    expect(readFileSync(file, "utf8")).toBe("");
    expect(readdirSync(dirname(file)).filter((name) => name.includes("pre-sqlite"))).toEqual([]);
    const again = noteAt("<!-- cell: keep01 -->\nfirst\n<!-- cell: keep02 -->\nsecond\n");
    expect(outline(again.note).items.map((item) => item.id)).toEqual(["keep01", "keep02"]);
  });

  it("a note that would not read back the same stays in file mode, untouched, with the reason", () => {
    // A lone cell line holds no cell: written again it would be an empty note, not this one.
    const { file, note } = noteAt("<!-- cell -->");
    expect(note.mode).toBe("file");
    expect(note.modeReason).toMatch(/read back/);
    expect(readFileSync(file, "utf8")).toBe("<!-- cell -->");
    expect(note.readPlain().text).toBe("<!-- cell -->");
    expect(() => insert(note, "bot:B1", { text: "x" })).toThrow(/file mode/);
  });

  it("switching to file mode writes note.md without ids; back to database mode keeps the ids it can", () => {
    const { file, note } = noteAt("alpha\n<!-- cell -->\nbeta\n");
    const [a, b] = outline(note).items.map((item) => item.id);
    expect(note.setMode("file")).toEqual({ mode: "file", reason: "switched to file mode" });
    expect(readFileSync(file, "utf8")).toBe("alpha\n<!-- cell -->\nbeta\n");
    writeFileSync(file, "alpha\n<!-- cell -->\nbeta changed\n<!-- cell -->\ngamma\n");
    expect(note.setMode("db")).toEqual({ mode: "db", reason: null });
    const items = outline(note).items;
    expect(items.map((item) => item.id).slice(0, 2)).toEqual([a, b]);
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ rev: 2, first: "beta changed" });
  });
});

describe("changing a note by id", () => {
  it("edit: a whole replace needs the current rev; a stale rev is refused with the text and rev there now", () => {
    const { file, note } = noteAt("one\n<!-- cell -->\ntwo\n");
    const [a] = outline(note).items;
    const done = edit(note, "bot:B1", { id: a!.id, rev: 1, text: "one, edited" });
    expect(done.changed).toEqual([{ id: a!.id, rev: 2 }]);
    expect(readFileSync(file, "utf8")).toContain(`<!-- cell: ${a!.id} -->\none, edited`);
    let error: unknown;
    try { edit(note, "bot:B1", { id: a!.id, rev: 1, text: "late" }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(NoteConflict);
    expect((error as NoteConflict).current).toEqual({ id: a!.id, rev: 2, text: "one, edited" });
    expect((error as Error).message).toContain('"conflict":true');
    expect(() => edit(note, "bot:B1", { id: a!.id, text: "no rev" })).toThrow(/rev is required/);
  });

  it("edit: old_text → new_text needs old_text once in the cell, and no rev; text with a <show> card or a cell line splits off new cells", () => {
    const { note } = noteAt("the quick fox\n<!-- cell -->\nfox fox\n");
    const [a, b] = outline(note).items;
    edit(note, "bot:B1", { id: a!.id, old_text: "quick", new_text: "slow" });
    expect(read(note, { ids: [a!.id] }).cells[0]).toMatchObject({ text: "the slow fox", rev: 2 });
    expect(() => edit(note, "bot:B1", { id: b!.id, old_text: "fox", new_text: "cat" })).toThrow(/2 times/);
    expect(() => edit(note, "bot:B1", { id: b!.id, old_text: "wolf", new_text: "cat" })).toThrow(NoteConflict);
    const grown = edit(note, "bot:B1", { id: a!.id, rev: 2, text: "intro\n<show name=\"stats\">{}</show>\n<!-- cell -->\nmore" });
    expect(grown.added).toHaveLength(2);
    expect(outline(note).items.map((item) => item.kind)).toEqual(["text", "card", "text", "text"]);
    expect(() => edit(note, "bot:B1", { id: b!.id, old_text: "fox fox", new_text: "<!-- branch: X -->\n<!-- route: a -->\nx" })).toThrow(/app_note_branch/);
  });

  it("insert, delete (a tombstone: reading it says when it went), move", () => {
    const { note } = noteAt("A\n<!-- cell -->\nB\n");
    const [a, b] = outline(note).items;
    const added = insert(note, "bot:B1", { text: "between", after: a!.id });
    const top = insert(note, "bot:B1", { text: "top", at: "start" });
    expect(outline(note).items.map((item) => (item as { first: string }).first)).toEqual(["top", "A", "between", "B"]);
    remove(note, "bot:B1", { id: added.ids[0]! });
    expect(read(note, { ids: [added.ids[0]!] }).cells[0]).toMatchObject({ id: added.ids[0], deleted: true, text: "between" });
    expect(() => edit(note, "bot:B1", { id: added.ids[0]!, old_text: "between", new_text: "x" })).toThrow(/deleted at note rev/);
    move(note, "bot:B1", { id: top.ids[0]!, after: b!.id });
    expect(outline(note).items.map((item) => (item as { first: string }).first)).toEqual(["A", "B", "top"]);
    expect(() => remove(note, "bot:B1", { id: b!.id, rev: 9 })).toThrow(NoteConflict);
  });

  it("split at a line (the new half gets a new id), merge with the next cell; both check the rev and refuse a cut inside code", () => {
    const { note } = noteAt("one\ntwo\nthree\n<!-- cell -->\n```\na\nb\n```\n<!-- cell -->\n<show name=\"x\">{}</show>\n");
    const [text, code, card] = outline(note).items;
    expect(() => split(note, "bot:B1", { id: text!.id, rev: 3, line: 2 })).toThrow(NoteConflict);
    const cut = split(note, "bot:B1", { id: text!.id, rev: 1, line: 3 });
    expect(read(note, { ids: [text!.id, cut.new_id] }).cells.map((cell) => (cell as { text: string }).text)).toEqual(["one\ntwo", "three"]);
    expect(() => split(note, "bot:B1", { id: code!.id, rev: 1, line: 3 })).toThrow(/inside a code block/);
    const joined = merge(note, "bot:B1", { id: text!.id, rev: 2 });
    expect(joined.merged).toBe(cut.new_id);
    expect(read(note, { ids: [text!.id] }).cells[0]).toMatchObject({ text: "one\ntwo\nthree", rev: 3 });
    expect(() => merge(note, "bot:B1", { id: code!.id, rev: 1 })).toThrow(/card stays a cell/);
    expect(() => merge(note, "bot:B1", { id: card!.id, rev: 1 })).toThrow(/last one/);
  });

  it("branches: create around cells, add / rename / delete a route, move a cell into and out of a branch, dissolve keeping one route", () => {
    const { file, note } = noteAt("intro\n<!-- cell -->\nplan A\n<!-- cell -->\noutro\n");
    const [intro, plan, outro] = outline(note).items;
    type Made = { branch: string; routes: { id: string; name: string }[] };
    const made = branch(note, "bot:B1", { op: "create", ids: [plan!.id], name: "Plan", names: ["A", "B"] }) as unknown as Made;
    expect(readFileSync(file, "utf8")).toContain("<!-- branch: Plan -->\n<!-- route: A -->");
    const [routeA, routeB] = made.routes;
    move(note, "bot:B1", { id: outro!.id, route: routeB!.id });
    expect(read(note, { route: "Plan › B" }).cells.map((cell) => cell.id)).toEqual([outro!.id]);
    const extra = branch(note, "bot:B1", { op: "add_route", branch: made.branch, name: "C" }) as unknown as { route: string };
    branch(note, "bot:B1", { op: "rename", route: extra.route, name: "C2" });
    branch(note, "bot:B1", { op: "rename", branch: made.branch, name: "Plan v2" });
    expect(readFileSync(file, "utf8")).toContain("<!-- branch: Plan v2 -->");
    expect(readFileSync(file, "utf8")).toContain("<!-- route: C2 -->");
    branch(note, "bot:B1", { op: "delete_route", route: extra.route });
    expect(() => move(note, "bot:B1", { id: made.branch, route: routeA!.id })).toThrow(/inside itself/);
    move(note, "bot:B1", { id: outro!.id, after: made.branch });
    const gone = branch(note, "bot:B1", { op: "dissolve", branch: made.branch, keep: routeA!.id }) as unknown as { kept: string[] };
    expect(gone.kept).toEqual([plan!.id]);
    expect(outline(note).items.map((item) => item.id)).toEqual([intro!.id, plan!.id, outro!.id]);
    expect(readFileSync(file, "utf8")).not.toContain("branch");
    const second = branch(note, "bot:B1", { op: "create", after: intro!.id, name: "Empty" }) as unknown as Made;
    expect(() => branch(note, "bot:B1", { op: "delete_route", route: second.routes[0]!.id, rev: 7 })).toThrow(NoteConflict);
    branch(note, "bot:B1", { op: "delete", branch: second.branch });
    expect(outline(note).items).toHaveLength(3);
  });

  it("a change that would not read back from note.md is refused and changes nothing", () => {
    const { file, note } = noteAt("a\n<!-- cell -->\nb\n");
    const [a] = outline(note).items;
    const before = readFileSync(file, "utf8");
    // An open fence swallows the cells after it once written.
    expect(() => edit(note, "bot:B1", { id: a!.id, rev: 1, text: "```\nopen" })).toThrow(/read back/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(note.rev).toBe(1);
  });

  it("search finds cells, branch and route names", () => {
    const { note } = noteAt(REAL);
    const found = search(note, "載入", 10);
    expect(found.map((match) => match.path)).toEqual(["Loading › Eager", "Loading › Lazy load"]);
    expect(search(note, "disk", 10)).toEqual([expect.objectContaining({ kind: "route", excerpt: "Cache › disk" })]);
  });
});

describe("an edit made in note.md", () => {
  it("comes back by id: changed cells take the new text, a new cell gets an id, a removed one is a tombstone", () => {
    const { file, note } = noteAt("A\n<!-- cell -->\nB\n<!-- cell -->\nC\n");
    const [a, b, c] = outline(note).items;
    const text = readFileSync(file, "utf8").replace("\nB\n", "\nB edited in the file\n").replace(`<!-- cell: ${c!.id} -->\nC\n`, "") + `\n<!-- cell -->\nD`;
    writeFileSync(file, text);
    later(file);
    expect(note.sync()).toBeNull();
    const items = outline(note).items;
    expect(items.map((item) => item.id).slice(0, 2)).toEqual([a!.id, b!.id]);
    expect(items[1]).toMatchObject({ rev: 2, first: "B edited in the file" });
    expect(items).toHaveLength(3);
    expect(read(note, { ids: [c!.id] }).cells[0]).toMatchObject({ deleted: true });
    // The new cell got its id in the file.
    expect(readFileSync(file, "utf8")).toContain(`<!-- cell: ${items[2]!.id} -->\nD`);
  });

  it("an edit made on an older copy is not taken: the file is kept as a conflict file and note.md is the database's again", () => {
    const { file, note } = noteAt("A\n<!-- cell -->\nB\n");
    const [a] = outline(note).items;
    const old = readFileSync(file, "utf8");
    edit(note, "bot:B1", { id: a!.id, rev: 1, text: "A by the bot" });
    // Someone saves the copy they opened before the bot's edit, with a change of their own.
    writeFileSync(file, old.replace("\nB\n", "\nB by the user\n"));
    later(file);
    const kept = note.sync();
    expect(kept).toMatch(/note\.conflict-20261111-093000\.md$/);
    expect(readFileSync(kept!, "utf8")).toContain("B by the user");
    expect(readFileSync(file, "utf8")).toContain("A by the bot");
    expect(readFileSync(file, "utf8")).not.toContain("B by the user");
  });

  it("a plain rewrite of note.md (no ids) is matched to the cells it most likely is", () => {
    const { file, note } = noteAt("A\n<!-- cell -->\nB\n<!-- cell -->\nC\n");
    const ids = outline(note).items.map((item) => item.id);
    writeFileSync(file, "A\n<!-- cell -->\nB2\n<!-- cell -->\nC\n");
    later(file);
    note.sync();
    expect(outline(note).items.map((item) => item.id)).toEqual(ids);
  });
});

describe("the Note tab's plain read and write", () => {
  it("reads without ids; a save keeps ids by matching cells; a stale base is refused with the note now", () => {
    const { file, note } = noteAt("A\n<!-- cell -->\nB\n");
    const ids = outline(note).items.map((item) => item.id);
    const first = note.readPlain();
    expect(first.text).toBe("A\n<!-- cell -->\nB\n");
    const saved = note.writePlain("A\n<!-- cell -->\nB plus\n<!-- cell -->\nnew\n", first.mtime);
    expect(saved).toEqual({ saved: true, mtime: expect.any(Number) });
    const after = outline(note).items;
    expect(after.map((item) => item.id).slice(0, 2)).toEqual(ids);
    expect(after).toHaveLength(3);
    expect(note.writePlain("mine", first.mtime)).toEqual({ saved: false, text: "A\n<!-- cell -->\nB plus\n<!-- cell -->\nnew\n", mtime: saved.mtime });
    expect(readFileSync(file, "utf8")).toContain(`<!-- cell: ${ids[0]} -->`);
  });

  it("outlineLines gives the 問 quote its ids, lines and route path, for the saved note or the editor's own words", () => {
    const { note } = noteAt("intro\n<!-- branch: Loading -->\n<!-- route: Lazy load -->\n每個分頁第一次打開時才載入外掛\n<!-- end branch -->\n");
    const saved = note.outlineLines();
    expect(saved.text).toBe("intro\n<!-- branch: Loading -->\n<!-- route: Lazy load -->\n每個分頁第一次打開時才載入外掛\n<!-- end branch -->\n");
    const cell = saved.cells[1] as { id: string; start: number; end: number; path: { fork: string; route: string }[]; label: string; rev: number };
    expect(cell).toMatchObject({ start: 3, end: 3, rev: 1, path: [{ fork: "Loading", route: "Lazy load" }] });
    expect(cell.label).toBe(`Note #${cell.id} · Loading › Lazy load`);
    expect(saved.forks).toEqual([expect.objectContaining({ name: "Loading", start: 1, end: 4, routes: [expect.objectContaining({ name: "Lazy load", start: 2, end: 4 })] })]);
    // Unsaved words: a line typed above moves the lines, the ids stay; a new cell has none yet.
    const typed = note.outlineLines("new line\nintro\n<!-- branch: Loading -->\n<!-- route: Lazy load -->\n每個分頁第一次打開時才載入外掛\n<!-- cell -->\nfresh\n<!-- end branch -->\n");
    const cells = typed.cells as { id: string | null; start: number; rev: number | null }[];
    expect(cells[1]).toMatchObject({ id: cell.id, start: 4, rev: 1 });
    expect(cells[2]).toMatchObject({ id: null, rev: null });
    expect(cells[0]!.rev).toBeNull();
  });
});
