// A Markdown result (`artifacts/x.md`) as the page a preview card's frame and its full-page window load: rendered by
// the chat's own markdown (Web/src/markdown.ts, with ccb-latex's math) and styled by the chat's own stylesheet, so it
// reads like a long bot reply. Raw HTML in the file is shown as text (the chat's markdown never runs it) and the page
// gets no scripts at all; pictures beside the file load from botling-card://preview like a result page's.
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type MarkdownIt from "markdown-it";
import { createMarkdown, mediaHTML } from "../../../Web/src/markdown";
import { escapeHTML } from "../../../Web/src/util";
import { mathPlugin } from "../../builtin-plugins/ccb-latex/src/math";
import { markdownTitle, previewURL } from "../core/preview-url";

/** What a Markdown page may load: its own inline styles, pictures beside it, KaTeX's inlined fonts. No scripts, frames, forms or network. */
export const MARKDOWN_CSP = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src botling-card://preview data:",
  "media-src botling-card://preview",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Where a picture the file names loads from: relative ones beside the file as they are, local absolute ones through the preview origin. */
export function markdownMediaSource(src: string): string {
  const value = src.trim();
  if (/^file:/i.test(value)) { try { return previewURL(fileURLToPath(value)); } catch { return value; } }
  if (isAbsolute(value)) return previewURL(value);
  return value;
}

let renderer: MarkdownIt | null = null;
function markdown(): MarkdownIt {
  if (renderer) return renderer;
  const md = createMarkdown();
  mathPlugin(md);
  // Pictures: as the chat draws them, not clickable (the page has no scripts), loaded from beside the file.
  md.renderer.rules.image = (tokens, index) => mediaHTML(markdownMediaSource(tokens[index]!.attrGet("src") ?? ""), tokens[index]!.content, false);
  return (renderer = md);
}

/** The Markdown's HTML body, as the chat renders a reply. */
export function renderMarkdownBody(text: string): string {
  return markdown().render(text);
}

/** The page's own layout on top of the chat's stylesheet: a scrolling, readable column instead of the chat's fixed frame. */
const PAGE_CSS = `html, body { height: auto; min-height: 100%; }
body { display: block; overflow: auto; }
main.markdown { max-width: 860px; margin: 0 auto; padding: 28px 32px 48px; }
main.markdown .media { max-height: none; cursor: default; }`;

/** The whole page for `text`, titled by its first `# heading` (else the file name). `chatCSS` and `katexCSS` are inlined. */
export function markdownPage(text: string, file: string, styles: { chatCSS?: string; katexCSS?: string } = {}): string {
  const body = renderMarkdownBody(text);
  const title = markdownTitle(text) ?? basename(file, extname(file));
  const katex = body.includes('class="katex') ? styles.katexCSS ?? "" : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>${styles.chatCSS ?? ""}</style>
${katex ? `<style>${katex}</style>\n` : ""}<style>${PAGE_CSS}</style>
</head><body><main class="markdown">
${body}</main></body></html>`;
}

/** KaTeX's stylesheet with its woff2 fonts inlined as data: URLs (the page may load nothing else). */
export function inlineKatexFonts(css: string, fontsDir: string): string {
  return css.replace(/src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)[^;}]*/g, (whole, name: string) => {
    try { return `src:url(data:font/woff2;base64,${readFileSync(join(fontsDir, `${name}.woff2`)).toString("base64")}) format("woff2")`; } catch { return whole; }
  });
}

/** The page's stylesheets, read once: the chat's (out/renderer/chat.css) and ccb-latex's KaTeX one. */
export function markdownStyles(rendererDir: string, builtIns: string): () => { chatCSS: string; katexCSS: string } {
  let styles: { chatCSS: string; katexCSS: string } | null = null;
  return () => {
    if (styles) return styles;
    const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
    const dist = join(builtIns, "ccb-latex", "dist");
    styles = { chatCSS: read(join(rendererDir, "chat.css")), katexCSS: inlineKatexFonts(read(join(dist, "katex.min.css")), join(dist, "fonts")) };
    return styles;
  };
}

/** The response for a Markdown result the preview origin serves (`file` already checked by previewFile). */
export function markdownResponse(file: string, styles: { chatCSS?: string; katexCSS?: string }, method = "GET"): Response {
  const html = markdownPage(readFileSync(file, "utf8"), file, styles);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": MARKDOWN_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  return new Response(method === "HEAD" ? null : html, { headers });
}
