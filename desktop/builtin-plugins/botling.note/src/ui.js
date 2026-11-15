// botling.note, web part: a line editor with live markdown rendering.
// Every line is shown rendered except the one the cursor is in, which is a plain text box.
// Data goes only through the program part (src/host.ts -> api.notes.*); images only through ./assets.js.
// Colors come only from the app's theme variables, so light/dark follows the app live.

import { initAssets, importImage, localizeNote, IMAGE_API_AVAILABLE } from "./assets.js";
import { VIEW, SAVE_MS, POLL_MS } from "./ui-css.js";
import { openHref, inline, classify, QUOTE_LEAD } from "./ui-text.js";
import { install as installInsert } from "./ui-insert.js";
import { install as installTable } from "./ui-table.js";
import { install as installCards } from "./ui-cards.js";
import { install as installDrag } from "./ui-drag.js";
import { install as installRender } from "./ui-render.js";
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
  installRender(st, api);
  const {
    render, activate, closeMap, placeMap, onDocDown, onEsc,
  } = api;

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
    keydown, flash, changed, flush,
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
