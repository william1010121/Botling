// What a card worker's `<show>` JSON is checked against before the card is drawn (worker-cards.ts `cardContent`, rules.validate). Only for the two
// built-in components that have a schema the app can read here: inline-chart (its kinds and fields, the same checks as its template's drawer) and
// inline-report-block (its `type`, and the rules of a progress bar). Any other component (the library's, Maintainer's own) has none and is never
// rejected here. A message is one line, in English, and names the field, so the worker can fix it from the text alone.
//
// Kept in step with the drawers by hand: a test draws wrong data with the real templates (jsdom) and requires this check to say wrong too, and
// reads the `type` and `kind` lists out of the templates, so a kind added there without one here fails it.

const CHART_KINDS = ["bars", "waterfall", "dumbbell", "line"] as const;
/** inline-report-block's own `type` list (its template's TYPES); `flow` is the old name of `flowchart`. */
export const REPORT_BLOCK_TYPES = ["kpi", "table", "options", "proscons", "checklist", "progress", "timeline", "roadmap", "steps", "callout", "matrix", "flowchart", "sequence", "prose", "quote", "glossary", "sources", "image"] as const;
export const CHART_KIND_NAMES: readonly string[] = CHART_KINDS;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The JSON a component was given, the way its drawer reads it (a string of JSON; a one-element array and `{output}` / `{block}` wrappers for report blocks). */
function read(data: string, wrappers: "chart" | "block"): { value: Record<string, unknown> } | { error: string } | null {
  const text = data.trim();
  if (!text || text === "null") return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return { error: `not valid JSON (${(error as Error).message.slice(0, 120)})` }; }
  if (isObject(value) && typeof value.output === "string" && (wrappers === "chart" ? !value.kind : !value.type)) { try { value = JSON.parse(value.output); } catch { /* keep it */ } }
  if (wrappers === "block") {
    if (Array.isArray(value)) { if (value.length === 1) value = value[0]; else return { error: `an array of ${value.length} blocks; one <show> holds one block` }; }
    if (isObject(value) && !value.type && isObject(value.block)) value = value.block;
  }
  if (value == null) return null;
  if (!isObject(value)) return { error: `must be one JSON object, got ${Array.isArray(value) ? "an array" : typeof value}` };
  return { value };
}

/** A number ≥ 0, as inline-chart wants every value. */
function plainNumber(value: unknown, path: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number (got ${value === undefined ? "no such field" : JSON.stringify(value)})`;
  if (value < 0) return `${path} must not be negative (${value})`;
  return null;
}
const label = (value: unknown, path: string): string | null => (value == null || String(value) === "" ? `${path} is missing` : null);
const list = (value: unknown, path: string, min: number): string | null => (!Array.isArray(value) ? `${path} must be an array` : value.length < min ? `${path} needs at least ${min} entr${min === 1 ? "y" : "ies"}` : null);

function checkChart(chart: Record<string, unknown>): string | null {
  const kind = chart.kind;
  if (!kind) return `kind is missing (${CHART_KINDS.join(" / ")})`;
  if (typeof kind !== "string" || !CHART_KIND_NAMES.includes(kind)) return `kind ${JSON.stringify(kind)} is unknown (${CHART_KINDS.join(" / ")})`;
  if (chart.better != null && chart.better !== "higher" && chart.better !== "lower") return `better must be "higher" or "lower" (got ${JSON.stringify(chart.better)})`;
  const each = (items: unknown[], path: string, check: (item: Record<string, unknown>, at: string) => string | null): string | null => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isObject(item)) return `${path}[${i}] must be an object`;
      const bad = check(item, `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  };
  if (kind === "bars") {
    const bad = list(chart.items, "items", 1);
    if (bad) return bad;
    const items = chart.items as unknown[];
    const inner = each(items, "items", (item, at) => label(item.label, `${at}.label`) ?? plainNumber(item.value, `${at}.value`));
    if (inner) return inner;
    if (chart.base != null && !items.some((item) => String((item as Record<string, unknown>).label) === chart.base)) return `base ${JSON.stringify(chart.base)} is not the label of an item`;
    return null;
  }
  if (kind === "waterfall") {
    return list(chart.steps, "steps", 1) ?? each(chart.steps as unknown[], "steps", (step, at) => label(step.label, `${at}.label`) ?? plainNumber(step.value, `${at}.value`) ?? (step.start != null ? plainNumber(step.start, `${at}.start`) : null));
  }
  if (kind === "dumbbell") {
    return list(chart.rows, "rows", 1) ?? each(chart.rows as unknown[], "rows", (row, at) => label(row.label, `${at}.label`) ?? plainNumber(row.before, `${at}.before`) ?? plainNumber(row.after, `${at}.after`));
  }
  const shape = list(chart.x, "x", 1) ?? list(chart.series, "series", 1);
  if (shape) return shape;
  const xs = chart.x as unknown[], series = chart.series as unknown[];
  if (series.length > 3) return `series holds at most 3 lines (got ${series.length})`;
  const lines = each(series, "series", (one, at) => {
    const bad = list(one.values, `${at}.values`, 1);
    if (bad) return bad;
    const values = one.values as unknown[];
    if (values.length !== xs.length) return `${at}.values has ${values.length} values but x has ${xs.length}`;
    for (let i = 0; i < values.length; i++) { const wrong = plainNumber(values[i], `${at}.values[${i}]`); if (wrong) return wrong; }
    return null;
  });
  if (lines) return lines;
  if (chart.ref != null) { if (!isObject(chart.ref)) return "ref must be an object {value, label}"; return plainNumber(chart.ref.value, "ref.value"); }
  return null;
}

