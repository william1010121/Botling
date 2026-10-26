// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSummaryReply } from "../../src/contract/summary";
import { IntervalSummaries, setSummaryCountable } from "../../../Web/src/catchup";
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
afterEach(() => {
  setSummaryCountable(message => message.role === "bot");
  document.body.replaceChildren();
  sent.splice(0);
});

it("keeps the shared 1.x default bot-only until desktop explicitly opts in", () => {
  const messages = [line("u1", "user"), line("b", "bot"), line("n1", "notice"), line("u2", "user"), line("n2", "notice")];
  draw(messages);
  new IntervalSummaries().update(state(messages), find);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".interval-summary-trigger")];
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.closest<HTMLElement>(".row")?.dataset.id).toBe("b");
  expect(buttons[0]!.textContent).toContain("1");
  expect(find("n1")?.querySelector(".bot-column")).toBeNull();
});

describe("notification summary footer", () => {
  beforeEach(() => setSummaryCountable(isSummaryReply));
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
    const bubble = find("n2")?.querySelector(".bot-column > .notice-bubble");
    expect(bubble).toBeTruthy();
    const summaries = new IntervalSummaries();
    summaries.update(state(messages), find);
    expect(find("n2")?.querySelector(".bot-column > .notice-bubble")).toBe(bubble);
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
    const next = line("next", "bot");
    messages.push(next);
    document.body.append(messageElement(next, {}));
    summaries.update(state(messages), find);
    expect(document.querySelectorAll(".interval-summary-trigger")).toHaveLength(1);
    expect(document.querySelector(".interval-summary-trigger")).toBe(trigger);
    expect(trigger?.closest<HTMLElement>(".row")?.dataset.id).toBe("next");
    expect(trigger?.textContent).toContain("3");
    summaries.update({ ...state(messages), intervalSummaries: [{
      key: "k", ids: ["b", "n", "metadata", "next"], count: 3, heads: null, state: "ready", bullets: ["Done"],
      error: null, model: "test", since: null, until: null, latest: null, manual: true,
    }] }, find);
    expect(document.querySelector(".interval-summary-trigger")).toBeNull();
    expect(document.querySelector(".catchup-card")).not.toBeNull();
    expect(find("n")?.classList.contains("catchup-folded")).toBe(true);
    summaries.update(state([line("other", "user")]), () => null);
  });
});
