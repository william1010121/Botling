// Browser-safe PDF quote markup parser and writer for Notes (§9A.8, D74 Q-C8).
// Kept independent of note-format.ts so web-v3 bundles never pull in node:crypto.
import { EntryRef } from "../protocol/content-url";
import { ContentId, ServerId } from "../protocol/ids";

const PDF_QUOTE_NAME_MAX = 200;
const PDF_QUOTE_TEXT_MAX = 4_000;
const PDF_QUOTE_HEAD = /^> 〔PDF · ([^\r\n〕]*) · p\. ([1-9]\d*)〕$/;
const PDF_SOURCE_COMMENT = /^<!-- source: content=([^/\s]+)\/([^\s]+) entry=([^#\s]+)#([1-9][0-9]{0,15}) page=([1-9][0-9]{0,15}) -->$/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

export interface PdfQuote {
  name: string;
  page: number;
  text: string;
  source: { owner: string; id: string; entry: { stream: string; seq: number } } | null;
}

function sanitizePdfName(name: string): string {
  const trimmed = name.replace(/[/\\]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const lastPart = sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
  return lastPart.replace(/\r\n|[\r\n〕]/g, "_").slice(0, PDF_QUOTE_NAME_MAX);
}

function capPdfText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length <= PDF_QUOTE_TEXT_MAX) return normalized;
  let cut = PDF_QUOTE_TEXT_MAX - 1;
  const code = normalized.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${normalized.slice(0, cut)}…`;
}

/** Formats a quoted PDF passage for a Note; omits the source comment when `quote.source` is null. */
export function pdfQuoteMarkup(quote: PdfQuote): string {
  const name = sanitizePdfName(quote.name);
  const page = Number.isFinite(quote.page) ? Math.max(1, Math.floor(quote.page)) : 1;
  const lines = [
    `> 〔PDF · ${name} · p. ${page}〕`,
    ...capPdfText(quote.text).split("\n").map((line) => (line === "" ? ">" : `> ${line}`)),
  ];
  if (quote.source) {
    lines.push(`<!-- source: content=${quote.source.owner}/${quote.source.id} entry=${quote.source.entry.stream}#${quote.source.entry.seq} page=${page} -->`);
  }
  return lines.join("\n");
}

function parsePdfSourceComment(line: string, expectedPage: number): PdfQuote["source"] {
  const match = PDF_SOURCE_COMMENT.exec(line);
  if (!match) return null;
  const [, owner, id, stream, seqStr, pageStr] = match;
  const commentPage = Number(pageStr);
  if (!Number.isSafeInteger(commentPage) || commentPage !== expectedPage) return null;
  if (!ServerId.safeParse(owner).success || !ContentId.safeParse(id).success) return null;
  const entry = EntryRef.safeParse({ stream, seq: Number(seqStr) });
  if (!entry.success) return null;
  return { owner: owner!, id: id!, entry: entry.data };
}

function matchFenceOpen(line: string): { ch: string; len: number } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  const info = match[2] ?? "";
  if (marker[0] === "`" && info.includes("`")) return null;
  return { ch: marker[0]!, len: marker.length };
}

/** Reads every PDF quote block in a Note, each with the 0-based line of its first `>` line. */
export function pdfQuotes(text: string): Array<PdfQuote & { line: number }> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Array<PdfQuote & { line: number }> = [];
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.ch}{${fence.len},}\\s*$`);
      if (close.test(line)) fence = null;
      i++;
      continue;
    }
    const opened = matchFenceOpen(line);
    if (opened) {
      fence = opened;
      i++;
      continue;
    }
    const head = PDF_QUOTE_HEAD.exec(line);
    if (!head) {
      i++;
      continue;
    }
    const page = Number(head[2]);
    if (!Number.isSafeInteger(page) || page < 1) {
      i++;
      continue;
    }
    const name = head[1]!;
    const textLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const cur = lines[j]!;
      if (PDF_QUOTE_HEAD.test(cur)) break;
      if (cur === ">") textLines.push("");
      else if (cur.startsWith("> ")) textLines.push(cur.slice(2));
      else if (cur.startsWith(">")) textLines.push(cur.slice(1));
      else break;
      j++;
    }
    const source = j < lines.length ? parsePdfSourceComment(lines[j]!, page) : null;
    out.push({ line: i, name, page, text: textLines.join("\n"), source });
    i = source ? j + 1 : j;
  }
  return out;
}
