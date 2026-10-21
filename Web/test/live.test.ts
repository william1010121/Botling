/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { componentElement, componentPage, keepFrames, refreshDueCards } from "../src/components";
import { messageElement } from "../src/messages";
import { FloatLayer } from "../src/float";
import { PinArea } from "../src/pins";
import type { ChatState, ComponentInfo, DisplayView, MessageView, PinView } from "../src/types";

// Live components: ccb.onData (new data without reloading the frame), ccb.load(), and a card
// whose command runs again every few seconds while it is on screen.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  cpu: { template: "<pre></pre>", version: 1, working: false, updated: false, hasPrevious: false },
};

function message(displays: DisplayView[]): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
  };
}

const card = (overrides: Partial<DisplayView> = {}): DisplayView => ({
  name: "cpu", data: `{"cpu":10}`, command: "top -l 1", folder: "/p", status: "done", ranAt: "10:42", every: 2, ...overrides,
});

/** Runs a component page's ccb script against a fake window, with what it posts and hears. */
function run(page: string) {
  const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
  const posted: unknown[] = [];
  const listeners: ((event: { data: unknown; source: unknown }) => void)[] = [];
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const frame = {
    addEventListener(type: string, listener: (event: { data: unknown; source: unknown }) => void) {
      if (type === "message") listeners.push(listener);
    },
  } as unknown as { ccb: { data: unknown; load: () => Promise<unknown>; onData: (fn: (data: unknown) => void) => () => void } };
  new Function("window", "parent", script)(frame, parent);
  const hear = (data: unknown) => listeners.forEach((listener) => listener({ data, source: parent }));
  return { ccb: frame.ccb, posted, hear };
}

/**
 * Holds the page's animation frames until `paint()`, so a frame drawing new data behind the shown
 * one takes its place exactly when the test says it has loaded and painted, never by the clock.
 */
function holdPaints(): { paint: () => void } {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queue.push(callback));
  return { paint: () => { while (queue.length) queue.shift()!(0); } };
}

const say = (frame: HTMLIFrameElement, data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("in the frame", () => {
  it("ccb.load() resolves to the data it has", async () => {
    const { ccb } = run(componentPage("<p></p>", `{"items":[1]}`));
    await expect(ccb.load()).resolves.toEqual({ items: [1] });
  });

  it("ccb.onData asks for live data and gets each new data", () => {
    const { ccb, posted, hear } = run(componentPage("<p></p>", `{"cpu":1}`));
    const got: unknown[] = [];
    const stop = ccb.onData((data) => got.push(data));
    expect(posted).toContainEqual({ ccb: "live" });
    hear({ ccbData: `{"cpu":42}` });
    expect(got).toEqual([{ cpu: 42 }]);
    expect(ccb.data).toEqual({ cpu: 42 });
    // Not JSON: ignored.
    hear({ ccbData: "{oops" });
    stop();
    hear({ ccbData: `{"cpu":7}` });
    expect(got).toEqual([{ cpu: 42 }]);
    expect(ccb.data).toEqual({ cpu: 7 });
  });
});

describe("a frame that takes live data", () => {
  it("keeps its frame when only the data changes and is sent the new data", () => {
    const row = messageElement(message([card()]), components);
    document.body.append(row);
    const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    const posts: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => { posts.push(data); });
    say(frame, { ccb: "live" });

    const fresh = messageElement(message([card({ data: `{"cpu":80}` })]), components);
    expect(keepFrames(row, fresh)).toBe(row);
    expect(row.querySelector(".component-frame")).toBe(frame);
    expect(posts).toContainEqual({ ccbData: `{"cpu":80}` });
    // The same data again: nothing to send.
    posts.length = 0;
    keepFrames(row, messageElement(message([card({ data: `{"cpu":80}` })]), components));
    expect(posts).toEqual([]);
  });

  it("a frame that did not ask stays on screen while the new data is drawn behind it, then gives way", () => {
    const paints = holdPaints();
    const row = messageElement(message([card()]), components);
    document.body.append(row);
    const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    const page = frame.srcdoc;
    const fresh = messageElement(message([card({ data: `{"cpu":80}` })]), components);
    expect(keepFrames(row, fresh)).toBe(row);
    // Not reloaded, not emptied: the old drawing is what shows until the new one is ready.
    expect(frame.isConnected).toBe(true);
    expect(frame.srcdoc).toBe(page);
    const next = row.querySelector<HTMLIFrameElement>(".component-frame.incoming")!;
    expect(next.srcdoc).toContain(`{"cpu":80}`);
    // The same data again (its command ran and printed the same): nothing more to draw.
    keepFrames(row, messageElement(message([card({ data: `{"cpu":80}` })]), components));
    expect(row.querySelectorAll(".component-frame")).toHaveLength(2);
    expect(next.isConnected).toBe(true);
    // Newer data while it loads: it is replaced, the old drawing still on screen.
    keepFrames(row, messageElement(message([card({ data: `{"cpu":90}` })]), components));
    expect(next.isConnected).toBe(false);
    const newest = row.querySelector<HTMLIFrameElement>(".component-frame.incoming")!;
    expect(newest.srcdoc).toContain(`{"cpu":90}`);
    expect(frame.isConnected).toBe(true);
    newest.dispatchEvent(new Event("load"));
    expect(frame.isConnected).toBe(true);
    paints.paint();
    expect([...row.querySelectorAll(".component-frame")]).toEqual([newest]);
    expect(newest.classList.contains("incoming")).toBe(false);
  });

  it("a component's own element keeps track of what it shows", () => {
    const element = componentElement("cpu", components.cpu, `{"cpu":1}`, null, "k");
    expect(element?.querySelector("iframe")).not.toBeNull();
  });
});

