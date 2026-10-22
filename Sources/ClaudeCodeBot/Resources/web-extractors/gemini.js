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

// The element's words with line breaks where the page breaks lines (innerText without layout).
// A number in `out` is a break: 1 a new line, 2 a blank line; breaks in a row keep the largest.
function textOf(element) {
  const out = [];
  const code = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.nodeValue.replace(/\s+/g, " ")); return; }
    if (node.nodeType !== 1 || node.matches(SELECTORS.skip)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") { out.push(1); return; }
    if (tag === "pre") {
      // Code keeps its own spacing: put back after the lines are tidied.
      code.push("```\n" + node.textContent.replace(/\n+$/, "") + "\n```");
      out.push(2, "\u0000" + (code.length - 1) + "\u0000", 2);
      return;
    }
    const line = node.classList.contains("query-text-line") ? 1 : PARAGRAPHS.has(tag) ? 2 : LINES.has(tag) ? 1 : 0;
    if (line) out.push(line);
    if (tag === "li") out.push("- ");
    for (const child of node.childNodes) walk(child);
    if (tag === "td" || tag === "th") out.push(" | ");
    if (line) out.push(line);
  };
  walk(element);
  let text = "";
  let pending = 0;
  for (const piece of out) {
    if (typeof piece === "number") { pending = Math.max(pending, piece); continue; }
    // Spaces between two blocks are no words.
    if (pending && !piece.trim()) continue;
    if (pending) { text += "\n".repeat(pending); pending = 0; }
    text += piece;
  }
  return text
    .split("\n").map((part) => part.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
