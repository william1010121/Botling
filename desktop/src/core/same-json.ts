// Two JSON values the same, whatever order an object's keys came in and with fields left undefined as good as left out
// (Swift's `==` on the struct sees them this way: `editSpecs` saves a chat's specs only when they differ).
export function sameJSON(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
