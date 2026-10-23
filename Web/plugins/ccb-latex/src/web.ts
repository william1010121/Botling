import type { CcbWeb } from "../../../src/plugins";
import { closingDollar, mathPlugin, renderMath, renderPlainWithMath } from "./math";

/**
 * LaTeX for Botling: formulas in messages (bot replies through markdown-it, your own messages after
 * they are drawn), a live preview above the input box while the caret is inside a formula, and
 * copying a typeset formula copies its TeX.
 */
export function activate(ccb: CcbWeb): () => void {
  ccb.messages.use(mathPlugin);

  ccb.messages.afterRender((element, message) => {
    if (message.role !== "user") return;
    const bubble = element.querySelector<HTMLElement>(".user-bubble");
    if (bubble && /[$\\]/.test(message.text)) bubble.innerHTML = renderPlainWithMath(message.text);
  });

  // The preview: shown while the caret is inside a formula in the input box.
  let hidePreview: (() => void) | null = null;
  let shown = "";
  const preview = (text: string, caret: number) => {
    const formula = ccb.settings.get<boolean>("ccb-latex.preview") === false ? null : formulaAt(text, caret);
    const key = formula ? `${formula.display}${formula.tex}` : "";
    if (key === shown) return;
    shown = key;
    hidePreview?.();
    hidePreview = formula && formula.tex.trim() ? ccb.composer.showPopover(renderMath(formula.tex, formula.display)) : null;
  };
  ccb.composer.addExtension(
    ccb.codemirror.view.EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        preview(update.state.doc.toString(), update.view.hasFocus ? update.state.selection.main.head : -1);
      }
    }),
  );

  ccb.commands.register("ccb-latex.insert", () => {
    const view = ccb.composer.view;
    const range = view.state.selection.main;
    const selected = view.state.sliceDoc(range.from, range.to);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `$${selected}$` },
      selection: { anchor: range.from + 1, head: range.from + 1 + selected.length },
    });
    view.focus();
  });

  const onCopy = (event: ClipboardEvent) => copyAsTeX(event, ccb.settings.get<boolean>("ccb-latex.copyTeX") !== false);
  document.addEventListener("copy", onCopy);

  return () => {
    hidePreview?.();
    document.removeEventListener("copy", onCopy);
  };
}

/** The formula the caret is in (between its delimiters), or null. */
export function formulaAt(text: string, caret: number): { tex: string; display: boolean } | null {
  if (caret < 0) return null;
  const pairs: [string, string, boolean][] = [["$$", "$$", true], ["\\[", "\\]", true], ["\\(", "\\)", false]];
  for (const [open, close, display] of pairs) {
    const start = text.lastIndexOf(open, caret - open.length);
    if (start === -1) continue;
    const end = text.indexOf(close, start + open.length);
    // An unclosed formula still previews while you type it.
    if (end === -1 ? caret >= start + open.length : caret >= start + open.length && caret <= end) {
      // `$$` is opened only if the dollars before it pair up.
      if (open === "$$" && countOf(text.slice(0, start), "$$") % 2 === 1) continue;
      return { tex: text.slice(start + open.length, end === -1 ? text.length : end), display };
    }
  }
  // Single dollars: walk the formulas from the start of the text.
  let at = 0;
  while ((at = text.indexOf("$", at)) !== -1) {
    if (text[at + 1] === "$") {
      const end = text.indexOf("$$", at + 2);
      if (end === -1) return null;
      at = end + 2;
      continue;
    }
    if (text[at - 1] === "\\") { at += 1; continue; }
    const end = closingDollar(text, at);
    if (end === -1) {
      // Only when it already looks like TeX, so a price does not pop up a preview.
      const rest = text.slice(at + 1);
      return caret > at && !/^\s/.test(rest) && /[\\^_{]/.test(rest) ? { tex: rest, display: false } : null;
    }
    if (caret > at && caret <= end) return { tex: text.slice(at + 1, end), display: false };
    at = end + 1;
  }
  return null;
}

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Copying typeset formulas copies their TeX source, written as `$…$` or `$$…$$`. */
function copyAsTeX(event: ClipboardEvent, enabled: boolean): void {
  const selection = window.getSelection();
  if (!enabled || !selection || selection.isCollapsed || !event.clipboardData) return;
  const fragment = selection.getRangeAt(0).cloneContents();
  const formulas = fragment.querySelectorAll(".katex-display, .katex");
  if (!formulas.length) return;
  for (const formula of fragment.querySelectorAll(".katex-display, .katex:not(.katex-display .katex)")) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex == null) continue;
    const display = formula.classList.contains("katex-display");
    formula.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : `$${tex}$`));
  }
  event.clipboardData.setData("text/plain", fragment.textContent ?? "");
  event.preventDefault();
}
