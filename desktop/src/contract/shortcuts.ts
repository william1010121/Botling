// The app's keyboard shortcuts, one registry for main (menu accelerators), the shell page and the
// native chat page's relay. A binding is a string "Mod+Shift+K": modifiers in the fixed order
// Mod, Ctrl, Cmd, Alt, Shift, then one key. `Mod` is Cmd on macOS and Ctrl elsewhere; `Ctrl` and `Cmd`
// are those physical keys (Ctrl+Cmd+I is both held, as before). Settings keep only the bindings that
// differ from the default (`shortcutBindings` in settings.json); anything unusable falls back to it.

export type ShortcutId = "search" | "settings" | "toggleSidebar" | "toggleRightPanel" | "toggleTerminal" | "reload" | "forceReload" | "reloadChat";
export type ShortcutGroup = "navigation" | "panels" | "view";
export interface ShortcutDef { id: ShortcutId; group: ShortcutGroup; default: string }
/** Every key the app handles itself and lets you change. Order is the order on the Settings page. */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "search", group: "navigation", default: "Mod+K" },
  { id: "settings", group: "navigation", default: "Mod+," },
  { id: "toggleSidebar", group: "panels", default: "Ctrl+Cmd+S" },
  { id: "toggleRightPanel", group: "panels", default: "Ctrl+Cmd+I" },
  { id: "toggleTerminal", group: "panels", default: "Mod+J" },
  { id: "reload", group: "view", default: "Mod+R" },
  { id: "forceReload", group: "view", default: "Mod+Shift+R" },
  { id: "reloadChat", group: "view", default: "Mod+Alt+R" },
];
export const SHORTCUT_IDS = SHORTCUTS.map(s => s.id) as readonly ShortcutId[];

export interface FixedShortcut { id: string; group: "system" | "chat"; combo: string; platform?: "mac" | "other" }
/** Keys that belong to the system, Electron's menu roles or the chat box: listed on the page, not changeable, and not takeable. */
export const FIXED_SHORTCUTS: readonly FixedShortcut[] = [
  { id: "undo", group: "system", combo: "Mod+Z" }, { id: "redo", group: "system", combo: "Mod+Shift+Z" },
  { id: "cut", group: "system", combo: "Mod+X" }, { id: "copy", group: "system", combo: "Mod+C" },
  { id: "paste", group: "system", combo: "Mod+V" }, { id: "selectAll", group: "system", combo: "Mod+A" },
  { id: "closeWindow", group: "system", combo: "Mod+W" }, { id: "minimize", group: "system", combo: "Mod+M" },
  { id: "hide", group: "system", combo: "Mod+H", platform: "mac" }, { id: "quit", group: "system", combo: "Mod+Q" },
  { id: "devTools", group: "system", combo: "Mod+Alt+I" },
  { id: "zoomReset", group: "system", combo: "Mod+0" }, { id: "zoomIn", group: "system", combo: "Mod+=" }, { id: "zoomOut", group: "system", combo: "Mod+-" },
  { id: "fullscreen", group: "system", combo: "Ctrl+Cmd+F", platform: "mac" },
  { id: "send", group: "chat", combo: "Enter" }, { id: "newline", group: "chat", combo: "Shift+Enter" },
];

export type Overrides = Partial<Record<ShortcutId, string>>;
export type Bindings = Record<ShortcutId, string>;
export type Conflict = { kind: "shortcut"; id: ShortcutId } | { kind: "fixed"; id: string };
export type Platform = NodeJS.Platform | string;

