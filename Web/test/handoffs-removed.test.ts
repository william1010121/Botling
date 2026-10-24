import { beforeAll, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import type { ChatState, HandoffView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const record = (state: HandoffView["state"], id = state): HandoffView => ({
  id, from: "claude", to: "codex", fromName: "Claude", toName: "Codex", kind: "task",
  task: "Review the toolbar", origin: "Fix the toolbar", round: 1, limit: 6, state,
  lines: [{ who: "claude", name: "Claude", text: "Review the toolbar" }],
});
const chat = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "handoff-chat", botName: "Botling", messages: [], working: false, avatar: "", placeholder: "Message…",
  replyingTo: null, pendingFiles: [], components: {}, ...extra,
});
beforeAll(async () => {
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../src/main");
});

describe("chat without inferred hand-off presentation", () => {
  it("does not mount a chip, panel or stop controls even with active, waiting and ended records", () => {
    sent.length = 0;
    window.ccb.setState(chat({ handoffs: [record("running"), record("waiting"), record("done"), record("stopped")],
      rounds: { kind: "handoff", round: 2, limit: 6, text: "Hand-off 2/6", stop: "Stop now" } }));
    expect(document.querySelector(".handoff-chip, .handoff-panel, .handoff-toggle, .handoff-stop-all")).toBeNull();
    expect(document.querySelector(".composer")).not.toBeNull();
    expect(sent.filter((item) => item.type === "stopRounds" || item.type === "stopHandoff")).toEqual([]);
  });

  it("keeps hand-off history and normal chat controls across patches and bot changes", () => {
    const divider = { id: "history", role: "divider", text: "Claude → Codex: review toolbar", stamp: null,
      avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null,
      replyTo: null, replyPreview: null, openable: false } as const;
    window.ccb.setState(chat({ messages: [divider], handoffs: [record("running")] }));
    window.ccb.patchState({ base: chat({ handoffs: [record("done")] }), changed: [], order: [divider.id] });
    expect(document.getElementById("messages")?.textContent).toContain(divider.text);
    window.ccb.setState(chat({ botID: "another-chat", rounds: { kind: "discussion", round: 2, limit: 3, text: "Round 2/3", stop: "Stop now" } }));
    expect(document.querySelector(".handoff-chip, .handoff-panel")).toBeNull();
    expect(document.querySelector(".composer textarea, .composer .cm-editor")).not.toBeNull();
  });
});
