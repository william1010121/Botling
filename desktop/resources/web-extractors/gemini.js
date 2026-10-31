// Reads the conversation on a gemini.google.com page. Contract: README.md next to this file.
// Only reads the page: never types, clicks or changes it.
//
// When Gemini changes its page, fix the selectors here; nothing else in the app needs to change.
const SELECTORS = {
  // Every message, in page order: what you asked and what Gemini answered.
  turns: "user-query, model-response",
  // Inside a user-query: the text you wrote.
  userText: ".query-text, .query-content",
  // Inside a model-response: the answer itself.
  answerText: "message-content .markdown, message-content",
  // The conversation's name, where the page shows it (the selected row in its side list).
  title: "[data-test-id='conversation-title'], .conversation.selected .conversation-title, .selected .conversation-title",
  // A formula: Gemini's wrapper (its TeX in data-math), else KaTeX's own element (its TeX in an
  // annotation). Its text is no use: KaTeX draws each formula three times (MathML, TeX, HTML).
  math: "[data-math], .katex-display, .katex",
  mathTex: "annotation[encoding='application/x-tex']",
  // A formula on a line of its own.
  displayMath: ".math-block, .katex-display",
  // Parts of a message that are not its words: screen-reader labels, buttons, its thinking.
  skip: ".cdk-visually-hidden, .screen-reader-only, button, mat-icon, model-thoughts, .thoughts-container, script, style",
};

function extract(doc) {
  const turns = [];
  for (const node of doc.querySelectorAll(SELECTORS.turns)) {
    const isUser = node.tagName.toLowerCase() === "user-query";
    const body = node.querySelector(isUser ? SELECTORS.userText : SELECTORS.answerText);
    const text = body ? textOf(body) : "";
    if (text) turns.push({ role: isUser ? "user" : "assistant", text });
  }
  const titleNode = doc.querySelector(SELECTORS.title);
  const title = titleNode ? textOf(titleNode) : null;
  return { title: title || null, turns };
}

// Elements that start a new line, and those that also leave a blank line around them.
const LINES = new Set(["div", "section", "article", "li", "tr", "dt", "dd", "hr"]);
const PARAGRAPHS = new Set(["p", "ul", "ol", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

// A formula's TeX, as Markdown math: `$…$` in a line, `$$…$$` on its own; null when it has none.
function mathOf(node) {
  const annotation = node.querySelector(SELECTORS.mathTex);
  const tex = (node.getAttribute("data-math") || (annotation && annotation.textContent) || "").trim();
  if (!tex) return null;
  const display = node.matches(SELECTORS.displayMath) || node.querySelector(SELECTORS.displayMath) !== null;
  return { tex, display };
}

// A list item's bullet: the item's first words follow it on its line.
const BULLET = "\u0001";

// The element's words with line breaks where the page breaks lines (innerText without layout).
// A number in `out` is a break: 1 a new line, 2 a blank line; breaks in a row keep the largest.
function textOf(element) {
  const out = [];
  const code = [];
  // Inside a list item, paragraphs are lines: the list stays tight.
  let items = 0;
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.nodeValue.replace(/\s+/g, " ")); return; }
    if (node.nodeType !== 1 || node.matches(SELECTORS.skip)) return;
    if (node.matches(SELECTORS.math)) {
      const math = mathOf(node);
      if (math) {
        // Kept whole, like code: its spacing is TeX's.
        code.push(math.display ? "$$" + math.tex + "$$" : "$" + math.tex + "$");
        const piece = "\u0000" + (code.length - 1) + "\u0000";
        if (math.display) out.push(2, piece, 2); else out.push(piece);
        return;
      }
    }
    const tag = node.tagName.toLowerCase();
    if (tag === "br") { out.push(1); return; }
    if (tag === "pre") {
      // Code keeps its own spacing: put back after the lines are tidied.
      code.push("```\n" + node.textContent.replace(/\n+$/, "") + "\n```");
      out.push(2, "\u0000" + (code.length - 1) + "\u0000", 2);
      return;
    }
    const paragraph = PARAGRAPHS.has(tag) ? (items > 0 ? 1 : 2) : 0;
    const line = node.classList.contains("query-text-line") ? 1 : paragraph || (LINES.has(tag) ? 1 : 0);
    if (line) out.push(line);
    if (tag === "li") { out.push(BULLET); items += 1; }
    for (const child of node.childNodes) walk(child);
    if (tag === "li") items -= 1;
    if (tag === "td" || tag === "th") out.push(" | ");
    if (line) out.push(line);
  };
  walk(element);
  let text = "";
  let pending = 0;
  let bulleted = false;
  for (const piece of out) {
    // Right after a bullet, a break (its item's paragraph) or spaces are no line of their own.
    if (bulleted && (typeof piece === "number" || !piece.trim())) continue;
    if (typeof piece === "number") { pending = Math.max(pending, piece); continue; }
    // Spaces between two blocks are no words.
    if (pending && !piece.trim()) continue;
    if (pending) { text += "\n".repeat(pending); pending = 0; }
    if (piece === BULLET) { text += "- "; bulleted = true; continue; }
    bulleted = false;
    text += piece;
  }
  return text
    .split("\n").map((part) => part.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
