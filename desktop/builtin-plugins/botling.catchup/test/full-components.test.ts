// @vitest-environment jsdom
// The source viewer ("Show N messages") shows a folded message's components whole, and is wide enough for them:
// no card is cut at a height behind a "Show whole card" button, and the dialog may grow past 960px.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SummaryViewer } from "../src/viewer";
import type { ChatState, MessageView } from "../../../../Web/src/types";
import type { CatchUpView } from "../src/types";
import { setLanguage } from "../../../../Web/src/i18n";
import { mediaHTML, renderMarkdown } from "../../../../Web/src/markdown";
import { setPage } from "../src/page";
import { catchupCSS } from "./page";

// A running chat frame's picture, taller than the old 240px clip.
vi.mock("../../../../Web/src/source-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../Web/src/source-snapshot")>()),
  requestSourceSnapshot: async () => ({ html: "<p>whole card</p>", height: 600 }),
}));

setPage({ render: renderMarkdown, media: (url, label) => mediaHTML(url, label) });
const message = (id: string, extra: Partial<MessageView> = {}): MessageView => ({ id, role: "bot", text: `Original ${id}`, stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra });
const view: CatchUpView = { key: "range", ids: ["a"], count: 1, state: "ready", bullets: ["Point"], model: "m", requestedBy: "user" };
const state = (m: MessageView): ChatState => ({ botID: "bot", botName: "Garden", messages: [m], working: false, avatar: "", placeholder: "", pendingFiles: [], replyingTo: null, components: {} });
let viewer: SummaryViewer;
let height: PropertyDescriptor | undefined;
beforeEach(() => {
  setLanguage("en"); document.body.innerHTML = "<main></main>"; viewer = new SummaryViewer();
  // jsdom lays nothing out: every card "measures" far taller than the old 240px clip.
  height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
});
afterEach(() => { viewer.close(); if (height) Object.defineProperty(HTMLElement.prototype, "scrollHeight", height); else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight; });
const settle = () => new Promise<void>((done) => setTimeout(done, 20));
const nothingCut = () => {
  expect(document.querySelector(".source-clipped")).toBeNull();
  expect(document.querySelector(".source-whole")).toBeNull();
  expect(document.querySelector(".summary-source-viewer")?.textContent).not.toContain("Show whole card");
};

it("a component's saved data (no template to draw) is shown in full, not cut behind \"Show whole card\"", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  const m = message("a", { displays: [{ name: "gone-chart", data: JSON.stringify({ rows }, null, 2) }] });
  viewer.open("owner", state(m), view, () => null, () => {});
  await settle();
  expect(document.querySelector(".source-card pre")?.textContent).toContain("row 39");
  nothingCut();
});

it("a running chat frame's picture is shown in full", async () => {
  const m = message("a", { displays: [{ name: "gone-chart", data: "{}" }] });
  const row = document.createElement("div"); row.innerHTML = '<iframe class="component-frame"></iframe>';
  viewer.open("owner", state(m), view, () => row, () => {});
  await settle();
  expect(document.querySelector(".source-snapshot .source-static-frame")).not.toBeNull();
  nothingCut();
});

it("a long list of choices is shown in full", async () => {
  const m = message("a", { choices: Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}`, detail: "a detail", recommended: false })), open: true });
  viewer.open("owner", state(m), view, () => null, () => {});
  await settle();
  expect(document.querySelectorAll(".source-option")).toHaveLength(12);
  nothingCut();
});

it("the viewer dialog is wider than 960px (up to 1280px), and still fits a narrow window", () => {
  const rule = catchupCSS.match(/\.summary-source-viewer\s*\{[^}]*\}/)?.[0] ?? "";
  const width = rule.match(/[^-]width:\s*min\((\d+)px,\s*calc\(100vw - (\d+)px\)\)/);
  expect(width, rule).not.toBeNull();
  expect(Number(width![1])).toBeGreaterThanOrEqual(1200);
  expect(Number(width![2])).toBeLessThanOrEqual(24);
});
