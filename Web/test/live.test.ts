/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { componentElement, componentPage, keepFrames, liveCardCount, offscreenRecheck, redrawWait, refreshDueCards } from "../src/components";
import { messageElement } from "../src/messages";
import type { ChatState, ComponentInfo, DisplayView, MessageView } from "../src/types";

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

/** The frames of `root` that are still drawing behind another. (Not a selector: jsdom's `querySelector` answers a stale element once the class has moved from one frame to the next.) */
const incomingFrames = (root: ParentNode): HTMLIFrameElement[] => [...root.querySelectorAll<HTMLIFrameElement>(".component-frame")].filter((frame) => frame.classList.contains("incoming"));

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
    const next = incomingFrames(row)[0];
    expect(next.srcdoc).toContain(`{"cpu":80}`);
    // The same data again (its command ran and printed the same): nothing more to draw.
    keepFrames(row, messageElement(message([card({ data: `{"cpu":80}` })]), components));
    expect(row.querySelectorAll(".component-frame")).toHaveLength(2);
    expect(next.isConnected).toBe(true);
    // Newer data while it loads: the page on its way is not thrown away (a page slower than the refresh would never show); the newest waits behind it.
    keepFrames(row, messageElement(message([card({ data: `{"cpu":90}` })]), components));
    keepFrames(row, messageElement(message([card({ data: `{"cpu":95}` })]), components));
    expect(next.isConnected).toBe(true);
    expect(incomingFrames(row)).toHaveLength(1);
    expect(frame.isConnected).toBe(true);
    next.dispatchEvent(new Event("load"));
    paints.paint();
    expect(frame.isConnected).toBe(true);
    say(next, { ccb: "ready", height: 90 });
    expect(frame.isConnected).toBe(true);
    paints.paint();
    // It took the place; only the newest of what came meanwhile is drawn now, behind it.
    expect(frame.isConnected).toBe(false);
    expect(next.classList.contains("incoming")).toBe(false);
    const newest = incomingFrames(row)[0];
    expect(newest.srcdoc).toContain(`{"cpu":95}`);
    say(newest, { ccb: "ready", height: 90 });
    paints.paint();
    expect([...row.querySelectorAll(".component-frame")]).toEqual([newest]);
    expect(newest.classList.contains("incoming")).toBe(false);
  });

  it("a component's own element keeps track of what it shows", () => {
    const element = componentElement("cpu", components.cpu, `{"cpu":1}`, null, "k");
    expect(element?.querySelector("iframe")).not.toBeNull();
  });
});



