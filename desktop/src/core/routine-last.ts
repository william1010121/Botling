// When a routine last ran and how that went, for every kind (bot.json `routineLast`, by routine id as the view gives it; times
// are epoch ms). A prompt routine's run is "sent": its prompt was handed to the bot, which says nothing of how the bot's work went
// (the same words as a scheduled routine's `fired`). A watch keeps its own, richer last run (`routineWatches`, routine-watch.ts).
export interface LastRun {
  at: number;
  result: "sent" | "ok" | "failed";
}

const RESULTS = new Set(["sent", "ok", "failed"]);

/** bot.json's `routineLast`, as it is (bad entries left out). */
export function fromRoutineLast(value: unknown): Record<string, LastRun> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, LastRun> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<LastRun> | null;
    if (!e || typeof e !== "object" || typeof e.at !== "number" || !Number.isFinite(e.at) || typeof e.result !== "string" || !RESULTS.has(e.result)) continue;
    Object.defineProperty(out, id, { value: { at: e.at, result: e.result }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** A run time as ISO-8601 for a row, or null when it is not a date a Date can hold (a hand-edited bot.json or schedule file: `toISOString` would throw and take the whole routines view with it). */
export function lastTime(at: number): string | null {
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : null;
}
