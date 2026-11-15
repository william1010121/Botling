// botling.note, web part: markdown text helpers and the line renderer (moved out of ui.js, text unchanged).

import katex from "katex";
import { srcFor } from "./assets.js";
import { classifyLines } from "../../../src/core/note-cells.ts";

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function mathHtml(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml" });
  } catch (error) {
    const cls = display ? "n-math-block n-math-err" : "n-math-err";
    const t = esc(display ? tex : `$${tex}$`);
    return `<span class="${cls}" title="${esc(String(error?.message ?? "Math error").slice(0, 300))}">${t}</span>`;
  }
}

// Inline $…$: currency-safe. The opening $ is not followed by a space, the closing $ is not preceded
// by a space and not followed by a digit, so "$4 and $20" stays text.
const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$])/g;

// Open a link through the app: web links in the default browser, .md in the app's preview, other files by the system.
function openHref(ccb, botId, href) {
  if (!href || href.startsWith("#")) return;
  if (typeof ccb.openLink !== "function") return ccb.notify?.("This Botling version cannot open links yet.");
  Promise.resolve()
    .then(() => ccb.openLink(href, { botId }))
    .catch((error) => ccb.notify?.(`Could not open ${href}: ${error?.message ?? error}`));
}

// The markdown link [text](href) that covers position pos of a raw line, or "".
function hrefAt(line, pos) {
  const re = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?|mailto):[^>\s]+)>/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[0].startsWith("!")) continue;
    if (pos >= m.index && pos <= m.index + m[0].length) return m[1] ?? m[2] ?? "";
  }
  return "";
}

// Inline markdown for one line (input is raw text; output is safe HTML).
export function inline(raw) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let src = raw.replace(/\u0000/g, "");
  src = src
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
    .replace(/\\\$/g, () => keep("$"))
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt, ref) =>
      keep(`<span class="n-img" data-ref="${esc(ref)}" data-alt="${esc(alt)}"></span>`))
    .replace(/\$\$(.+?)\$\$/g, (_, t) => keep(mathHtml(t.trim(), false)))
    .replace(INLINE_MATH, (_, t) => keep(mathHtml(t, false)));
  let s = esc(src);
  s = s
    .replace(/\[([^\]]+)\]\(\s*(?:&lt;)?([^\s)]+?)(?:&gt;)?(?:\s+&quot;[^)]*?&quot;)?\s*\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, (_, p, t) => `${p}<em>${t}</em>`)
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, (_, p, t) => `${p}<em>${t}</em>`)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

// Fill the image spans of a rendered element through the adapter (never rejects).
function hydrateImages(root) {
  for (const span of root.querySelectorAll(".n-img:not([data-done])")) {
    span.dataset.done = "1";
    const ref = span.dataset.ref ?? "";
    const alt = span.dataset.alt ?? "";
    const placeholder = () => {
      span.textContent = "";
      const ph = document.createElement("span");
      ph.className = "n-img-ph";
      ph.textContent = `Image unavailable · ${alt || ref.split("/").pop()}`;
      ph.title = ref;
      span.append(ph);
    };
    let got;
    try {
      got = srcFor(ref);
    } catch {
      got = null;
    }
    Promise.resolve(got).then((url) => {
      if (!url) return placeholder();
      const img = document.createElement("img");
      img.alt = alt;
      img.loading = "lazy";
      img.addEventListener("error", placeholder);
      img.src = url;
      span.textContent = "";
      span.append(img);
    }, placeholder);
  }
}

// What each line is, given the whole text (fences, $$ blocks, cards, tables): the app's one copy of the rules.
export const classify = classifyLines;

function mathBlockEl(lines, start, end) {
  const parts = lines.slice(start, end + 1);
  parts[0] = parts[0].replace(/^\s*\$\$/, "");
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\$\$.*$/, "");
  const tex = parts.join("\n").trim();
  const el = document.createElement("div");
  el.className = "nl nl-math";
  el.dataset.i = String(start);
  if (!tex) {
    el.classList.add("nl-empty");
    el.innerHTML = "&nbsp;";
    return el;
  }
  const h = mathHtml(tex, true);
  el.innerHTML = h.startsWith('<span class="n-math-block') ? h : `<div class="n-math-block">${h}</div>`;
  return el;
}

// "> " quote levels at the start of a line ("> > x", ">> x", up to 3 spaces before each `>`).
const QUOTE_LEAD = /^ {0,3}>[ \t]?/;
function quoteOfLine(line) {
  let depth = 0;
  let rest = line;
  let m;
  while ((m = QUOTE_LEAD.exec(rest))) {
    depth++;
    rest = rest.slice(m[0].length);
  }
  return { depth, rest };
}
const QUOTE_STEP = 14; // px per quote level
// The bars of a quote line (or of the text box editing one); `extra` is the line's own indent.
function quoteBars(el, depth, extra = 0) {
  for (const b of el.querySelectorAll(":scope > .nq-bar")) b.remove();
  el.classList.toggle("nl-quote", depth > 0);
  if (!depth) {
    delete el.dataset.qd;
    return;
  }
  el.dataset.qd = String(depth);
  el.style.paddingLeft = `${depth * QUOTE_STEP + extra}px`;
  for (let k = 0; k < depth; k++) {
    const b = document.createElement("span");
    b.className = "nq-bar";
    b.style.left = `${k * QUOTE_STEP + 2}px`;
    el.append(b);
  }
}
// Consecutive quote lines are one blockquote: a level's bar is rounded (and the quote spaced) only where that level starts
// or ends, not between two lines of it.
function joinQuotes(root) {
  const depthOf = (el) => (el && el.classList.contains("nl") ? Number(el.dataset.qd || 0) : 0);
  for (const el of root.querySelectorAll(".nl[data-qd]")) {
    const d = depthOf(el);
    let p = el.previousElementSibling;
    while (p && p.classList.contains("nl") && getComputedStyle(p).display === "none") p = p.previousElementSibling;
    let n = el.nextElementSibling;
    while (n && n.classList.contains("nl") && getComputedStyle(n).display === "none") n = n.nextElementSibling;
    const pd = depthOf(p);
    const nd = depthOf(n);
    el.classList.toggle("nq-start", pd === 0);
    el.classList.toggle("nq-end", nd === 0);
    [...el.querySelectorAll(":scope > .nq-bar")].forEach((b, k) => {
      b.classList.toggle("nq-top", pd <= k);
      b.classList.toggle("nq-bot", nd <= k);
    });
    if (d === 0) delete el.dataset.qd;
  }
}

