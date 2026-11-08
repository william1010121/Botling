/// <reference types="node" />
// Several questions answered together: one card group, one Submit, the answers sent as `picks`.
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { answerAction, answerPicks, choicesDrawGroups } from "../src/components";
import { messageElement } from "../src/messages";
import type { MessageView, QuestionView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const questions: QuestionView[] = [
  { question: "Which database?", multiple: false, options: [{ label: "Postgres", detail: "managed", recommended: true }, { label: "SQLite", detail: null, recommended: false }] },
  { question: "Which features?", multiple: true, options: [{ label: "Login", detail: null, recommended: false }, { label: "Export", detail: null, recommended: false }, { label: "Search", detail: null, recommended: false }] },
  { question: "Deploy now?", multiple: false, options: [{ label: "Yes", detail: null, recommended: true }, { label: "No", detail: null, recommended: false }] },
];

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "g1", role: "bot", text: "Three things.", stamp: null, avatar: null,
    choices: questions[0]!.options, chosen: null, answer: null, open: true, questions, picks: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, ...overrides,
  };
}

beforeEach(() => { sent.length = 0; document.body.innerHTML = ""; });

describe("question groups", () => {
  it("draws every question with radio or checkbox options, Other and Skip, and one Submit", () => {
    const row = messageElement(message({}), {});
    const sections = row.querySelectorAll(".question");
    expect(sections).toHaveLength(3);
    expect([...sections].map((s) => s.querySelector(".question-words")?.textContent)).toEqual(["Which database?", "Which features?", "Deploy now?"]);
    expect(sections[0]!.querySelector(".question-option")?.getAttribute("role")).toBe("radio");
    expect(sections[1]!.querySelector(".question-option")?.getAttribute("role")).toBe("checkbox");
    expect(row.querySelectorAll(".question-other input")).toHaveLength(3);
    expect(row.querySelectorAll(".question-skip")).toHaveLength(3);
    expect(row.querySelectorAll(".question-submit")).toHaveLength(1);
  });

  it("sends nothing until every question is answered or skipped, then one answer with picks in order", () => {
    const row = messageElement(message({}), {});
    const submit = row.querySelector<HTMLButtonElement>(".question-submit")!;
    const sections = [...row.querySelectorAll(".question")];
    const options = (at: number) => [...sections[at]!.querySelectorAll<HTMLButtonElement>(".question-option")];
    expect(submit.disabled).toBe(true);
    // Single-choice: a second pick replaces the first.
    options(0)[0]!.click();
    options(0)[1]!.click();
    expect(options(0).map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    // Multi-select: ticks add up, a second click unticks; Other goes with them.
    options(1)[2]!.click();
    options(1)[0]!.click();
    options(1)[1]!.click();
    options(1)[1]!.click();
    const other = sections[1]!.querySelector<HTMLInputElement>(".question-other input")!;
    other.value = " SSO ";
    other.dispatchEvent(new Event("input"));
    expect(submit.disabled).toBe(true);
    submit.click();
    expect(sent).toEqual([]);
    sections[2]!.querySelector<HTMLButtonElement>(".question-skip")!.click();
    expect(sections[2]!.classList.contains("skipped")).toBe(true);
    expect(submit.disabled).toBe(false);
    submit.click();
    submit.click();
    expect(sent).toEqual([{ type: "answer", messageID: "g1", text: "", picks: [{ options: [1] }, { options: [0, 2], other: "SSO" }, { options: [], skipped: true }] }]);
  });

  it("typing Other on a single-choice question clears its option", () => {
    const row = messageElement(message({ questions: [questions[0]!], choices: questions[0]!.options }), {});
    row.querySelector<HTMLButtonElement>(".question-option")!.click();
    const input = row.querySelector<HTMLInputElement>(".question-other input")!;
    input.value = "MySQL";
    input.dispatchEvent(new Event("input"));
    row.querySelector<HTMLButtonElement>(".question-submit")!.click();
    expect(sent).toEqual([{ type: "answer", messageID: "g1", text: "", picks: [{ options: [], other: "MySQL" }] }]);
  });

  it("folds an answered group to each answer, and opens it again read only", () => {
    const row = messageElement(message({ open: false, answer: "1. Which database?\n→ SQLite", picks: [
      { options: [1], other: null, skipped: false }, { options: [0, 2], other: "SSO", skipped: false }, { options: [], other: null, skipped: true }] }), {});
    const folded = row.querySelector<HTMLButtonElement>(".folded-choice")!;
    expect(folded.textContent).toBe("SQLite · Login; Search; Other: SSO · Skipped");
    folded.click();
    expect(row.querySelector(".question-submit")).toBeNull();
    expect([...row.querySelectorAll<HTMLButtonElement>(".question-option")].every((b) => b.disabled)).toBe(true);
    expect(row.querySelectorAll(".question-option.picked")).toHaveLength(3);
    expect(row.querySelector<HTMLInputElement>(".question-other:not([hidden]) input")?.value).toBe("SSO");
    row.querySelector<HTMLButtonElement>(".fold")!.click();
    expect(row.querySelector(".folded-choice")).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("an ignored group lists its questions", () => {
    const row = messageElement(message({ open: false, ignoredAt: "2026-11-08T00:00:00.000Z" }), {});
    expect([...row.querySelectorAll(".ignored-question li")].map((li) => li.textContent)).toEqual([
      "Which database?: Postgres / SQLite", "Which features?: Login / Export / Search", "Deploy now?: Yes / No"]);
  });

  it("uses the 「choices」 template only when it says it draws groups", () => {
    const plain = { template: "<p>pick</p>", version: 0, working: false, updated: false, hasPrevious: false };
    const groups = { ...plain, template: "<div id=\"root\" data-ccb-questions></div>" };
    expect(choicesDrawGroups(plain)).toBe(false);
    expect(choicesDrawGroups(groups)).toBe(true);
    expect(messageElement(message({}), { choices: plain }).querySelector(".question-group")).not.toBeNull();
    expect(messageElement(message({ id: "g2" }), { choices: groups }).querySelector(".question-group")).toBeNull();
  });

  it("a template's group answer becomes the same action", () => {
    expect(answerPicks([{ options: [1, 9, "x"], other: " hi " }, { skipped: true }])).toEqual([{ options: [1], other: "hi" }, { options: [], skipped: true }]);
    expect(answerPicks([])).toBeNull();
    expect(answerAction("g1", { picks: [{ options: [0] }] })).toEqual({ type: "answer", messageID: "g1", text: "", picks: [{ options: [0] }] });
  });
});
