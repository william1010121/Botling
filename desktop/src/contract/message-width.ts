/** Botling 2's message column, including its horizontal padding (CSS pixels). */
export const MESSAGE_WIDTH_DEFAULT = 640;
export const MESSAGE_WIDTH_MIN = 360;
export const MESSAGE_WIDTH_MAX = 1200;

/** Tolerant settings.json read; malformed values use the default. */
export function messageWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MESSAGE_WIDTH_MAX, Math.max(MESSAGE_WIDTH_MIN, Math.round(value))) : null;
}
