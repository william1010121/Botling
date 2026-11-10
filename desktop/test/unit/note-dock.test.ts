// The Note tab's quick chat (note-dock.ts): which tab offers the bubble, and when the docked chat stays open.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockable, docked, dockKey, keepDock, NOTE_PLUGIN, toggleDock } from "../../src/renderer/note-dock";
import type { MainTab } from "../../src/renderer/main-tabs";
import { desktop } from "../helpers";

const tab = (plugin: string, id = "note"): MainTab => ({ plugin, id, title: "Note", forRole: "any" } as MainTab);
const note = tab(NOTE_PLUGIN);
const board = tab("botling.whiteboard", "board");

describe("dockable tabs", () => {
  it("is the Note tab only", () => {
    expect(dockable(note)).toBe(true);
    expect(dockable(board)).toBe(false);
    expect(dockable(null)).toBe(false);
  });
  it("keys the dock by bot and tab, and offers none on Chat, another tab or a worker's page", () => {
    expect(dockKey("b1", note, false)).toBe(`b1/${NOTE_PLUGIN}/note`);
    expect(dockKey("b1", null, false)).toBeNull();
    expect(dockKey("b1", board, false)).toBeNull();
    expect(dockKey("b1", note, true)).toBeNull();
    expect(dockKey(null, note, false)).toBeNull();
  });
});

describe("the docked chat", () => {
  const key = dockKey("b1", note, false);
  it("the bubble opens it and closes it again", () => {
    const open = toggleDock(null, key);
    expect(docked(open, key)).toBe(true);
    expect(docked(toggleDock(open, key), key)).toBe(false);
    // No Note shown: nothing to open.
    expect(toggleDock(null, null)).toBeNull();
  });
  it("closes on another tab or bot, and the Note comes back without it", () => {
    const open = toggleDock(null, key);
    expect(keepDock(open, key)).toBe(open);
    const away = keepDock(open, null);
    expect(away).toBeNull();
    expect(docked(keepDock(away, key), key)).toBe(false);
    expect(keepDock(open, dockKey("b2", note, false))).toBeNull();
    expect(docked(open, dockKey("b2", note, false))).toBe(false);
  });
});

describe("App.tsx draws it", () => {
  const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
  it("wraps the tab and the chat page in ChatBody, the bubble over the Note, closed on Esc", () => {
    expect(app).toContain("<ChatBody docked={noteDocked}>");
    expect(app).toContain('className="note-bubble"');
    expect(app).toContain("const noteKey = web || browserFull ? null : dockKey(bot?.id, tab, !!watching);");
    expect(app).toMatch(/event\.key !== "Escape"[^\n]*\n\s*event\.preventDefault\(\);\n\s*setNoteDockAt\(null\)/);
  });
  it("the browser pane uses the same bubble", () => {
    expect(readFileSync(join(desktop, "src/renderer/BrowserPane.tsx"), "utf8")).toContain("<BotBubble bot={bot} look={look} on={miniChat}");
  });
});
