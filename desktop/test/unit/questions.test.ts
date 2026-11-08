// Several questions in one reply (<choices question="…">), answered together with one message.
import { describe, expect, it } from "vitest";
import { parseReply } from "../../src/core/reply";
import { answerMessage, answerSummary, savedPicks, savedQuestions, validPicks, type Question } from "../../src/core/questions";

const block = (question: string, lines: string[], extra = "") => `<choices question="${question}"${extra}>\n${lines.join("\n")}\n</choices>`;

describe("reply parser: question groups", () => {
  it("leaves a plain <choices> block as it always was", () => {
    const parsed = parseReply("Pick one.\n<choices>\n* A | cheap\n- B\n</choices>");
    expect(parsed.choices).toEqual([{ label: "A", detail: "cheap", recommended: true }, { label: "B", recommended: false }]);
    expect(parsed.questions).toBeUndefined();
    expect(parsed.body).toBe("Pick one.");
  });

  it("keeps the last plain block with options when there are several", () => {
    const parsed = parseReply("<choices>\n- A\n- B\n</choices>\n<choices>\n- C\n- D\n</choices>\n<choices>\n</choices>");
    expect(parsed.choices?.map((c) => c.label)).toEqual(["C", "D"]);
    expect(parsed.questions).toBeUndefined();
  });

  it("reads one named question as a group of one", () => {
    const parsed = parseReply(`Two things.\n${block("Which database?", ["* Postgres | managed", "- SQLite"])}`);
    expect(parsed.questions).toEqual([{ question: "Which database?", multiple: false, options: [
      { label: "Postgres", detail: "managed", recommended: true }, { label: "SQLite", recommended: false }] }]);
    expect(parsed.choices?.map((c) => c.label)).toEqual(["Postgres", "SQLite"]);
    expect(parsed.body).toBe("Two things.");
  });

  it("reads five questions in order, single and multi-select", () => {
    const reply = [
      "Before I start:",
      block("Q1", ["* A", "- B"]),
      block("Q2", ["- Login", "* Export", "* Search", "- Billing"], ` multiple="true"`),
      block("Q3", ["* Yes", "- No"]),
      block("Q4", ["- X", "- Y", "- Z"], " multiple"),
      block("Q5", ["- 1", "* 2", "* 3"]),
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.questions?.map((q) => [q.question, q.multiple, q.options.length])).toEqual([
      ["Q1", false, 2], ["Q2", true, 4], ["Q3", false, 2], ["Q4", true, 3], ["Q5", false, 3]]);
    // Multi-select keeps every suggestion; single-choice keeps only the first.
    expect(parsed.questions![1]!.options.filter((o) => o.recommended).map((o) => o.label)).toEqual(["Export", "Search"]);
    expect(parsed.questions![4]!.options.filter((o) => o.recommended).map((o) => o.label)).toEqual(["2"]);
    expect(parsed.body).toBe("Before I start:");
  });

  it("keeps at most 5 questions and 6 options each", () => {
    const many = Array.from({ length: 7 }, (_, i) => block(`Q${i + 1}`, ["- a", "- b", "- c", "- d", "- e", "- f", "- g", "- h"])).join("\n");
    const parsed = parseReply(many);
    expect(parsed.questions).toHaveLength(5);
    expect(parsed.questions!.every((q) => q.options.length === 6)).toBe(true);
    expect(parsed.body).toBe("");
  });

  it("drops a malformed question (fewer than 2 options) and keeps the rest", () => {
    const parsed = parseReply(`${block("Bad", ["- only one"])}\n${block("Good", ["- a", "- b"])}`);
    expect(parsed.questions?.map((q) => q.question)).toEqual(["Good"]);
  });

  it("falls back to plain choices when no named question is well formed", () => {
    const parsed = parseReply(`${block("Bad", ["- only one"])}\n${block("Worse", [])}`);
    expect(parsed.questions).toBeUndefined();
    expect(parsed.choices?.map((c) => c.label)).toEqual(["only one"]);
  });

  it("multiple=\"false\" stays single-choice; quoted entities read back", () => {
    const parsed = parseReply(`<choices question="Use &quot;fast&quot; mode?" multiple="false">\n* Yes\n* No\n</choices>`);
    expect(parsed.questions).toEqual([{ question: "Use \"fast\" mode?", multiple: false, options: [{ label: "Yes", recommended: true }, { label: "No", recommended: false }] }]);
  });

  it("ignores question blocks inside code", () => {
    const parsed = parseReply("Example:\n```\n<choices question=\"Q\">\n- a\n- b\n</choices>\n```");
    expect(parsed.questions).toBeUndefined();
    expect(parsed.choices).toBeNull();
  });
});

