// Reads grok.com conversations. Contract: README.md next to this file.
// Read only. User marker observed on the public page; answer class and /c/:id route
// verified in Grok's public page assets (2026-10-23). Authenticated answers untested.
// Everything below `extract` shares the other readers' Markdown conversion.
const SELECTORS = {
  user: "[data-testid='user-message']",
  assistant: ".response-content-markdown",
  userText: ".whitespace-pre-wrap",
  answerText: ".response-content-markdown",
  streaming: "[data-is-streaming='true'], [aria-busy='true']",
  // Conservative guard for pages exposing a stop control while an answer is pending.
  stop: "button[aria-label='Stop'], button[aria-label='Stop generating'], button[aria-label='Stop response'], button[data-testid='stop-button']",
  title: "[data-testid='conversation-title']",
  keepLines: ".whitespace-pre-wrap",
  math: ".katex-display, .katex",
  mathTex: "annotation[encoding='application/x-tex']",
  displayMath: ".katex-display",
  skip: ".sr-only, .thinking-container, .not-prose, button, [role='button'], [aria-hidden='true'], svg, form, script, style, .katex-mathml",
};

function extract(doc) {
  const pick = SELECTORS.user + ", " + SELECTORS.assistant;
  const found = Array.from(doc.querySelectorAll(pick))
    .filter((node) => !node.closest(SELECTORS.skip));
  // A message inside another one found (a message element in its turn's wrapper) is read with it.
  const messages = outermost(found);
  const turns = [];
  const lastAnswer = messages.filter((node) => node.matches(SELECTORS.assistant)).at(-1);
  const generating = !!doc.querySelector(SELECTORS.stop);
  for (const node of messages) {
    const isUser = node.matches(SELECTORS.user);
    if (!isUser && (node.closest(SELECTORS.streaming) || node.querySelector(SELECTORS.streaming)
      || (generating && node === lastAnswer))) continue;
    const inner = SELECTORS[isUser ? "userText" : "answerText"];
    const bodies = outermost(Array.from(node.querySelectorAll(inner)).filter((body) => !skippedWithin(body, node)));
    const text = (bodies.length ? bodies : [node]).map(markdownOf).filter(Boolean).join("\n\n");
    if (!text) continue;
    const role = isUser ? "user" : "assistant";
    const last = turns[turns.length - 1];
    // An answer in several messages (around a tool it used) is one answer.
    if (last && last.role === role && role === "assistant") last.text += "\n\n" + text;
    else turns.push({ role, text });
  }
  const titleNode = doc.querySelector(SELECTORS.title);
  const title = titleNode ? plainOf(titleNode) : "";
  return { title: title || null, turns };
}

// ---- The page as Markdown (the same in each site's script) ----

// The elements not inside another one of them.
function outermost(nodes) {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

// Elements that are blocks of their own (a paragraph, a list, …), not words in a line.
const BLOCKS = "p, div, section, article, header, footer, main, aside, figure, figcaption, details, summary, ul, ol, li, pre, blockquote, table, hr, h1, h2, h3, h4, h5, h6";

// A formula's TeX: `$…$` in a line, `$$…$$` on its own; its drawn text when it has no TeX.
function mathOf(node) {
  const annotation = node.querySelector(SELECTORS.mathTex);
  const tex = (node.getAttribute("data-math") || (annotation && annotation.textContent) || "").trim();
  const display = node.matches(SELECTORS.displayMath) || node.querySelector(SELECTORS.displayMath) !== null;
  if (!tex) {
    const drawn = node.querySelector(".katex-html");
    return { text: (drawn || node).textContent.replace(/\s+/g, " ").trim(), display };
  }
  return { text: display ? "$$" + tex + "$$" : "$" + tex + "$", display };
}

function skipped(node) {
  return node.nodeType !== 1 || node.matches(SELECTORS.skip);
}

// Inside a part that is not words (its folded thinking), below `root`.
function skippedWithin(node, root) {
  for (let at = node; at && at !== root; at = at.parentElement) if (skipped(at)) return true;
  return false;
}

// A message as Markdown: its blocks with a blank line between them.
function markdownOf(element) {
  return blocksOf(element, element.matches(SELECTORS.keepLines)).join("\n\n");
}

// The element's text, plain, on one line (a title).
function plainOf(element) {
  return blocksOf(element, false).join(" ").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
}

// An element's children as Markdown blocks: words in a row are one paragraph, block elements
// their own blocks. A line naming a code block's language right before it is the fence's.
function blocksOf(element, keepLines) {
  const blocks = [];
  let line = "";
  const flush = () => {
    const text = tidy(line, keepLines);
    if (text) blocks.push(text);
    line = "";
  };
  for (const child of element.childNodes) {
    if (child.nodeType === 3) { line += keepLines ? child.nodeValue : child.nodeValue.replace(/\s+/g, " "); continue; }
    if (skipped(child)) continue;
    const keeps = keepLines || child.matches(SELECTORS.keepLines);
    if (child.matches(SELECTORS.math)) {
      const math = mathOf(child);
      if (math.display) { flush(); if (math.text) blocks.push(math.text); } else line += verbatim(math.text);
      continue;
    }
    const isBlock = child.matches(BLOCKS) || child.querySelector(BLOCKS + ", " + SELECTORS.displayMath) !== null;
    if (!isBlock) { line += inlineOf(child, keeps); continue; }
    flush();
    blocks.push(...blockOf(child, keeps));
  }
  flush();
  return blocks.filter((block, index) => {
    const next = blocks[index + 1];
    return !(next && !block.includes("\n") && next.toLowerCase().startsWith("```" + block.toLowerCase() + "\n"));
  });
}

// One block element as Markdown blocks.
function blockOf(node, keepLines) {
  const tag = node.tagName.toLowerCase();
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const text = blocksOf(node, keepLines).join(" ");
    return text ? ["#".repeat(Number(heading[1])) + " " + text] : [];
  }
  if (tag === "pre") return [codeOf(node)];
  if (tag === "hr") return ["---"];
  if (tag === "ul" || tag === "ol") {
    const list = listOf(node, keepLines);
    return list ? [list] : [];
  }
  if (tag === "table") {
    const table = tableOf(node);
    return table ? [table] : [];
  }
  if (tag === "blockquote") {
    const text = blocksOf(node, keepLines).join("\n\n");
    return text ? [text.split("\n").map((part) => (part ? "> " + part : ">")).join("\n")] : [];
  }
  return blocksOf(node, keepLines);
}

