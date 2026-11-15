// The Note's route overview (routeFacts in src/branch.js): what a route holds, counted line by line.
// It used to call an undefined MARKER, so any route with a non-empty line threw a ReferenceError and the
// 路線總覽 map would not open.
import { expect, it } from "vitest";
// @ts-expect-error branch.js is plain JavaScript without types
import { parseBranches, routeFacts, routeIsEmpty } from "../src/branch.js";
import { classifyLines } from "../../../src/core/note-cells";

const read = (text: string) => {
  const lines = text.split("\n");
  return { lines, meta: parseBranches(lines, classifyLines(lines)) };
};

it("routeFacts counts text, card lines and todos of a route, skips blanks, cell lines and marker lines, and does not throw", () => {
  const { lines, meta } = read([
    "<!-- branch: 學習率 -->",
    "<!-- route: lr=3e-4 -->",
    "some text",
    "",
    "<!-- cell -->",
    '<show kind="chart" src="a.json">',
    "- [ ] tune it",
    "<!-- branch: inner -->",
    "<!-- route: x -->",
    "inner text",
    "<!-- end branch -->",
    "<!-- route: lr=1e-3 -->",
    "",
    "<!-- end branch -->",
  ].join("\n"));
  const [first, second] = meta.forks[0]!.routes;
  // text + card + todo + inner text; the cell line, the blank and the three nested marker lines do not count.
  expect(routeFacts(lines, first)).toEqual({ cards: 1, todos: 1, content: 4 });
  expect(routeIsEmpty(lines, first)).toBe(false);
  expect(routeFacts(lines, second)).toEqual({ cards: 0, todos: 0, content: 0 });
  expect(routeIsEmpty(lines, second)).toBe(true);
});

it("routeFacts of a route whose only content is a nested fork's markers counts no content", () => {
  const { lines, meta } = read(["<!-- branch: a -->", "<!-- route: r -->", "<!-- branch: b -->", "<!-- route: s -->", "<!-- end branch -->", "<!-- end branch -->"].join("\n"));
  expect(routeFacts(lines, meta.forks[0]!.routes[0]!)).toEqual({ cards: 0, todos: 0, content: 0 });
});