describe("question group answers", () => {
  const questions: Question[] = [
    { question: "Which database?", multiple: false, options: [{ label: "Postgres", recommended: true }, { label: "SQLite", recommended: false }] },
    { question: "Which features?", multiple: true, options: [{ label: "Login", recommended: false }, { label: "Export", recommended: false }, { label: "Search", recommended: false }] },
    { question: "Deploy when?", multiple: false, options: [{ label: "Now", recommended: true }, { label: "Later", recommended: false }] },
    { question: "", multiple: false, options: [{ label: "A", recommended: false }, { label: "B", recommended: false }] },
  ];

  it("checks picks against the questions", () => {
    expect(validPicks(questions, [{ options: [0] }, { options: [2, 0, 2], other: " SSO " }, { options: [], other: "Monday" }, { options: [], skipped: true }]))
      .toEqual([{ options: [0] }, { options: [0, 2], other: "SSO" }, { options: [], other: "Monday" }, { options: [], skipped: true }]);
    expect(validPicks(questions, [{ options: [0] }])).toBeNull(); // one per question
    expect(validPicks(questions, [{ options: [0, 1] }, { options: [0] }, { options: [0] }, { options: [0] }])).toBeNull(); // single-choice, two picked
    expect(validPicks(questions, [{ options: [5] }, { options: [0] }, { options: [0] }, { options: [0] }])).toBeNull(); // no such option
    expect(validPicks(questions, [{ options: [] }, { options: [0] }, { options: [0] }, { options: [0] }])).toBeNull(); // unanswered
    expect(validPicks(questions, [{ options: [0], other: "x" }, { options: [0] }, { options: [0] }, { options: [0] }])).toBeNull(); // single: option and words
  });

  it("writes one message listing each question and its answer in order", () => {
    const picks = validPicks(questions, [{ options: [0] }, { options: [0, 1], other: "SSO" }, { options: [], other: "Monday" }, { options: [], skipped: true }])!;
    expect(answerMessage(questions, picks)).toBe([
      "1. Which database?", "→ Postgres",
      "2. Which features? (several allowed)", "→ Login; Export; Other: SSO",
      "3. Deploy when?", "→ Monday",
      "4. Question 4", "→ (Skipped)",
    ].join("\n"));
    expect(answerSummary(questions, picks)).toBe("Postgres · Login; Export; Other: SSO · Monday · (Skipped)");
  });

  it("keeps the per-option notes the user typed", () => {
    const picks = validPicks(questions, [
      { options: [1], notes: { "1": " managed is fine " } },
      { options: [0, 1], other: "SSO", notes: { "0": "first", "2": "not picked", "x": "bad", "1": "   " } },
      { options: [0], notes: { "0": "a".repeat(1_500) } },
      { options: [], skipped: true, notes: { "0": "ignored" } },
    ])!;
    expect(picks[0]).toEqual({ options: [1], notes: { "1": "managed is fine" } });
    expect(picks[1]).toEqual({ options: [0, 1], other: "SSO", notes: { "0": "first" } });
    expect(picks[2].notes!["0"]).toHaveLength(1_000);
    expect(picks[3]).toEqual({ options: [], skipped: true });
    expect(answerMessage(questions.slice(0, 2), picks.slice(0, 2))).toBe([
      "1. Which database?", "→ SQLite (Note: managed is fine)",
      "2. Which features? (several allowed)", "→ Login (Note: first); Export; Other: SSO",
    ].join("\n"));
    expect(answerSummary(questions.slice(0, 2), picks.slice(0, 2))).toBe("SQLite (Note: managed is fine) · Login (Note: first); Export; Other: SSO");
    expect(savedPicks(questions.slice(0, 1), JSON.parse(JSON.stringify(picks.slice(0, 1))))).toEqual(picks.slice(0, 1));
  });

  it("reads saved questions and picks back defensively", () => {
    expect(savedQuestions([{ question: 1, options: [{ label: "a" }, { label: "" }, { label: "b", recommended: true }] }, "junk"]))
      .toEqual([{ question: "", multiple: false, options: [{ label: "a", recommended: false }, { label: "b", recommended: true }] }]);
    expect(savedQuestions([{ options: [{ label: "a" }] }])).toBeNull();
    expect(savedPicks(questions, [{ options: [9] }])).toBeNull();
    expect(savedPicks(null, [])).toBeNull();
  });
});