// Code keeps its own spacing; its language from its class (`language-python`).
function codeOf(pre) {
  const code = pre.querySelector("code") || pre;
  const named = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec((code.getAttribute("class") || "") + " " + (pre.getAttribute("class") || ""));
  return "```" + (named ? named[1] : "") + "\n" + code.textContent.replace(/\n+$/, "") + "\n```";
}

// A list: each item on its own line after its bullet (a number in a numbered list, from its
// `start`); what else is in an item (a list in it) indented under it.
function listOf(list, keepLines) {
  const ordered = list.tagName.toLowerCase() === "ol";
  let number = Number(list.getAttribute("start")) || 1;
  const lines = [];
  for (const item of list.children) {
    if (item.tagName.toLowerCase() !== "li" || skipped(item)) continue;
    const marker = ordered ? number++ + ". " : "- ";
    const parts = blocksOf(item, keepLines);
    if (!parts.length) continue;
    const pad = " ".repeat(marker.length);
    lines.push(parts.map((part, index) => part.split("\n").map((row, at) => (index === 0 && at === 0 ? marker : row ? pad : "") + row).join("\n")).join("\n"));
  }
  return lines.join("\n");
}

// A table as Markdown's: its first row the header.
function tableOf(table) {
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.children).filter((cell) => /^t[hd]$/i.test(cell.tagName))
      .map((cell) => blocksOf(cell, false).join(" ").replace(/\|/g, "\\|")))
    .filter((cells) => cells.length);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells) => "| " + Array.from({ length: width }, (_, i) => cells[i] || "").join(" | ") + " |";
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

// An element in a line: its words, with Markdown for code, bold, italics and links.
function inlineOf(node, keepLines) {
  if (node.nodeType === 3) return keepLines ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");
  if (skipped(node)) return "";
  if (node.matches(SELECTORS.math)) return verbatim(mathOf(node).text);
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "code") return verbatim("`" + node.textContent + "`");
  const keeps = keepLines || node.matches(SELECTORS.keepLines);
  const inner = Array.from(node.childNodes).map((child) => inlineOf(child, keeps)).join("");
  if (!inner.trim()) return inner;
  const wrap = (mark) => {
    const lead = inner.match(/^\s*/)[0];
    const trail = inner.match(/\s*$/)[0];
    return lead + mark + inner.trim() + mark + trail;
  };
  if (tag === "strong" || tag === "b") return wrap("**");
  if (tag === "em" || tag === "i") return wrap("*");
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    return /^https?:\/\//.test(href) && href !== inner.trim() ? "[" + inner.trim() + "](" + href + ")" : inner;
  }
  return inner;
}

// Text kept as it is (a formula's TeX, inline code) while the line around it is tidied.
const VERBATIM = [];
function verbatim(text) {
  VERBATIM.push(text);
  return "\u0000" + (VERBATIM.length - 1) + "\u0000";
}

// A paragraph's text: no spaces at its lines' ends, no runs of blank lines. Typed text keeps its
// own spacing inside its lines.
function tidy(text, keepLines) {
  const lines = text.split("\n").map((part) => (keepLines ? part.replace(/\s+$/, "") : part.replace(/[ \t]+/g, " ").trim()));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().replace(/\u0000(\d+)\u0000/g, (_, index) => VERBATIM[Number(index)]);
}
