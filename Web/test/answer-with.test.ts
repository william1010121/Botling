import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerPrefix, Composer } from "../src/composer";
import { sent } from "../src/bridge";
import type { ChatState } from "../src/types";

const answer = { options: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "both", label: "Both" }], chosen: "claude" };

describe("@codex at the start of a message in a bot with two heads", () => {
  it("picks that head and leaves the words", () => {
    expect(answerPrefix("@codex review PR #5", answer)).toEqual({ id: "codex", rest: "review PR #5" });
    expect(answerPrefix("  @Both which is better?", answer)).toEqual({ id: "both", rest: "which is better?" });
  });

  it("leaves other @names and mid-sentence mentions alone", () => {
    expect(answerPrefix("@Gemini hi", answer)).toBeNull();
    expect(answerPrefix("ask @codex later", answer)).toBeNull();
    expect(answerPrefix("@codex", answer)).toBeNull();
  });
});

describe("seen marks in a bot with two heads", () => {
  it("light the heads a line has reached and name the rest", async () => {
    const { seenMarks } = await import("../src/messages");
    const marks = seenMarks([{ mark: "C", name: "Claude", seen: true }, { mark: "X", name: "Codex", seen: false }]);
    expect([...marks.querySelectorAll(".seen-mark")].map((mark) => [mark.textContent, mark.classList.contains("on")])).toEqual([["C", true], ["X", false]]);
    expect(marks.title).toBe("Seen by Claude · not yet by Codex");
  });
});


