// botling.note, web part, mount part 3 (M7-S103): the live cards (views, frames, timers, freeze), the "/卡片" picker, the
// whiteboard preview and the ask-quote actions. Moved out of ui.js without a change; `install` runs where the code used to
// run in `mount`. What it borrows from the rest of `mount` it reads through `api` (the first blocks destructure what parts 1
// and 2 registered; the forwarders look the other names up when called, because ui.js registers them after its last
// definition); what the rest of `mount` needs from here it finds on `api` after `install` returns (the last statement).

import { chosenRoute, pathVisible } from "./branch.js";
import { CELL_LINE } from "./cells.js";
import { showLine as cardLine } from "./cardsrc.js";
import { createBoard, boardTree } from "./board.js";
import { srcFor, rememberAsset } from "./assets.js";
import { inline, classify, ICONS } from "./ui-text.js";

export function install(st, api) {
  const { ccb } = api;
  const {
    wrap, boardBtn, warn, page, text, model, saveView, selectRoute, closePopup, openPopup, snap, record,
    cardLayer, views, cardKeyOf,
  } = api;
  // The bridge block: names defined later in `mount` (ui.js).
  const render = (...a) => api.render(...a);
  const activate = (...a) => api.activate(...a);
  const flash = (...a) => api.flash(...a);
  const changed = (...a) => api.changed(...a);
  const flush = (...a) => api.flush(...a);
  const closeMap = (...a) => api.closeMap(...a);
  const shownMarkdown = (...a) => api.shownMarkdown(...a);
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
  Object.assign(api, {
    cardEl, afterCards, syncSoon, stopTimer, relayout, onCardMsg, cardPicker, drawBoard, closeBoard, askCell, askFork,
  });
}
