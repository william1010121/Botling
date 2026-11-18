// botling.note, web part, margin comments: the opened comment (a popover over the page) and the floating window (follow-ups). Moved out of
// ui-margin.js without a change (the file's size gate); `install` runs where the code used to run in ui-margin.js's `install`. What it borrows
// from the rest of that function it reads through `k` (forwarders that look the names up when called, because ui-margin.js defines them after
// this call); what ui-margin.js needs from here comes back as the return value of `install`.

import { clock, h, icon, mdEl, newRid } from "./ui-margin-dom.js";

export function install(st, api, k) {
  const { ccb, wrap, page } = api;
  const mg = st.mg;
  const call = (method, params = {}) => ccb.host.call(method, { botId: st.botId, ...params });
  const on = typeof ccb.host?.call === "function";
  const changed = (...a) => api.changed(...a);
  const { cancel, chipOf, copy, gb, ib, lastTurn, layout, remove, saveAsCell, setFocus, textP, threadOf, threadSig, turnEl, twoStep, upsert } = k;
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

  return { toggleFloat, dropFloat, syncFloat, closeWin, drawWin, followFloat, onOutside, onEsc };
}
