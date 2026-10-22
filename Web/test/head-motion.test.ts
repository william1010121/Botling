import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState, MessageView, StepView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "head-motion", botName: "Bot", messages: [], working: false, avatar: "codex-avatar", placeholder: "",
  replyingTo: null, pendingFiles: [], components: {}, seenHeads: { C: "data:c", X: "data:x" }, ...extra,
});

const message = (id: string, codexSeen = false): MessageView => ({
  id, role: "user", text: "Review", stamp: null, avatar: null, choices: null, chosen: null,
  answer: null, open: false, display: null, attachments: null, replyTo: null, replyPreview: null, openable: false,
  seen: [{ mark: "C", name: "Claude", seen: true, recipient: true }, { mark: "X", name: "Codex", seen: codexSeen, recipient: false }],
});

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("head motion lifecycle", () => {
  it("keeps the active live avatar across streamed steps, then settles on completion", () => {
    window.ccb.setState(state({ working: true }));
    const row = document.querySelector(".typing")!;
    const avatar = row.querySelector(".avatar")!;
    const step: StepView = { id: "tool1", kind: "tool", title: "Run checks", tool: "Bash", detail: null, output: null, failed: false, done: false, status: null, count: null };
    window.ccb.setState(state({ working: true, live: [step] }));
    expect(document.querySelector(".typing")).toBe(row);
    expect(document.querySelector(".typing .avatar")).toBe(avatar);
    window.ccb.setState(state({ working: true, avatar: "claude-avatar" }));
    expect(document.querySelector<HTMLImageElement>(".typing .avatar")!.getAttribute("src")).toBe("claude-avatar");
    window.ccb.setState(state());
    expect(document.querySelector(".typing")).toBeNull();
  });

  it("bounces only new targets or read checks, never historical or repeatedly redrawn heads", () => {
    window.ccb.setState(state({ botID: "receipt-motion", messages: [message("old")] }));
    expect(document.querySelectorAll(".head-arrive, .receipt-arrive")).toHaveLength(0);
    window.ccb.setState(state({ botID: "receipt-motion", messages: [message("old"), message("new")] }));
    expect(document.querySelectorAll('[data-id="new"] .head-arrive')).toHaveLength(1);
    window.ccb.setState(state({ botID: "receipt-motion", messages: [message("old"), { ...message("new"), text: "Review now" }] }));
    expect(document.querySelectorAll('[data-id="new"] .head-arrive')).toHaveLength(0);
    window.ccb.setState(state({ botID: "receipt-motion", messages: [message("old"), message("new", true)] }));
    expect(document.querySelectorAll('[data-id="new"] .head-arrive')).toHaveLength(0);
    expect(document.querySelectorAll('[data-id="new"] .receipt-arrive')).toHaveLength(1);
  });
});
