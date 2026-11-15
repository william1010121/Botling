// botling.note, web part: a line editor with live markdown rendering.
// Every line is shown rendered except the one the cursor is in, which is a plain text box.
// Data goes only through the program part (src/host.ts -> api.notes.*); images only through ./assets.js.
// Colors come only from the app's theme variables, so light/dark follows the app live.

import katexCss from "./katex-style.ts";
import { initAssets, importImage, srcFor, localizeNote, rememberAsset, IMAGE_API_AVAILABLE } from "./assets.js";
import {
  parseBranches, chosenRoute, pathVisible, routeIsEmpty, childForks, blockRange, branchFrom, addRoute, endFork,
  renameFork, renameRoute, deleteRoute, routeFacts, cleanName,
} from "./branch.js";
import {
  isCellLine, CELL_LINE, cellRuns, splitCell, mergeBelow, insertCellBelow, moveCell as moveCellIn, deleteCell as deleteCellIn, convertCell as convertCellIn,
  cellGaps, gapTouches, moveCellTo,
} from "./cells.js";
import {
  tableAt, parseTable, serializeTable, cellText, cellRaw, getCell, setCell, insertRow, deleteRow, insertCol, deleteCol, newTable,
} from "./table.js";
import { cardAt, showLine as cardLine } from "./cardsrc.js";
import { createBoard, boardTree, BOARD_CSS } from "./board.js";
import { VIEW, SAVE_MS, POLL_MS, CSS } from "./ui-css.js";
import {
  openHref, hrefAt, inline, hydrateImages, classify, mathBlockEl, QUOTE_LEAD, quoteOfLine, QUOTE_STEP, quoteBars, joinQuotes,
  drawLine, svg, ASK_SVG, FORK_SVG, ICONS, INSERT_ITEMS,
} from "./ui-text.js";
export { inline, classify };