/**
 * The rules of a progress block (inline-report-block's usage, the report's own `progress` block): 1–8 items, each a label, a `value` ≥ 0 and an optional
 * `max` > 0; the value may not be more than the max (without `max` the value is a percent, so at most 100). A bar that is "more than full" is the
 * worker forcing the wrong component: it should pick another one or describe the chart it wants.
 */
function checkProgress(block: Record<string, unknown>): string | null {
  const bad = list(block.items, "items", 1);
  if (bad) return bad;
  const items = block.items as unknown[];
  if (items.length > 8) return `items holds at most 8 bars (got ${items.length})`;
  for (let i = 0; i < items.length; i++) {
    const item = items[i], at = `items[${i}]`;
    if (!isObject(item)) return `${at} must be an object {label, value, max?}`;
    const wrong = label(item.label, `${at}.label`) ?? plainNumber(item.value, `${at}.value`);
    if (wrong) return wrong;
    if (item.max != null && (typeof item.max !== "number" || !(item.max > 0))) return `${at}.max must be a number above 0 (got ${JSON.stringify(item.max)})`;
    const max = typeof item.max === "number" ? item.max : 100;
    if ((item.value as number) > max) return `${at}.value ${item.value} is more than ${typeof item.max === "number" ? `its max ${max}` : "100 (without max the value is a percent)"}: a progress bar shows a part of a whole, value must be ≤ max; use another component, or describe the chart you want in a <component> instead`;
  }
  return null;
}

/**
 * The error of one `<show>`'s JSON for the component `name`, or null when it is fine, the component has no schema here, or the check itself could not run. Never throws.
 */
export function validateCardShow(name: string, data: string): string | null {
  try {
    if (name === "inline-chart") {
      const got = read(data, "chart");
      if (!got) return null;
      return "error" in got ? got.error : checkChart(got.value);
    }
    if (name === "inline-report-block") {
      const got = read(data, "block");
      if (!got) return null;
      if ("error" in got) return got.error;
      const block = got.value;
      if (!block.type) return `type is missing (${REPORT_BLOCK_TYPES.join(", ")})`;
      const type = block.type === "flow" ? "flowchart" : block.type;
      if (typeof type !== "string" || !(REPORT_BLOCK_TYPES as readonly string[]).includes(type)) return `type ${JSON.stringify(block.type)} is unknown (${REPORT_BLOCK_TYPES.join(", ")})`;
      if (type === "progress") return checkProgress(block);
    }
  } catch { /* a check that cannot run says nothing: the component's own drawer still shows its error card */ }
  return null;
}
