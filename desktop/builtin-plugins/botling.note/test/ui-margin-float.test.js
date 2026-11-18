// @vitest-environment jsdom
// An opened side note (旁註) floats over the page (src/ui-margin.js floatFor / placeFloat / syncFloat, ui-margin-css.js `.nm-float`): it is a
// `position: fixed` card outside the note's flow, so it takes no room in the right column and moves nothing (no clear-and-redraw of the doc);
// it is at most as tall as the visible frame, ends above the bottom margin that keeps it clear of the app's floating status bar, keeps its
// header and action row in view while the answer scrolls, follows its pill, and closes on 收起, Esc and a press outside. jsdom has no layout:
// the geometry the code reads (rects, heights, window size) is stubbed here. Run through ui-margin-float-run.test.ts (vitest.config.mts only
// collects *.test.ts here). Mounted from source, headless: no window, no focus taken from the user.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/ui.js";
import { MARGIN_CSS } from "../src/ui-margin-css.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const VW = 1280;
let VH = 800;
let floatH = 2000; // what a long answer would measure
let pillRect = { left: 900, top: 300, width: 340, height: 36 };
const rect = (r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height, x: r.left, y: r.top, toJSON() {} });
const realRect = Element.prototype.getBoundingClientRect;
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
const realInner = [Object.getOwnPropertyDescriptor(window, "innerHeight"), Object.getOwnPropertyDescriptor(window, "innerWidth")];

beforeEach(() => {
  VH = 800;
  floatH = 2000;
  pillRect = { left: 900, top: 300, width: 340, height: 36 };
  Object.defineProperty(window, "innerHeight", { get: () => VH, configurable: true });
  Object.defineProperty(window, "innerWidth", { get: () => VW, configurable: true });
  Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("nm-folded")) return rect(pillRect);
    if (this.classList.contains("note")) return rect({ left: 0, top: 0, width: VW, height: VH }); // the frame
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { get() { return this.classList.contains("nm-float") ? floatH : this.classList.contains("nm-folded") ? 36 : 0; }, configurable: true });
  Object.defineProperty(Element.prototype, "clientWidth", { get() { return this.classList.contains("note-body") ? VW : 0; }, configurable: true }); // a wide frame: the margin column exists
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  try { localStorage.clear(); } catch {}
  vi.useFakeTimers();
});
let current = null;
afterEach(() => {
  current?.stop?.();
  current = null;
  Element.prototype.getBoundingClientRect = realRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight);
  Object.defineProperty(Element.prototype, "clientWidth", realClientWidth);
  if (realInner[0]) Object.defineProperty(window, "innerHeight", realInner[0]); else delete window.innerHeight;
  if (realInner[1]) Object.defineProperty(window, "innerWidth", realInner[1]); else delete window.innerWidth;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

const NOTE = "# Plan\n\nOld check: same tag means same build.\n<!-- cell -->\nsecond cell\n";
const LONG = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：很長的回答`).join("\n\n");
const thread = (over = {}) => ({
  id: "c-0001", anchor: { cell: "", label: "", kind: "text", scope: "selection", quote: "same tag means same build" },
  turns: [{ rid: "r0", q: "為什麼標籤一樣？", a: LONG, qAt: 1000, aAt: 2000, seenAt: 1500 }],
  folded: false, created: 1000, updated: 2000, answering: false, ...over,
});
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
async function open(threads) {
  const env = { text: NOTE, mtime: 1, view_fn: null, stop: null, root: null, folded: [] };
  env.ccb = {
    context: { botId: "B1" },
    panels: { register: (id, fn) => { env.view_fn = fn; } },
    composer: { insertQuote: async () => ({ inserted: true }) },
    host: {
      call: async (method, params) => {
        if (method === "read") return { text: env.text, mtime: env.mtime };
        if (method === "write") { env.text = params.text; env.mtime += 1; return { saved: true, mtime: env.mtime }; }
        if (method === "components") return { components: [] };
        if (method === "assetUrls") return {};
        if (method === "cards") return [];
        if (method === "outline") return { mode: "db", cells: [], forks: [] };
        if (method === "marginList") return { threads: structuredClone(threads) };
        if (method === "marginFold") { env.folded.push(params); return { saved: true }; }
        return null;
      },
    },
    on: () => () => {},
    notify() {},
    card: async ({ component }) => `https://card.invalid/${component}`,
  };
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  activate(env.ccb);
  env.stop = env.view_fn(root);
  env.root = root;
  current = env;
  await settle(10);
  return env;
}
const q = (env, sel) => env.root.querySelector(sel);
const qa = (env, sel) => [...env.root.querySelectorAll(sel)];
const mouse = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const click = (el) => mouse(el, "click");
const pill = (env, id = "c-0001") => q(env, `.nm-rail .nm-card[data-thread="${id}"]`);
const pop = (env) => q(env, ".nm-float");
const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
const px = (v) => Number.parseFloat(v);
const BAR = 88; // the margin the popover keeps above the bottom of the frame (the app's floating status bar lies over it)

