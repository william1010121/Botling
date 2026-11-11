// A Note block quoted into a bot's input box (`ccb.composer.insertQuote` → the chat page's `ccb.quote`): appended to
// that chat's draft after what is there, a blank line before and after it, the caret at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { Composer, quoteAppend } from "../src/composer";
import type { ChatState } from "../src/types";

function state(botID: string): ChatState {
  return { botID, botName: botID, messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {} } as unknown as ChatState;
}

// No layout in jsdom: the editor's measuring frames never run.
beforeEach(() => { sent.length = 0; document.body.innerHTML = ""; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("quoteAppend", () => {
  it("puts the quote after what is there, one blank line before and after", () => {
    expect(quoteAppend("", "block")).toBe("block\n\n");
    expect(quoteAppend("ask this", "block")).toBe("ask this\n\nblock\n\n");
    expect(quoteAppend("ask this\n", "block")).toBe("ask this\n\nblock\n\n");
    expect(quoteAppend("ask this\n\n", "block")).toBe("ask this\n\nblock\n\n");
    expect(quoteAppend("a", "\n\nline 1\nline 2\n\n")).toBe("a\n\nline 1\nline 2\n\n");
  });
});

describe("Composer.quote", () => {
  it("appends to the chat on screen, caret at the end, kept as its draft", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("Look:");
    composer.view.dispatch({ selection: { anchor: 0 } });
    expect(composer.quote("A", "> a block", false)).toBe(true);
    expect(composer.text).toBe("Look:\n\n> a block\n\n");
    expect(composer.view.state.selection.main.head).toBe(composer.text.length);
    composer.update(state("B"));
    composer.update(state("A"));
    expect(composer.text).toBe("Look:\n\n> a block\n\n");
  });

  it("appends to another chat's kept draft without touching the box", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("mine");
    expect(composer.quote("B", "quoted", false)).toBe(true);
    expect(composer.text).toBe("mine");
    expect(sent).toContainEqual({ type: "draft", botID: "B", text: "quoted\n\n", cursor: 8 });
    composer.update(state("B"));
    expect(composer.text).toBe("quoted\n\n");
  });

  it("writes nothing for empty text or before the box knows its chat", () => {
    const composer = new Composer(document.body);
    expect(composer.quote("A", "x", false)).toBe(false);
    composer.update(state("A"));
    expect(composer.quote("A", "\n\n", false)).toBe(false);
    expect(composer.text).toBe("");
  });
});