describe("a card given a new page keeps its old picture until the new one is ready", () => {
  const v2: Record<string, ComponentInfo> = { cpu: { template: "<pre>v2</pre>", version: 2, working: false, updated: false, hasPrevious: false } };
  const still = (overrides: Partial<DisplayView> = {}) => card({ every: null, ...overrides });
  const framesOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLIFrameElement>(".component-frame")];
  const incomingOf = (row: HTMLElement) => incomingFrames(row)[0];
  const ready = (frame: HTMLIFrameElement, height: number) => say(frame, { ccb: "ready", height });
  afterEach(() => vi.useRealTimers());

  /** A card on the page whose frame measured 120px. */
  function shownCard(display = still(), info = components): { row: HTMLElement; frame: HTMLIFrameElement } {
    const row = messageElement(message([display]), info);
    document.body.append(row);
    const frame = framesOf(row)[0];
    say(frame, { ccb: "size", height: 120 });
    return { row, frame };
  }
  /** Brings the row up to a redraw with `display` and `info`, as the chat does. */
  const redraw = (row: HTMLElement, display: DisplayView, info = components) => keepFrames(row, messageElement(message([display]), info));

  const changes: [string, DisplayView, DisplayView, Record<string, ComponentInfo>][] = [
    ["its template and version change", still(), still(), v2],
    ["its picture map changes", still({ images: { "/a.png": "ccb-preview:1" } }), still({ images: { "/a.png": "ccb-preview:2" } }), components],
    ["only its data changes", still(), still({ data: `{"cpu":50}` }), components],
  ];
  for (const [what, from, to, info] of changes) {
    it(`when ${what}: the old frame stays, as tall as it was, until the new page says it is ready`, () => {
      const paints = holdPaints();
      const { row, frame } = shownCard(from);
      const page = frame.srcdoc;
      expect(redraw(row, to, info)).toBe(row);
      const next = incomingOf(row);
      expect(next).not.toBeNull();
      expect(framesOf(row)).toEqual([frame, next]);
      expect(frame.srcdoc).toBe(page);
      // Invisible, not hidden, so nothing in it can be reached meanwhile: not by the pointer, not by Tab, not by a screen reader.
      expect(next.hasAttribute("inert")).toBe(true);
      expect(next.tabIndex).toBe(-1);
      expect(next.getAttribute("aria-hidden")).toBe("true");
      // The empty page a frame starts with loads (a `load` event); the new page measures; the clock runs: none of it is ready.
      next.dispatchEvent(new Event("load"));
      say(next, { ccb: "size", height: 40 });
      paints.paint();
      expect(framesOf(row)).toEqual([frame, next]);
      expect(frame.style.height).toBe("120px");
      expect(next.style.getPropertyValue("height")).toBe("120px");
      // Ready: painted, decoded, sized. Not before the window paints once more.
      ready(next, 40);
      expect(framesOf(row)).toEqual([frame, next]);
      paints.paint();
      expect(framesOf(row)).toEqual([next]);
      expect(next.classList.contains("incoming")).toBe(false);
      expect(next.style.position).toBe("");
      expect(next.style.height).toBe("40px");
      expect(next.getAttribute("aria-hidden")).toBeNull();
      expect(next.hasAttribute("inert")).toBe(false);
      expect(next.hasAttribute("tabindex")).toBe(false);
    });
  }

  it("does not show a page that is slow: past the old two seconds it waits, and past its wait it is given up, the old picture staying; what waited behind it is drawn then, and the next redraw asks again", () => {
    const paints = holdPaints();
    // Only the clock: the held animation frames stay the test's own.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { row, frame } = shownCard();
    // A page on its way, and another page asked for meanwhile: it waits.
    redraw(row, still({ data: `{"cpu":20}` }));
    const first = incomingOf(row);
    redraw(row, still(), v2);
    vi.advanceTimersByTime(2500);
    paints.paint();
    expect(framesOf(row)).toEqual([frame, first]);
    expect(frame.style.height).toBe("120px");
    // The first is given up: the old picture stays, and the one that waited is drawn now (with its own wait).
    vi.advanceTimersByTime(redrawWait);
    expect(first.isConnected).toBe(false);
    const second = incomingOf(row);
    expect(framesOf(row)).toEqual([frame, second]);
    expect(second.srcdoc).toContain("v2");
    expect(frame.style.height).toBe("120px");
    // Its late word is nobody's now.
    ready(first, 40);
    paints.paint();
    expect(framesOf(row)).toEqual([frame, second]);
    vi.advanceTimersByTime(redrawWait);
    expect(framesOf(row)).toEqual([frame]);
    expect(frame.style.height).toBe("120px");
    // The frame is what it was drawn from before either, so a redraw with the first of them asks for its page again.
    redraw(row, still({ data: `{"cpu":20}` }));
    const again = incomingOf(row);
    expect(again.srcdoc).toContain(`{"cpu":20}`);
    expect(again).not.toBe(first);
    ready(again, 60);
    paints.paint();
    expect(framesOf(row)).toEqual([again]);
  });

  it("a page given up once is asked for again, for the same data, without waiting for its pictures; other data waits for them as before", () => {
    const paints = holdPaints();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { row, frame } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    const first = incomingOf(row);
    expect(first.srcdoc).toContain("image.decode");
    vi.advanceTimersByTime(redrawWait);
    expect(framesOf(row)).toEqual([frame]);
    // The same data again: its page no longer waits for pictures to decode (the one that never did), and it takes the place.
    redraw(row, still({ data: `{"cpu":20}` }));
    const quick = incomingOf(row);
    expect(quick.srcdoc).toContain(`{"cpu":20}`);
    expect(quick.srcdoc).toContain("ccb: 'ready'");
    expect(quick.srcdoc).not.toContain("image.decode");
    ready(quick, 70);
    paints.paint();
    expect(framesOf(row)).toEqual([quick]);
    // Other data, on a frame that gave up on something else, is waited for in full.
    redraw(row, still({ data: `{"cpu":30}` }));
    expect(incomingOf(row).srcdoc).toContain("image.decode");
  });

  it("a page that says it is ready with no height (an empty card) takes the place and the shell keeps the height it has", () => {
    const paints = holdPaints();
    const { row, frame } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    const next = incomingOf(row);
    ready(next, 0);
    paints.paint();
    expect(framesOf(row)).toEqual([next]);
    expect(frame.isConnected).toBe(false);
    expect(next.classList.contains("incoming")).toBe(false);
    expect(next.style.position).toBe("");
    expect(next.style.height).toBe("120px");
    // Nor is 0 remembered: a card drawn anew starts as tall as before.
    expect(framesOf(messageElement(message([still()]), components))[0].style.height).toBe("120px");
  });

  it("a frame that takes live data is not sent data while a new page is being drawn behind it; the data waits behind that page and is drawn once it is shown", () => {
    const paints = holdPaints();
    const { row, frame } = shownCard();
    const posts: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => { posts.push(data); });
    say(frame, { ccb: "live" });
    // Its page changes: drawn behind it (live data cannot carry a new template).
    redraw(row, still(), v2);
    const next = incomingOf(row);
    // The template is back, with new data: the shown frame is not told it, and the page on its way is not thrown away.
    redraw(row, still({ data: `{"cpu":80}` }));
    expect(posts).toEqual([]);
    expect(next.isConnected).toBe(true);
    ready(next, 100);
    paints.paint();
    expect(framesOf(row)).toHaveLength(2);
    const latest = incomingOf(row);
    expect(latest.srcdoc).toContain(`{"cpu":80}`);
    expect(latest.srcdoc).not.toContain("v2");
    ready(latest, 120);
    paints.paint();
    expect(framesOf(row)).toEqual([latest]);
  });

  it("success A, then a failure, then success B: one frame on screen all along, never shorter, the failure said where the bar says it", () => {
    const paints = holdPaints();
    const { row, frame } = shownCard();
    const heights: number[] = [];
    const check = () => {
      const onScreen = framesOf(row).filter((one) => !one.classList.contains("incoming"));
      expect(onScreen).toHaveLength(1);
      expect(row.querySelector(".command-error, .command-waiting")).toBeNull();
      heights.push(parseFloat(onScreen[0].style.height));
      return onScreen[0];
    };
    expect(check()).toBe(frame);
    const srcdoc = frame.srcdoc;
    // Failed: the core keeps the last data, so the same drawing stays and the bar says why.
    redraw(row, still({ status: "failed", error: "The command failed (exit code 2).", ranAt: "10:43" }));
    expect(check()).toBe(frame);
    expect(frame.srcdoc).toBe(srcdoc);
    expect(framesOf(row)).toEqual([frame]);
    const note = row.querySelector<HTMLElement>(".command-when.failed")!;
    expect(note.textContent).toContain("Failed");
    expect(note.title).toBe("The command failed (exit code 2).");
    // Running again with the data still there, then new data: behind the old drawing.
    redraw(row, still({ status: "running", data: `{"cpu":10}` }));
    expect(check()).toBe(frame);
    redraw(row, still({ data: `{"cpu":50}` }));
    expect(check()).toBe(frame);
    expect(row.querySelector(".command-when.failed")).toBeNull();
    const next = incomingOf(row);
    ready(next, 120);
    paints.paint();
    expect(framesOf(row)).toEqual([next]);
    expect(next.srcdoc).toContain(`{"cpu":50}`);
    expect(check()).toBe(next);
    expect(Math.min(...heights)).toBe(120);
  });

  it("a failure with no data to keep is still the error card", () => {
    const row = messageElement(message([still({ status: "failed", data: "null", error: "boom" })]), components);
    expect(row.querySelector(".command-error")?.textContent).toContain("boom");
    expect(framesOf(row)).toEqual([]);
  });

  it("A, B, then C and D: B on its way is not dropped, only the newest of C and D waits, and B and then D take the place", () => {
    const paints = holdPaints();
    const { row, frame } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    const b = incomingOf(row);
    redraw(row, still({ data: `{"cpu":30}` }));
    redraw(row, still({ data: `{"cpu":40}` }));
    expect(framesOf(row)).toEqual([frame, b]);
    // Not shown before B says it is ready.
    paints.paint();
    expect(framesOf(row)).toEqual([frame, b]);
    expect(frame.style.height).toBe("120px");
    ready(b, 200);
    paints.paint();
    expect(frame.isConnected).toBe(false);
    expect(b.style.height).toBe("200px");
    // D (the newest) is drawn behind B; C was never drawn.
    const d = incomingOf(row);
    expect(framesOf(row)).toEqual([b, d]);
    expect(d.srcdoc).toContain(`{"cpu":40}`);
    expect(b.style.getPropertyValue("height")).toBe("200px");
    ready(d, 130);
    paints.paint();
    expect(framesOf(row)).toEqual([d]);
    expect(d.style.height).toBe("130px");
    // Nothing more is waiting: the same data again draws nothing.
    redraw(row, still({ data: `{"cpu":40}` }));
    expect(framesOf(row)).toEqual([d]);
  });

  it("a drawing behind the shown frame writes neither the visible height nor the remembered one", () => {
    const paints = holdPaints();
    const { row, frame } = shownCard();
    redraw(row, still(), v2);
    const next = incomingOf(row);
    say(next, { ccb: "size", height: 300 });
    expect(frame.style.height).toBe("120px");
    // A card drawn anew meanwhile starts at what the shown one has, not at what the preparing one measured.
    expect(framesOf(messageElement(message([still()]), components))[0].style.height).toBe("120px");
    ready(next, 300);
    paints.paint();
    expect(framesOf(messageElement(message([still()]), components))[0].style.height).toBe("300px");
  });

  it("a frame's first drawing takes the place of a waiting box that was as tall as the card was last time", () => {
    shownCard();
    const waiting = messageElement(message([still({ status: "running", data: "null" })]), components);
    expect(waiting.querySelector<HTMLElement>(".command-waiting")!.style.minHeight).toBe("120px");
    const unseen = messageElement({ ...message([still({ status: "running", data: "null" })]), id: "never-drawn" }, components);
    expect(unseen.querySelector<HTMLElement>(".command-waiting")!.style.minHeight).toBe("");
    // Its data comes: no frame to keep, and the new one starts at the remembered height.
    const done = messageElement(message([still()]), components);
    expect(framesOf(done)[0].style.height).toBe("120px");
  });

  it("a ready that comes from a frame nobody is waiting for changes nothing", () => {
    const { frame } = shownCard();
    ready(frame, 50);
    expect(frame.style.height).toBe("120px");
  });

  it("a page made for a frame that is handed over to says when it is ready; any other page is what it was", () => {
    const page = componentPage("<p>x</p>", "null", {}, "2x2", "chat", false, false, true);
    expect(page).toContain("ccb: 'ready'");
    expect(componentPage("<p>x</p>", "null")).not.toContain("ccb: 'ready'");
    const { frame } = shownCard();
    expect(frame.srcdoc).toContain("ccb: 'ready'");
    // Rebuilt (tokens came while it waited), it still says it.
    expect((frame as unknown as { ccbBuild: () => string }).ccbBuild()).toContain("ccb: 'ready'");
  });

  it("the waiting box of a card that is not the message's first is as tall as that card was", () => {
    const row = messageElement(message([still(), still()]), components);
    document.body.append(row);
    const [first, second] = framesOf(row);
    say(first, { ccb: "size", height: 120 });
    say(second, { ccb: "size", height: 80 });
    const waiting = messageElement(message([still(), still({ status: "running", data: "null" })]), components);
    const boxes = waiting.querySelectorAll<HTMLElement>(".command-waiting");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].style.minHeight).toBe("80px");
  });

  it("a ready whose height is not a number, or is below 0, is not a ready", () => {
    const paints = holdPaints();
    const { row } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    const next = incomingOf(row);
    for (const height of [-5, "90", null, Number.NaN, Infinity]) ready(next, height as number);
    paints.paint();
    expect(framesOf(row)).toHaveLength(2);
    ready(next, 90);
    paints.paint();
    expect(framesOf(row)).toEqual([next]);
  });

  it("a drawing on its way that is no longer in the page is replaced, and the frame still remembers what it was drawn from before", () => {
    holdPaints();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { row, frame } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    const lost = incomingOf(row);
    lost.remove();
    vi.advanceTimersByTime(redrawWait / 2);
    redraw(row, still({ data: `{"cpu":30}` }));
    const next = incomingOf(row);
    expect(next).not.toBe(lost);
    expect(next.srcdoc).toContain(`{"cpu":30}`);
    // The lost one's own wait ends: that is nobody's business now, the one that took its place keeps its wait.
    vi.advanceTimersByTime(redrawWait / 2 + 1);
    expect(framesOf(row)).toEqual([frame, next]);
    vi.advanceTimersByTime(redrawWait / 2);
    expect(framesOf(row)).toEqual([frame]);
    // Both given up: the frame is what it was drawn from at the start, so that data again draws nothing.
    redraw(row, still());
    expect(framesOf(row)).toEqual([frame]);
  });

  it("the wait of a drawing that was replaced ends without touching the one that replaced it, which can still be shown", () => {
    const paints = holdPaints();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { row } = shownCard();
    redraw(row, still({ data: `{"cpu":20}` }));
    incomingOf(row).remove();
    vi.advanceTimersByTime(redrawWait / 2);
    redraw(row, still({ data: `{"cpu":30}` }));
    const next = incomingOf(row);
    // The lost one's wait is over now; the newer one is still being drawn and takes the place when it says it is ready.
    vi.advanceTimersByTime(redrawWait / 2 + 1);
    ready(next, 60);
    paints.paint();
    expect(framesOf(row)).toEqual([next]);
    expect(next.srcdoc).toContain(`{"cpu":30}`);
  });

  describe("the ready script of a page", () => {
    type Fake = { quick?: boolean; readyState?: string; height?: () => number; images?: { decode?: () => Promise<void> }[]; fonts?: { ready: Promise<unknown> } };
    /** Runs the ready script of a page against a fake document and window; its animation frames and timers are the test's. */
    function runReady(fake: Fake = {}) {
      const page = componentPage("<p>x</p>", "null", {}, "2x2", "chat", false, false, fake.quick ? "quick" : true);
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((one) => one[1]);
      const posted: unknown[] = [];
      const rafs: (() => void)[] = [];
      const timers: (() => void)[] = [];
      let requested = 0;
      let onLoad: (() => void) | null = null;
      const doc = {
        readyState: fake.readyState ?? "complete",
        fonts: fake.fonts,
        images: fake.images ?? [],
        getElementById: () => ({ getBoundingClientRect: () => ({ height: (fake.height ?? (() => 40.2))() }) }),
      };
      const win = { addEventListener: (type: string, listener: () => void) => { if (type === "load") onLoad = listener; } };
      const raf = (callback: () => void) => { requested++; rafs.push(callback); return requested; };
      const later = (callback: () => void) => { timers.push(callback); return 0; };
      new Function("document", "window", "parent", "requestAnimationFrame", "setTimeout", scripts[scripts.length - 1])(doc, win, { postMessage: (data: unknown) => posted.push(data) }, raf, later);
      const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
      return {
        posted, settled,
        requested: () => requested,
        load: () => onLoad?.(),
        /** The window paints one frame. */
        frame: async () => { rafs.splice(0).forEach((callback) => callback()); await settled(); },
        /** A window that paints nothing: only the clock runs. */
        clock: async () => { timers.splice(0).forEach((callback) => callback()); await settled(); },
      };
    }

    it("says it is ready once, with its height, after two painted frames", async () => {
      const run = runReady();
      await run.settled();
      expect(run.posted).toEqual([]);
      await run.frame();
      expect(run.posted).toEqual([]);
      await run.frame();
      expect(run.posted).toEqual([{ ccb: "ready", height: 41 }]);
      await run.frame();
      await run.frame();
      expect(run.posted).toHaveLength(1);
    });

    it("waits for the page to load: the empty page a frame starts with is not ready", async () => {
      const run = runReady({ readyState: "loading" });
      for (let i = 0; i < 4; i++) await run.frame();
      expect(run.posted).toEqual([]);
      run.load();
      await run.settled();
      await run.frame();
      await run.frame();
      expect(run.posted).toHaveLength(1);
    });

    it("is not ready while a picture is being decoded or a font is loading; a picture that fails to decode does not hold it back", async () => {
      let decoded!: () => void;
      const run = runReady({ images: [{ decode: () => new Promise<void>((resolve) => { decoded = resolve; }) }], fonts: { ready: Promise.resolve() } });
      for (let i = 0; i < 5; i++) await run.frame();
      expect(run.posted).toEqual([]);
      decoded();
      await run.settled();
      await run.frame();
      await run.frame();
      expect(run.posted).toHaveLength(1);
      const broken = runReady({ images: [{ decode: () => Promise.reject(new Error("broken")) }] });
      await broken.settled();
      await broken.frame();
      await broken.frame();
      expect(broken.posted).toHaveLength(1);
      const font = runReady({ fonts: { ready: new Promise(() => {}) } });
      for (let i = 0; i < 5; i++) await font.frame();
      expect(font.posted).toEqual([]);
    });

    it("a page with nothing in it is ready too, with height 0, after the same two painted frames", async () => {
      const run = runReady({ height: () => 0 });
      await run.settled();
      await run.frame();
      expect(run.posted).toEqual([]);
      await run.frame();
      expect(run.posted).toEqual([{ ccb: "ready", height: 0 }]);
      for (let i = 0; i < 5; i++) await run.frame();
      expect(run.posted).toHaveLength(1);
    });

    it("a page asked for again after one that never got ready does not wait for its pictures (a font still holds it)", async () => {
      const stuck = { decode: () => new Promise<void>(() => {}) };
      const quick = runReady({ images: [stuck], quick: true });
      await quick.settled();
      await quick.frame();
      await quick.frame();
      expect(quick.posted).toEqual([{ ccb: "ready", height: 41 }]);
      const full = runReady({ images: [stuck] });
      for (let i = 0; i < 5; i++) await full.frame();
      expect(full.posted).toEqual([]);
      const font = runReady({ quick: true, fonts: { ready: new Promise(() => {}) } });
      for (let i = 0; i < 5; i++) await font.frame();
      expect(font.posted).toEqual([]);
    });

    it("does not wait for a frame nobody paints (a window out of sight): a short timer stands in", async () => {
      const run = runReady();
      await run.settled();
      await run.clock();
      await run.clock();
      expect(run.posted).toEqual([{ ccb: "ready", height: 41 }]);
    });
  });
});

