import { isComposingEnter } from "./ime";
import { pieces, t } from "./i18n";
import type { PinRefresh } from "./types";

/**
 * How often a pin (or a spec's pin) refreshes by itself, as its menus say it and as the user
 * types it: "Every [n] [sec / min]" from 2 seconds to 24 hours, typed right in the menu.
 * Swift keeps the same bounds (`PinnedComponent.minimumSeconds` / `maximumSeconds`).
 */

export type IntervalUnit = "sec" | "min";

/** The shortest and longest interval, in seconds. */
export const intervalBounds = { minSeconds: 2, maxSeconds: 24 * 60 * 60 } as const;

/** A refresh interval as Swift stores it: `seconds`, or whole `minutes`. */
export type Interval = { seconds: number; minutes?: undefined } | { minutes: number; seconds?: undefined };

/** What the menu's minutes row and seconds row show while the pin refreshes in neither unit. */
export const presetMinutes = 15;
export const presetSeconds = 5;

/** "When shown", "Every 15 min", "Every 30 sec", "Only on ↻". */
export function refreshWords(refresh: PinRefresh, minutes: number, seconds?: number | null): string {
  if (refresh === "interval") return seconds ? t("refresh.everySeconds", { n: seconds }) : t("refresh.everyMinutes", { n: minutes });
  return refresh === "shown" ? t("refresh.whenShown") : t("refresh.onlyManual");
}

/**
 * What the user typed as an interval: a whole number in `unit`, from 2 sec to 24 h. Minutes stay
 * minutes ("Every 2 min"), seconds stay seconds ("Every 90 sec").
 */
export function parseInterval(text: string, unit: IntervalUnit): { interval: Interval } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: t("refresh.wholeNumber") };
  const count = Number(trimmed);
  const seconds = unit === "min" ? count * 60 : count;
  if (seconds < intervalBounds.minSeconds) return { error: t("refresh.atLeast", { n: intervalBounds.minSeconds }) };
  if (seconds > intervalBounds.maxSeconds) return { error: t("refresh.atMost") };
  return { interval: unit === "min" ? { minutes: count } : { seconds: count } };
}

/** One of a menu's two interval rows: the value it shows, and what to do when it is applied. */
export interface IntervalRow {
  start: { count: number; unit: IntervalUnit };
  /** `close`: picked or Return (the menu closes); else it was applied by leaving the field. */
  set: (interval: Interval, close: boolean) => void;
}

/** What a row says as a whole, for screen readers and tests: "Every 30 sec". */
function rowWords(count: string, unit: IntervalUnit): string {
  const n = count.trim() || "…";
  return unit === "min" ? t("refresh.everyMinutes", { n }) : t("refresh.everySeconds", { n });
}

/**
 * An interval row of a refresh menu: "Every [n] [sec|min]", the number and unit editable in place.
 * Clicking the row (not its fields) picks it as it stands; Return in a field (never an input
 * method's Return) picks it too; leaving the row after an edit applies it and the menu stays
 * open. Escape drops the edit; clicking another entry of the menu does too. A number that is not
 * an interval (2 sec to 24 h) is said under the row and nothing changes.
 */
export function intervalRow(row: IntervalRow, checked: boolean): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "refresh-interval" + (checked ? " checked" : "");
  const line = document.createElement("div");
  line.className = "refresh-interval-line";
  const pick = document.createElement("button");
  pick.className = "refresh-interval-pick";
  pick.setAttribute("role", "menuitemradio");
  pick.setAttribute("aria-checked", String(checked));
  const count = document.createElement("input");
  count.type = "text";
  count.inputMode = "numeric";
  count.className = "refresh-interval-count";
  count.value = String(row.start.count);
  count.setAttribute("aria-label", t("refresh.interval"));
  const unit = document.createElement("select");
  unit.className = "refresh-interval-unit";
  unit.setAttribute("aria-label", t("refresh.unit"));
  for (const [value, word] of [["sec", t("refresh.sec")], ["min", t("refresh.min")]]) unit.add(new Option(word, value));
  unit.value = row.start.unit;
  const error = document.createElement("div");
  error.className = "refresh-interval-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  let edited = false;
  const say = () => pick.setAttribute("aria-label", rowWords(count.value, unit.value as IntervalUnit));
  const check = () => {
    const parsed = parseInterval(count.value, unit.value as IntervalUnit);
    const wrong = "error" in parsed ? parsed.error : "";
    error.textContent = wrong;
    error.hidden = !wrong;
    count.setAttribute("aria-invalid", String(!!wrong));
    return parsed;
  };
  const apply = (close: boolean) => {
    const parsed = check();
    if (!("interval" in parsed)) {
      count.focus();
      count.select();
      return;
    }
    edited = false;
    row.set(parsed.interval, close);
  };
  const changed = () => {
    edited = true;
    say();
    if (!error.hidden) check();
  };
  count.addEventListener("input", changed);
  unit.addEventListener("change", changed);
  for (const field of [count, unit] as HTMLElement[]) {
    field.addEventListener("keydown", (event: KeyboardEvent) => {
      // Arrow keys move the caret or pick a unit here, not the menu's focus.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") event.stopPropagation();
      if (event.key === "Escape") edited = false;
      if (event.key === "Enter" && !isComposingEnter(event)) {
        event.preventDefault();
        apply(true);
      }
    });
  }
  holder.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === count || event.target === unit) return;
    apply(true);
  });
  holder.addEventListener("focusout", (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!edited || !holder.isConnected || (next && holder.contains(next))) return;
    // Another entry of the menu was chosen instead: the edit is dropped.
    if (next && holder.closest(".pin-menu")?.contains(next)) return;
    apply(false);
  });
  say();
  // "Every [n] [unit]" in the page's language; the first words are the button that picks the row.
  for (const piece of pieces("refresh.everyRow")) {
    if (typeof piece !== "string") line.append(piece.mark === "n" ? count : unit);
    else if (!piece.trim()) continue;
    else if (!pick.textContent) {
      pick.textContent = piece.trim();
      line.append(pick);
    } else {
      const words = document.createElement("span");
      words.className = "refresh-interval-words";
      words.textContent = piece.trim();
      line.append(words);
    }
  }
  if (!line.contains(pick)) line.prepend(pick);
  holder.append(line, error);
  return holder;
}
