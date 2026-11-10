import { renderToStaticMarkup } from 'react-dom/server';
import { registry } from './blocks';
import { labels } from './core/i18n';
import type { Mode } from './core/registry';
import { lintSpec } from './lint';
import { planSlides, type SlidePlan } from './planner';
import { validateSpec, type BrokenBlock, type Issue, type ReportSpec } from './spec';
import { BlockView, DocReport, SlideDeck, type Prepared } from './Report';
import { mathCss, typesetHtml } from './core/math';
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

/**
 * Click / Enter on a [data-zoom] figure shows it in a full-viewport overlay (lightbox); Esc, ✕ or a click outside it closes.
 * Inline, no network. 2026-11-10: it zooms smoothly around the pointer (the wheel, a trackpad pinch = ctrl + wheel, + / - / 0;
 * a click on the picture toggles fit / 2×) and pans by dragging, as the chat's lightbox (Web/src/lightbox.ts) does: the fitted
 * copy is placed with one transform (translate, then scale from its top-left), zoom out stops at the fitted size, a copy
 * smaller than the window is centred, a larger one pans only until its edge meets the window's. (It used to have no zoom.)
 */
export const LIGHTBOX = `(()=>{let o=null,from=null,c=null,r0=null,x=0,y=0,s=1,max=8,drag=null,dragged=false,label=null;
const close=()=>{if(!o)return;removeEventListener('resize',onResize);o.remove();o=c=null;from&&from.focus&&from.focus({preventScroll:true});from=null};
const place=(nx,ny,ns)=>{s=Math.min(Math.max(ns,1),max);const w=r0.width*s,h=r0.height*s,vw=o.clientWidth,vh=o.clientHeight;
x=w<=vw?(vw-w)/2-r0.left:Math.min(-r0.left,Math.max(vw-w-r0.left,nx));y=h<=vh?(vh-h)/2-r0.top:Math.min(-r0.top,Math.max(vh-h-r0.top,ny));
c.style.transform='translate('+x+'px, '+y+'px) scale('+s+')';label.textContent=Math.round(s*100)+'%';o.classList.toggle('zoomed',s>1)};
const zoomAt=(ns,cx,cy)=>{const px=(cx-r0.left-x)/s,py=(cy-r0.top-y)/s,n=Math.min(Math.max(ns,1),max);place(cx-r0.left-px*n,cy-r0.top-py*n,n)};
const measure=()=>{c.style.transform='';r0=c.getBoundingClientRect();const p=c.tagName==='IMG'?c:[...c.querySelectorAll('img')].find(i=>getComputedStyle(i).display!=='none');
const nw=p&&p.naturalWidth;max=Math.max(8,nw&&r0.width?4*nw/r0.width:0)};
const fit=()=>{if(!c)return;measure();place(0,0,1)};
const onResize=()=>{if(!c)return;const k=s,kx=x,ky=y;measure();place(kx,ky,k)};
const open=el=>{close();from=el;o=document.createElement('div');o.className='lb';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.tabIndex=-1;
c=el.cloneNode(true);['data-zoom','tabindex','role','style','width','height','id'].forEach(a=>c.removeAttribute(a));c.classList.add('lb-fig');c.setAttribute('role','img');c.setAttribute('draggable','false');
if(c.tagName==='IMG'&&!c.alt)c.alt='';const bar=document.createElement('div');bar.className='lb-bar';label=document.createElement('output');label.setAttribute('aria-live','polite');
const x_=document.createElement('button');x_.type='button';x_.className='lb-x';x_.textContent='✕';x_.setAttribute('aria-label','Close');bar.append(label,x_);
o.append(c,bar);document.body.appendChild(o);s=1;x=y=0;fit();addEventListener('resize',onResize);
if(c.tagName==='IMG'&&!c.complete)c.addEventListener('load',()=>fit(),{once:true});
o.addEventListener('click',e=>{e.stopPropagation();if(dragged){dragged=false;return}if(e.target.closest('.lb-x'))return close();if(e.target.closest('.lb-bar'))return;
if(c&&c.contains(e.target)){if(s>1)place(0,0,1);else zoomAt(2,e.clientX,e.clientY);return}close()});
o.addEventListener('wheel',e=>{e.preventDefault();const line=e.deltaMode===1?16:e.deltaMode===2?o.clientHeight:1,dx=e.deltaX*line,dy=e.deltaY*line;
if(!e.ctrlKey&&!e.metaKey&&Math.abs(dx)>Math.abs(dy))return place(x-dx,y-dy,s);zoomAt(s*Math.exp(-dy*(e.ctrlKey?0.01:0.002)),e.clientX,e.clientY)},{passive:false});
o.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.lb-bar'))return;drag={id:e.pointerId,sx:e.clientX,sy:e.clientY,fx:x,fy:y,moved:false};dragged=false});
o.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;if(!drag.moved&&Math.hypot(dx,dy)<4)return;
if(!drag.moved){drag.moved=true;o.classList.add('dragging');try{o.setPointerCapture(drag.id)}catch(_){}}e.preventDefault();place(drag.fx+dx,drag.fy+dy,s)});
const up=e=>{if(!drag||e.pointerId!==drag.id)return;dragged=drag.moved;try{o.releasePointerCapture(drag.id)}catch(_){}drag=null;o.classList.remove('dragging')};
o.addEventListener('pointerup',up);o.addEventListener('pointercancel',up);o.focus({preventScroll:true})};
document.addEventListener('click',e=>{const t=e.target.closest&&e.target.closest('[data-zoom]');if(t&&!o){e.preventDefault();open(t)}});
addEventListener('keydown',e=>{if(o){e.stopPropagation();const k=e.key;if(k==='Escape'||((k==='Enter'||k===' ')&&!(e.target.closest&&e.target.closest('.lb-x')))){e.preventDefault();close()}
else if(!e.altKey&&!e.ctrlKey&&(k==='0'||k==='='||k==='+'||k==='-')){e.preventDefault();if(k==='0')place(0,0,1);else zoomAt(s*(k==='-'?1/1.25:1.25),o.clientWidth/2,o.clientHeight/2)}return}
const t=document.activeElement;if((e.key==='Enter'||e.key===' ')&&t&&t.matches&&t.matches('[data-zoom]')){e.preventDefault();e.stopPropagation();open(t)}},true);})();`;

