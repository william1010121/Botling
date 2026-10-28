import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_TEMPLATE } from "../../src/core/components/builtins";
import { desktop } from "../helpers";

// jsdom ships without declarations; use the standard DOM surface exercised by this harness.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: object) => { window: Window & typeof globalThis };
};

const kit = readFileSync(join(desktop, "../Web/kit/generated/kit.v1.js"), "utf8");
function preview(data: Record<string, unknown>) {
  const dom = new JSDOM(PREVIEW_TEMPLATE, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const open = vi.fn();
  let onData: ((data: Record<string, unknown>) => void) | undefined;
  const disconnect = vi.fn();
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => 640 });
  Object.assign(w, {
    ccb: { data, open, onData: (fn: typeof onData) => { onData = fn; return () => { onData = undefined; }; } },
    ResizeObserver: class { observe() {} disconnect = disconnect; },
  });
  w.eval(kit);
  w.eval(w.document.querySelector("script")!.textContent!);
  return { dom, w, open, disconnect, update: async (next: Record<string, unknown>) => {
    await vi.waitFor(() => expect(onData).toBeTypeOf("function"));
    onData!(next);
    await new Promise(resolve => setTimeout(resolve, 0));
  } };
}

describe("kit built-in preview", () => {
  it("renders the real kit and preserves image, scaling, click and keyboard open contract", () => {
    const p = preview({ title: "<Report>", name: "report.html", src: "ccb-preview://page", shot: "data:image/png;base64,AA==", url: "file:///report.html" });
    try {
      const d = p.w.document;
      expect(d.querySelector('meta[name="ccb-kit"]')?.getAttribute("content")).toBe("1");
      expect(d.querySelector(".ccb-card .ccb-button")?.textContent).toBe("開啟完整頁面");
      expect(d.querySelector(".preview-title")?.textContent).toBe("<Report>");
      expect(d.querySelector(".preview-name")?.textContent).toBe("report.html");
      expect(d.querySelector("iframe")).toBeNull();
      expect(d.querySelector("img")?.style.transform).toBe("scale(0.5)");
      const shot = d.querySelector<HTMLElement>(".preview-shot")!;
      expect(shot.style.height).toBe("400px");
      shot.click();
      for (const key of ["Enter", " "]) shot.dispatchEvent(new p.w.KeyboardEvent("keydown", { key, bubbles: true }));
      shot.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      d.querySelector<HTMLButtonElement>("button")!.click();
      expect(p.open.mock.calls).toEqual(Array(4).fill(["file:///report.html", "<Report>"]));
    } finally { p.w.close(); }
  });

  it("keeps the iframe sandbox and updates images, actions, missing state and observer on live data", async () => {
    const p = preview({ name: "first.html", src: "ccb-preview://first", url: "file:///first.html" });
    try {
      const d = p.w.document;
      expect(d.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      await p.update({ title: "Second", src: "ccb-preview://second", shot: "data:image/png;base64,AA==", url: "file:///second.html" });
      expect(d.querySelector("iframe")).toBeNull();
      expect(d.querySelector("img")).not.toBeNull();
      d.querySelector<HTMLButtonElement>("button")!.click();
      expect(p.open).toHaveBeenLastCalledWith("file:///second.html", "Second");
      await p.update({ missing: true, src: "ccb-preview://second", url: "file:///second.html" });
      expect(d.querySelector(".ccb-empty")?.textContent).toBe("找不到這個檔案");
      expect(d.querySelector(".preview-shot")).toBeNull();
      expect(d.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
      d.querySelector<HTMLButtonElement>("button")!.click();
      expect(p.open).toHaveBeenCalledTimes(1);
      expect(p.disconnect).toHaveBeenCalledTimes(2);
    } finally { p.w.close(); }
  });

  it("retains a usable open action without a preview and disables it without a URL", () => {
    for (const data of [{ url: "file:///page.html" }, {}]) {
      const p = preview(data);
      try {
        expect(p.w.document.querySelector(".ccb-empty")?.textContent).toBe("這個頁面無法預覽");
        const button = p.w.document.querySelector<HTMLButtonElement>("button")!;
        expect(button.disabled).toBe(!("url" in data));
        button.click();
        expect(p.open.mock.calls).toEqual("url" in data ? [[data.url, "網頁預覽"]] : []);
      } finally { p.w.close(); }
    }
  });
});
