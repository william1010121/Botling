// What a card worker's `<show>` JSON is checked against before the card is drawn (worker-cards.ts `cardContent`, rules.validate). Only for the two
// built-in components that have a schema the app can read here: inline-chart (its kinds and fields, the same checks as its template's drawer) and
// inline-report-block (its `type`, and the rules of a progress bar). Any other component (the library's, Maintainer's own) has none and is never
// rejected here. A message is one line, in English, and names the field, so the worker can fix it from the text alone.
//
// Kept in step with the drawers by hand: a test draws wrong data with the repo's templates (jsdom) and requires this check to say wrong too. The lists of kinds and
// types are the live template's own (`liveList`), so a kind Maintainer adds to a component is never rejected here; only the fields of the kinds below are checked.

// The kinds this check knows the fields of. The live template (the library's own copy, which Maintainer extends: `targets` came that way) decides which kinds exist: its
// `KINDS` list is read from it (`liveList`), a kind it lists that is not known here is never rejected, and a missing template falls back to these.
const CHART_KINDS = ["bars", "waterfall", "dumbbell", "line", "targets", "stacked"] as const;
/** inline-report-block's own `type` list (its template's TYPES); `flow` is the old name of `flowchart`. */
export const REPORT_BLOCK_TYPES = ["kpi", "table", "options", "proscons", "checklist", "progress", "timeline", "roadmap", "steps", "callout", "matrix", "flowchart", "sequence", "prose", "quote", "glossary", "sources", "image"] as const;
export const CHART_KIND_NAMES: readonly string[] = CHART_KINDS;

/** The list a template names in `<marker> = [...]` (its `KINDS`, its `TYPES`), or null when it has none that can be read. */
export function liveList(template: string | null | undefined, marker: "KINDS" | "TYPES"): string[] | null {
  const found = new RegExp(`\\b${marker} = \\[([^\\]]+)\\]`).exec(template ?? "");
  if (!found) return null;
  const names = found[1]!.split(",").map((entry) => entry.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return names.length ? names : null;
}

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

/** `items` works as the main array of every kind, an alias for the kind's own field (the live template's `field()`): the own field wins; for a line only when every element is a series. */
function arrayField(chart: Record<string, unknown>, own: string, fits?: (item: unknown) => boolean): [unknown, string] {
  if (chart[own] != null || own === "items" || !Array.isArray(chart.items) || (fits && !chart.items.every(fits))) return [chart[own], own];
  return [chart.items, "items"];
}

function checkChart(chart: Record<string, unknown>, kinds: readonly string[]): string | null {
  const kind = chart.kind;
  if (!kind) return `kind is missing (${kinds.join(" / ")})`;
  if (typeof kind !== "string" || !kinds.includes(kind)) return `kind ${JSON.stringify(kind)} is unknown (${kinds.join(" / ")})`;
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
    const [steps, at] = arrayField(chart, "steps");
    return list(steps, at, 1) ?? each(steps as unknown[], at, (step, path) => label(step.label, `${path}.label`) ?? plainNumber(step.value, `${path}.value`) ?? (step.start != null ? plainNumber(step.start, `${path}.start`) : null));
  }
  if (kind === "dumbbell") {
    const [rows, at] = arrayField(chart, "rows");
    return list(rows, at, 1) ?? each(rows as unknown[], at, (row, path) => label(row.label, `${path}.label`) ?? plainNumber(row.before, `${path}.before`) ?? plainNumber(row.after, `${path}.after`));
  }
  if (kind === "line") {
    const shape = list(chart.x, "x", 1);
    if (shape) return shape;
    const xs = chart.x as unknown[];
    const [lines, at] = arrayField(chart, "series", (one) => isObject(one) && Array.isArray(one.values));
    const found = list(lines, at, 1);
    if (found) return found;
    const series = lines as unknown[];
    if (series.length > 3) return `${at} holds at most 3 lines (got ${series.length})`;
    const bad = each(series, at, (one, path) => {
      const empty = list(one.values, `${path}.values`, 1);
      if (empty) return empty;
      const values = one.values as unknown[];
      if (values.length !== xs.length) return `${path}.values has ${values.length} values but x has ${xs.length}`;
      for (let i = 0; i < values.length; i++) { const wrong = plainNumber(values[i], `${path}.values[${i}]`); if (wrong) return wrong; }
      return null;
    });
    if (bad) return bad;
    if (chart.ref != null) { if (!isObject(chart.ref)) return "ref must be an object {value, label}"; return plainNumber(chart.ref.value, "ref.value"); }
    return null;
  }
  if (kind === "targets") return checkTargets(chart, each);
  // A kind the live template lists and this check does not know the fields of (Maintainer added it): nothing to say.
  return null;
}

