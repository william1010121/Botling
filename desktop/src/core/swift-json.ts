/**
 * Swift `JSONEncoder` look-alikes, so files written by 1.x Swift and 2.x stay byte-compatible.
 * Both sort keys at every level, skip `undefined` members and escape "/" as "\/" unless told not to.
 */

/** Compact form: `.sortedKeys`, slashes escaped. */
export function swiftJSON(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).filter((key) => (item as Record<string, unknown>)[key] !== undefined).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sorted(value)).replaceAll("/", "\\/");
}

/**
 * Swift's `JSONEncoder` with `.prettyPrinted, .sortedKeys`: `"key" : value`, two-space indent, an empty
 * list or object as `[\n\n]`; slashes escaped unless `.withoutEscapingSlashes` (`escapeSlashes: false`).
 */
export function swiftPrettyJSON(value: unknown, { escapeSlashes = true } = {}, indent = ""): string {
  const inner = indent + "  ";
  const options = { escapeSlashes };
  if (Array.isArray(value)) {
    if (!value.length) return "[\n\n" + indent + "]";
    return "[\n" + value.map((item) => inner + swiftPrettyJSON(item, options, inner)).join(",\n") + "\n" + indent + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
    if (!keys.length) return "{\n\n" + indent + "}";
    return "{\n" + keys.map((key) => `${inner}${swiftPrettyJSON(key, options)} : ${swiftPrettyJSON((value as Record<string, unknown>)[key], options, inner)}`).join(",\n") + "\n" + indent + "}";
  }
  const text = JSON.stringify(value);
  return escapeSlashes ? text.replace(/\//g, "\\/") : text;
}
