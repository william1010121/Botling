// Unsent drafts across a reload of the native chat page (View → Reload Chat Page). The desktop does
// not persist Web/src's `draft` actions, so the page mirrors them into its own tab's sessionStorage:
// it survives a reload of this web contents only (never another window, never a restart), and is
// handed back to Composer.setDrafts when the new document starts.
export interface DraftStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface KeptDraft { text: string; cursor: number }
export const DRAFTS_KEY = "botling.chatDrafts.v1";
const LIMIT = 1_000_000;

export function keptDrafts(store: DraftStore | null): Record<string, KeptDraft> {
  const drafts: Record<string, KeptDraft> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(store?.getItem(DRAFTS_KEY) ?? "{}"); } catch { return drafts; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return drafts;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || key === "__proto__" || key.length > 160 || !value || typeof value !== "object") continue;
    const { text, cursor } = value as { text?: unknown; cursor?: unknown };
    if (typeof text !== "string" || !text) continue;
    drafts[key] = { text, cursor: typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, Math.min(cursor, text.length)) : text.length };
  }
  return drafts;
}

/** One chat's draft as the composer last told the app (empty text: forgotten). */
export function keepDraft(store: DraftStore | null, chat: string, draft: { text: unknown; cursor: unknown }): void {
  if (!store || typeof chat !== "string" || !chat || chat === "__proto__" || chat.length > 160 || typeof draft?.text !== "string") return;
  try {
    const drafts = keptDrafts(store);
    if (draft.text) drafts[chat] = { text: draft.text, cursor: typeof draft.cursor === "number" && Number.isSafeInteger(draft.cursor) ? Math.max(0, Math.min(draft.cursor, draft.text.length)) : draft.text.length };
    else delete drafts[chat];
    const text = JSON.stringify(drafts);
    if (Object.keys(drafts).length === 0) store.removeItem(DRAFTS_KEY);
    else if (text.length <= LIMIT) store.setItem(DRAFTS_KEY, text);
  } catch { /* storage refused (quota, privacy): the draft simply does not survive a reload */ }
}

/** This tab's sessionStorage, or null where the page has none. */
export function pageDraftStore(): DraftStore | null {
  try { return window.sessionStorage ?? null; } catch { return null; }
}
