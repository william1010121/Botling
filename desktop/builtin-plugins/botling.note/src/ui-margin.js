// botling.note, web part, margin comments (旁註): select a passage (or press a cell's 問 button), ask the bot in a small box that opens in
// the margin beside the passage, read the answer as a comment card in the right-hand margin tied to the passage by a thin line, follow
// up in a floating window. Nothing here writes into the note: the threads live in the program part (src/margin.ts, plugin storage),
// the frame asks for them with ccb.host.call("marginList" | "marginAsk" | "marginDelete" | "marginCancel").
// The margin has a node of its own (page > .nm-rail, .nm-links) that render() never rebuilds, so a typed question survives a redraw;
// `layout` (called after every render, on resize and when threads change) only moves the cards so each lines up with its passage.
// Where a passage is now: by the id of its cell in note.db (notes.outline), then by its text; a passage that is gone leaves its card at
// the bottom marked "原文找不到", one in a route that is not shown leaves it hidden. Design: MARGIN.md.

import { inline, openAnchor } from "./ui-text.js";
import { MARGIN_CSS } from "./ui-margin-css.js";

const SVG = "http://www.w3.org/2000/svg";
const ICON = {
  chat: '<path d="M2.5 3h11v7.5H8l-3 2.5v-2.5H2.5z"/>',
  up: '<path d="M3.5 10l4.5-4.5 4.5 4.5"/>',
  reply: '<path d="M6.5 4L3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  min: '<path d="M3.5 8.5h9"/>',
  dock: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M10 3v10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5v-1h3v1M5 4.5l.5 8h5l.5-8"/>',
};
const icon = (name) => `<svg class="nm-i" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
const h = (tag, cls = "", txt = null) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt !== null) el.textContent = txt;
  return el;
};
const clock = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
};
const SCOPE_NAME = { selection: "選取文字", cell: "整個 cell", note: "整份 Note" };
const newRid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// The bot's answer as Markdown, small: paragraphs, lists, headings (as bold), code fences; every line through the note's own inline().
function mdEl(src, ccb, botId) {
  const box = h("div", "nm-md");
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = h("pre");
      pre.append(h("code", "", code.join("\n")));
      box.append(pre);
    } else if (!l.trim()) {
      i++;
    } else if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length && LIST.test(lines[i])) list.append(Object.assign(h("li"), { innerHTML: inline(lines[i++].replace(LIST, "")) }));
      box.append(list);
    } else if (/^#{1,6}\s/.test(l)) {
      box.append(Object.assign(h("p"), { innerHTML: `<strong>${inline(l.replace(/^#{1,6}\s+/, ""))}</strong>` }));
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++]);
      box.append(Object.assign(h("p"), { innerHTML: inline(para.join("\n")) }));
    }
  }
  box.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (!a) return;
    e.preventDefault();
    openAnchor(ccb, botId, a);
  });
  return box;
}

