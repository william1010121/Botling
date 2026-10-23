import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import type { ChatState, MessageView, StepView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const step = (id: string, kind: StepView["kind"], title: string, extra: Partial<StepView> = {}): StepView =>
  ({ id, kind, title, tool: null, detail: null, output: null, failed: false, done: true, status: null, count: null, ...extra });
let sequence = 0;
const message = (steps: StepView[], earlier = false): MessageView => ({
  id: `placement-reply-${sequence}`, role: "bot", text: "Workers launched.", stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, display: null,
  attachments: null, replyTo: null, replyPreview: null, openable: false, steps, earlier,
});
const state = (engine: string, overrides: Partial<ChatState> = {}): ChatState => ({
  botID: `placement-${engine}`, botName: engine, working: false, avatar: "", placeholder: "",
  messages: [], replyingTo: null, pendingFiles: [], components: {}, ...overrides,
});
beforeAll(async () => {
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../src/main");
});
beforeEach(() => { sequence++; sent.length = 0; });

// Both engines feed the same StepView renderer. Codex commentary and Claude text between
// tool calls must exercise the text branch, as well as Claude's common calls-only branch.
describe.each(["codex-worker", "claude"])("%s cards in the reply", (engine) => {
  it("keeps the commentary worker outside collapsed Worked", () => {
    const id = `${engine}-commentary`;
    window.ccb.setState(state(engine, { messages: [message([
      step("commentary", "text", "I will delegate the review."),
      step("call", "tool", "Launch review"),
      step(id, "subagent", "Review placement", { status: "running", done: false }),
    ])] }));
    const card = document.querySelector<HTMLElement>("#messages .subagent-card")!;
    expect(card.closest("[hidden]")).toBeNull();
    expect(card.closest(".steps")).toBeNull();
  });
  it.each([false, true])("survive streaming, finalization, folding and history (commentary: %s)", (commentary) => {
    const id = engine === "codex-worker" ? "worker:task-123" : "toolu_A";
    const running = step(id, "subagent", "Review placement", { status: "running", done: false, count: 2 });
    const steps = [
      ...(commentary ? [step("note", "text", "I will ask a worker to review.")] : []),
      running,
      ...Array.from({ length: 9 }, (_, i) => step(`tool-${i}`, "tool", `Read file ${i}`)),
    ];
    const assertCard = (status: string) => {
      const cards = document.querySelectorAll<HTMLButtonElement>("#messages .subagent-card");
      expect(cards).toHaveLength(1);
      const card = cards[0];
      expect(card.closest("[hidden]")).toBeNull();
      expect(card.closest(".steps, .steps-run, .steps-body")).toBeNull();
      expect(card.classList.contains(status)).toBe(true);
      expect(card.textContent).toContain("Review placement");
      expect(card.textContent).toContain(status === "running" ? "2 tools" : "5 tools");
      card.click();
      expect(sent.at(-1)).toEqual({ type: "openSubagent", id });
    };
    window.ccb.setState(state(engine, { working: true, live: steps }));
    assertCard("running");
    window.ccb.setState(state(engine, { working: true, live: [...steps, step("more", "tool", "Another call")] }));
    assertCard("running");
    window.ccb.setState(state(engine, { messages: [message(steps)] }));
    assertCard("running");
    const toggle = document.querySelector<HTMLButtonElement>('#messages .steps > .steps-toggle')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    assertCard("running");
    toggle.click();
    assertCard("running");
    const completed = steps.map(s => s.id === id ? { ...s, done: true, status: "completed", count: 5 } : s);
    window.ccb.setState(state(engine, { messages: [message(completed)] }));
    assertCard("completed");
    window.ccb.setState(state("elsewhere"));
    window.ccb.setState(state(engine, { messages: [JSON.parse(JSON.stringify(message(completed, true)))] }));
    assertCard("completed");
  });
  it("keeps multiple workers' status and Open IDs associated when Worked toggles", () => {
    const ids = [`${engine}-active`, `${engine}-finished`];
    window.ccb.setState(state(engine, { messages: [message([
      step("multi-note", "text", "Two independent reviews."),
      step(ids[0], "subagent", "Active review", { status: "running", done: false, count: 2 }),
      step(ids[1], "subagent", "Finished review", { status: "completed", count: 7 }),
    ])] }));
    for (let i = 0; i < 3; i++) {
      const cards = [...document.querySelectorAll<HTMLButtonElement>("#messages .subagent-card")];
      expect(cards).toHaveLength(2);
      expect(cards[0].classList.contains("running")).toBe(true);
      expect(cards[1].classList.contains("completed")).toBe(true);
      expect(cards[0].textContent).toContain("2 tools");
      expect(cards[1].textContent).toContain("7 tools");
      cards.forEach((card, index) => {
        expect(card.closest("[hidden], .steps")).toBeNull();
        card.click();
        expect(sent.at(-1)).toEqual({ type: "openSubagent", id: ids[index] });
      });
      document.querySelector<HTMLButtonElement>("#messages .steps > .steps-toggle")!.click();
    }
  });
  it("shows a card-only reply without an empty Worked toggle", () => {
    window.ccb.setState(state(engine, { messages: [message([step(`${engine}-only`, "subagent", "Only worker", { status: "completed" })])] }));
    expect(document.querySelectorAll("#messages .subagent-card")).toHaveLength(1);
    expect(document.querySelector("#messages .steps-toggle")).toBeNull();
  });
});
