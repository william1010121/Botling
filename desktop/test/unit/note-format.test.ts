// A bot's note as the Note tab and the bots both read it (core/note-format.ts): branches marked by
// HTML comments (`<!-- branch: … -->`, `<!-- route: … -->`, `<!-- end branch -->`) and live cards
// (`<show name="…">…</show>` lines, the chat's own syntax).
import { describe, expect, it } from "vitest";
import { noteBranches, noteCards, noteRoutes, noteView } from "../../src/core/note-format";

// The design's own example (BranchMap: "note.md 原文").
const SWEEP = [
  "# ViT-S 預訓練：學習率掃描", // 0
  "比較三種學習率設定。", // 1
  "", // 2
  "<!-- branch: 學習率 -->", // 3
  "<!-- route: lr=3e-4 cosine -->", // 4
  "cfg：lr=3e-4、cosine、warmup 5k。", // 5
  '<show name="train-curve-live"></show>', // 6
  "<!-- branch: 後續 -->", // 7
  "<!-- route: 延長到 200k -->", // 8
  "exp-047 跑到 175k。", // 9
  "<!-- route: batch 1024 -->", // 10
  "<!-- end branch -->", // 11
  "<!-- route: lr=1e-3 warmup -->", // 12
  "40k step 出現 loss spike。", // 13
  "<!-- route: +label smoothing -->", // 14
  "- [ ] 補一個 mixup 0.2 的比較", // 15
  "<!-- end branch -->", // 16
  "", // 17
  "## 結論", // 18
].join("\n");

describe("note branches", () => {
  it("reads forks, their routes and a nested fork, with each one's lines", () => {
    const { forks, problems } = noteBranches(SWEEP);
    expect(problems).toEqual([]);
    expect(forks).toEqual([{
      key: "學習率", name: "學習率", line: 3, end: 16,
      routes: [
        {
          key: "學習率/lr=3e-4 cosine", name: "lr=3e-4 cosine", line: 4, end: 12,
          forks: [{
            key: "學習率/lr=3e-4 cosine/後續", name: "後續", line: 7, end: 11,
            routes: [
              { key: "學習率/lr=3e-4 cosine/後續/延長到 200k", name: "延長到 200k", line: 8, end: 10, forks: [] },
              { key: "學習率/lr=3e-4 cosine/後續/batch 1024", name: "batch 1024", line: 10, end: 11, forks: [] },
            ],
          }],
        },
        { key: "學習率/lr=1e-3 warmup", name: "lr=1e-3 warmup", line: 12, end: 14, forks: [] },
        { key: "學習率/+label smoothing", name: "+label smoothing", line: 14, end: 16, forks: [] },
      ],
    }]);
  });

  it("lists every way through the note, first routes first", () => {
    expect(noteRoutes(SWEEP)).toEqual([
      { "學習率": "lr=3e-4 cosine", "學習率/lr=3e-4 cosine/後續": "延長到 200k" },
      { "學習率": "lr=3e-4 cosine", "學習率/lr=3e-4 cosine/後續": "batch 1024" },
      { "學習率": "lr=1e-3 warmup" },
      { "學習率": "+label smoothing" },
    ]);
  });

  it("shows the note as one route reads it: shared lines and that route's, no markers; first routes by default", () => {
    expect(noteView(SWEEP, {}).text).toBe([
      "# ViT-S 預訓練：學習率掃描", "比較三種學習率設定。", "",
      "cfg：lr=3e-4、cosine、warmup 5k。", '<show name="train-curve-live"></show>', "exp-047 跑到 175k。",
      "", "## 結論",
    ].join("\n"));
    const view = noteView(SWEEP, { "學習率": "+label smoothing" });
    expect(view.text).toBe(["# ViT-S 預訓練：學習率掃描", "比較三種學習率設定。", "", "- [ ] 補一個 mixup 0.2 的比較", "", "## 結論"].join("\n"));
    expect(view.lines).toEqual([0, 1, 2, 15, 17, 18]);
    // A pick for a route that is not there falls back to the first one.
    expect(noteView(SWEEP, { "學習率": "nope", "學習率/lr=3e-4 cosine/後續": "batch 1024" }).lines).toEqual([0, 1, 2, 5, 6, 17, 18]);
  });

  it("with no end branch a fork runs to the end of the file (or of the route around it)", () => {
    const text = ["top", "<!-- branch: A -->", "<!-- route: one -->", "1", "<!-- route: two -->", "2", "still two"].join("\n");
    const { forks, problems } = noteBranches(text);
    expect(problems).toEqual([]);
    expect(forks).toEqual([{ key: "A", name: "A", line: 1, end: null, routes: [
      { key: "A/one", name: "one", line: 2, end: 4, forks: [] },
      { key: "A/two", name: "two", line: 4, end: 7, forks: [] },
    ] }]);
    expect(noteView(text, { A: "two" }).text).toBe("top\n2\nstill two");
  });

  it("takes spacing and case loosely, never markers inside code, and lines before a fork's first route are shared", () => {
    const text = [
      "  <!--Branch:  Plan  -->",
      "intro for every route",
      "<!--   ROUTE: a-->",
      "a text",
      "```",
      "<!-- route: not a marker -->",
      "```",
      "<!-- END   branch -->",
      "`<!-- branch: inline code -->`",
    ].join("\n");
    const { forks, problems } = noteBranches(text);
    expect(problems).toEqual([]);
    expect(forks).toEqual([{ key: "Plan", name: "Plan", line: 0, end: 7, routes: [{ key: "Plan/a", name: "a", line: 2, end: 7, forks: [] }] }]);
    expect(noteView(text, {}).lines).toEqual([1, 3, 4, 5, 6, 8]);
  });

  it("says what it could not place, and keeps such lines as text", () => {
    const text = ["<!-- route: lost -->", "<!-- end branch -->", "<!-- branch: A -->", "<!-- branch: B -->", "<!-- route: x -->", "<!-- branch:  -->"].join("\n");
    const { forks, problems } = noteBranches(text);
    expect(problems).toEqual([
      { line: 0, message: "A route outside any branch." },
      { line: 1, message: "An end branch with no branch open." },
      { line: 3, message: "A branch inside a branch that has no route yet." },
      { line: 5, message: "A branch or route needs a name." },
    ]);
    expect(forks).toEqual([{ key: "A", name: "A", line: 2, end: null, routes: [{ key: "A/x", name: "x", line: 4, end: 6, forks: [] }] }]);
    expect(noteView(text, {}).lines).toEqual([0, 1, 3, 5]);
  });

  it("two forks or routes of one name get keys of their own", () => {
    const text = ["<!-- branch: A -->", "<!-- route: r -->", "<!-- route: r -->", "<!-- end branch -->", "<!-- branch: A -->", "<!-- route: r -->"].join("\n");
    const { forks } = noteBranches(text);
    expect(forks.map((fork) => [fork.key, fork.routes.map((route) => route.key)])).toEqual([["A", ["A/r", "A/r#2"]], ["A#2", ["A#2/r"]]]);
  });
});

