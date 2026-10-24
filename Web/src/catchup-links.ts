import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MessageView } from "./types";

export interface SourceLink { url: string; labels: string[] }
// Independent of model bullets and their prompt limits, and of mutable renderer plugins.
const parser = new MarkdownIt({ html: false, linkify: false });
parser.validateLink = () => true; // Preserve even unsupported targets; rendering decides clickability.
export function clickableSourceURL(url: string): boolean {
  const value = url.trim().toLowerCase();
  if (/^(javascript|vbscript):/.test(value)) return false;
  if (value.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp);/.test(value);
  return true;
}

/** CommonMark links/images/reference links/autolinks, bare URLs, and attached/artifact files.
 * Exact target equality only; retain every distinct caption for repeated targets.
 */
export function sourceLinks(messages: MessageView[]): SourceLink[] {
  const links = new Map<string, SourceLink>();
  const add = (url: string, label = "") => {
    if (!url) return;
    const entry = links.get(url) ?? { url, labels: [] };
    if (label && label !== url && !entry.labels.includes(label)) entry.labels.push(label);
    links.set(url, entry);
  };
  const bare = (text: string, literal = false) => {
    for (const match of text.matchAll(/(?:https?:\/\/|file:\/\/|mailto:)[^\s<>"'`]+/gi)) {
      let url = literal ? match[0] : match[0].replace(/[.,;!。，；！]+$/, "");
      // Drop sentence/Markdown closing delimiters, while preserving balanced URL parentheses.
      for (const [open, close] of literal ? [] : [["(", ")"], ["[", "]"], ["{", "}"]]) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
      }
      add(url);
    }
  };
  const walk = (tokens: Token[]) => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "link_open") {
        let label = "";
        for (let j = i + 1; j < tokens.length && tokens[j].type !== "link_close"; j++) label += tokens[j].content;
        add(token.attrGet("href") ?? "", label);
        // Still visit image tokens inside linked images, but don't reinterpret URL labels.
        while (++i < tokens.length && tokens[i].type !== "link_close") {
          if (tokens[i].type === "image") add(tokens[i].attrGet("src") ?? "", tokens[i].content);
        }
      } else if (token.type === "image") add(token.attrGet("src") ?? "", token.content);
      else if (token.children) walk(token.children);
      else if (["text", "code_inline", "code_block", "fence"].includes(token.type)) bare(token.content, token.type !== "text");
    }
  };
  for (const message of messages) {
    walk(parser.parse(message.text, {}));
    if (message.answer) walk(parser.parse(message.answer, {}));
    for (const file of message.attachments ?? []) add(file.url, file.name);
    for (const artifact of message.artifacts ?? []) add(artifact.url, artifact.title);
  }
  return [...links.values()];
}
