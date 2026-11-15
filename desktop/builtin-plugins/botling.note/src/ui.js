// botling.note, web part: a line editor with live markdown rendering.
// Every line is shown rendered except the one the cursor is in, which is a plain text box.
// Data goes only through the program part (src/host.ts -> api.notes.*); images only through ./assets.js.
// Colors come only from the app's theme variables, so light/dark follows the app live.

import { initAssets } from "./assets.js";
import { VIEW, POLL_MS } from "./ui-css.js";
import { inline, classify } from "./ui-text.js";
import { install as installInsert } from "./ui-insert.js";
import { install as installTable } from "./ui-table.js";
import { install as installCards } from "./ui-cards.js";
import { install as installDrag } from "./ui-drag.js";
import { install as installRender } from "./ui-render.js";
import { install as installKeysSave } from "./ui-keys-save.js";
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
  installKeysSave(st, api);
  const {
    keydown, flash, changed, flush, load,
  } = api;

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
