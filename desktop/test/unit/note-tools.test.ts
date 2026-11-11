// Who may use which Note tool (decided by the user, 2026-11-11): a bot reads its own Note and the other Notes of its
// project and changes only its own; a worker only reads; another project's Notes are out of reach. Also: an edit made in
// note.md that cannot be taken is reported to the caller (conflict_file), a Note kept as a plain file says so, and every
// engine lists the write tools for coordinators and only the three read tools for workers.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers";
import { NoteService, NOTE_READ_TOOLS, NOTE_TOOLS, runNoteTool, type NoteBot, type NoteToolContext } from "../../src/core/note-tools";
import { appTools, workerAppTools } from "../../src/core/app-tools/registry";

const services: NoteService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

function project(): { bots: NoteBot[]; ctx: (botId: string, caller?: NoteToolContext["caller"]) => NoteToolContext } {
  const root = tempDir("note-tools");
  const note = (folder: string, name: string, text: string) => {
    const file = join(root, folder, ".bot", name === "main" ? "note.md" : `bots/${name}/note.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const bots: NoteBot[] = [
    { id: "A1", name: "Alpha", folder: join(root, "p1"), note: note("p1", "main", "alpha one\n<!-- cell -->\nalpha two\n") },
    { id: "B2", name: "Beta", folder: join(root, "p1"), note: note("p1", "beta", "beta notes about GPUs\n") },
    { id: "C3", name: "Gamma", folder: join(root, "p2"), note: note("p2", "main", "gamma secret GPUs\n") },
  ];
  const service = new NoteService();
  services.push(service);
  return { bots, ctx: (botId, caller = "coordinator") => ({ botId, caller, bots: () => bots, service }) };
}

type Item = { id: string; rev: number; first: string };
const items = (result: unknown) => (result as { items: Item[] }).items;

describe("note tools: who may do what", () => {
  it("a bot reads and changes its own Note", () => {
    const { bots, ctx } = project();
    const [first] = items(runNoteTool("app_note_outline", {}, ctx("A1")));
    const edited = runNoteTool("app_note_edit", { id: first.id, rev: first.rev, text: "alpha ONE" }, ctx("A1")) as { changed: { id: string; rev: number }[] };
    expect(edited.changed).toEqual([{ id: first.id, rev: first.rev + 1 }]);
    const read = runNoteTool("app_note_read", { ids: [first.id] }, ctx("A1")) as { cells: { text: string }[] };
    expect(read.cells[0].text).toBe("alpha ONE");
    expect(readFileSync(bots[0].note, "utf8")).toContain(`<!-- cell: ${first.id} -->\nalpha ONE`);
  });

  it("reads another bot's Note of the same project, by id or name, and cannot change it", () => {
    const { ctx } = project();
    const byName = runNoteTool("app_note_outline", { bot: "beta" }, ctx("A1")) as { bot: { id: string }; items: Item[] };
    expect(byName.bot.id).toBe("B2");
    expect(byName.items[0].first).toBe("beta notes about GPUs");
    const read = runNoteTool("app_note_read", { bot: "B2" }, ctx("A1")) as { cells: { text: string }[] };
    expect(read.cells.map((cell) => cell.text)).toEqual(["beta notes about GPUs\n"]);
    const id = byName.items[0].id;
    expect(() => runNoteTool("app_note_edit", { bot: "B2", id, rev: 1, text: "x" }, ctx("A1"))).toThrow(/only your own Note/);
    expect(() => runNoteTool("app_note_insert", { bot: "Beta", text: "x" }, ctx("A1"))).toThrow(/only your own Note/);
  });

  it("another project's Note is out of reach, and an unknown bot lists the ones that can be read", () => {
    const { ctx } = project();
    expect(() => runNoteTool("app_note_read", { bot: "C3" }, ctx("A1"))).toThrow(/another project/);
    expect(() => runNoteTool("app_note_outline", { bot: "Gamma" }, ctx("A1"))).toThrow(/another project/);
    expect(() => runNoteTool("app_note_outline", { bot: "Nobody" }, ctx("A1"))).toThrow(/Alpha \(A1\), Beta \(B2\)/);
  });

  it("a worker reads its owner's and its project's Notes and changes none", () => {
    const { ctx } = project();
    const [first] = items(runNoteTool("app_note_outline", {}, ctx("A1", "worker")));
    expect(runNoteTool("app_note_search", { query: "GPUs", bot: "B2" }, ctx("A1", "worker"))).toMatchObject({ matches: [expect.objectContaining({ excerpt: expect.stringContaining("GPUs") })] });
    for (const tool of ["app_note_edit", "app_note_insert", "app_note_delete", "app_note_move", "app_note_split", "app_note_merge", "app_note_branch"] as const) {
      expect(() => runNoteTool(tool, { id: first.id, rev: first.rev, text: "x", line: 1, op: "create" }, ctx("A1", "worker"))).toThrow(/A worker reads Notes only/);
    }
  });

  it('search with bot "all" looks through this project\'s Notes only', () => {
    const { ctx } = project();
    const found = runNoteTool("app_note_search", { query: "GPUs", bot: "all" }, ctx("A1")) as { bots: { id: string }[]; matches: { bot: string }[] };
    expect(found.bots.map((bot) => bot.id)).toEqual(["A1", "B2"]);
    expect(found.matches.map((match) => match.bot)).toEqual(["B2"]);
  });

  it("a session with no bot gets no Notes", () => {
    const { ctx } = project();
    expect(() => runNoteTool("app_note_outline", {}, ctx("Z9"))).toThrow(/not available/);
  });
});

describe("note tools: the file and the conflicts", () => {
  it("an edit made in note.md over an older copy of a cell is kept aside and reported", () => {
    const { bots, ctx } = project();
    const [first] = items(runNoteTool("app_note_outline", {}, ctx("A1")));
    const before = readFileSync(bots[0].note, "utf8");
    runNoteTool("app_note_edit", { id: first.id, rev: first.rev, text: "alpha new" }, ctx("A1"));
    // Someone saved the copy they had opened before that edit, changing the other cell.
    writeFileSync(bots[0].note, before.replace("alpha two", "alpha two, edited elsewhere"));
    const t = Date.now() / 1000 + 5;
    utimesSync(bots[0].note, t, t);
    const result = runNoteTool("app_note_outline", {}, ctx("A1")) as { conflict_file?: string; items: Item[] };
    expect(result.conflict_file).toMatch(/note\.conflict-\d{8}-\d{6}\.md$/);
    expect(readFileSync(result.conflict_file!, "utf8")).toContain("edited elsewhere");
    expect(result.items.map((item) => item.first)).toEqual(["alpha new", "alpha two"]);
  });

  it("a stale rev is refused with what is there now", () => {
    const { ctx } = project();
    const [first] = items(runNoteTool("app_note_outline", {}, ctx("A1")));
    runNoteTool("app_note_edit", { id: first.id, rev: first.rev, text: "one" }, ctx("A1"));
    let message = "";
    try { runNoteTool("app_note_edit", { id: first.id, rev: first.rev, text: "two" }, ctx("A1")); } catch (error) { message = (error as Error).message; }
    expect(JSON.parse(message.slice(message.indexOf("{")))).toMatchObject({ conflict: true, id: first.id, rev: first.rev + 1, text: "one" });
  });

  it("a Note kept as a plain file says so instead of showing no cells", () => {
    const { bots, ctx } = project();
    const file = bots[1].note;
    writeFileSync(file, "```\nan unclosed fence\n");
    const service = ctx("A1").service!;
    service.mode(file, "file", "B2");
    expect(() => runNoteTool("app_note_outline", { bot: "B2" }, ctx("A1"))).toThrow(/kept as a plain file.*read .*note\.md directly/);
    const found = runNoteTool("app_note_search", { query: "a", bot: "all" }, ctx("A1")) as { matches: { bot: string }[] };
    expect(new Set(found.matches.map((match) => match.bot))).toEqual(new Set(["A1"]));
  });
});

describe("note tools in every engine", () => {
  it("coordinators get all ten, workers only the three read tools", () => {
    for (const provider of ["claude", "agy", "codex"] as const) {
      const names = appTools(provider).map((tool) => tool.name);
      for (const name of NOTE_TOOLS) expect(names).toContain(name);
      const worker = workerAppTools(provider).map((tool) => tool.name).filter((name) => name.startsWith("app_note_"));
      expect(worker).toEqual([...NOTE_READ_TOOLS]);
    }
  });
});
