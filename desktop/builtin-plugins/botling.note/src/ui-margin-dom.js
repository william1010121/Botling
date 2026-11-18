// botling.note, web part, margin comments: the small DOM helpers of ui-margin.js (the element maker, the icons, the clock, the bot's answer as
// Markdown). Moved out of ui-margin.js without a change (the file's size gate); ui-margin.js and ui-margin-float.js import them.

import { inline, openAnchor } from "./ui-text.js";

export const SVG = "http://www.w3.org/2000/svg";
const ICON = {
  chat: '<path d="M2.5 3h11v7.5H8l-3 2.5v-2.5H2.5z"/>',
  up: '<path d="M3.5 10l4.5-4.5 4.5 4.5"/>',
  reply: '<path d="M6.5 4L3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  min: '<path d="M3.5 8.5h9"/>',
  dock: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M10 3v10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5v-1h3v1M5 4.5l.5 8h5l.5-8"/>',
};
export const icon = (name) => `<svg class="nm-i" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
export const h = (tag, cls = "", txt = null) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt !== null) el.textContent = txt;
  return el;
};
export const clock = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
};
export const SCOPE_NAME = { selection: "選取文字", cell: "整個 cell", note: "整份 Note" };
export const newRid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// The bot's answer as Markdown, small: paragraphs, lists, headings (as bold), code fences; every line through the note's own inline().
export function mdEl(src, ccb, botId) {
  const box = h("div", "nm-md");
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = h("pre");
      pre.append(h("code", "", code.join("\n")));
      box.append(pre);
    } else if (!l.trim()) {
      i++;
    } else if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length && LIST.test(lines[i])) list.append(Object.assign(h("li"), { innerHTML: inline(lines[i++].replace(LIST, "")) }));
      box.append(list);
    } else if (/^#{1,6}\s/.test(l)) {
      box.append(Object.assign(h("p"), { innerHTML: `<strong>${inline(l.replace(/^#{1,6}\s+/, ""))}</strong>` }));
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++]);
      box.append(Object.assign(h("p"), { innerHTML: inline(para.join("\n")) }));
    }
  }
  box.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (!a) return;
    e.preventDefault();
    openAnchor(ccb, botId, a);
  });
  return box;
}
