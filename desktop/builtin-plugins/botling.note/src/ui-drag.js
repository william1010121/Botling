// botling.note, web part, mount part 4 (M7-S104): the multi-line selection (the hidden text box, copy / cut / typing, the
// highlight) and the drag of a cell by its grip. Moved out of ui.js without a change; `install` runs where the code used to
// run in `mount`. What it borrows from the rest of `mount` it reads through `api` (the first block destructures what parts 1
// to 3 registered; the forwarders look the other names up when called, because ui.js registers them after its last
// definition); what the rest of `mount` needs from here it finds on `api` after `install` returns (the last statement).

import { pathVisible } from "./branch.js";
import { isCellLine, cellGaps, gapTouches, moveCellTo } from "./cells.js";
import { classify, quoteOfLine, QUOTE_LEAD, ASK_SVG } from "./ui-text.js";

export function install(st, api) {
  const { root } = api;
  const {
    wrap, page, text, model, closePopup, snap, record, undos, selectRoute, placeName, nextEditable, prevEditable,
    commitCell, goLine,
  } = api;
  // The bridge block: names defined later in `mount` (ui.js).
  const render = (...a) => api.render(...a);
  const activate = (...a) => api.activate(...a);
  const flash = (...a) => api.flash(...a);
  const changed = (...a) => api.changed(...a);
  const closeMap = (...a) => api.closeMap(...a);
  const sink = document.createElement("textarea");
  sink.className = "nsel-sink";
  sink.tabIndex = -1;
  sink.setAttribute("aria-label", "選取的內容");
  wrap.append(sink);
  const blockOf = (info, i) => (info[i] && (info[i].kind === "table" || info[i].kind === "mathb" || info[i].kind === "card") ? info[i] : { start: i, end: i });
  function selRange(m = model()) {
    let lo = Math.min(st.msel.anchor, st.msel.head);
    let hi = Math.max(st.msel.anchor, st.msel.head);
    lo = Math.max(0, Math.min(lo, st.lines.length - 1));
    hi = Math.max(0, Math.min(hi, st.lines.length - 1));
    return { lo: blockOf(m.info, lo).start, hi: blockOf(m.info, hi).end };
  }
  const isStructure = (m, i) => m.meta.at[i].marker !== null || (m.info[i].kind === "text" && isCellLine(st.lines[i]));
  function selText(m = model()) {
    const { lo, hi } = selRange(m);
    return shownMarkdown(m, lo, hi);
  }
  // The Markdown of the shown lines lo..hi: no `cell` / branch / route / end-branch lines (a blank line where one was left out
  // between two lines of text) and nothing from routes that are not shown.
  function shownMarkdown(m, lo, hi) {
    const out = [];
    let gap = false;
    for (let i = lo; i <= hi; i++) {
      if (!m.vis(i)) continue;
      if (isStructure(m, i)) {
        gap = true;
        continue;
      }
      if (gap && out.length && out[out.length - 1].trim() && st.lines[i].trim()) out.push("");
      gap = false;
      out.push(st.lines[i]);
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  }
  const stepDown = (i) => nextEditable(blockOf(classify(st.lines), i).end);
  const stepUp = (i) => prevEditable(blockOf(classify(st.lines), i).start);
  function startSel(anchor, head) {
    if (st.tcell) {
      commitCell();
      st.tcell = null;
    }
    st.active = -1;
    closePopup();
    st.msel = { anchor, head };
    render();
    focusSink();
  }
  function clearSel() {
    if (!st.msel) return;
    st.msel = null;
    wrap.classList.remove("msel-on");
    for (const el of st.doc.querySelectorAll(".nl-msel")) el.classList.remove("nl-msel");
  }
  function focusSink() {
    if (!st.msel) return;
    sink.value = selText();
    if (document.activeElement !== sink) sink.focus({ preventScroll: true });
    sink.select();
  }
  // Cmd/Ctrl+A: the cell around line i; again (the cell already selected): the whole note.
  function selectAllFrom(i) {
    const m = model();
    const idx = m.cells.at[i];
    const run = idx >= 0 ? m.cells.runs[idx] : null;
    const whole = () => {
      let a = 0;
      while (a < st.lines.length - 1 && !m.editable(a)) a++;
      let b = st.lines.length - 1;
      while (b > 0 && !m.editable(b)) b--;
      startSel(a, b);
      flash("已選取整份筆記（目前顯示的路線）· ⌘C 複製 Markdown");
    };
    if (!run) return whole();
    const a = run.first >= 0 ? run.first : run.start;
    const b = run.last >= 0 ? run.last : run.end;
    if (st.msel) {
      const r = selRange(m);
      if (r.lo <= a && r.hi >= b) return whole();
    }
    startSel(a, b);
    flash("已選取這個 cell · 再按 ⌘A 選取整份筆記 · ⌘C 複製 Markdown");
  }
  // Replace the selection by `txt` (typing, paste, Delete): the shown lines go, `cell` lines between them go, branch /
  // route / end-branch lines and hidden routes stay; the text lands where the first removed line was.
  function replaceSel(txt) {
    if (!st.msel) return;
    const before = snap();
    const m = model();
    const { lo, hi } = selRange(m);
    const out = [];
    let first = -1;
    for (let i = 0; i < st.lines.length; i++) {
      const drop = i >= lo && i <= hi && m.vis(i) && m.meta.at[i].marker === null;
      if (drop) {
        if (first < 0) first = out.length;
        continue;
      }
      out.push(st.lines[i]);
    }
    if (first < 0) return clearSel();
    const add = String(txt).replace(/\r\n?/g, "\n").split("\n");
    out.splice(first, 0, ...add);
    st.lines = out;
    clearSel();
    changed();
    record(before);
    const at = first + add.length - 1;
    activate(at, add[add.length - 1].length);
    if (undos.length && undos[undos.length - 1].after.text === text()) st.tail = { rec: undos[undos.length - 1], line: at };
  }
  // `>` over a selection quotes every selected line ("> " in front, one more level where there already is one);
  // Cmd/Ctrl+Shift+. toggles: all quoted takes one level off, else the lines without one get it. Only text lines change
  // (never cell / branch / route / end-branch lines, cards, tables or code); the same lines stay selected; one undo step.
  function quoteSel(mode) {
    if (!st.msel) return;
    const m = model();
    const { lo, hi } = selRange(m);
    const pick = [];
    for (let i = lo; i <= hi; i++) if (m.vis(i) && !isStructure(m, i) && m.info[i].kind === "text") pick.push(i);
    if (!pick.length) return flash("選取的行裡沒有可以加引用的文字");
    const full = pick.filter((i) => st.lines[i].trim());
    const all = full.length > 0 && full.every((i) => quoteOfLine(st.lines[i]).depth > 0);
    const before = snap();
    for (const i of pick) {
      const l = st.lines[i];
      if (mode === "toggle" && all) st.lines[i] = l.replace(QUOTE_LEAD, "");
      else if (mode === "toggle" && quoteOfLine(l).depth > 0) continue;
      else st.lines[i] = l.trim() ? `> ${l}` : ">";
    }
    changed();
    record(before);
    render();
    focusSink();
    flash(mode === "toggle" && all ? "已移除引用（⌘⇧. 切換）" : "已加上引用（⌘⇧. 切換，⌘Z 復原）");
  }
  const isQuoteKey = (e) => !e.altKey && (e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Period" || e.key === ">" || e.key === ".");
  sink.addEventListener("keydown", (e) => {
    if (!st.msel || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (isQuoteKey(e)) {
      e.preventDefault();
      quoteSel("toggle");
    } else if (!mod && !e.altKey && (k === ">" || k === "＞")) {
      e.preventDefault();
      quoteSel("add");
    } else if (mod && k.toLowerCase() === "z") {
      e.preventDefault(); // Cmd+Z that the note's own undo did not take: not the box's undo either
    } else if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === "a") {
      e.preventDefault();
      selectAllFrom(st.msel.head);
    } else if (e.shiftKey && !mod && !e.altKey && (k === "ArrowDown" || k === "ArrowUp")) {
      e.preventDefault();
      const h = k === "ArrowDown" ? stepDown(st.msel.head) : stepUp(st.msel.head);
      if (h >= 0) {
        st.msel.head = h;
        render();
        focusSink();
      }
    } else if (!mod && !e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(k)) {
      e.preventDefault();
      const { lo, hi } = selRange();
      clearSel();
      if (k === "ArrowUp" || k === "ArrowLeft") goLine(lo, 0, false);
      else goLine(hi, st.lines[hi].length, true);
    } else if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clearSel();
      render();
    } else if (!mod && (k === "Backspace" || k === "Delete")) {
      e.preventDefault();
      replaceSel("");
    } else if (!mod && k === "Enter") {
      e.preventDefault();
      replaceSel("\n");
    } else if (k === "Tab" || k === "Home" || k === "End" || k === "PageUp" || k === "PageDown" || (e.shiftKey && (k === "ArrowLeft" || k === "ArrowRight"))) {
      e.preventDefault();
    }
  });
  // copy / cut: the Markdown (set explicitly; the box holds the same text, so a copy that skips this event gets it too)
  sink.addEventListener("copy", (e) => {
    if (!st.msel) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", selText());
    flash("已複製 Markdown");
  });
  sink.addEventListener("cut", (e) => {
    if (!st.msel) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", selText());
    replaceSel("");
  });
  // typing, an input method's text, paste: the box's text replaces the selection
  sink.addEventListener("input", (e) => {
    if (!st.msel || e.isComposing) return;
    if (/^history/.test(e.inputType ?? "")) return focusSink(); // the box's own undo: not an edit of the note
    if (/^[>＞]$/.test(sink.value)) return quoteSel("add"); // `>` from an input method (full-width too)
    replaceSel(sink.value);
  });
  sink.addEventListener("compositionend", () => {
    if (!st.msel) return;
    if (/^[>＞]$/.test(sink.value)) return quoteSel("add");
    replaceSel(sink.value);
  });
  sink.addEventListener("blur", () => {
    setTimeout(() => {
      if (!st.gone && st.msel && document.activeElement !== sink && root.contains(document.activeElement)) {
        clearSel();
        render();
      }
    }, 0);
  });
  // The line (index) under a point / element; a cell's own padding counts as its first or last line.
  function lineAtEl(el, y) {
    if (!el || !st.doc.contains(el)) return -1;
    const ln = el.closest("[data-i]");
    if (ln && st.doc.contains(ln)) return Number(ln.dataset.i);
    const box = el.closest("[data-a]");
    if (!box || !st.doc.contains(box)) return -1;
    const r = box.getBoundingClientRect();
    const a = Math.ceil(Number(box.dataset.a));
    const b = Math.floor(Number(box.dataset.b));
    return Math.max(0, Math.min(st.lines.length - 1, y < r.top + r.height / 2 ? a : b));
  }
  st.doc.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || st.drag || e.target.closest("button, a, .cell-grip, .cell-bar, .nt-bar, .nb-fork, input")) {
      st.press = null;
      return;
    }
    const at = lineAtEl(e.target, e.clientY);
    if (at < 0 || !e.target.closest("[data-i]")) {
      st.press = null;
      return;
    }
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const from = st.msel ? st.msel.anchor : st.active >= 0 ? st.active : st.tcell ? st.tcell.start : -1;
      if (from >= 0 && from !== at) {
        e.preventDefault();
        e.stopPropagation();
        st.press = { line: from, moved: true };
        startSel(from, at);
        return;
      }
    }
    if (st.msel) clearSel();
    st.press = { line: at, moved: false };
  }, true);
  const onSelMove = (e) => {
    if (!st.press || !(e.buttons & 1) || st.drag) return;
    const br = st.body.getBoundingClientRect();
    if (e.clientY < br.top + 24) st.body.scrollTop -= 18;
    else if (e.clientY > br.bottom - 24) st.body.scrollTop += 18;
    const y = Math.max(br.top + 2, Math.min(br.bottom - 2, e.clientY));
    const x = Math.max(br.left + 2, Math.min(br.right - 2, e.clientX));
    let at = lineAtEl(document.elementFromPoint(x, y), y);
    if (at < 0) return;
    if (!st.press.moved && at === st.press.line) return;
    e.preventDefault();
    if (!st.press.moved) {
      st.press.moved = true;
      window.getSelection()?.removeAllRanges();
      startSel(st.press.line, at);
    } else if (st.msel && st.msel.head !== at) {
      st.msel.head = at;
      render();
      focusSink();
    }
  };
  const onSelUp = () => {
    if (st.press?.moved && st.msel) focusSink();
    st.press = null;
  };
  document.addEventListener("mousemove", onSelMove);
  document.addEventListener("mouseup", onSelUp);
  // Cmd/Ctrl+A with nothing being edited (the note itself has the focus): the whole note.
  const onSelAll = (e) => {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key ?? "").toLowerCase() !== "a") return;
    if (st.msel || st.active >= 0 || st.tcell || st.drag || st.boardOpen) return;
    const f = document.activeElement;
    if (f && f !== document.body && !wrap.contains(f)) return;
    if (f && (f.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName))) return;
    const a = nextEditable(-1);
    if (a < 0) return;
    e.preventDefault();
    selectAllFrom(a);
    if (st.msel) selectAllFrom(st.msel.head); // straight to the whole note
  };
  document.addEventListener("keydown", onSelAll);
  // the highlight, after each render
  function drawSel(m) {
    wrap.classList.toggle("msel-on", !!st.msel);
    if (!st.msel) return;
    const { lo, hi } = selRange(m);
    for (const el of st.doc.querySelectorAll("[data-i], .cell-branch, [data-fork-end]")) {
      const a = el.dataset.i !== undefined ? Number(el.dataset.i) : Number(el.dataset.a);
      const b = el.dataset.j !== undefined ? Number(el.dataset.j) : el.dataset.i !== undefined ? a : Number(el.dataset.b);
      if (a >= lo && b <= hi) el.classList.add("nl-msel");
    }
  }

  // ---- drag a cell by its grip (as in Jupyter) ----
  // A drop goes into the gap nearest the pointer: between cells, before / after a fork, into the route a fork shows (an empty
  // route too). Hovering a route tab for a moment shows that route; dropping on a tab puts the cell at the end of that route.
  // The text moves as in cells.js moveCellTo; Cmd+Z takes the whole drag back (view included).
  st.drag = null; // { start, x, y, lx, ly, on, text, before, ghost, gaps, target, tabKey, tabTimer, raf, dx, dy }
  const GRIP_SVG = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">${[3, 8, 13]
    .map((y) => `<circle cx="2.5" cy="${y}" r="1.4"/><circle cx="7.5" cy="${y}" r="1.4"/>`).join("")}</svg>`;
  const dropLine = document.createElement("div");
  dropLine.className = "nd-line";
  dropLine.hidden = true;
  const dropTag = document.createElement("span");
  dropTag.className = "nd-tag";
  dropLine.append(dropTag);
  const dropZone = document.createElement("div");
  dropZone.className = "nd-zone";
  dropZone.hidden = true;
  page.append(dropZone, dropLine);

  function cellAsk(run, title = "問 Bot（回答掛在右側旁註）") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cell-ask";
    b.innerHTML = ASK_SVG;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep the line being edited
      e.stopPropagation();
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }

  function cellGrip(c) {
    const g = document.createElement("div");
    g.className = "cell-grip";
    g.title = "拖曳來移動這一格（也可以用 ⌥↑ / ⌥↓）";
    g.setAttribute("aria-label", "拖曳來移動這一格");
    g.innerHTML = GRIP_SVG;
    g.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || st.drag) return;
      e.preventDefault();
      e.stopPropagation();
      const r = c.getBoundingClientRect();
      st.drag = { start: Number(c.dataset.start), x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, on: false, text: text(), before: snap(),
        dx: e.clientX - r.left, dy: e.clientY - r.top, gaps: [], target: null, tabKey: "", tabTimer: null, raf: 0 };
      document.addEventListener("pointermove", onDragMove, true);
      document.addEventListener("pointerup", onDragUp, true);
      document.addEventListener("pointercancel", cancelDrag, true);
      window.addEventListener("blur", cancelDrag);
    });
    return g;
  }

  function beginDrag() {
    closePopup();
    closeMap();
    st.drag.on = true;
    if (st.tcell) {
      commitCell();
      st.tcell = null;
      render();
    }
    if (st.active >= 0) {
      st.active = -1;
      render(); // the cell is drawn without its text box first, so the copy that follows the pointer looks rendered
    }
    const src = st.doc.querySelector(`.cell[data-start="${st.drag.start}"]`);
    if (src) {
      const r = src.getBoundingClientRect();
      const ghost = document.createElement("div");
      ghost.className = "note nd-ghost";
      ghost.style.width = `${Math.min(r.width, 560)}px`;
      const copy = src.cloneNode(true);
      copy.classList.remove("cell-active", "cell-dragging");
      ghost.append(copy);
      root.append(ghost);
      st.drag.ghost = ghost;
      st.drag.dx = Math.min(st.drag.dx, 40);
    }
    wrap.classList.add("nd-on");
    dragRefresh();
    const tick = () => {
      if (!st.drag?.on) return;
      const br = st.body.getBoundingClientRect();
      const edge = 56;
      const v = st.drag.ly < br.top + edge ? -(br.top + edge - st.drag.ly) : st.drag.ly > br.bottom - edge ? st.drag.ly - (br.bottom - edge) : 0;
      if (v) {
        const before = st.body.scrollTop;
        st.body.scrollTop += Math.max(-24, Math.min(24, v / 2.5));
        if (st.body.scrollTop !== before) aim();
      }
      st.drag.raf = requestAnimationFrame(tick);
    };
    st.drag.raf = requestAnimationFrame(tick);
  }

  // After every render while dragging: dim the cell, measure where each gap is drawn, aim again.
  function dragRefresh() {
    st.doc.querySelector(`.cell[data-start="${st.drag.start}"]`)?.classList.add("cell-dragging");
    const { meta, cells } = model();
    const pr = page.getBoundingClientRect();
    const els = [...st.doc.children].filter((el) => el.dataset.a !== undefined).map((el) => {
      const r = el.getBoundingClientRect();
      return { a: Number(el.dataset.a), b: Number(el.dataset.b), top: r.top - pr.top, bottom: r.bottom - pr.top, el };
    });
    st.drag.idx = cells.at[st.drag.start];
    st.drag.gaps = cellGaps(st.lines, meta, cells).filter((g) => pathVisible(g.path, st.sel)).map((gap) => {
      const own = els.find((x) => x.a === gap.g); // an empty route's "start writing" line stands for its gap
      if (own) return { gap, y: (own.top + own.bottom) / 2, zone: own.el };
      let prev = null;
      let next = null;
      for (const x of els) {
        if (x.b < gap.g) prev = x;
        else if (x.a > gap.g) {
          next = x;
          break;
        }
      }
      const y = prev && next ? (prev.bottom + next.top) / 2 : prev ? prev.bottom + 4 : next ? next.top - 4 : 0;
      return { gap, y };
    });
    aim();
  }

  function onDragMove(e) {
    if (!st.drag) return;
    st.drag.lx = e.clientX;
    st.drag.ly = e.clientY;
    if (!st.drag.on) {
      if (Math.hypot(e.clientX - st.drag.x, e.clientY - st.drag.y) < 4) return;
      beginDrag();
    }
    e.preventDefault();
    if (st.drag.ghost) {
      st.drag.ghost.style.left = `${e.clientX - st.drag.dx}px`;
      st.drag.ghost.style.top = `${e.clientY - Math.min(st.drag.dy, 18)}px`;
    }
    aim();
  }

  // Pick the target under the pointer: a route tab, else the nearest gap; then draw it.
  function aim() {
    if (!st.drag?.on) return;
    const hit = document.elementFromPoint(st.drag.lx, st.drag.ly);
    const tab = hit?.closest?.(".nb-tab[data-route]");
    const bar = tab?.closest(".nb-fork");
    if (tab && bar) {
      const key = `${bar.dataset.fork}\u0000${tab.dataset.route}`;
      st.drag.target = { tab: { fork: bar.dataset.fork, route: tab.dataset.route } };
      if (st.drag.tabKey !== key) {
        st.drag.tabKey = key;
        clearTimeout(st.drag.tabTimer);
        if (tab.getAttribute("aria-selected") !== "true") {
          st.drag.tabTimer = setTimeout(() => {
            if (!st.drag?.on) return;
            const fork = model().meta.forks.find((f) => f.key === st.drag.target?.tab?.fork);
            const route = fork?.routes.find((r) => r.name === st.drag.target?.tab?.route);
            if (!route) return;
            selectRoute(fork, route);
            render(); // dragRefresh() runs at its end
          }, 450);
        }
      }
    } else {
      st.drag.tabKey = "";
      clearTimeout(st.drag.tabTimer);
      const y = st.drag.ly - page.getBoundingClientRect().top;
      let best = null;
      for (const g of st.drag.gaps) if (!best || Math.abs(g.y - y) < Math.abs(best.y - y)) best = g;
      st.drag.target = best && !gapTouches(best.gap, st.drag.idx) ? best : null;
    }
    drawTarget();
  }

  function drawTarget() {
    for (const el of st.doc.querySelectorAll(".nb-tab-drop, .nd-into")) el.classList.remove("nb-tab-drop", "nd-into");
    dropLine.hidden = true;
    dropZone.hidden = true;
    const t = st.drag?.target;
    if (!t) return;
    let forkKey = "";
    let routeName = "";
    let label = "共用內容";
    if (t.tab) {
      forkKey = t.tab.fork;
      routeName = t.tab.route;
      const fork = model().meta.forks.find((f) => f.key === forkKey);
      label = `${fork?.name ?? ""} › ${routeName}（最後）`;
      const last = st.drag.gaps.filter((g) => g.gap.path.length && g.gap.path[g.gap.path.length - 1].fork.key === forkKey
        && g.gap.path[g.gap.path.length - 1].route.name === routeName).pop();
      if (last) showLine(last, label);
    } else {
      const path = t.gap.path;
      if (path.length) {
        forkKey = path[path.length - 1].fork.key;
        routeName = path[path.length - 1].route.name;
      }
      label = placeName(path);
      showLine(t, label);
      t.zone?.classList.add("nd-into");
    }
    dropLine.style.setProperty("--nd-c", forkKey ? "var(--n-c-branch)" : "var(--n-accent)");
    if (!forkKey) return;
    const head = [...st.doc.querySelectorAll(".cell-branch[data-fork]")].find((el) => el.dataset.fork === forkKey);
    const end = [...st.doc.querySelectorAll("[data-fork-end]")].find((el) => el.dataset.forkEnd === forkKey);
    if (head) {
      const pr = page.getBoundingClientRect();
      const top = head.getBoundingClientRect().top - pr.top - 6;
      const bottom = (end ?? head).getBoundingClientRect().bottom - pr.top + 4;
      dropZone.style.top = `${top}px`;
      dropZone.style.height = `${Math.max(24, bottom - top)}px`;
      dropZone.hidden = false;
      for (const tab of head.querySelectorAll(".nb-tab[data-route]")) if (tab.dataset.route === routeName) tab.classList.add("nb-tab-drop");
    }
  }
  function showLine(g, label) {
    dropLine.style.top = `${g.y}px`;
    dropTag.textContent = `放進：${label}`;
    dropLine.hidden = false;
  }

  function endDrag() {
    const d = st.drag;
    st.drag = null;
    if (!d) return null;
    document.removeEventListener("pointermove", onDragMove, true);
    document.removeEventListener("pointerup", onDragUp, true);
    document.removeEventListener("pointercancel", cancelDrag, true);
    window.removeEventListener("blur", cancelDrag);
    clearTimeout(d.tabTimer);
    cancelAnimationFrame(d.raf);
    d.ghost?.remove();
    wrap.classList.remove("nd-on");
    dropLine.hidden = true;
    dropZone.hidden = true;
    for (const el of st.doc.querySelectorAll(".cell-dragging, .nb-tab-drop, .nd-into")) el.classList.remove("cell-dragging", "nb-tab-drop", "nd-into");
    return d;
  }
  function cancelDrag() {
    const d = endDrag();
    if (d?.on) render();
  }

  function onDragUp(e) {
    if (!st.drag) return;
    e.preventDefault();
    const d = endDrag();
    if (!d.on) return;
    const t = d.target;
    if (!t || d.text !== text()) return render();
    let m = model();
    let gap = t.gap;
    if (t.tab) {
      const fork = m.meta.forks.find((f) => f.key === t.tab.fork);
      const route = fork?.routes.find((r) => r.name === t.tab.route);
      if (!route) return render();
      selectRoute(fork, route);
      m = model();
      gap = cellGaps(st.lines, m.meta, m.cells).filter((g) => g.path.length && g.path[g.path.length - 1].fork.key === t.tab.fork
        && g.path[g.path.length - 1].route.name === t.tab.route).pop();
    }
    const idx = m.cells.at[d.start];
    const res = idx >= 0 && gap ? moveCellTo(st.lines, m.cells.runs, idx, gap) : { error: "放不進這裡" };
    if (res.error || res.same) {
      if (res.error) flash(res.error);
      return render();
    }
    changed();
    record(d.before);
    st.active = -1;
    render();
    flashCell(res.start);
    flash(`已移到「${placeName(gap.path)}」 · ⌘Z 復原`);
  }

  // Briefly light up the cell that holds line `start` (after a move) and bring it into view.
  function flashCell(start) {
    const { cells } = model();
    const idx = cells.at[start];
    const r = idx >= 0 ? cells.runs[idx] : null;
    const el = r && st.doc.querySelector(`.cell[data-start="${r.start}"]`);
    if (!el) return;
    el.classList.add("cell-dropped");
    el.scrollIntoView({ block: "nearest" });
  }
  Object.assign(api, {
    shownMarkdown, stepDown, stepUp, startSel, clearSel, selectAllFrom, isQuoteKey, onSelMove, onSelUp, onSelAll, drawSel,
    cellAsk, cellGrip, dragRefresh, cancelDrag, flashCell,
  });
}
