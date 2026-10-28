import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { sent } from "../src/bridge";
import { extensions, jumpTo } from "../src/messages";
import { stepsElement, liveElement } from "../src/steps";
import type { ChatState, MessageView, StepView } from "../src/types";

class Sizes {
  static all: Sizes[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { Sizes.all.push(this); }
  observe(element: Element) { this.targets.add(element); }
  unobserve(element: Element) { this.targets.delete(element); }
  disconnect() { this.targets.clear(); }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}
class Near {
  static all: Near[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { Near.all.push(this); }
  observe(element: Element) { this.targets.add(element); }
  unobserve(element: Element) { this.targets.delete(element); }
  disconnect() { this.targets.clear(); }
}
globalThis.ResizeObserver = Sizes as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver = Near as unknown as typeof IntersectionObserver;
globalThis.CSS ??= {} as typeof CSS;
CSS.escape ??= (text) => text.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

const message = (i: number, extra: Partial<MessageView> = {}): MessageView => ({
  id: `m${i}`, role: "bot", text: `Reply ${i}`, stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, display: null,
  attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra,
});
const history = (n: number) => Array.from({ length: n }, (_, i) => message(i));
const state = (messages: MessageView[], extra: Partial<ChatState> = {}): ChatState => ({
  botID: "history", botName: "History", messages, working: false, avatar: "", placeholder: "",
  replyingTo: null, pendingFiles: [], components: {}, ...extra,
});
const rows = () => [...document.querySelectorAll<HTMLElement>("#messages > .row, #messages > .stamped")];
const row = (id: string) => document.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;
const more = () => document.querySelector<HTMLButtonElement>(".history-more")!;
let scroller: HTMLElement;
let paints: FrameRequestCallback[];
let bot = 0;

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
  scroller = document.getElementById("scroller")!;
});
beforeEach(() => {
  paints = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  window.ccb.setState(state([], { botID: `reset-${++bot}` }));
  sent.length = 0;
});
afterEach(() => vi.unstubAllGlobals());
const paint = () => { for (const callback of paints.splice(0)) callback(0); };

