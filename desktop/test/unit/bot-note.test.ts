// A bot's note (the Note tab's one Markdown file, bot-note.ts): made on first read, saved whole and atomically, a
// save over a newer file on disk refused (so a bot's edit is never overwritten), and changes on disk told once.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { NoteWatcher, notePath, readNote, writeNote } from "../../src/core/bot-note";

const watchers: NoteWatcher[] = [];
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.close(); });

describe("notePath: one note per bot, beside its other .bot files", () => {
  it("project bot, sub bot and main bot", () => {
    expect(notePath({ role: "manager", folder: "/p/repo", memoryPath: ".bot/memory.md" })).toBe("/p/repo/.bot/note.md");
    expect(notePath({ role: "bot", folder: "/p/repo", memoryPath: ".bot/memory.md", id: "S1", parent: "P1" })).toBe("/p/repo/.bot/sub-bots/S1/note.md");
    expect(notePath({ role: "main", folder: "/data/main", memoryPath: "memory.md" })).toBe("/data/main/note.md");
  });
});

describe("readNote / writeNote", () => {
  it("creates an empty note on first read, folders included", () => {
    const file = join(tempDir("bot-note"), "proj", ".bot", "note.md");
    const first = readNote(file);
    expect(first).toEqual({ path: file, text: "", mtime: expect.any(Number) });
    expect(readFileSync(file, "utf8")).toBe("");
    writeFileSync(file, "# Kept\n");
    expect(readNote(file).text).toBe("# Kept\n");
  });

  it("saves the whole text atomically and leaves no temp file", () => {
    const dir = tempDir("bot-note");
    const file = join(dir, "note.md");
    const saved = writeNote(file, "# Plan\n- [ ] one\n");
    expect(saved).toEqual({ saved: true, mtime: expect.any(Number) });
    expect(readFileSync(file, "utf8")).toBe("# Plan\n- [ ] one\n");
    expect(readdirSync(dir)).toEqual(["note.md"]);
  });

  it("refuses a save based on an older version and hands back what is on disk", () => {
    const file = join(tempDir("bot-note"), "note.md");
    const { mtime } = readNote(file);
    const ours = writeNote(file, "mine", mtime);
    expect(ours.saved).toBe(true);
    // A bot edits the file meanwhile.
    writeFileSync(file, "the bot's");
    const later = Date.now() / 1000 + 5;
    utimesSync(file, later, later);
    const stale = writeNote(file, "mine again", ours.mtime);
    expect(stale).toEqual({ saved: false, text: "the bot's", mtime: expect.any(Number) });
    expect(readFileSync(file, "utf8")).toBe("the bot's");
    // Based on what is there now, it saves.
    expect(writeNote(file, "merged", (stale as { mtime: number }).mtime).saved).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("merged");
  });

  it("a save with a base when the file was removed makes it again", () => {
    const file = join(tempDir("bot-note"), "note.md");
    const { mtime } = readNote(file);
    rmSync(file);
    expect(writeNote(file, "back", mtime).saved).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("back");
  });
});

describe("NoteWatcher", () => {
  it("tells a change made on disk once, and not its own saves", async () => {
    const file = join(tempDir("bot-note"), ".bot", "note.md");
    const heard: [string, number | null][] = [];
    const watcher = new NoteWatcher((botId, mtime) => heard.push([botId, mtime]), { settleMs: 20, pollMs: 200 });
    watchers.push(watcher);
    const { mtime } = readNote(file);
    watcher.watch("B1", file, mtime);
    const ours = writeNote(file, "from the editor", mtime);
    if (ours.saved) watcher.watch("B1", file, ours.mtime);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(heard).toEqual([]);
    writeFileSync(file, "from the bot");
    const later = Date.now() / 1000 + 5;
    utimesSync(file, later, later);
    await until(() => heard.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toEqual([["B1", expect.any(Number)]]);
  });

  it("tells a removed note as null, and stops when unwatched", async () => {
    const file = join(tempDir("bot-note"), "note.md");
    const heard: [string, number | null][] = [];
    const watcher = new NoteWatcher((botId, mtime) => heard.push([botId, mtime]), { settleMs: 20, pollMs: 200 });
    watchers.push(watcher);
    watcher.watch("B1", file, readNote(file).mtime);
    rmSync(file);
    await until(() => heard.length > 0);
    expect(heard).toEqual([["B1", null]]);
    watcher.unwatch("B1");
    writeFileSync(file, "again");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(heard).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });

  it("keeps at most `max` notes watched, dropping the oldest", () => {
    const dir = tempDir("bot-note");
    const watcher = new NoteWatcher(() => {}, { max: 2 });
    watchers.push(watcher);
    for (const id of ["A", "B", "C"]) {
      const file = join(dir, id, "note.md");
      watcher.watch(id, file, readNote(file).mtime);
    }
    expect(watcher.watched()).toEqual(["B", "C"]);
  });
});
