import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { applyPatch } from "../src/patch";
import type { ChatState, ComponentInfo, MessageView } from "../src/types";

// Updates with only what changed (ccb.patchState): a long chat sent and parsed every message
// and all components on every streamed step.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(id: string, text: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id, role: "bot", text, stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, ...overrides,
  };
}

const components: Record<string, ComponentInfo> = { card: { template: "<p>card</p>", version: 0, working: false, updated: false, hasPrevious: false } };

function base(overrides: Partial<ChatState> = {}): Omit<ChatState, "messages" | "components"> {
  const { messages: _m, components: _c, ...rest } = {
    botID: "b1", botName: "Main bot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  } as ChatState;
  return rest;
}

describe("applyPatch", () => {
  it("keeps unchanged messages as the same objects, in the new order", () => {
    const a = message("a", "one"), b = message("b", "two");
    const first = applyPatch(null, { base: base(), components, order: ["a", "b"], changed: [a, b] })!;
    expect(first.messages).toEqual([a, b]);
    expect(first.components).toBe(components);

    const b2 = message("b", "two, longer");
    const c = message("c", "three");
    const next = applyPatch(first, { order: ["a", "b", "c"], changed: [b2, c] })!;
    expect(next.messages[0]).toBe(a);
    expect(next.messages[1]).toBe(b2);
    expect(next.messages[2]).toBe(c);
    expect(next.components).toBe(components);
    expect(next.botID).toBe("b1");

    // A message gone; the base changed.
    const later = applyPatch(next, { base: base({ working: true }), order: ["a", "c"], changed: [] })!;
    expect(later.messages.map((m) => m.id)).toEqual(["a", "c"]);
    expect(later.working).toBe(true);
  });

  it("cannot apply without an earlier state or with a message it does not know", () => {
    expect(applyPatch(null, { order: [], changed: [] })).toBeNull();
    const first = applyPatch(null, { base: base(), components, order: ["a"], changed: [message("a", "x")] })!;
    expect(applyPatch(first, { order: ["a", "zz"], changed: [] })).toBeNull();
  });
});

describe("the chat page", () => {
  beforeAll(async () => {
    document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
    await import("../src/main");
  });
  beforeEach(() => { sent.length = 0; });

  it("resizes existing message and typing faces through patches, clamps values and restores defaults", () => {
    const state = { ...base({ working: true }), messages: [message("size", "hello", { avatar: "face" })], components: {} } as ChatState;
    window.ccb.setState(state);
    const row = document.querySelector(".row.bot");
    const typing = document.querySelector(".typing > .avatar");
    const size = () => document.documentElement.style.getPropertyValue("--chat-avatar-size");
    expect(size()).toBe("");
    for (const [input, output] of [[80, 80], [999, 96], [-2, 32]]) {
      window.ccb.patchState({ base: base({ working: true, chatAvatarSize: input }), order: ["size"], changed: [] });
      expect(size()).toBe(`${output}px`);
      expect(document.querySelector(".row.bot")).toBe(row);
      expect(document.querySelector(".typing > .avatar")).toBe(typing);
    }
    // Newly opened chats receive the same global size in their first full state.
    window.ccb.setState({ ...state, botID: "another", chatAvatarSize: 96 });
    expect(size()).toBe("96px");
    window.ccb.patchState({ base: base(), order: ["size"], changed: [] });
    expect(size()).toBe("");
    window.ccb.setState({ ...state, chatAvatarSize: NaN });
    expect(size()).toBe("");
  });

  it("keeps each head's verification disclosure and keyboard focus through live verdict updates", () => {
    const head = (id: string, speaker: string, state: "checking" | "judged" | "interrupted", reason?: string) => message(id, "Reply", {
      speaker, completionVerification: { model: "gpt-6-luna", state, verdict: state === "judged" ? "WAITING_DEPENDENCY" : null, reason },
    });
    window.ccb.setState({ ...base(), components: {}, messages: [head("claude", "botling · Claude", "checking"), head("codex", "botling · Codex", "checking")] } as ChatState);
    const card = (id: string) => document.querySelector<HTMLDetailsElement>(`[data-id="${id}"] .completion-verification`)!;
    expect(card("claude").open).toBe(false);
    expect(card("codex").open).toBe(false);
    card("claude").querySelector("summary")!.click();
    card("claude").querySelector("summary")!.focus();
    window.ccb.patchState({ order: ["claude", "codex"], changed: [head("claude", "botling · Claude", "judged", "Actual dependency"), head("codex", "botling · Codex", "interrupted")] });
    expect(card("claude").open).toBe(true);
    expect(card("claude").querySelector(".verification-reason")?.textContent).toBe("Actual dependency");
    expect(document.activeElement).toBe(card("claude").querySelector("summary"));
    expect(card("codex").open).toBe(false);
    expect(card("codex").querySelector("summary")?.textContent).toContain("Interrupted; no verdict");
    card("claude").querySelector("summary")!.click();
    window.ccb.patchState({ order: ["claude", "codex"], changed: [head("claude", "botling · Claude", "judged", "Updated dependency")] });
    expect(card("claude").open).toBe(false);
    expect(card("claude").textContent).toContain("Updated dependency");
    window.ccb.setState({ ...base({ botID: "other-chat" }), components: {}, messages: [head("claude", "botling · Claude", "checking")] } as ChatState);
    expect(card("claude").open).toBe(false);
  });

  it("redraws only what a patch changed, and asks for everything when it cannot apply one", () => {
    const a = message("a", "first"), b = message("b", "second");
    window.ccb.patchState({ base: base(), components, order: ["a", "b"], changed: [a, b] });
    const rows = () => [...document.querySelectorAll("#messages > *")];
    const [rowA, rowB] = rows();
    expect(rows()).toHaveLength(2);

    window.ccb.patchState({ order: ["a", "b", "c"], changed: [message("b", "second, more"), message("c", "third")] });
    const after = rows();
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(rowA);
    expect(after[1]).not.toBe(rowB);
    expect(after[1].textContent).toContain("second, more");
    expect(after[2].textContent).toContain("third");

    // A message it was never sent: the page asks again instead of drawing a hole.
    window.ccb.patchState({ order: ["a", "missing"], changed: [] });
    expect(sent).toContainEqual({ type: "resync" });
    expect(rows()).toHaveLength(3);
  });
});