describe("chat history window", () => {
  it("mounts only the recent 50 of 525 messages, and appends new replies without replacing mounted rows or the editor", () => {
    const rendered: string[] = [];
    extensions.afterRender.push({ plugin: "history-test", handler: (_element, m) => rendered.push(m.id) });
    try {
      const messages = history(525);
      window.ccb.setState(state(messages));
      expect(rows()).toHaveLength(50);
      expect(rendered).toEqual(messages.slice(-50).map(m => m.id));
      expect(rows()[0].dataset.id).toBe("m475");
      expect(row("m474")).toBeNull();
      expect(more().textContent).toBe("Load 50 earlier messages");
      const mounted = row("m475");
      const editor = document.querySelector<HTMLElement>("#composer-slot .cm-editor")!;
      const view = EditorView.findFromDOM(editor)!;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "unsent draft" } });
      window.ccb.setState(state([...messages, message(525)]));
      expect(rows()).toHaveLength(51);
      expect(row("m475")).toBe(mounted);
      expect(document.querySelector("#composer-slot .cm-editor")).toBe(editor);
      expect(EditorView.findFromDOM(editor)).toBe(view);
      expect(view.state.doc.toString()).toBe("unsent draft");
      expect(rendered).toHaveLength(51);
    } finally { extensions.afterRender.pop(); }
  });

  it("loads one page on upward scrolling, preserves the visible row through prepend and later size changes, and stops at the beginning", () => {
    const messages = history(125);
    let top = 0, above = 0, below = 0;
    const rect = (y: number, height: number) => ({ x: 0, y, top: y, bottom: y + height, left: 0, right: 600, width: 600, height, toJSON() {} }) as DOMRect;
    const height = () => rows().length * 40 + (more().hidden ? 0 : 24) + above + below;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: height },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, height() - 400)); } },
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return rect(0, 400);
      if (this.parentElement?.id === "messages" && (this.matches(".row, .stamped"))) {
        const index = rows().indexOf(this);
        return rect(index * 40 + (more().hidden ? 0 : 24) + (index >= 50 ? above : 0) - top, 40);
      }
      return original.call(this);
    });
    try {
      window.ccb.setState(state(messages));
      const retained = row("m75");
      scroller.scrollTop = 120;
      scroller.dispatchEvent(new Event("scroll"));
      const anchor = row("m78");
      const before = anchor.getBoundingClientRect().top;
      paint();
      expect(rows()).toHaveLength(100);
      expect(rows()[0].dataset.id).toBe("m25");
      expect(row("m75")).toBe(retained);
      expect(anchor.getBoundingClientRect().top).toBe(before);
      expect(scroller.scrollTop).toBe(2120);
      above = 160;
      Sizes.all.find(observer => observer.targets.has(document.getElementById("messages")!))!.fire();
      expect(anchor.getBoundingClientRect().top).toBe(before);
      expect(scroller.scrollTop).toBe(2280);
      below = 200;
      Sizes.all.find(observer => observer.targets.has(document.getElementById("messages")!))!.fire();
      expect(scroller.scrollTop).toBe(2280);
      more().click();
      expect(rows()).toHaveLength(125);
      expect(more().hidden).toBe(true);
      more().click();
      expect(rows()).toHaveLength(125);
    } finally {
      geometry.mockRestore();
      for (const property of ["scrollTop", "scrollHeight", "clientHeight"]) delete (scroller as unknown as Record<string, unknown>)[property];
    }
  });

  it("keeps iframe nodes and lazy observers through pagination, redraws changed rows, and releases removed history on switch", () => {
    const components = { card: { template: "<p>card</p>", version: 0, working: false, updated: false, hasPrevious: false } };
    const messages = history(110).map(m => ({ ...m, displays: [{ name: "card", data: "{}", at: null }] }));
    window.ccb.setState(state(messages, { components }));
    const frame = row("m60").querySelector<HTMLIFrameElement>("iframe")!;
    const watcher = Near.all.find(o => o.options?.rootMargin)!;
    expect(document.querySelectorAll("#messages iframe")).toHaveLength(50);
    expect(watcher.targets.has(frame)).toBe(true);
    more().click();
    expect(document.querySelectorAll("#messages iframe")).toHaveLength(100);
    expect(row("m60").querySelector("iframe")).toBe(frame);
    window.ccb.setState(state(messages.map(m => m.id === "m60" ? { ...m, text: "Updated" } : m), { components }));
    expect(row("m60").querySelector("iframe")).toBe(frame);
    expect(row("m60").textContent).toContain("Updated");
    window.ccb.setState(state(messages.slice(11), { components }));
    expect(rows()[0].dataset.id).toBe("m11");
    expect(row("m60").querySelector("iframe")).toBe(frame);
    expect([...watcher.targets].every(target => target.isConnected)).toBe(true);
    window.ccb.setState(state(history(130), { botID: "other" }));
    expect(rows()).toHaveLength(50);
    expect(frame.isConnected).toBe(false);
    expect(watcher.targets.has(frame)).toBe(false);
    expect([...watcher.targets].every(target => target.isConnected)).toBe(true);
  });

  it("mounts a quote or task navigation target outside the window, while missing targets leave the window alone", () => {
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      window.ccb.setState(state(history(160)));
      jumpTo("unknown");
      expect(rows()).toHaveLength(50);
      jumpTo("m20");
      expect(row("m20")).not.toBeNull();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(row("m159")).not.toBeNull();
      window.ccb.setState(state(history(160), { botID: "tasks" }));
      expect(row("m15")).toBeNull();
      window.ccb.jumpToTask("m15", "task-1");
      expect(row("m15")).not.toBeNull();
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally { HTMLElement.prototype.scrollIntoView = previous; }
  });

  it("applies existing state patches without mounting hidden changes, and renders the latest hidden text when requested", () => {
    const messages = history(140);
    window.ccb.setState(state(messages));
    const unchanged = row("m100");
    window.ccb.patchState({ order: [...messages.map(m => m.id), "m140"], changed: [message(10, { text: "hidden update" }), message(140)] });
    expect(rows()).toHaveLength(51);
    expect(row("m10")).toBeNull();
    expect(row("m100")).toBe(unchanged);
    more().click();
    more().click();
    expect(row("m10").textContent).toContain("hidden update");
    expect(row("m140").textContent).toContain("Reply 140");
    expect(sent.some(action => action.type === "resync")).toBe(false);
  });

  it("keeps the loaded boundary on language redraw and resets it on subagent identity changes within the same bot", () => {
    const messages = history(150);
    window.ccb.setState(state(messages));
    more().click();
    expect(rows()).toHaveLength(100);
    window.ccb.setState(state(messages, { lang: "zh-Hant" }));
    expect(rows()).toHaveLength(100);
    expect(more().textContent).toBe("載入更早的 50 則訊息");
    const subagent = { id: "sub1", title: "Inspect", owner: "Main", status: "running", type: null };
    window.ccb.setState(state(messages, { subagent }));
    expect(rows()).toHaveLength(50);
    expect(rows()[0].classList.contains("sub-work")).toBe(true);
    more().click();
    window.ccb.setState(state(messages, { subagent: { ...subagent, id: "sub2" } }));
    expect(rows()).toHaveLength(50);
    window.ccb.setState(state(messages));
    expect(rows()).toHaveLength(50);
    expect(rows()[0].classList.contains("sub-work")).toBe(false);
  });

  it("does not load history for ordinary bottom-following scroll events or wheel down", () => {
    window.ccb.setState(state(history(150)));
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 30 }));
    paint();
    expect(rows()).toHaveLength(50);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    paint();
    expect(rows()).toHaveLength(100);
  });
});

