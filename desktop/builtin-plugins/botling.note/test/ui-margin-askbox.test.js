// @vitest-environment jsdom
// The ask box of the Note's margin comments (src/ui-margin.js draftCard / placeDraft): it sits right under its cell in the flow of the note,
// keeps every control of the old floating box (scope, ⌘↵, Esc / 取消, 改為引用到對話), and survives render() emptying the doc without a
// flicker (no new fade-in) and without losing the typing focus. Mounted from source in jsdom (no layout, no window, no focus taken from
// the user); run through ui-margin-askbox-run.test.ts. Kept apart from ui-margin.test.js so the two branches editing that file do not collide.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/ui.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let scrolled = [];
let focused = [];
const realFocus = HTMLElement.prototype.focus;
beforeEach(() => {
  document.elementFromPoint = () => null;
  scrolled = [];
  focused = [];
  HTMLElement.prototype.focus = function (o) { focused.push([this, o]); return realFocus.call(this, o); };
  Element.prototype.scrollIntoView = function (o) { scrolled.push([this, o]); };
  Element.prototype.scrollTo = () => {};
  try { localStorage.clear(); } catch {}
  vi.useFakeTimers();
});
let current = null;
afterEach(() => {
  HTMLElement.prototype.focus = realFocus;
  current?.stop?.();
  current = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

const NOTE = "# Plan\n\nOld check: same tag means same build.\n<!-- cell -->\nsecond cell\n<!-- cell -->\n- [ ] todo\n";
const thread = (cell = "", quote = "second cell") => ({
  id: "c-0001", anchor: { cell, label: "", kind: "text", scope: "selection", quote },
  turns: [{ rid: "r0", q: "q?", a: "a.", qAt: 1000, aAt: 2000, seenAt: 1500 }],
  folded: false, created: 1000, updated: 2000, answering: false,
});
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
async function open(threads = []) {
  const env = { text: NOTE, mtime: 1, calls: [], asked: [], quotes: [], root: null, view_fn: null, stop: null };
  env.ccb = {
    context: { botId: "B1" },
    panels: { register: (id, fn) => { env.view_fn = fn; } },
    composer: { insertQuote: async (quote) => { env.quotes.push(quote); return { inserted: true }; } },
    host: {
      call: async (method, params) => {
        env.calls.push(method);
        if (method === "read") return { text: env.text, mtime: env.mtime };
        if (method === "write") { env.text = params.text; env.mtime += 1; return { saved: true, mtime: env.mtime }; }
        if (method === "components") return { components: [] };
        if (method === "assetUrls") return {};
        if (method === "cards") return [];
        if (method === "outline") {
          const cells = [...env.root.querySelectorAll(".cell[data-start]")].map((c) => ({ id: `c${c.dataset.start}`, start: Number(c.dataset.start), end: Number(c.dataset.end), label: `Note #c${c.dataset.start}` }));
          return { mode: "db", cells, forks: [] };
        }
        if (method === "marginList") return { threads: structuredClone(threads) };
        if (method === "marginAsk") {
          env.asked.push(params);
          return { thread: { id: "c-0009", anchor: params.anchor, turns: [{ rid: params.rid, q: params.question, a: null, qAt: 5000, aAt: null, seenAt: null }], folded: false, created: 5000, updated: 5000, answering: true } };
        }
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
const type = (ta, value) => { ta.value = value; ta.dispatchEvent(new InputEvent("input", { bubbles: true })); };
const key = (ta, k, init = {}) => { const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }); ta.dispatchEvent(e); return e; };
const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
async function askFirstCell(env) {
  click(qa(env, ".cell")[0].querySelector(".cell-ask"));
  await settle();
  return q(env, ".nm-draft");
}

describe("the ask box under its cell", () => {
  it("one row holds the scope toggle, 改為引用到對話, 取消 and 送出 ⌘↵; no hint line under it", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    const row = draft.querySelector(".nm-ask-ctl");
    expect(row).not.toBeNull();
    expect(row.querySelector(".nm-scope")).not.toBeNull();
    expect(byText(row, "button", "改為引用到對話")).toBeTruthy();
    expect(byText(row, "button", "取消")).toBeTruthy();
    expect(row.querySelector(".nm-go").textContent).toContain("⌘↵");
    expect(draft.querySelector(".nm-ask-hint, small")).toBeNull();
    expect(row.nextElementSibling).toBeNull(); // nothing below the row (no error yet)
  });

  it("Esc and 取消 close the box and ask nothing", async () => {
    const env = await open();
    let draft = await askFirstCell(env);
    type(draft.querySelector("textarea"), "不送");
    const esc = key(draft.querySelector("textarea"), "Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(q(env, ".nm-draft")).toBeNull();
    draft = await askFirstCell(env);
    expect(draft).not.toBeNull();
    click(byText(draft, "button", "取消"));
    expect(q(env, ".nm-draft")).toBeNull();
    expect(env.asked).toEqual([]);
  });

  it("the scope toggle changes what is sent: 整份 Note goes out as scope note", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    click(byText(draft, ".nm-scope button", "整份 Note"));
    const d2 = q(env, ".nm-draft"); // the row is drawn again
    expect(byText(d2, ".nm-scope button", "整份 Note").classList.contains("nm-on")).toBe(true);
    type(d2.querySelector("textarea"), "整份呢？");
    key(d2.querySelector("textarea"), "Enter", { metaKey: true });
    await settle(20);
    expect(env.asked).toHaveLength(1);
    expect(env.asked[0].anchor.scope).toBe("note");
    expect(q(env, ".nm-draft")).toBeNull();
  });

  it("改為引用到對話 puts the quote in the chat and closes the box without asking", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    click(byText(draft, "button", "改為引用到對話"));
    await settle(20);
    expect(env.quotes).toHaveLength(1);
    expect(env.quotes[0]).toContain("Old check");
    expect(env.asked).toEqual([]);
    expect(q(env, ".nm-draft")).toBeNull();
  });

  it("opening scrolls the box into view (nearest, smooth) without the textarea focus scrolling first; the fade-in is a one-off class", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    expect(scrolled.some(([el, o]) => el === draft && o?.block === "nearest" && o?.behavior === "smooth")).toBe(true);
    expect(focused.some(([el, o]) => el === draft.querySelector("textarea") && o?.preventScroll === true)).toBe(true);
    expect(draft.classList.contains("nm-enter")).toBe(true);
    await settle(500);
    expect(draft.classList.contains("nm-enter")).toBe(false);
  });

  it("the box makes no room in the margin: no rail and no nm-on on the page; with a comment the rail keeps its card and the box stays in the flow", async () => {
    const env = await open();
    await askFirstCell(env);
    expect(q(env, ".nm-rail")).toBeNull();
    expect(q(env, ".note-page").classList.contains("nm-on")).toBe(false);
    env.stop();
    const env2 = await open([thread()]);
    const draft = await askFirstCell(env2);
    expect(draft.closest(".nm-rail")).toBeNull();
    expect(draft.previousElementSibling).toBe(qa(env2, ".cell")[0]);
    expect(q(env2, '.nm-rail .nm-card[data-thread="c-0001"]')).not.toBeNull();
  });

  it("render() empties the doc: the box comes back under its cell with its text, plays no new fade-in, and the typing focus returns to it", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    await settle(500); // the fade-in is over
    const ta = draft.querySelector("textarea");
    type(ta, "寫到一半");
    expect(document.activeElement).toBe(ta);
    ta.dispatchEvent(new FocusEvent("blur")); // Chrome fires a blur when the doc is emptied under the focused box: that is not the user leaving
    click(q(env, ".cb")); // ticks the todo line: render() runs
    await settle(20);
    const again = q(env, ".nm-draft");
    expect(again).toBe(draft); // the same box, not a new one
    expect(again.previousElementSibling).toBe(qa(env, ".cell")[0]);
    expect(again.querySelector("textarea").value).toBe("寫到一半");
    expect(again.classList.contains("nm-enter")).toBe(false); // a re-insert must not replay the fade-in (a flicker)
    expect(document.activeElement).toBe(again.querySelector("textarea"));
    await settle(20);
    expect(document.activeElement).toBe(again.querySelector("textarea")); // and the blur's timer did not take it back
  });

  it("a layout in the same tick as the user leaving the box does not pull the focus back (the click on 取消 / a scope tab must land)", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    const ta = draft.querySelector("textarea");
    expect(document.activeElement).toBe(ta);
    const away = byText(draft, "button", "取消");
    away.focus();
    window.dispatchEvent(new Event("resize")); // layoutSoon(): a microtask, before the blur's timer runs
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(away);
  });

  it("render() does not pull the focus into the box when the user had left it", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    const ta = draft.querySelector("textarea");
    const away = byText(draft, "button", "取消");
    away.focus(); // the user clicked another control: the box's textarea blurs for real
    ta.dispatchEvent(new FocusEvent("blur"));
    await settle(20);
    expect(document.activeElement).toBe(away);
    away.blur();
    click(q(env, ".cb"));
    await settle(20);
    expect(q(env, ".nm-draft")).toBe(draft);
    expect(document.activeElement).not.toBe(q(env, ".nm-draft textarea"));
  });

  it("a press inside the box does not start editing a line, drag-select cells or write the note; a line press still edits and the box stays", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    mouse(draft.querySelector("textarea"), "mousedown");
    mouse(draft.querySelector(".nm-draft-top"), "mousedown");
    await settle(20);
    expect(q(env, ".nl-active")).toBeNull();
    expect(q(env, ".nl-msel")).toBeNull();
    const line = qa(env, ".nl").find((el) => el.textContent.includes("second cell"));
    mouse(line, "mousedown");
    await settle(20);
    expect(q(env, ".nl-active")).not.toBeNull();
    expect(q(env, ".nm-draft")).toBe(draft);
    expect(draft.previousElementSibling).toBe(qa(env, ".cell")[0]);
    await settle(1500);
    expect(env.calls.filter((c) => c === "write")).toEqual([]);
  });

  it("the asked cell is marked while the box is open and the mark goes with the box (no comment, a comment, a comment still looking for its cell)", async () => {
    const env = await open();
    const draft = await askFirstCell(env);
    expect(qa(env, ".cell")[0].classList.contains("nm-cellhl")).toBe(true);
    key(draft.querySelector("textarea"), "Escape");
    expect(q(env, ".nm-cellhl")).toBeNull();
    env.stop();
    const env2 = await open([thread()]);
    await askFirstCell(env2);
    expect(qa(env2, ".cell")[0].classList.contains("nm-cellhl")).toBe(true);
    env2.stop();
    // a comment whose words are not in the note and whose cell id is still on the way (the outline is asked 400 ms later): "pending", no card to draw yet
    const env3 = await open([thread("c0", "text nobody wrote")]);
    expect(q(env3, ".nm-rail")).toBeNull();
    await askFirstCell(env3);
    expect(qa(env3, ".cell")[0].classList.contains("nm-cellhl")).toBe(true);
  });
});
