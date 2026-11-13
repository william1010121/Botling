// The browser pane's site-tools sheet as drawn (static markup, no window): the "What should the tool do?" box above
// the ask button, and which keys in it send.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteToolsSheet, askKeySends } from "../../src/renderer/SiteToolsSheet";

const sheet = (url: string | null) => renderToStaticMarkup(createElement(SiteToolsSheet, {
  botId: "b1", botName: "EEG", catalog: null, runs: {}, closeIcon: null,
  tab: url ? { id: "t1", url, title: "Page" } : null,
  onClose() {}, onAsk: async () => {}, askText: (page: string) => page,
} as unknown as Parameters<typeof SiteToolsSheet>[0]));

describe("the site-tools sheet", () => {
  it("has the request box before the ask button", () => {
    const out = sheet("https://chatgpt.com/c/1");
    expect(out).toContain("What should the tool do?");
    expect(out).toMatch(/<textarea[^>]*class="bp-field-text bp-tool-request-text"/);
    expect(out.indexOf("bp-tool-request-text")).toBeLessThan(out.indexOf("bp-tool-ask"));
    expect(out).toContain("Ask EEG to make a tool for this site");
  });
  it("turns the box off with no page", () => {
    expect(sheet(null)).toMatch(/<textarea[^>]*disabled/);
  });
  it("sends on Enter and ⌘Enter, not Shift+Enter or while composing", () => {
    expect(askKeySends({ key: "Enter", shiftKey: false })).toBe(true);
    expect(askKeySends({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false } })).toBe(true);
    expect(askKeySends({ key: "Enter", shiftKey: true })).toBe(false);
    expect(askKeySends({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
    expect(askKeySends({ key: "a", shiftKey: false })).toBe(false);
  });
});