const step = (id: string, extra: Partial<StepView> = {}): StepView => ({
  id, kind: "tool", tool: "Bash", title: id, detail: "input", output: "large output\n".repeat(20000),
  failed: false, done: true, status: null, count: null, ...extra,
});
describe("deferred work details", () => {
  it("creates step rows on first expansion, then tool text and images only when their own line opens; preserves disclosure and fresh output on redraw", () => {
    const steps = Array.from({ length: 200 }, (_, i) => step(`deferred-${i}`));
    steps[0].images = [{ url: "ccb-preview:picture", name: "picture" }];
    const work = stepsElement("deferred-list", steps);
    expect(work.querySelectorAll(".step")).toHaveLength(0);
    expect(work.querySelectorAll("pre, img")).toHaveLength(0);
    const toggle = work.querySelector<HTMLButtonElement>(".steps-toggle")!;
    toggle.click();
    expect(work.querySelectorAll(".step")).toHaveLength(200);
    expect(work.querySelectorAll("pre, img")).toHaveLength(0);
    const head = work.querySelector<HTMLButtonElement>(".step-head")!;
    head.click();
    expect(work.querySelectorAll("pre")).toHaveLength(2);
    expect(work.querySelector<HTMLImageElement>("img")!.getAttribute("src")).toBe("ccb-preview:picture");
    const output = work.querySelectorAll("pre")[1];
    head.click(); head.click();
    expect(work.querySelectorAll("pre")[1]).toBe(output);
    const again = stepsElement("deferred-list", [{ ...steps[0], output: "updated output" }, ...steps.slice(1)]);
    expect(again.querySelector(".steps-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect(again.querySelector(".step-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(again.querySelectorAll("pre")[1].textContent).toBe("updated output");
    expect(again.querySelectorAll("pre")).toHaveLength(2);
  });

  it("defers interleaved prose and folded runs while retaining visible subagent cards and the live tail", () => {
    const steps = [step("lazy-prose", { kind: "text", title: "**Inspecting**" }), step("lazy-tool"), step("lazy-agent", { kind: "subagent", title: "Review", status: "running" })];
    const work = stepsElement("mixed-deferred", steps);
    expect(work.querySelector(".step-prose")).toBeNull();
    expect(work.querySelectorAll(".subagent-card")).toHaveLength(1);
    expect(work.querySelector(".subagent-card")!.closest("[hidden], .steps")).toBeNull();
    work.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(work.querySelector(".step-prose strong")?.textContent).toBe("Inspecting");
    expect(work.querySelector(".step.tool")).toBeNull();
    work.querySelector<HTMLButtonElement>(".steps-run .steps-toggle")!.click();
    expect(work.querySelectorAll(".step.tool")).toHaveLength(1);
    expect(work.querySelector("pre")).toBeNull();
    const live = liveElement(Array.from({ length: 40 }, (_, i) => step(`live-lazy-${i}`)));
    expect(live.querySelectorAll(".step.tool")).toHaveLength(6);
    expect(live.querySelectorAll("pre")).toHaveLength(0);
  });
});


it("bounds old-message navigation and retains its context and selection through incoming updates", () => {
  const previous = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const messages = history(2000);
    window.ccb.setState(state(messages));
    expect(rows()).toHaveLength(50);
    jumpTo("m20");
    expect(row("m20")).not.toBeNull();
    expect(row("m19")).not.toBeNull();
    expect(row("m21")).not.toBeNull();
    expect(scroll).toHaveBeenCalled();
    expect(rows().length).toBeLessThanOrEqual(150);
    const target = row("m20");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(target.querySelector(".text") ?? target);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    expect(selected).toContain("Reply 20");
    window.ccb.patchState({
      order: [...messages.map(m => m.id), "m2000"],
      changed: [message(1999, { text: "stream update" }), message(2000)],
    });
    expect(rows().length).toBeLessThanOrEqual(150);
    expect(row("m20")).toBe(target);
    expect(selection.toString()).toBe(selected);
    jumpTo("m1999");
    expect(row("m1999").textContent).toContain("stream update");
    expect(row("m2000")).not.toBeNull();
    expect(rows().length).toBeLessThanOrEqual(150);
  } finally { HTMLElement.prototype.scrollIntoView = previous; }
});
