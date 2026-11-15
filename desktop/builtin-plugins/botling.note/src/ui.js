// botling.note, web part: a line editor with live markdown rendering.
// Every line is shown rendered except the one the cursor is in, which is a plain text box.
// Data goes only through the program part (src/host.ts -> api.notes.*); images only through ./assets.js.
// Colors come only from the app's theme variables, so light/dark follows the app live.

import { initAssets, importImage, localizeNote, IMAGE_API_AVAILABLE } from "./assets.js";
import {
  chosenRoute, pathVisible, routeIsEmpty, childForks, blockRange, routeFacts,
} from "./branch.js";
import {
  tableAt,
} from "./table.js";
import { cardAt } from "./cardsrc.js";
import { VIEW, SAVE_MS, POLL_MS } from "./ui-css.js";
import {
  openHref, hrefAt, inline, classify, mathBlockEl, QUOTE_LEAD, quoteOfLine, QUOTE_STEP, quoteBars, joinQuotes,
  drawLine, svg, FORK_SVG,
} from "./ui-text.js";
import { install as installInsert } from "./ui-insert.js";
import { install as installTable } from "./ui-table.js";
import { install as installCards } from "./ui-cards.js";
import { install as installDrag } from "./ui-drag.js";
export { inline, classify };

function mount(root, ccb) {
  const st = { botId: ccb.context?.botId ?? "" }; // the editor state (parts 1 and 2: the document, the selection, the view, popups, tables, cards, drag, map)
  const api = { root, ccb }; // what the parts of mount hand to each other: each part's `install` registers its names here
  installInsert(st, api);
  const {
    wrap, status, crumb, boardBtn, warn, kept, page, fileInput, fitFrame, pinFrame, viewNow, flushView, saveView,
    saveSel, restorePos, setStatus, showState, text, setText, grow, model, checkCut, prevEditable, nextEditable,
    lastEditable, selectRoute, migrate, refork, closePopup, openPopup, movePopup, syncInsertMenu, undos, look, snap,
    record, onUndoKey, placeName, TYPE_LABEL, TYPE_ITEMS, runOf,
  } = api;
  installTable(st, api);
  const {
    moveCell, deleteCell, convertCell, cellBar, cellKey, branchAt, newRouteIn, pickRoute, commitRename, endOf, routeMenu,
    commitCell, enterCell, goLine, tableEl, cardLayer, views, cardKeyOf,
  } = api;
  installCards(st, api);
  const {
    cardEl, afterCards, syncSoon, stopTimer, relayout, onCardMsg, cardPicker, drawBoard, closeBoard, askCell, askFork,
  } = api;
  installDrag(st, api);
  const {
    shownMarkdown, stepDown, stepUp, startSel, clearSel, selectAllFrom, isQuoteKey, onSelMove, onSelUp, onSelAll, drawSel,
    cellAsk, cellGrip, dragRefresh, cancelDrag, flashCell,
  } = api;

  // ---- drawing the branch pieces ----
  function forkBar(fork, meta) {
    const bar = document.createElement("div");
    bar.className = "nb-fork";
    bar.dataset.fork = fork.key;
    const chosen = chosenRoute(fork, st.sel);
    const editing = st.edit && st.edit.fkey === fork.key ? st.edit : null;
    const done = { v: false };
    const input = (value, label, onCommit, onCancel) => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "nb-input";
      inp.value = value;
      inp.setAttribute("aria-label", label);
      inp.style.width = `${Math.max(7, Math.min(28, [...value].length + 2))}ch`;
      inp.addEventListener("input", () => {
        inp.style.width = `${Math.max(7, Math.min(28, [...inp.value].length + 2))}ch`;
      });
      inp.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          if (!done.v) { done.v = true; onCommit(inp.value); }
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (!done.v) { done.v = true; onCancel(); }
        }
      });
      inp.addEventListener("blur", () => {
        if (!done.v && !st.gone) { done.v = true; onCommit(inp.value); }
      });
      inp.addEventListener("mousedown", (e) => e.stopPropagation());
      queueMicrotask(() => {
        inp.focus();
        inp.select();
      });
      return inp;
    };
    const after = editing?.after;
    const cancel = () => {
      st.edit = null;
      if (typeof after === "number" && after < st.lines.length) activate(after, 0);
      else render();
    };

    if (editing && editing.route === null) {
      const lab = document.createElement("span");
      lab.className = "nb-fl";
      lab.innerHTML = FORK_SVG;
      lab.append(input(fork.name, "分叉名稱", (v) => commitRename(fork, null, v, after), cancel));
      bar.append(lab);
    } else {
      const lab = document.createElement("button");
      lab.type = "button";
      lab.className = "nb-fl";
      lab.title = "點一下改分叉名稱";
      lab.innerHTML = FORK_SVG;
      lab.append(document.createTextNode(fork.name));
      lab.addEventListener("click", () => {
        st.edit = { fkey: fork.key, route: null };
        render();
      });
      bar.append(lab);
    }

    const tabs = document.createElement("div");
    tabs.className = "nb-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", `${fork.name}的路線`);
    for (const route of fork.routes) {
      if (editing && editing.route === route.name) {
        const holder = document.createElement("span");
        holder.className = "nb-tab";
        holder.setAttribute("aria-selected", "true");
        holder.append(input(route.name, "路線名稱", (v) => commitRename(fork, route, v, after), cancel));
        tabs.append(holder);
        continue;
      }
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "nb-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(route === chosen));
      tab.title = "雙擊或右鍵可以改名、刪除；拖一格到這裡放進這條路線";
      tab.dataset.route = route.name;
      tab.append(document.createTextNode(route.name));
      const nested = childForks(meta, route);
      if (nested.length) {
        const c = document.createElement("span");
        c.className = "nb-cnt";
        c.textContent = `⑂ ${nested.reduce((a, f) => a + f.routes.length, 0)}`;
        tab.append(c);
      }
      tab.addEventListener("click", () => pickRoute(fork, route));
      tab.addEventListener("dblclick", (e) => {
        e.preventDefault();
        st.edit = { fkey: fork.key, route: route.name };
        render();
      });
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        routeMenu(fork, route, tab.getBoundingClientRect());
      });
      tabs.append(tab);
    }
    bar.append(tabs);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "nb-add";
    add.textContent = "+";
    add.title = "新增路線";
    add.setAttribute("aria-label", "新增路線");
    add.addEventListener("click", () => newRouteIn(fork));
    bar.append(add);
    return bar;
  }

  function emptyRouteEl(fork, route) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nb-empty";
    b.textContent = "這條路線還是空的 · 點一下開始寫";
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", () => {
      if (route.start < route.end) return activate(route.start, 0);
      st.lines.splice(route.start, 0, "");
      changed();
      activate(route.start, 0);
    });
    return b;
  }

  function forkEndEl(fork) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nb-end";
    b.textContent = "分叉結束 · 往下是所有路線共用的內容";
    b.title = `「${fork.name}」到此結束，點一下在這之後接著寫`;
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", () => endOf(fork));
    return b;
  }

  // ---- the route overview (the map of every fork and route) ----
  function crumbText(meta) {
    const parts = [];
    for (const f of childForks(meta, null)) {
      const r = chosenRoute(f, st.sel);
      const before = parts.length;
      parts.push(`${f.name} › ${r.name}`);
      const nested = [];
      const walk = (route) => {
        const kids = childForks(meta, route);
        if (!kids.length) return;
        const rr = chosenRoute(kids[0], st.sel);
        nested.push(rr.name);
        walk(rr);
      };
      walk(r);
      if (nested.length) parts[before] += ` › ${nested.join(" › ")}`;
    }
    return parts.join(" · ");
  }

  // The overview hangs under the route button, fixed to the frame's viewport, in the panel root (not inside .note).
  function placeMap() {
    if (!st.mapEl) return;
    const r = crumb.getBoundingClientRect();
    const w = st.mapEl.offsetWidth;
    st.mapEl.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    st.mapEl.style.top = `${r.bottom + 6}px`;
    st.mapEl.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 24)}px`;
  }
  function closeMap() {
    st.mapEl?.remove();
    st.mapEl = null;
    crumb.setAttribute("aria-expanded", "false");
  }
  function goRoute(route) {
    for (const e of route.fork.parentPath) selectRoute(e.fork, e.route);
    selectRoute(route.fork, route);
    st.active = -1;
    closeMap();
    closePopup();
    render();
    const key = route.fork.key;
    for (const bar of st.doc.querySelectorAll(".nb-fork")) {
      if (bar.dataset.fork === key) bar.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  function drawMap() {
    const { meta } = model();
    const map = document.createElement("nav");
    map.className = "nb-map";
    map.setAttribute("aria-label", "分支總覽");
    const node = (label, metaText, opts = {}) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nb-node${opts.on ? " on" : ""}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      if (opts.glyph) {
        dot.className = "";
        dot.textContent = opts.glyph;
        dot.style.color = "var(--n-faint)";
      }
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = label;
      const mt = document.createElement("span");
      mt.className = "meta";
      mt.textContent = metaText;
      b.append(dot, nm, mt);
      b.addEventListener("click", opts.run);
      return b;
    };
    const heading = st.lines.map((l) => /^#{1,6}\s+(.*)$/.exec(l)).find(Boolean);
    map.append(node("共用開頭", heading ? `標題 · ${heading[1].slice(0, 18)}` : "", { glyph: "≡", run: () => { closeMap(); st.active = -1; render(); st.body.scrollTo({ top: 0, behavior: "smooth" }); } }));
    const here = new Set();
    for (const f of meta.forks) {
      const r = chosenRoute(f, st.sel);
      if (pathVisible(f.parentPath, st.sel)) here.add(r);
    }
    const drawForks = (parent, into) => {
      for (const f of childForks(meta, parent)) {
        const head = document.createElement("div");
        head.className = "nb-fk";
        head.innerHTML = FORK_SVG;
        head.append(document.createTextNode(`${f.name} · ${f.routes.length} 條路線`));
        into.append(head);
        const kids = document.createElement("div");
        kids.className = "nb-kids";
        for (const r of f.routes) {
          const facts = routeFacts(st.lines, r);
          const bits = [];
          if (routeIsEmpty(st.lines, r)) bits.push("空白");
          else {
            if (facts.cards) bits.push(`${facts.cards} 張卡片`);
            if (facts.todos) bits.push(`${facts.todos} 個待辦`);
            if (!facts.cards && !facts.todos) bits.push(`${facts.content} 行`);
          }
          const deeper = childForks(meta, r).some((c) => here.has(chosenRoute(c, st.sel)) && pathVisible(c.parentPath, st.sel));
          const on = here.has(r);
          if (on && !deeper) bits.unshift("你在這裡");
          kids.append(node(r.name, bits.join(" · "), { on, run: () => goRoute(r) }));
          drawForks(r, kids);
        }
        into.append(kids);
      }
    };
    drawForks(null, map);
    const hint = document.createElement("div");
    hint.className = "nb-maphint";
    hint.textContent = "點一條路線：切過去並捲到分叉處。分頁上雙擊或按右鍵可以改名、刪除。";
    map.append(hint);
    return map;
  }
  function toggleMap() {
    if (st.mapEl) return closeMap();
    st.mapEl = drawMap();
    root.append(st.mapEl);
    placeMap();
    crumb.setAttribute("aria-expanded", "true");
  }
  crumb.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMap();
  });
  const onDocDown = (e) => {
    if (st.mapEl && !st.mapEl.contains(e.target) && !crumb.contains(e.target)) closeMap();
    if (st.popup && st.popup.kind !== "insert" && !st.popup.el.contains(e.target)) closePopup();
  };
  const onEsc = (e) => {
    if (e.key !== "Escape") return;
    if (st.drag) {
      e.preventDefault();
      e.stopPropagation();
      cancelDrag();
      return;
    }
    if (st.mapEl) closeMap();
    else if (st.popup && st.popup.kind !== "insert") closePopup();
    else if (st.boardOpen) {
      e.preventDefault();
      closeBoard();
    }
  };
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onEsc);
  window.addEventListener("resize", placeMap);

  function render() {
    st.doc.textContent = "";
    const { info, meta, vis, editable, cells } = model();
    st.renderingKeys = cardKeyOf(info);
    if (st.active >= 0 && !editable(st.active)) st.active = -1;
    if (st.active >= 0) st.tcell = null;
    if (st.msel && (st.active >= 0 || st.tcell || Math.max(st.msel.anchor, st.msel.head) >= st.lines.length)) st.msel = null;
    if (st.tcell && !(info[st.tcell.start]?.kind === "table" && info[st.tcell.start].start === st.tcell.start && vis(st.tcell.start))) st.tcell = null;
    if (st.active < 0 && st.popup?.kind === "insert") closePopup();
    const inBlock = st.active >= 0 && info[st.active].kind !== "text" ? info[st.active] : null;

    const ends = new Map();
    for (const f of meta.forks) ends.set(f.endLine, [...(ends.get(f.endLine) ?? []), f]);
    for (const list of ends.values()) list.sort((a, b) => b.depth - a.depth);

    // One block per cell (a run of lines between `cell` / branch / route / end-branch lines). A run of only blank lines
    // is drawn only when `cell` lines made it a cell, it holds the cursor, or it is the whole note.
    const shown = (r) => !r.empty || r.aboveCell || r.belowCell || (st.active >= r.start && st.active <= r.end) || cells.runs.length === 1;
    let cur = null; // { idx, el }
    const openCell = (idx) => {
      const r = cells.runs[idx];
      const c = document.createElement("div");
      c.className = `cell cell-${r.type}`;
      c.dataset.type = r.type;
      c.dataset.start = String(r.start);
      c.dataset.end = String(r.end);
      c.dataset.a = String(r.start);
      c.dataset.b = String(r.end);
      c.append(cellAsk(() => askCell(c)), cellGrip(c), cellBar(c));
      // a click on the cell's own padding (not on a line) edits its last line
      c.addEventListener("mousedown", (e) => {
        if (e.target !== c) return;
        e.preventDefault();
        const j = r.last >= 0 ? r.last : r.start;
        activate(j, st.lines[j].length);
      });
      st.doc.append(c);
      cur = { idx, el: c };
    };
    const put = (el, isActive) => {
      cur.el.append(el);
      if (isActive) cur.el.classList.add("cell-active");
    };

    for (let i = 0; i <= st.lines.length; i++) {
      for (const f of ends.get(i) ?? []) {
        if (!pathVisible(f.parentPath, st.sel)) continue;
        cur = null;
        const end = forkEndEl(f);
        end.dataset.forkEnd = f.key;
        end.dataset.a = end.dataset.b = String(i);
        st.doc.append(end);
      }
      if (i === st.lines.length) break;
      const at = meta.at[i];
      if (!vis(i)) continue;
      if (at.marker === "branch") {
        cur = null;
        const c = document.createElement("div");
        c.className = "cell cell-branch";
        c.dataset.type = "branch";
        c.dataset.fork = at.fork.key;
        c.dataset.a = c.dataset.b = String(i);
        c.append(cellAsk(() => askFork(at.fork)), forkBar(at.fork, meta));
        st.doc.append(c);
        const r = chosenRoute(at.fork, st.sel);
        if (routeIsEmpty(st.lines, r) && !(st.active >= r.start && st.active < r.end)) {
          const empty = emptyRouteEl(at.fork, r);
          empty.dataset.a = empty.dataset.b = String(r.start - 0.5); // where the route's only gap is (cells.js cellGaps)
          st.doc.append(empty);
        }
        continue;
      }
      const idx = cells.at[i];
      if (idx < 0) { cur = null; continue; } // a `cell` / route / end-branch line: the gap between two cells
      const run = cells.runs[idx];
      if (!shown(run)) continue;
      if (!cur || cur.idx !== idx) openCell(idx);
      const line = st.lines[i];
      const nfo = info[i];
      const blank = !line.trim() && nfo.kind === "text" && i !== st.active;
      // the one blank line next to the cell's top / bottom boundary takes no room (the blank around a `<!-- cell -->` line);
      // any other blank line, at the edge or not, takes a whole line, as typed
      const edge = blank && !run.empty && ((i === run.start && i < run.first) || (i === run.end && i > run.last));
      const raw = !!inBlock && nfo.kind !== "text" && nfo.start === inBlock.start;
      if (i === st.active) {
        const holder = document.createElement("div");
        holder.className = "nl nl-active";
        holder.dataset.i = String(i);
        const ta = document.createElement("textarea");
        ta.rows = 1;
        ta.spellcheck = false;
        ta.value = line;
        const quoteBox = () => {
          // a quote line being edited keeps its bars, so the quote around it stays one piece; its `>`s stay as typed
          const d = info[i].kind === "text" ? quoteOfLine(ta.value).depth : 0;
          if (Number(holder.dataset.qd || 0) === d) return;
          quoteBars(holder, d);
          holder.style.paddingLeft = "";
          ta.style.paddingLeft = d ? `${d * QUOTE_STEP + 2}px` : "";
          joinQuotes(holder.parentElement ?? st.doc);
        };
        ta.addEventListener("input", () => {
          const parts = ta.value.split("\n");
          if (parts.length > 1) {
            st.lines.splice(i, 1, ...parts);
            // the caret stays where it is (Shift+Enter splits at it; a paste ends after the pasted text)
            let k = 0;
            let off = ta.selectionStart ?? ta.value.length;
            while (k < parts.length - 1 && off > parts[k].length) { off -= parts[k].length + 1; k++; }
            st.active = i + k;
            st.caret = off;
            changed();
            render();
            return;
          }
          st.lines[i] = ta.value;
          quoteBox();
          grow(ta);
          changed();
          if (st.tail && st.tail.line === i && undos[undos.length - 1] === st.tail.rec) st.tail.rec.after = look(); // typing: saved as typing is
          if (info[i].kind === "text") syncInsertMenu(ta);
        });
        ta.addEventListener("keydown", (e) => keydown(e, ta, i));
        ta.addEventListener("click", (e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          const href = hrefAt(ta.value, ta.selectionStart ?? 0);
          if (!href) return;
          e.preventDefault();
          openHref(ccb, st.botId, href);
        });
        ta.addEventListener("blur", () => {
          // Leaving the box for somewhere outside the note: render the line.
          setTimeout(() => {
            if (!st.gone && st.active === i && !root.contains(document.activeElement)) {
              st.active = -1;
              render();
            }
          }, 0);
        });
        holder.append(ta);
        put(holder, true);
        quoteBox();
        queueMicrotask(() => {
          ta.focus();
          const pos = Math.min(st.caret, ta.value.length);
          ta.setSelectionRange(pos, pos);
          grow(ta);
          if (st.popup?.kind === "insert") {
            const r = ta.getBoundingClientRect();
            st.popup.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - st.popup.el.offsetWidth - 8))}px`;
            st.popup.el.style.top = `${r.bottom + 4 + st.popup.el.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - st.popup.el.offsetHeight - 4) : r.bottom + 4}px`;
          }
        });
      } else if (nfo.kind === "card" && !raw) {
        if (i !== nfo.start) continue; // the whole card is drawn at its first line
        put(cardEl(nfo.start, nfo.end, nfo.card), false);
      } else if (nfo.kind === "table" && !raw) {
        if (i !== nfo.start) continue; // the whole table is drawn at its first line
        const tb = tableEl(nfo.start, nfo.end);
        tb.dataset.j = String(nfo.end);
        put(tb, !!(st.tcell && st.tcell.start === nfo.start));
      } else if (nfo.kind === "mathb" && !raw) {
        if (i !== nfo.start) continue; // the whole block is drawn at its first line
        const el = mathBlockEl(st.lines, nfo.start, nfo.end);
        el.dataset.i = String(nfo.start);
        el.dataset.j = String(nfo.end);
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          activate(nfo.start, st.lines[nfo.start].length);
        });
        put(el, false);
      } else {
        const el = drawLine(line, nfo, i, (index, on) => {
          st.lines[index] = st.lines[index].replace(/\[([ xX])\]/, on ? "[x]" : "[ ]");
          changed();
          render();
        }, raw);
        if (edge) el.classList.add("nl-edge");
        if (blank && run.empty) el.classList.add("nl-only");
        if (i === run.first) el.classList.add("nl-first");
        el.addEventListener("mousedown", (e) => {
          if (e.target.closest("a")) return;
          e.preventDefault();
          activate(i, st.lines[i].length);
        });
        put(el, false);
      }
    }

    // the route button in the status bar, and the overview if it is open
    const crumbStr = crumbText(meta);
    crumb.hidden = !meta.forks.length;
    crumb.textContent = "";
    crumb.insertAdjacentHTML("afterbegin", FORK_SVG);
    const label = document.createElement("span");
    label.textContent = `路線：${crumbStr}`;
    crumb.append(label);
    crumb.title = crumbStr;
    crumb.setAttribute("aria-haspopup", "true");
    if (!meta.forks.length && st.mapEl) closeMap();
    else if (st.mapEl) {
      const fresh = drawMap();
      st.mapEl.replaceWith(fresh);
      st.mapEl = fresh;
      placeMap();
    }
    joinQuotes(st.doc);
    drawSel({ info, meta, vis, editable, cells });
    afterCards(info, vis);
    if (st.boardOpen) drawBoard();
    if (st.active >= 0) {
      st.lastLine = st.active;
      st.lastCaret = st.caret;
      st.wasEditing = true;
    } else if (st.tcell || st.msel) st.wasEditing = false;
    if (st.viewReady) saveView();
    if (st.drag?.on) dragRefresh();
  }

  function activate(i, at) {
    clearSel();
    if (st.tcell) {
      commitCell();
      st.tcell = null;
    }
    st.active = Math.max(0, Math.min(st.lines.length - 1, i));
    st.caret = at;
    render();
  }

  function keydown(e, ta, i) {
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (e.isComposing) return;
    if (st.popup?.kind === "insert") {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        movePopup(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const s = st.popup.items[st.popup.idx];
        if (s && !s.it.disabled) s.it.run();
        else if (s) s.it.onDisabled?.();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        st.dismissed = true;
        st.plusMode = false;
        closePopup();
        return;
      }
    }
    const cellEl = ta.closest(".cell");
    if (cellEl && cellEl.dataset.type !== "branch" && cellKey(e, cellEl)) {
      e.preventDefault();
      return;
    }
    if (isQuoteKey(e) && classify(st.lines)[i].kind === "text") {
      e.preventDefault();
      const pos = ta.selectionStart ?? 0;
      const had = ta.value.match(QUOTE_LEAD)?.[0] ?? "";
      const before = snap();
      st.lines[i] = had ? ta.value.slice(had.length) : `> ${ta.value}`;
      changed();
      record(before);
      activate(i, Math.max(0, pos + (had ? -had.length : 2)));
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      if (classify(st.lines)[i].kind === "text") branchAt(i);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllFrom(i); // the cell; again: the whole note
      return;
    }
    if (e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      // from the first / last row of the line on: whole lines
      const down = e.key === "ArrowDown";
      const one = ta.scrollHeight <= ta.clientHeight + 4;
      if (one || (down ? ta.selectionEnd === ta.value.length : ta.selectionStart === 0)) {
        const h = down ? stepDown(i) : stepUp(i);
        if (h >= 0) {
          e.preventDefault();
          startSel(i, h);
        }
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const at = ta.selectionStart;
      const before = ta.value.slice(0, at);
      let after = ta.value.slice(ta.selectionEnd);
      // keep a list going
      const li = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(before);
      let lead = "";
      if (li && !/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?$/.test(before) && !classifyIn(i)) {
        const marker = /\d/.test(li[2]) ? `${parseInt(li[2], 10) + 1}${li[2].slice(-1)}` : li[2];
        lead = `${li[1]}${marker} ${li[3] ? "[ ] " : ""}`;
      } else if (li && /^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?$/.test(before)) {
        st.lines[i] = ""; // Enter on an empty list item ends the list
        after = ta.value.slice(ta.selectionEnd);
        st.lines.splice(i + 1, 0, after);
        changed();
        activate(i + 1, 0);
        return;
      }
      st.lines[i] = before;
      st.lines.splice(i + 1, 0, lead + after);
      changed();
      activate(i + 1, lead.length);
    } else if (e.key === "Backspace" && atStart && i > 0) {
      e.preventDefault();
      const m = model();
      const run = m.cells.runs[m.cells.at[i]];
      if (!st.lines[i] && run && run.aboveCell && run.start === i && run.end === i) {
        // an empty cell of one line: Backspace removes the cell (and its `cell` line), like Jupyter's merge up
        st.lines.splice(i - 1, 2);
        changed();
        const p = prevEditable(i - 1);
        if (p >= 0) activate(p, st.lines[p].length);
        else { st.active = -1; render(); }
        return;
      }
      if (m.info[i - 1].kind === "table" && m.info[i].kind === "text") {
        if (!st.lines[i]) {
          st.lines.splice(i, 1);
          changed();
          goLine(i - 1, 0, true);
        }
      } else if (m.editable(i - 1)) {
        const at = st.lines[i - 1].length;
        st.lines.splice(i - 1, 2, st.lines[i - 1] + st.lines[i]);
        changed();
        activate(i - 1, at);
      } else if (!st.lines[i] && prevEditable(i) >= 0) {
        // next to a branch marker: only an empty line can be removed
        const p = prevEditable(i);
        st.lines.splice(i, 1);
        changed();
        activate(p, st.lines[p].length);
      }
    } else if (e.key === "Delete" && atEnd && i < st.lines.length - 1) {
      e.preventDefault();
      const ki = classify(st.lines);
      if (model().editable(i + 1) && (ki[i + 1].kind !== "table" || ki[i].kind !== "text")) {
        const at = st.lines[i].length;
        st.lines.splice(i, 2, st.lines[i] + st.lines[i + 1]);
        changed();
        activate(i, at);
      }
    } else if (e.key === "ArrowUp" && !e.shiftKey && i > 0 && ta.value.slice(0, ta.selectionStart).indexOf("\n") === -1 && ta.scrollHeight <= ta.clientHeight + 4) {
      const p = prevEditable(i);
      if (p < 0) return;
      e.preventDefault();
      goLine(p, Math.min(ta.selectionStart, st.lines[p].length), true);
    } else if (e.key === "ArrowDown" && !e.shiftKey && i < st.lines.length - 1 && ta.scrollHeight <= ta.clientHeight + 4) {
      const n = nextEditable(i);
      if (n < 0) return;
      e.preventDefault();
      goLine(n, Math.min(ta.selectionStart, st.lines[n].length), false);
    } else if (e.key === "ArrowLeft" && atStart && i > 0) {
      const p = prevEditable(i);
      if (p < 0) return;
      e.preventDefault();
      activate(p, st.lines[p].length);
    } else if (e.key === "ArrowRight" && atEnd && i < st.lines.length - 1) {
      const n = nextEditable(i);
      if (n < 0) return;
      e.preventDefault();
      activate(n, 0);
    } else if (e.key === "Escape") {
      e.preventDefault();
      st.active = -1;
      render();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const at = ta.selectionStart;
      st.lines[i] = e.shiftKey ? st.lines[i].replace(/^ {1,2}/, "") : `  ${st.lines[i]}`;
      changed();
      activate(i, Math.max(0, at + (e.shiftKey ? -Math.min(2, (ta.value.match(/^ */)?.[0].length ?? 0)) : 2)));
    }
  }
  // Paste / drop of an image goes through the adapter (./assets.js): file -> ref, inserted as a line.
  const imageFiles = (dt) => [...(dt?.files ?? [])].filter((f) => /^image\//.test(f.type));
  st.notice = null;
  const flash = (msg) => {
    setStatus(msg);
    clearTimeout(st.notice);
    st.notice = setTimeout(() => !st.gone && showState(st.state), 4000);
  };
  st.imageAt = -1; // where the "圖片" menu item wants the picture
  async function addImages(files, startAt) {
    let at = typeof startAt === "number" && startAt >= 0 ? startAt : st.active >= 0 ? st.active : Math.max(0, lastEditable());
    for (const file of files) {
      try {
        const ref = await importImage(file);
        if (st.gone) return;
        at = Math.max(0, Math.min(at, st.lines.length - 1));
        const md = `![${(file.name || "").replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "")}](${ref})`;
        if (!st.lines[at].trim()) st.lines[at] = md;
        else st.lines.splice(++at, 0, md);
        st.active = -1;
        changed();
        render();
      } catch (error) {
        flash(IMAGE_API_AVAILABLE ? "Could not add the image." : "Adding images needs a newer Botling (2.6.0+).");
      }
    }
  }
  fileInput.addEventListener("change", () => {
    const files = imageFiles({ files: fileInput.files });
    fileInput.value = "";
    const at = st.imageAt;
    st.imageAt = -1;
    if (files.length) addImages(files, at);
  });
  st.body.addEventListener("paste", (e) => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  });
  st.body.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  st.body.addEventListener("drop", (e) => {
    const files = imageFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  });

  const classifyIn = (i) => classify(st.lines)[i].kind !== "text";

  // Rendered links open on a plain click (the line is not being edited); Cmd/Ctrl+click inside the edited line is on its textarea.
  st.body.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || !st.body.contains(a)) return;
    e.preventDefault();
    openHref(ccb, st.botId, a.getAttribute("href"));
  });

  st.body.addEventListener("mousedown", (e) => {
    if (e.target === st.body || e.target === st.doc || e.target === page) {
      e.preventDefault();
      const last = lastEditable();
      if (last >= 0) goLine(last, st.lines[last].length, true);
    }
  });

  function changed() {
    st.dirty = true;
    showState("dirty");
    clearTimeout(st.timer);
    st.timer = setTimeout(flush, SAVE_MS);
  }

  st.soon = false; // a save was asked for while one was on its way: the next one goes right after it
  async function flush() {
    clearTimeout(st.timer);
    if (st.saving && st.dirty) st.soon = true;
    if (!st.dirty || st.saving || !st.loaded || st.gone) return;
    st.saving = true;
    const sent = text();
    st.dirty = false;
    showState("saving");
    try {
      const res = await ccb.host.call("write", { botId: st.botId, text: sent, base: st.mtime });
      if (res.saved) {
        st.mtime = res.mtime;
        if (!st.dirty) showState("saved");
        if (!st.dirty) checkCut(sent);
      } else {
        // The note changed on disk since we read it.
        st.dirty = true;
        conflict(res.text, res.mtime);
      }
    } catch (error) {
      st.dirty = true;
      showState("error");
    } finally {
      st.saving = false;
      const next = st.soon;
      st.soon = false;
      if (st.dirty && warn.hidden && st.state !== "error") st.timer = setTimeout(flush, next ? 0 : SAVE_MS);
    }
  }

  function conflict(theirs, theirMtime) {
    clearTimeout(st.timer);
    warn.hidden = false;
    warn.textContent = "This note was changed somewhere else. ";
    const load = document.createElement("button");
    load.textContent = "Load their version";
    load.onclick = () => {
      warn.hidden = true;
      st.mtime = theirMtime;
      st.dirty = false;
      setText(theirs);
      st.active = -1;
      render();
      showState("saved");
    };
    const keep = document.createElement("button");
    keep.textContent = "Keep mine";
    keep.onclick = () => {
      warn.hidden = true;
      st.mtime = theirMtime;
      st.dirty = true;
      flush();
    };
    warn.append(load, keep);
    showState("dirty");
  }

  async function load(initial) {
    try {
      const view = initial ? ccb.host.call("viewGet", { botId: st.botId }).catch(() => null) : null;
      const note = await ccb.host.call("read", { botId: st.botId });
      if (initial) {
        const v = await view;
        if (v && typeof v === "object") {
          if (v.routes && typeof v.routes === "object" && !Array.isArray(v.routes)) st.sel = { ...v.routes };
          if (v.pos && typeof v.pos === "object") st.pos = v.pos;
          if (v.folds && typeof v.folds === "object" && !Array.isArray(v.folds)) st.folds = { ...v.folds };
        }
      }
      if (st.gone) return;
      if (!initial && (note.mtime === st.mtime || st.dirty || st.saving || st.drag)) return; // mid-drag: the next poll picks it up
      st.mtime = note.mtime;
      setText(note.text);
      st.loaded = true;
      checkCut(text());
      if (initial) st.active = -1;
      if (st.active >= st.lines.length) st.active = -1;
      render();
      showState("saved");
      if (initial) {
        restorePos();
        st.viewReady = true;
        st.viewSent = JSON.stringify(viewNow());
        localize();
      }
    } catch (error) {
      if (initial) setStatus("Could not read the note.", { label: "Retry", run: () => load(true) });
    }
  }

  // Old notes with absolute-path / file:// pictures: the app copies them in and rewrites the links.
  async function localize() {
    const base = st.mtime;
    const res = await localizeNote(base);
    if (!res || st.gone || st.dirty || st.saving || st.mtime !== base) return;
    st.mtime = res.mtime;
    setText(res.text);
    if (st.active >= st.lines.length) st.active = -1;
    render();
  }

  // The names the parts read through `api` (after the last definition: a const arrow function does not hoist).
  Object.assign(api, {
    render, activate, flash, changed, flush, closeMap,
  });
  // Others edit the note (the bot, an editor): the app says so with noteChanged; polling is the fallback.
  const offs = [];
  if (typeof ccb.on === "function") {
    const off = ccb.on("noteChanged", (data) => {
      if (data?.botId && st.botId && data.botId !== st.botId) return;
      if (data && typeof data.mtime === "number" && data.mtime === st.mtime) return;
      load(false);
    });
    if (typeof off === "function") offs.push(off);
  }
  // note.md was edited from an older copy of a cell: the app kept note.db and saved that edit aside as `file`
  if (typeof ccb.on === "function") {
    const off = ccb.on("noteConflict", (d) => {
      if (d?.botId && st.botId && d.botId !== st.botId) return;
      kept.textContent = `note.md 裡有一段改動是改在舊版內容上，沒能存進筆記；那份改動另存在 ${d?.file || "（App 沒說檔名）"}，需要的話打開來對照。`;
      if (d?.reason) kept.title = String(d.reason);
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "知道了";
      ok.onclick = () => {
        kept.hidden = true;
      };
      kept.append(ok);
      kept.hidden = false;
      load(false);
    });
    if (typeof off === "function") offs.push(off);
  }
  // a card's command ran (or its state changed): fetch the cards' states again
  if (typeof ccb.on === "function") {
    const off = ccb.on("noteCardChanged", (d) => {
      if (d?.botId && st.botId && d.botId !== st.botId) return;
      syncSoon(80);
    });
    if (typeof off === "function") offs.push(off);
  }
  const poll = setInterval(() => load(false), POLL_MS);
  const hide = () => {
    flush();
    flushView();
  };
  st.body.addEventListener("scroll", saveView, { passive: true });
  st.body.addEventListener("keyup", saveView);
  st.body.addEventListener("mouseup", saveView);
  window.addEventListener("pagehide", hide);
  document.addEventListener("visibilitychange", hide);

  initAssets(ccb, st.botId);
  showState("loading");
  load(true);

  return () => {
    flushView();
    st.gone = true;
    flush();
    clearInterval(poll);
    clearTimeout(st.cardTimer);
    for (const v of views.values()) stopTimer(v);
    views.clear();
    cardLayer.remove();
    relayout.disconnect();
    window.removeEventListener("message", onCardMsg);
    clearTimeout(st.timer);
    clearTimeout(st.notice);
    for (const off of offs) off();
    window.removeEventListener("pagehide", hide);
    document.removeEventListener("visibilitychange", hide);
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onEsc);
    document.removeEventListener("keydown", onUndoKey, true);
    window.removeEventListener("resize", placeMap);
    window.removeEventListener("resize", fitFrame);
    document.removeEventListener("mousemove", onSelMove);
    document.removeEventListener("mouseup", onSelUp);
    document.removeEventListener("keydown", onSelAll);
    window.removeEventListener("scroll", pinFrame);
    cancelDrag();
    closePopup();
    closeMap();
    wrap.remove();
    for (const id of ["botling-note-katex", "botling-note-css"]) document.getElementById(id)?.remove();
  };
}

export function activate(ccb) {
  ccb.panels.register(VIEW, (root) => mount(root, ccb));
}
