// The native chat page can be reloaded on its own (View → Reload Chat Page). What was typed and not
// sent must come back: the page keeps each chat's draft in its tab's sessionStorage, which survives a
// reload of that same web contents and nothing else.
import { expect, it } from "vitest";
import { DRAFTS_KEY, keepDraft, keptDrafts, type DraftStore } from "../../src/renderer/chat-frame/draft-keep";

function store(initial: Record<string, string> = {}): DraftStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}

it("keeps each chat's unsent draft across a page reload and forgets one that was emptied", () => {
  const s = store();
  keepDraft(s, "main", { text: "half a thought", cursor: 6 });
  keepDraft(s, "other", { text: "second chat", cursor: 11 });
  // A fresh page (the reload) reads them back for Composer.setDrafts.
  expect(keptDrafts(s)).toEqual({ main: { text: "half a thought", cursor: 6 }, other: { text: "second chat", cursor: 11 } });
  // Sending (or clearing) the box posts an empty draft: it must not come back on the next reload.
  keepDraft(s, "main", { text: "", cursor: 0 });
  expect(keptDrafts(s)).toEqual({ other: { text: "second chat", cursor: 11 } });
  keepDraft(s, "other", { text: "", cursor: 0 });
  expect(s.data.has(DRAFTS_KEY)).toBe(false);
});

it("never breaks the page on missing, corrupt, oversized or hostile storage", () => {
  expect(keptDrafts(null)).toEqual({});
  expect(keptDrafts(store({ [DRAFTS_KEY]: "{not json" }))).toEqual({});
  expect(keptDrafts(store({ [DRAFTS_KEY]: `{"a":{"text":3},"b":"x","c":{"text":"ok","cursor":"no"},"__proto__":{"text":"p","cursor":0}}` }))).toEqual({ c: { text: "ok", cursor: 2 } });
  const throwing: DraftStore = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };
  expect(() => keepDraft(throwing, "main", { text: "x", cursor: 1 })).not.toThrow();
  expect(keptDrafts(throwing)).toEqual({});
  // Bad keys or values are ignored, not stored.
  const s = store();
  keepDraft(s, "", { text: "x", cursor: 1 });
  keepDraft(s, "main", { text: 5 as unknown as string, cursor: 1 });
  expect(s.data.size).toBe(0);
  // The cursor is clamped into the text.
  keepDraft(s, "main", { text: "abc", cursor: 99 });
  expect(keptDrafts(s)).toEqual({ main: { text: "abc", cursor: 3 } });
});