describe("a card that refreshes by itself", () => {
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    // No live card left from before (copies made and never put on the page are past their grace): its timer (a real one) stops.
    refreshDueCards(Date.now() + 60_000);
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

  it("is ticked from the cards it made, without looking through the page each time", () => {
    draw(card());
    const query = vi.spyOn(document, "querySelectorAll");
    vi.advanceTimersByTime(3000);
    expect(runs()).toHaveLength(1);
    expect(query.mock.calls.filter(([selector]) => String(selector).includes("command-card"))).toEqual([]);
  });

  it("measures a card that is due but out of view only now and then, and runs it soon after it comes into view", () => {
    const row = draw(card(), 5000);
    const element = row.querySelector<HTMLElement>(".command-card")!;
    let top = 5000;
    const measure = vi.fn(() => ({ top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON() {} }) as DOMRect);
    element.getBoundingClientRect = measure;
    vi.advanceTimersByTime(10_000);
    expect(runs()).toEqual([]);
    // Due from 2 s on: one look a second (not one per 250 ms tick) over the 8 s after it.
    expect(measure.mock.calls.length).toBeLessThanOrEqual(10);
    expect(measure.mock.calls.length).toBeGreaterThanOrEqual(5);
    top = 10;
    vi.advanceTimersByTime(offscreenRecheck + 250);
    expect(runs()).toHaveLength(1);
  });

  it("still runs a card a redraw kept, once per interval, and not for the redraw's copy that never reached the page", () => {
    const row = draw(card());
    const fresh = messageElement(message([card({ data: `{"cpu":80}` })]), components);
    expect(keepFrames(row, fresh)).toBe(row);
    vi.advanceTimersByTime(2250);
    expect(runs()).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(runs()).toHaveLength(2);
  });

  it("follows a card drawn again as a new element of the same message", () => {
    const first = draw(card());
    vi.advanceTimersByTime(1000);
    first.remove();
    draw(card());
    vi.advanceTimersByTime(2500);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ messageID: "m1", index: 0, live: true });
  });

  it("lets go of a copy that never reached the page, and of a card taken off it", () => {
    const row = draw(card());
    // A redraw's copy of a card it does not keep: made, never put on the page.
    messageElement(message([card({ data: `{"cpu":80}` })]), components);
    expect(liveCardCount()).toBe(2);
    vi.advanceTimersByTime(3000);
    expect(liveCardCount()).toBe(1);
    // Taken off the page while another card still holds the timer.
    const other = draw(card({ every: 5 }));
    other.querySelector<HTMLElement>(".command-card")!.dataset.liveKey = "other/0";
    row.remove();
    vi.advanceTimersByTime(500);
    expect(liveCardCount()).toBe(1);
  });

  it("waits for a card made a moment before it is put on the page, and runs it once it is there", () => {
    const row = messageElement(message([card()]), components);
    // Ticks pass while nothing is on the page yet: the card made is still waited for, within its grace.
    vi.advanceTimersByTime(750);
    expect(liveCardCount()).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    document.body.append(row);
    row.querySelector<HTMLElement>(".command-card")!.getBoundingClientRect = () => ({ top: 10, bottom: 110, left: 0, right: 300, width: 300, height: 100, x: 0, y: 10, toJSON() {} }) as DOMRect;
    vi.advanceTimersByTime(2500);
    expect(runs()).toHaveLength(1);
  });

  it("keeps what runs a card while its new element is made but not on the page yet (the old one taken off first)", () => {
    const first = draw(card());
    vi.advanceTimersByTime(300);
    first.remove();
    // The same message drawn anew: made now, put on the page a moment later.
    const again = messageElement(message([card()]), components);
    vi.advanceTimersByTime(250);
    document.body.append(again);
    again.querySelector<HTMLElement>(".command-card")!.getBoundingClientRect = () => ({ top: 10, bottom: 110, left: 0, right: 300, width: 300, height: 100, x: 0, y: 10, toJSON() {} }) as DOMRect;
    vi.advanceTimersByTime(2500);
    expect(runs()).toHaveLength(1);
  });

  it("counts a card's interval again from its new element once the old one is gone (nothing is left of its old count)", () => {
    // Another card keeps the timer going meanwhile.
    document.body.append(messageElement({ ...message([card({ every: 60 })]), id: "k1" }, components));
    const first = draw(card());
    vi.advanceTimersByTime(1000);
    first.remove();
    vi.advanceTimersByTime(500);
    // Without the forgotten count the new card would be overdue (its first count ended at 2.25 s) and run at once.
    draw(card());
    vi.advanceTimersByTime(1500);
    expect(runs()).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(runs()).toHaveLength(1);
  });

  it("stops its timer once no card is on the page, and starts it again for the next one", () => {
    const row = draw(card());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // One tick has seen it on the page; taken off, the next tick lets it go and the timer stops.
    vi.advanceTimersByTime(300);
    row.remove();
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(0);
    draw(card());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // A second card shares the one timer.
    draw(card({ every: 5 }));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2500);
    expect(runs()).toHaveLength(1);
  });

  it("only cards that have an interval and have run", () => {
    draw(card({ every: null }));
    draw(card({ status: "running" }));
    draw(card({ status: "approve" }));
    vi.advanceTimersByTime(10000);
    expect(runs()).toEqual([]);
    expect(refreshDueCards()).toBe(0);
  });

});
