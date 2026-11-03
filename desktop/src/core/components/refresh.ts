// How a component refreshes when it is made live (a spec's `refresh` and `minutes`); the pins' own are botling.board's (its pin-data.ts).
export type PinRefresh = "shown" | "interval" | "manual";
export const DEFAULT_MINUTES = 15;
/** Minutes between runs, one to a day. */
export const clampMinutes = (minutes: number) => Math.min(Math.max(Math.round(minutes), 1), 24 * 60);
