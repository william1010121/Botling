// The check of a card worker's `<show>` JSON (card-validate.ts): the two built-in components that have a schema the app can read, held against their own
// templates (the real validator and drawer, in jsdom) so a kind or a type added there without one here fails this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error jsdom ships without .d.ts
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CHART_KIND_NAMES, REPORT_BLOCK_TYPES, validateCardShow } from "../../src/core/card-validate";
import { INLINE_EXAMPLES } from "../../src/core/inline-blocks";

const cardsFolder = new URL("../../builtin-plugins/botling.cards/components", import.meta.url).pathname;
const template = (name: string) => readFileSync(join(cardsFolder, name, "template.html"), "utf8");

/** What a template draws for `data`: whether its error card shows (the real validator). */
function drawn(name: "inline-chart" | "inline-report-block", data: unknown): { error: boolean } {
  const dom = new JSDOM(`<!doctype html><html><body>${template(name)}</body></html>`, {
    runScripts: "dangerously",
    beforeParse(window: unknown) { (window as unknown as { ccb: unknown }).ccb = { data: typeof data === "string" ? data : JSON.stringify(data), setStatus() {}, onData() {}, onSize() {} }; },
  });
  const doc = dom.window.document;
  const error = name === "inline-chart" ? doc.querySelector(".err") !== null : doc.querySelector(".blk-error") !== null;
  dom.window.close();
  return { error };
}

const examples = INLINE_EXAMPLES.split("\n").map((line) => /: (\{.*\})$/.exec(line)![1]!);
const BARS = { kind: "bars", title: "t", items: [{ label: "a", value: 1 }, { label: "b", value: 2 }] };

