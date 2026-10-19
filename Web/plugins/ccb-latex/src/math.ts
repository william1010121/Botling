import katex from "katex";
import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { escapeHTML } from "../../../src/util";

/**
 * LaTeX in messages: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` on their own.
 * Single dollars follow Pandoc's rule so prices are left alone: the opening `$` must have a
 * non-space right after it, and the closing `$` a non-space right before it and no digit right
 * after it. `\$` is a plain dollar sign. Code is never touched.
 */
export function renderMath(tex: string, display: boolean): string {
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    output: "htmlAndMathml",
    strict: "ignore",
    trust: false,
  });
  return display ? `<div class="math-display">${html}</div>` : `<span class="math-inline">${html}</span>`;
}

/** The index of the `$` that closes an inline formula opened at `open`, or -1. */
export function closingDollar(src: string, open: number): number {
  const first = src[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  let at = open + 1;
  for (;;) {
    at = src.indexOf("$", at);
    if (at === -1) return -1;
    const before = src[at - 1];
    const after = src[at + 1] ?? "";
    if (before !== "\\" && !/\s/.test(before) && !/[0-9]/.test(after) && at > open + 1) return at;
    at += 1;
  }
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  const char = src[start];

  // \( … \) and \[ … \]
  if (char === "\\" && (src[start + 1] === "(" || src[start + 1] === "[")) {
    const display = src[start + 1] === "[";
    const close = src.indexOf(display ? "\\]" : "\\)", start + 2);
    if (close === -1) return false;
    if (!silent) {
      const token = state.push(display ? "math_display" : "math_inline", "", 0);
      token.content = src.slice(start + 2, close);
    }
    state.pos = close + 2;
    return true;
  }
  if (char !== "$") return false;

  // $$ … $$ inside a line: shown on its own line.
  if (src[start + 1] === "$") {
    const close = src.indexOf("$$", start + 2);
    if (close === -1 || src.slice(start + 2, close).trim() === "") return false;
    if (!silent) {
      const token = state.push("math_display", "", 0);
      token.content = src.slice(start + 2, close);
    }
    state.pos = close + 2;
    return true;
  }

  const close = closingDollar(src, start);
  if (close === -1) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = src.slice(start + 1, close);
  }
  state.pos = close + 1;
  return true;
}

/** A `$$` or `\[` that starts a line, to its closing pair (same line or later). */
function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const first = state.src.slice(lineStart, lineEnd);
  const opener = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
  if (!opener) return false;
  const closer = opener === "$$" ? "$$" : "\\]";

  let content = "";
  let line = startLine;
  const rest = first.slice(2);
  const sameLine = rest.indexOf(closer);
  if (sameLine !== -1) {
    if (rest.slice(sameLine + 2).trim() !== "") return false; // text after it: leave to inline
    content = rest.slice(0, sameLine);
  } else {
    const parts = [rest];
    let found = false;
    for (line = startLine + 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      const at = text.indexOf(closer);
      if (at !== -1) {
        parts.push(text.slice(0, at));
        found = true;
        break;
      }
      parts.push(text);
    }
    if (!found) return false;
    content = parts.join("\n");
  }
  if (silent) return true;
  const token = state.push("math_display", "", 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  // Before `escape`, which would otherwise turn `\(` into `(`.
  md.inline.ruler.before("escape", "math_inline", inlineMath);
  md.block.ruler.before("fence", "math_block", blockMath, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, false);
  md.renderer.rules.math_display = (tokens, index) => renderMath(tokens[index].content, true);
}

/**
 * Your own messages are plain text, not markdown, but their formulas are still typeset.
 * Everything else is escaped and line breaks are kept.
 */
export function renderPlainWithMath(text: string): string {
  let html = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\" && text[i + 1] === "$") {
      html += "$";
      i += 2;
      continue;
    }
    if (char === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const display = text[i + 1] === "[";
      const close = text.indexOf(display ? "\\]" : "\\)", i + 2);
      if (close !== -1) {
        html += renderMath(text.slice(i + 2, close), display);
        i = close + 2;
        continue;
      }
    }
    if (char === "$" && text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1 && text.slice(i + 2, close).trim() !== "") {
        html += renderMath(text.slice(i + 2, close), true);
        i = close + 2;
        continue;
      }
    }
    if (char === "$") {
      const close = closingDollar(text, i);
      if (close !== -1) {
        html += renderMath(text.slice(i + 1, close), false);
        i = close + 1;
        continue;
      }
    }
    html += escapeHTML(char);
    i += 1;
  }
  return html.replace(/\n/g, "<br>");
}
