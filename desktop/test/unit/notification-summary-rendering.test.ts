// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "../../src/renderer/chat-frame/notification-summary";
import { IntervalSummaries } from "../../../Web/src/catchup";
import { messageElement } from "../../../Web/src/messages";
import { sent } from "../../../Web/src/bridge";
import type { ChatState, MessageView } from "../../../Web/src/types";

const line = (id: string, role: MessageView["role"]): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: null, choices: null,
  chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false,
});
const state = (messages: MessageView[]): ChatState => ({
  botID: "main", botName: "Main", avatar: "", messages, live: [], working: false,
  placeholder: "Message Main", replyingTo: null, components: {}, pendingFiles: [],
});
const find = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`);
function draw(messages: MessageView[]) {
  document.body.replaceChildren(...messages.map(message => messageElement(message, {})));
}
afterEach(() => { document.body.replaceChildren(); sent.splice(0); });

describe("notification summary footer", () => {
  it("keeps bot-only footers and excludes error, relay and divider metadata from eligibility", () => {
    const messages = [line("u1", "user"), line("b1", "bot"), line("u2", "user"), line("e", "error"), line("r", "relay"), line("d", "divider")];
    draw(messages);
    new IntervalSummaries().update(state(messages), find);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".interval-summary-trigger")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest<HTMLElement>(".row")?.dataset.id).toBe("b1");
    buttons[0]!.click();
    expect(sent.at(-1)).toEqual({ type: "catchUpManual", botID: "main", userMessageID: "u1" });
  });

  it("offers notice-only intervals and preserves the notice role and original interval id", () => {
    const messages = [line("u1", "user"), line("n1", "notice"), line("n2", "notice"), line("u2", "user"), line("n3", "notice")];
    draw(messages);
    const summaries = new IntervalSummaries();
    summaries.update(state(messages), find);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".interval-summary-trigger")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.closest<HTMLElement>(".row")?.dataset.id).toBe("n2");
    expect(buttons[0]!.textContent).toContain("2");
    buttons[0]!.click();
    expect(sent.at(-1)).toEqual({ type: "catchUpManual", botID: "main", userMessageID: "u1" });
    expect(find("n2")?.classList.contains("notice")).toBe(true);
    expect(messages[2]!.role).toBe("notice");
    buttons[0]!.focus();
    summaries.update(state(messages), find);
    expect(document.querySelectorAll(".interval-summary-trigger")).toHaveLength(2);
    expect(document.activeElement).toBe(buttons[0]);
    summaries.update({ ...state(messages), subagent: {} as never }, find);
    expect(document.querySelector(".interval-summary-trigger")).toBeNull();
  });

  it("puts one trigger on the last bot or notice and removes it once that range is summarized", () => {
    const messages = [line("u", "user"), line("b", "bot"), line("n", "notice"), line("metadata", "divider")];
    draw(messages);
    const summaries = new IntervalSummaries();
    summaries.update(state(messages), find);
    const trigger = document.querySelector<HTMLButtonElement>(".interval-summary-trigger");
    expect(document.querySelectorAll(".interval-summary-trigger")).toHaveLength(1);
    expect(trigger?.closest<HTMLElement>(".row")?.dataset.id).toBe("n");
    expect(trigger?.textContent).toContain("2");
    summaries.update({ ...state(messages), intervalSummaries: [{
      key: "k", ids: ["b", "n", "metadata"], count: 2, heads: null, state: "ready", bullets: ["Done"],
      error: null, model: "test", since: null, until: null, latest: null, manual: true,
    }] }, find);
    expect(document.querySelector(".interval-summary-trigger")).toBeNull();
    expect(document.querySelector(".catchup-card")).not.toBeNull();
    expect(find("n")?.classList.contains("catchup-folded")).toBe(true);
    summaries.update(state([line("other", "user")]), () => null);
  });
});