describe("validateCardShow: the lists are the templates' own", () => {
  it("the chart kinds and the report block types are exactly the ones the templates draw", () => {
    const chartKinds = /KINDS = \[([^\]]+)\]/.exec(template("inline-chart"))![1]!.split(",").map((kind) => kind.trim().replace(/'/g, ""));
    expect([...CHART_KIND_NAMES]).toEqual(chartKinds);
    const types = /var TYPES = \[([^\]]+)\]/.exec(template("inline-report-block"))![1]!.split(",").map((type) => type.trim().replace(/'/g, ""));
    expect([...REPORT_BLOCK_TYPES]).toEqual(types);
  });

  it("every example the card worker is given passes, and the real drawer draws it without its error card", () => {
    for (const example of examples) {
      const json = JSON.parse(example) as { kind?: string };
      const name = json.kind ? "inline-chart" : "inline-report-block";
      expect(validateCardShow(name, example), example).toBeNull();
      expect(drawn(name, example).error, example).toBe(false);
    }
  });
});

describe("validateCardShow: inline-chart", () => {
  const wrong: Array<[string, unknown, RegExp]> = [
    ["a waterfall written with `items` (what a bot guessed)", { kind: "waterfall", title: "x", items: [{ label: "a", value: 1 }] }, /steps must be an array/],
    ["no kind", { title: "x", items: [] }, /kind is missing/],
    ["an unknown kind", { kind: "pie", items: [] }, /kind "pie" is unknown/],
    ["a wrong better", { ...BARS, better: "best" }, /better must be/],
    ["a bar with a string value", { kind: "bars", items: [{ label: "a", value: "1,200" }] }, /items\[0\]\.value must be a number/],
    ["a negative value", { kind: "bars", items: [{ label: "a", value: -1 }] }, /must not be negative/],
    ["a base that is no item", { ...BARS, base: "zzz" }, /base "zzz" is not the label/],
    ["a missing label", { kind: "bars", items: [{ value: 1 }] }, /items\[0\]\.label is missing/],
    ["a dumbbell row without after", { kind: "dumbbell", rows: [{ label: "a", before: 1 }] }, /rows\[0\]\.after must be a number/],
    ["a line whose values are shorter than x", { kind: "line", x: ["a", "b"], series: [{ name: "p", values: [1] }] }, /has 1 values but x has 2/],
    ["a line with four series", { kind: "line", x: ["a"], series: [1, 2, 3, 4].map((n) => ({ name: String(n), values: [n] })) }, /at most 3 lines/],
    ["a ref that is no object", { ...BARS, kind: "line", x: ["a"], series: [{ name: "p", values: [1] }], ref: 5 }, /ref must be an object/],
  ];
  for (const [what, data, message] of wrong) {
    it(`rejects ${what}, as the real drawer does`, () => {
      expect(validateCardShow("inline-chart", JSON.stringify(data))).toMatch(message);
      expect(drawn("inline-chart", data).error).toBe(true);
    });
  }

  it("rejects text that is no JSON, a JSON array and an empty-looking object; an empty string or null is no data (nothing to check)", () => {
    expect(validateCardShow("inline-chart", "{not json")).toMatch(/not valid JSON/);
    expect(validateCardShow("inline-chart", "[1,2]")).toMatch(/must be one JSON object, got an array/);
    expect(validateCardShow("inline-chart", "{}")).toMatch(/kind is missing/);
    expect(validateCardShow("inline-chart", "")).toBeNull();
    expect(validateCardShow("inline-chart", "null")).toBeNull();
  });
});

describe("validateCardShow: inline-report-block", () => {
  it("a progress value above its max is wrong (the first worker forced a progress bar with value > max): the error names the field and says what to do", () => {
    const message = validateCardShow("inline-report-block", JSON.stringify({ type: "progress", items: [{ label: "p50", value: 120, max: 100 }] }))!;
    expect(message).toContain("items[0].value 120 is more than its max 100");
    expect(message).toContain("value must be ≤ max");
    expect(message).toContain("<component>");
  });

  it("without max the value is a percent: above 100 is wrong, 100 is fine; value equal to max is fine", () => {
    expect(validateCardShow("inline-report-block", JSON.stringify({ type: "progress", items: [{ label: "a", value: 101 }] }))).toMatch(/more than 100 \(without max the value is a percent\)/);
    expect(validateCardShow("inline-report-block", JSON.stringify({ type: "progress", items: [{ label: "a", value: 100 }] }))).toBeNull();
    expect(validateCardShow("inline-report-block", JSON.stringify({ type: "progress", items: [{ label: "a", value: 52, max: 52 }] }))).toBeNull();
  });

  it("the other progress rules: 1–8 items, a label, a number ≥ 0, a max above 0", () => {
    const check = (items: unknown) => validateCardShow("inline-report-block", JSON.stringify({ type: "progress", items }));
    expect(check([])).toMatch(/needs at least 1 entry/);
    expect(check(Array.from({ length: 9 }, () => ({ label: "a", value: 1 })))).toMatch(/at most 8 bars/);
    expect(check([{ value: 1 }])).toMatch(/items\[0\]\.label is missing/);
    expect(check([{ label: "a", value: "5" }])).toMatch(/items\[0\]\.value must be a number/);
    expect(check([{ label: "a", value: -1 }])).toMatch(/must not be negative/);
    expect(check([{ label: "a", value: 1, max: 0 }])).toMatch(/items\[0\]\.max must be a number above 0/);
    expect(check("x")).toMatch(/items must be an array/);
    expect(check([5])).toMatch(/items\[0\] must be an object/);
  });

  it("a type that is missing or unknown is wrong, as the real drawer says; flow is flowchart's old name; a one-block array and a {block} wrapper are read as the drawer reads them", () => {
    expect(validateCardShow("inline-report-block", '{"items":[]}')).toMatch(/type is missing/);
    expect(validateCardShow("inline-report-block", '{"type":"bar","items":[]}')).toMatch(/type "bar" is unknown/);
    expect(drawn("inline-report-block", { type: "bar", items: [] }).error).toBe(true);
    expect(drawn("inline-report-block", { items: [] }).error).toBe(true);
    expect(validateCardShow("inline-report-block", '{"type":"flow"}')).toBeNull();
    expect(validateCardShow("inline-report-block", '[{"type":"progress","items":[{"label":"a","value":9,"max":3}]}]')).toMatch(/more than its max/);
    expect(validateCardShow("inline-report-block", '{"block":{"type":"progress","items":[{"label":"a","value":9,"max":3}]}}')).toMatch(/more than its max/);
    expect(validateCardShow("inline-report-block", "[{},{}]")).toMatch(/an array of 2 blocks/);
  });

  it("a component without a schema here is never rejected, whatever its data", () => {
    expect(validateCardShow("gpu-monitor", "{not json")).toBeNull();
    expect(validateCardShow("anything", '{"value":999,"max":1}')).toBeNull();
    expect(validateCardShow("constructor", "{}")).toBeNull();
    expect(validateCardShow("__proto__", "{}")).toBeNull();
  });
});
