import { t } from "./i18n";
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

  // A table too wide for one line per row gets column widths from its text, so a short column
  // (a version, a name) is not squeezed to a letter while a long one takes the whole bubble.
  md.renderer.rules.table_open = (tokens, index, options, _env, self) => {
    const rows: string[][] = [];
    for (let i = index + 1; i < tokens.length && tokens[i].type !== "table_close"; i++) {
      if (tokens[i].type === "tr_open") rows.push([]);
      else if (tokens[i].type === "inline") rows[rows.length - 1]?.push(tokens[i].content);
    }
    const widths = tableColumnWidths(rows);
    if (!widths) return self.renderToken(tokens, index, options);
    const cols = widths.map((width) => `<col style="width: ${width}%">`).join("");
    return `<table class="fitted"><colgroup>${cols}</colgroup>\n`;
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
    return `<video class="media" src="${url}" controls preload="metadata" aria-label="${name || escapeHTML(t("markdown.video"))}"></video>`;
  }
  return `<img class="media" src="${url}" alt="${name}" data-url="${url}" data-label="${name}" loading="lazy">`;
}

/** About how many Latin letters fit across a bot bubble at the table's 14px. */
const tableLineUnits = 64;
/** A short column keeps its natural width up to this share of the table. */
const shortColumnShare = 0.4;

/**
 * Column widths in percent for a markdown table (header row first), or null when every row fits
 * on one line and the browser's own sizing is fine. Short columns, smallest first, keep their
 * natural width (at most 40%, and no more than an even split of what is left); the long columns
 * share the rest by length.
 */
export function tableColumnWidths(rows: string[][]): number[] | null {
  const count = Math.max(0, ...rows.map((row) => row.length));
  if (count < 2) return null;
  // The cell's right padding is about two letters.
  const natural = Array.from({ length: count }, (_, column) =>
    Math.max(...rows.map((row) => textUnits(row[column] ?? ""))) + 2);
  if (natural.reduce((sum, units) => sum + units, 0) <= tableLineUnits) return null;
  const shares: number[] = new Array(count).fill(0);
  const open = natural.map((_, column) => column).sort((a, b) => natural[a] - natural[b]);
  let left = 1;
  while (open.length > 1) {
    const share = natural[open[0]] / tableLineUnits;
    if (share > left / open.length) break;
    shares[open[0]] = Math.min(share, shortColumnShare);
    left -= shares[open.shift()!];
  }
  const openUnits = open.reduce((sum, column) => sum + natural[column], 0);
  for (const column of open) shares[column] = (left * natural[column]) / openUnits;
  return shares.map((share) => Math.round(share * 1000) / 10);
}

/** Width of a cell's text in Latin letters: CJK and full-width characters count as two. */
function textUnits(text: string): number {
  let units = 0;
  for (const character of text.replace(/[*_`~]/g, "")) {
    units += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character) ? 2 : 1;
  }
  return units;
}

export function renderMarkdown(text: string): string {
  return md.render(text);
}
