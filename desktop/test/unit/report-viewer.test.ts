// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ReportViewer } from "../../src/renderer/ReportViewer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
const root = createRoot(container);
afterEach(async () => { await act(async () => { root.render(null); }); });

it("offers no invented alternate file for a single authorized preview URL", async () => {
  const url = "botling-card://preview/project/artifacts/report.html";
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: () => {} })); });
  expect([...document.querySelectorAll("button")].map(b => b.textContent)).toEqual(["← Back to conversation"]);
  expect(document.querySelector("iframe")?.getAttribute("src")).toBe(url);
  expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
});

it("tracks replacement authorized URLs, including slides without a filename suffix", async () => {
  const close = vi.fn();
  const first = "botling-card://preview/project/artifacts/report.html";
  const next = "botling-card://preview/project/artifacts/deck.html";
  await act(async () => { root.render(createElement(ReportViewer, { url: first, onClose: close })); });
  await act(async () => { root.render(createElement(ReportViewer, { url: next, onClose: close })); });
  expect(document.querySelector("iframe")?.getAttribute("src")).toBe(next);
  await act(async () => { document.querySelector("section")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(close).toHaveBeenCalledOnce();
});

// 2026-11-10: the report preview offers the page's bot's chat, the same BotBubble as the Note tab and the browser's
// full screen (so a restyle applies to all three). Since the floating chat (design B) it is the strip in a corner of the
// page; clicking it opens the bot's real chat over the page (the viewer stops hiding the native chat); Esc hides the
// chat first, then closes the preview.
const bot = { id: "b", name: "Bot", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 1, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as import("../../src/contract").BotView;
const url = "botling-card://preview/project/artifacts/report.html";

it("offers the page's bot's chat as the floating chat's strip (the shared BotBubble)", async () => {
  const open = vi.fn(), close = vi.fn();
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: false, onOpen: open, line: "首頁標題放大到 32px 了" } })); });
  const strip = document.querySelector<HTMLElement>(".report-viewer .float-strip-holder[data-place=\"preview\"] .bot-strip");
  expect(strip).not.toBeNull();
  expect(strip!.textContent).toContain("首頁標題放大到 32px 了");
  expect(strip!.querySelector(".bot-strip-badge")?.textContent).toBe("1");
  const button = strip!.querySelector<HTMLButtonElement>(".bot-strip-open")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector("section")?.getAttribute("aria-modal")).toBe("true");
  await act(async () => { button.click(); });
  expect(open).toHaveBeenCalledWith(true);
});

it("lets the chat show while it is open, and Esc hides it before closing the preview", async () => {
  const { shellOverlayActive } = await import("../../src/renderer/ShellOverlay");
  const open = vi.fn(), close = vi.fn();
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: false, onOpen: open, line: "" } })); });
  expect(shellOverlayActive()).toBe(true);
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: true, onOpen: open, line: "" } })); });
  expect(shellOverlayActive()).toBe(false);
  const section = document.querySelector("section")!;
  expect(section.getAttribute("aria-modal")).not.toBe("true");
  // Open, the strip makes way for the panel.
  expect(document.querySelector(".report-viewer .bot-strip")).toBeNull();
  await act(async () => { section.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(open).toHaveBeenCalledWith(false);
  expect(close).not.toHaveBeenCalled();
});

it("is given the chat's bot by the app", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  expect(readFileSync(join(__dirname, "../../src/renderer/App.tsx"), "utf8")).toMatch(/<ReportViewer url=\{report.url\}[^\n]*\n\s*bubble=\{bubble \?/);
});
