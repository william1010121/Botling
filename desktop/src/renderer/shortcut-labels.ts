import { dictionaries, type Lang } from "../../../Web/src/i18n";
import { en, type Key } from "../../../Web/src/locales/en";
import { bindingsFor, formatCombo, type Bindings, type ShortcutId } from "../contract/shortcuts";

/** The platform the shell page runs on, in Node's words (shortcuts show ⌘ on a Mac, Ctrl elsewhere). */
export const shellPlatform = (): string => (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "darwin" : /Win/i.test(navigator.platform ?? "") ? "win32" : "linux");

let current: Bindings = bindingsFor({});
/** The app tells the buttons' hints which keys are bound (set while it draws, from Settings). */
export function setShortcutLabels(overrides: unknown): Bindings { current = bindingsFor(overrides); return current; }
/** How `id`'s key is written now, for a button's title or a hint. */
export const shortcutLabel = (id: ShortcutId): string => formatCombo(current[id], shellPlatform());

/** A word of the Shortcuts page in `lang` (the chat page's dictionaries; English for anything missing). */
export function say(lang: Lang | null | undefined, key: Key, values: Record<string, string | number> = {}): string {
  const word = dictionaries[lang ?? "en"]?.[key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
