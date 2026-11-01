// The subagent index + append-only step files, and the one-time split of the old whole-file format.
import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { BotStore } from "../../src/core/store/bot-store";
import { INDEX_FORMAT, SubagentStore, foldLines, subagentFileName } from "../../src/core/store/subagent-store";
import { SubagentBook } from "../../src/core/subagents";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const folder = (name = "subagent-store") => { const root = tempDir(name); roots.push(root); return root; };
const step = (id: string, extra: object = {}) => ({ id, kind: "tool" as const, tool: "Read", title: id, failed: false, done: true, ...extra });

function oldRows() {
  return [
    { id: "a", description: "Alpha", prompt: "do a", status: "completed", background: false, startedAt: 10, endedAt: 20, result: "A report", unknownKey: { keep: 1 },
      steps: [step("a1"), { id: "a:text:1", kind: "text", title: "words", failed: false, done: true }],
      previousRuns: [{ prompt: "first", status: "failed", startedAt: 1, endedAt: 2, result: "boom", execution: { run: 1, ownerSessionId: null, threadId: "t", turnId: null }, steps: [step("old1"), step("old2")] }] },
    { id: "tool/use:1", description: "Beta", prompt: "do b", status: "running", background: true, startedAt: 30, steps: [step("b1")] },
  ];
}

