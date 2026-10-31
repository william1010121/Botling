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
const rows = () => [...document.querySelectorAll<HTMLElement>("#messages > .row[data-id], #messages > .stamped")];
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

const loads = () => sent.filter((a) => (a as { type: string }).type === "loadHistory");

describe("history held by the app", () => {
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

  it("offers the older lines the app holds, and asks for them once", () => {
    window.ccb.setState(state(history(10).map((m, i) => ({ ...m, id: `m${i + 30}` })), { history: { hasMore: true, older: 30 } }));
    expect(more().hidden).toBe(false);
    expect(more().textContent).toBe("Load 30 earlier messages");
    more().click();
    more().click();
    expect(loads()).toEqual([{ type: "loadHistory" }]);
  });

  it("shows no button for a whole chat", () => {
    window.ccb.setState(state(history(10)));
    expect(more().hidden).toBe(true);
  });

  it("mounts the older page when it arrives, in front of the lines already there", () => {
    const newer = history(10).map((m, i) => ({ ...m, id: `m${i + 30}` }));
    window.ccb.setState(state(newer, { history: { hasMore: true, older: 30 } }));
    more().click();
    const older = history(30).map((m, i) => ({ ...m, id: `m${i}` }));
    window.ccb.setState(state([...older, ...newer]));
    expect(rows().map((r) => r.dataset.id)).toEqual([...older, ...newer].map((m) => m.id));
    expect(more().hidden).toBe(true);
  });

  it("jumps to a line that is on an older page: asks for that page, then goes to it", async () => {
    const newer = history(10).map((m, i) => ({ ...m, id: `m${i + 300}` }));
    window.ccb.setState(state(newer, { history: { hasMore: true, older: 300 } }));
    document.dispatchEvent(new CustomEvent("ccb-reveal-message", { detail: "m7" }));
    expect(loads()).toEqual([{ type: "loadHistory", until: "m7" }]);
    expect(row("m7")).toBeNull();
    const older = history(300).map((m, i) => ({ ...m, id: `m${i}` }));
    window.ccb.setState(state([...older, ...newer]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(row("m7")).not.toBeNull();
    expect(row("m7").classList.contains("flash")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
