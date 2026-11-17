// Component tokens: CSS variables a plugin pushes into every component frame (chat, Board, Pin, Note, the
// component editor's previews), live. The core ships no values; a plugin's manifest names them
// (`contributes.componentTokens`, desktop/src/core/plugins/registry.ts `componentTokens`) and the core hands the
// page the merged, cleaned set. Pure (no DOM here): the core and the pages share `cleanTokens`, so a name or value
// that is refused in the core is refused in the page too.
//
// A frame gets them as `<style id="ccb-tokens">:root{…}</style>` in its head (`componentPage`), before the
// component's own CSS. With none, the page is exactly what it was before this existed.

/** A token name: `--ccb-` and lower-case words, so a plugin can only set what components opt into. */
const NAME = /^--ccb-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** What may not be in a value: a declaration or rule boundary, a tag, quotes, an escape, a comment, an at-rule, a call that loads something, !important, a control character. */
const BAD_VALUE = /[;{}<>"'\\@!\u0000-\u001f\u007f]|\/\*|\*\/|url\s*\(|expression\s*\(|image-set\s*\(|\bimport\b/i;

export const TOKEN_NAME_MAX = 64;
export const TOKEN_VALUE_MAX = 100;
/** The most tokens one set may hold (and the merged set of every plugin). */
export const TOKEN_COUNT_MAX = 64;

export type ComponentTokens = Readonly<Record<string, string>>;

/** Whether `name` may be a token name. */
export function tokenName(name: unknown): name is string {
  return typeof name === "string" && name.length <= TOKEN_NAME_MAX && NAME.test(name);
}

/** Whether `value` may be a token value: a short CSS value such as `4px`, `1.4` or `0.5rem`. */
export function tokenValue(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= TOKEN_VALUE_MAX && !BAD_VALUE.test(value);
}

/** The valid entries of `input`, sorted by name (a name or value that is refused is dropped, the rest stays). */
export function cleanTokens(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const name of Object.keys(input).sort()) {
    const value = (input as Record<string, unknown>)[name];
    if (!tokenName(name) || !tokenValue(value)) continue;
    if (Object.keys(out).length >= TOKEN_COUNT_MAX) break;
    out[name] = value.trim();
  }
  return out;
}

/** The stylesheet text for a set (`:root{--a:1;--b:2}`), "" for none. */
export function tokensCss(tokens: ComponentTokens): string {
  const entries = Object.entries(cleanTokens(tokens));
  return entries.length ? `:root{${entries.map(([name, value]) => `${name}:${value}`).join(";")}}` : "";
}

let current: ComponentTokens = {};
const listeners = new Set<(tokens: ComponentTokens, before: ComponentTokens) => void>();

/** The tokens every component page is built with now. */
export function componentTokens(): ComponentTokens {
  return current;
}

/** The set `componentPage` writes into a page (`<style id="ccb-tokens">`), "" for none. */
export function componentTokensCss(): string {
  return tokensCss(current);
}

/**
 * Makes `input` (cleaned) the set for every page built from now on, and tells whoever listens when it differs from the one
 * before. Returns whether it changed.
 */
export function setComponentTokens(input: unknown): boolean {
  const next = cleanTokens(input);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  const before = current;
  current = next;
  for (const listener of [...listeners]) {
    try { listener(next, before); } catch (error) { console.error(error); }
  }
  return true;
}

/** Calls `listener` whenever the set changes; returns how to stop. */
export function onComponentTokens(listener: (tokens: ComponentTokens, before: ComponentTokens) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The script a page carries when it was built with tokens: it takes `{ccbTokens: "<css>"}` from its parent (only) and
 * puts it in `<style id="ccb-tokens">`, so a change reaches a frame on screen without reloading it. "" empties it.
 */
export const tokenListenerScript = `
window.addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== parent || !message || typeof message.ccbTokens !== 'string') return;
  let style = document.getElementById('ccb-tokens');
  if (!style) { style = document.createElement('style'); style.id = 'ccb-tokens'; document.head.appendChild(style); }
  style.textContent = message.ccbTokens;
});`;