it("splits an old whole-file history (previous runs and a journal) into the index and step files, keeps the original as .bak, and never runs twice", () => {
  const dir = folder(), file = join(dir, "subagents.json");
  const checkpoint = { format: "botling-history-v1", sequence: 1, rows: oldRows() };
  writeFileSync(file, JSON.stringify(checkpoint));
  mkdirSync(file + ".journal");
  // Receipt 2 adds a step to "a" and a third record; receipt 1 is already covered by the checkpoint and ignored.
  writeFileSync(join(file + ".journal", "0000000000000001.json"), JSON.stringify({ order: ["a", "tool/use:1"], changes: [] }));
  writeFileSync(join(file + ".journal", "0000000000000002.json"), JSON.stringify({ order: ["a", "tool/use:1", "c"], changes: [
    { id: "a", patches: [{ path: ["steps", 2], value: step("a3") }] },
    { id: "c", patches: [{ path: [], value: { id: "c", description: "Gamma", prompt: "", status: "stopped", background: false, startedAt: 40, steps: [] } }] },
  ] }));
  const original = readFileSync(file);

  const store = new BotStore(dir);
  const rows = store.loadList("subagents.json") as any[];
  expect(rows.map(row => row.id)).toEqual(["a", "tool/use:1", "c"]);
  expect(rows[0]).toMatchObject({ description: "Alpha", result: "A report", unknownKey: { keep: 1 }, toolCount: 2, stepCount: 3, runs: 1 });
  for (const row of rows) { expect(row).not.toHaveProperty("steps"); expect(row).not.toHaveProperty("previousRuns"); }

  expect(readFileSync(file + ".bak").equals(original)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(INDEX_FORMAT);
  expect(existsSync(file + ".journal")).toBe(false);
  expect(existsSync(file + ".journal.bak")).toBe(true);
  expect(existsSync(file + ".migrating")).toBe(false);
  expect(readdirSync(join(dir, "subagents")).sort()).toEqual(["a.jsonl", "tool%2Fuse%3A1.jsonl"]);

  const history = store.readSubagentSteps("a");
  expect(history.steps.map(s => s.id)).toEqual(["a1", "a:text:1", "a3"]);
  expect(history.runs).toHaveLength(1);
  expect(history.runs[0]!.run).toMatchObject({ prompt: "first", status: "failed", result: "boom", execution: { run: 1, threadId: "t" } });
  expect(history.runs[0]!.steps.map(s => s.id)).toEqual(["old1", "old2"]);

  // Idempotent: a second load reads the index, writes nothing and leaves the backup alone.
  const index = readFileSync(file), steps = readFileSync(join(dir, "subagents", "a.jsonl"));
  const again = new BotStore(dir).loadList("subagents.json");
  expect(again).toEqual(rows);
  expect(readFileSync(file).equals(index)).toBe(true);
  expect(readFileSync(join(dir, "subagents", "a.jsonl")).equals(steps)).toBe(true);
  expect(readFileSync(file + ".bak").equals(original)).toBe(true);
  expect(readdirSync(dir).filter(name => name.includes(".bak"))).toEqual(["subagents.json.bak", "subagents.json.journal.bak"]);
});

it("migrates a bare array (pre-journal format) and finishes a split that crashed after its index was complete", () => {
  const dir = folder(), file = join(dir, "subagents.json");
  writeFileSync(file, JSON.stringify(oldRows()));
  new SubagentStore(dir).load();
  // Crash image: the old file already moved aside, the finished index not yet renamed into place.
  const index = readFileSync(file);
  rmSync(file); writeFileSync(file + ".migrating", index);
  const rows = new SubagentStore(dir).load();
  expect(rows).toHaveLength(2);
  expect(existsSync(file + ".migrating")).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(INDEX_FORMAT);
  expect(existsSync(file + ".bak")).toBe(true);
});

it("a crash before the old file is moved aside redoes the split from the original without losing anything", () => {
  const dir = folder(), file = join(dir, "subagents.json");
  writeFileSync(file, JSON.stringify(oldRows()));
  mkdirSync(join(dir, "subagents")); writeFileSync(join(dir, "subagents", "a.jsonl"), "garbage from an earlier attempt\n");
  writeFileSync(file + ".migrating", "{half");
  const store = new SubagentStore(dir);
  store.load();
  expect(store.readSteps("a").steps.map(s => s.id)).toEqual(["a1", "a:text:1"]);
});

it("an unreadable file is never replaced", () => {
  const dir = folder(), file = join(dir, "subagents.json");
  writeFileSync(file, "{broken");
  const store = new BotStore(dir);
  expect(() => store.loadList("subagents.json")).toThrow();
  expect(() => store.commitSubagents([{ id: "x" }])).toThrow();
  expect(readFileSync(file, "utf8")).toBe("{broken");
});

it("appends steps, patches and run boundaries to the end of the file: the earlier bytes never change and the index stays small", () => {
  const dir = folder(), store = new BotStore(dir);
  const book = new SubagentBook();
  book.sink = (id, line) => store.stageSubagentLine(id, line);
  book.started({ id: "w", description: "Worker", type: "codex-worker", prompt: "p".repeat(100), background: true, execution: { run: 1, ownerSessionId: null, threadId: "t", turnId: "u" } }, 1);
  const file = join(dir, "subagents", "w.jsonl"), index = join(dir, "subagents.json");
  let before = Buffer.alloc(0);
  const grow = (action: () => void) => {
    action(); store.commitSubagents(book.list);
    const now = readFileSync(file);
    expect(now.subarray(0, before.length).equals(before)).toBe(true);
    expect(now.length).toBeGreaterThan(before.length);
    before = now;
  };
  grow(() => book.toolUse({ id: "c1", tool: "Read", title: "Read", detail: "x", parent: "w", input: {} } as any));
  grow(() => book.toolResult({ id: "c1", output: "contents", failed: false, parent: "w", launch: null }));
  for (let i = 0; i < 300; i++) grow(() => book.text("w", `word ${i} ${"x".repeat(2000)}`));
  const indexBefore = statSync(index).size;
  expect(indexBefore).toBeLessThan(2_000);
  expect(statSync(file).size).toBeGreaterThan(500_000);
  book.ended({ id: "w", status: "completed", summary: "r1" }, 2); store.commitSubagents(book.list); // the index only: no line
  expect(readFileSync(file).equals(before)).toBe(true);
  grow(() => book.started({ id: "w", description: "Worker", type: null, prompt: "again", background: true, execution: { run: 2, ownerSessionId: null, threadId: "t", turnId: "v" } }, 3));
  grow(() => book.text("w", "second run"));
  expect(statSync(index).size).toBeLessThan(2_500);
  const history = store.readSubagentSteps("w");
  expect(history.runs).toHaveLength(1);
  expect(history.runs[0]!.steps).toHaveLength(301);
  expect(history.runs[0]!.steps[0]).toMatchObject({ id: "c1", output: "contents", done: true });
  expect(history.runs[0]!.run).toMatchObject({ prompt: "p".repeat(100), status: "completed", result: "r1", execution: { run: 1, turnId: "u" } });
  expect(history.steps.map(s => s.title)).toEqual(["second run"]);
  expect(JSON.parse(readFileSync(index, "utf8")).subagents[0]).toMatchObject({ id: "w", runs: 1, stepCount: 1, toolCount: 0 });
  // The text step ids stay unique across a restart's tail.
  expect(new Set(history.runs[0]!.steps.map(s => s.id)).size).toBe(301);
});

it("a step that is not in memory any more is still found by its result, loaded from its file", () => {
  const dir = folder(), store = new BotStore(dir);
  const first = new SubagentBook();
  first.sink = (id, line) => store.stageSubagentLine(id, line);
  first.started({ id: "w", description: "Worker", type: null, prompt: "p", background: true }, 1);
  first.toolUse({ id: "c1", tool: "Bash", title: "ls", detail: "", parent: "w", input: {} } as any);
  store.commitSubagents(first.list);
  const reopened = new BotStore(dir), book = new SubagentBook((reopened.loadList("subagents.json") as any[]).map(row => ({ ...row, steps: [] })));
  book.sink = (id, line) => reopened.stageSubagentLine(id, line);
  book.loadSteps = id => reopened.readSubagentSteps(id).steps;
  expect(book.get("w")!.steps).toEqual([]);
  expect(book.toolResult({ id: "c1", output: "files", failed: false, parent: "w", launch: null })).toBe(true);
  reopened.commitSubagents(book.list);
  expect(reopened.readSubagentSteps("w").steps[0]).toMatchObject({ id: "c1", output: "files", done: true });
});

it("a missing, empty or corrupt step file shows what can be read and is never fatal", () => {
  const dir = folder(), store = new SubagentStore(dir);
  expect(store.readSteps("nothing")).toEqual({ runs: [], steps: [] });
  mkdirSync(store.directory);
  const lines = [JSON.stringify({ k: "step", step: step("s1") }), "{not json", "", JSON.stringify({ k: "step", step: { nope: true } }), JSON.stringify({ k: "mystery" }), JSON.stringify({ k: "step", step: step("s2") })];
  writeFileSync(store.pathFor("x"), lines.join("\n") + "\n{\"k\":\"step\",\"step\":{\"id\":\"cut");
  expect(store.readSteps("x").steps.map(s => s.id)).toEqual(["s1", "s2"]);
  expect(foldLines(["garbage"]).steps).toEqual([]);
});

it("reads only the tail of a large file and drops the line it lands in the middle of", () => {
  const dir = folder(), store = new SubagentStore(dir);
  mkdirSync(store.directory);
  const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ k: "step", step: step(`s${i}`, { output: "x".repeat(500) }) }));
  writeFileSync(store.pathFor("big"), lines.join("\n") + "\n");
  const tail = store.readSteps("big", 20_000).steps;
  expect(tail.at(-1)!.id).toBe("s999");
  expect(tail.length).toBeGreaterThan(20);
  expect(tail.length).toBeLessThan(40);
  expect(tail[0]!.id).toBe(`s${1000 - tail.length}`);
});

