import MarkdownIt from "markdown-it";
import { escapeHTML } from "./util";

const videoExtensions = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Bot replies: markdown. Raw HTML from the bot is shown as text, never run. Links become chips;
 * `![caption](url)` becomes an image or a playing video. Plugins add to it (LaTeX is the
 * ccb-latex plugin); since markdown-it plugins cannot be taken out, unloading one rebuilds it.
 */
export function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false });

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
    return mediaHTML(token.attrGet("src") ?? "", token.content);
  };
  return md;
}

export let md: MarkdownIt = createMarkdown();

export function resetMarkdown(): MarkdownIt {
  md = createMarkdown();
  return md;
}

export function mediaHTML(src: string, label: string): string {
  const url = escapeHTML(src);
  const name = escapeHTML(label);
  if (videoExtensions.test(src.split("?")[0])) {
    return `<video class="media" src="${url}" controls preload="metadata" aria-label="${name || "Video"}"></video>`;
  }
  return `<img class="media" src="${url}" alt="${name}" data-url="${url}" data-label="${name}" loading="lazy">`;
}

export function renderMarkdown(text: string): string {
  return md.render(text);
}
