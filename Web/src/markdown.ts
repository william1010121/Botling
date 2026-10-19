import MarkdownIt from "markdown-it";
import { escapeHTML, mathPlugin } from "./math";

const videoExtensions = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Bot replies: markdown with LaTeX. Raw HTML from the bot is shown as text, never run.
 * Links become chips; `![說明](網址)` becomes an image or a playing video.
 */
export const md: MarkdownIt = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false });
md.use(mathPlugin);

// Results and pictures are local files, so file: is allowed; script and data URLs are not
// (except data: images).
md.validateLink = (url) => {
  const value = url.trim().toLowerCase();
  if (/^(javascript|vbscript):/.test(value)) return false;
  if (value.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp);/.test(value);
  return true;
};

md.renderer.rules.link_open = (tokens, index) => {
  const href = tokens[index].attrGet("href") ?? "";
  return `<a class="chip" href="#" data-url="${escapeHTML(href)}">`;
};

md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet("src") ?? "";
  const alt = token.content;
  return mediaHTML(src, alt);
};

export function mediaHTML(src: string, label: string): string {
  const url = escapeHTML(src);
  const name = escapeHTML(label);
  if (videoExtensions.test(src.split("?")[0])) {
    return `<video class="media" src="${url}" controls preload="metadata" aria-label="${name || "影片"}"></video>`;
  }
  return `<img class="media" src="${url}" alt="${name}" data-url="${url}" data-label="${name}" loading="lazy">`;
}

export function renderMarkdown(text: string): string {
  return md.render(text);
}
