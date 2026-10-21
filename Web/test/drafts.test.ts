import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { sent } from "../src/bridge";
import { Composer, draftDelay } from "../src/composer";
import type { ChatState } from "../src/types";

function state(botID: string, overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID, botName: botID, messages: [], working: false, avatar: "", placeholder: "Make a wish…",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  } as ChatState;
}

const drafts = () => sent.filter((action) => action.type === "draft");

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("drafts", () => {
  it("keep each bot's unsent text and caret when switching A → B → A", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("Hello from A");
    composer.view.dispatch({ selection: { anchor: 5 } });
    composer.update(state("B"));
    expect(composer.text).toBe("");
    composer.insert("B's words");
    composer.update(state("A"));
    expect(composer.text).toBe("Hello from A");
    expect(composer.view.state.selection.main.head).toBe(5);
    composer.update(state("B"));
    expect(composer.text).toBe("B's words");
    // Switching away saves at once, for an app restart.
    expect(drafts()).toContainEqual({ type: "draft", botID: "A", text: "Hello from A", cursor: 5 });
    expect(drafts()).toContainEqual({ type: "draft", botID: "B", text: "B's words", cursor: 9 });
  });

  it("are not shared: a bot never typed in starts empty", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("only A");
    composer.update(state("B"));
    expect(composer.text).toBe("");
    composer.update(state("C"));
    expect(composer.text).toBe("");
  });

  it("are cleared by sending", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("send me");
    composer.update(state("B"));
    composer.update(state("A"));
    composer.submit();
    expect(composer.text).toBe("");
    expect(sent.at(-1)).toEqual({ type: "draft", botID: "A", text: "", cursor: 0 });
    composer.update(state("B"));
    composer.update(state("A"));
    expect(composer.text).toBe("");
  });

  it("are saved a moment after typing stops, not on every key", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("a");
    composer.insert("b");
    expect(drafts()).toEqual([]);
    vi.advanceTimersByTime(draftDelay);
    expect(drafts()).toEqual([{ type: "draft", botID: "A", text: "ab", cursor: 2 }]);
  });

  it("come back from the app after a restart", () => {
    const composer = new Composer(document.body);
    composer.setDrafts({ A: { text: "from yesterday", cursor: 4 } });
    composer.update(state("A"));
    expect(composer.text).toBe("from yesterday");
    expect(composer.view.state.selection.main.head).toBe(4);
    // Restoring is not typing: nothing is saved back.
    vi.advanceTimersByTime(draftDelay);
    expect(drafts()).toEqual([]);
  });

  it("keep only committed text while an input method is composing", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("你");
    vi.advanceTimersByTime(draftDelay);
    sent.length = 0;
    // Mid-composition: the candidate being chosen is not a draft yet.
    Object.defineProperty(composer.view, "composing", { configurable: true, get: () => true });
    composer.insert("hao");
    vi.advanceTimersByTime(draftDelay);
    expect(drafts()).toEqual([]);
    // Switching away mid-composition: A keeps "你" (already saved), not the half-typed "hao".
    composer.update(state("B"));
    expect(drafts()).toEqual([]);
    Object.defineProperty(composer.view, "composing", { configurable: true, get: () => false });
    composer.update(state("A"));
    expect(composer.text).toBe("你");
  });

  it("do not undo into another bot's text", () => {
    const composer = new Composer(document.body);
    composer.update(state("A"));
    composer.insert("A text");
    composer.update(state("B"));
    composer.insert("x");
    composer.update(state("A"));
    composer.update(state("B"));
    expect(composer.text).toBe("x");
    // History starts again with each bot's text: undo has nothing of A's to put back.
    undo(composer.view);
    expect(composer.text).toBe("x");
  });
});