describe("note cards", () => {
  it("reads <show> lines as the chat does: name, command, refresh, other attributes, JSON data; each with a key and the route it is in", () => {
    const text = [
      "# GPU",
      '<show name="gpu-status" refresh="10m" width="full"></show>',
      "<!-- branch: A -->",
      "<!-- route: one -->",
      '<show name="commit-log" command="git log --oneline -5"></show>',
      '<show name="chart" id="c1">{"points": [1, 2]}</show>',
      "<!-- route: two -->",
      '<show name="gpu-status"/>',
      "<!-- end branch -->",
      "`<show name=\"in-code\"></show>`",
      '<show name="broken">{not json</show>',
      "<show name='multi'>",
      '{"a": 1}',
      "</show>",
    ].join("\n");
    const { cards, problems } = noteCards(text);
    expect(problems).toEqual([{ line: 10, message: 'The data of <show name="broken"> is not JSON.' }]);
    expect(cards).toEqual([
      { key: expect.stringMatching(/^note\/[0-9a-f]{16}-1$/), line: 1, endLine: 1, name: "gpu-status", command: null, refresh: 600, data: "null", attributes: { name: "gpu-status", refresh: "10m", width: "full" }, source: '<show name="gpu-status" refresh="10m" width="full"></show>', route: null },
      { key: expect.stringMatching(/^note\/[0-9a-f]{16}-1$/), line: 4, endLine: 4, name: "commit-log", command: "git log --oneline -5", refresh: null, data: "null", attributes: { name: "commit-log", command: "git log --oneline -5" }, source: '<show name="commit-log" command="git log --oneline -5"></show>', route: "A/one" },
      { key: expect.stringMatching(/^note\/[0-9a-f]{16}-1$/), line: 5, endLine: 5, name: "chart", command: null, refresh: null, data: '{"points": [1, 2]}', attributes: { name: "chart", id: "c1" }, source: '<show name="chart" id="c1">{"points": [1, 2]}</show>', route: "A/one" },
      { key: expect.stringMatching(/^note\/[0-9a-f]{16}-2$/), line: 7, endLine: 7, name: "gpu-status", command: null, refresh: null, data: "null", attributes: { name: "gpu-status" }, source: '<show name="gpu-status"/>', route: "A/two" },
      { key: expect.stringMatching(/^note\/[0-9a-f]{16}-1$/), line: 11, endLine: 13, name: "multi", command: null, refresh: null, data: '{"a": 1}', attributes: { name: "multi" }, source: "<show name='multi'>\n{\"a\": 1}\n</show>", route: null },
    ]);
    // The same card keeps its key when the note changes around it; the second of a kind is told apart.
    expect(cards[3]!.key.slice(0, -2)).toBe(cards[0]!.key.slice(0, -2));
    expect(noteCards(`intro\n\n${text}`).cards.map((card) => card.key)).toEqual(cards.map((card) => card.key));
  });

  it("a command card's key follows its command, so another command is another card", () => {
    const one = noteCards('<show name="x" command="a"></show>').cards[0]!.key;
    const two = noteCards('<show name="x" command="b"></show>').cards[0]!.key;
    expect(one).not.toBe(two);
  });
});