/** targets: rows `{label, median, p90}` (p90 ≥ median) against one `target`; `log` only true / false, and a log scale asked for with `log: true` cannot draw a 0. */
function checkTargets(chart: Record<string, unknown>, each: (items: unknown[], path: string, check: (item: Record<string, unknown>, at: string) => string | null) => string | null): string | null {
  const at = chart.items != null || chart.rows == null ? "items" : "rows";
  const rows = chart[at];
  const bad = list(rows, at, 1);
  if (bad) return bad;
  const wrongTarget = plainNumber(chart.target, "target");
  if (wrongTarget) return wrongTarget;
  if (chart.log != null && typeof chart.log !== "boolean") return `log must be true or false (got ${JSON.stringify(chart.log)})`;
  const inner = each(rows as unknown[], at, (row, path) => {
    const wrong = label(row.label, `${path}.label`) ?? plainNumber(row.median, `${path}.median`) ?? plainNumber(row.p90, `${path}.p90`);
    if (wrong) return wrong;
    return (row.p90 as number) < (row.median as number) ? `${path}.p90 (${row.p90}) must not be below median (${row.median})` : null;
  });
  if (inner) return inner;
  const shown = (rows as Array<Record<string, number>>).slice(0, 12);
  // Chosen by `log: true` only: the drawer also switches to log by itself when every value is above 0 and they span more than 20×, and then there is no 0 left to fail on.
  const log = chart.log === true;
  if (log) {
    if (!((chart.target as number) > 0)) return `a log scale cannot draw a target of 0: make target above 0, or give "log": false`;
    const zero = shown.findIndex((row) => !(row.median! > 0));
    if (zero >= 0) return `${at}[${zero}].median is 0, and a log scale cannot draw 0: make it above 0, or give "log": false`;
  }
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
 * The error for a `<show name>` that is no component of the library (haiku wrote `name="progress"`: nothing draws it, and the card was accepted as done with no
 * error), or null when `name` is `known`. It names the components there are, and, when the name is one of inline-report-block's types or inline-chart's kinds,
 * the component and field that mean it. `names` is the list shown to the worker (the library's, without the pin-only ones).
 */
export function unknownComponentError(name: string, known: readonly string[], names: readonly string[]): string | null {
  if (known.includes(name)) return null;
  const lower = name.trim().toLowerCase();
  const hint = REPORT_BLOCK_TYPES.some((type) => type === lower) && known.includes("inline-report-block") ? `for a ${lower} block use inline-report-block with type "${lower}". `
    : CHART_KIND_NAMES.includes(lower) && known.includes("inline-chart") ? `for a ${lower} chart use inline-chart with "kind": "${lower}". ` : "";
  const shown = names.slice(0, 40).join(", ") + (names.length > 40 ? `, … (${names.length - 40} more)` : "");
  return `is not in the library: ${hint}Use name="…" of one of these components: ${shown}`;
}

/**
 * The error of one `<show>`'s JSON for the component `name`, or null when it is fine, the component has no schema here, or the check itself could not run. Never throws.
 * `template` is the component's live template.html (the library's copy, which Maintainer may have extended): its own list of kinds / types is the one that counts.
 */
export function validateCardShow(name: string, data: string, template?: string | null): string | null {
  try {
    if (name === "inline-chart") {
      const got = read(data, "chart");
      if (!got) return null;
      return "error" in got ? got.error : checkChart(got.value, liveList(template, "KINDS") ?? CHART_KINDS);
    }
    if (name === "inline-report-block") {
      const got = read(data, "block");
      if (!got) return null;
      if ("error" in got) return got.error;
      const block = got.value;
      const types: readonly string[] = liveList(template, "TYPES") ?? REPORT_BLOCK_TYPES;
      if (!block.type) return `type is missing (${types.join(", ")})`;
      const type = block.type === "flow" ? "flowchart" : block.type;
      if (typeof type !== "string" || !types.includes(type)) return `type ${JSON.stringify(block.type)} is unknown (${types.join(", ")})`;
      if (type === "progress") return checkProgress(block);
    }
  } catch { /* a check that cannot run says nothing: the component's own drawer still shows its error card */ }
  return null;
}