export const css = { tokens, base, blocks: blockCss, slides: slideCss };

/** Compute layouts (elkjs) once; a failing layout turns that block into an ErrorBlock. */
function prepare(spec: ReportSpec, mode: Mode, baseDir = process.cwd()): { prepared: Prepared; errors: Issue[] } {
  const prepared: Prepared = new WeakMap();
  const errors: Issue[] = [];
  for (const [si, sec] of spec.sections.entries()) {
    for (const [bi, b] of sec.blocks.entries()) {
      const def = registry.get(b.type);
      if (!def?.prepare) continue;
      try { prepared.set(b, def.prepare(b, mode, { baseDir, id: `s${si}b${bi}` })); } catch (e) {
        const path = `sections[${si}].blocks[${bi}]`, message = `${b.type === 'figure' || b.type === 'experiment' ? 'figure' : 'layout'} failed: ${(e as Error).message}`;
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

export function renderV2(input: unknown, opts: { mode?: Mode; baseDir?: string } = {}): RenderResult {
  const mode = opts.mode ?? 'doc';
  const { spec, errors } = validateSpec(input);
  if (!spec) return { ok: false, errors, warnings: [] };
  const { prepared, errors: layoutErrors } = prepare(spec, mode, opts.baseDir);
  errors.push(...layoutErrors);
  const slides: SlidePlan[] = planSlides(spec, registry, labels[spec.lang].continued);
  const warnings = lintSpec(spec, registry, slides, opts.baseDir);
  const body = typesetHtml(renderToStaticMarkup(mode === 'doc' ? <DocReport spec={spec} prepared={prepared}/> : <SlideDeck spec={spec} slides={slides} prepared={prepared}/>));
  const math = mathCss(body);
  const zoom = body.includes('data-zoom') ? LIGHTBOX : '';
  const html = mode === 'doc'
    ? page(spec.title, spec.lang, tokens + base + blockCss + math, body, zoom)
    : page(spec.title, spec.lang, tokens + base + blockCss + slideCss + math, body, PAGER + zoom);
  return { ok: errors.length === 0, errors, warnings, html, slides: slides.length, spec };
}

/** Render one block on its own (gallery, tests). */
export function renderBlock(block: unknown, opts: { mode?: Mode; lang?: 'zh-Hant' | 'en'; baseDir?: string } = {}): { html: string; errors: Issue[] } {
  const spec = { version: 2, lang: opts.lang ?? 'zh-Hant', title: 'x', asOf: 'x', tldr: 'x', sections: [{ title: 'x', blocks: [block] }] };
  const { spec: s, errors } = validateSpec(spec);
  if (!s) return { html: '', errors };
  const { prepared, errors: prepErrors } = prepare(s, opts.mode ?? 'doc', opts.baseDir);
  errors.push(...prepErrors);
  const html = typesetHtml(renderToStaticMarkup(<BlockView block={s.sections[0].blocks[0]} ctx={{ lang: s.lang, t: labels[s.lang], mode: opts.mode ?? 'doc', id: 'g' + Math.abs(hash(JSON.stringify(block))).toString(36) }} prepared={prepared}/>));
  return { html, errors };
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
