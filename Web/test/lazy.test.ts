import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { componentElement, frameBuilt, placeholderHeight, refreshDueCards } from "../src/components";
import type { ChatState, ComponentInfo, DisplayView, MessageView } from "../src/types";

// Lazy component frames: a chat's frames are built only once they come near the visible chat
// (opening a long chat built every frame in its history at once, for seconds).

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

/** A stand-in IntersectionObserver: the test says which elements come near. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly watched = new Set<Element>();
  readonly options: IntersectionObserverInit | undefined;
  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.options = options;
    FakeObserver.all.push(this);
  }
  observe(element: Element) { this.watched.add(element); }
  unobserve(element: Element) { this.watched.delete(element); }
  disconnect() { this.watched.clear(); }
  /** `elements` come within the margin of the visible chat. */
  near(...elements: Element[]) {
    const entries = elements.filter((element) => this.watched.has(element))
      .map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}
globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
// The chat's own (the input box's editor watches with others).
const watcher = () => FakeObserver.all.find((observer) => observer.options?.rootMargin)!;

const info = (template: string): ComponentInfo => ({ template, version: 0, working: false, updated: false, hasPrevious: false });
const components: Record<string, ComponentInfo> = { card: info("<p>card</p>"), choices: info("<p>choices</p>") };

function message(id: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id, role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

const shown = (data: string, extra: Partial<DisplayView> = {}): DisplayView => ({ name: "card", data, at: null, ...extra });

function state(messages: MessageView[], overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "Bot", messages, working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, ...overrides,
  };
}