describe("a live Board tile", () => {
  it("keeps its tile and frame when only its data changes, with fresh controls", () => {
    document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
    const area = new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
    const pin = (data: string): PinView => ({ id: "P1", name: "cpu", headline: "", chip: { text: "", tone: "neutral" }, size: "2x2", refresh: "manual", minutes: 15, display: card({ data, every: null }) });
    const state = (data: string) => ({ botID: "b", botName: "B", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components, pins: [pin(data)], pinChoices: [], board: true }) as ChatState;
    area.update(state(`{"cpu":1}`));
    const tile = document.querySelector<HTMLElement>(".board-card")!;
    const frame = tile.querySelector<HTMLIFrameElement>(".component-frame")!;
    const posts: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => { posts.push(data); });
    say(frame, { ccb: "live" });
    area.update(state(`{"cpu":2}`));
    expect(document.querySelector(".board-card")).toBe(tile);
    expect(tile.querySelector(".component-frame")).toBe(frame);
    expect(posts).toContainEqual({ ccbData: `{"cpu":2}` });
    expect(tile.querySelectorAll(".board-card-tools")).toHaveLength(1);
    expect(tile.querySelectorAll(".board-card-body")).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("a Board tile, a pinned panel and a floating card that do not take live data", () => {
  const pin = (data: string, extra: Partial<PinView> = {}): PinView => ({ id: "P1", name: "cpu", headline: "", chip: { text: "", tone: "neutral" }, size: "2x2", refresh: "manual", minutes: 15, display: card({ data, every: null }), ...extra });
  const state = (data: string, extra: Partial<ChatState> = {}) => ({ botID: "b", botName: "B", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components, pins: [pin(data)], pinChoices: [], board: true, ...extra }) as ChatState;
  /** Counts every srcdoc `frame` is given from here on. */
  function watch(frame: HTMLIFrameElement): { count: number } {
    const counter = { count: 0 };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
    Object.defineProperty(frame, "srcdoc", {
      configurable: true,
      get() { return descriptor.get!.call(this); },
      set(value: string) { counter.count++; descriptor.set!.call(this, value); },
    });
    return counter;
  }
  /** After new data: the shown frame is the same, never given a page again, still in the page. */
  function staysUntilDrawn(holder: () => HTMLElement, frame: HTMLIFrameElement, count: { count: number }, paints: { paint: () => void }) {
    expect(frame.isConnected).toBe(true);
    expect(holder().contains(frame)).toBe(true);
    expect(count.count).toBe(0);
    const next = holder().querySelector<HTMLIFrameElement>(".component-frame.incoming")!;
    expect(next.srcdoc).toContain(`{"cpu":2}`);
    next.dispatchEvent(new Event("load"));
    expect(frame.isConnected).toBe(true);
    paints.paint();
    expect([...holder().querySelectorAll(".component-frame")]).toEqual([next]);
  }

  beforeEach(() => {
    document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
  });

  it("a Board tile keeps its tile and drawing until the new data is drawn", () => {
    const paints = holdPaints();
    const area = new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
    area.update(state(`{"cpu":1}`));
    const tile = document.querySelector<HTMLElement>(".board-card")!;
    const frame = tile.querySelector<HTMLIFrameElement>(".component-frame")!;
    const count = watch(frame);
    area.update(state(`{"cpu":2}`));
    expect(document.querySelector(".board-card")).toBe(tile);
    staysUntilDrawn(() => document.querySelector<HTMLElement>(".board-card")!, frame, count, paints);
  });

  it("an opened pin keeps its drawing until the new data is drawn", () => {
    const paints = holdPaints();
    const area = new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
    area.update(state(`{"cpu":1}`, { board: false }));
    document.querySelector<HTMLElement>(".pin-chip:not(.add)")!.click();
    const sheet = () => document.querySelector<HTMLElement>(".pin-sheet")!;
    const frame = sheet().querySelector<HTMLIFrameElement>(".component-frame")!;
    const count = watch(frame);
    area.update(state(`{"cpu":2}`, { board: false }));
    staysUntilDrawn(sheet, frame, count, paints);
  });

  it("a floating card keeps its drawing until the new data is drawn", () => {
    const paints = holdPaints();
    const layer = new FloatLayer(document.body);
    const floating = (data: string) => ({ floating: [{ botID: "b", botName: "B", pin: pin(data, { float: { corner: "topRight", width: 280, height: 160, collapsed: false }, floatMenu: "stop" }) }], board: false });
    layer.update(state(`{"cpu":1}`, floating(`{"cpu":1}`)));
    const body = () => document.querySelector<HTMLElement>(".float-card")!;
    const frame = body().querySelector<HTMLIFrameElement>(".component-frame")!;
    const count = watch(frame);
    layer.update(state(`{"cpu":2}`, floating(`{"cpu":2}`)));
    staysUntilDrawn(body, frame, count, paints);
  });
});

describe("a card that refreshes by itself", () => {
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    // No live card left from before: its timer (a real one) stops.
    refreshDueCards();
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A chat with a card in it, on screen unless `top` puts it below the window. */
  function draw(display: DisplayView, top = 10): HTMLElement {
    const row = messageElement(message([display]), components);
    document.body.append(row);
    const cardElement = row.querySelector<HTMLElement>(".command-card")!;
    cardElement.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON() {} }) as DOMRect;
    return row;
  }

  const runs = () => sent.filter((action) => action.type === "componentCommand");

  it("runs again every few seconds while on screen", () => {
    draw(card());
    vi.advanceTimersByTime(1500);
    expect(runs()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(runs()).toEqual([{ type: "componentCommand", messageID: "m1", index: 0, command: "top -l 1", folder: "/p", force: true, live: true }]);
    // Not again before its time.
    vi.advanceTimersByTime(1000);
    expect(runs()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(runs()).toHaveLength(2);
  });

  it("pauses while the window is hidden or the card is scrolled away", () => {
    hidden = true;
    const row = draw(card());
    vi.advanceTimersByTime(5000);
    expect(runs()).toEqual([]);
    hidden = false;
    vi.advanceTimersByTime(500);
    expect(runs()).toHaveLength(1);

    sent.length = 0;
    row.remove();
    draw(card(), 5000);
    vi.advanceTimersByTime(5000);
    expect(runs()).toEqual([]);
  });

  it("only cards that have an interval and have run", () => {
    draw(card({ every: null }));
    draw(card({ status: "running" }));
    draw(card({ status: "approve" }));
    vi.advanceTimersByTime(10000);
    expect(runs()).toEqual([]);
    expect(refreshDueCards()).toBe(0);
  });

  it("a pin's Board tile too", () => {
    document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
    const area = new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
    const pin: PinView = { id: "P1", name: "cpu", headline: "", chip: { text: "", tone: "neutral" }, size: "2x2", refresh: "manual", minutes: 15, display: card() };
    area.update({ botID: "b", botName: "B", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components, pins: [pin], pinChoices: [], board: true } as ChatState);
    const tile = document.querySelector<HTMLElement>(".board-card .command-card")!;
    tile.getBoundingClientRect = () => ({ top: 10, bottom: 110, left: 0, right: 300, width: 300, height: 100, x: 0, y: 10, toJSON() {} }) as DOMRect;
    sent.length = 0;
    vi.advanceTimersByTime(2500);
    expect(sent).toContainEqual({ type: "pinCommand", id: "P1", command: "top -l 1", folder: "/p", force: true, live: true });
  });
});
