// botling.note, whiteboard preview (layout A, "由上往下的流程"): the note drawn as a flow, one card per cell (cells.js),
// top to bottom; a branch splits into side-by-side columns, one per route, and merges back at its end line. Nested
// branches nest columns. The layout comes only from note.md (nothing is stored but which branches are folded, kept by
// the app with the rest of the view, never in note.md). View and light actions only: double-click a card to go to that
// cell in the editor, click a route title to show that route, fold / unfold a branch. Zoom (⌘ + wheel, the buttons,
// "符合畫面") and pan (drag, wheel / trackpad), a minimap.

const CARD_W = 248;
const GAP = 26; // between cards in a column (the connector)
const COL_GAP = 36; // between route columns
const PILL_H = 28;
const TITLE_H = 26;

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const blank = (l) => !String(l ?? "").trim();

// ---- the flow, from the note's model (pure) ----
// seq: [{ kind: "cell", run, path } | { kind: "fork", fork, path, routes: [{ route, path, items: seq }] }]
export function boardTree(lines, meta, cells) {
  const build = (s, e, path) => {
    const items = [];
    let i = s;
    while (i < e) {
      const at = meta.at[i];
      if (at?.marker === "branch" && at.fork.start === i) {
        const fork = at.fork;
        const routes = fork.routes.map((route) => {
          const rp = [...path, { fork, route }];
          return { route, path: rp, items: build(route.start, Math.max(route.start, route.end), rp) };
        });
        items.push({ kind: "fork", fork, path, routes });
        i = Math.max(i + 1, fork.endLine + 1);
        continue;
      }
      const idx = cells.at[i];
      if (idx >= 0 && cells.runs[idx].start === i) {
        const run = cells.runs[idx];
        if (!run.empty) items.push({ kind: "cell", run, path });
        i = Math.max(i + 1, run.end + 1);
        continue;
      }
      i++;
    }
    return items;
  };
  return build(0, lines.length, []);
}

// What a card shows for a cell (pure): { type, label, title, rows: [{ text, done, mark }], code, lang, tex, table, show, images }
export function cellSummary(lines, info, run) {
  const seg = lines.slice(run.first, run.last + 1);
  const type = run.type;
  const images = [];
  for (const l of seg) for (const m of l.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) images.push({ alt: m[1], ref: m[2] });
  if (type === "code") {
    const lang = (/^\s*```\s*([\w+#.-]*)/.exec(seg[0] ?? "")?.[1] ?? "").trim();
    const body = seg.slice(1, /^\s*```/.test(seg[seg.length - 1] ?? "") && seg.length > 1 ? -1 : undefined);
    return { type, label: lang ? `程式碼 · ${lang}` : "程式碼", code: body.slice(0, 4), more: body.length > 4, images: [] };
  }
  if (type === "math") {
    const tex = seg.join(" ").replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim();
    return { type, label: "數學", tex, images: [] };
  }
  if (type === "table") {
    const cellsOf = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    return { type, label: "表格", table: { head: cellsOf(seg[0] ?? ""), rows: Math.max(0, seg.length - 2) }, images: [] };
  }
  if (type === "card") {
    const c = info[run.first]?.card;
    return { type, label: "即時卡片", show: c ? { name: c.name, command: c.command, body: c.body } : { name: "?", command: null, body: "" }, images: [] };
  }
  // Markdown: the first heading is the title; then a few lines, list / to-do marks kept short.
  let title = "";
  const rows = [];
  let inFence = false;
  for (const raw of seg) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || blank(raw)) continue;
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (h && !title && !rows.length) {
      title = h[1].replace(/\s+#+\s*$/, "");
      continue;
    }
    const todo = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(raw);
    if (todo) rows.push({ text: todo[2], mark: todo[1] === " " ? "☐" : "☑", done: todo[1] !== " " });
    else if (/^\s*[-*+]\s+/.test(raw)) rows.push({ text: raw.replace(/^\s*[-*+]\s+/, ""), mark: "•" });
    else if (/^\s*\d+[.)]\s+/.test(raw)) rows.push({ text: raw.replace(/^\s*(\d+)[.)]\s+/, ""), mark: `${/^\s*(\d+)/.exec(raw)[1]}.` });
    else if (h) rows.push({ text: h[1], strong: true });
    else rows.push({ text: raw.replace(/^\s*>\s?/, ""), quote: /^\s*>/.test(raw) });
  }
  const textRows = rows.filter((r) => !/^!\[[^\]]*\]\([^)]*\)$/.test(r.text.trim()));
  return { type: "markdown", label: images.length && !title && !textRows.length ? "圖片" : "Markdown", title, rows: textRows.slice(0, 5), more: textRows.length > 5, images };
}

