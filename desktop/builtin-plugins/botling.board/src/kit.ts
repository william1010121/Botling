// What the plugin draws with: the chat page's own parts (`ccb.page`, Web/src/plugins.ts `PageKit`) behind names this plugin's
// modules import, so each reads as it did in the chat page. The page's kit is set once, when the plugin activates; the
// bundle holds none of the page's modules (one `components.ts` runs, the page's, so a card is the same thing wherever it shows).
import type { PageKit } from "../../../../Web/src/plugins";
import type { Key } from "../../../../Web/src/i18n";
import type { ChatState, PinSize } from "../../../../Web/src/types";
import { shared } from "../../../../Web/src/contract";
import { isOwn, own, type OwnKey } from "./words";

export { shared };
export type { PageKit };
export type { Key as CoreKey };

let current: PageKit | null = null;

/** The page's kit, from `activate` (or a test); null again when the plugin unloads. */
export function useKit(kit: PageKit | null): void {
  current = kit;
}

export function page(): PageKit {
  if (!current) throw new Error("botling.board: the chat page's kit is not set.");
  return current;
}

export function post(action: Parameters<PageKit["post"]>[0]): void {
  page().post(action);
}

export type WordKey = OwnKey | Key;

/** A word: this plugin's own, else the chat page's. */
export function t(key: WordKey, values: Record<string, string | number> = {}): string {
  return isOwn(key) ? own(key, values) : page().t(key as Key, values);
}

export function language(): ReturnType<PageKit["language"]> {
  return page().language();
}

/** `key` cut at its `{name}` marks (the chat page's words with fields in them). */
export function pieces(key: Key): (string | { mark: string })[] {
  return page().pieces(key);
}

export const isComposingEnter = (event: KeyboardEvent): boolean => page().isComposingEnter(event);

export const windowVisible = (): boolean => page().visible.windowVisible();
export const onScreen = (element: Element): boolean => page().visible.onScreen(element);
export const whenShownAgain = (fn: () => void): void => page().visible.whenShownAgain(fn);

/** The Board's refresh numbers (Swift's `PinnedComponent`: shared in contract.json). */
export const presetMinutes = shared.refresh.defaultMinutes;
export const presetSeconds = 5;
export const maxColumns = shared.board.maxColumns;
export const maxRows = shared.board.maxRows;

export type { ChatState };

/** Escapes text for HTML, as the chat page does (Web/src/util.ts: a pure function, copied). */
export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Every Board size, row by row: 1×1, 2×1, … 4×4 (the chat page's `pinSizes`). */
export const pinSizes: PinSize[] = Array.from({ length: maxRows }, (_, row) =>
  Array.from({ length: maxColumns }, (_, column) => `${column + 1}x${row + 1}` as PinSize)).flat();

// The page's functions, looked up when called (the kit is set by then).
const fromComponents = <K extends keyof PageKit["components"]>(name: K): PageKit["components"][K] =>
  ((...args: never[]) => (page().components[name] as unknown as (...args: never[]) => unknown)(...args)) as unknown as PageKit["components"][K];
export const commandCard = fromComponents("commandCard");
export const componentElement = fromComponents("componentElement");
export const componentSizes = fromComponents("componentSizes");
export const detailTarget = fromComponents("detailTarget");
export const hasFrame = fromComponents("hasFrame");
export const keepFrames = fromComponents("keepFrames");
export const markPinFrames = fromComponents("markPinFrames");
export const pinSize = fromComponents("pinSize");
export const reportComponent = fromComponents("reportComponent");
export const resizeFrame = fromComponents("resizeFrame");
export const sizeInfo = fromComponents("sizeInfo");

export const intervalRow = ((...args: Parameters<PageKit["refresh"]["intervalRow"]>) => page().refresh.intervalRow(...args)) as PageKit["refresh"]["intervalRow"];
export const parseInterval = ((...args: Parameters<PageKit["refresh"]["parseInterval"]>) => page().refresh.parseInterval(...args)) as PageKit["refresh"]["parseInterval"];
export const refreshWords = ((...args: Parameters<PageKit["refresh"]["refreshWords"]>) => page().refresh.refreshWords(...args)) as PageKit["refresh"]["refreshWords"];
