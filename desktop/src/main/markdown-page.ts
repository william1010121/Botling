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

/**
 * The page's own look on top of the chat's stylesheet (its colours, tokens.css's dark and light sets, its markdown
 * rules): a document, not a reply. The text fills the window with even side margins (no narrow middle column); type is
 * set for Traditional Chinese mixed with English (PingFang TC with the system font, 16px, line-height 1.75, a space
 * between CJK and Latin), headings get a scale, tables a frame, code blocks scroll sideways instead of wrapping.
 */
export const PAGE_CSS = `html, body { height: auto; min-height: 100%; }
body { display: block; overflow: auto; }
.page.markdown {
  --page-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", sans-serif;
  --page-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang TC", monospace;
  padding: clamp(24px, 4vw, 56px) clamp(20px, 5vw, 72px) 64px;
  font: 16px/1.75 var(--page-sans); letter-spacing: 0.01em;
  text-autospace: normal; text-spacing-trim: trim-start; overflow-wrap: break-word;
}
.page.markdown p { margin: 0 0 1em; }
.page.markdown strong { font-weight: 650; }
.page.markdown h1, .page.markdown h2, .page.markdown h3, .page.markdown h4, .page.markdown h5, .page.markdown h6 {
  margin: 1.9em 0 0.6em; line-height: 1.35; font-weight: 650; letter-spacing: 0; color: var(--text);
}
.page.markdown h1 { font-size: 30px; font-weight: 700; margin-top: 0.4em; padding-bottom: 0.35em; border-bottom: 1px solid var(--line); }
.page.markdown h2 { font-size: 23px; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
.page.markdown h3 { font-size: 19px; }
.page.markdown h4 { font-size: 16.5px; }
.page.markdown h5, .page.markdown h6 { font-size: 15px; color: var(--muted); }
.page.markdown > :first-child { margin-top: 0; }
.page.markdown ul, .page.markdown ol { margin: 0 0 1em; padding-left: 1.6em; }
.page.markdown li { margin: 0.3em 0; }
.page.markdown li > ul, .page.markdown li > ol { margin: 0.2em 0 0; }
.page.markdown li > p { margin: 0 0 0.4em; }
.page.markdown a.chip { color: var(--link); background: none; padding: 0; border-radius: 0; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--link) 40%, transparent); text-underline-offset: 3px; }
.page.markdown code { font: 0.875em/1.5 var(--page-mono); letter-spacing: 0; font-variant-ligatures: none; background: var(--chip); padding: 0.15em 0.4em; border-radius: 5px; }
.page.markdown pre {
  margin: 0 0 1.2em; padding: 14px 18px; background: var(--code); border: 1px solid var(--line); border-radius: 10px;
  white-space: pre; overflow-x: auto; font-size: 14px; line-height: 1.6;
}
.page.markdown pre code { font-size: inherit; line-height: inherit; padding: 0; background: none; border-radius: 0; }
.page.markdown blockquote {
  margin: 0 0 1.2em; padding: 0.6em 1.1em; border-left: 3px solid var(--accent-line); border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--info-bg) 60%, transparent); color: var(--soft-text);
}
.page.markdown blockquote > :last-child { margin-bottom: 0; }
.page.markdown .table-scroll { margin: 0 0 1.2em; border: 1px solid var(--line); border-radius: 10px; }
.page.markdown table { width: 100%; font-size: 14.5px; line-height: 1.6; }
.page.markdown th, .page.markdown td { padding: 9px 14px; border-bottom: 1px solid var(--line); }
.page.markdown th { font-weight: 600; background: var(--notice); white-space: nowrap; }
.page.markdown tr:last-child td { border-bottom: none; }
.page.markdown tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--notice) 55%, transparent); }
.page.markdown hr { height: 1px; margin: 2em 0; }
.page.markdown .media { max-width: 100%; max-height: none; cursor: default; border-radius: 10px; margin: 0.4em 0; }
.page.markdown .katex { font-size: 1.08em; }
.page.markdown .katex-display { margin: 1em 0 1.2em; overflow-x: auto; overflow-y: hidden; padding: 4px 0; }`;

/** The whole page for `text`, titled by its first `# heading` (else the file name), in `theme` (Settings → Appearance → Report pages, as a result page). `chatCSS` and `katexCSS` are inlined. */
export function markdownPage(text: string, file: string, styles: { chatCSS?: string; katexCSS?: string } = {}, theme: "dark" | "light" = "dark"): string {
  const body = renderMarkdownBody(text);
  const title = markdownTitle(text) ?? basename(file, extname(file));
  const katex = body.includes('class="katex') ? styles.katexCSS ?? "" : "";
  return `<!doctype html>
<html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>${styles.chatCSS ?? ""}</style>
${katex ? `<style>${katex}</style>\n` : ""}<style>${PAGE_CSS}</style>
</head><body><main class="markdown page">
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
export function markdownResponse(file: string, styles: { chatCSS?: string; katexCSS?: string }, method = "GET", theme: "dark" | "light" = "dark"): Response {
  const html = markdownPage(readFileSync(file, "utf8"), file, styles, theme);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": MARKDOWN_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  return new Response(method === "HEAD" ? null : html, { headers });
}