describe("an opened side note floats over the page", () => {
  it("is a position: fixed card outside the rail and the note; the rail, the cells and the page layout do not change; nothing in the doc is redrawn", async () => {
    const env = await open([thread()]);
    const page = q(env, ".note-page");
    const doc = q(env, ".note-doc");
    const card = pill(env);
    expect(page.classList.contains("nm-on")).toBe(true); // a wide frame: the margin column exists with the pill in it
    const before = {
      pageClass: page.className, minHeight: page.style.minHeight, pageStyle: page.getAttribute("style"),
      pillTop: card.style.top, railKids: [...q(env, ".nm-rail").children], cells: qa(env, ".cell").map((c) => [c, c.outerHTML]), docKids: [...doc.children],
    };
    const seen = new MutationObserver(() => {});
    seen.observe(doc, { childList: true, subtree: true });
    click(card.querySelector(".nm-head"));
    await settle();
    const p = pop(env);
    expect(p).not.toBeNull();
    expect(p.style.position).toBe("fixed");
    expect(p.closest(".nm-rail")).toBeNull();
    expect(p.closest(".note-page")).toBeNull();
    expect(p.closest(".note-doc")).toBeNull();
    expect(q(env, ".nm-rail").querySelector(".nm-float")).toBeNull();
    // no room taken, nothing pushed
    expect(page.className).toBe(before.pageClass);
    expect(page.style.minHeight).toBe(before.minHeight);
    expect(page.getAttribute("style")).toBe(before.pageStyle);
    expect(pill(env)).toBe(card);
    expect(card.style.top).toBe(before.pillTop);
    expect([...q(env, ".nm-rail").children]).toEqual(before.railKids);
    expect(qa(env, ".cell").map((c) => [c, c.outerHTML])).toEqual(before.cells);
    expect([...doc.children]).toEqual(before.docKids);
    // the same card as before: header 旁註 + 已回答, the answer, the action row
    expect(p.querySelector(".nm-head").textContent).toContain("旁註");
    expect(p.querySelector(".nm-head .nm-st").textContent).toBe("已回答");
    expect(p.textContent).toContain("第 60 行");
    for (const label of ["在視窗追問", "複製", "存成 cell", "刪除", "收起"]) expect(byText(p, ".nm-foot button", label), label).toBeDefined();
    // over its own pill (the stubbed pill sits at x 900..1240, inside the 1280 px frame: no clamping)
    expect(px(p.style.left)).toBe(900);
    expect(px(p.style.width)).toBe(340);
    // closing is as quiet as opening
    click(byText(p, ".nm-foot button", "收起"));
    await settle();
    expect(pop(env)).toBeNull();
    expect(page.className).toBe(before.pageClass);
    expect(page.style.minHeight).toBe(before.minHeight);
    expect([...doc.children]).toEqual(before.docKids);
    expect(qa(env, ".cell").map((c) => [c, c.outerHTML])).toEqual(before.cells);
    expect(seen.takeRecords().filter((r) => r.type === "childList")).toEqual([]); // no clear and redraw, no jump
    seen.disconnect();
    expect(env.folded).toEqual([]);
  });

  it("stays inside the visible frame and above the bottom margin, wherever its pill is; the header and the action row are fixed, the answer scrolls", async () => {
    const env = await open([thread()]);
    const cases = [{ top: 20 }, { top: 300 }, { top: 700 }, { top: 790 }, { top: -400 }, { top: 5000 }];
    for (const c of cases) {
      pillRect = { ...pillRect, top: c.top };
      click(pill(env).querySelector(".nm-head"));
      await settle();
      const p = pop(env);
      const top = px(p.style.top);
      const maxH = px(p.style.maxHeight);
      const h = Math.min(floatH, maxH); // a long answer: the card is as tall as its cap
      expect(top, `top for ${c.top}`).toBeGreaterThanOrEqual(8);
      expect(top + h, `bottom for ${c.top}`).toBeLessThanOrEqual(VH - BAR);
      expect(maxH).toBeLessThanOrEqual(VH - BAR - 8);
      click(byText(p, ".nm-foot button", "收起"));
      await settle();
    }
    // a small window: still above the margin (and the cap has a floor, so the card stays usable)
    VH = 420;
    window.dispatchEvent(new Event("resize"));
    pillRect = { ...pillRect, top: 350 };
    click(pill(env).querySelector(".nm-head"));
    await settle();
    expect(px(pop(env).style.top) + Math.min(floatH, px(pop(env).style.maxHeight))).toBeLessThanOrEqual(VH - BAR);
    // the card is a column: header and action row are direct children that never scroll, the body between them does
    const p = pop(env);
    expect([...p.children].map((c) => c.className)).toEqual(["nm-head", "nm-body", "nm-foot"]);
    expect(MARGIN_CSS).toMatch(/\.nm-card\.nm-float \{[^}]*position: fixed[^}]*flex-direction: column/);
    expect(MARGIN_CSS).toMatch(/\.nm-float > \.nm-body \{[^}]*overflow-y: auto/);
    expect(MARGIN_CSS).toMatch(/\.nm-float > \.nm-head, \.nm-float > \.nm-foot \{ flex: none/);
  });

  it("closes on 收起, on Esc and on a press outside; a press inside it, or on its own pill, keeps it; one at a time", async () => {
    const two = thread({ id: "c-0002", anchor: { cell: "", label: "", kind: "text", scope: "selection", quote: "second cell" } });
    const env = await open([thread(), two]);
    const doc = q(env, ".note-doc");
    const kids = [...doc.children];
    const openIt = async (id = "c-0001") => { click(pill(env, id).querySelector(".nm-head")); await settle(); return pop(env); };
    // 收起 in the footer and the chevron in the header
    let p = await openIt();
    click(byText(p, ".nm-foot button", "收起"));
    await settle();
    expect(pop(env)).toBeNull();
    p = await openIt();
    click(p.querySelector(".nm-head .nm-ib"));
    await settle();
    expect(pop(env)).toBeNull();
    // Esc
    p = await openIt();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(pop(env)).toBeNull();
    // a press outside
    p = await openIt();
    mouse(document.body, "mousedown");
    await settle();
    expect(pop(env)).toBeNull();
    // inside the popover, and on its own pill: stays; a second press on the pill (the click) closes it
    p = await openIt();
    mouse(p.querySelector(".nm-body"), "mousedown");
    mouse(pill(env).querySelector(".nm-head"), "mousedown");
    await settle();
    expect(pop(env)).toBe(p);
    click(pill(env).querySelector(".nm-head"));
    await settle();
    expect(pop(env)).toBeNull();
    // another key does not close it
    p = await openIt();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(pop(env)).toBe(p);
    // one at a time: opening the second replaces the first
    mouse(pill(env, "c-0002").querySelector(".nm-head"), "mousedown"); // outside the first: it closes
    click(pill(env, "c-0002").querySelector(".nm-head"));
    await settle();
    expect(qa(env, ".nm-float")).toHaveLength(1);
    expect(pop(env).dataset.thread).toBe("c-0002");
    expect([...doc.children]).toEqual(kids); // none of this touched the doc
  });

  it("follows its pill when the note scrolls, and goes with the thread when it is deleted or the Note is closed", async () => {
    const env = await open([thread()]);
    floatH = 200; // a short card: it sits at its pill, not pushed up by the bottom margin
    pillRect = { ...pillRect, top: 300 };
    click(pill(env).querySelector(".nm-head"));
    await settle();
    expect(px(pop(env).style.top)).toBe(300);
    pillRect = { ...pillRect, top: 180 };
    q(env, ".note-body").dispatchEvent(new Event("scroll"));
    expect(px(pop(env).style.top)).toBe(180);
    env.stop();
    current = null;
    expect(document.querySelector(".nm-float")).toBeNull();
  });
});
