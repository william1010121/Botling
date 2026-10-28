import { renderToStaticMarkup } from 'react-dom/server';
import { registry } from './blocks';
import { labels } from './core/i18n';
import type { Mode } from './core/registry';
import { lintSpec } from './lint';
import { planSlides, type SlidePlan } from './planner';
import { validateSpec, type BrokenBlock, type Issue, type ReportSpec } from './spec';
import { BlockView, DocReport, SlideDeck, type Prepared } from './Report';
import tokens from './theme/tokens.css';
import base from './theme/doc.css';
import blockCss from './theme/blocks.css';
import slideCss from './theme/slides.css';

export type RenderResult = { ok: boolean; errors: Issue[]; warnings: Issue[]; html?: string; slides?: number; spec?: ReportSpec };

/** Keyboard paging for slide mode only (doc output never contains a script). */
export const PAGER = `(()=>{const s=[...document.querySelectorAll('.sv')];
const cur=()=>{let b=0,d=1/0;s.forEach((x,j)=>{const r=x.getBoundingClientRect(),v=Math.abs(r.top+r.height/2-innerHeight/2);if(v<d){d=v;b=j}});return b};
const go=n=>{const t=s[Math.max(0,Math.min(s.length-1,n))];t&&t.scrollIntoView({block:'center'})};
addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey)return;const k=e.key;
if(['ArrowRight','ArrowDown','PageDown',' '].includes(k)){e.preventDefault();go(cur()+1)}
else if(['ArrowLeft','ArrowUp','PageUp'].includes(k)){e.preventDefault();go(cur()-1)}
else if(k==='Home'){e.preventDefault();go(0)}else if(k==='End'){e.preventDefault();go(s.length-1)}});})();`;

export const css = { tokens, base, blocks: blockCss, slides: slideCss };

/** Compute async layouts (elkjs) once; a failing layout turns that block into an ErrorBlock. */
async function prepare(spec: ReportSpec, mode: Mode): Promise<{ prepared: Prepared; errors: Issue[] }> {
  const prepared: Prepared = new WeakMap();
  const errors: Issue[] = [];
  for (const [si, sec] of spec.sections.entries()) {
    for (const [bi, b] of sec.blocks.entries()) {
      const def = registry.get(b.type);
      if (!def?.prepare) continue;
      try { prepared.set(b, await def.prepare(b, mode)); } catch (e) {
        const path = `sections[${si}].blocks[${bi}]`, message = `layout failed: ${(e as Error).message}`;
        errors.push({ path, message });
        sec.blocks[bi] = { type: '__error', original: b.type, path, message } satisfies BrokenBlock;
      }
    }
  }
  return { prepared, errors };
}

function page(title: string, lang: string, style: string, body: string, script?: string): string {
  const head = renderToStaticMarkup(<><title>{title}</title><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="color-scheme" content="light dark"/></>);
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8">${head}<style>${style}</style>${body}${script ? `<script>${script}</script>` : ''}`;
}

export async function renderV2(input: unknown, opts: { mode?: Mode } = {}): Promise<RenderResult> {
  const mode = opts.mode ?? 'doc';
  const { spec, errors } = validateSpec(input);
  if (!spec) return { ok: false, errors, warnings: [] };
  const { prepared, errors: layoutErrors } = await prepare(spec, mode);
  errors.push(...layoutErrors);
  const slides: SlidePlan[] = planSlides(spec, registry, labels[spec.lang].continued);
  const warnings = lintSpec(spec, registry, slides);
  const html = mode === 'doc'
    ? page(spec.title, spec.lang, tokens + base + blockCss, renderToStaticMarkup(<DocReport spec={spec} prepared={prepared}/>))
    : page(spec.title, spec.lang, tokens + base + blockCss + slideCss, renderToStaticMarkup(<SlideDeck spec={spec} slides={slides} prepared={prepared}/>), PAGER);
  return { ok: errors.length === 0, errors, warnings, html, slides: slides.length, spec };
}

/** Render one block on its own (gallery, tests). */
export async function renderBlock(block: unknown, opts: { mode?: Mode; lang?: 'zh-Hant' | 'en' } = {}): Promise<{ html: string; errors: Issue[] }> {
  const spec = { version: 2, lang: opts.lang ?? 'zh-Hant', title: 'x', asOf: 'x', tldr: 'x', sections: [{ title: 'x', blocks: [block] }] };
  const { spec: s, errors } = validateSpec(spec);
  if (!s) return { html: '', errors };
  const { prepared } = await prepare(s, opts.mode ?? 'doc');
  const html = renderToStaticMarkup(<BlockView block={s.sections[0].blocks[0]} ctx={{ lang: s.lang, t: labels[s.lang], mode: opts.mode ?? 'doc', id: 'g' + Math.abs(hash(JSON.stringify(block))).toString(36) }} prepared={prepared}/>);
  return { html, errors };
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
