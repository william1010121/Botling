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

// 2026-11-10: the report preview offers the page's bot's bubble, the same BotBubble as the Note tab and the browser's
// full screen (so a later restyle applies to all three). Clicking it shows the bot's real chat over the page (the viewer
// stops hiding the native chat); Esc hides the chat first, then closes the preview.
const bot = { id: "b", name: "Bot", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 1, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as import("../../src/contract").BotView;
const url = "botling-card://preview/project/artifacts/report.html";

it("offers the page's bot's chat bubble (the shared BotBubble)", async () => {
  const toggle = vi.fn(), close = vi.fn();
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: false, onToggle: toggle } })); });
  const bubble = document.querySelector<HTMLButtonElement>(".report-viewer .bp-bubble.report-bubble");
  expect(bubble).not.toBeNull();
  expect(bubble!.getAttribute("aria-pressed")).toBe("false");
  expect(document.querySelector("section")?.getAttribute("aria-modal")).toBe("true");
  await act(async () => { bubble!.click(); });
  expect(toggle).toHaveBeenCalledOnce();
});

it("lets the chat show while it is open, and Esc hides it before closing the preview", async () => {
  const { shellOverlayActive } = await import("../../src/renderer/ShellOverlay");
  const toggle = vi.fn(), close = vi.fn();
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: false, onToggle: toggle } })); });
  expect(shellOverlayActive()).toBe(true);
  await act(async () => { root.render(createElement(ReportViewer, { url, onClose: close, bubble: { bot, look: "original", on: true, onToggle: toggle } })); });
  expect(shellOverlayActive()).toBe(false);
  const section = document.querySelector("section")!;
  expect(section.getAttribute("aria-modal")).not.toBe("true");
  expect(document.querySelector(".report-bubble")?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { section.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(toggle).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("is given the chat's bot by the app", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  expect(readFileSync(join(__dirname, "../../src/renderer/App.tsx"), "utf8")).toMatch(/<ReportViewer url=\{report.url\}[^\n]*\n\s*bubble=\{bubble \?/);
});