function drawLine(line, info, index, toggle, raw) {
  const el = document.createElement("div");
  el.className = "nl";
  el.dataset.i = String(index);
  if (raw && info.kind !== "text") {
    el.classList.add("nl-raw");
    el.textContent = line || " ";
    return el;
  }
  if (info.kind === "fence") {
    const isOpen = info.open;
    el.classList.add("nl-fence");
    if (info.empty) el.classList.add("nl-fence-hidden");
    if (!isOpen) el.classList.add("nl-fence-end");
    else if (info.lang) {
      el.classList.add("nl-fence-lang");
      el.textContent = info.lang;
    }
    return el;
  }
  if (info.kind === "code") {
    el.classList.add("nl-code");
    if (info.empty) el.classList.add("nl-fence-hidden");
    el.textContent = line || " ";
    return el;
  }
  if (!line.trim()) {
    el.classList.add("nl-empty");
    el.innerHTML = "&nbsp;";
    return el;
  }
  const q = quoteOfLine(line);
  if (q.depth) {
    // a quote line: what follows the `>`s is drawn as a line of its own (a list item, a heading...), inside the bars
    const el = drawLine(q.rest, info, index, toggle, false);
    if (el.classList.contains("nl-empty")) {
      el.classList.remove("nl-empty");
      el.textContent = "\u00a0";
    }
    el.classList.remove("nl-doc-first");
    quoteBars(el, q.depth, parseFloat(el.style.paddingLeft) || 0);
    return el;
  }
  let m;
  if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
    el.classList.add(`nl-h${m[1].length}`);
    if (index === 0) el.classList.add("nl-doc-first");
    el.innerHTML = inline(m[2]);
  } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    el.classList.add("nl-hr");
  } else if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s(.*)$/.exec(line))) {
    const done = m[2] !== " ";
    el.classList.add("nl-li");
    if (done) el.classList.add("nl-done");
    el.style.paddingLeft = `${m[1].length * 6}px`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cb";
    box.checked = done;
    box.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(index, !done);
    });
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.append(box);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.innerHTML = inline(m[3]);
    el.append(mark, txt);
  } else if ((m = /^(\s*)([-*+]|\d+[.)])\s(.*)$/.exec(line))) {
    el.classList.add("nl-li");
    el.style.paddingLeft = `${m[1].length * 6}px`;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = /\d/.test(m[2]) ? m[2] : "•";
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.innerHTML = inline(m[3]);
    el.append(mark, txt);
  } else if ((m = /^\s*\$\$(.+?)\$\$\s*$/.exec(line))) {
    const h = mathHtml(m[1].trim(), true);
    el.innerHTML = h.startsWith('<span class="n-math-block') ? h : `<div class="n-math-block">${h}</div>`;
  } else {
    el.innerHTML = inline(line);
  }
  hydrateImages(el);
  return el;
}

const svg = (inner, w = 14) =>
  `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
// 問: a speech bubble with quote marks
const ASK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.8V16A2.5 2.5 0 0 1 4 13.5z"/><path d="M9.2 8.5h1.9v2.1c0 1.1-.6 1.9-1.7 2.2M13.4 8.5h1.9v2.1c0 1.1-.6 1.9-1.7 2.2"/></svg>';
const FORK_SVG = svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-11.5 8.5"/>', 13);
const ICONS = {
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>'),
  card: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'),
  branch: FORK_SVG,
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

// The "/" and "+" insert menu. `keys` are what typing after "/" is matched against.
const INSERT_ITEMS = [
  { id: "h1", ic: "H1", label: "標題 1", keys: "heading h1 title 標題 大標" },
  { id: "h2", ic: "H2", label: "標題 2", keys: "heading h2 標題" },
  { id: "h3", ic: "H3", label: "標題 3", keys: "heading h3 標題" },
  { id: "todo", ic: "☐", label: "待辦", keys: "todo task checkbox check list 待辦 清單" },
  { id: "image", ic: ICONS.image, label: "圖片", keys: "image img picture photo 圖片 照片" },
  { id: "card", ic: ICONS.card, label: "卡片", hint: "組件", keys: "card show component 卡片 組件" },
  { id: "code", ic: "{ }", label: "程式碼", keys: "code fence 程式碼" },
  { id: "math", ic: "∑", label: "數學", keys: "math formula latex 數學 公式" },
  { id: "table", ic: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>'), label: "表格", keys: "table grid 表格 表" },
  { id: "branch", ic: ICONS.branch, label: "分支", hint: "⌘⇧B", keys: "branch fork route 分支 路線 分叉" },
];

export { openHref, hrefAt, hydrateImages, mathBlockEl, QUOTE_LEAD, quoteOfLine, QUOTE_STEP, quoteBars, joinQuotes, drawLine, svg, ASK_SVG, FORK_SVG, ICONS, INSERT_ITEMS };