const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("#messages iframe.component-frame")];
const say = (frame: HTMLIFrameElement, data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

beforeEach(() => {
  sent.length = 0;
});

describe("component frames in the chat", () => {
  it("are built only once they come near the visible chat", () => {
    const history = Array.from({ length: 20 }, (_, i) => message(`m${i}`, { displays: [shown(`{"n":${i}}`)] }));
    window.ccb.setState(state(history));
    const all = frames();
    expect(all).toHaveLength(20);
    // Watched against the chat's scroller, with a generous margin.
    expect(watcher().options?.root).toBe(document.getElementById("scroller"));
    expect(watcher().options?.rootMargin).toMatch(/^\d{3,}px/);
    expect(all.every((frame) => !frame.srcdoc && !frameBuilt(frame))).toBe(true);
    // A placeholder with a height, so the chat does not collapse and jump when they are built.
    expect(all[0].classList.contains("pending")).toBe(true);
    expect(all[0].style.height).toBe(`${placeholderHeight}px`);

    // The last two scroll near: only they get their pages.
    watcher().near(all[18], all[19]);
    expect(all.filter((frame) => frame.srcdoc)).toEqual([all[18], all[19]]);
    expect(all[19].srcdoc).toContain(`{"n":19}`);
        expect(watcher().watched.has(all[19])).toBe(false);
    expect(watcher().watched.has(all[0])).toBe(true);
  });

  it("those in view or near it when the chat opens are built at once", () => {
    const scroller = document.getElementById("scroller")!;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height }) as DOMRect;
    scroller.getBoundingClientRect = () => rect(0, 800);
    const frame = HTMLIFrameElement.prototype as HTMLIFrameElement;
    const before = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
    // Message i of 20 sits 1000px below the one before it; the last is in view.
    frame.getBoundingClientRect = function (this: HTMLIFrameElement) { return rect((frames().indexOf(this) - 19) * 1000 + 500, 200); };
    try {
      window.ccb.setState(state(Array.from({ length: 20 }, (_, i) => message(`v${i}`, { displays: [shown(`{"v":${i}}`)] })), { botID: "view" }));
      const all = frames();
      // In view, and the two within the margin above it.
      expect(all.filter((element) => frameBuilt(element))).toEqual(all.slice(17));
    } finally {
      delete (frame as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      delete (scroller as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      expect(Element.prototype.getBoundingClientRect).toBe(before.value);
    }
  });

  it("keep built and unbuilt frames alike when a redraw shows the same thing", () => {
    const history = [message("a", { displays: [shown(`{"a":1}`)] }), message("b", { displays: [shown(`{"b":1}`)] })];
    window.ccb.setState(state(history, { botID: "keep" }));
    const [a, b] = frames();
    watcher().near(b);
    // The bot finishes and the components library changes (every component message is redrawn).
    window.ccb.setState(state(history, { botID: "keep", working: true, components: { ...components, other: info("<p>x</p>") } }));
    expect(frames()[0]).toBe(a);
    expect(frames()[1]).toBe(b);
    expect(frameBuilt(a)).toBe(false);
    expect(frameBuilt(b)).toBe(true);
    // Only the frames on the page are watched: none of the dropped fresh copies.
    const pending = [...watcher().watched].filter((element) => element instanceof HTMLIFrameElement);
    expect(pending.every((element) => element.isConnected)).toBe(true);
  });

  it("an unbuilt card whose data changed (answered, <show id> updated) is replaced by one with the new data", () => {
    window.ccb.setState(state([message("q", { displays: [shown(`{"v":1}`)] })], { botID: "upd" }));
    const [before] = frames();
    window.ccb.setState(state([message("q", { displays: [shown(`{"v":2}`)] })], { botID: "upd" }));
    const [after] = frames();
    expect(after).not.toBe(before);
    expect(watcher().watched.has(before)).toBe(false);
    watcher().near(after);
    expect(after.srcdoc).toContain(`{"v":2}`);
  });

  it("start at the height they had, after switching away and back", () => {
    window.ccb.setState(state([message("h", { displays: [shown(`{"h":1}`)] })], { botID: "one" }));
    const [first] = frames();
    watcher().near(first);
    say(first, { ccb: "size", height: 333 });
    expect(first.style.height).toBe("333px");
    window.ccb.setState(state([message("x")], { botID: "two" }));
    // Every frame of the chat left is no longer watched.
    expect([...watcher().watched].some((element) => !element.isConnected)).toBe(false);
    window.ccb.setState(state([message("h", { displays: [shown(`{"h":1}`)] })], { botID: "one" }));
    const [again] = frames();
    expect(frameBuilt(again)).toBe(false);
    expect(again.style.height).toBe("333px");
  });

  it("an answered question's choices draw lazily with its answer", () => {
    const choices = [{ label: "Yes", detail: null, recommended: true }, { label: "No", detail: null, recommended: false }];
    window.ccb.setState(state([message("c", { choices, chosen: null, open: true })], { botID: "ask" }));
    const [open] = frames();
    expect(frameBuilt(open)).toBe(false);
    watcher().near(open);
    expect(open.srcdoc).toContain('"chosen":null');
    say(open, { ccb: "answer", index: 1 });
    expect(sent).toContainEqual({ type: "choose", messageID: "c", index: 1 });
  });
});

describe("command cards in the chat", () => {
  it("run their command for the first time only once they come near", () => {
    const card = shown("null", { command: "git log -1", folder: "/p", status: "idle" });
    window.ccb.setState(state([message("cmd", { displays: [card] })], { botID: "cmd" }));
    expect(sent.filter((action) => action.type === "componentCommand")).toHaveLength(0);
    const waiting = document.querySelector("#messages .command-waiting")!;
    watcher().near(waiting);
    expect(sent.filter((action) => action.type === "componentCommand")).toEqual([
      { type: "componentCommand", messageID: "cmd", index: 0, command: "git log -1", folder: "/p" },
    ]);
    // Drawn again while it runs: not asked twice.
    window.ccb.setState(state([message("cmd", { displays: [card] })], { botID: "cmd", working: true }));
    watcher().near(...document.querySelectorAll("#messages .command-waiting"));
    expect(sent.filter((action) => action.type === "componentCommand")).toHaveLength(1);
  });

  it("that refresh by themselves wait until their frame is built", () => {
    const card = shown(`{"cpu":1}`, { command: "top -l 1", folder: "/p", status: "done", every: 2 });
    window.ccb.setState(state([message("live", { displays: [card] })], { botID: "live" }));
    const element = document.querySelector<HTMLElement>("#messages .command-card")!;
    element.getBoundingClientRect = () => ({ top: 10, bottom: 200, left: 0, right: 300, width: 300, height: 190 }) as DOMRect;
    const now = Date.now();
    refreshDueCards(now);
    // Due, and on screen, but its frame is not built yet.
    expect(refreshDueCards(now + 5000)).toBe(0);
    watcher().near(element.querySelector(".component-frame")!);
    expect(refreshDueCards(now + 5000)).toBe(1);
  });
});

describe("surfaces always on show", () => {
  it("pinned, Board and floating copies are built at once", () => {
    for (const surface of ["pinned", "board"] as const) {
      const element = componentElement("card", components.card, `{"p":1}`, null, `pin-${surface}`, null, null, "2x2", surface);
      const frame = element!.querySelector<HTMLIFrameElement>("iframe")!;
      expect(frame.srcdoc).toContain(`{"p":1}`);
      expect(frameBuilt(frame)).toBe(true);
    }
  });
});