function mount(root, ccb) {
  const st = { botId: ccb.context?.botId ?? "" }; // the editor state (parts 1 and 2: the document, the selection, the view, popups, tables, cards, drag, map)
  for (const [id, css] of [["botling-note-katex", katexCss], ["botling-note-css", CSS + BOARD_CSS]]) {
    document.getElementById(id)?.remove();
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.append(style);
  }

  const wrap = document.createElement("div");
  wrap.className = "note";
  const status = document.createElement("div");
  status.className = "note-status";
  const crumb = document.createElement("button");
  crumb.type = "button";
  crumb.className = "nb-crumb";
  crumb.hidden = true;
  const statusText = document.createElement("span");
  statusText.className = "nb-st";
  const boardTitle = document.createElement("span");
  boardTitle.className = "nb-btitle";
  boardTitle.innerHTML = "<b>白板預覽</b><span>只能看 · 雙擊卡片跳到那一格</span>";
  const boardSep = document.createElement("span");
  boardSep.className = "nb-sep";
  boardSep.setAttribute("aria-hidden", "true");
  const boardBtn = document.createElement("button");
  boardBtn.type = "button";
  boardBtn.className = "nb-board";
  boardBtn.setAttribute("aria-pressed", "false");
  boardBtn.title = "白板預覽：把這份 Note 畫成由上往下的流程（再按一次或 Esc 回來）";
  boardBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2" width="5" height="4" rx="1"></rect><rect x="9.5" y="2" width="5" height="4" rx="1"></rect><rect x="5.5" y="10" width="5" height="4" rx="1"></rect><path d="M4 6v2h8V6M8 8v2"></path></svg><span>白板</span><kbd>Esc</kbd>';
  status.append(boardTitle, crumb, statusText, boardSep, boardBtn);
  const warn = document.createElement("div");
  warn.className = "note-warn";
  warn.hidden = true;
  const kept = document.createElement("div"); // noteConflict: an edit in note.md the app could not take in, kept aside
  kept.className = "note-warn note-kept";
  kept.hidden = true;
  st.body = document.createElement("div");
  st.body.className = "note-body";
  const page = document.createElement("div");
  page.className = "note-page";
  st.doc = document.createElement("div");
  st.doc.className = "note-doc";
  page.append(st.doc);
  st.body.append(page);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  wrap.append(status, warn, kept, st.body, fileInput);
  st.folds = {}; // whiteboard: the branches folded into one card (fork key -> true); kept with the view, never in note.md
  root.append(wrap);
  // The note is 100vh tall, but the frame around it may add padding: shrink by the overflow so the frame itself never
  // scrolls (a scrolled frame hides the status bar), and pin the frame's own scroll at 0 if anything nudges it.
  const fitFrame = () => {
    wrap.style.height = "";
    const over = (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight;
    if (over > 0) wrap.style.height = `calc(100vh - ${over}px)`;
  };
  const pinFrame = () => {
    const se = document.scrollingElement;
    if (se && se.scrollTop) se.scrollTop = 0;
  };
  fitFrame();
  window.addEventListener("resize", fitFrame);
  window.addEventListener("scroll", pinFrame);

  st.lines = [""];
  st.active = -1; // the line the cursor is in; -1: none
  st.caret = 0;
  st.mtime = 0;
  st.dirty = false;
  st.saving = false;
  st.loaded = false;
  st.timer = null;
  st.gone = false;
  st.state = "loading";

  // Which route of each fork is shown: `sel` maps fork.key -> route name. A nested fork's key holds its parent fork's key
  // and route ("層1#1/A>層2#1"), so it is a next[node] pointer per route: switching a fork changes only its own entry, and
  // switching back finds the deeper choices made there before. What is shown is the walk from the top along these
  // (branch.js pathVisible / chosenRoute); a renamed or deleted route falls back to the fork's first route.
  // The app keeps it with the line / scroll (program part: viewGet / viewSet, ccb.storage), never in note.md. The frame is
  // usually sandboxed (no localStorage); localStorage is only a fallback for an app without plugin storage.
  const SEL_KEY = `botling.note.routes.${st.botId}`;
  const POS_KEY = `botling.note.pos.${st.botId}`;
  st.sel = {};
  st.pos = null; // where the reader was, restored once on open: { line, caret, scroll, editing, text }
  try {
    const raw = JSON.parse(localStorage.getItem(SEL_KEY) ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) st.sel = raw;
    st.pos = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
  } catch {
    st.sel = {};
  }
  st.viewTimer = null;
  st.viewReady = false; // the stored view has been read (nothing is written before that)
  st.lastLine = -1; // the line last edited, its caret, and whether a line was being edited (focus leaving the frame
  st.lastCaret = 0; // closes the line editor; reopening still puts the cursor back)
  st.wasEditing = false;
  st.viewSent = "";
  function viewNow() {
    const ta = st.doc.querySelector(".nl-active textarea");
    if (ta) st.lastCaret = ta.selectionStart ?? st.caret;
    const line = Math.max(0, Math.min(st.lines.length - 1, st.active >= 0 ? st.active : st.tcell ? st.tcell.start : st.lastLine));
    return {
      routes: st.sel,
      folds: st.folds,
      pos: { line, caret: st.lastCaret, scroll: Math.round(st.body.scrollTop), editing: st.wasEditing && !st.tcell && !st.msel, text: st.lines[line] ?? "" },
    };
  }
  async function flushView() {
    clearTimeout(st.viewTimer);
    if (!st.viewReady || !st.loaded) return;
    const v = viewNow();
    const s = JSON.stringify(v);
    if (s === st.viewSent) return;
    st.viewSent = s;
    try {
      localStorage.setItem(SEL_KEY, JSON.stringify(v.routes));
      localStorage.setItem(POS_KEY, JSON.stringify(v.pos));
    } catch {
      /* sandboxed frame / blocked storage: the app keeps it */
    }
    try {
      await ccb.host.call("viewSet", { botId: st.botId, view: v });
    } catch {
      /* an app without plugin storage: only localStorage (if any) remembers */
    }
  }
  const saveView = () => {
    clearTimeout(st.viewTimer);
    st.viewTimer = setTimeout(flushView, 500);
  };
  const saveSel = () => saveView();
  // Back to where the reader was: the same line (found again by its text if lines moved), its caret, the scroll.
  function restorePos() {
    const p = st.pos;
    st.pos = null;
    if (!p || typeof p !== "object") return;
    let line = Math.min(Number(p.line) || 0, st.lines.length - 1);
    if (typeof p.text === "string" && st.lines[line] !== p.text) {
      let best = -1;
      for (let k = 0; k < st.lines.length; k++) if (st.lines[k] === p.text && (best < 0 || Math.abs(k - line) < Math.abs(best - line))) best = k;
      if (best >= 0) line = best;
    }
    const m = model();
    if (p.editing && m.editable(line) && m.info[line].kind === "text") activate(line, Math.min(Number(p.caret) || 0, st.lines[line].length));
    st.lastLine = line;
    const top = Number(p.scroll) || 0;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!st.gone) st.body.scrollTop = top;
    }));
  }

  st.edit = null; // an inline rename: { fkey, route: name | null (the fork's own name) }
  st.popup = null; // { el, kind: "insert" | "menu", items, idx }
  st.mapEl = null; // the overview panel
  st.menuLine = -1; // the line the insert menu belongs to
  st.plusMode = false; // the menu was opened with "+" (an empty line), not by typing "/"
  st.dismissed = false; // Esc closed the "/" menu; stays closed until the text stops being a slash command

  const setStatus = (text, action) => {
    statusText.textContent = text;
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      b.onclick = action.run;
      statusText.append(b);
    }
  };
  const showState = (s) => {
    st.state = s;
    setStatus(s === "saved" ? "Saved" : s === "dirty" ? "Editing…" : s === "saving" ? "Saving…" : s === "error" ? "Could not save" : "Loading…",
      s === "error" ? { label: "Retry", run: () => flush() } : undefined);
  };

  const text = () => st.lines.join("\n");
  const setText = (t) => {
    st.lines = t.replace(/\r\n?/g, "\n").split("\n");
  };

  const grow = (ta) => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  // ---- the document model: what each line is, and which lines the chosen routes show ----
  function model() {
    const info = classify(st.lines);
    const meta = parseBranches(st.lines, info);
    const vis = (i) => pathVisible(meta.at[i].path, st.sel);
    const editable = (i) => i >= 0 && i < st.lines.length && meta.at[i].marker === null && !(info[i].kind === "text" && isCellLine(st.lines[i])) && vis(i);
    let cells = cellRuns(st.lines, info, meta);
    if (st.appCut && st.appCut.text === text()) cells = st.appCut.cells;
    return { info, meta, vis, editable, cells };
  }
  // The app (note.db) is where cells are cut: src/note-cells.ts is its rules, bundled unchanged, so drawing stays instant.
  // After a read and after each save the app is asked how it cuts that same text (notes.parse `cells` / `branches`); if
  // its cells differ (the app moved on to newer rules than this copy), its cells are drawn while the text stays the same.
  // An app without these fields (older) answers null: ours are used.
  st.appCut = null; // { text, cells: { runs, at } }
  st.cutWarned = false;
  const runKey = (r) => [r.start, r.end, r.above, r.below, !!r.softAbove, !!r.softBelow, !!r.aboveCell, !!r.belowCell, r.first, r.last, !!r.empty, r.type].join(",");
  async function checkCut(sent) {
    let res = null;
    try {
      res = await ccb.host.call("parse", { botId: st.botId, text: sent });
    } catch {}
    if (st.gone || !res || !Array.isArray(res.cells) || text() !== sent) return;
    const n = st.lines.length;
    const runs = res.cells;
    let ok = true;
    let prev = -1;
    for (const r of runs) {
      if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start <= prev || r.end < r.start || r.end >= n || typeof r.type !== "string") ok = false;
      if (!ok) break;
      prev = r.end;
    }
    const info = classify(st.lines);
    const meta = parseBranches(st.lines, info);
    const ours = cellRuns(st.lines, info, meta);
    const same = ours.runs.length === runs.length && ours.runs.every((r, k) => runKey(r) === runKey(runs[k]));
    if (Array.isArray(res.branches)) {
      const fk = (f) => [f.key, f.start, f.endLine, f.depth, ...f.routes.map((r) => [r.name, r.marker, r.start, r.end, !!r.implicit].join(":"))].join("|");
      const theirs = res.branches.map(fk).join("\n");
      if (theirs !== meta.forks.map(fk).join("\n") && !st.cutWarned) {
        st.cutWarned = true;
        console.warn("botling.note: the app reads the branches of this note differently from the bundled note-cells.ts (an app of another version)");
      }
    }
    const had = st.appCut;
    if (same || !ok) {
      st.appCut = null;
    } else {
      const at = new Array(n).fill(-1);
      runs.forEach((r, k) => {
        for (let i = r.start; i <= r.end; i++) at[i] = k;
      });
      st.appCut = { text: sent, cells: { runs: runs.map((r) => ({ ...r })), at } };
      if (!st.cutWarned) {
        st.cutWarned = true;
        console.warn("botling.note: the app cuts this note into cells differently from the bundled note-cells.ts (an app of another version); drawing the app's cells");
      }
    }
    if ((had || st.appCut) && !st.drag && !st.msel) render();
  }
  const prevEditable = (i) => {
    const m = model();
    for (let j = i - 1; j >= 0; j--) if (m.editable(j)) return j;
    return -1;
  };
  const nextEditable = (i) => {
    const m = model();
    for (let j = i + 1; j < st.lines.length; j++) if (m.editable(j)) return j;
    return -1;
  };
  const lastEditable = () => {
    const m = model();
    for (let j = st.lines.length - 1; j >= 0; j--) if (m.editable(j)) return j;
    return -1;
  };

  const selectRoute = (fork, route) => {
    st.sel[fork.key] = route.name;
    saveSel();
  };
  // Rename keeps the remembered choices: keys that start with the old fork / route path move to the new one.
  const migrate = (from, to) => {
    if (from === to) return;
    for (const k of Object.keys(st.sel)) {
      const nk = k === from || k.startsWith(`${from}/`) ? to + k.slice(from.length) : k;
      if (nk !== k) {
        st.sel[nk] = st.sel[k];
        delete st.sel[k];
      }
    }
    saveSel();
  };

  // The same fork (by its key) in the lines as they are now.
  const refork = (fork) => model().meta.forks.find((f) => f.key === fork.key) ?? null;

  // ---- popups (insert menu, block menu, route menu) ----
  function closePopup() {
    if (st.popup) st.popup.el.remove();
    st.popup = null;
  }
  function openPopup(kind, rect, items) {
    closePopup();
    const el = document.createElement("div");
    el.className = "nb-menu";
    el.setAttribute("role", "menu");
    const shown = [];
    items.forEach((it) => {
      if (it.sep) {
        const sep = document.createElement("div");
        sep.className = "nb-sep";
        el.append(sep);
        return;
      }
      if (it.head) {
        const h = document.createElement("div");
        h.className = "nb-mh";
        h.textContent = it.head;
        el.append(h);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nb-mi${it.danger ? " danger" : ""}`;
      b.setAttribute("role", "menuitem");
      if (it.disabled) b.disabled = true;
      if (it.ic) {
        const ic = document.createElement("span");
        ic.className = "ic";
        ic.innerHTML = it.ic;
        b.append(ic);
      }
      const lb = document.createElement("span");
      lb.className = "lb";
      lb.textContent = it.label;
      b.append(lb);
      if (it.hint) {
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = it.hint;
        b.append(k);
      }
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor where it is
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (it.disabled) return it.onDisabled?.();
        it.run();
      });
      el.append(b);
      shown.push({ it, b });
    });
    root.append(el); // outside .note: its own top layer, never under the document
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    const below = rect.bottom + 4;
    el.style.left = `${left}px`;
    el.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 4) : below}px`;
    st.popup = { el, kind, items: shown, idx: Math.max(0, shown.findIndex((s) => !s.it.disabled)) };
    markPopup();
  }
  function markPopup() {
    if (!st.popup) return;
    st.popup.items.forEach((s, n) => s.b.setAttribute("aria-selected", String(n === st.popup.idx && st.popup.kind === "insert")));
    st.popup.items[st.popup.idx]?.b.scrollIntoView?.({ block: "nearest" });
  }
  function movePopup(d) {
    if (!st.popup) return;
    const n = st.popup.items.length;
    for (let k = 1; k <= n; k++) {
      const j = (st.popup.idx + d * k + n * k) % n;
      if (!st.popup.items[j].it.disabled) {
        st.popup.idx = j;
        break;
      }
    }
    markPopup();
  }

  // ---- the insert menu: "/" at the start of a line, or the "+" button ----
  function insertItems(query) {
    const q = query.trim().toLowerCase();
    return INSERT_ITEMS.filter((it) => !q || `${it.label} ${it.keys} ${it.id}`.toLowerCase().includes(q));
  }
  function syncInsertMenu(ta) {
    const val = ta.value;
    const slash = /^\/\S*$/.test(val);
    if (!slash) st.dismissed = false;
    const want = !st.dismissed && (slash || (st.plusMode && val === ""));
    if (!want) {
      if (!slash) st.plusMode = false;
      if (st.popup?.kind === "insert") closePopup();
      st.menuLine = -1;
      return;
    }
    const items = insertItems(slash ? val.slice(1) : "");
    if (!items.length) {
      if (st.popup?.kind === "insert") closePopup();
      return;
    }
    const keep = st.popup?.kind === "insert" ? st.popup.items[st.popup.idx]?.it.id : null;
    st.menuLine = st.active;
    openPopup("insert", ta.getBoundingClientRect(), [
      { head: "基本" },
      ...items.map((it) => ({ ...it, run: () => applyInsert(it.id, st.active) })),
    ]);
    const at = st.popup.items.findIndex((s) => s.it.id === keep && !s.it.disabled);
    if (at >= 0) st.popup.idx = at;
    markPopup();
  }

  function applyInsert(id, i) {
    closePopup();
    st.plusMode = false;
    st.menuLine = -1;
    if (i < 0 || i >= st.lines.length) return;
    const level = /^h([1-3])$/.exec(id);
    if (level) {
      st.lines[i] = `${"#".repeat(+level[1])} `;
      changed();
      activate(i, st.lines[i].length);
    } else if (id === "todo") {
      st.lines[i] = "- [ ] ";
      changed();
      activate(i, st.lines[i].length);
    } else if (id === "code") {
      st.lines.splice(i, 1, "```", "", "```");
      changed();
      activate(i + 1, 0);
    } else if (id === "math") {
      st.lines.splice(i, 1, "$$", "", "$$");
      changed();
      activate(i + 1, 0);
    } else if (id === "image") {
      st.lines[i] = "";
      changed();
      activate(i, 0);
      st.imageAt = i;
      fileInput.click();
    } else if (id === "branch") {
      st.lines[i] = "";
      changed();
      branchAt(i);
    } else if (id === "card") {
      st.lines[i] = ""; // the "/卡片" text is not part of what was there before
      changed();
      cardPicker(i);
    } else if (id === "table") {
      const b = snap();
      st.lines[i] = ""; // the "/table" text is not part of what was there before
      b.text = text();
      st.lines.splice(i, 1, ...newTable(3, 2));
      changed();
      record(b);
      enterCell(i, -1, 0, true);
    }
  }

  // ---- undo for edits that move whole pieces (drag, move, split, merge, insert, delete, change type, delete route) ----
  // Typing keeps the text box's own undo. These edits keep { before, after } snapshots (text and shown routes); Cmd/Ctrl+Z
  // takes the last one back only while the note is exactly as that edit left it, otherwise the key does what it always does.
  const undos = [];
  const redos = [];
  // A structural edit (move, split, merge, drag...) first saves what was typed before it, and is saved right after: note.db
  // keeps a cell's id by its text, so an edit and a move of the same cell are best two saves, not one.
  const look = () => ({ text: text(), sel: JSON.stringify(st.sel) });
  const snap = () => {
    if (st.dirty && st.loaded && !st.gone && warn.hidden && st.state !== "error") flush();
    return look();
  };
  st.tail = null; // { rec, line }: typing right after an edit over a selection joins that edit's undo step
  const record = (before) => {
    st.tail = null;
    if (text() === before.text) return;
    undos.push({ before, after: snap() });
    if (undos.length > 100) undos.shift();
    redos.length = 0;
  };
  function undoStep(redo) {
    const from = redo ? redos : undos;
    const top = from[from.length - 1];
    if (!top || (redo ? top.before : top.after).text !== text()) return false;
    from.pop();
    (redo ? undos : redos).push(top);
    const to = redo ? top.after : top.before;
    setText(to.text);
    try {
      const v = JSON.parse(to.sel);
      if (v && typeof v === "object") st.sel = v;
    } catch {
      /* keep the routes shown now */
    }
    saveSel();
    st.active = -1;
    st.tcell = null;
    st.msel = null;
    closePopup();
    changed();
    render();
    flash(redo ? "已重做（⌘⇧Z）" : "已復原（⌘Z）");
    return true;
  }
  const onUndoKey = (e) => {
    if (e.isComposing || e.altKey || !(e.metaKey || e.ctrlKey) || (e.key ?? "").toLowerCase() !== "z" || st.drag || st.boardOpen) return;
    if (undoStep(e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", onUndoKey, true);

  // "共用內容" or "分支 › 路線" for where a gap / cell is.
  const placeName = (path) => (path.length ? `${path[path.length - 1].fork.name} › ${path[path.length - 1].route.name}` : "共用內容");

  // ---- cells: a cell is a whole chunk of Markdown, cut by `<!-- cell -->` lines (./cells.js) ----
  const TYPE_LABEL = { markdown: "Markdown", code: "程式碼", math: "數學", card: "卡片", table: "表格" };
  const TYPE_ITEMS = [
    { id: "markdown", ic: "M↓", label: "Markdown", hint: "⌘⌥0" },
    { id: "code", ic: "{ }", label: "程式碼", hint: "⌘⌥C" },
    { id: "math", ic: "∑", label: "數學", hint: "⌘⌥M" },
    { id: "card", ic: ICONS.card, label: "卡片", hint: "用 / 卡片 插入", disabled: true },
  ];
  // The run (from ./cells.js) a drawn cell stands for, in the lines as they are now.
  const runOf = (c) => {
    const { cells } = model();
    const idx = cells.at[Number(c.dataset.start)];
    return idx >= 0 ? { idx, run: cells.runs[idx], runs: cells.runs } : null;
  };
  // Where the cursor is now: the edited line and the caret inside it (the textarea knows it better than `caret`).
  const cursorNow = () => {
    const ta = st.doc.querySelector(".nl-active textarea");
    return st.active >= 0 ? { i: st.active, pos: ta ? ta.selectionStart ?? st.caret : st.caret } : null;
  };
  const after = (res) => {
    closePopup();
    if (res.error) return flash(res.error);
    changed();
    activate(Math.max(0, Math.min(res.at, st.lines.length - 1)), res.caret ?? 0);
  };

  function splitAtCursor(c) {
    const cur = cursorNow();
    const got = runOf(c);
    if (!got) return;
    if (!cur || cur.i < got.run.start || cur.i > got.run.end) return flash("先在這一格裡點一下，把游標放在要切開的地方（⌃⇧-）");
    const b = snap();
    after(splitCell(st.lines, classify(st.lines), got.run, cur.i, cur.pos));
    record(b);
  }
  function mergeCell(c) {
    const got = runOf(c);
    if (!got) return;
    const b = snap();
    after(mergeBelow(st.lines, got.run));
    record(b);
  }
  function insertBelow(c, withMenu) {
    const got = runOf(c);
    if (!got) return;
    closePopup();
    const b = snap();
    const res = insertCellBelow(st.lines, got.run);
    changed();
    record(b);
    st.plusMode = !!withMenu;
    activate(res.at, 0);
    if (withMenu) {
      queueMicrotask(() => {
        const ta = st.doc.querySelector("textarea");
        if (ta && st.active === res.at) syncInsertMenu(ta);
      });
    }
  }
  // Up / down (toolbar ↑ ↓, ⌥↑ ⌥↓): swap with the neighbouring cell, or, at a region's edge, go to the next place a drag could
  // put it: out of a route into the shared text around the fork, into the top / bottom of the route the next fork shows.
  function moveCell(c, dir) {
    const got = runOf(c);
    if (!got) return;
    closePopup();
    const { run } = got;
    const b = snap();
    const was = st.active >= run.start && st.active <= run.end ? st.active : -1;
    let base = run.start;
    let res = moveCellIn(st.lines, got.runs, got.idx, dir);
    let into = "";
    if (!res.error) res.end = res.start + run.end - run.start;
    else {
      const m = model();
      const gaps = cellGaps(st.lines, m.meta, m.cells).filter((g) => pathVisible(g.path, st.sel));
      const p = gaps.findIndex((g) => g.next === got.idx);
      const target = p < 0 ? null : gaps[dir < 0 ? p - 1 : p + 2];
      if (!target) return flash(dir < 0 ? "已經是最上面一格" : "已經是最下面一格");
      const from = gaps[p].path;
      res = moveCellTo(st.lines, m.cells.runs, got.idx, target);
      if (res.error) return flash(res.error);
      base = run.first >= 0 ? run.first : run.start;
      if (placeName(from) !== placeName(target.path) || from.length !== target.path.length) into = placeName(target.path);
    }
    changed();
    record(b);
    if (into) flash(`已移到「${into}」 · ⌘Z 復原`);
    if (was >= 0) activate(Math.max(res.start, Math.min(res.end ?? res.start, res.start + (was - base))), st.caret);
    else {
      st.active = -1;
      render();
      flashCell(res.start);
    }
  }
  function deleteCell(c, keepFlow) {
    const got = runOf(c);
    if (!got) return;
    closePopup();
    const b = snap();
    const res = deleteCellIn(st.lines, got.run);
    changed();
    record(b);
    if (keepFlow) activate(Math.min(res.at, st.lines.length - 1), 0);
    else {
      st.active = -1;
      render();
    }
  }
  function convertCell(c, to) {
    const got = runOf(c);
    if (!got) return;
    const b = snap();
    after(convertCellIn(st.lines, got.run, to));
    record(b);
  }

  function typeMenu(c, rect) {
    const now = c.dataset.type;
    openPopup("menu", rect, [
      { head: "把這一格變成" },
      ...TYPE_ITEMS.map((it) => ({
        ...it,
        hint: it.id === now ? "✓" : it.hint,
        run: () => convertCell(c, it.id),
        onDisabled: () => flash("卡片要等 Botling 提供卡片 API 才能用。"),
      })),
    ]);
  }

  // The cell's toolbar on its top border, right side (hover or active), as in Jupyter.
  function cellBar(c) {
    const bar = document.createElement("div");
    bar.className = "cell-bar";
    const btn = (cls, label, title, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the cursor where it is
        e.stopPropagation();
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(b);
      });
      bar.append(b);
      return b;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "cb-sep";
      bar.append(s);
    };
    const t = btn("cb-type", "", "改變這一格的型態", (b) => typeMenu(c, b.getBoundingClientRect()));
    t.textContent = `${TYPE_LABEL[c.dataset.type] ?? "Markdown"} ▾`;
    sep();
    btn("cb-split", "✂", "在游標處切開（⌃⇧-）", () => splitAtCursor(c));
    btn("cb-merge", "⤓", "和下一格合併（⌃⇧M）", () => mergeCell(c));
    sep();
    btn("", "↑", "上移（⌥↑）", () => moveCell(c, -1));
    btn("", "↓", "下移（⌥↓）", () => moveCell(c, 1));
    btn("", "＋", "在下面新增一格（⌥↵）", () => insertBelow(c, true));
    btn("cb-del", "🗑", "刪除這一格（⌘⇧⌫）", () => deleteCell(c, false));
    btn("", "⋯", "更多", (b) => blockMenu(c, b.getBoundingClientRect()));
    return bar;
  }

  // Jupyter-like keys while a cell is being edited. Ctrl+Shift / Alt / Cmd+Alt combos only, so normal typing is never touched.
  function cellKey(e, c) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
      if (e.code === "Minus") return splitAtCursor(c), true;
      if (e.code === "KeyM") return mergeCell(c), true;
    }
    if (e.altKey && !mod && !e.shiftKey) {
      if (e.key === "ArrowUp") return moveCell(c, -1), true;
      if (e.key === "ArrowDown") return moveCell(c, 1), true;
      if (e.key === "Enter") return insertBelow(c, false), true;
    }
    if (mod && e.shiftKey && !e.altKey && (e.key === "Backspace" || e.key === "Delete")) return deleteCell(c, true), true;
    if (mod && e.altKey && !e.shiftKey) {
      const to = { Digit0: "markdown", KeyC: "code", KeyM: "math" }[e.code];
      if (to) return convertCell(c, to), true;
    }
    return false;
  }
  // ---- branches ----
  function branchAt(i) {
    const m = model();
    if (!m.editable(i)) return;
    const res = branchFrom(st.lines, m.meta, m.info, i);
    changed();
    const fork = parseBranches(st.lines, classify(st.lines)).forks.find((f) => f.start === res.start);
    if (fork) {
      selectRoute(fork, fork.routes.find((r) => r.name === res.newRoute) ?? fork.routes[fork.routes.length - 1]);
      st.edit = { fkey: fork.key, route: res.newRoute, after: res.blank };
    }
    st.active = -1;
    render();
  }
  function newRouteIn(stale) {
    const fork = refork(stale);
    if (!fork) return render();
    const res = addRoute(st.lines, fork);
    changed();
    const nf = parseBranches(st.lines, classify(st.lines)).forks.find((f) => f.start === fork.start);
    if (nf) {
      selectRoute(nf, nf.routes.find((r) => r.name === res.name) ?? nf.routes[nf.routes.length - 1]);
      st.edit = { fkey: nf.key, route: res.name, after: res.blank };
    }
    st.active = -1;
    render();
  }
  function pickRoute(fork, route) {
    selectRoute(fork, route);
    st.active = -1;
    closePopup();
    render();
  }
  function commitRename(stale, staleRoute, value, after) {
    st.edit = null;
    const fork = refork(stale);
    const route = staleRoute ? fork?.routes.find((r) => r.name === staleRoute.name) : null;
    if (!fork || (staleRoute && !route)) return render();
    const name = cleanName(value);
    const old = route ? route.name : fork.name;
    if (name && name !== old) {
      if (route) {
        const wasSelected = chosenRoute(fork, st.sel) === route;
        renameRoute(st.lines, fork, route, name);
        migrate(`${fork.key}/${old}>`, `${fork.key}/${name}>`);
        if (wasSelected) st.sel[fork.key] = name;
        saveSel();
      } else {
        renameFork(st.lines, fork, name);
        const nf = parseBranches(st.lines, classify(st.lines)).forks.find((f) => f.start === fork.start);
        if (nf) migrate(fork.key, nf.key);
      }
      changed();
    }
    if (typeof after === "number" && after < st.lines.length) activate(after, 0);
    else render();
  }
  function endOf(stale) {
    const fork = refork(stale);
    if (!fork) return render();
    const at = endFork(st.lines, fork);
    changed();
    activate(at, 0);
  }
  function routeMenu(fork, route, rect) {
    const n = route.end - (route.marker >= 0 ? route.marker : route.start);
    openPopup("menu", rect, [
      { ic: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), label: "改名", run: () => { closePopup(); st.edit = { fkey: fork.key, route: route.name }; render(); } },
      { ic: ICONS.trash, label: fork.routes.length > 1 ? "刪除這條路線…" : "刪除整個分叉…", danger: true, run: () => {
        openPopup("menu", rect, [
          { head: `${fork.routes.length > 1 ? `「${route.name}」` : "整個分叉"}與裡面的 ${Math.max(0, n - 1)} 行會被刪掉` },
          { ic: ICONS.trash, label: "確定刪除", danger: true, run: () => {
            closePopup();
            const f = refork(fork);
            const r = f?.routes.find((x) => x.name === route.name);
            if (!f || !r) return render();
            const b = snap();
            deleteRoute(st.lines, f, r);
            changed();
            record(b);
            st.active = -1;
            render();
          } },
          { label: "取消", run: closePopup },
        ]);
      } },
    ]);
  }
  function blockMenu(c, rect) {
    const start = Number(c.dataset.start);
    openPopup("menu", rect, [
      { ic: "✂", label: "在游標處切開", hint: "⌃⇧-", run: () => splitAtCursor(c) },
      { ic: "⤓", label: "和下一格合併", hint: "⌃⇧M", run: () => mergeCell(c) },
      { ic: ICONS.plus, label: "在下面新增一格…", hint: "⌥↵", run: () => { closePopup(); insertBelow(c, true); } },
      { ic: ICONS.branch, label: "從這裡分支", hint: "⌘⇧B", run: () => { closePopup(); branchAt(start); } },
      { sep: true },
      { ic: ICONS.trash, label: "刪除這一格", hint: "⌘⇧⌫", danger: true, run: () => { closePopup(); deleteCell(c, false); } },
    ]);
  }

  // ---- tables: drawn as tables; a clicked cell is edited in place (./table.js keeps the pipe text) ----
  // tcell: the table cell being edited { start (the table's first line), r (-1 = header), c, before (undo snapshot) }.
  // Typing rewrites only that table, tidy (padded columns), and only once something is typed: a table nobody edits
  // keeps its bytes. Each cell's typing is one undo step (Cmd+Z), as is each add / delete / align.
  st.tcell = null;
  st.tHover = null; // the cell under the pointer: { start, r, c }
  const tableEnd = (start) => {
    const k = classify(st.lines)[start];
    return k && k.kind === "table" && k.start === start ? k.end : -1;
  };
  function commitCell() {
    if (st.tcell) record(st.tcell.before);
    if (st.tcell) st.tcell.before = snap();
  }
  function enterCell(start, r, c, selectAll) {
    clearSel();
    commitCell();
    st.active = -1;
    closePopup();
    st.tcell = { start, r, c, before: snap(), selectAll: !!selectAll };
    render();
  }
  function leaveTable() {
    commitCell();
    st.tcell = null;
    render();
  }
  // Go to line j from a line editor or a table: a table line is entered at its header (from above) or last row (from below).
  function goLine(j, pos, fromBelow) {
    const k = classify(st.lines)[j];
    if (k?.kind !== "table") return activate(j, pos);
    const t = parseTable(st.lines, k.start, k.end);
    enterCell(k.start, fromBelow ? t.rows.length - 1 : -1, 0);
  }
  // Replace the table at `start` with `t` (or remove it). Returns false when the table is gone.
  function writeTable(start, t, remove) {
    const end = tableEnd(start);
    if (end < 0) return false;
    if (remove) {
      st.lines.splice(start, end - start + 1);
      if (!st.lines.length) st.lines.push("");
    } else st.lines.splice(start, end - start + 1, ...serializeTable(t));
    changed();
    return true;
  }
  // An add / delete / align on the table at `start`; fn(t) changes it and returns where the cursor goes ({ r, c }) or "removed".
  function tableOp(start, fn) {
    commitCell();
    closePopup();
    const end = tableEnd(start);
    if (end < 0) return;
    const b = snap();
    const t = parseTable(st.lines, start, end);
    const to = fn(t);
    if (to === null) return;
    writeTable(start, t, to === "removed");
    record(b);
    if (to === "removed" || !to) {
      st.tcell = null;
      render();
    } else {
      st.tcell = { start, r: to.r, c: to.c, before: snap() };
      render();
    }
  }
  const addRow = (start, r, c) => tableOp(start, (t) => (insertRow(t, r + 1), { r: r + 1, c }));
  const addCol = (start, r, c) => tableOp(start, (t) => (insertCol(t, c + 1), { r, c: c + 1 }));
  function tableMenu(start, r, c, rect) {
    const end = tableEnd(start);
    if (end < 0) return;
    const t = parseTable(st.lines, start, end);
    const al = t.aligns[c] || "";
    const align = (a) => tableOp(start, (x) => ((x.aligns[c] = a), { r, c }));
    openPopup("menu", rect, [
      { head: r < 0 ? `表頭 · 第 ${c + 1} 欄` : `第 ${r + 1} 列 · 第 ${c + 1} 欄` },
      { ic: "↑", label: "在上面插入一列", disabled: r < 0, run: () => tableOp(start, (x) => (insertRow(x, r), { r, c })) },
      { ic: "↓", label: "在下面插入一列", hint: "↵（最後一列）", run: () => addRow(start, r, c) },
      { ic: "←", label: "在左邊插入一欄", run: () => tableOp(start, (x) => (insertCol(x, c), { r, c })) },
      { ic: "→", label: "在右邊插入一欄", run: () => addCol(start, r, c) },
      { sep: true },
      { ic: "⇤", label: "這一欄靠左", hint: al === "left" ? "✓" : "", run: () => align("left") },
      { ic: "↔", label: "這一欄置中", hint: al === "center" ? "✓" : "", run: () => align("center") },
      { ic: "⇥", label: "這一欄靠右", hint: al === "right" ? "✓" : "", run: () => align("right") },
      { sep: true },
      { ic: ICONS.trash, label: "刪除這一列", danger: true, disabled: r < 0, run: () => tableOp(start, (x) => (deleteRow(x, r), { r: Math.min(r, x.rows.length - 1), c })) },
      { ic: ICONS.trash, label: "刪除這一欄", danger: true, run: () => tableOp(start, (x) => {
        if (x.header.length <= 1) return "removed";
        deleteCol(x, c);
        return { r, c: Math.min(c, x.header.length - 1) };
      }) },
      { ic: ICONS.trash, label: "刪除整個表格", danger: true, run: () => tableOp(start, () => "removed") },
      { sep: true },
      { ic: "M↓", label: "編輯原始 Markdown", run: () => { commitCell(); st.tcell = null; closePopup(); activate(start + (r < 0 ? 0 : r + 2), 0); } },
    ]);
  }

  function tableEl(start, end) {
    const t = parseTable(st.lines, start, end);
    const box = document.createElement("div");
    box.className = "nl nl-table nt-box";
    box.dataset.i = String(start);
    const scroll = document.createElement("div");
    scroll.className = "nt-scroll";
    const table = document.createElement("table");
    table.className = "nt";
    const editing = st.tcell && st.tcell.start === start ? st.tcell : null;
    if (editing) box.classList.add("nt-editing");
    const cellEl = (tag, r, c) => {
      const el = document.createElement(tag);
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      if (t.aligns[c]) el.dataset.align = t.aligns[c];
      const raw = getCell(t, r, c);
      if (editing && editing.r === r && editing.c === c) {
        el.classList.add("nt-on");
        el.append(cellEditor(start, r, c, raw, editing));
      } else {
        el.innerHTML = inline(cellText(raw));
        hydrateImages(el);
      }
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest("a") || e.target.closest(".nt-ed")) return;
        e.preventDefault();
        enterCell(start, r, c);
      });
      el.addEventListener("mouseenter", () => { st.tHover = { start, r, c }; });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        tableMenu(start, r, c, { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX });
      });
      return el;
    };
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    t.header.forEach((_, c) => hr.append(cellEl("th", -1, c)));
    thead.append(hr);
    const tbody = document.createElement("tbody");
    t.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((_, c) => tr.append(cellEl("td", r, c)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    scroll.append(table);
    // the hover bar under the table: add a row / column after the cell being edited (or hovered, or at the end), and the menu
    const bar = document.createElement("div");
    bar.className = "nt-bar";
    const here = () => {
      const p = st.tcell && st.tcell.start === start ? st.tcell : st.tHover && st.tHover.start === start ? st.tHover : null;
      return p ? { r: p.r, c: p.c } : { r: t.rows.length - 1, c: t.header.length - 1 };
    };
    const btn = (label, title, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(b);
      });
      bar.append(b);
    };
    btn("＋ 列", "在下面新增一列", () => { const h = here(); addRow(start, h.r, h.c); });
    btn("＋ 欄", "在右邊新增一欄", () => { const h = here(); addCol(start, h.r, h.c); });
    btn("⋯", "表格選單（也可以在格子上按右鍵）", (b) => { const h = here(); tableMenu(start, h.r, h.c, b.getBoundingClientRect()); });
    box.append(scroll, bar);
    return box;
  }

  // The in-place editor of one table cell (plain text; the cell's Markdown shown raw, `\|` as `|`).
  function cellEditor(start, r, c, raw, editing) {
    const ed = document.createElement("span");
    ed.className = "nt-ed";
    ed.contentEditable = "plaintext-only";
    ed.spellcheck = false;
    ed.textContent = cellText(raw);
    ed.addEventListener("input", () => {
      const end = tableEnd(start);
      if (end < 0) return;
      const t = parseTable(st.lines, start, end);
      setCell(t, r, c, cellRaw(ed.textContent));
      st.lines.splice(start, end - start + 1, ...serializeTable(t)); // same number of lines: nothing below moves
      changed();
    });
    ed.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const end = tableEnd(start);
      if (end < 0) return;
      const t = parseTable(st.lines, start, end);
      const cols = t.header.length;
      const last = t.rows.length - 1;
      const sel = window.getSelection();
      const pos = sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : 0;
      const len = ed.textContent.length;
      const go = (nr, nc, all) => enterCell(start, nr, nc, all);
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        commitCell();
        selectAllFrom(start); // the cell (a table alone in its cell: the table); again: the whole note
      } else if (e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const h = e.key === "ArrowDown" ? stepDown(start) : stepUp(start);
        startSel(start, h >= 0 ? h : start);
      } else if (e.key === "Tab") {
        // as in a spreadsheet: the next cell's text is selected, so typing replaces it
        e.preventDefault();
        if (e.shiftKey) {
          if (c > 0) go(r, c - 1, true);
          else if (r >= 0) go(r - 1, cols - 1, true);
        } else if (c < cols - 1) go(r, c + 1, true);
        else if (r < last) go(r + 1, 0, true);
        else tableOp(start, (x) => (insertRow(x, x.rows.length), { r: x.rows.length - 1, c: 0 }));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (r < last) go(r + 1, c);
        else tableOp(start, (x) => (insertRow(x, x.rows.length), { r: x.rows.length - 1, c: 0 })); // a new row, from its first cell
      } else if ((e.key === "Home" || e.key === "End") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // move the caret ourselves: when it is already there, the browser would scroll the whole frame instead
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(ed);
        const s2 = window.getSelection();
        if (e.shiftKey && s2.rangeCount) {
          const at = s2.getRangeAt(0);
          if (e.key === "End") range.setStart(at.startContainer, at.startOffset);
          else range.setEnd(at.endContainer, at.endOffset);
        } else range.collapse(e.key === "Home");
        s2.removeAllRanges();
        s2.addRange(range);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        leaveTable();
      } else if (e.key === "ArrowUp" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (r >= 0) go(r - 1, c);
        else {
          const p = prevEditable(start);
          if (p >= 0) { commitCell(); st.tcell = null; goLine(p, st.lines[p].length, true); }
        }
      } else if (e.key === "ArrowDown" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (r < last) go(r + 1, c);
        else {
          const n = nextEditable(end);
          if (n >= 0) { commitCell(); st.tcell = null; goLine(n, 0, false); }
        }
      } else if (e.key === "ArrowLeft" && pos === 0 && !e.shiftKey && !e.altKey && (c > 0 || r >= 0)) {
        e.preventDefault();
        if (c > 0) go(r, c - 1);
        else go(r - 1, cols - 1);
      } else if (e.key === "ArrowRight" && pos >= len && !e.shiftKey && !e.altKey && (c < cols - 1 || r < last)) {
        e.preventDefault();
        if (c < cols - 1) go(r, c + 1);
        else go(r + 1, 0);
      } else {
        const cellBox = ed.closest(".cell");
        if (cellBox && cellKey(e, cellBox)) e.preventDefault();
      }
    });
    ed.addEventListener("blur", () => {
      setTimeout(() => {
        if (!st.gone && st.tcell === editing && !root.contains(document.activeElement)) leaveTable();
      }, 0);
    });
    queueMicrotask(() => {
      if (!ed.isConnected) return;
      ed.focus({ preventScroll: true }); // only the note scrolls, never the frame
      const br = st.body.getBoundingClientRect();
      const er = ed.getBoundingClientRect();
      if (er.top < br.top + 8) st.body.scrollTop -= br.top + 8 - er.top;
      else if (er.bottom > br.bottom - 8) st.body.scrollTop += er.bottom - (br.bottom - 8);
      const range = document.createRange();
      range.selectNodeContents(ed);
      if (!editing.selectAll) range.collapse(false);
      editing.selectAll = false;
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    });
    return ed;
  }

  // ---- live cards: `<show>` blocks (./cardsrc.js), drawn as the chat draws them ----
  // The app serves a card's page once (ccb.card), so a card's frame must never be taken out of the page and put back (that
  // reloads it). The frames live in a layer of their own over the note and are laid over each card's slot after every
  // render; the slot only keeps the room. A card is known by its name, command and how many such cards come before it
  // (as the core's keys are), so typing elsewhere, moving its cell or switching routes keeps its frame. What the card shows
  // comes from the program part (notes.cards: its JSON, or its command's last output); a card with a command runs it once
  // the user allowed it (ccb.requestApproval), again on ↻ and on its refresh timer while it is shown.
  const cardLayer = document.createElement("div");
  cardLayer.className = "nc-layer";
  page.append(cardLayer);
  const views = new Map(); // local key -> { lk, name, frame, shape, data, height, state, key, msg, slot, head, timer, every, autoRan, drawing }
  st.cardSig = "";
  st.cardTimer = null;
  st.cardsOff = null; // why the app cannot draw cards (an older app), or null
  const cardKeyOf = (info) => {
    const seen = new Map();
    const out = [];
    for (let i = 0; i < info.length; i++) {
      const k = info[i];
      if (k.kind !== "card" || k.start !== i) continue;
      const id = `${k.card.name}\n${k.card.command ?? ""}`;
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      out.push({ lk: `${id}#${n}`, start: i, end: k.end, card: k.card });
    }
    return out;
  };
  const viewOf = (lk, name) => {
    let v = views.get(lk);
    if (!v) {
      v = { lk, name, frame: null, shape: null, data: null, height: 0, state: null, key: null, msg: null, slot: null, head: null, timer: null, every: null, autoRan: false, drawing: false };
      views.set(lk, v);
    }
    return v;
  };
  st.renderingKeys = null; // the blocks of the render in progress
  const STATUS = { approve: "等你允許執行", idle: "等待執行", running: "執行中…", static: "" };
  const hhmm = (t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  function cardStatus(v) {
    if (st.cardsOff) return st.cardsOff;
    const vs = v.state;
    if (!vs) return "載入中…";
    if (!vs.exists) return `組件庫裡沒有「${vs.name}」`;
    if (vs.status === "failed") return `執行失敗${vs.error ? `：${vs.error}` : ""}`;
    if (vs.status === "done") return `${vs.ranAt ? `更新於 ${hhmm(vs.ranAt)}` : "已更新"}${vs.every ? ` · 每 ${vs.every >= 60 && vs.every % 60 === 0 ? `${vs.every / 60} 分` : `${vs.every} 秒`}更新` : ""}`;
    return STATUS[vs.status] ?? "";
  }
  function paintHead(v) {
    const h = v.head;
    if (!h) return;
    // the buttons and status follow the state even on a head not yet in the page (cardEl paints it before it is placed)
    h.status.textContent = cardStatus(v);
    h.status.dataset.state = v.state?.status ?? "";
    h.run.hidden = !v.state?.command;
    h.allow.hidden = v.state?.status !== "approve";
    h.freeze.disabled = !v.frame || !!v.msg;
    if (!h.el.isConnected) return;
    if (v.slot) {
      v.slot.classList.toggle("nc-empty", !v.frame || !!v.msg);
      v.slot.dataset.msg = v.msg ?? (v.frame ? "" : v.state?.status === "approve" ? "這張卡片要執行指令才有內容：按「允許並執行」" : "載入中…");
    }
  }
  function cardEl(start, end, card) {
    const lk = st.renderingKeys?.find((b) => b.start === start)?.lk ?? `${card.name}\n${card.command ?? ""}#1`;
    const v = viewOf(lk, card.name);
    const box = document.createElement("div");
    box.className = "nl nc-box";
    box.dataset.i = String(start);
    box.dataset.j = String(end);
    const head = document.createElement("div");
    head.className = "nc-head";
    const title = document.createElement("span");
    title.className = "nc-title";
    title.textContent = card.name;
    const status = document.createElement("span");
    status.className = "nc-status";
    const btn = (label, tip, fn, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nc-btn ${cls}`;
      b.textContent = label;
      b.title = tip;
      b.setAttribute("aria-label", tip);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const allow = btn("允許並執行", "允許這張卡片的指令在 bot 的資料夾執行", () => runView(v, false), "nc-allow");
    allow.hidden = true; // shown only once the card's state says it waits for approval (paintHead)
    const run = btn("↻", "重新執行指令", () => runView(v, true));
    const freeze = btn("凍結成圖片", "把卡片現在的樣子存成圖片，取代這行 <show>（⌘Z 可復原）", () => freezeCard(v.lk));
    const src = btn("</>", "編輯原始碼（<show> 那幾行）", () => activate(start, st.lines[start].length));
    head.append(title, status, allow, run, freeze, src);
    const slot = document.createElement("div");
    slot.className = "nc-slot";
    slot.style.height = `${v.height || 120}px`;
    box.append(head, slot);
    // a click on the head (not a button) edits nothing: the card is shown, not its text
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
    });
    v.slot = slot;
    v.head = { el: box, status, run, allow, freeze };
    paintHead(v);
    return box;
  }
  // After a render: lay the frames over their slots, drop the cards that are gone, and ask for fresh states when the cards'
  // text changed.
  function afterCards(info) {
    const blocks = st.renderingKeys ?? cardKeyOf(info);
    const live = new Set(blocks.map((b) => b.lk));
    for (const v of [...views.values()]) {
      if (!live.has(v.lk)) dropView(v);
      else if (!v.slot || !v.slot.isConnected) {
        v.slot = null;
        stopTimer(v);
      }
    }
    layoutCards();
    // a head drawn again (a route switched away and back, any re-render) gets the known state now: with the cards' text
    // unchanged no sync follows to repaint it
    for (const v of views.values()) if (v.slot && v.state) paintHead(v);
    const sig = blocks.map((b) => `${b.lk}\u0002${st.lines.slice(b.start, b.end + 1).join("\n")}`).join("\u0001");
    if (sig !== st.cardSig) {
      st.cardSig = sig;
      if (blocks.length) syncSoon(350);
    }
    for (const v of views.values()) if (v.slot) armTimer(v);
  }
  function dropView(v) {
    stopTimer(v);
    v.frame?.remove();
    views.delete(v.lk);
  }
  st.hoverLk = null;
  function hoverCell() {
    const cell = st.hoverLk ? views.get(st.hoverLk)?.slot?.closest(".cell") : null;
    for (const c of st.doc.querySelectorAll(".cell.nc-hover")) if (c !== cell) c.classList.remove("nc-hover");
    cell?.classList.add("nc-hover");
  }
  function layoutCards() {
    if (!views.size) return;
    hoverCell();
    const pr = page.getBoundingClientRect();
    const pass = !!(st.drag || st.press);
    for (const v of views.values()) {
      if (!v.frame) continue;
      const slot = v.slot && v.slot.isConnected ? v.slot : null;
      if (!slot || v.msg) {
        v.frame.style.display = "none";
        continue;
      }
      const h = v.height || 120;
      slot.style.height = `${h}px`;
      const r = slot.getBoundingClientRect();
      const st = v.frame.style;
      st.display = "block";
      st.left = `${r.left - pr.left}px`;
      st.top = `${r.top - pr.top}px`;
      st.width = `${r.width}px`;
      st.height = `${h}px`;
      st.pointerEvents = pass ? "none" : "";
    }
  }
  const relayout = new ResizeObserver(() => layoutCards());
  relayout.observe(st.doc);
  const onCardMsg = (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.ccb !== "size") return;
    for (const v of views.values()) {
      if (!v.frame || e.source !== v.frame.contentWindow) continue;
      const h = Math.max(24, Math.min(6000, Math.ceil(Number(d.height) || 0)));
      if (h !== v.height) {
        v.height = h;
        layoutCards();
      }
    }
  };
  window.addEventListener("message", onCardMsg);

  const syncSoon = (ms) => {
    clearTimeout(st.cardTimer);
    st.cardTimer = setTimeout(syncCards, ms);
  };
  st.syncing = false;
  st.syncAgain = false;
  async function syncCards() {
    if (st.gone) return;
    if (st.syncing) {
      st.syncAgain = true;
      return;
    }
    const blocks = cardKeyOf(classify(st.lines));
    if (!blocks.length) return;
    st.syncing = true;
    const sent = text();
    try {
      let list = null;
      try {
        list = await ccb.host.call("cards", { botId: st.botId, text: sent });
        st.cardsOff = null;
      } catch (error) {
        st.cardsOff = /unavailable/.test(String(error?.message ?? error)) ? "這個 App 版本還不能執行卡片的指令（缺少 notes.cards）" : `讀不到卡片：${error?.message ?? error}`;
      }
      if (st.gone) return;
      const now = cardKeyOf(classify(st.lines));
      for (const b of now) {
        const v = viewOf(b.lk, b.card.name);
        const st = list?.find((c) => c.line === b.start && c.name === b.card.name) ?? (list ? null : localState(b.card));
        if (st) {
          v.state = st;
          v.key = st.key ?? null;
        }
      }
      let running = false;
      for (const v of views.values()) {
        if (!v.state) continue;
        if (v.state.status === "running") running = true;
        drawView(v);
        if (v.state.status === "idle" && !v.autoRan && v.slot && v.key) {
          v.autoRan = true;
          runView(v, false, true);
        }
        armTimer(v);
        paintHead(v);
      }
      if (running) syncSoon(2000); // the event says when a run ends; this is the fallback
    } finally {
      st.syncing = false;
      if (st.syncAgain) {
        st.syncAgain = false;
        syncSoon(50);
      }
    }
  }
  // Without the app's notes.cards (an older app): a card with JSON still draws it; one that needs its command cannot.
  const localState = (card) => ({ key: null, name: card.name, exists: true, command: card.command, every: null, status: card.command || !card.body ? "unavailable" : "static", data: card.body || "null", error: null, ranAt: null, images: {} });
  async function drawView(v) {
    const cs = v.state;
    if (!cs) return;
    v.msg = !cs.exists ? `組件庫裡沒有「${cs.name}」這個組件` : cs.status === "unavailable" ? "這個 App 版本還不能執行卡片的指令" : null;
    if (v.msg || (cs.data === "null" && (cs.status === "approve" || cs.status === "idle" || cs.status === "running"))) {
      if (v.msg && v.frame) v.frame.style.display = "none";
      paintHead(v);
      if (!v.frame) return;
    }
    let data = null;
    try {
      data = JSON.parse(cs.data);
    } catch {
      data = null;
    }
    const shape = JSON.stringify([cs.name, Object.entries(cs.images ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
    if (!v.frame || v.shape !== shape) {
      if (typeof ccb.card !== "function") {
        v.msg = "這個 App 版本還不能畫卡片（缺少 ccb.card）";
        paintHead(v);
        return;
      }
      if (v.drawing) return;
      v.drawing = true;
      try {
        const url = await ccb.card({ component: cs.name, data, botId: st.botId });
        if (st.gone || views.get(v.lk) !== v) return;
        const frame = document.createElement("iframe");
        frame.className = "nc-frame";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-label", cs.name);
        frame.tabIndex = -1;
        // the frame is not inside its cell: the pointer over it still counts as over the cell (its bar and grip show)
        frame.addEventListener("mouseenter", () => {
          st.hoverLk = v.lk;
          hoverCell();
        });
        frame.addEventListener("mouseleave", () => {
          if (st.hoverLk === v.lk) st.hoverLk = null;
          hoverCell();
        });
        frame.src = url;
        v.frame?.remove();
        v.frame = frame;
        v.shape = shape;
        v.data = cs.data;
        cardLayer.append(frame);
      } catch (error) {
        v.msg = `畫不出這張卡片：${error?.message ?? error}`;
      } finally {
        v.drawing = false;
      }
      layoutCards();
      paintHead(v);
      if (v.state !== cs) drawView(v); // it changed while the page was being made
    } else if (v.data !== cs.data) {
      v.data = cs.data;
      v.frame.contentWindow?.postMessage({ ccbData: data }, "*");
    }
  }
  // Run the card's command (force: again); asks the user first when the app says it is not allowed yet.
  async function runView(v, force, quiet) {
    if (!v.key) return syncSoon(0);
    try {
      let r = await ccb.host.call("runCard", { botId: st.botId, key: v.key, force: !!force, text: text() });
      if (r?.needsApproval) {
        if (quiet) return;
        if (typeof ccb.requestApproval !== "function") return flash("這個 App 版本不能從 Note 允許指令");
        const { allowed } = (await ccb.requestApproval({ botId: st.botId, ...r.needsApproval })) ?? {};
        if (!allowed) return;
        r = await ccb.host.call("runCard", { botId: st.botId, key: v.key, force: !!force, text: text() });
      }
    } catch (error) {
      if (!quiet) flash(`卡片沒有執行：${error?.message ?? error}`);
    }
    syncSoon(100);
  }
  function armTimer(v) {
    // the app's `every` (the component's Command schedule or refresh="…"); the tag's own refresh as notes.parse read it otherwise
    const each = v.state?.every || v.state?.refresh || null;
    const every = v.slot && v.state?.command && v.state.status !== "approve" && each ? each : null;
    if (every === v.every && (v.timer || !every)) return;
    stopTimer(v);
    if (!every) return;
    v.every = every;
    v.timer = setInterval(() => {
      if (!st.gone && document.visibilityState !== "hidden" && v.slot) runView(v, true, true);
    }, Math.max(2000, every * 1000));
  }
  function stopTimer(v) {
    clearInterval(v.timer);
    v.timer = null;
    v.every = null;
  }

  // "凍結成圖片": the app takes a picture of the card's frame (ccb.snapshot, kept in the note's assets); its <show> lines become
  // that picture's line. Cmd+Z brings the card back.
  async function freezeCard(lk) {
    const v = views.get(lk);
    if (!v?.frame || v.msg) return flash("卡片還沒畫好，等它出現再凍結");
    if (typeof ccb.snapshot !== "function") return flash("這個 App 版本還不能把卡片存成圖片（缺少 ccb.snapshot）");
    // the whole card on screen: the app can only take what is shown
    const br = st.body.getBoundingClientRect();
    let r = v.frame.getBoundingClientRect();
    if (r.top < br.top || r.bottom > br.bottom) {
      st.body.scrollTop += r.top - br.top - Math.max(8, (br.height - r.height) / 2);
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      r = v.frame.getBoundingClientRect();
    }
    wrap.classList.add("nc-freezing");
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    let res = null;
    try {
      res = await ccb.snapshot({ botId: st.botId, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    } catch (error) {
      flash(`沒能存成圖片：${error?.message ?? error}`);
    } finally {
      wrap.classList.remove("nc-freezing");
    }
    if (!res?.ref || st.gone) return;
    rememberAsset(res.ref, res.url);
    const b = cardKeyOf(classify(st.lines)).find((x) => x.lk === lk);
    if (!b) return flash("卡片已經不在筆記裡了；圖片留在 Note 的資產裡");
    const before = snap();
    const alt = b.card.name.replace(/[[\]\\]/g, "");
    // the picture keeps the card's place as a cell of its own: where the card was cut from its text without a `cell`
    // line, one is written (else the picture would join that text's cell)
    const m = model();
    const run = m.cells.runs[m.cells.at[b.start]];
    const add = [...(run?.softAbove ? [CELL_LINE] : []), `![${alt}](${res.ref})`, ...(run?.softBelow ? [CELL_LINE] : [])];
    st.lines.splice(b.start, b.end - b.start + 1, ...add);
    changed();
    record(before);
    st.active = -1;
    render();
    flash("已凍結成圖片 · ⌘Z 復原成卡片");
  }

  // "/卡片": pick one of the bot's components (its own list first); it is written as one <show> line in a cell of its own.
  async function cardPicker(i) {
    const ta = st.doc.querySelector(".nl-active textarea");
    const rect = (ta ?? st.doc).getBoundingClientRect();
    openPopup("insert", rect, [{ head: "卡片" }, { label: "載入組件清單…", disabled: true, run() {} }]);
    let list = null;
    try {
      list = await ccb.host.call("components", { botId: st.botId });
    } catch (error) {
      closePopup();
      return flash(/unavailable/.test(String(error?.message ?? error)) ? "這個 App 版本還不能插入卡片（缺少 notes.components）" : `讀不到組件清單：${error?.message ?? error}`);
    }
    if (st.gone || st.active !== i) return;
    const comps = list?.components ?? [];
    if (!comps.length) {
      closePopup();
      return flash("組件庫裡還沒有組件");
    }
    const item = (c) => ({ ic: c.icon && c.icon.length <= 2 ? c.icon : ICONS.card, label: c.title || c.name, hint: c.command ? (c.every ? "指令 · 自動更新" : "指令") : c.name, run: () => insertCard(i, c) });
    const own = comps.filter((c) => c.offered);
    const rest = comps.filter((c) => !c.offered);
    openPopup("insert", (st.doc.querySelector(".nl-active textarea") ?? st.doc).getBoundingClientRect(), [
      ...(own.length ? [{ head: "這個 bot 的組件" }, ...own.map(item)] : []),
      ...(rest.length ? [{ head: "組件庫的其他組件" }, ...rest.map(item)] : []),
    ]);
  }
  function insertCard(i, comp) {
    closePopup();
    if (i < 0 || i >= st.lines.length) return;
    st.lines[i] = st.lines[i].trim() === "" || /^\/\S*$/.test(st.lines[i]) ? "" : st.lines[i];
    const before = snap();
    const m = model();
    const idx = m.cells.at[i];
    const run = idx >= 0 ? m.cells.runs[idx] : null;
    const above = run ? st.lines.slice(run.start, i).some((l) => l.trim()) : false;
    const below = run ? st.lines.slice(i + 1, run.end + 1).some((l) => l.trim()) : false;
    const add = [...(above ? [CELL_LINE] : []), cardLine(comp), ...(below ? [CELL_LINE] : [])];
    if (st.lines[i] === "") st.lines.splice(i, 1, ...add);
    else st.lines.splice(i + 1, 0, CELL_LINE, ...add.filter((l, k) => !(k === 0 && l === CELL_LINE)));
    changed();
    record(before);
    st.active = -1;
    render();
    flash(`已插入卡片「${comp.title || comp.name}」`);
  }

  // ---- whiteboard preview (./board.js): the note as a top-to-bottom flow; view and light actions only ----
  // The toggle sits at the right end of the status bar; it (again) or Esc brings the editor back where it was. Which
  // branches are folded is kept with the view (viewSet, the app's plugin storage), never in note.md; nothing else is kept.
  st.boardOpen = false;
  st.boardBack = null; // the editor as the board found it: { active, caret, scroll }
  const board = createBoard({
    inline,
    imgSrc: (ref) => srcFor(ref),
    liveCard: (start) => {
      const b = st.renderingKeys?.find((x) => x.start === start);
      return (b && views.get(b.lk)?.state) ?? null;
    },
    chosen: (fork) => chosenRoute(fork, st.sel),
    visible: (path) => pathVisible(path, st.sel),
    isFolded: (key) => !!st.folds[key],
    onFold(key, folded) {
      if (folded) st.folds[key] = true;
      else delete st.folds[key];
      saveView();
      drawBoard();
    },
    onRoute(fork, route) {
      selectRoute(fork, route);
      render();
    },
    onJump: (start, path) => jumpFromBoard(start, path),
  });
  st.body.after(board.el);
  function drawBoard() {
    if (!st.boardOpen) return;
    const m = model();
    board.update({ lines: st.lines, info: m.info, tree: boardTree(st.lines, m.meta, m.cells) });
  }
  function setBoardButton() {
    wrap.classList.toggle("nw-on", st.boardOpen);
    boardBtn.classList.toggle("on", st.boardOpen);
    boardBtn.setAttribute("aria-pressed", String(st.boardOpen));
    boardBtn.setAttribute("aria-label", st.boardOpen ? "白板預覽，開啟中（按一下或 Esc 回到編輯器）" : "白板預覽");
  }
  function openBoard() {
    if (st.boardOpen || st.drag) return;
    const ta = st.doc.querySelector(".nl-active textarea");
    st.boardBack = { active: st.active, caret: ta ? ta.selectionStart ?? st.caret : st.caret, scroll: st.body.scrollTop };
    closePopup();
    closeMap();
    st.msel = null;
    st.tcell = null;
    st.active = -1;
    st.boardOpen = true;
    setBoardButton();
    board.show();
    render();
    board.el.focus({ preventScroll: true });
  }
  function closeBoard(then) {
    if (!st.boardOpen) return;
    st.boardOpen = false;
    board.hide();
    setBoardButton();
    const back = st.boardBack;
    st.boardBack = null;
    if (then) return then();
    st.active = -1;
    render();
    if (back && back.active >= 0 && model().editable(back.active)) activate(back.active, Math.min(back.caret, st.lines[back.active].length));
    requestAnimationFrame(() => {
      if (!st.gone && back) st.body.scrollTop = back.scroll;
    });
  }
  // Double-click on a card: back to the editor at that cell (its routes shown).
  function jumpFromBoard(start, path) {
    closeBoard(() => {
      for (const e of path) selectRoute(e.fork, e.route);
      st.active = -1;
      render();
      const el = st.doc.querySelector(`.cell[data-start="${start}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.remove("cell-dropped");
      void el.offsetWidth;
      el.classList.add("cell-dropped");
      st.lastLine = start;
      saveView();
    });
  }
  boardBtn.addEventListener("click", () => (st.boardOpen ? closeBoard() : openBoard()));

  // ---- ask: quote a cell (or a branch as shown) into this bot's chat ----
  // The quote is Markdown ("> " per line): a text cell its raw Markdown, a table its pipe text, a card its name and the <show>
  // line(s), a branch only its shown route(s) without markers. It goes to the composer when the app lends one to this frame
  // (ccb.composer.insertQuote, else a real ccb.composer); a mainTab frame's composer is a stub, so it is copied instead.
  function cellQuoteText(c, m = model()) {
    const lo = Number(c.dataset.start);
    const hi = Number(c.dataset.end);
    const body = shownMarkdown(m, lo, hi);
    let name = "";
    for (let i = lo; i <= hi; i++) if (m.info[i]?.kind === "card" && m.info[i].card) { name = m.info[i].card.name; break; }
    return name && !/\S/.test(body.replace(/<show[\s\S]*?(<\/show>|\/>)/g, "")) ? `**${name}**\n${body}` : body;
  }
  const quoteOf = (text) => text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
  // The quote's first line names the cell by its id in note.db, `> 〔Note #b7k3f9 · Loading › Lazy load〕`, so the bot can
  // read it with app_note_read even after lines moved: the label of the cell with the same lines in notes.outline (asked
  // with this text, after saving what was typed so a new cell has its id). A branch: its fork's id, the routes above it and
  // the route shown. No outline (older app), file mode, no id or no answer in time: the quote has no first line.
  async function noteLabel(find) {
    if (typeof ccb.host?.call !== "function") return "";
    const ask = (async () => {
      if (st.dirty && st.loaded && warn.hidden && st.state !== "error") await flush();
      const sent = text();
      const o = await ccb.host.call("outline", { botId: st.botId, text: sent });
      if (!o || o.mode !== "db" || text() !== sent) return "";
      return find(o) || "";
    })().catch(() => "");
    return await Promise.race([ask, new Promise((r) => setTimeout(() => r(""), 2000))]);
  }
  const labelLine = (label) => (label ? `> 〔${label.replace(/[\r\n]+/g, " ")}〕\n` : "");
  async function askCell(c) {
    const text = cellQuoteText(c);
    if (!text.trim()) return flash("這一格是空的，沒有可以引用的內容");
    const lo = Number(c.dataset.start);
    const hi = Number(c.dataset.end);
    const label = await noteLabel((o) => {
      const hit = (Array.isArray(o.cells) ? o.cells : []).find((x) => x && x.start === lo && x.end === hi);
      return hit?.id && typeof hit.label === "string" ? hit.label : "";
    });
    return askQuote(text, label);
  }
  async function askFork(fork) {
    const m = model();
    const text = shownMarkdown(m, fork.start, Math.min(fork.endLine, st.lines.length - 1));
    if (!text.trim()) return flash("這個分叉顯示的路線是空的");
    const shown = chosenRoute(fork, st.sel)?.name ?? "";
    const label = await noteLabel((o) => {
      const hit = (Array.isArray(o.forks) ? o.forks : []).find((x) => x && x.start === fork.start);
      if (!hit?.id) return "";
      // The app's label (Botling 2.7: its id, the routes above it, its name), then the route shown.
      if (typeof hit.label === "string" && hit.label) return shown ? `${hit.label} › ${shown}` : hit.label;
      const steps = (Array.isArray(hit.path) ? hit.path : []).map((s) => `${s.fork} › ${s.route}`);
      steps.push(shown ? `${hit.name ?? fork.name} › ${shown}` : `${hit.name ?? fork.name}`);
      return `Note #${hit.id} · ${steps.join(" › ")}`;
    });
    return askQuote(text, label);
  }
  function copyText(text) {
    // a sandboxed frame has no clipboard permission; a copy command during the click (user activation) still works
    let done = false;
    const onCopy = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.clipboardData?.setData("text/plain", text);
      done = !!e.clipboardData;
    };
    document.addEventListener("copy", onCopy, true);
    try {
      if (!document.hasFocus()) window.focus(); // the toolbar's buttons keep focus where it was: it may be outside this frame
      document.execCommand("copy");
    } catch {}
    document.removeEventListener("copy", onCopy, true);
    if (done) return Promise.resolve(true);
    return navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
  }
  async function askQuote(text, label = "") {
    const quote = labelLine(label) + quoteOf(text);
    const comp = ccb.composer;
    if (typeof comp?.insertQuote === "function") {
      try {
        const res = await comp.insertQuote(quote, { focus: true }); // no botId: the app uses the Note's own bot
        if (res !== false && res?.inserted !== false) return flash("已引用到對話");
      } catch {}
    }
    const view = comp?.view;
    if (comp?.element && view?.state?.doc && typeof view.dispatch === "function") {
      try {
        const cur = view.state.doc.toString();
        const lead = !cur.trim() ? "" : cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
        const from = cur.trim() ? cur.length : 0;
        const insert = `${lead}${quote}\n\n`;
        view.dispatch({ changes: { from, to: cur.length, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
        view.focus();
        return flash("已引用到對話");
      } catch {}
    }
    const block = `${quote}\n\n`;
    if (await copyText(block)) flash("已複製引用，到對話裡貼上（⌘V）就能問");
    else flash("沒能複製：請選取這一格後按 ⌘C");
  }

  // ---- multi-line selection ----
  // A selection across lines covers whole lines (a table or math block as one piece): mouse drag from one line to another,
  // Shift+click, Shift+↑/↓ from the edge of a line or a table, Cmd/Ctrl+A (the cell, then the whole note). It is drawn as a
  // highlight; a hidden text box holds its Markdown, fully selected, so copy / cut / typing / paste / Delete act on it.
  // Copy gives the Markdown of the shown lines: no `<!-- cell -->`, branch, route or end-branch lines (where one was left
  // out between two lines of text a blank line keeps them apart) and nothing from routes that are not shown. Deleting or
  // typing over it removes the shown lines and the `cell` lines between them, never branch / route / end-branch lines.
  st.msel = null; // { anchor, head }: line indexes
  st.press = null; // a left-button press on a line: { line, moved }
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

  function cellAsk(run, title = "引用到對話裡問") {
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
