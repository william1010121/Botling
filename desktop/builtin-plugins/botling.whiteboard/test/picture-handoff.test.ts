// @vitest-environment jsdom
// A bot's picture on its Running card must not flicker (the invariant: no flash, no blank frame, no jump in size):
//  - new data for a frame that takes live data (`ccb.onData`, announced with { ccb: "live" }) goes to the frame it has;
//  - a picture that needs a new page keeps the old frame on screen until the new one has loaded and painted (two animation
//    frames), then swaps; a late answer for an older request is dropped;
//  - the tile keeps its size all along (its box is the CSS class of its size, drawn with or without a frame);
//  - the running lane keeps its cards where they are in the page when their order changes (CSS `order` moves them on screen;
//    moving an iframe in the page would load it again), and the cap on drawn pictures keeps the bots already drawn.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPictured } from "../src/board";
import { Whiteboard, type BoardApi } from "../src/ui";
import type { BoardView, Bot, Entry, Picture } from "../src/types";
import { board, bot, empty } from "./fixtures";

const display = (extra: Partial<Picture> = {}): Picture => ({ name: "status", data: '{"ok":true}', size: "1x1", command: null, folder: null, status: null, error: null, ranAt: null, ...extra });
const runner = (n: number, at: number): Bot => bot(n, `Bot ${n}`, "bot", { working: true, lastActivity: new Date(at).toISOString() });
const calm = { items: [], doing: {} };

interface Tile { spec: Parameters<BoardApi["tile"]>[0]; url: string; answer: (url?: string) => void }
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let view: BoardView;
let tiles: Tile[];
let manual: boolean;
let failing: boolean;
let n: number;

const api: BoardApi = {
  board: async (since) => (since !== undefined && since === view.stamp ? { ...view, same: true, bots: [], entries: [] } : view),
  ignore: async () => {}, send: async () => {}, openChat: () => {}, openResult: () => {}, approve: async () => ({ allowed: false }), run: async () => {},
  setShelf: () => {}, onError: () => {},
  tile: (spec) => new Promise<string>((resolve, reject) => {
    if (failing) return reject(new Error("no page"));
    const url = `botling-card://page/${++n}`;
    tiles.push({ spec, url, answer: (own) => resolve(own ?? url) });
    if (!manual) resolve(url);
  }),
};
const show = (list: Bot[], data: Entry[], stamp: string) => { view = board([bot(2, "Main bot", "main"), ...list], data, calm, { stamp }); };
const frames = () => [...host.querySelectorAll<HTMLIFrameElement>("iframe.wb-picture-frame")];
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const flush = () => advance(0);
const painted = async (frame: HTMLIFrameElement) => { await act(async () => { frame.dispatchEvent(new Event("load")); }); await advance(40); };
const announce = (frame: HTMLIFrameElement) => act(async () => {
  window.dispatchEvent(new MessageEvent("message", { data: { ccb: "live" }, source: frame.contentWindow }));
});
const poll = () => advance(1000);

beforeEach(async () => {
  vi.useFakeTimers();
  tiles = []; manual = false; failing = false; n = 0;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});
const mount = async () => { await act(async () => root.render(createElement(Whiteboard, { api, now: Date.now(), refreshMs: 1000 }))); await flush(); await flush(); };

const one = (picture: Picture, stamp: string) => show([runner(21, Date.now())], [empty("b21", { picture })], stamp);

