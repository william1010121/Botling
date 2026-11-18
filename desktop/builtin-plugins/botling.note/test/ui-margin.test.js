// @vitest-environment jsdom
// The Note page's margin comments (旁註, src/ui-margin.js), mounted from source in a headless DOM (jsdom, no window, no focus taken) with a fake
// `ccb`: the ask box, the "answering…" state, the answer as a card in the margin, the floating follow-up window, folding / removing, a passage
// that is gone, and the one rule behind all of it: the answer is never written into the note (the saved text only changes when the user presses
// 存成 cell). Run through ui-margin-run.test.ts (vitest.config.mts only collects *.test.ts here). jsdom has no layout, so the frame is "narrow":
// the cards sit in the rail under the note and the ask box floats under its cell; where the cards go in a wide frame is geometry, not covered here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/ui.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
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
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

const NOTE = "# Plan\n\nOld check: same tag means same build.\n<!-- cell -->\nsecond cell\n";
const thread = (over = {}) => ({
  id: "c-0001", anchor: { cell: "", label: "", kind: "text", scope: "selection", quote: "same tag means same build" },
  turns: [{ rid: "r0", q: "為什麼標籤一樣？", a: "因為只比標籤。\n\n- 第一點\n- 第二點", qAt: 1000, aAt: 2000, seenAt: 1500 }],
  folded: false, created: 1000, updated: 2000, answering: false, ...over,
});