const MODS = ["Mod", "Ctrl", "Cmd", "Alt", "Shift"] as const;
type Mod = (typeof MODS)[number];
const NAMED = new Set(["Enter", "Space", "Tab", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown"]);
const isFunctionKey = (key: string) => /^F([1-9]|1\d|2[0-4])$/.test(key);

export interface Combo { mods: Mod[]; key: string }

/** A binding as modifiers and key, or null when it is not a usable one (unknown part, no modifier, only Shift). */
export function parseCombo(text: unknown): Combo | null {
  if (typeof text !== "string" || !text || text.length > 40) return null;
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  if (!key || (key.length > 1 && !NAMED.has(key) && !isFunctionKey(key))) return null;
  if (key.length === 1 && !/^[A-Z0-9,.\/;'\[\]\\`=\-]$/.test(key)) return null;
  const mods: Mod[] = [];
  for (const part of parts) {
    if (!(MODS as readonly string[]).includes(part) || mods.includes(part as Mod)) return null;
    mods.push(part as Mod);
  }
  if (mods.includes("Mod") && (mods.includes("Ctrl") || mods.includes("Cmd"))) return null;
  if (!isFunctionKey(key) && !mods.some(m => m !== "Shift")) return null;
  return { mods: MODS.filter(m => mods.includes(m)), key };
}
/** The one spelling of a binding (modifier order fixed), or null. */
export function canonical(text: unknown): string | null {
  const combo = parseCombo(text);
  return combo ? [...combo.mods, combo.key].join("+") : null;
}

const defaults = (): Bindings => Object.fromEntries(SHORTCUTS.map(s => [s.id, s.default])) as Bindings;
export const DEFAULT_BINDINGS: Readonly<Bindings> = defaults();

/** The key of each shortcut in effect: the saved one, else the default. */
export function bindingsFor(overrides: unknown): Bindings {
  const out = defaults();
  const saved = overrides && typeof overrides === "object" ? overrides as Record<string, unknown> : {};
  for (const id of SHORTCUT_IDS) { const combo = canonical(saved[id]); if (combo) out[id] = combo; }
  return out;
}

const fixedConflict = (combo: string): Conflict | null => {
  const found = FIXED_SHORTCUTS.find(f => f.combo === combo);
  return found ? { kind: "fixed", id: found.id } : null;
};
/** What `combo` would collide with if `id` took it: another shortcut (as bound now) or a fixed system key. */
export function findConflict(id: ShortcutId, combo: string, overrides: unknown): Conflict | null {
  const wanted = canonical(combo);
  if (!wanted) return null;
  const now = bindingsFor(overrides);
  const other = SHORTCUT_IDS.find(candidate => candidate !== id && now[candidate] === wanted);
  return other ? { kind: "shortcut", id: other } : fixedConflict(wanted);
}

/** Saved overrides cleaned: unknown ids, unusable keys, keys equal to the default and keys that collide are dropped. */
export function normalizeOverrides(raw: unknown): Overrides {
  const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Overrides = {};
  for (const def of SHORTCUTS) {
    const combo = canonical(saved[def.id]);
    if (combo && combo !== def.default && !fixedConflict(combo)) out[def.id] = combo;
  }
  // A key two shortcuts share goes to the earlier one; the later falls back to its default (repeat: that may free or take another).
  for (let again = true; again;) {
    again = false;
    const now = bindingsFor(out);
    for (const id of SHORTCUT_IDS) {
      if (out[id] && SHORTCUT_IDS.some(other => other !== id && now[other] === now[id] && (SHORTCUT_IDS.indexOf(other) < SHORTCUT_IDS.indexOf(id) || !out[other]))) {
        delete out[id]; again = true; break;
      }
    }
  }
  return out;
}

/** `id` bound to `combo` (an override equal to the default is no override). The caller checks conflicts first. */
export function setBinding(overrides: Overrides, id: ShortcutId, combo: string): Overrides {
  const next = { ...overrides };
  const wanted = canonical(combo);
  if (!wanted || wanted === DEFAULT_BINDINGS[id]) delete next[id]; else next[id] = wanted;
  return next;
}
export function resetBinding(overrides: Overrides, id: ShortcutId): Overrides {
  const next = { ...overrides }; delete next[id]; return next;
}

/** Electron's spelling for the application menu. */
export function toAccelerator(text: string): string {
  const combo = parseCombo(text);
  if (!combo) throw new Error(`Not a shortcut: ${text}`);
  const has = (mod: Mod) => combo.mods.includes(mod);
  const key = combo.key;
  return [...(has("Shift") ? ["Shift"] : []), ...(has("Alt") ? ["Alt"] : []), ...(has("Ctrl") ? ["Ctrl"] : []), ...(has("Cmd") ? ["Cmd"] : []), ...(has("Mod") ? ["CmdOrCtrl"] : []), key].join("+");
}

/** What the key looks like on this platform: ⌃⌥⇧⌘K on a Mac, Ctrl+Shift+K elsewhere. */
export function formatCombo(text: string, platform: Platform): string {
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  const mac = platform === "darwin";
  const mods = parts.filter(p => (MODS as readonly string[]).includes(p));
  const glyph: Record<string, string> = { Mod: mac ? "⌘" : "Ctrl", Ctrl: mac ? "⌃" : "Ctrl", Cmd: mac ? "⌘" : "Win", Alt: mac ? "⌥" : "Alt", Shift: mac ? "⇧" : "Shift" };
  const shown: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: mac ? "↩" : "Enter", Backspace: mac ? "⌫" : "Backspace", Delete: mac ? "⌦" : "Delete", Tab: mac ? "⇥" : "Tab" };
  const text2 = shown[key] ?? key;
  if (!mac) return [...mods.map(m => glyph[m]), text2].join("+");
  const order = ["Ctrl", "Alt", "Shift", "Mod", "Cmd"];
  return [...mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(m => glyph[m]), text2].join("");
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
const NAMES: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
/** Keys an event can be, by what is printed on it and (for letters and digits) where it sits. */
function eventKeys(event: KeyLike): string[] {
  const keys: string[] = [];
  const code = /^Key([A-Z])$/.exec(event.code ?? "")?.[1] ?? /^Digit(\d)$/.exec(event.code ?? "")?.[1];
  if (code) keys.push(code);
  const key = event.key ?? "";
  if (key.length === 1 && key !== " ") keys.push(key.toUpperCase());
  else if (NAMES[key]) keys.push(NAMES[key]);
  else if (isFunctionKey(key)) keys.push(key);
  return keys;
}

/** The binding a key press spells on this platform, or null when it is a modifier alone, Escape or has no modifier. */
export function comboFromEvent(event: KeyLike, platform: Platform): string | null {
  const keys = eventKeys(event);
  const key = keys[0];
  if (!key || key === "+") return null;
  const mac = platform === "darwin";
  const mods: Mod[] = [];
  if (event.metaKey && event.ctrlKey) mods.push("Ctrl", "Cmd");
  else if (mac ? event.metaKey : event.ctrlKey) mods.push("Mod");
  else if (event.ctrlKey) mods.push("Ctrl");
  else if (event.metaKey) mods.push("Cmd");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  return canonical([...MODS.filter(m => mods.includes(m)), key].join("+"));
}

/** Does this key press spell `text`? Modifiers must match exactly; Mod is either Cmd or Ctrl (not both). */
export function matchesEvent(text: string, event: KeyLike): boolean {
  const combo = parseCombo(text);
  if (!combo || !eventKeys(event).includes(combo.key)) return false;
  const has = (mod: Mod) => combo.mods.includes(mod);
  const control = has("Mod") ? event.metaKey !== event.ctrlKey : event.ctrlKey === has("Ctrl") && event.metaKey === has("Cmd");
  return control && event.altKey === has("Alt") && event.shiftKey === has("Shift");
}

/** The shortcut a key press is, among `bindings`. */
export function actionForEvent(event: KeyLike, bindings: Bindings): ShortcutId | null {
  return SHORTCUT_IDS.find(id => matchesEvent(bindings[id], event)) ?? null;
}
