import { onScreen, post, windowVisible } from "./kit";

/**
 * The pins the user can see now, in page order: a chip above the input box, the opened pin, a
 * Board tile in view, a floating card (folded too: its header shows how it stands). The chat page
 * decides whether an element is in view (`onScreen`); this is the list told to Swift (`pinsVisible`),
 * whose timer runs a pin only then.
 */
export function visiblePinIDs(): string[] {
  if (!windowVisible()) return [];
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const element of document.querySelectorAll<HTMLElement>(".pin-chip[data-id], .board-card[data-id], .float-card[data-id]")) {
    if (onScreen(element)) add(element.dataset.id);
  }
  const sheet = document.querySelector<HTMLElement>(".pin-sheet:not([hidden])");
  if (sheet && onScreen(sheet)) add(document.querySelector<HTMLElement>(".pin-chip.on[data-id]")?.dataset.id);
  return ids;
}

let told: string[] = [];

/** Tells Swift which pins are seen, when that changed since it was last told. */
export function reportVisiblePins(): void {
  const ids = visiblePinIDs();
  if (ids.length === told.length && ids.every((id, index) => id === told[index])) return;
  told = ids;
  post({ type: "pinsVisible", ids });
}

let reportSoon: ReturnType<typeof setTimeout> | null = null;

/** `reportVisiblePins` once things settle (after a scroll, a resize, an update). */
export function reportVisiblePinsSoon(): void {
  reportSoon ??= setTimeout(() => {
    reportSoon = null;
    reportVisiblePins();
  }, 150);
}

/** Forgets what Swift was told (the plugin loads again, or a test starts over). */
export function resetVisiblePins(): void {
  told = [];
  if (reportSoon) clearTimeout(reportSoon);
  reportSoon = null;
}
