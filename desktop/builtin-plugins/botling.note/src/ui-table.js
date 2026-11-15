// botling.note, web part, mount part 2 (M7-S102): the cell actions (split, merge, insert, move, delete, convert, the cell bar and
// its keys), the branch actions (route menu, rename, new route), the table editor, and the card keys and layer. Moved out
// of ui.js without a change; `install` runs where the code used to run in `mount`. What it borrows from the rest of
// `mount` it reads through `api` (the first block destructures what part 1 registered; the forwarders look the other
// names up when called, because ui.js registers them after its last definition); what the rest of `mount` needs from
// here it finds on `api` after `install` returns (the last statement).

import { parseBranches, chosenRoute, pathVisible, branchFrom, addRoute, endFork, renameFork, renameRoute, deleteRoute, cleanName } from "./branch.js";
import { splitCell, mergeBelow, insertCellBelow, moveCell as moveCellIn, deleteCell as deleteCellIn, convertCell as convertCellIn, cellGaps, moveCellTo } from "./cells.js";
import { parseTable, serializeTable, cellText, cellRaw, getCell, setCell, insertRow, deleteRow, insertCol, deleteCol } from "./table.js";
import { hydrateImages, inline, classify, svg, ICONS } from "./ui-text.js";

export function install(st, api) {
  const { root, ccb } = api;
  const {
    page, saveSel, text, model, prevEditable, nextEditable, selectRoute, migrate, refork, closePopup, openPopup,
    syncInsertMenu, snap, record, placeName, TYPE_LABEL, TYPE_ITEMS, runOf,
  } = api;
  // The bridge block: names defined later in `mount` (ui.js).
  const render = (...a) => api.render(...a);
  const activate = (...a) => api.activate(...a);
  const flash = (...a) => api.flash(...a);
  const changed = (...a) => api.changed(...a);
  const flashCell = (...a) => api.flashCell(...a);
  const clearSel = (...a) => api.clearSel(...a);
  const selectAllFrom = (...a) => api.selectAllFrom(...a);
  const stepDown = (...a) => api.stepDown(...a);
  const stepUp = (...a) => api.stepUp(...a);
  const startSel = (...a) => api.startSel(...a);
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
  Object.assign(api, {
    moveCell, deleteCell, convertCell, cellBar, cellKey, branchAt, newRouteIn, pickRoute, commitRename, endOf, routeMenu,
    commitCell, enterCell, goLine, tableEl, cardLayer, views, cardKeyOf,
  });
}
