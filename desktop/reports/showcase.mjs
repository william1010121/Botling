// One self-contained showcase page: intro, every block, the four examples (desktop inline + phone
// preview) and a few slides from each. Usage: node desktop/reports/showcase.mjs /abs/out.html
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadReports, root } from './load.mjs';

const out = process.argv[2];
if (!out) throw Error('Usage: node desktop/reports/showcase.mjs /abs/out.html');
const api = await loadReports();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Prefix ids so several reports can share one page. */
const scope = (html, p) => html.replace(/\b(id|aria-labelledby)="([^"]+)"/g, (_, a, v) => `${a}="${v.split(' ').map(x => `${p}-${x}`).join(' ')}"`).replace(/url\(#([^)]+)\)/g, `url(#${p}-$1)`);
const bodyOf = html => html.slice(html.indexOf('</style>') + 8).replace(/<script>[\s\S]*<\/script>$/, '');

let gallery = '';
for (const [i, b] of api.blocks.entries()) {
  for (const [k, ex] of b.examples.entries()) {
    const r = await api.renderBlock(ex);
    gallery += `<article class="gi${b.fit === 'full' || b.type === 'flow' || b.type === 'timeline' || b.type === 'options' || b.type === 'sequence' || b.type === 'roadmap' ? ' wide' : ''}"><p class="gt-t"><code>${b.type}</code>${k ? ` <span>${k + 1}</span>` : ''}</p><p class="gd">${esc(b.description)}</p>${scope(r.html, `g${i}x${k}`)}</article>`;
  }
}

const files = (await readdir(join(root, 'reports/v2/examples'))).filter(f => f.endsWith('.json')).sort((a, b) => ['status', 'decision', 'investigation', 'results'].findIndex(k => a.startsWith(k)) - ['status', 'decision', 'investigation', 'results'].findIndex(k => b.startsWith(k)));
let examples = '', nav = '';
for (const [i, f] of files.entries()) {
  const spec = JSON.parse(await readFile(join(root, 'reports/v2/examples', f), 'utf8'));
  const doc = await api.renderV2(spec, { mode: 'doc' });
  const deck = await api.renderV2(spec, { mode: 'slide' });
  const slides = [...bodyOf(deck.html).matchAll(/<section class="sv"[\s\S]*?<\/footer><\/div><\/section>/g)].map(m => m[0]);
  const pick = [0, 2, 3].filter(n => n < slides.length).map(n => scope(slides[n], `x${i}s${n}`));
  const kind = api.blocks && spec.kind;
  nav += `<a href="#ex-${kind}">${esc(spec.title)}</a>`;
  examples += `<section class="ex" id="ex-${kind}">
    <header class="exh"><p class="kick">${['進度報告', '決策', '問題調查', '成果'][i]} · <code>${kind}</code> · ${spec.sections.reduce((n, s) => n + s.blocks.length, 0)} 個區塊 · ${deck.slides} 張投影片</p><h2>${esc(spec.title)}</h2></header>
    <p class="lbl">文件 · 桌面寬度</p>
    <div class="desk">${scope(bodyOf(doc.html), `x${i}`)}</div>
    <div class="pair">
      <figure class="phone-wrap"><p class="lbl">手機 · 390px</p><div class="phone"><iframe title="${esc(spec.title)}（手機）" srcdoc="${esc(doc.html)}" loading="lazy"></iframe></div></figure>
      <figure class="slides"><p class="lbl">同一份資料的投影片（${pick.length} / ${deck.slides}）</p><div class="deck">${pick.join('')}</div></figure>
    </div>
  </section>`;
}

const css = api.v2css;
const slideCss = css.slides.replace(/^html\{[^}]*\}\s*body\{[^}]*\}\s*/m, '').replace(/\.deck\{[^}]*\}/, '');
const page = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Botling 報告系統</title>
<style>${css.tokens}${css.base}${css.blocks}${slideCss}
html,body{background:var(--ground);color:var(--text)}
body{overflow-x:hidden}
.page{max-width:1240px;margin:0 auto;padding:40px 16px 80px}
.intro{max-width:760px;margin:0 0 28px}
.intro .kick,.kick{margin:0;font-size:12.5px;color:var(--faint)}
.intro h1{font-size:28px;font-weight:650;letter-spacing:-.02em;margin:6px 0 12px}
.intro ul{margin:0;padding-left:20px;color:var(--muted);font-size:15px;line-height:1.75}
.intro b{color:var(--text);font-weight:600}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 40px}
.toc a{color:var(--text);text-decoration:none;font-size:13.5px;background:var(--chip);border-radius:999px;padding:5px 12px}
.toc a:hover{background:var(--selected)}
h2.part{font-size:13px;font-weight:650;color:var(--faint);letter-spacing:.05em;margin:48px 0 14px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.gi{min-width:0;display:flex;flex-direction:column;gap:6px}
.gi.wide{grid-column:1/-1}
.gt-t{margin:0;font-size:13px;color:var(--muted)}.gt-t code{font-size:12.5px}.gt-t span{color:var(--faint)}
.gd{margin:0 0 4px;font-size:12.5px;color:var(--faint);line-height:1.5}
.gi>.blk{flex:1}
.ex{margin:56px 0 0;padding-top:28px;border-top:1px solid var(--line)}
.exh h2{font-size:24px;font-weight:650;margin:4px 0 16px;letter-spacing:-.01em}
.lbl{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--faint);letter-spacing:.03em}
.desk{border:1px solid var(--border);border-radius:16px;overflow:hidden;background:var(--ground);margin-bottom:24px}
.desk .rp{padding-top:32px}
.pair{display:grid;grid-template-columns:392px minmax(0,1fr);gap:24px;align-items:start}
.pair figure{margin:0;min-width:0}
.phone{width:392px;max-width:100%;height:780px;border:1px solid var(--border);border-radius:32px;overflow:hidden;background:var(--ground)}
.phone iframe{display:block;width:100%;height:100%;border:0}
.slides .deck{display:flex;flex-direction:column;gap:16px}
.slides .sv{width:100%}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}.pair{grid-template-columns:minmax(0,1fr)}.phone{width:100%;height:720px}}
</style>
<body><div class="page">
<header class="intro"><p class="kick">Botling · 報告系統 v2 · 2026-10-28</p><h1>Botling 報告系統</h1><ul>
<li><b>Bot 挑積木，不填模板：</b>一份報告是「段落 → 區塊」，22 種區塊（KPI、圖表、流程圖、矩陣、時間軸…）依內容挑選，版面由規劃器自動排。</li>
<li><b>只寫重點：</b>每段一句結論當標題，圖表要有結論標題，依據最多 4 行；超出預算時檢查器會退回給 bot 改寫。</li>
<li><b>同一份資料兩種輸出：</b>文件版不帶 JavaScript、跟著 App 的深淺色；投影片版 16:9，結論當標題，放不下自動接續下一張。</li>
</ul></header>
<nav class="toc" aria-label="目錄"><a href="#blocks">全部區塊</a>${nav}</nav>
<h2 class="part" id="blocks">區塊總覽 · ${api.blocks.length} 種</h2>
<div class="grid">${gallery}</div>
<h2 class="part">四份範例報告</h2>
${examples}
</div></body></html>`;
await writeFile(out, page);
console.log(JSON.stringify({ ok: true, out, bytes: page.length }));