function makeEnv(text, threads = []) {
  const env = { text, mtime: 1, calls: [], handlers: {}, stop: null, root: null, margin: { threads: structuredClone(threads), asked: [], folded: [], deleted: [] } };
  const m = env.margin;
  env.answer = async (id, a) => {
    const t = m.threads.find((x) => x.id === id);
    const turn = t.turns[t.turns.length - 1];
    turn.a = a;
    turn.aAt = 3000;
    t.answering = false;
    env.handlers.marginChanged?.({ botId: "B1" });
    await settle(5);
  };
  env.ccb = {
    context: { botId: "B1" },
    panels: { register: (id, fn) => { env.view_fn = fn; } },
    host: {
      call: async (method, params) => {
        env.calls.push(method);
        if (method === "read") return { text: env.text, mtime: env.mtime };
        if (method === "write") {
          if (params.base !== env.mtime) return { saved: false, text: env.text, mtime: env.mtime };
          env.text = params.text;
          env.mtime += 1;
          return { saved: true, mtime: env.mtime };
        }
        if (method === "components") return { components: [] };
        if (method === "assetUrls") return {};
        if (method === "cards") return [];
        if (method === "outline") {
          const cells = [...env.root.querySelectorAll(".cell[data-start]")].map((c) => ({ id: `c${c.dataset.start}`, start: Number(c.dataset.start), end: Number(c.dataset.end), label: `Note #c${c.dataset.start}` }));
          return { mode: "db", cells, forks: [] };
        }
        if (method === "marginList") return { threads: structuredClone(m.threads) };
        if (method === "marginAsk") {
          m.asked.push(params);
          let t = params.id ? m.threads.find((x) => x.id === params.id) : null;
          const turn = { rid: params.rid, q: params.question, a: null, qAt: 5000, aAt: null, seenAt: null };
          if (t) t.turns.push(turn);
          else {
            t = { id: `c-${String(m.threads.length + 1).padStart(4, "0")}`, anchor: params.anchor, turns: [turn], folded: false, created: 5000, updated: 5000 };
            m.threads.push(t);
          }
          t.answering = true;
          return { thread: structuredClone(t) };
        }
        if (method === "marginFold") { m.folded.push([params.id, params.folded]); m.threads.find((x) => x.id === params.id).folded = params.folded; return { saved: true }; }
        if (method === "marginDelete") { m.deleted.push(params.id); m.threads = m.threads.filter((x) => x.id !== params.id); return { deleted: true }; }
        return null;
      },
    },
    on: (name, fn) => { env.handlers[name] = fn; return () => { delete env.handlers[name]; }; },
    notify() {},
    card: async ({ component }) => `https://card.invalid/${component}`,
  };
  return env;
}
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
async function open(text, threads = []) {
  const env = makeEnv(text, threads);
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
const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find((b) => b.textContent.includes(text) || b.title.includes(text));
const writes = (env) => env.calls.filter((c) => c === "write");

describe("margin comments on the Note page", () => {
  it("ask from a cell: the box opens outside the note's text, the question goes out, the card says it is answering, the answer lands in the card and never in the note", async () => {
    const env = await open(NOTE);
    expect(q(env, ".nm-rail")).toBeNull(); // nothing in the DOM while there is nothing to show
    click(qa(env, ".cell")[0].querySelector(".cell-ask"));
    await settle();
    const draft = q(env, ".nm-draft");
    expect(draft).not.toBeNull();
    expect(draft.previousElementSibling).toBe(qa(env, ".cell")[0]); // the box sits right under its cell, in the flow (the cells below move down), not inside the cell
    expect(draft.closest(".cell")).toBeNull();
    expect(q(env, ".nm-rail")).toBeNull(); // no margin column is made for a box alone
    expect(draft.querySelector(".nm-qc").textContent).toContain("Old check");
    expect(draft.textContent).not.toContain("不會寫進 Note"); // no explanatory line at the bottom of the box
    expect(byText(draft, ".nm-scope button", "整個 cell").classList.contains("nm-on")).toBe(true);
    type(draft.querySelector("textarea"), "為什麼標籤一樣？");
    click(draft.querySelector(".nm-go"));
    await settle(20);
    expect(env.margin.asked).toHaveLength(1);
    expect(env.margin.asked[0]).toMatchObject({ question: "為什麼標籤一樣？", anchor: { kind: "cell", scope: "cell", cell: "c0", label: "Note #c0" } });
    expect(env.margin.asked[0].anchor.quote).toContain("Old check");
    expect(q(env, ".nm-draft")).toBeNull();
    const card = q(env, '.nm-card[data-thread="c-0001"]');
    expect(card.querySelector(".nm-st").textContent).toBe("回答中");
    expect(card.querySelector(".nm-wait")).not.toBeNull();
    expect(card.textContent).toContain("為什麼標籤一樣？");
    await env.answer("c-0001", "因為只比標籤。\n\n- 第一點\n- 第二點");
    const done = q(env, '.nm-card[data-thread="c-0001"]');
    expect(done.querySelector(".nm-st").textContent).toBe("已回答");
    expect(done.querySelector(".nm-wait")).toBeNull();
    expect(done.querySelectorAll(".nm-md li")).toHaveLength(2);
    expect(done.textContent).toContain("因為只比標籤");
    // not in the note: not drawn there, not saved, no write at all
    expect(q(env, ".note-doc").textContent).not.toContain("因為只比標籤");
    await settle(1500);
    expect(writes(env)).toEqual([]);
    expect(env.text).toBe(NOTE);
  });

  it("a selection inside a line offers 問 Bot; the ask carries just the selected words", async () => {
    const env = await open(NOTE);
    const line = qa(env, ".nl").find((el) => el.textContent.includes("same tag"));
    mouse(line, "mousedown");
    await settle();
    const ta = q(env, ".nl-active textarea");
    const from = ta.value.indexOf("same tag");
    ta.setSelectionRange(from, from + "same tag means same build".length);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle(5);
    const pop = q(env, ".nm-pop");
    expect(pop).not.toBeNull();
    expect(pop.closest(".note-doc")).toBeNull();
    click(pop.querySelector("button"));
    await settle();
    expect(q(env, ".nm-pop")).toBeNull();
    const draft = q(env, ".nm-draft");
    expect(draft.querySelector(".nm-qc").textContent).toBe("same tag means same build");
    expect(byText(draft, ".nm-scope button", "選取文字").classList.contains("nm-on")).toBe(true);
    type(draft.querySelector("textarea"), "這句什麼意思？");
    draft.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    await settle(20);
    expect(env.margin.asked[0]).toMatchObject({ question: "這句什麼意思？", anchor: { kind: "text", scope: "selection", quote: "same tag means same build", cell: "c0" } });
    expect(env.text).toBe(NOTE);
  });

  it("a double press on 送出 asks once; a failed ask keeps the box with the reason", async () => {
    const env = await open(NOTE);
    click(qa(env, ".cell")[0].querySelector(".cell-ask"));
    await settle();
    const draft = q(env, ".nm-draft");
    type(draft.querySelector("textarea"), "一次就好");
    click(draft.querySelector(".nm-go"));
    click(draft.querySelector(".nm-go"));
    await settle(20);
    expect(env.margin.asked).toHaveLength(1);
    // a failing host: the box stays, with the reason
    env.stop();
    const env2 = await open(NOTE);
    const real = env2.ccb.host.call;
    env2.ccb.host.call = async (method, params) => { if (method === "marginAsk") throw new Error("沒能把問題送給 bot：No such bot."); return real(method, params); };
    click(qa(env2, ".cell")[0].querySelector(".cell-ask"));
    await settle();
    type(q(env2, ".nm-draft textarea"), "會失敗");
    click(q(env2, ".nm-draft .nm-go"));
    await settle(20);
    expect(q(env2, ".nm-draft .nm-err").textContent).toContain("No such bot");
    expect(q(env2, ".nm-draft textarea").value).toBe("會失敗");
    expect(q(env2, ".nm-card[data-thread]")).toBeNull();
  });

  it("comments are still there when the Note is opened again: the card, its answer, the mark on the passage; fold and delete are kept by the host", async () => {
    const env = await open(NOTE, [thread()]);
    const card = q(env, '.nm-card[data-thread="c-0001"]');
    expect(card.textContent).toContain("因為只比標籤");
    expect(qa(env, ".nl").find((el) => el.textContent.includes("same tag")).classList.contains("nm-hl")).toBe(true);
    click(card.querySelector(".nm-fold"));
    await settle();
    expect(env.margin.folded).toEqual([["c-0001", true]]);
    expect(q(env, '.nm-card[data-thread="c-0001"]').classList.contains("nm-folded")).toBe(true);
    // deleting needs a second press
    click(q(env, '.nm-card[data-thread="c-0001"] .nm-head'));
    await settle();
    expect(env.margin.folded.at(-1)).toEqual(["c-0001", false]);
    const del = byText(q(env, '.nm-card[data-thread="c-0001"]'), ".nm-foot button", "刪除");
    click(del);
    expect(env.margin.deleted).toEqual([]);
    expect(del.textContent).toBe("確定刪除？");
    click(del);
    await settle();
    expect(env.margin.deleted).toEqual(["c-0001"]);
    expect(q(env, ".nm-card[data-thread]")).toBeNull();
    expect(q(env, ".nm-rail")).toBeNull();
    expect(env.text).toBe(NOTE);
    expect(writes(env)).toEqual([]);
  });

  it("a passage that is gone leaves its card marked 原文找不到; a passage in a route that is not shown leaves nothing", async () => {
    const gone = thread({ id: "c-0002", anchor: { cell: "", label: "", kind: "text", scope: "selection", quote: "text nobody wrote" } });
    const env = await open(NOTE, [thread(), gone]);
    expect(q(env, '.nm-card[data-thread="c-0002"] .nm-st').textContent).toBe("原文找不到");
    expect(q(env, '.nm-card[data-thread="c-0001"] .nm-st').textContent).toBe("已回答");
    expect(qa(env, ".nm-card[data-thread]").map((c) => c.dataset.thread)).toEqual(["c-0001", "c-0002"]); // orphans last
    env.stop();
    const forked = "intro\n<!-- cell -->\n<!-- branch: 學習率 -->\n<!-- route: slow -->\nslow text\n<!-- route: fast -->\nfast text\n<!-- end branch -->\nafter\n";
    const other = thread({ anchor: { cell: "", label: "", kind: "text", scope: "selection", quote: "fast text" } });
    const env2 = await open(forked, [other]);
    expect(q(env2, ".nm-card[data-thread]")).toBeNull();
  });

  it("follow-up in the floating window: the card keeps a stub, the window sends the follow-up, 釘回側欄 brings the card back", async () => {
    const env = await open(NOTE, [thread()]);
    click(byText(q(env, '.nm-card[data-thread="c-0001"]'), ".nm-foot button", "在視窗追問"));
    await settle();
    const win = q(env, ".nm-win");
    expect(win).not.toBeNull();
    expect(win.closest(".note-doc")).toBeNull();
    expect(win.textContent).toContain("因為只比標籤");
    const card = q(env, '.nm-card[data-thread="c-0001"]');
    expect(card.querySelector(".nm-stub")).not.toBeNull();
    expect(card.querySelector(".nm-st").textContent).toBe("視窗追問中");
    expect(card.querySelector(".nm-foot")).toBeNull();
    type(win.querySelector("textarea"), "那 bundle id 呢？");
    click(win.querySelector(".nm-go"));
    await settle(20);
    expect(env.margin.asked).toHaveLength(1);
    expect(env.margin.asked[0]).toMatchObject({ id: "c-0001", question: "那 bundle id 呢？" });
    expect(env.margin.asked[0].anchor).toBeUndefined();
    expect(q(env, ".nm-win .nm-wait")).not.toBeNull();
    expect(q(env, ".nm-win textarea").disabled).toBe(true);
    await env.answer("c-0001", "是 CFBundleIdentifier。");
    expect(q(env, ".nm-win").textContent).toContain("CFBundleIdentifier");
    expect(q(env, ".nm-win textarea").disabled).toBe(false);
    // minimise keeps the window, 釘回側欄 closes it and the card is whole again, with the last answer
    click(byText(q(env, ".nm-win"), ".nm-ib", "縮小"));
    expect(q(env, ".nm-win").classList.contains("nm-min")).toBe(true);
    click(byText(q(env, ".nm-win"), ".nm-ib", "釘回側欄"));
    await settle();
    expect(q(env, ".nm-win")).toBeNull();
    const back = q(env, '.nm-card[data-thread="c-0001"]');
    expect(back.querySelector(".nm-stub")).toBeNull();
    expect(back.textContent).toContain("CFBundleIdentifier");
    expect(back.textContent).toContain("前面還有 1 輪");
    expect(env.text).toBe(NOTE);
  });

  it("存成 cell is the only way an answer reaches the note: a new cell right after the passage's cell, one undo step", async () => {
    const env = await open(NOTE, [thread()]);
    await settle(1500);
    expect(writes(env)).toEqual([]);
    click(byText(q(env, '.nm-card[data-thread="c-0001"]'), ".nm-foot button", "存成 cell"));
    await settle(800);
    expect(writes(env)).toHaveLength(1);
    expect(env.text).toContain("same build.\n<!-- cell -->\n因為只比標籤。\n\n- 第一點\n- 第二點\n<!-- cell -->\nsecond cell");
    expect(q(env, '.nm-card[data-thread="c-0001"]')).not.toBeNull(); // the comment stays
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    await settle(800);
    expect(env.text).toBe(NOTE);
  });

  it("Cmd+Z typed in a comment box is the box's, not the note's undo", async () => {
    const env = await open(NOTE, [thread()]);
    click(byText(q(env, '.nm-card[data-thread="c-0001"]'), ".nm-foot button", "存成 cell"));
    await settle(800);
    const saved = env.text;
    click(byText(q(env, '.nm-card[data-thread="c-0001"]'), ".nm-foot button", "在視窗追問"));
    await settle();
    const ta = q(env, ".nm-win textarea");
    const ev = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await settle(800);
    expect(ev.defaultPrevented).toBe(false);
    expect(env.text).toBe(saved);
  });
});
