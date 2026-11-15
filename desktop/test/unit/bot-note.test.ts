// A bot's note (the Note tab's one Markdown file, bot-note.ts): made on first read, saved whole and atomically, a
// save over a newer file on disk refused (so a bot's edit is never overwritten), and changes on disk told once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { NoteWatcher, notePath, readNote, writeNote } from "../../src/core/bot-note";

// statSync and utimesSync pass through to the real ones, unless a test makes one fail once (the stamp after a save).
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statSync: vi.fn(fs.statSync), utimesSync: vi.fn(fs.utimesSync) };
});

const watchers: NoteWatcher[] = [];
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.close(); vi.mocked(statSync).mockClear(); vi.mocked(utimesSync).mockClear(); });

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

  it("a save stamps the note later than the one it replaced, even when the clock has not moved past it", () => {
    // Linux stamps files with the kernel's coarse clock, so two saves in one tick would share the mtime a save is based
    // on. A note dated ahead of the clock stands in for that tick here, on any disk.
    const file = join(tempDir("bot-note"), "note.md");
    readNote(file);
    const ahead = Date.now() / 1000 + 5;
    utimesSync(file, ahead, ahead);
    const base = readNote(file).mtime;
    const ours = writeNote(file, "mine", base);
    expect(ours.saved).toBe(true);
    expect(ours.mtime).toBeGreaterThan(base);
    expect(writeNote(file, "stale", base)).toEqual({ saved: false, text: "mine", mtime: ours.mtime });
  });

  it("a save whose stamp fails (a disk that refuses utimes, the note gone just after) is still a save, never an error", () => {
    const file = join(tempDir("bot-note"), "note.md");
    readNote(file);
    const ahead = Date.now() / 1000 + 5;
    utimesSync(file, ahead, ahead);
    const base = readNote(file).mtime;
    const refused = Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" });
    vi.mocked(utimesSync).mockClear().mockImplementationOnce(() => { throw refused; });
    const ours = writeNote(file, "mine", base);
    expect(vi.mocked(utimesSync)).toHaveBeenCalledTimes(1);
    expect(ours).toEqual({ saved: true, mtime: statSync(file).mtimeMs });
    expect(readFileSync(file, "utf8")).toBe("mine");

    // The stat after the rename fails (the note removed just then): the old answer, 0.
    const real = vi.mocked(statSync).getMockImplementation()!;
    let calls = 0;
    vi.mocked(statSync).mockImplementation(((...args: Parameters<typeof statSync>) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("ENOENT: no such file or directory, stat"), { code: "ENOENT" });
      return real(...args);
    }) as typeof statSync);
    try {
      expect(writeNote(file, "again")).toEqual({ saved: true, mtime: 0 });
    } finally {
      vi.mocked(statSync).mockImplementation(real);
    }
    expect(readFileSync(file, "utf8")).toBe("again");
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
