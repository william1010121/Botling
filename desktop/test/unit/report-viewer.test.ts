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