describe("a picture's new data", () => {
  it("goes to the frame it has when that frame takes live data: same iframe, no new page, nothing hidden", async () => {
    one(display(), "a");
    await mount();
    const [first] = frames();
    expect(first).toBeDefined();
    await announce(first!);
    const posted = vi.spyOn(first!.contentWindow!, "postMessage");
    one(display({ data: '{"ok":false}' }), "b");
    await poll();
    expect(frames()).toEqual([first]);
    expect(tiles).toHaveLength(1);
    expect(posted).toHaveBeenCalledWith({ ccbData: '{"ok":false}' }, "*");
    expect(first!.style.visibility).not.toBe("hidden");
  });

  it("sends the data it was last given only once: a poll with the same data posts nothing", async () => {
    one(display(), "a");
    await mount();
    const [first] = frames();
    await announce(first!);
    const posted = vi.spyOn(first!.contentWindow!, "postMessage");
    one(display(), "b"); // a new stamp, the picture itself unchanged
    await poll();
    expect(posted).not.toHaveBeenCalled();
    expect(tiles).toHaveLength(1);
  });

  it("a frame that has not said it takes live data keeps its place until the new page has loaded and painted", async () => {
    one(display(), "a");
    await mount();
    const [first] = frames();
    const box = host.querySelector(".wb-picture")!;
    one(display({ data: '{"ok":false}' }), "b");
    await poll();
    // the new page is loading out of sight beside the shown one
    expect(tiles).toHaveLength(2);
    expect(frames()).toHaveLength(2);
    expect(frames()[0]).toBe(first);
    expect(first!.isConnected).toBe(true);
    expect(first!.style.visibility).not.toBe("hidden");
    const next = frames()[1]!;
    expect(next.getAttribute("src")).toBe(tiles[1]!.url);
    expect(next.style.visibility).toBe("hidden");
    await advance(5000); // a slow load: the old picture stays
    expect(first!.isConnected).toBe(true);
    expect(frames()).toHaveLength(2);
    await act(async () => { next.dispatchEvent(new Event("load")); });
    expect(first!.isConnected).toBe(true); // loaded is not yet painted
    await advance(40);
    expect(frames()).toEqual([next]);
    expect(next.style.visibility).not.toBe("hidden");
    expect(host.querySelector(".wb-picture")).toBe(box); // the tile's box is never rebuilt
    expect(box.className).toContain("wb-picture-1x1");
  });

  it("drops the answer of an older request that comes after a newer one", async () => {
    one(display(), "a");
    await mount();
    manual = true;
    one(display({ data: '{"v":2}' }), "b");
    await poll();
    one(display({ data: '{"v":3}' }), "c");
    await poll();
    expect(tiles).toHaveLength(3);
    await act(async () => { tiles[2]!.answer(); });
    await act(async () => { tiles[1]!.answer(); }); // late, for data that is no longer wanted
    await flush();
    const list = frames();
    const loading = list.filter((frame) => frame.style.visibility === "hidden");
    expect(loading.map((frame) => frame.getAttribute("src"))).toEqual([tiles[2]!.url]);
    await painted(loading[0]!);
    expect(frames().map((frame) => frame.getAttribute("src"))).toEqual([tiles[2]!.url]);
  });

  it("a picture that fails to be asked for leaves the one shown where it is", async () => {
    one(display(), "a");
    await mount();
    const [first] = frames();
    failing = true;
    one(display({ data: '{"ok":false}' }), "b");
    await poll();
    expect(frames()).toEqual([first]);
    expect(first!.style.visibility).not.toBe("hidden");
  });
});

describe("the running lane", () => {
  const four = (order: number[], stamp: string) => show(
    order.map((k, at) => runner(k, 1_000_000 - at * 1000)),
    order.map((k) => empty(`b${k}`, { picture: display({ data: `{"k":${k}}` }) })),
    stamp,
  );
  it("keeps every card, and so its iframe, where it is in the page when the order changes; only their place on screen moves", async () => {
    four([21, 22, 23, 24], "a");
    await mount();
    const card = (k: number) => host.querySelector<HTMLElement>(`.lane-running .wb-card[data-bot="b${k}"]`)!;
    const before = [21, 22, 23, 24].map((k) => card(k).querySelector("iframe"));
    expect(before.every(Boolean)).toBe(true);
    const moved: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (node instanceof Element && (node.matches(".wb-card") || node.querySelector("iframe"))) moved.push((node as HTMLElement).dataset.bot ?? node.className);
    });
    watch.observe(host, { childList: true, subtree: true });
    four([24, 23, 22, 21], "b"); // the most recent first now: the reverse order
    await poll();
    watch.disconnect();
    expect(moved).toEqual([]);
    expect([21, 22, 23, 24].map((k) => card(k).querySelector("iframe"))).toEqual(before);
    // on screen, the first in the order comes first
    const order = (k: number) => Number(card(k).style.order);
    expect([24, 23, 22, 21].map(order)).toEqual([0, 1, 2, 3]);
  });
});

describe("the cap on drawn pictures", () => {
  it("keeps the bots already drawn, then fills the room in the lane's order", () => {
    expect([...keepPictured(new Set(["c"]), ["a", "b", "c", "d"], 2)]).toEqual(["c", "a"]);
    expect([...keepPictured(new Set(), ["a", "b", "c"], 2)]).toEqual(["a", "b"]);
    expect([...keepPictured(new Set(["x", "a"]), ["a", "b"], 2)]).toEqual(["a", "b"]); // x has no picture any more
    expect([...keepPictured(new Set(["a", "b", "c"]), ["c", "b", "a"], 2)]).toEqual(["c", "b"]); // over the cap: the lane's order decides
  });
});
