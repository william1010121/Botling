// The check of a card worker's `<show>` JSON (card-validate.ts): the two built-in components that have a schema the app can read, held against their own
// templates (the real validator and drawer, in jsdom) so a kind or a type added there without one here fails this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error jsdom ships without .d.ts
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CHART_KIND_NAMES, REPORT_BLOCK_TYPES, liveList, unknownComponentError, validateCardShow } from "../../src/core/card-validate";
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
  it("every chart kind and report block type the repo's templates draw is known here (the live copy in the library may have more: targets), and the types are exactly the same", () => {
    const chartKinds = liveList(template("inline-chart"), "KINDS")!;
    for (const kind of chartKinds) expect(CHART_KIND_NAMES, kind).toContain(kind);
    expect(CHART_KIND_NAMES).toContain("targets");
    expect([...REPORT_BLOCK_TYPES]).toEqual(liveList(template("inline-report-block"), "TYPES"));
  });

  it("liveList reads the KINDS / TYPES list a template names, and nothing when there is none", () => {
    expect(liveList("var MAX = 12, KINDS = ['bars', \"gantt\" , 'targets'];", "KINDS")).toEqual(["bars", "gantt", "targets"]);
    expect(liveList("var TYPES = ['kpi', 'table'];", "TYPES")).toEqual(["kpi", "table"]);
    expect(liveList("var TYPES = ['kpi'];", "KINDS")).toBeNull();
    expect(liveList("var MYKINDS = ['a'];", "KINDS")).toBeNull();
    expect(liveList("KINDS = [];", "KINDS")).toBeNull();
    expect(liveList(null, "KINDS")).toBeNull();
    expect(liveList(undefined, "TYPES")).toBeNull();
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
    ["a waterfall with neither steps nor items", { kind: "waterfall", title: "x" }, /steps must be an array/],
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

describe("validateCardShow: the live inline-chart (the library's copy: `items` on every kind, targets, kinds Maintainer adds)", () => {
  const check = (data: unknown, template?: string) => validateCardShow("inline-chart", JSON.stringify(data), template);
  const ROWS = [{ label: "冷啟", median: 13.1, p90: 26.8 }, { label: "重啟", median: 14.7, p90: 30.6 }];
  const TARGETS = { kind: "targets", title: "兩項都超過 10 s 目標", unit: "s", target: 10, items: ROWS };

  it("`items` is the main array of every kind: a waterfall, a dumbbell and a line written with it pass, and the kind's own field wins when both are given", () => {
    expect(check({ kind: "waterfall", items: [{ label: "a", value: 1 }] })).toBeNull();
    expect(check({ kind: "dumbbell", items: [{ label: "a", before: 2, after: 1 }] })).toBeNull();
    expect(check({ kind: "line", x: ["a", "b"], items: [{ name: "p", values: [1, 2] }] })).toBeNull();
    expect(check({ kind: "waterfall", steps: [{ label: "a", value: 1 }], items: "junk" })).toBeNull();
    // Errors name the field the worker really used.
    expect(check({ kind: "waterfall", items: [{ label: "a", value: "x" }] })).toMatch(/^items\[0\]\.value must be a number/);
    expect(check({ kind: "dumbbell", items: [{ label: "a", before: 1 }] })).toMatch(/^items\[0\]\.after must be a number/);
    expect(check({ kind: "waterfall", steps: [{ label: "a", value: "x" }], items: [{ label: "a", value: 1 }] })).toMatch(/^steps\[0\]\.value must be a number/);
    // A line takes `items` only when every element has the series shape: {label, value} items do not fit, so the message is about `series`.
    expect(check({ kind: "line", x: ["a"], items: [{ label: "a", value: 1 }] })).toMatch(/series must be an array/);
    expect(check({ kind: "line", x: ["a", "b"], items: [{ name: "p", values: [1] }] })).toMatch(/items\[0\]\.values has 1 values but x has 2/);
    expect(check({ kind: "line", x: ["a"], items: [1, 2, 3, 4].map((n) => ({ name: String(n), values: [n] })) })).toMatch(/items holds at most 3 lines/);
  });

  it("targets: median and p90 per row against one target; the example of its usage passes, with `rows` as the alias", () => {
    expect(check(TARGETS)).toBeNull();
    expect(check({ ...TARGETS, items: undefined, rows: ROWS })).toBeNull();
    expect(check({ ...TARGETS, log: false })).toBeNull();
    expect(check({ ...TARGETS, target: 0.1, log: true })).toBeNull();
    // Two worlds at once are no mistake: a median of 0 with auto log off (a 0 stops the span test) draws.
    expect(check({ ...TARGETS, target: 10, items: [{ label: "a", median: 0, p90: 500 }] })).toBeNull();
  });

  it("targets: what its drawer rejects is rejected here with the field named", () => {
    expect(check({ ...TARGETS, target: undefined })).toMatch(/^target must be a number \(got no such field\)/);
    expect(check({ ...TARGETS, target: "10" })).toMatch(/^target must be a number/);
    expect(check({ ...TARGETS, target: -1 })).toMatch(/^target must not be negative/);
    expect(check({ ...TARGETS, log: "yes" })).toMatch(/^log must be true or false/);
    expect(check({ ...TARGETS, items: [] })).toMatch(/^items needs at least 1 entry/);
    expect(check({ ...TARGETS, items: undefined })).toMatch(/^items must be an array/);
    expect(check({ ...TARGETS, items: undefined, rows: [1] })).toMatch(/^rows\[0\] must be an object/);
    expect(check({ ...TARGETS, items: [{ median: 1, p90: 2 }] })).toMatch(/^items\[0\]\.label is missing/);
    expect(check({ ...TARGETS, items: [{ label: "a", median: "1", p90: 2 }] })).toMatch(/^items\[0\]\.median must be a number/);
    expect(check({ ...TARGETS, items: [{ label: "a", median: 1 }] })).toMatch(/^items\[0\]\.p90 must be a number/);
    expect(check({ ...TARGETS, items: [{ label: "a", median: 5, p90: 4 }] })).toMatch(/^items\[0\]\.p90 \(4\) must not be below median \(5\)/);
    // A log scale asked for cannot draw 0. (The drawer also goes log by itself when every value is above 0 and they span more than 20×: nothing left there to fail on.)
    expect(check({ ...TARGETS, log: true, items: [{ label: "a", median: 0, p90: 1 }] })).toMatch(/^items\[0\]\.median is 0, and a log scale cannot draw 0/);
    expect(check({ ...TARGETS, log: true, target: 0 })).toMatch(/^a log scale cannot draw a target of 0/);
    expect(check({ ...TARGETS, target: 1, items: [{ label: "a", median: 2, p90: 100 }] })).toBeNull();
    expect(check({ ...TARGETS, target: 1, items: [{ label: "a", median: 2, p90: 100 }, { label: "b", median: 0, p90: 3 }] })).toBeNull();
    // Only the 12 rows drawn are looked at for a 0 on a log scale, as the drawer does: a 13th is cut off before it.
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `r${i}`, median: 5, p90: 6 }));
    expect(check({ ...TARGETS, log: true, items: [...many, { label: "cut", median: 0, p90: 900 }] })).toBeNull();
    expect(check({ ...TARGETS, log: true, items: [{ label: "zero", median: 0, p90: 900 }, ...many] })).toMatch(/^items\[0\]\.median is 0/);
  });

  it("the kinds are the live template's own: one it lists is known (and a kind of fields this check does not know is never rejected); one it does not list is unknown; no template falls back to the built-in list", () => {
    const template = "var MAX = 12, KINDS = ['bars', 'heatmap'];";
    expect(check({ kind: "heatmap", cells: "anything" }, template)).toBeNull();
    expect(check({ kind: "targets", target: "x" }, template)).toMatch(/kind "targets" is unknown \(bars \/ heatmap\)/);
    expect(check({ kind: "pie" }, template)).toMatch(/kind "pie" is unknown \(bars \/ heatmap\)/);
    expect(check({ title: "x" }, template)).toMatch(/kind is missing \(bars \/ heatmap\)/);
    expect(check({ kind: "bars", items: [{ label: "a", value: "x" }] }, template)).toMatch(/items\[0\]\.value must be a number/);
    expect(check({ kind: "targets", target: "x", items: ROWS })).toMatch(/^target must be a number/);
    expect(check({ kind: "heatmap" })).toMatch(/kind "heatmap" is unknown \(bars \/ waterfall \/ dumbbell \/ line \/ targets\)/);
    expect(check({ kind: "heatmap" }, "no list in this one")).toMatch(/kind "heatmap" is unknown/);
  });

  it("the report block types are the live template's own too: a type it lists is known, any other is not", () => {
    const template = "var TYPES = ['kpi', 'gantt'];";
    expect(validateCardShow("inline-report-block", '{"type":"gantt","items":[]}', template)).toBeNull();
    expect(validateCardShow("inline-report-block", '{"type":"table"}', template)).toMatch(/type "table" is unknown \(kpi, gantt\)/);
    expect(validateCardShow("inline-report-block", '{"items":[]}', template)).toMatch(/type is missing \(kpi, gantt\)/);
    expect(validateCardShow("inline-report-block", '{"type":"gantt"}')).toMatch(/type "gantt" is unknown/);
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

describe("unknownComponentError: a name that is not in the library", () => {
  const names = (count: number) => Array.from({ length: count }, (_, at) => `name-${at}`);

  it("is null for a known name and says `not in the library` for any other", () => {
    expect(unknownComponentError("status", ["status"], ["status"])).toBeNull();
    expect(unknownComponentError("nope", ["status"], ["status"])).toContain("is not in the library");
  });

  it("hints at the component and field that mean the name, only when the library has that component (V5, V6)", () => {
    const both = ["inline-chart", "inline-report-block"];
    expect(unknownComponentError("progress", both, both)).toContain('for a progress block use inline-report-block with type "progress"');
    expect(unknownComponentError("bars", both, both)).toContain('for a bars chart use inline-chart with "kind": "bars"');
    // The component it would point to is not there: no hint to a component the worker cannot use.
    expect(unknownComponentError("progress", ["status"], ["status"])).not.toContain("inline-report-block");
    expect(unknownComponentError("progress", ["inline-chart"], ["inline-chart"])).not.toContain("with type");
    expect(unknownComponentError("bars", ["status"], ["status"])).not.toContain("inline-chart");
    expect(unknownComponentError("bars", ["inline-report-block"], ["inline-report-block"])).not.toContain("with");
  });

  it("lists at most 40 names and counts the rest (V7); exactly 40 is listed whole", () => {
    const long = unknownComponentError("nope", names(45), names(45))!;
    expect(long).toContain("name-39");
    expect(long).not.toContain("name-40");
    expect(long).toContain(", … (5 more)");
    const exact = unknownComponentError("nope", names(40), names(40))!;
    expect(exact).toContain("name-39");
    expect(exact).not.toContain("more)");
  });
});