it("file names: separators and other unsafe characters never reach the path", () => {
  const dir = folder(), store = new SubagentStore(dir);
  const ids = ["../../etc/passwd", "a/b", "a\\b", "..", ".", "toolu_01ABC", "7f9c1b0e-1111-2222-3333-444455556666", "with:colon", "nul\0byte", "é世界", "x".repeat(500)];
  const names = ids.map(subagentFileName);
  for (const name of names) {
    expect(name).toMatch(/^[A-Za-z0-9_%~-]+\.jsonl$/);
    expect(name.length).toBeLessThan(160);
  }
  expect(new Set(names).size).toBe(ids.length);
  expect(subagentFileName("toolu_01ABC")).toBe("toolu_01ABC.jsonl");
  for (const id of ids) expect(store.pathFor(id).startsWith(store.directory)).toBe(true);
  expect(() => subagentFileName("")).toThrow();
  store.stage("../../escape", { k: "step", step: step("s") });
  store.flush();
  expect(readdirSync(store.directory)).toEqual(["%2E%2E%2F%2E%2E%2Fescape.jsonl"]);
  expect(existsSync(join(dir, "..", "escape.jsonl"))).toBe(false);
});

it("files of subagents that left the list are removed; others stay", () => {
  const dir = folder(), store = new BotStore(dir);
  const base = { description: "", prompt: "", status: "completed", background: false, startedAt: 1 };
  store.stageSubagentLine("keep", { k: "step", step: step("k") as any });
  store.stageSubagentLine("drop", { k: "step", step: step("d") as any });
  store.commitSubagents([{ id: "keep", ...base }, { id: "drop", ...base }]);
  expect(readdirSync(join(dir, "subagents")).sort()).toEqual(["drop.jsonl", "keep.jsonl"]);
  store.commitSubagents([{ id: "keep", ...base }]);
  expect(readdirSync(join(dir, "subagents"))).toEqual(["keep.jsonl"]);
});

