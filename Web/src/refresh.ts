import { isComposingEnter } from "./ime";
import type { PinRefresh } from "./types";

/**
 * How often a pin (or a spec's pin) refreshes by itself, as its menus say it and as the user
 * types it: the quick presets, and a custom "Every [n] sec / min" from 2 seconds to 24 hours.
 * Swift keeps the same bounds (`PinnedComponent.minimumSeconds` / `maximumSeconds`).
 */

export type IntervalUnit = "sec" | "min";

/** The shortest and longest custom interval, in seconds. */
export const intervalBounds = { minSeconds: 2, maxSeconds: 24 * 60 * 60 } as const;

/** A refresh interval as Swift stores it: `seconds`, or whole `minutes`. */
export type Interval = { seconds: number; minutes?: undefined } | { minutes: number; seconds?: undefined };

/** The quick presets the menu always offers. */
export const presetMinutes = 15;
export const presetSeconds = 5;

/** "When shown", "Every 15 min", "Every 30 sec", "Only on ↻". */
export function refreshWords(refresh: PinRefresh, minutes: number, seconds?: number | null): string {
  if (refresh === "interval") return seconds ? `Every ${seconds} sec` : `Every ${minutes} min`;
  return refresh === "shown" ? "When shown" : "Only on ↻";
}

/**
 * What the user typed as an interval: a whole number in `unit`, from 2 sec to 24 h. Minutes stay
 * minutes ("Every 2 min"), seconds stay seconds ("Every 90 sec").
 */
export function parseInterval(text: string, unit: IntervalUnit): { interval: Interval } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: "Type a whole number" };
  const count = Number(trimmed);
  const seconds = unit === "min" ? count * 60 : count;
  if (seconds < intervalBounds.minSeconds) return { error: `At least ${intervalBounds.minSeconds} sec` };
  if (seconds > intervalBounds.maxSeconds) return { error: "At most 24 h (1440 min)" };
  return { interval: unit === "min" ? { minutes: count } : { seconds: count } };
}

/** Whether a pin's interval is one of the presets (else the menu shows it as its own entry). */
export function isPreset(minutes: number, seconds?: number | null): boolean {
  return seconds ? seconds === presetSeconds : minutes === presetMinutes;
}

/**
 * The custom entry's row in a menu: "Every [n] [sec|min] Set", and a line saying what is wrong
 * when the number is not an interval. Return sets it (never an input method's Return).
 */
export function intervalEditor(start: { count: number; unit: IntervalUnit }, set: (interval: Interval) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "refresh-custom";
  const line = document.createElement("div");
  line.className = "refresh-custom-line";
  const count = document.createElement("input");
  count.type = "text";
  count.inputMode = "numeric";
  count.className = "refresh-custom-count";
  count.value = String(start.count);
  count.setAttribute("aria-label", "Interval");
  const unit = document.createElement("select");
  unit.className = "refresh-custom-unit";
  unit.setAttribute("aria-label", "Unit");
  unit.innerHTML = `<option value="sec">sec</option><option value="min">min</option>`;
  unit.value = start.unit;
  const apply = document.createElement("button");
  apply.className = "refresh-custom-set";
  apply.textContent = "Set";
  const error = document.createElement("div");
  error.className = "refresh-custom-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const check = () => {
    const parsed = parseInterval(count.value, unit.value as IntervalUnit);
    const wrong = "error" in parsed ? parsed.error : "";
    error.textContent = wrong;
    error.hidden = !wrong;
    count.setAttribute("aria-invalid", String(!!wrong));
    return parsed;
  };
  const submit = () => {
    const parsed = check();
    if ("interval" in parsed) set(parsed.interval);
    else count.focus();
  };
  count.addEventListener("input", () => { if (!error.hidden) check(); });
  unit.addEventListener("change", () => { if (!error.hidden) check(); });
  for (const field of [count, unit] as HTMLElement[]) {
    field.addEventListener("keydown", (event: KeyboardEvent) => {
      // Arrow keys move the caret or pick a unit here, not the menu's focus.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") event.stopPropagation();
      if (event.key === "Enter" && !isComposingEnter(event)) {
        event.preventDefault();
        submit();
      }
    });
  }
  apply.addEventListener("click", (event) => {
    event.stopPropagation();
    submit();
  });
  line.append(document.createTextNode("Every "), count, unit, apply);
  row.append(line, error);
  return row;
}
