// botling.note, web part, mount part 1 (M7-S101): the editor shell (the page, status bar, style tags), the view state kept
// with the app, the insert menu and popups, and undo. Moved out of ui.js without a change; `install` runs where the code
// used to run in `mount`. What it borrows from the rest of `mount` it reads through `api` (the forwarders below, which
// look the name up when called, because ui.js registers those names after its last definition); what the rest of `mount`
// needs from here it finds on `api` after `install` returns (the last statement).

import katexCss from "./katex-style.ts";
import { parseBranches, pathVisible } from "./branch.js";
import { isCellLine, cellRuns } from "./cells.js";
import { newTable } from "./table.js";
import { BOARD_CSS } from "./board.js";
import { CSS } from "./ui-css.js";
import { classify, ICONS, INSERT_ITEMS } from "./ui-text.js";

export function install(st, api) {
  const { root, ccb } = api;
  // The bridge block: names defined later in `mount` (ui.js).
  const branchAt = (...a) => api.branchAt(...a);
  const enterCell = (...a) => api.enterCell(...a);
  const cardPicker = (...a) => api.cardPicker(...a);
  const render = (...a) => api.render(...a);
  const activate = (...a) => api.activate(...a);
  const flash = (...a) => api.flash(...a);
  const changed = (...a) => api.changed(...a);
  const flush = (...a) => api.flush(...a);

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
    if (e.target?.closest?.(".nm-ui")) return; // typing in a margin comment's box: ⌘Z is that box's, not the note's
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
  Object.assign(api, {
    wrap, status, crumb, boardBtn, warn, kept, page, fileInput, fitFrame, pinFrame, viewNow, flushView, saveView,
    saveSel, restorePos, setStatus, showState, text, setText, grow, model, checkCut, prevEditable, nextEditable,
    lastEditable, selectRoute, migrate, refork, closePopup, openPopup, movePopup, syncInsertMenu, undos, look, snap,
    record, onUndoKey, placeName, TYPE_LABEL, TYPE_ITEMS, runOf,
  });
}