it("a failed append keeps the lines staged; the retry lands them on a fresh line", () => {
  const dir = folder(), store = new SubagentStore(dir);
  store.stage("w", { k: "step", step: step("one") as any });
  writeFileSync(store.directory, "blocked");
  expect(() => store.flush()).toThrow();
  expect(store.pending).toBe(true);
  rmSync(store.directory); mkdirSync(store.directory);
  appendFileSync(store.pathFor("w"), '{"k":"step","step":{"id":"torn');
  store.stage("w", { k: "step", step: step("two") as any });
  store.flush();
  expect(store.pending).toBe(false);
  expect(store.readSteps("w").steps.map(s => s.id)).toEqual(["one", "two"]);
});

it("never trims a subagent another bot owns now (A1), and its steps file survives the commit that drops older ones", async () => {
  const { Core } = await import("../../src/core/server");
  const { saveProjectRow } = await import("../../src/core/projects");
  const { Layout } = await import("../../src/core/store/workspace");
  const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0", OTHER = "C0FFEE00-0000-4000-8000-000000000009";
  const dir = folder("subagent-store-moved"), work = folder("subagent-store-moved-work");
  writeFileSync(Layout.settings(dir), JSON.stringify({ agentMoves: true }));
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder: work, avatar: "triangle" });
  saveProjectRow(dir, { id: OTHER, name: "Helper", folder: work, avatar: "square", job: "helps" });
  const store = Layout.bot(dir, PROJECT);
  mkdirSync(join(store, "subagents"), { recursive: true });
  writeFileSync(join(store, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"] } }));
  // The moved one is the oldest of 42 ended workers: the next trim would drop it first.
  const ended = Array.from({ length: 42 }, (_, i) => ({ id: `task-${i}`, description: `W${i}`, prompt: "p", status: "completed", background: true, startedAt: 800_000_000 + i, endedAt: 800_000_100 + i, type: "codex-worker" }));
  writeFileSync(join(store, "subagents.json"), JSON.stringify({ format: INDEX_FORMAT, subagents: ended }));
  for (const row of ended) writeFileSync(join(store, "subagents", subagentFileName(row.id)), JSON.stringify({ k: "step", step: step(`${row.id}-s`) }) + "\n");
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true, routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  try {
    await core.moveAgent(PROJECT, "task-0", { kind: "bot", botId: OTHER });
    const bot = (core as any).bots.get(PROJECT);
    // A new worker starts: the book trims its ended ones to 40, and the commit removes the dropped ones' files.
    bot.subagents.started({ id: "task-new", description: "New", type: "codex-worker", prompt: "p", background: true });
    bot.saveSubagents();
    const ids = bot.subagents.list.map((s: { id: string }) => s.id);
    expect(ids).toContain("task-0");
    expect(ids).not.toContain("task-1");
    expect(existsSync(join(store, "subagents", subagentFileName("task-0")))).toBe(true);
    expect(existsSync(join(store, "subagents", subagentFileName("task-1")))).toBe(false);
    expect((JSON.parse(readFileSync(join(store, "subagents.json"), "utf8")).subagents as { id: string }[]).map((s) => s.id)).toContain("task-0");
  } finally { await core.shutdown(); }
});
