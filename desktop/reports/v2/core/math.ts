// LaTeX in report text: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` display, typeset at build time with the
// KaTeX the app already ships (HTML + MathML, no script, no network). Applied once to the finished page body:
// text nodes only (never attributes, code, SVG, script or style), so every block gets math without knowing it.
// Single dollars follow Pandoc's rule so prices stay prices: the opening `$` needs a non-space after it, the
// closing `$` a non-space before it and no digit after it. `\$` is a literal dollar sign.
import katex from 'katex';
import katexCss from 'katex/dist/katex.min.css';
import { katexFonts } from './katex-fonts';

export type Segment = { kind: 'text' | 'dollar' | 'math'; raw: string; tex?: string; display?: boolean };

function closingDollar(src: string, open: number, limit: number): number {
  const first = src[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  let at = open + 1;
  for (;;) {
    at = src.indexOf('$', at);
    if (at === -1 || at >= limit) return -1;
    const before = src[at - 1], after = src[at + 1] ?? '';
    if (before !== '\\' && !/\s/.test(before) && !/[0-9]/.test(after) && at > open + 1) return at;
    at += 1;
  }
}

/** A formula never crosses a blank line (a paragraph break): where the paragraph that holds `from` ends. */
const nextBreak = (src: string, from: number) => { const m = /\n[ \t]*\n/g; m.lastIndex = from; return m.exec(src)?.index ?? src.length; };

/** Split text into plain text, `\$` and formulas. `skipCode` leaves backtick code spans alone (Markdown source). */
export function splitMath(src: string, skipCode = false): Segment[] {
  const out: Segment[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ kind: 'text', raw: text }); text = ''; } };
  const take = (kind: 'math', raw: string, tex: string, display: boolean) => { flush(); out.push({ kind, raw, tex, display }); };
  let i = 0, limit = nextBreak(src, 0);
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (i >= limit) limit = nextBreak(src, i);
    if (skipCode && c === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close !== -1) { text += src.slice(i, close + run); i = close + run; continue; }
      text += src.slice(i, i + run); i += run; continue;
    }
    if (c === '\\' && n === '$') { flush(); out.push({ kind: 'dollar', raw: '\\$' }); i += 2; continue; }
    if (c === '\\' && (n === '(' || n === '[')) {
      const display = n === '[', close = src.indexOf(display ? '\\]' : '\\)', i + 2);
      if (close !== -1 && close < limit && src.slice(i + 2, close).trim() !== '') { take('math', src.slice(i, close + 2), src.slice(i + 2, close), display); i = close + 2; continue; }
    }
    if (c === '$' && n === '$') {
      const close = src.indexOf('$$', i + 2);
      if (close !== -1 && close < limit && src.slice(i + 2, close).trim() !== '') { take('math', src.slice(i, close + 2), src.slice(i + 2, close), true); i = close + 2; continue; }
    } else if (c === '$') {
      const close = closingDollar(src, i, limit);
      if (close !== -1) { take('math', src.slice(i, close + 1), src.slice(i + 1, close), false); i = close + 1; continue; }
    }
    text += c; i++;
  }
  flush();
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" } as Record<string, string>)[e]);

/** One formula as HTML; TeX KaTeX rejects shows as its source in a muted style (`.math-error`). `raw` is the escaped source with its delimiters. */
function typeset(raw: string, tex: string, display: boolean): string {
  try {
    return katex.renderToString(unescapeHtml(tex), { displayMode: display, throwOnError: true, output: 'htmlAndMathml', strict: 'ignore', trust: false });
  } catch (e) {
    return `<span class="math-error" title="${escapeHtml(String((e as Error).message ?? e).replace(/^KaTeX parse error: /, ''))}">${raw}</span>`;
  }
}

/** Typeset the formulas in one chunk of escaped HTML text. */
function typesetText(text: string): string {
  if (!/[$\\]/.test(text)) return text;
  return splitMath(text).map(s => s.kind === 'text' ? s.raw : s.kind === 'dollar' ? '$' : typeset(s.raw, s.tex!, s.display!)).join('');
}

const SKIP = new Set(['svg', 'script', 'style', 'code', 'pre', 'textarea', 'title']);

/** Typeset the math in a page body (HTML from React's static markup). Text inside code, SVG, script, style and tags is untouched. */
export function typesetHtml(html: string): string {
  if (!/[$\\]/.test(html)) return html;
  const stack: string[] = [];
  return html.split(/(<[^>]*>)/).map(part => {
    if (part.startsWith('<')) {
      const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(part);
      if (m && SKIP.has(m[2].toLowerCase()) && !part.endsWith('/>')) {
        if (m[1]) { const at = stack.lastIndexOf(m[2].toLowerCase()); if (at >= 0) stack.length = at; } else stack.push(m[2].toLowerCase());
      }
      return part;
    }
    return stack.length ? part : typesetText(part);
  }).join('');
}

/** Markdown must not see formulas (`_`, `*`, `\(` would be eaten): swap each for a placeholder, then put the source back. */
export function shieldMath(text: string): { text: string; restore: (html: string) => string } {
  const kept: string[] = [];
  const shielded = splitMath(text, true).map(s => {
    if (s.kind === 'text') return s.raw;
    kept.push(s.raw);
    return `\u0005${kept.length - 1}\u0006`;
  }).join('');
  return { text: shielded, restore: html => kept.length ? html.replace(/\u0005(\d+)\u0006/g, (_, i) => escapeHtml(kept[+i])) : html };
}

/** Muted source for TeX that does not parse; display math sits on its own line and scrolls sideways instead of widening the page. */
const EXTRA = '.katex-display{overflow-x:auto;overflow-y:hidden;padding:.1em 0}.math-error{color:var(--muted);font-family:var(--mono);font-size:.92em;text-decoration:underline dotted;text-underline-offset:.2em}';

/** The KaTeX stylesheet for a page body that has math: its rules, and only the font files its classes can reach, as woff2 data URIs. */
export function mathCss(body: string): string {
  if (!body.includes('class="katex')) return '';
  const used = new Set<string>();
  for (const m of body.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  const faces = [...katexCss.matchAll(/@font-face\{([^}]*)\}/g)].map(m => {
    const d = m[1];
    return { family: /font-family:"?(\w+)/.exec(d)![1], style: /font-style:(\w+)/.exec(d)?.[1] ?? 'normal', weight: /font-weight:(\d+)/.exec(d)?.[1] ?? '400', file: /url\(fonts\/([\w-]+)\.woff2\)/.exec(d)![1] };
  });
  const rules = katexCss.replace(/@font-face\{[^}]*\}/g, '');
  const need = new Set<string>(['KaTeX_Main|normal|400']);
  for (const m of rules.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const family = /font-family:"?(KaTeX_\w+)/.exec(m[2])?.[1];
    if (!family) continue;
    const reached = m[1].split(',').some(sel => (sel.match(/\.[\w-]+/g) ?? []).every(c => used.has(c.slice(1))));
    if (reached) need.add(`${family}|${/font-style:(\w+)/.exec(m[2])?.[1] ?? 'normal'}|${/font-weight:(\d+)/.exec(m[2])?.[1] ?? '400'}`);
  }
  const fonts = faces.filter(f => need.has(`${f.family}|${f.style}|${f.weight}`) && katexFonts[f.file])
    .map(f => `@font-face{font-display:block;font-family:${f.family};font-style:${f.style};font-weight:${f.weight};src:url(data:font/woff2;base64,${katexFonts[f.file]}) format("woff2")}`);
  return fonts.join('') + rules + EXTRA;
}
