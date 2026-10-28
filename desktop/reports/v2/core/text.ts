import MarkdownIt from 'markdown-it';

/** Deterministic text width (no DOM): CJK = 1em, Latin ≈ .56em, digits .6em, narrow punctuation .3em. */
export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80 && c <= 0xffef) em += 1;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if (/[ il.,:;'|!()[\]·]/.test(ch)) em += 0.3;
    else if (/[A-Z@MW%&]/.test(ch)) em += 0.68;
    else em += 0.56;
  }
  return em * fontSize;
}

/** Greedy wrap into lines no wider than maxWidth; CJK can break anywhere, Latin at spaces. */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines = 3): string[] {
  const tokens = text.match(/[⺀-￯]|[^\s⺀-￯]+|\s+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const next = line + token;
    if (line && textWidth(next.trimEnd(), fontSize) > maxWidth) {
      lines.push(line.trim());
      line = token.trimStart();
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.$/u, '…');
    return kept;
  }
  return lines;
}

/** Length budget that treats one CJK char as one unit and one Latin word as ~1.5 units. */
export function textUnits(text: string): number {
  const cjk = (text.match(/[⺀-￯]/g) ?? []).length;
  const words = (text.replace(/[⺀-￯]/g, ' ').match(/[A-Za-z0-9][\w.%+-]*/g) ?? []).length;
  return cjk + words * 1.5;
}

const md = new MarkdownIt('zero', { html: false, linkify: false, breaks: false }).enable(['list', 'backticks', 'newline']);
/** Restricted markdown: paragraphs, bullet/numbered lists, **bold**, *italic*, `code`. Raw HTML is escaped.
 *  Emphasis is matched before markdown-it runs because CommonMark's flanking rules reject the very
 *  common CJK case `**很可能（80%）**是…` (closing ** after punctuation, followed by a letter). */
export function renderMarkdown(text: string): string {
  const marked = text
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '\u0001$1\u0002')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?!\*)/g, '$1\u0003$2\u0004');
  return md.render(marked).replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>').replace(/\u0003/g, '<em>').replace(/\u0004/g, '</em>');
}
export function markdownBullets(text: string): { count: number; depth: number } {
  let count = 0, depth = 0;
  for (const line of text.split('\n')) {
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (!m) continue;
    count++;
    depth = Math.max(depth, Math.floor(m[1].replace(/\t/g, '  ').length / 2) + 1);
  }
  return { count, depth };
}
export function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0].trim();
}

export function fmt(value: number, unit = ''): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 || Number.isInteger(value) ? 0 : abs >= 10 ? 1 : 2;
  const s = value.toLocaleString('en-US', { maximumFractionDigits: digits });
  return unit ? (unit === '%' ? `${s}%` : `${s} ${unit}`) : s;
}
export const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
/** Round for SVG output so markup is stable across platforms. */
export const r1 = (v: number) => Math.round(v * 10) / 10;