// ---- the view ----
const ICON_FORK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"></circle><circle cx="6" cy="19" r="2"></circle><circle cx="18" cy="7" r="2"></circle><path d="M6 7v10"></path><path d="M18 9c0 5-6 4-11.5 8.5"></path></svg>';
const ICON_FIT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"></path></svg>';
const CHEV_UP = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"></path></svg>';
const CHEV_DOWN = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"></path></svg>';
const TYPE_COLOR = { markdown: "var(--n-c-text)", code: "var(--n-c-code)", math: "var(--n-c-math)", card: "var(--n-c-card)", table: "var(--n-c-table)", image: "var(--n-c-image)" };

export const BOARD_CSS = `
.nw { position: relative; flex: 1; min-height: 0; overflow: hidden; outline: none; cursor: grab; touch-action: none;
  background-color: var(--n-board); background-image: radial-gradient(var(--n-board-dot) 1.2px, transparent 1.2px); background-size: 20px 20px;
  font-size: 12px; line-height: 1.5; color: var(--n-text); user-select: none; -webkit-user-select: none; }
.nw[hidden] { display: none; }
.nw.nw-panning { cursor: grabbing; }
.nw-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.nw-lines { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.nw-lines .c { stroke: var(--n-board-conn); stroke-width: 2; fill: none; }
.nw-lines .f { stroke: var(--n-board-fork); stroke-width: 2; fill: none; }
.nw-lines .m { stroke: var(--n-board-fork); stroke-width: 2; fill: var(--n-board); }
.nw-card { position: absolute; width: ${CARD_W}px; box-sizing: border-box; padding: 7px 10px 8px 12px; border: 1px solid var(--n-cell-line);
  border-left: 3px solid var(--cc, var(--n-c-text)); border-radius: 8px; background: var(--n-paper); cursor: default; overflow: hidden; }
.nw-card:hover { border-color: var(--n-board-hover); border-left-color: var(--cc, var(--n-c-text)); box-shadow: 0 0 0 3px var(--n-board-ring); }
.nw-card.nw-hidden-route { opacity: .78; }
.nw-card.t-code { background: var(--n-code); }
.nw-lab { font-size: 10.5px; color: var(--cc); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw-title { font-size: 13.5px; font-weight: 700; line-height: 1.4; margin: 1px 0 1px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.nw-row { color: var(--n-muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.nw-row.done { text-decoration: line-through; }
.nw-row.quote { border-left: 2px solid var(--n-line); padding-left: 6px; }
.nw-row strong, .nw-row b { color: var(--n-text); }
.nw-row code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--n-chip); border-radius: 3px; padding: 0 3px; }
.nw-row a { color: var(--n-link); text-decoration: none; }
.nw-row .n-img { display: none; }
.nw-more { color: var(--n-faint); font-size: 11px; }
.nw-code { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--n-muted); white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.nw-tex { color: var(--n-text); overflow: hidden; max-height: 64px; }
.nw-tex .katex-display { margin: 2px 0; }
.nw-thead { display: flex; gap: 0; margin-top: 3px; border: 1px solid var(--n-strong-line); border-radius: 4px; overflow: hidden; }
.nw-thead span { flex: 1; min-width: 0; padding: 2px 6px; background: var(--n-t-head); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw-thead span + span { border-left: 1px solid var(--n-strong-line); }
.nw-show { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--n-muted); }
.nw-show b { font-weight: 650; color: var(--cc); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nw-show i { font-style: normal; margin-left: auto; padding: 0 6px; border-radius: 999px; background: var(--n-chip); }
.nw-kv { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; margin-top: 4px; color: var(--n-muted); }
.nw-kv span:nth-child(odd) { color: var(--n-faint); }
.nw-kv span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw-bars { display: flex; align-items: flex-end; gap: 5px; height: 26px; margin-top: 5px; }
.nw-bars span { width: 14px; border-radius: 3px 3px 0 0; background: var(--n-chip); }
.nw-bars span:last-child { background: var(--cc); }
.nw-img { display: block; max-width: 100%; max-height: 110px; margin-top: 4px; border-radius: 5px; object-fit: contain; background: var(--n-chip); }
.nw-img-ph { display: flex; align-items: center; justify-content: center; height: 54px; margin-top: 4px; border-radius: 5px; border: 1px dashed var(--n-strong-line); color: var(--n-faint); font-size: 11px; }
.nw-pill { position: absolute; height: ${PILL_H}px; box-sizing: border-box; display: flex; align-items: center; gap: 5px; padding: 0 4px 0 11px;
  border-radius: 999px; border: 1px solid var(--n-board-fork); background: var(--n-board-branch); color: var(--n-c-branch); font-size: 12px; font-weight: 600; white-space: nowrap; }
.nw-pill > span { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.nw-fold-btn { display: inline-flex; align-items: center; justify-content: center; gap: 3px; height: 20px; padding: 0 6px; border: 0; border-radius: 999px;
  background: transparent; color: inherit; font: inherit; font-size: 11px; font-weight: 500; cursor: pointer; opacity: .85; }
.nw-fold-btn:hover { background: color-mix(in srgb, var(--n-c-branch) 16%, transparent); opacity: 1; }
.nw-rt { position: absolute; height: ${TITLE_H}px; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--n-muted); font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.nw-rt:hover { background: var(--n-hover); color: var(--n-text); }
.nw-rt.on { color: var(--n-text); }
.nw-rt em { font-style: normal; padding: 0 6px; border-radius: 999px; background: var(--n-accent-bg); color: var(--n-accent); font-size: 10.5px; font-weight: 600; }
.nw-rt > span { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.nw-empty { position: absolute; width: 150px; height: 34px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--n-strong-line);
  border-radius: 8px; color: var(--n-faint); font-size: 11.5px; background: transparent; }
.nw-fold { position: absolute; width: ${CARD_W}px; box-sizing: border-box; padding: 8px 8px 9px 12px; border: 1px solid var(--n-board-fork); border-left: 3px solid var(--n-c-branch);
  border-radius: 8px; background: var(--n-board-branch); cursor: default; }
.nw-fold:hover { box-shadow: 0 0 0 3px var(--n-board-ring); }
.nw-fold-head { display: flex; align-items: center; gap: 5px; color: var(--n-c-branch); font-size: 12px; font-weight: 600; }
.nw-fold-head > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nw-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.nw-chip { height: 22px; max-width: 100%; padding: 0 8px; border: 1px solid var(--n-line); border-radius: 999px; background: var(--n-paper); color: var(--n-muted);
  font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw-chip:hover { color: var(--n-text); border-color: var(--n-strong-line); }
.nw-chip.on { color: var(--n-accent); border-color: var(--n-board-accent-line); background: var(--n-accent-bg); font-weight: 600; }
.nw-fold-n { margin-top: 5px; color: var(--n-faint); font-size: 11px; }
.nw-legend { position: absolute; left: 16px; top: 14px; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 8px; background: var(--n-paper);
  border: 1px solid var(--n-line); font-size: 11.5px; color: var(--n-muted); pointer-events: none; }
.nw-legend span { display: flex; align-items: center; gap: 6px; }
.nw-legend i { width: 10px; height: 3px; border-radius: 2px; }
.nw-zoom { position: absolute; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px; background: var(--n-paper);
  border: 1px solid var(--n-strong-line); cursor: default; }
.nw-zoom button { height: 28px; min-width: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--n-muted); font: inherit; font-size: 16px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 6px; }
.nw-zoom button.nw-fit { font-size: 12px; padding: 0 8px; }
.nw-zoom button:hover { background: var(--n-hover); color: var(--n-text); }
.nw-zoom output { min-width: 44px; text-align: center; font-size: 12px; color: var(--n-text); }
.nw-zoom i { width: 1px; height: 16px; margin: 0 2px; background: var(--n-line); }
.nw-map { position: absolute; left: 16px; bottom: 16px; width: 156px; height: 100px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--n-strong-line);
  background: var(--n-paper); overflow: hidden; cursor: pointer; }
.nw-map span { position: absolute; border-radius: 2px; }
.nw-map .nw-vp { box-sizing: border-box; border: 1.5px solid var(--n-accent); border-radius: 3px; background: color-mix(in srgb, var(--n-accent) 10%, transparent); }
.nw-none { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); color: var(--n-faint); font-size: 13px; pointer-events: none; }
`;

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// opts: { inline(raw) -> html, imgSrc(ref) -> url | Promise<url|null> | null, liveCard(start) -> { data, status } | null,
//   chosen(fork) -> route, visible(path) -> bool, isFolded(key), onFold(key, folded), onRoute(fork, route), onJump(start, path) }
export function createBoard(opts) {
  const view = el("div", "nw");
  view.hidden = true;
  view.tabIndex = -1;
  view.setAttribute("role", "region");
  view.setAttribute("aria-label", "白板預覽");
  const world = el("div", "nw-world");
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "nw-lines");
  svg.setAttribute("aria-hidden", "true");
  world.append(svg);
  const legend = el("div", "nw-legend",
    [["var(--n-c-text)", "Markdown"], ["var(--n-c-code)", "程式碼"], ["var(--n-c-card)", "即時卡片"], ["var(--n-c-branch)", "分岔 / 路線"]].map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join(""));
  const map = el("div", "nw-map");
  map.title = "小地圖：藍框是現在看到的範圍；按一下移到那裡";
  const vp = el("span", "nw-vp");
  const zoom = el("div", "nw-zoom");
  const zout = el("button", "", "−");
  zout.type = "button";
  zout.setAttribute("aria-label", "縮小");
  const zlab = el("output", "", "100%");
  const zin = el("button", "", "+");
  zin.type = "button";
  zin.setAttribute("aria-label", "放大");
  const zfit = el("button", "nw-fit", `${ICON_FIT}符合畫面`);
  zfit.type = "button";
  zfit.title = "整份縮到剛好看完（⌘ + 滾輪縮放）";
  zoom.append(zout, zlab, zin, el("i"), zfit);
  const none = el("div", "nw-none", "這份 Note 還是空的");
  none.hidden = true;
  view.append(world, legend, map, zoom, none);

  let t = { x: 0, y: 0, z: 1 };
  let size = { w: 0, h: 0 };
  let boxes = []; // for the minimap: { x, y, w, h, color }
  let placed = false; // the first layout of this opening sets the view
  const apply = () => {
    world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.z})`;
    zlab.textContent = `${Math.round(t.z * 100)}%`;
    drawViewport();
  };
  const clampZ = (z) => Math.min(2, Math.max(0.15, z));
  const zoomAt = (z, cx, cy) => {
    const nz = clampZ(z);
    t = { x: cx - ((cx - t.x) / t.z) * nz, y: cy - ((cy - t.y) / t.z) * nz, z: nz };
    apply();
  };
  const fit = () => {
    const vw = view.clientWidth;
    const vh = view.clientHeight;
    if (!vw || !vh || !size.w) return;
    const z = clampZ(Math.min(1, (vw - 48) / size.w, (vh - 48) / size.h));
    t = { x: (vw - size.w * z) / 2, y: Math.max(24, (vh - size.h * z) / 2), z };
    apply();
  };
  const home = () => {
    const vw = view.clientWidth;
    if (!vw || !size.w) return;
    if (size.w <= vw - 48) {
      t = { x: (vw - size.w) / 2, y: 24, z: 1 };
      apply();
    } else fit();
  };
  zout.addEventListener("click", () => zoomAt(t.z / 1.25, view.clientWidth / 2, view.clientHeight / 2));
  zin.addEventListener("click", () => zoomAt(t.z * 1.25, view.clientWidth / 2, view.clientHeight / 2));
  zfit.addEventListener("click", fit);

  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(t.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
    else {
      const k = e.deltaMode ? 16 : 1;
      t = { ...t, x: t.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k, y: t.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k };
      apply();
    }
  }, { passive: false });
  let pan = null;
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, .nw-zoom, .nw-map")) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false };
    view.focus({ preventScroll: true });
  });
  view.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 3) return;
    if (!pan.moved) {
      pan.moved = true;
      view.setPointerCapture?.(e.pointerId);
      view.classList.add("nw-panning");
    }
    t = { ...t, x: pan.tx + dx, y: pan.ty + dy };
    apply();
  });
  const endPan = (e) => {
    if (!pan || (e && e.pointerId !== pan.id)) return;
    pan = null;
    view.classList.remove("nw-panning");
  };
  view.addEventListener("pointerup", endPan);
  view.addEventListener("pointercancel", endPan);
  const onKey = (e) => {
    if (view.hidden || e.altKey) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "=" || e.key === "+")) zoomAt(t.z * 1.25, view.clientWidth / 2, view.clientHeight / 2);
    else if (mod && e.key === "-") zoomAt(t.z / 1.25, view.clientWidth / 2, view.clientHeight / 2);
    else if (mod && e.key === "0") fit();
    else return;
    e.preventDefault();
  };
  view.addEventListener("keydown", onKey);

  // minimap
  let mapScale = 1;
  let mapOff = { x: 0, y: 0 };
  function drawMap() {
    map.textContent = "";
    if (!size.w) return;
    mapScale = Math.min(140 / size.w, 84 / size.h);
    mapOff = { x: (156 - size.w * mapScale) / 2, y: (100 - size.h * mapScale) / 2 };
    for (const b of boxes) {
      const s = el("span");
      s.style.cssText = `left:${mapOff.x + b.x * mapScale}px;top:${mapOff.y + b.y * mapScale}px;width:${Math.max(2, b.w * mapScale)}px;height:${Math.max(2, b.h * mapScale)}px;background:${b.color}`;
      map.append(s);
    }
    map.append(vp);
    drawViewport();
  }
  function drawViewport() {
    if (!size.w) return;
    const vw = view.clientWidth;
    const vh = view.clientHeight;
    const x = (-t.x / t.z) * mapScale + mapOff.x;
    const y = (-t.y / t.z) * mapScale + mapOff.y;
    vp.style.cssText = `left:${x}px;top:${y}px;width:${(vw / t.z) * mapScale}px;height:${(vh / t.z) * mapScale}px`;
  }
  const mapTo = (e) => {
    const r = map.getBoundingClientRect();
    const wx = (e.clientX - r.left - mapOff.x) / mapScale;
    const wy = (e.clientY - r.top - mapOff.y) / mapScale;
    t = { ...t, x: view.clientWidth / 2 - wx * t.z, y: view.clientHeight / 2 - wy * t.z };
    apply();
  };
  let mapDrag = false;
  map.addEventListener("pointerdown", (e) => {
    mapDrag = true;
    map.setPointerCapture?.(e.pointerId);
    mapTo(e);
  });
  map.addEventListener("pointermove", (e) => mapDrag && mapTo(e));
  map.addEventListener("pointerup", () => (mapDrag = false));

  // ---- cards ----
  function cardEl(item, model) {
    const s = cellSummary(model.lines, model.info, item.run);
    const kind = s.type === "markdown" && s.label === "圖片" ? "image" : s.type;
    const c = el("div", `nw-card t-${kind}`);
    c.style.setProperty("--cc", TYPE_COLOR[kind] ?? TYPE_COLOR.markdown);
    c.dataset.start = String(item.run.start);
    c.title = "雙擊：回到編輯器的這一格";
    if (!opts.visible(item.path)) c.classList.add("nw-hidden-route");
    const add = (cls, html) => c.append(el("div", cls, html));
    if (kind === "card") {
      const live = opts.liveCard?.(item.run.start) ?? null;
      c.append(el("div", "nw-show", `<b>${escHtml(s.show.name)}</b><span>${s.show.command ? "指令" : "JSON"}</span><i>即時</i>`));
      let data = null;
      try {
        data = JSON.parse(live?.data && live.data !== "null" ? live.data : s.show.body || "null");
      } catch {
        data = null;
      }
      const entries = data && typeof data === "object" && !Array.isArray(data) ? Object.entries(data).filter(([, v]) => v === null || typeof v !== "object").slice(0, 3) : [];
      if (entries.length) add("nw-kv", entries.map(([k, v]) => `<span>${escHtml(k)}</span><span>${escHtml(String(v))}</span>`).join(""));
      else if (s.show.command) add("nw-kv", `<span>指令</span><span>${escHtml(s.show.command)}</span>`);
      else add("nw-bars", [24, 20, 23, 17, 14].map((h) => `<span style="height:${h}px"></span>`).join(""));
    } else {
      add("nw-lab", escHtml(s.label));
      if (kind === "code") {
        add("nw-code", s.code.length ? s.code.map(escHtml).join("\n") : " ");
        if (s.more) add("nw-more", "…");
      } else if (kind === "math") add("nw-tex", opts.inline(`$$${s.tex.replace(/\$\$/g, "")}$$`));
      else if (kind === "table") {
        add("nw-thead", s.table.head.slice(0, 4).map((h) => `<span>${escHtml(h || " ")}</span>`).join(""));
        add("nw-more", `${s.table.rows} 列 · ${s.table.head.length} 欄`);
      } else {
        if (s.title) add("nw-title", opts.inline(s.title));
        for (const r of s.rows) add(`nw-row${r.done ? " done" : ""}${r.quote ? " quote" : ""}`, `${r.mark ? `${escHtml(r.mark)} ` : ""}${opts.inline(r.text)}`);
        if (s.more) add("nw-more", "…");
        if (s.images.length) {
          const src = opts.imgSrc?.(s.images[0].ref);
          const ph = () => {
            const p = el("div", "nw-img-ph", `圖片${s.images[0].alt ? `：${escHtml(s.images[0].alt)}` : ""}`);
            return p;
          };
          if (!src) c.append(ph());
          else {
            const img = el("img", "nw-img");
            img.alt = s.images[0].alt || "圖片";
            img.draggable = false;
            img.style.height = "90px";
            const set = (u) => {
              if (u) img.src = u;
              else img.replaceWith(ph());
            };
            img.addEventListener("error", () => img.replaceWith(ph()));
            if (typeof src === "string") set(src);
            else Promise.resolve(src).then(set, () => set(null));
            c.append(img);
          }
          if (s.images.length > 1) add("nw-more", `另有 ${s.images.length - 1} 張圖`);
        }
      }
    }
    c.addEventListener("dblclick", (e) => {
      e.preventDefault();
      opts.onJump(item.run.start, item.path);
    });
    return c;
  }

  // ---- layout: each piece returns { w, h, draw(x, y) } ----
  function layout(model) {
    world.querySelectorAll(".nw-card, .nw-pill, .nw-rt, .nw-empty, .nw-fold").forEach((n) => n.remove());
    const paths = [];
    boxes = [];
    const line = (cls, d) => paths.push(`<path class="${cls}" d="${d}"></path>`);
    const put = (node, x, y, color) => {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      if (color) boxes.push({ x, y, w: node.offsetWidth, h: node.offsetHeight, color });
    };
    const measure = (node) => {
      world.append(node);
      return { w: node.offsetWidth, h: node.offsetHeight };
    };
    const countCells = (items) => items.reduce((n, it) => n + (it.kind === "cell" ? 1 : it.routes.reduce((m, r) => m + countCells(r.items), 0)), 0);

    function seq(items) {
      const parts = items.map((it) => (it.kind === "cell" ? card(it) : opts.isFolded(it.fork.key) ? folded(it) : fork(it)));
      const w = Math.max(0, ...parts.map((p) => p.w));
      const h = parts.reduce((s, p) => s + p.h, 0) + GAP * Math.max(0, parts.length - 1);
      return {
        w, h, n: parts.length,
        draw(x, y) {
          let cy = y;
          parts.forEach((p, k) => {
            if (k) line("c", `M${x + w / 2} ${cy - GAP}V${cy}`);
            p.draw(x + (w - p.w) / 2, cy);
            cy += p.h + GAP;
          });
        },
      };
    }
    function card(it) {
      const node = cardEl(it, model);
      const m = measure(node);
      return { w: m.w, h: m.h, draw: (x, y) => put(node, x, y, getComputedStyle(node).getPropertyValue("--cc") || "var(--n-c-text)") };
    }
    function empty() {
      const node = el("div", "nw-empty", "（這條路線還沒有內容）");
      const m = measure(node);
      return { w: m.w, h: m.h, draw: (x, y) => put(node, x, y) };
    }
    function pill(it) {
      const node = el("div", "nw-pill", `${ICON_FORK}<span>分岔：${escHtml(it.fork.name)}</span>`);
      const b = el("button", "nw-fold-btn", `${CHEV_UP}收起`);
      b.type = "button";
      b.title = "把這個分岔收成一張卡";
      b.setAttribute("aria-label", `收起分岔「${it.fork.name}」`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onFold(it.fork.key, true);
      });
      node.append(b);
      node.dataset.fork = it.fork.key;
      return node;
    }
    function routeTitle(it, r) {
      const on = opts.chosen(it.fork) === r.route;
      const shown = on && opts.visible(it.path);
      const node = el("button", `nw-rt${on ? " on" : ""}`, `<span>${escHtml(r.route.implicit ? "（第一條路線）" : r.route.name)}</span>${shown ? "<em>編輯器顯示中</em>" : ""}`);
      node.type = "button";
      node.dataset.route = r.route.name;
      node.dataset.fork = it.fork.key;
      node.title = on ? "編輯器顯示這條路線" : "按一下：編輯器改顯示這條路線";
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onRoute(it.fork, r.route);
      });
      return node;
    }
    function fork(it) {
      const p = pill(it);
      const pm = measure(p);
      const cols = it.routes.map((r) => {
        const title = routeTitle(it, r);
        const tm = measure(title);
        const body = r.items.length ? seq(r.items) : empty();
        return { title, tm, body, w: Math.max(tm.w, body.w) };
      });
      const colsW = cols.reduce((s, c) => s + c.w, 0) + COL_GAP * Math.max(0, cols.length - 1);
      const w = Math.max(pm.w, colsW);
      const bodyH = Math.max(0, ...cols.map((c) => c.body.h));
      const h = PILL_H + 14 + 10 + TITLE_H + 6 + bodyH + 20 + 12;
      return {
        w, h,
        draw(x, y) {
          const cx = x + w / 2;
          put(p, cx - pm.w / 2, y, "var(--n-c-branch)");
          const barY = y + PILL_H + 14;
          const titleY = barY + 10;
          const topY = titleY + TITLE_H + 6;
          const mergeY = y + h - 6;
          line("f", `M${cx} ${y + PILL_H}V${barY}`);
          let cxs = [];
          let left = x + (w - colsW) / 2;
          for (const c of cols) {
            const ccx = left + c.w / 2;
            cxs.push(ccx);
            line("f", `M${ccx} ${barY}V${titleY}`);
            put(c.title, ccx - c.tm.w / 2, titleY);
            c.body.draw(ccx - c.body.w / 2, topY);
            line("f", `M${ccx} ${topY + c.body.h}V${mergeY}`);
            left += c.w + COL_GAP;
          }
          if (cxs.length > 1) {
            line("f", `M${cxs[0]} ${barY}H${cxs[cxs.length - 1]}`);
            line("f", `M${cxs[0]} ${mergeY}H${cxs[cxs.length - 1]}`);
          }
          paths.push(`<circle class="m" cx="${cx}" cy="${mergeY}" r="6"></circle>`);
        },
      };
    }
    function folded(it) {
      const node = el("div", "nw-fold");
      node.dataset.fork = it.fork.key;
      const head = el("div", "nw-fold-head", `${ICON_FORK}<span>分岔：${escHtml(it.fork.name)}</span>`);
      const b = el("button", "nw-fold-btn", `${CHEV_DOWN}展開`);
      b.type = "button";
      b.setAttribute("aria-label", `展開分岔「${it.fork.name}」`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onFold(it.fork.key, false);
      });
      head.append(b);
      const chips = el("div", "nw-chips");
      for (const r of it.routes) {
        const on = opts.chosen(it.fork) === r.route;
        const chip = el("button", `nw-chip${on ? " on" : ""}`, escHtml(r.route.implicit ? "（第一條路線）" : r.route.name));
        chip.type = "button";
        chip.dataset.route = r.route.name;
        chip.title = on ? "編輯器顯示這條路線" : "按一下：編輯器改顯示這條路線";
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onRoute(it.fork, r.route);
        });
        chips.append(chip);
      }
      const n = countCells(it.routes.flatMap((r) => r.items));
      node.append(head, chips, el("div", "nw-fold-n", `${it.routes.length} 條路線 · ${n} 格 · 雙擊展開`));
      node.addEventListener("dblclick", (e) => {
        if (e.target.closest("button")) return;
        opts.onFold(it.fork.key, false);
      });
      const m = measure(node);
      return { w: m.w, h: m.h, draw: (x, y) => put(node, x, y, "var(--n-c-branch)") };
    }

    const root = seq(model.tree);
    const PAD = 40;
    root.draw(PAD, PAD);
    size = { w: root.w + PAD * 2, h: root.h + PAD * 2 };
    svg.setAttribute("width", String(size.w));
    svg.setAttribute("height", String(size.h));
    svg.innerHTML = paths.join("");
    world.style.width = `${size.w}px`;
    world.style.height = `${size.h}px`;
    none.hidden = root.n > 0;
    drawMap();
  }

  return {
    el: view,
    // model: { lines, info, tree }
    update(model) {
      if (view.hidden) return;
      layout(model);
      if (!placed) {
        placed = true;
        home();
      } else apply();
    },
    show() {
      view.hidden = false;
      placed = false;
    },
    hide() {
      view.hidden = true;
      pan = null;
    },
    fit,
    zoomBy: (k) => zoomAt(t.z * k, view.clientWidth / 2, view.clientHeight / 2),
    get transform() {
      return { ...t };
    },
  };
}