export function install(st, api) {
  const { ccb, wrap, page } = api;
  const { model, shownMarkdown, text } = api;
  const call = (method, params = {}) => ccb.host.call(method, { botId: st.botId, ...params });
  const on = typeof ccb.host?.call === "function";
  const flash = (...a) => api.flash(...a);
  const changed = (...a) => api.changed(...a);
  const flush = (...a) => api.flush(...a);
  const render = (...a) => api.render(...a);

  const style = document.createElement("style");
  style.id = "botling-note-margin-css";
  document.getElementById(style.id)?.remove();
  style.textContent = MARGIN_CSS;
  document.head.append(style);

  const mg = {
    threads: [], // as marginList gives them: { id, anchor, turns, folded, answering, ... }
    cards: new Map(), // thread id -> { el, sig }
    draft: null, // the ask box: { rid, kind, scope, quote, line, cellKey, label, text, sending, error, el, id? }
    win: null, // the floating window: { id, x, y, min, draft, el }
    open: "", float: null, floatFocus: false, // the opened comment (a popover over the page): the thread id, its { id, sig, el, chip } card, and whether it takes the keyboard focus when it appears
    outline: null, outlineText: null, outlineBusy: false,
    rail: null, links: null, pop: null, marks: new Map(), focus: "", timer: 0, raf: 0,
  };
  st.mg = mg;
  const highlights = typeof globalThis.Highlight === "function" && globalThis.CSS?.highlights ? { all: new globalThis.Highlight(), focus: new globalThis.Highlight() } : null;
  if (highlights) {
    CSS.highlights.set("nm-anchor", highlights.all);
    CSS.highlights.set("nm-focus", highlights.focus);
  }

  // ---- where a passage is now ----
  const lineEls = () => {
    const out = [];
    for (const el of st.doc.querySelectorAll("[data-i]")) {
      const a = Number(el.dataset.i);
      out.push({ a, b: el.dataset.j !== undefined ? Number(el.dataset.j) : a, el });
    }
    return out;
  };
  const elOfLine = (els, i) => els.find((x) => x.a <= i && i <= x.b)?.el ?? null;
  const cellEl = (start, end) => [...st.doc.querySelectorAll(".cell")].find((c) => Number(c.dataset.start) === start && Number(c.dataset.end) === end) ?? null;
  function findLine(anchor, lo, hi) {
    const first = anchor.quote.split("\n").find((l) => l.trim());
    if (!first) return -1;
    const needle = anchor.kind === "text" ? anchor.quote.trim() : first.trim();
    for (let i = Math.max(0, lo); i <= Math.min(hi, st.lines.length - 1); i++) if (st.lines[i].includes(needle)) return i;
    return -1;
  }
  // { state: "ok", el, line, stale } | { state: "hidden" } | { state: "pending" } | { state: "orphan" }
  function locate(anchor, els) {
    const oc = anchor.cell && mg.outline ? (Array.isArray(mg.outline.cells) ? mg.outline.cells : []).find((c) => c && c.id === anchor.cell) : null;
    const line = oc ? findLine(anchor, oc.start, oc.end) : findLine(anchor, 0, st.lines.length - 1);
    if (line >= 0) {
      const el = elOfLine(els, line);
      return el ? { state: "ok", el, line, stale: false } : { state: "hidden" };
    }
    if (oc) {
      const el = cellEl(oc.start, oc.end);
      return el ? { state: "ok", el, line: oc.start, stale: true } : { state: "hidden" };
    }
    if (anchor.cell && mg.outlineText === null) return { state: "pending" }; // the ids are on their way
    return { state: "orphan" };
  }
  async function fetchOutline() {
    if (mg.outlineBusy || st.gone) return;
    mg.outlineBusy = true;
    const sent = text();
    let o = null;
    try {
      o = await ccb.host.call("outline", { botId: st.botId, text: sent });
    } catch { /* no outline: the passages are found by their text */ }
    mg.outlineBusy = false;
    if (st.gone) return;
    mg.outline = o && o.mode === "db" ? o : null;
    mg.outlineText = sent;
    layout();
  }

  // ---- the selection and the little 問 button ----
  function selection() {
    if (st.msel) {
      const m = model();
      const blk = (i) => (m.info[i] && ["table", "mathb", "card"].includes(m.info[i].kind) ? m.info[i] : { start: i, end: i });
      const lo = Math.max(0, Math.min(Math.min(st.msel.anchor, st.msel.head), st.lines.length - 1));
      const hi = Math.max(0, Math.min(Math.max(st.msel.anchor, st.msel.head), st.lines.length - 1));
      const quote = shownMarkdown(m, blk(lo).start, blk(hi).end);
      const els = [...st.doc.querySelectorAll(".nl-msel")].filter((e) => e.dataset.i !== undefined);
      if (!quote.trim() || !els.length) return null;
      return { kind: "lines", scope: "selection", quote, line: Number(els[0].dataset.i), end: els[els.length - 1], first: els[0] };
    }
    const ta = st.doc.querySelector(".nl-active textarea");
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const quote = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const holder = ta.closest(".nl");
      if (!quote.trim() || !holder) return null;
      return { kind: "text", scope: "selection", quote, line: Number(holder.dataset.i), end: holder, first: holder };
    }
    return null;
  }
  function hidePop() {
    mg.pop?.el.remove();
    mg.pop = null;
  }
  function showPop() {
    if (!on || st.gone) return;
    const sel = mg.draft ? null : selection();
    if (!sel) return hidePop();
    if (!mg.pop) {
      const el = h("div", "nm-pop nm-ui");
      const b = h("button");
      b.type = "button";
      b.innerHTML = `${icon("chat")}<span>問 Bot</span>`;
      b.title = "問 Bot：回答會掛在右側旁註，不會寫進 Note";
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      b.addEventListener("click", () => {
        const s = mg.pop?.sel;
        hidePop();
        if (s) openDraft(s);
      });
      el.append(b);
      mg.pop = { el, sel };
    }
    mg.pop.sel = sel;
    if (!mg.pop.el.isConnected) page.append(mg.pop.el);
    const pr = page.getBoundingClientRect();
    const fr = sel.first.getBoundingClientRect();
    mg.pop.el.style.left = `${Math.max(0, fr.left - pr.left)}px`;
    mg.pop.el.style.top = `${Math.max(0, fr.top - pr.top - 34)}px`;
  }
  const afterPointer = () => setTimeout(showPop, 0);
  document.addEventListener("mouseup", afterPointer);
  document.addEventListener("keyup", afterPointer);

  // ---- the ask box ----
  function openDraft(spec) {
    if (!on) return flash("這個版本的 App 還不能掛旁註。");
    closeDraft();
    const cell = spec.cellEl ?? spec.first?.closest(".cell") ?? null;
    const d = {
      rid: newRid(), kind: spec.kind, scope: spec.kind === "cell" ? "cell" : "selection", quote: spec.quote,
      line: spec.line ?? (cell ? Number(cell.dataset.start ?? cell.dataset.a) : 0),
      fork: cell?.dataset.fork ?? "", cellNode: cell,
      cellKey: cell ? { start: Number(cell.dataset.start ?? cell.dataset.a), end: Number(cell.dataset.end ?? cell.dataset.b) } : null,
      label: typeof spec.label === "function" ? spec.label : cell && typeof api.cellLabel === "function" ? () => api.cellLabel(cell) : () => Promise.resolve(""),
      text: "", sending: false, error: "", el: null,
    };
    mg.draft = d;
    d.el = draftCard(d);
    layout();
    d.el.classList.add("nm-enter"); // the fade-in plays once, on open: render() re-inserts the box and a kept animation would replay (a flicker)
    const settled = () => d.el.classList.remove("nm-enter");
    d.el.addEventListener("animationend", settled, { once: true });
    setTimeout(settled, 400);
    d.el.querySelector("textarea")?.focus({ preventScroll: true });
    if (typeof d.el.scrollIntoView === "function") d.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  // The first question sits right under its cell, in the flow of the note (the cells below are pushed down), not in the margin.
  // render() rebuilds the doc, so layout() puts the box back after its cell every time.
  function draftCell(d) {
    if (d.cellNode?.isConnected) return d.cellNode;
    if (d.cellKey && Number.isFinite(d.cellKey.start)) {
      const c = cellEl(d.cellKey.start, d.cellKey.end);
      if (c) return c;
    }
    if (d.fork) {
      const b = [...st.doc.querySelectorAll(".cell-branch")].find((e) => e.dataset.fork === d.fork);
      if (b) return b;
    }
    return elOfLine(lineEls(), d.line)?.closest(".cell") ?? null;
  }
  function placeDraft() {
    const d = mg.draft;
    if (!d) return;
    const cell = draftCell(d);
    const wiped = !d.el.isConnected; // render() empties the doc: the box comes back as a detached node, and a detached node drops the focus
    if (cell) {
      d.cellNode = cell;
      if (cell.nextElementSibling !== d.el) cell.after(d.el);
    } else if (d.el.parentElement !== st.doc) st.doc.append(d.el);
    const ta = d.el.querySelector("textarea");
    if (wiped && d.focused && ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
  }
  function markDraft() {
    const d = mg.draft;
    if (!d) return;
    const el = elOfLine(lineEls(), d.line) ?? d.cellNode;
    if (el) mark("draft", { state: "ok", el, line: d.line, stale: false }, { kind: d.kind, quote: d.quote });
  }
  function closeDraft() {
    if (!mg.draft) return;
    mg.draft.el?.remove();
    mg.draft = null;
    layout();
  }
  function scopeBar(d, redraw) {
    const bar = h("div", "nm-scope");
    for (const key of d.kind === "cell" ? ["cell", "note"] : ["selection", "cell", "note"]) {
      const b = h("button", d.scope === key ? "nm-on" : "", SCOPE_NAME[key]);
      b.type = "button";
      b.addEventListener("click", () => {
        d.scope = key;
        redraw();
      });
      bar.append(b);
    }
    return bar;
  }
  function draftCard(d) {
    const card = h("div", "nm-card nm-draft nm-inline nm-ui");
    const body = h("div", "nm-draft-body");
    card.append(body);
    const draw = () => {
      body.textContent = "";
      const top = h("div", "nm-draft-top");
      top.insertAdjacentHTML("beforeend", icon("chat"));
      top.append(h("b", "", "問 Bot"), h("span", "nm-qc", d.quote.replace(/\s+/g, " ").trim()));
      const esc = h("kbd", "", "Esc");
      top.append(esc);
      const ta = h("textarea");
      ta.rows = 2;
      ta.value = d.text;
      ta.setAttribute("aria-label", "提問");
      ta.placeholder = "問這一段…";
      ta.addEventListener("input", () => { d.text = ta.value; });
      ta.addEventListener("focus", () => { d.focused = true; });
      // Leaving the box clears it; a blur that comes from render() removing the box (Chrome fires one) does not: placeDraft() has already
      // given the focus back by the time this timer looks, so what counts is whether the box has it a tick later.
      ta.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== ta) d.focused = false; }, 0); });
      ta.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          closeDraft();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send(d);
        }
      });
      const go = h("button", "nm-btn nm-go");
      go.type = "button";
      go.innerHTML = '送出 <kbd>⌘↵</kbd>';
      go.disabled = d.sending;
      go.addEventListener("click", () => send(d));
      const cancel = h("button", "nm-btn nm-ghost", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", closeDraft);
      const quoteBtn = h("button", "nm-gb", "改為引用到對話");
      quoteBtn.type = "button";
      quoteBtn.addEventListener("click", async () => {
        const label = await d.label().catch(() => "");
        closeDraft();
        api.askQuote?.(d.quote, label);
      });
      const row = h("div", "nm-row nm-ask-ctl");
      row.append(scopeBar(d, draw), h("span", "nm-sp"), quoteBtn, cancel, go);
      body.append(top, ta, row);
      if (d.error) body.append(h("div", "nm-err", d.error));
    };
    d.redraw = draw;
    draw();
    return card;
  }
  async function send(d) {
    if (d.sending) return;
    const q = d.text.trim();
    if (!q) return;
    d.sending = true;
    d.error = "";
    d.redraw?.();
    try {
      const label = await d.label().catch(() => "");
      const id = /^Note #([A-Za-z0-9_-]{1,64})\b/.exec(label)?.[1] ?? "";
      const r = await call("marginAsk", { rid: d.rid, question: q, anchor: { cell: id, label, kind: d.kind, scope: d.scope, quote: d.quote } });
      if (st.gone) return;
      if (r?.thread) upsert(r.thread);
      if (mg.draft === d) {
        d.el?.remove();
        mg.draft = null;
      }
      flash("已送給 bot，回答會出現在右側旁註");
    } catch (error) {
      d.error = String(error?.message ?? error);
    } finally {
      d.sending = false;
      if (!st.gone) {
        d.redraw?.();
        layout();
      }
    }
  }

  // ---- the threads ----
  function upsert(thread) {
    const i = mg.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) mg.threads[i] = thread;
    else mg.threads.push(thread);
    if (mg.win?.id === thread.id) drawWin();
    layout();
  }
  async function refresh() {
    if (!on) return;
    let r = null;
    try {
      r = await call("marginList");
    } catch { /* an app without margin comments: none */ }
    if (st.gone) return;
    mg.threads = Array.isArray(r?.threads) ? r.threads : [];
    if (mg.win && !mg.threads.some((t) => t.id === mg.win.id)) closeWin();
    else if (mg.win) drawWin();
    layout();
  }
  const threadOf = (id) => mg.threads.find((t) => t.id === id) ?? null;
  const lastTurn = (t) => t.turns[t.turns.length - 1];
  const answerOf = (t) => [...t.turns].reverse().find((x) => typeof x.a === "string")?.a ?? "";
  async function remove(t) {
    try {
      await call("marginDelete", { id: t.id });
    } catch (error) {
      return flash(`沒能刪掉旁註：${error?.message ?? error}`);
    }
    mg.threads = mg.threads.filter((x) => x.id !== t.id);
    if (mg.win?.id === t.id) closeWin();
    if (mg.open === t.id) mg.open = "";
    mg.cards.get(t.id)?.el.remove();
    mg.cards.delete(t.id);
    layout();
  }
  async function cancel(t) {
    try {
      await call("marginCancel", { id: t.id });
    } catch (error) {
      return flash(`沒能取消：${error?.message ?? error}`);
    }
    await refresh();
  }
  async function copy(t) {
    const ok = await (api.copyText ? api.copyText(answerOf(t)) : Promise.resolve(false));
    flash(ok ? "已複製回答" : "沒能複製");
  }
  // 存成 cell: the one place an answer goes into the note, and only when the user asks: a new cell after the passage's cell (⌘Z undoes it).
  function saveAsCell(t) {
    const body = answerOf(t).trim();
    if (!body) return;
    const place = locate(t.anchor, lineEls());
    const cell = place.state === "ok" ? place.el.closest?.(".cell") ?? place.el : null;
    const end = cell ? Number(cell.dataset.end) : NaN;
    if (!Number.isFinite(end)) return flash("找不到原文的位置，沒有存進 Note");
    const before = api.snap();
    st.lines.splice(end + 1, 0, "<!-- cell -->", ...body.split("\n"));
    changed();
    api.record(before);
    st.active = -1;
    render();
    flash("已存成原文後面的新 cell（⌘Z 復原）");
  }

  function twoStep(btn, run) {
    let armed = 0;
    btn.addEventListener("click", () => {
      if (armed) {
        clearTimeout(armed);
        return run();
      }
      const was = btn.innerHTML;
      btn.textContent = "確定刪除？";
      btn.classList.add("nm-bad");
      armed = setTimeout(() => {
        armed = 0;
        btn.innerHTML = was;
        btn.classList.remove("nm-bad");
      }, 3000);
    });
  }
  const gb = (cls, name, label, run, title) => {
    const b = h("button", `nm-gb ${cls}`.trim());
    b.type = "button";
    b.innerHTML = `${icon(name)}<span>${label}</span>`;
    if (title) b.title = title;
    if (run) b.addEventListener("click", run);
    return b;
  };
  const ib = (name, title, run, cls = "") => {
    const b = h("button", `nm-ib ${cls}`.trim());
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon(name);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  };
  const turnEl = (who, node) => {
    const t = h("div", "nm-turn");
    const av = h("div", who === "bot" ? "nm-av nm-bot" : "nm-av", who === "bot" ? "B" : "你");
    const msg = h("div", "nm-msg");
    msg.append(node);
    t.append(av, msg);
    return t;
  };
  // the user's own question: a chip (or link) in it opens like the one in a bot's answer
  const textP = (s) => {
    const box = Object.assign(h("div", "nm-md"), { innerHTML: `<p>${inline(String(s))}</p>` });
    box.addEventListener("click", (e) => {
      const a = e.target.closest?.("a");
      if (!a) return;
      e.preventDefault();
      openAnchor(ccb, st.botId, a);
    });
    return box;
  };

  // The state chip of a thread (回答中 / 視窗追問中 / 已回答 / N 輪), as a class and the html inside it.
  function chipOf(t, winOpen) {
    if (t.answering) return { cls: "nm-chip nm-st nm-run", html: `<i class="nm-spin"></i>${winOpen ? "視窗追問中" : "回答中"}` };
    if (winOpen) return { cls: "nm-chip nm-st nm-run", html: "視窗追問中" };
    return { cls: "nm-chip nm-st nm-done", html: t.turns.length > 1 ? `${t.turns.length} 輪` : "已回答" };
  }
  const threadSig = (t, ...more) => JSON.stringify([t.turns.length, !!t.answering, t.turns[t.turns.length - 1]?.a?.length ?? -1, t.turns[0].q, ...more]);

  // The margin card: always the one-line pill (what is in the rail never grows, so opening a comment never moves the note or the other pills).
  // Pressing it opens the comment as a popover (floatFor / placeFloat), which floats over the page.
  function cardFor(t) {
    const winOpen = mg.win?.id === t.id;
    const sig = JSON.stringify([t.turns.length, !!t.answering, t.turns[0].q, winOpen]); // what the pill shows; an answer arriving does not redraw it
    const old = mg.cards.get(t.id);
    if (old && old.sig === sig) return old;
    const card = h("div", `nm-card nm-ui nm-folded${winOpen || mg.open === t.id ? " nm-active" : ""}`);
    card.dataset.thread = t.id;
    const head = h("div", "nm-head");
    head.insertAdjacentHTML("beforeend", icon("chat"));
    const chip = h("span", "nm-chip nm-st");
    const c = chipOf(t, winOpen);
    chip.className = c.cls;
    chip.innerHTML = c.html;
    const sum = h("span", "nm-sum", `${t.turns[0].q.replace(/\s+/g, " ")} · ${t.turns.length} 則`);
    head.append(h("b", "nm-full", "旁註"), sum, chip, h("span", "nm-sp"));
    if (winOpen) head.append(gb("nm-pri", "dock", "釘回側欄", () => closeWin()));
    else head.append(ib("up", "展開", () => toggleFloat(t.id), "nm-fold"));
    card.append(head);
    head.addEventListener("click", () => {
      if (!winOpen) toggleFloat(t.id);
    });
    card.addEventListener("mouseenter", () => setFocus(t.id));
    card.addEventListener("mouseleave", () => setFocus(""));
    old?.el.remove();
    const rec = { el: card, sig, chip, chipCls: chip.className, chipHtml: chip.innerHTML };
    mg.cards.set(t.id, rec);
    return rec;
  }

  // ---- the opened comment: a popover over the page ----
  // `position: fixed`, so it is outside the flow of the note: no column is taken, the cells and the other pills stay where they are. It sits
  // over its own pill (same left edge and width), at most as tall as the visible part of the frame, and the long answer scrolls inside the
  // card while the header and the action row stay put. The floating status bar of the app is outside this frame, so its height cannot be read:
  // BOTTOM_SAFE is a margin that keeps the action row above it.
  const FLOAT_EDGE = 8;
  const FLOAT_BOTTOM_SAFE = 88;
  const FLOAT_MIN_H = 140;
  function floatFor(t) {
    const turn = lastTurn(t);
    const card = h("div", "nm-card nm-ui nm-float nm-active");
    card.dataset.thread = t.id;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "旁註");
    card.tabIndex = -1; // focusable by script only: the popover takes the focus when it opens
    const head = h("div", "nm-head");
    head.insertAdjacentHTML("beforeend", icon("chat"));
    const chip = h("span", "nm-chip nm-st");
    const c = chipOf(t, false);
    chip.className = c.cls;
    chip.innerHTML = c.html;
    head.append(h("b", "nm-full", "旁註"), chip, h("span", "nm-sp"), ib("up", "收起", () => closeFloat()));
    card.append(head);
    const body = h("div", "nm-body");
    body.append(h("div", "nm-q", t.anchor.quote.replace(/\s+/g, " ").trim()));
    body.append(turnEl("you", textP(turn.q)));
    if (typeof turn.a === "string") {
      const msg = mdEl(turn.a, ccb, st.botId);
      body.append(turnEl("bot", msg));
      msg.after(h("div", "nm-stamp", `${clock(turn.aAt)} · 不會寫進 Note`));
    } else {
      const wait = h("div", "nm-wait");
      wait.innerHTML = `<i class="nm-spin"></i><span>bot 還在回答…（回答也會出現在對話裡）</span>`;
      body.append(turnEl("bot", wait));
    }
    if (t.turns.length > 1) body.append(h("div", "nm-more", `前面還有 ${t.turns.length - 1} 輪，在視窗裡看全部`));
    card.append(body);
    const foot = h("div", "nm-foot");
    if (t.answering) {
      foot.append(gb("", "x", "不等了", () => cancel(t), "取消這個問題；bot 如果之後才回，會留在對話裡"));
    } else {
      foot.append(gb("nm-pri", "reply", "在視窗追問", () => openWin(t.id)));
      foot.append(gb("", "copy", "複製", () => copy(t)));
      foot.append(gb("", "plus", "存成 cell", () => saveAsCell(t), "把這個回答存成原文後面的新 cell"));
    }
    foot.append(h("span", "nm-sp"));
    const del = gb("", "trash", "刪除", null, "刪掉這則旁註（不影響 Note）");
    twoStep(del, () => remove(t));
    foot.append(del);
    if (!t.answering) foot.append(gb("", "up", "收起", () => closeFloat()));
    card.append(foot);
    card.addEventListener("mouseenter", () => setFocus(t.id));
    card.addEventListener("mouseleave", () => setFocus(""));
    return { chip, el: card };
  }
  function toggleFloat(id) {
    if (!threadOf(id)) return;
    if (mg.open === id) return closeFloat();
    mg.open = id;
    mg.floatFocus = true; // a keyboard user pressed the pill's chevron: the popover covers it, so the focus moves into the popover
    layout();
  }
  function closeFloat() {
    const id = mg.open;
    if (!id) return;
    const hadFocus = !!mg.float?.el.contains(document.activeElement);
    mg.open = "";
    layout();
    if (mg.focus === id) setFocus(""); // the popover went away under the pointer: no mouseleave comes
    if (hadFocus) mg.cards.get(id)?.el.querySelector(".nm-fold")?.focus({ preventScroll: true }); // back on the pill's chevron
  }
  // Takes the popover down and forgets that it was open: a comment whose pill is not in the rail (its route is not shown, no thread left) does not
  // come back by itself when the pill does.
  function dropFloat() {
    mg.open = "";
    mg.floatFocus = false;
    mg.float?.el.remove();
    mg.float = null;
  }
  // The box for the popover, in viewport coordinates: over its pill, inside the visible part of the frame, above the bottom margin.
  function placeFloat(el, anchor) {
    const vw = window.innerWidth || 1000;
    const vh = window.innerHeight || 700;
    const wr = wrap.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const top0 = Math.max(FLOAT_EDGE, wr.height ? wr.top + FLOAT_EDGE : 0);
    const bottom = Math.min(vh, wr.height ? wr.bottom : vh) - FLOAT_BOTTOM_SAFE;
    const maxH = Math.max(FLOAT_MIN_H, bottom - top0);
    const width = Math.min(a.width || 340, vw - 2 * FLOAT_EDGE);
    const left = Math.min(Math.max(FLOAT_EDGE, a.left), Math.max(FLOAT_EDGE, vw - FLOAT_EDGE - width));
    const s = el.style;
    s.position = "fixed";
    s.left = `${left}px`;
    s.width = `${width}px`;
    s.maxHeight = `${maxH}px`;
    const height = Math.min(el.offsetHeight, maxH);
    s.top = `${Math.min(Math.max(a.top, top0), Math.max(top0, bottom - height))}px`;
  }
  // Called at the end of layout(): make the popover (re)built when its thread changed, and put it where its pill is now.
  function syncFloat(rows) {
    const id = mg.open;
    const row = id ? rows.find((r) => r.key === id) : null;
    const t = id ? threadOf(id) : null;
    if (!row || !t || mg.win?.id === id) return dropFloat();
    const sig = threadSig(t);
    let f = mg.float;
    if (!f || f.id !== id || f.sig !== sig) {
      const built = floatFor(t);
      const scroll = f && f.id === id ? f.el.querySelector(".nm-body")?.scrollTop ?? 0 : 0;
      const hadFocus = !!f?.el.contains(document.activeElement); // an answer arriving rebuilds the card: the focus stays in the popover
      if (f?.el.isConnected) f.el.replaceWith(built.el);
      else wrap.append(built.el);
      mg.float = f = { id, sig, el: built.el, chip: built.chip, chipCls: built.chip.className, chipHtml: built.chip.innerHTML };
      placeFloat(f.el, row.card);
      const body = f.el.querySelector(".nm-body");
      if (body) body.scrollTop = scroll;
      if (hadFocus || mg.floatFocus) f.el.focus({ preventScroll: true });
      mg.floatFocus = false;
    }
    if (row.place.state !== "ok" || row.place.stale) {
      f.chip.className = "nm-chip nm-st nm-warn";
      f.chip.textContent = row.place.state === "orphan" ? "原文找不到" : "原文已改";
    } else {
      f.chip.className = f.chipCls;
      f.chip.innerHTML = f.chipHtml;
    }
    placeFloat(f.el, row.card);
  }
  const followFloat = () => {
    const pill = mg.open ? mg.cards.get(mg.open)?.el : null;
    if (mg.float && pill?.isConnected) placeFloat(mg.float.el, pill);
  };
  const onOutside = (e) => {
    if (!mg.open) return;
    const n = e.target;
    if (n?.closest?.(".nm-float, .nm-win, .nm-pop") || mg.cards.get(mg.open)?.el.contains(n)) return;
    closeFloat();
  };
  const onEsc = (e) => {
    if (e.key === "Escape" && mg.open && !e.isComposing) closeFloat();
  };
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onEsc);
  st.body.addEventListener("scroll", followFloat, { passive: true });
  window.addEventListener("resize", followFloat);

  // ---- the floating window ----
  function openWin(id) {
    if (!threadOf(id)) return;
    mg.open = ""; // the popover gives way to the window
    mg.win = { id, x: null, y: null, min: false, draft: "", el: null, error: "", sending: false };
    drawWin();
    layout();
    mg.win.el?.querySelector("textarea")?.focus();
  }
  function closeWin() {
    if (!mg.win) return;
    mg.win.el?.remove();
    mg.win = null;
    layout();
  }
  function drawWin() {
    const w = mg.win;
    const t = w && threadOf(w.id);
    if (!w || !t) return;
    const hadFocus = !!w.el && w.el.contains(document.activeElement);
    const scroll = w.el?.querySelector(".nm-wbody")?.scrollTop ?? 0;
    w.el?.remove();
    const el = h("div", `nm-win nm-ui${w.min ? " nm-min" : ""}`);
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "旁註追問");
    const bar = h("div", "nm-wbar");
    const grip = h("i", "nm-grip");
    const chip = h("span", `nm-chip ${t.answering ? "nm-run" : "nm-done"}`);
    chip.innerHTML = t.answering ? '<i class="nm-spin"></i>回答中' : `${t.turns.length} 輪`;
    bar.append(grip);
    bar.insertAdjacentHTML("beforeend", icon("chat"));
    bar.append(h("b", "", "旁註追問"), chip, h("span", "nm-sp"));
    bar.append(ib("dock", "釘回側欄", () => closeWin()));
    bar.append(ib("min", w.min ? "展開" : "縮小", () => { w.min = !w.min; drawWin(); }));
    bar.append(ib("x", "收起旁註", () => closeWin()));
    el.append(bar);
    const body = h("div", "nm-wbody");
    body.append(h("div", "nm-q", t.anchor.quote.replace(/\s+/g, " ").trim()));
    const turns = t.turns;
    if (turns.length > 2) {
      const prev = h("details", "nm-prev");
      prev.append(h("summary", "", `前 ${turns.length - 1} 輪`));
      const inner = h("div", "nm-in");
      for (const x of turns.slice(0, -1)) {
        inner.append(h("div", "", `你：${x.q}`));
        if (x.a) inner.append(mdEl(x.a, ccb, st.botId));
      }
      prev.append(inner);
      body.append(prev);
    }
    for (const x of turns.length > 2 ? turns.slice(-1) : turns) {
      body.append(turnEl("you", textP(x.q)));
      if (typeof x.a === "string") {
        const msg = mdEl(x.a, ccb, st.botId);
        body.append(turnEl("bot", msg));
        msg.after(h("div", "nm-stamp", `${clock(x.aAt)} · 不會寫進 Note`));
      } else {
        const wait = h("div", "nm-wait");
        wait.innerHTML = '<i class="nm-spin"></i><span>bot 還在回答…</span>';
        body.append(turnEl("bot", wait));
      }
    }
    const inRow = h("div", "nm-winin");
    const ta = h("textarea");
    ta.rows = 2;
    ta.value = w.draft;
    ta.placeholder = t.answering ? "等 bot 回答後再追問" : "接著問…";
    ta.disabled = !!t.answering;
    ta.setAttribute("aria-label", "追問");
    const go = h("button", "nm-btn nm-go");
    go.type = "button";
    go.innerHTML = '追問 <kbd>⌘↵</kbd>';
    go.disabled = !!t.answering || w.sending;
    const follow = async () => {
      const q = ta.value.trim();
      if (!q || w.sending || t.answering) return;
      w.sending = true;
      w.error = "";
      go.disabled = true;
      w.rid ??= newRid();
      try {
        const r = await call("marginAsk", { rid: w.rid, id: t.id, question: q });
        w.rid = null;
        w.draft = "";
        if (r?.thread) upsert(r.thread);
      } catch (error) {
        w.error = String(error?.message ?? error);
      } finally {
        w.sending = false;
        if (!st.gone && mg.win === w) drawWin();
      }
    };
    ta.addEventListener("input", () => { w.draft = ta.value; w.rid = null; });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        follow();
      }
    });
    go.addEventListener("click", follow);
    inRow.append(ta, go);
    body.append(inRow);
    if (w.error) body.append(h("div", "nm-err", w.error));
    el.append(body);
    const foot = h("div", "nm-wfoot");
    foot.append(gb("", "copy", "複製", () => copy(t)), gb("", "plus", "存成 cell", () => saveAsCell(t)), h("small", "", "不會寫進 Note"), h("span", "nm-sp"));
    if (t.answering) foot.append(gb("", "x", "不等了", () => { closeWin(); cancel(t); }));
    foot.append(gb("", "up", "收起旁註", () => closeWin()));
    el.append(foot);
    const vw = window.innerWidth || 1000;
    const vh = window.innerHeight || 700;
    if (w.x === null) {
      w.x = Math.max(12, vw - 540 - 28);
      w.y = Math.max(56, vh - 480 - 28);
    }
    el.style.left = `${w.x}px`;
    el.style.top = `${w.y}px`;
    wrap.append(el);
    w.el = el;
    body.scrollTop = scroll;
    if (hadFocus && !ta.disabled) ta.focus();
    // drag by the bar
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = { dx: e.clientX - w.x, dy: e.clientY - w.y };
      bar.setPointerCapture?.(e.pointerId);
      bar.style.cursor = "grabbing";
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      w.x = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.dx));
      w.y = Math.max(0, Math.min(window.innerHeight - 48, e.clientY - drag.dy));
      el.style.left = `${w.x}px`;
      el.style.top = `${w.y}px`;
    });
    const end = () => {
      drag = null;
      bar.style.cursor = "";
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  // ---- marks in the text, and the cards beside them ----
  function textRange(el, quote) {
    const nodes = [];
    let full = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest(".cell-ask, .cell-grip, .cell-bar, textarea")) continue;
      nodes.push({ n, at: full.length });
      full += n.nodeValue;
    }
    const q = quote.trim();
    for (const needle of [q, q.replace(/[*_`~]/g, ""), q.replace(/^[-*+]\s+|^\d+[.)]\s+|^#+\s+/, "").replace(/[*_`~]/g, "")]) {
      const at = needle ? full.indexOf(needle) : -1;
      if (at < 0) continue;
      const pos = (offset) => {
        let k = nodes.length - 1;
        while (k > 0 && nodes[k].at > offset) k--;
        return [nodes[k].n, offset - nodes[k].at];
      };
      if (!nodes.length) return null;
      const range = document.createRange();
      const [sn, so] = pos(at);
      const [en, eo] = pos(at + needle.length - 1);
      range.setStart(sn, so);
      range.setEnd(en, Math.min(en.nodeValue.length, eo + 1));
      return range;
    }
    return null;
  }
  function clearMarks() {
    for (const el of st.doc.querySelectorAll(".nm-hl, .nm-cellhl, .nm-focus")) el.classList.remove("nm-hl", "nm-cellhl", "nm-focus");
    highlights?.all.clear();
    highlights?.focus.clear();
    mg.marks.clear();
  }
  function mark(key, place, anchor) {
    const cell = place.el.closest?.(".cell") ?? null;
    if (place.stale || anchor.kind === "cell") {
      const target = cell ?? place.el;
      target.classList.add("nm-cellhl");
      mg.marks.set(key, { els: [target], range: null });
      return;
    }
    const range = highlights && anchor.kind === "text" ? textRange(place.el, anchor.quote) : null;
    if (range) {
      highlights.all.add(range);
      mg.marks.set(key, { els: [], range });
      return;
    }
    const els = [place.el];
    if (anchor.kind === "lines") {
      const n = anchor.quote.split("\n").length;
      for (let i = 1; i < n; i++) {
        const next = elOfLine(lineEls(), place.line + i);
        if (next && next !== place.el) els.push(next);
      }
    }
    for (const el of els) el.classList.add("nm-hl");
    mg.marks.set(key, { els, range: null });
  }
  function setFocus(key) {
    if (mg.focus === key) return;
    const prev = mg.marks.get(mg.focus);
    if (prev) {
      for (const el of prev.els) el.classList.remove("nm-focus");
      if (prev.range) highlights?.focus.delete(prev.range);
    }
    mg.focus = key;
    const next = mg.marks.get(key);
    if (next) {
      for (const el of next.els) el.classList.add("nm-focus");
      if (next.range) highlights?.focus.add(next.range);
    }
    mg.cards.forEach((c, id) => c.el.classList.toggle("nm-active", id === key || mg.win?.id === id || mg.open === id));
  }
  function teardownRail() {
    mg.rail?.remove();
    mg.links?.remove();
    mg.rail = mg.links = null;
    page.classList.remove("nm-on");
    page.style.minHeight = "";
    clearMarks();
  }
  function layout() {
    if (st.gone || !on || !st.loaded) return;
    placeDraft();
    if (!mg.threads.length) {
      dropFloat();
      if (mg.rail) teardownRail();
      else clearMarks();
      markDraft();
      if (mg.pop) showPop();
      return;
    }
    // the ids of note.db are what find a passage again after its text was edited: asked once per text, only when a comment has one
    if (mg.threads.some((t) => t.anchor.cell) && mg.outlineText !== text() && !mg.outlineBusy) {
      clearTimeout(mg.timer);
      mg.timer = setTimeout(fetchOutline, 400);
    }
    const els = lineEls();
    clearMarks();
    const rows = [];
    let hidden = 0;
    for (const t of mg.threads) {
      const place = locate(t.anchor, els);
      if (place.state === "hidden") {
        hidden++;
        mg.cards.get(t.id)?.el.remove();
        continue;
      }
      if (place.state === "pending") continue;
      const rec = cardFor(t);
      if (place.state === "orphan" || place.stale) {
        rec.chip.className = "nm-chip nm-st nm-warn";
        rec.chip.textContent = place.state === "orphan" ? "原文找不到" : "原文已改";
      } else {
        rec.chip.className = rec.chipCls;
        rec.chip.innerHTML = rec.chipHtml;
      }
      rec.el.classList.toggle("nm-stale", place.state !== "ok" || place.stale);
      rows.push({ key: t.id, card: rec.el, place, anchor: t.anchor, dashed: mg.open !== t.id });
    }
    if (!rows.length) {
      dropFloat();
      teardownRail();
      markDraft();
      if (mg.pop) showPop();
      return;
    }
    const wide = st.body.clientWidth >= 760;
    if (!mg.rail) {
      mg.rail = h("div", "nm-rail nm-ui");
      mg.links = document.createElementNS(SVG, "svg");
      mg.links.setAttribute("class", "nm-links");
      mg.links.setAttribute("aria-hidden", "true");
      page.append(mg.links, mg.rail);
    }
    page.classList.toggle("nm-on", wide);
    mg.rail.classList.toggle("nm-narrow", !wide);
    mg.links.style.display = wide ? "" : "none";
    const pr = page.getBoundingClientRect();
    for (const r of rows) {
      const er = r.place.el?.getBoundingClientRect();
      r.y = er ? er.top - pr.top + Math.min(er.height / 2, 15) : Number.MAX_SAFE_INTEGER;
      const cr = (r.place.el?.closest?.(".cell") ?? r.place.el)?.getBoundingClientRect();
      r.x1 = cr ? cr.right - pr.left : 0;
    }
    rows.sort((a, b) => a.y - b.y);
    // a card to a margin slot
    const railKids = [];
    if (!wide) {
      const head = h("div", "nm-rail-head");
      head.innerHTML = `<b>旁註</b><span class="nm-n">${rows.length}</span><small>只掛在 Note 旁邊，不寫進內容${hidden ? ` · ${hidden} 則在沒顯示的路線` : ""}</small>`;
      railKids.push(head);
    }
    for (const r of rows) {
      if (!wide) r.card.style.top = "";
      railKids.push(r.card);
    }
    mg.rail.replaceChildren(...railKids);
    mg.links.textContent = "";
    if (wide) {
      let bottom = -10;
      const railLeft = pr.width - 340;
      for (const r of rows) {
        const top = Math.max(r.y === Number.MAX_SAFE_INTEGER ? bottom + 10 : r.y - 17, bottom + 10);
        r.card.style.top = `${top}px`;
        r.top = top;
        bottom = top + r.card.offsetHeight;
      }
      page.style.minHeight = `${Math.max(0, bottom + 24)}px`;
      for (const r of rows) {
        if (r.y === Number.MAX_SAFE_INTEGER || !r.place.el) continue;
        const y2 = r.top + 17;
        const xm = (r.x1 + railLeft) / 2;
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", `M${r.x1} ${r.y}H${xm}V${y2}H${railLeft}`);
        if (r.dashed) path.setAttribute("class", "nm-dim");
        const dot = document.createElementNS(SVG, "circle");
        dot.setAttribute("cx", String(railLeft));
        dot.setAttribute("cy", String(y2));
        dot.setAttribute("r", "3");
        mg.links.append(path, dot);
      }
    } else {
      page.style.minHeight = "";
    }
    for (const r of rows) if (r.place.state === "ok" && r.place.el) mark(r.key, r.place, r.anchor);
    markDraft();
    setFocusKeep();
    for (const r of rows) r.card.classList.toggle("nm-active", r.key === mg.focus || r.key === mg.open || r.key === mg.win?.id);
    syncFloat(rows);
    if (mg.pop) showPop();
  }
  function setFocusKeep() {
    const key = mg.focus;
    mg.focus = "";
    setFocus(key);
  }
  const layoutSoon = () => {
    if (mg.raf || st.gone) return;
    mg.raf = 1;
    queueMicrotask(() => {
      mg.raf = 0;
      layout();
    });
  };
  window.addEventListener("resize", layoutSoon);
  const watcher = typeof ResizeObserver === "function" ? new ResizeObserver(layoutSoon) : null;
  watcher?.observe(st.doc);

  // the note's own events: threads changed (an answer came in, another window of the same Note)
  const offs = [];
  if (typeof ccb.on === "function") {
    const off = ccb.on("marginChanged", (d) => {
      if (d?.botId && st.botId && d.botId !== st.botId) return;
      refresh();
    });
    if (typeof off === "function") offs.push(off);
  }
  api.marginStop = () => {
    clearTimeout(mg.timer);
    for (const off of offs) off();
    window.removeEventListener("resize", layoutSoon);
    window.removeEventListener("resize", followFloat);
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onEsc);
    st.body.removeEventListener("scroll", followFloat);
    dropFloat();
    document.removeEventListener("mouseup", afterPointer);
    document.removeEventListener("keyup", afterPointer);
    watcher?.disconnect();
    hidePop();
    mg.win?.el?.remove();
    mg.draft?.el?.remove();
    mg.rail?.remove();
    mg.links?.remove();
    if (highlights) {
      CSS.highlights.delete("nm-anchor");
      CSS.highlights.delete("nm-focus");
    }
    document.getElementById("botling-note-margin-css")?.remove();
  };
  Object.assign(api, { marginSync: layout, marginOpen: openDraft, marginRefresh: refresh });
  refresh();
}