describe("the saved Answer with choice", () => {
  let composers: Composer[];
  const state = (botID: string, chosen = "claude"): ChatState => ({
    botID, botName: botID, messages: [], working: false, avatar: "", placeholder: "Message…",
    replyingTo: null, pendingFiles: [], components: {}, answerWith: { ...answer, chosen },
  } as ChatState);
  const makeComposer = () => {
    const composer = new Composer(document.body);
    composers.push(composer);
    return composer;
  };
  const pick = (id: string) => document.querySelector<HTMLButtonElement>(`.answer-chip[data-head="${id}"]`)!.click();
  const chosen = () => document.querySelector<HTMLButtonElement>(".answer-chip.picked")?.dataset.head;
  const sends = () => sent.filter((action) => action.type === "send");

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    composers = [];
    document.body.innerHTML = "";
  });
  afterEach(() => {
    composers.forEach((composer) => composer.view.destroy());
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves an explicit choice immediately, before any message is sent", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    expect(sent).toContainEqual({ type: "setAnswerWith", botID: "A", to: "codex", requestID: 1 });
    expect(sends()).toEqual([]);
    expect(chosen()).toBe("codex");
  });

  it("keeps the choice across sends and state updates while the save reaches Swift", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    composer.setText("first");
    composer.submit();
    expect(chosen()).toBe("codex");
    composer.update(state("A"));
    composer.setText("second");
    composer.submit();
    expect(sends()).toEqual([
      { type: "send", text: "first", to: "codex" },
      { type: "send", text: "second", to: "codex" },
    ]);
    composer.update(state("A", "codex"));
    expect(chosen()).toBe("codex");
  });

  it("keeps pending choices per bot when switching, without copying them to other bots", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    composer.update(state("B", "both"));
    expect(chosen()).toBe("both");
    pick("claude");
    composer.update(state("A"));
    expect(chosen()).toBe("codex");
    composer.update(state("B", "both"));
    expect(chosen()).toBe("claude");
  });

  it("does not leave an unchanged click masking later native settings changes", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("claude");
    composer.update(state("A", "codex"));
    expect(chosen()).toBe("codex");
  });

  it("keeps the latest rapid choice while earlier saves and state pushes arrive", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    pick("both");
    composer.answerWithSaved({ botID: "A", requestID: 1, chosen: "codex" });
    composer.update(state("A", "codex"));
    expect(chosen()).toBe("both");
    composer.setText("latest choice");
    composer.submit();
    expect(sends()).toEqual([{ type: "send", text: "latest choice", to: "both" }]);
    composer.answerWithSaved({ botID: "A", requestID: 2, chosen: "both" });
    composer.update(state("A", "both"));
    expect(chosen()).toBe("both");
    composer.update(state("A", "claude"));
    expect(chosen()).toBe("claude");
  });

  it("does not mistake an old baseline push for acknowledgement of a rapid return to that choice", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    pick("claude");
    composer.update(state("A")); // In-flight baseline, before either save was handled.
    composer.answerWithSaved({ botID: "A", requestID: 1, chosen: "codex" });
    composer.update(state("A", "codex"));
    expect(chosen()).toBe("claude");
    composer.answerWithSaved({ botID: "A", requestID: 2, chosen: "claude" });
    composer.update(state("A"));
    expect(chosen()).toBe("claude");
    composer.update(state("A", "both"));
    expect(chosen()).toBe("both");
  });

  it("handles a rejected save and acknowledgements received while another bot is open", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    composer.update(state("B", "both"));
    composer.answerWithSaved({ botID: "A", requestID: 1, chosen: "claude" });
    expect(chosen()).toBe("both");
    composer.update(state("A"));
    expect(chosen()).toBe("claude");
    composer.update(state("A", "both"));
    expect(chosen()).toBe("both");
  });

  it("saves keyboard picks and drops a pending choice when that engine is disabled", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", altKey: true, bubbles: true }));
    expect(sent).toContainEqual({ type: "setAnswerWith", botID: "A", to: "codex", requestID: 1 });
    composer.update({ ...state("A"), answerWith: { options: [answer.options[0]], chosen: "claude" } });
    expect(chosen()).toBe("claude");
  });

  it("lets @mentions override one message without changing the saved choice", () => {
    const composer = makeComposer();
    composer.update(state("A", "codex"));
    composer.setText("@Claude review this");
    composer.submit();
    expect(chosen()).toBe("codex");
    composer.setText("next task");
    composer.submit();
    expect(sends()).toEqual([
      { type: "send", text: "review this", to: "claude" },
      { type: "send", text: "next task", to: "codex" },
    ]);
    expect(sent.some((action) => action.type === "setAnswerWith")).toBe(false);
  });

  it("uses the persisted choice after page recreation and follows later native settings changes", () => {
    const composer = makeComposer();
    composer.update(state("A"));
    pick("codex");
    composer.update(state("A", "codex"));
    composer.answerWithSaved({ botID: "A", requestID: 1, chosen: "codex" });
    composer.update(state("A", "both"));
    expect(chosen()).toBe("both");
    composer.view.destroy();
    composers = [];
    document.body.innerHTML = "";
    const restarted = makeComposer();
    restarted.update(state("A", "both"));
    restarted.setText("after restart");
    restarted.submit();
    expect(sends()).toEqual([{ type: "send", text: "after restart", to: "both" }]);
  });
});

describe("Answer with inside the input box", () => {
  const state = (answerWith: ChatState["answerWith"]): ChatState => ({
    botID: "A", botName: "A", messages: [], working: false, avatar: "", placeholder: "Message…",
    replyingTo: null, pendingFiles: [], components: {}, answerWith,
  } as ChatState);

  it("sits in the toolbar under the text: +, the segmented heads, the keys, then send", () => {
    document.body.innerHTML = "";
    const composer = new Composer(document.body);
    composer.update(state(answer));
    const tools = document.querySelector(".composer > .composer-tools")!;
    expect([...tools.children].map((child) => child.className)).toEqual(["plus", "answer-with", "answer-hint", "composer-gap", "send"]);
    expect(tools.querySelector(".answer-with")?.getAttribute("aria-label")).toBe("Answer with");
    expect(tools.querySelector(".answer-hint")?.textContent).toBe("⌥1 ⌥2 ⌥3 · or type @codex");
    expect(document.querySelector(".composer > .composer-row .editor")).not.toBeNull();
    // Nothing outside the box any more.
    expect(document.body.children).toHaveLength(1);
    composer.update(state(null));
    expect(tools.querySelector<HTMLElement>(".answer-with")!.hidden).toBe(true);
    expect(tools.querySelector<HTMLElement>(".answer-hint")!.hidden).toBe(true);
    composer.view.destroy();
  });
});
