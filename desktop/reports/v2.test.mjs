// ReportSpec v2: registry/schema, planner, lint, every block example, examples, v1 compatibility, CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { loadReports, root } from './load.mjs';

let api, temp;
const exDir = join(root, 'reports/v2/examples');
const base = { version: 2, lang: 'zh-Hant', title: '測試', asOf: '2026-10-28', tldr: '結論先講。' };
const spec = (blocks, extra = {}) => ({ ...base, sections: [{ title: '段落', takeaway: '這段的結論', blocks }], ...extra });
const dom = html => new JSDOM(html).window.document;
/** Figure tests need matplotlib for the python the renderer uses (user site-packages included, as the renderer does). */
const hasMatplotlib = spawnSync(process.env.BOTLING_PYTHON || 'python3', ['-I', '-c', 'import site; site.addsitedir(site.getusersitepackages()); import matplotlib'], { encoding: 'utf8' }).status === 0;
before(async () => { api = await loadReports(); temp = await mkdtemp(join(tmpdir(), 'report-v2-test-')); await mkdir(join(temp, 'artifacts')); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

test('registry: every block is described, has examples that validate, and appears in schema + prompt doc', () => {
  assert.ok(api.blocks.length >= 20);
  const types = api.blocks.map(b => b.type);
  assert.equal(new Set(types).size, types.length);
  for (const b of api.blocks) {
    assert.ok(b.description.length > 10 && b.when.length > 10, b.type);
    assert.ok(b.examples.length >= 1, b.type);
    for (const ex of b.examples) assert.ok(b.schema.safeParse(ex).success, `${b.type} example: ${JSON.stringify(b.schema.safeParse(ex).error?.issues)}`);
  }
  const schema = api.jsonSchema();
  const json = JSON.stringify(schema);
  for (const t of types) assert.ok(json.includes(`"const":"${t}"`), t);
  const doc = api.promptDoc();
  for (const t of types) assert.equal(doc.includes(`### \`${t}\``), !api.retiredCharts.has(t), t);
  assert.deepEqual(api.guideBlocks.map(b => b.type), types.filter(t => !api.retiredCharts.has(t)));
  for (const kind of ['status', 'decision', 'investigation', 'comparison', 'plan', 'results', 'explainer']) assert.ok(doc.includes(`### ${kind}`));
});

test('data charts: the guide offers figure only; old chart blocks still render, each with a warning naming its path', async () => {
  assert.deepEqual([...api.retiredCharts].sort(), ['bar', 'beforeafter', 'donut', 'quadrant', 'trend']);
  const doc = api.promptDoc();
  assert.match(doc, /Every chart is drawn by Python: a matplotlib `figure`/);
  const old = api.blocks.filter(b => api.retiredCharts.has(b.type)).map(b => b.examples[0]);
  const heat = api.registry.get('matrix').examples.find(e => e.cells.flat().some(c => typeof c === 'number'));
  const place = api.registry.get('matrix').examples.find(e => !e.cells.flat().some(c => typeof c === 'number'));
  const r = await api.renderV2(spec([...old, heat, place]), { mode: 'doc' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  old.forEach((b, i) => {
    const w = r.warnings.find(x => x.path === `sections[0].blocks[${i}]`);
    assert.ok(w, b.type); assert.match(w.message, new RegExp(`^${b.type} is no longer a block to choose: the renderer draws no charts of its own`)); assert.equal(w.example.type, 'figure');
  });
  assert.ok(r.warnings.some(x => x.path === `sections[0].blocks[${old.length}].cells` && /figure block/.test(x.message)), 'heatmap matrix');
  assert.ok(!r.warnings.some(x => x.path.startsWith(`sections[0].blocks[${old.length + 1}]`)), 'placement matrix stays quiet');
  const d = dom(r.html);
  for (const t of [...api.retiredCharts, 'matrix']) assert.ok(d.querySelector(`[data-type="${t}"], .blk-${t}`), `${t} still renders`);
  // The renderer draws no chart of its own: retired blocks show their values as a table under a notice.
  for (const t of api.retiredCharts) { const el = d.querySelector(`.blk-${t}`); assert.equal(el.querySelector('svg'), null, t); assert.ok(el.querySelector('.rt-note') && el.querySelector('table.tbl tbody tr'), t); }
  assert.equal(d.querySelector('.blk-matrix .h1, .blk-matrix .h5, .mx-key'), null, 'no heatmap shading');
});

test('generated docs and JSON Schema are in sync with the registry', async () => {
  assert.equal(await readFile(join(root, 'docs/report-blocks.md'), 'utf8'), api.promptDoc());
  assert.equal(await readFile(join(root, 'reports/v2/report-spec.schema.json'), 'utf8'), JSON.stringify(api.jsonSchema(), null, 2) + '\n');
});

test('planner: KPI rows, chart + short prose split, half pairs, full-width tables, author overrides', () => {
  const P = (items, layout) => api.planLayout(items, layout).map(r => `${r.kind}:${r.cells.map(c => `${c.index}/${c.span}`).join(',')}`);
  assert.deepEqual(P([{ fit: 'kpi' }, { fit: 'visual' }, { fit: 'text', short: true }]), ['kpi:0/12', 'split:1/7,2/5']);
  assert.deepEqual(P([{ fit: 'text', short: true }, { fit: 'visual' }]), ['split:0/5,1/7']);
  assert.deepEqual(P([{ fit: 'text', short: false }, { fit: 'visual' }]), ['full:0/12', 'full:1/12']);
  assert.deepEqual(P([{ fit: 'half' }, { fit: 'half' }, { fit: 'full' }, { fit: 'half' }]), ['pair:0/6,1/6', 'full:2/12', 'full:3/12']);
  assert.deepEqual(P([{ fit: 'visual' }, { fit: 'visual', full: true }]), ['full:0/12', 'full:1/12']);
  assert.deepEqual(P([{ fit: 'half' }, { fit: 'half' }], 'stack'), ['full:0/12', 'full:1/12']);
  assert.deepEqual(P([{ fit: 'text' }, { fit: 'text' }], 'grid'), ['pair:0/6,1/6']);
  assert.deepEqual(P([]), []);
});

test('slide planner: cover first, masters chosen from content, overflow goes to a continuation slide', () => {
  const rows = Array.from({ length: 15 }, (_, i) => [`r${i}`, i]);
  const { spec: s } = api.validateSpec({ ...base, next: ['下一步'], sections: [
    { title: 'A', takeaway: '數字', blocks: [{ type: 'kpi', items: [{ label: 'x', value: 1 }] }] },
    { title: 'B', takeaway: '表格', blocks: [{ type: 'table', columns: ['a', 'b'], rows }] },
    { title: 'C', takeaway: '圖與說明', blocks: [{ type: 'bar', title: 't', series: [{ name: 'n' }], rows: [{ label: 'a', values: [1] }] }, { type: 'callout', text: '注意' }] },
    { title: 'D', blocks: [{ type: 'quote', text: '原話' }] },
  ] });
  const slides = api.planSlides(s, api.registry, '（續）');
  assert.deepEqual(slides.map(x => x.master), ['cover', 'kpi-grid', 'table', 'table', 'table', 'split', 'quote', 'closing']);
  assert.equal(slides[3].headline, '表格（續）');
  assert.equal(slides[5].side.length, 1);
  assert.equal(slides[6].headline, 'D');
});

test('slide planner: text-only sections get a dense statement slide, never a mostly empty page', () => {
  const { spec: s } = api.validateSpec({ ...base, sections: [
    { title: 'A', takeaway: '只有一段說明', blocks: [{ type: 'prose', text: '一句話的背景說明。' }] },
    { title: 'B', takeaway: '說明加提醒', blocks: [{ type: 'prose', text: '背景。' }, { type: 'callout', tone: 'warn', text: '注意風險。' }] },
    { title: 'C', takeaway: '圖加說明仍是分欄', blocks: [{ type: 'bar', title: 't', series: [{ name: 'n' }], rows: [{ label: 'a', values: [1] }] }, { type: 'prose', text: '短說明。' }] },
  ] });
  const slides = api.planSlides(s, api.registry, '（續）');
  assert.deepEqual(slides.map(x => x.master), ['cover', 'statement', 'statement', 'split']);
  assert.equal(slides[2].main.length, 2);
  assert.ok(api.v2css.slides.includes('.m-statement'));
});

test('lint: handbook budgets produce warnings with paths', () => {
  const { spec: s } = api.validateSpec({ ...base, kind: 'decision', status: { level: 'at_risk' }, tldr: '一。二。三。四。', sections: [
    { title: 'x', blocks: [{ type: 'prose', text: Array.from({ length: 8 }, (_, i) => `- 點 ${i}`).join('\n') }] },
    { title: 'y', takeaway: '一個非常非常非常非常非常非常非常非常非常非常非常非常長的結論句子超過預算', blocks: [
      { type: 'bar', series: [{ name: 'n' }], rows: [{ label: 'a', values: [1] }] },
      { type: 'donut', title: 'd', parts: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
      { type: 'trend', title: 't', series: [{ name: 's', points: [['2026-10-01', 1], ['2026-10-02', 2]] }] },
      { type: 'prose', text: '很長的證據'.repeat(80) },
    ] },
  ] });
  const w = api.lintSpec(s, api.registry).map(x => `${x.path} ${x.message}`).join('\n');
  for (const needle of ['sections[0].takeaway', 'bullets', 'sections[1].blocks[0].title', '3 charts in one section', 'evidence too long', 'status.reason', 'TL;DR has 4', 'asks', 'options or proscons', 'Takeaway is long']) assert.ok(w.includes(needle), `missing: ${needle}\n${w}`);
  const { spec: clean } = api.validateSpec(spec([{ type: 'kpi', items: [{ label: 'a', value: 1 }] }], { asks: [] }));
  assert.deepEqual(api.lintSpec(clean, api.registry), []);
});

test('validation: top-level errors carry paths and a valid example; broken blocks render as placeholders', async () => {
  let r = await api.renderV2({ ...base, sections: [] });
  assert.equal(r.ok, false); assert.equal(r.html, undefined);
  assert.equal(r.errors[0].path, 'sections'); assert.equal(r.errors[0].example.version, 2);
  r = await api.renderV2(spec([
    { type: 'kpi', items: [{ label: 'ok', value: 3 }] },
    { type: 'bar', series: [{ name: 'a' }, { name: 'b' }], rows: [{ label: 'x', values: [1] }] },
    { type: 'sparkle', x: 1 },
    { type: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'zz' }] },
  ]));
  assert.equal(r.ok, false);
  const paths = r.errors.map(e => e.path);
  assert.ok(paths.includes('sections[0].blocks[1].rows[0].values'), paths.join());
  assert.ok(paths.includes('sections[0].blocks[2].type'));
  assert.ok(paths.includes('sections[0].blocks[3].edges[0].to'));
  assert.equal(r.errors.find(e => e.path.startsWith('sections[0].blocks[1]')).example.type, 'bar');
  assert.match(r.errors.find(e => e.path.endsWith('blocks[2].type')).message, /valid types: .*kpi/);
  const d = dom(r.html);
  assert.equal(d.querySelectorAll('.blk-error').length, 3);
  assert.equal(d.querySelectorAll('.blk-kpi').length, 1);
});

test('every block example renders in doc and slide mode, deterministically, with no script or remote resource', async () => {
  for (const b of api.blocks) for (const ex of b.examples) for (const mode of ['doc', 'slide']) {
    if (!hasMatplotlib && JSON.stringify(ex).includes('"figure"')) continue;
    const one = await api.renderBlock(ex, { mode, baseDir: exDir });
    assert.deepEqual(one.errors, [], b.type);
    const again = await api.renderBlock(ex, { mode, baseDir: exDir });
    assert.equal(one.html, again.html, `${b.type} ${mode} is not deterministic`);
    const d = dom(`<body>${one.html}</body>`);
    assert.ok(d.querySelector(`.blk-${b.type}`), `${b.type} ${mode} root`);
    assert.equal(d.querySelectorAll('script,link,iframe').length, 0);
    assert.doesNotMatch(one.html, /(src|href)="https?:/);
    if (b.visual) assert.ok(d.querySelector('[role=img],table,[role=progressbar],img,ol,ul'), `${b.type} needs an accessible text/table fallback`);
  }
});

test('lightbox: images and flow figures open enlarged; script is inline, only present with figures', async () => {
  const img = api.blocks.find(b => b.type === 'image').examples[0];
  for (const mode of ['doc', 'slide']) {
    const r = await api.renderV2(spec([img, { type: 'flow', title: 'F', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }]), { mode });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const d = dom(r.html);
    const im = d.querySelector('.blk-image img');
    assert.ok(im.hasAttribute('data-zoom') && im.getAttribute('tabindex') === '0' && im.getAttribute('role') === 'button', `${mode} img hooks`);
    const fl = d.querySelector('svg.fl');
    assert.ok(fl.hasAttribute('data-zoom') && fl.getAttribute('tabindex') === '0', `${mode} svg hooks`);
    const scripts = [...d.querySelectorAll('script')].map(x => x.textContent).join('\n');
    assert.match(scripts, /lightbox|data-zoom/); assert.match(scripts, /Escape/); assert.match(scripts, /Enter/);
    assert.doesNotMatch(r.html, /<script[^>]*src=/);
    assert.match(r.html, /\[data-zoom\][^{]*\{[^}]*cursor:zoom-in/); assert.match(r.html, /\.lb[^{]*\{[^}]*object-fit|object-fit:contain/);
    // An enlarged figure fills the window: its box is sized to the viewport and the SVG / PNG scales inside it.
    assert.match(r.html, /\.lb \.fg\.lb-fig\{[^}]*width:92vw;height:90vh/);
    assert.match(r.html, /\.lb \.fg\.lb-fig svg\{width:100%;height:100%/);
    assert.match(r.html, /\.lb \.fg\.lb-fig img\{[^}]*object-fit:contain/);
  }
  const plain = await api.renderV2(spec([{ type: 'prose', text: 'x' }]), { mode: 'doc' });
  assert.equal(dom(plain.html).querySelectorAll('script').length, 0);
});

test('colours come only from theme tokens; light and dark sets are both defined', () => {
  const css = Object.values(api.v2css).join('\n');
  assert.match(css, /prefers-color-scheme:dark/); assert.match(css, /\[data-theme="dark"\]/);
  const tokens = api.v2css.tokens;
  for (const other of [api.v2css.base, api.v2css.blocks, api.v2css.slides]) assert.doesNotMatch(other.replace(/#fff\b/gi, ''), /#[0-9a-f]{3,8}\b/i);
  assert.match(tokens, /--blue:#2F6FE0/); assert.match(tokens, /--ground:#0E0E10/);
});

test('the four examples render clean in doc and slide mode; doc output has no script', async () => {
  const files = (await readdir(exDir)).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 4);
  const kinds = new Set();
  for (const f of files) {
    const s = JSON.parse(await readFile(join(exDir, f), 'utf8'));
    kinds.add(s.kind);
    if (!hasMatplotlib && JSON.stringify(s).includes('"figure"')) continue;
    const doc = await api.renderV2(s, { mode: 'doc', baseDir: exDir });
    assert.equal(doc.ok, true, `${f}: ${JSON.stringify(doc.errors)}`);
    assert.deepEqual(doc.warnings, [], f);
    const d = dom(doc.html);
    assert.equal(d.querySelectorAll('script').length, d.querySelector('[data-zoom]') ? 1 : 0); // only the lightbox, only with figures
    assert.equal(d.querySelector('h1').textContent, s.title);
    assert.equal(d.querySelectorAll('section.sec').length, s.sections.length);
    const slides = await api.renderV2(s, { mode: 'slide', baseDir: exDir });
    const sd = dom(slides.html);
    assert.equal(sd.querySelectorAll('script').length, 1);
    assert.ok(sd.querySelector('script').textContent.length < 3200);
    assert.equal(sd.querySelectorAll('.sv').length, slides.slides);
    assert.ok(sd.querySelector('.m-cover') && sd.querySelector('.sv:last-child .m-closing'));
    for (const sec of s.sections.filter(x => x.takeaway)) assert.ok([...sd.querySelectorAll('.sl>h2')].some(h => h.textContent.startsWith(sec.takeaway)), sec.takeaway);
  }
  if (hasMatplotlib) assert.deepEqual([...kinds].sort(), ['decision', 'investigation', 'results', 'status']);
});

test('text is escaped everywhere, including markdown and closing tags', async () => {
  const evil = '</style><script>alert(1)</script><img src=x onerror=1>';
  const r = await api.renderV2({ ...spec([{ type: 'prose', text: `**粗** ${evil}` }, { type: 'flow', title: evil, nodes: [{ id: 'a', label: evil.slice(0, 30) }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }]), title: evil.slice(0, 40) }, { mode: 'slide' });
  const d = dom(r.html);
  assert.equal(d.querySelectorAll('script').length, 1); // only the pager (+ lightbox, no figures here)
  assert.equal(d.querySelectorAll('img').length, 0);
  assert.ok(d.querySelector('.blk-prose strong'));
});

test('v1 specs still render through the version dispatch', async () => {
  const v1 = JSON.parse(await readFile(join(root, 'reports/examples/project-status-20261028.json'), 'utf8'));
  const r = await api.renderAny(v1);
  assert.equal(r.ok, true);
  assert.equal(r.html, api.renderReport(v1));
  assert.equal(dom(r.html).querySelectorAll('.finding').length, 7);
  const bad = await api.renderAny({ schemaVersion: 1, title: '' });
  assert.equal(bad.ok, false); assert.ok(bad.errors.length);
  assert.equal((await api.renderAny(v1, { mode: 'slide' })).ok, false);
});

test('CLI prints JSON results, writes slides with --slides, and still writes HTML when only a block is broken', async () => {
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), ...args], { encoding: 'utf8' });
  const good = join(temp, 'good.json'), broken = join(temp, 'broken.json');
  await writeFile(good, await readFile(join(exDir, 'status-20261028.json'))); // no figure: the copy has no scripts next to it
  await writeFile(broken, JSON.stringify(spec([{ type: 'kpi', items: [{ label: 'a', value: 1 }] }, { type: 'donut', parts: [{ label: 'a', value: 1 }] }])));
  let r = cli('--check', good); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, errors: [], warnings: [] });
  const out = join(temp, 'artifacts', 'deck.html');
  r = cli(good, out, '--slides'); assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.htmlPath, out); assert.ok(res.slides > 3); assert.match(res.link, /^\[Botling 今天的交付狀態\]\(file:/);
  assert.match(await readFile(out, 'utf8'), /class="sv"/);
  const out2 = join(temp, 'artifacts', 'broken.html');
  r = cli(broken, out2); assert.equal(r.status, 1);
  const b = JSON.parse(r.stdout);
  assert.equal(b.ok, false); assert.equal(b.errors[0].path, 'sections[0].blocks[1].parts'); assert.equal(b.errors[0].example.type, 'donut');
  assert.equal(dom(await readFile(out2, 'utf8')).querySelectorAll('.blk-error').length, 1);
});

test('CLI accepts spaced paths and creates only a missing artifacts folder itself', async () => {
  const { realpathSync, existsSync } = await import('node:fs');
  const base = realpathSync(temp);
  const project = join(base, 'My Project'), spec = join(project, 'spec with space.json');
  await mkdir(project);
  await writeFile(spec, await readFile(join(exDir, 'status-20261028.json')));
  const out = join(project, '.bot', 'artifacts', 'a b.html');
  await mkdir(join(project, '.bot'));
  const r = spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), spec, out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).htmlPath, out);
  assert.ok(existsSync(out));
});

test('rejected output paths change nothing on disk (no folders, no files)', async () => {
  const { realpathSync, existsSync, symlinkSync, readdirSync } = await import('node:fs');
  const base = join(realpathSync(temp), 'reject');
  const proj = join(base, 'proj'), outside = join(base, 'outside');
  await mkdir(join(proj, 'artifacts'), { recursive: true }); await mkdir(outside);
  symlinkSync(outside, join(proj, 'artifacts', 'outside'));
  await mkdir(join(base, 'proj2'));
  symlinkSync(outside, join(base, 'proj2', 'artifacts'));
  const spec = join(base, 'spec.json');
  await writeFile(spec, await readFile(join(exDir, 'status-20261028.json')));
  const snapshot = () => {
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() && !e.isSymbolicLink() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]);
    return walk(base).sort();
  };
  const before = snapshot();
  for (const out of [
    join(base, 'nope', 'artifacts', 'x.html'),                 // missing parent of the artifacts folder
    join(proj, 'artifacts', 'sub', 'x.html'),                  // nested folder that does not exist
    join(proj, 'artifacts', '..', 'escape', 'x.html'),         // traversal out of artifacts
    join(proj, 'artifacts', 'outside', 'newdir', 'report.html'), // symlink escape, new folder below it
    join(proj, 'artifacts', 'outside', 'report.html'),         // symlink escape, existing folder
    join(base, 'proj2', 'artifacts', 'report.html'),           // artifacts itself is a symlink elsewhere
    join(base, 'proj3', 'artifacts', 'x.txt'),                 // wrong extension, folder missing
    join(base, 'plain', 'x.html'),                             // no artifacts folder at all
  ]) {
    const r = spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), spec, out], { encoding: 'utf8' });
    assert.equal(r.status, 1, out);
    assert.equal(JSON.parse(r.stdout).ok, false, out);
    assert.deepEqual(snapshot(), before, `side effect for ${out}`);
  }
  assert.equal(existsSync(join(outside, 'newdir')), false);
  assert.equal(existsSync(join(outside, 'report.html')), false);
});

test('the bundled command ships a licence notice for every package in the bundle', async () => {
  const { build } = await import('esbuild');
  const { thirdPartyNotices, bundledPackages, NOTICES_FILE } = await import('./licenses.mjs');
  const r = await build({ entryPoints: [join(root, 'reports/cli-main.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', outfile: join(temp, 'x.cjs'), metafile: true, jsx: 'automatic', loader: { '.css': 'text', '.woff2': 'base64' }, tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, logLevel: 'silent' });
  const packages = [...bundledPackages(r.metafile, root).keys()];
  for (const p of ['d3-scale', 'd3-array', 'internmap', 'elkjs', 'react', 'react-dom', 'zod', 'markdown-it']) assert.ok(packages.includes(p), p);
  const notices = thirdPartyNotices(r.metafile, root);
  assert.deepEqual(notices.missing, []);
  for (const p of packages) assert.match(notices.text, new RegExp(`^${p.replace(/[.]/g, '\\.')} \\d+\\.\\d+\\.\\d+ — `, 'm'), p);
  assert.match(notices.text, /Permission to use, copy, modify, and\/or distribute this software for any/); // ISC (d3)
  assert.match(notices.text, /Eclipse Public License - v 2\.0/);
  assert.match(notices.text, /Permission is hereby granted, free of charge/); // MIT
  // botling.report's build writes it next to report.cjs (build.json `bundles`), and packaging copies the whole plugin out of app.asar with the guide.
  const plugin = JSON.parse(await readFile(join(root, 'builtin-plugins/botling.report/build.json'), 'utf8'));
  assert.equal(plugin.bundles[0].outfile, 'report.cjs');
  assert.equal(plugin.bundles[0].notices, NOTICES_FILE);
  assert.match(await readFile(join(root, 'build-builtin-plugins.mjs'), 'utf8'), /writeFileSync\(join\(folder, notices\), found\.text\)/);
  assert.match(await readFile(join(root, 'electron-builder.config.cjs'), 'utf8'), /from: "out\/builtin-plugins", to: "builtin-plugins"/);
});


test('table strings never infer status from wording or column headings', async () => {
  const texts = ['已在調查，尚未修復', 'Password reset', 'fixed-width layout', '取消按鈕', 'done', 'pass', '已完成', 'cancelled', 'pending', 'risk', 'unverified'];
  for (const mode of ['doc', 'slide']) for (const heading of ['Status', '狀態', '交付狀態', 'Feature']) {
    const r = await api.renderBlock({ type: 'table', columns: [heading, heading], rows: texts.map(text => [text, { text }]) }, { mode });
    assert.deepEqual(r.errors, []);
    const d = dom(r.html);
    assert.equal(d.querySelectorAll('.cell-s, s, .sr-only').length, 0);
    assert.deepEqual([...d.querySelectorAll('tbody th, tbody td')].map(c => c.textContent), texts.flatMap(s => [s, s]));
  }
});

test('table explicit metadata controls status, strike and accessibility independently of text', async () => {
  const statuses = ['done', 'active', 'pending', 'blocked', 'risk', 'unverified', 'skipped'];
  const labels = ['Done', 'In progress', 'Pending', 'Blocked', 'At risk', 'Unverified', 'Skipped'];
  for (const mode of ['doc', 'slide']) {
    const r = await api.renderBlock({ type: 'table', columns: ['Feature', 'Details'], rows: statuses.map(status => ['done', { text: 'Password reset', status }]) }, { mode, lang: 'en' });
    assert.deepEqual(r.errors, []);
    const d = dom(r.html);
    assert.equal(d.querySelectorAll('tbody th .cell-s').length, 0);
    assert.equal(d.querySelectorAll('tbody td .cell-s').length, statuses.length);
    assert.deepEqual([...d.querySelectorAll('tbody td .sr-only')].map(c => c.textContent), labels.map(label => `（${label}）`));
    assert.equal(d.querySelectorAll('s').length, 1);
    assert.equal(d.querySelector('tbody tr:last-child s').textContent, 'Password reset');
    const styled = dom((await api.renderBlock({ type: 'table', columns: ['A', 'B'], rows: [[{ text: 'done', tone: 'warn' }, { text: 'cancelled', strong: true }]] }, { mode })).html);
    assert.ok(styled.querySelector('.t-warn'));
    assert.equal(styled.querySelector('b').textContent, 'cancelled');
    assert.equal(styled.querySelectorAll('s, .sr-only').length, 0);
  }
  const table = api.blocks.find(b => b.type === 'table');
  assert.equal(table.schema.safeParse({ type: 'table', columns: ['A', 'B'], rows: [['x', { text: 'done', status: 'pass' }]] }).success, false);
});

test('results lint suggests evidence without claiming mandatory comparisons or inventing measurements', () => {
  const { spec: s } = api.validateSpec(spec([{ type: 'prose', text: 'No baseline was measured; the cause remains uncertain.' }], { kind: 'results', impact: '還不知道對使用者有沒有影響。' }));
  const warnings = api.lintSpec(s, api.registry);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /when available/);
  assert.doesNotMatch(warnings[0].message, /must/);
  const { spec: measured } = api.validateSpec(spec([{ type: 'kpi', items: [{ label: 'Observed latency', value: 12 }] }], { kind: 'results', impact: '還不知道對使用者有沒有影響。' }));
  assert.deepEqual(api.lintSpec(measured, api.registry), []);
});

test('flowchart and legacy flow share validation, rendering and investigation lint', async () => {
  const payload = {
    title: 'The API connects clients to storage',
    nodes: [{ id: 'client', label: 'Client' }, { id: 'api', label: 'API' }, { id: 'db', label: 'Database' }],
    edges: [{ from: 'client', to: 'api', label: 'request' }, { from: 'api', to: 'db' }],
  };
  const report = type => spec([{ type, ...payload }], { kind: 'investigation', impact: 'Clients cannot save while the API is down.', asks: [] });
  for (const mode of ['doc', 'slide']) {
    const old = await api.renderV2(report('flow'), { mode });
    const current = await api.renderV2(report('flowchart'), { mode });
    assert.equal(old.ok, true); assert.equal(current.ok, true);
    assert.deepEqual(current.warnings, []); assert.deepEqual(old.warnings, []);
    assert.equal(current.html.replaceAll('blk-flowchart', 'blk-flow'), old.html);
    assert.equal(current.slides, old.slides);
  }
  for (const type of ['flowchart', 'flow']) {
    const valid = { type, ...payload };
    const schema = api.registry.get(type).schema;
    assert.equal(schema.safeParse(valid).success, true);
    for (const invalid of [
      { ...valid, nodes: [payload.nodes[0], payload.nodes[0]] },
      { ...valid, edges: [{ from: 'client', to: 'missing' }] },
      { ...valid, dir: 'invalid' },
      { ...valid, extra: true },
    ]) {
      assert.equal(schema.safeParse(invalid).success, false, type);
      assert.equal(api.validateSpec(spec([invalid])).errors.length > 0, true, type);
    }
    const large = { ...valid, nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })), edges: [] };
    const result = await api.renderV2(spec([large], { kind: 'investigation', impact: 'Clients cannot save while the API is down.', asks: [] }));
    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /13 nodes/);
  }
  const mixed = await api.renderV2(spec([{ type: 'flow', ...payload }, { type: 'flowchart', ...payload }], { asks: [] }));
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.warnings, []);
  const d = dom(mixed.html);
  assert.equal(d.querySelectorAll('.blk-flow, .blk-flowchart').length, 2);
});


test('retired bar shows its values, kind-aware research budgets, and SVG images disabled', async () => {
  const barRes = await api.renderBlock({
    type: 'bar',
    title: '扣除隨機猜測後 MAtt 跨人增益相等，SPDIM 轉負',
    unit: 'Δκ',
    series: [{ name: '2a' }, { name: 'OpenBMI' }],
    rows: [
      { label: 'MAtt 跨受試者', values: [0.098, 0.096] },
      { label: 'SPDIM 跨受試者', values: [-0.032, -0.033] },
    ],
  }, { mode: 'doc' });
  assert.deepEqual(barRes.errors, []);
  const bd = dom(`<body>${barRes.html}</body>`);
  assert.equal(bd.querySelector('svg'), null);
  assert.match(barRes.html, /0\.098/);
  assert.match(barRes.html, /-0\.032/);

  const svgSrc = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>t</text></svg>').toString('base64');
  const rows10 = Array.from({ length: 10 }, (_, i) => [`A0${i + 1}`, i]);
  const longProse = '白話定義與圖表導讀說明文字。'.repeat(25);
  const { spec: resSpec, errors } = api.validateSpec({ ...spec([
    { type: 'glossary', items: [{ term: 'Δκ', plain: '扣掉亂猜後的分數差。' }] },
    { type: 'kpi', items: [{ label: 'Δκ', value: '0.098' }] },
    { type: 'prose', text: longProse },
    { type: 'image', title: '手刻圖', alt: '密集文字', src: svgSrc },
  ], { kind: 'results', impact: '跨人增益在兩個資料集一樣大。', asks: [] }), sections: [
    { title: '段落', takeaway: '這段的結論', blocks: [{ type: 'glossary', items: [{ term: 'Δκ', plain: '扣掉亂猜後的分數差。' }] }, { type: 'kpi', items: [{ label: 'Δκ', value: '0.098' }] }, { type: 'prose', text: longProse }, { type: 'image', title: '手刻圖', alt: '密集文字', src: svgSrc }] },
    { title: '明細', takeaway: '十位受試者的分數', collapsed: true, blocks: [{ type: 'table', title: '受試者明細', columns: ['受試者', '分數'], rows: rows10 }] },
  ] });
  assert.deepEqual(errors, []);
  const warnings = api.lintSpec(resSpec, api.registry);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0].path, 'sections[0].blocks[3].src');
  assert.match(warnings[0].message, /SVG images are disabled/);
  const page = dom(api.renderV2(resSpec).html);
  assert.equal(page.querySelectorAll('.blk-image img').length, 0);
  assert.equal(page.querySelector('.blk-image .fg-none').textContent, '密集文字');
});

test('readability lint: answer first, first-page items, conclusion headings, numbers with baselines, defined terms', () => {
  const lint = extra => api.lintSpec(api.validateSpec({ ...base, sections: [{ title: '段落', takeaway: '這段的結論', blocks: [{ type: 'prose', text: '說明。' }] }], ...extra }).spec, api.registry);
  const paths = extra => lint(extra).map(w => w.path);
  // Background first → warned; the answer first → not.
  assert.ok(paths({ tldr: '本報告整理上週的實驗。結果是有效。' }).includes('tldr'));
  assert.ok(!paths({ tldr: '有效：新方法比舊方法高 3 分。' }).includes('tldr'));
  // First-page items by kind.
  assert.deepEqual(paths({ kind: 'status', asks: [] }).filter(p => ['impact', 'risk', 'next'].includes(p)).sort(), ['impact', 'next', 'risk']);
  assert.deepEqual(paths({ kind: 'status', asks: [], impact: '使用者不受影響。', risk: { text: '可能延一天' }, next: ['修'] }).filter(p => ['impact', 'risk', 'next'].includes(p)), []);
  assert.ok(paths({ status: { level: 'off_track', reason: '延了' }, asks: [] }).includes('asks'));
  assert.ok(paths({ status: { level: 'at_risk', reason: '延了' }, asks: [] }).includes('risk.plan'));
  assert.ok(!paths({ status: { level: 'at_risk', reason: '延了' }, asks: [], risk: { text: '延', plan: '明天補測' } }).includes('risk.plan'));
  // Topic-only takeaways.
  const topic = api.lintSpec(api.validateSpec({ ...base, sections: [{ title: '結果', takeaway: '結果', blocks: [{ type: 'prose', text: 'x' }] }, { title: 'b', takeaway: '進度說明', blocks: [{ type: 'prose', text: 'x' }] }] }).spec, api.registry);
  assert.deepEqual(topic.filter(w => /names a topic/.test(w.message)).map(w => w.path), ['sections[0].takeaway', 'sections[1].takeaway']);
  // A bare number is warned; a compared one is not.
  assert.ok(paths({ tldr: '準確率 92%。' }).includes('tldr'));
  for (const ok of ['準確率 92%（現行規則 85%）。', '準確率從 85% 升到 92%。', '增益 +0.3 pp，不顯著。', '準確率 92%，比亂猜高 42 pp。', '版本 2.1.3 已安裝。']) assert.ok(!paths({ tldr: ok }).includes('tldr'), ok);
  // Undefined terms: listed once, at their first use; glossary and bracketed definitions count.
  const undef = lint({ tldr: 'SESS 讓 MAtt 在 LOSO 上更好，κ 也升。' }).find(w => /without a plain definition/.test(w.message));
  assert.ok(undef); assert.equal(undef.path, 'tldr'); assert.match(undef.message, /SESS, MAtt, LOSO, κ/);
  assert.equal(lint({ tldr: '先對齊腦波基準（SESS）後，留一受試者驗證（LOSO）的分數從 41% 升到 50%。' }).filter(w => /plain definition/.test(w.message)).length, 0);
  const glossed = { ...base, tldr: 'SESS 讓分數從 41% 升到 50%。', sections: [{ title: '名詞', takeaway: '先看懂一個詞', blocks: [{ type: 'glossary', items: [{ term: 'SESS', plain: '把每個人的腦波先調到同一基準。' }] }] }] };
  assert.equal(api.lintSpec(api.validateSpec(glossed).spec, api.registry).filter(w => /plain definition/.test(w.message)).length, 0);
  assert.equal(lint({ tldr: 'GPU 與 API 都正常，PR 已合併。' }).filter(w => /plain definition/.test(w.message)).length, 0);
});

test('experiment kind: card checks, noise-aware verdict, and no "improvement" inside the noise', async () => {
  const card = { type: 'experiment', question: '加了 SESS 會不會更準？', hypothesis: '加 SESS 後準確率至少高 3 pp。', success: '區間不含 0。', baseline: '同模型、不加 SESS', baselineTuned: true, runs: 3, spread: '受試者間標準差（9 人）', result: { metric: '準確率', base: 74.9, new: 75.5, ci: [-1.2, 2.5], unit: '%' }, verdict: 'inconclusive' };
  const fig = { type: 'figure', title: '每位受試者的準確率', script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: '每位受試者加不加 SESS', perUnit: true };
  const overview = { question: '加 SESS 會不會更準？', compare: '同模型加與不加 SESS', setup: '2a，9 人，3 個種子', complete: '350 代算訓練完成' };
  const flow = { type: 'figure', role: 'flowchart', title: '兩條路只差 SESS', script: 'figures/flowchart.py', args: ['figures/flowchart.json'], alt: '流程' };
  const exp = (blocks, extra = {}) => api.validateSpec({ ...base, kind: 'experiment', overview, impact: '還不能把 SESS 當成跨 session 的改進。', risk: { text: '只有 9 人', plan: '補 OpenBMI 54 人' }, next: ['跑 OpenBMI'], asks: [], tldr: '跨 session 加 SESS 的差距在誤差內，不顯著（3 seeds）。', sections: [{ title: '流程', takeaway: '兩條路只差有沒有先做 SESS', blocks: [flow] }, { title: '每位受試者', takeaway: '每位受試者加 SESS 前後的準確率', blocks: [fig] }, { title: '實驗卡', takeaway: '差距在誤差內，假設還不能判定', collapsed: true, blocks: [{ type: 'glossary', items: [{ term: 'SESS', plain: '把每個人的腦波先調到同一基準。' }, { term: 'OpenBMI', plain: '54 人的公開腦波資料集。' }] }, ...blocks] }], ...extra });
  const { spec: good, errors } = exp([card]);
  assert.deepEqual(errors, []);
  assert.deepEqual(api.lintSpec(good, api.registry), []);
  const w = api.lintSpec(exp([{ ...card, runs: 1, baselineTuned: undefined, verdict: 'supported', result: { ...card.result } }], { tldr: 'SESS 讓準確率從 74.9% 提升到 75.5%。' }).spec, api.registry).map(x => `${x.path} ${x.message}`).join('\n');
  for (const needle of ['sections[2].blocks[1].runs Only 1 run', 'sections[2].blocks[1].baselineTuned', 'sections[2].blocks[1].verdict The 95% interval', 'tldr The bottom line claims an improvement']) assert.ok(w.includes(needle), `missing: ${needle}\n${w}`);
  assert.ok(api.lintSpec(exp([{ type: 'prose', text: '沒有卡。' }]).spec, api.registry).some(x => /without an experiment block/.test(x.message)));
  assert.ok(api.lintSpec(exp([card, { type: 'kpi', items: [{ label: '準確率', value: '75.5%' }] }]).spec, api.registry).some(x => /Experiment KPI without delta/.test(x.message)));
  assert.equal(api.blocks.find(b => b.type === 'experiment').schema.safeParse({ ...card, result: { ...card.result, ci: [3, 1] } }).success, false);
  for (const mode of ['doc', 'slide']) {
    const r = await api.renderBlock(card, { mode });
    assert.deepEqual(r.errors, []);
    assert.match(r.html, /還不能判定/); assert.match(r.html, /不顯著/); assert.match(r.html, /\+0\.6 pp/); assert.match(r.html, /同等調參/);
  }
  const supported = await api.renderBlock({ ...card, result: { ...card.result, ci: [0.4, 2.5] }, verdict: 'supported' }, { mode: 'doc' });
  assert.doesNotMatch(supported.html, /不顯著/);
});

test('first page: impact, biggest risk and the asks sit with the verdict, before the sections', async () => {
  const r = await api.renderV2({ ...spec([{ type: 'glossary', items: [{ term: 'κ', plain: '扣掉亂猜後的分數。' }] }]), impact: '使用者不受影響。', risk: { text: '可能延一天', plan: '明天補測' }, asks: [{ what: '確認停機', who: '你', by: '今天' }] }, { mode: 'doc' });
  assert.equal(r.ok, true);
  const d = dom(r.html);
  const verdict = d.querySelector('.verdict');
  assert.match(verdict.querySelector('.vimpact').textContent, /使用者不受影響/);
  assert.match(verdict.querySelector('.vrisk').textContent, /可能延一天.*明天補測/);
  assert.equal(verdict.nextElementSibling.className, 'asks');
  assert.ok(d.querySelector('.blk-glossary dt').textContent === 'κ');
  const slides = dom((await api.renderV2({ ...spec([{ type: 'prose', text: 'x' }]), impact: '使用者不受影響。' }, { mode: 'slide' })).html);
  assert.match(slides.querySelector('.m-cover .vimpact').textContent, /使用者不受影響/);
});

test('prompt doc: report-type templates, checked vs written rules, and causal sentences kept whole', () => {
  const doc = api.promptDoc();
  assert.ok(doc.includes('### experiment') && doc.includes('### status') && doc.includes('### investigation') && doc.includes('### explainer'));
  for (const needle of ['The first page holds five things', 'define every term once', 'Every number has a reference point and a meaning', 'equally tuned baseline', 'not significant', 'road to green', '## Checked by the renderer (warnings)', '## Not checked: rules only', '## Before you publish', 'keep a cause and its effect in one sentence']) assert.ok(doc.includes(needle), needle);
  assert.doesNotMatch(doc, /at most 20 English words or 30 Chinese characters/);
});

test('experiment order: the answer first, the first section (flowcharts) next, the setup collapsed after it; lint asks for both', async () => {
  const fig = { type: 'figure', title: '每位受試者的準確率', script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: '每位受試者基準與方法', perUnit: true, missing: ['資料集 B · 條件 2'] };
  const s = { ...base, kind: 'experiment', overview: { question: '方法會不會比基準準？', compare: '同模型、同資料，只差方法', setup: '兩個資料集、兩種條件，各 3 個種子', complete: '訓練 350 代才算完成；30 代不算', why: '新使用者不用重收資料' }, impact: '可以進下一步。', risk: { text: '人數少' }, next: ['補跑'], asks: [],
    sections: [{ title: '每位受試者', takeaway: '多數受試者用了方法後變好', blocks: [fig] }, { title: '細節', takeaway: '差距大於誤差', blocks: [{ type: 'prose', text: '說明。' }] }] };
  const paths = spec => api.lintSpec(api.validateSpec(spec).spec, api.registry).map(w => w.path);
  assert.ok(!paths(s).includes('overview'));
  assert.ok(paths({ ...s, overview: undefined }).includes('overview'));
  assert.ok(api.validateSpec({ ...s, overview: { ...s.overview, complete: undefined } }).errors.some(e => e.path === 'overview.complete'), 'what counts as complete training is required');
  const barFirst = { ...s, sections: [{ title: '總結', takeaway: '方法平均高 3 分', blocks: [{ type: 'bar', title: '方法平均高 3 分', series: [{ name: 'x' }], rows: [{ label: 'a', values: [1] }] }, fig] }] };
  assert.ok(api.lintSpec(api.validateSpec(barFirst).spec, api.registry).some(w => w.path === 'sections[0].blocks[0]' && /complete results/.test(w.message)));
  assert.ok(api.lintSpec(api.validateSpec({ ...s, sections: [{ title: '圖', takeaway: '多數變好', blocks: [{ ...fig, perUnit: undefined }] }] }).spec, api.registry).some(w => /complete results/.test(w.message)));
  if (!hasMatplotlib) return;
  const r = api.renderV2(s, { mode: 'doc', baseDir: exDir });
  assert.deepEqual(r.errors, []);
  const d = dom(r.html);
  const order = [...d.querySelectorAll('.rp > *')].map(e => e.className.split(' ')[0]);
  assert.deepEqual(order.slice(0, 6), ['rp-head', 'verdict', 'asks', 'sec', 'more', 'sec']);
  const ov = d.querySelector('details.more .overview');
  assert.ok(ov && !ov.closest('details').hasAttribute('open'), 'setup collapsed');
  assert.match(ov.textContent, /研究問題.*在比什麼.*資料與設定.*怎樣算訓練完成.*為什麼重要/);
  assert.match(d.querySelector('.fg-miss').textContent, /未跑：資料集 B · 條件 2/);
  const slides = api.renderV2(s, { mode: 'slide', baseDir: exDir });
  const sd = dom(slides.html);
  assert.ok(sd.querySelector('.sv:first-child .verdict'), 'the answer on the cover');
  assert.ok(sd.querySelector('.sv:nth-child(3) .overview'), 'the setup after the first section');
});

test('figure: runs the matplotlib script, inlines a theme-aware SVG or two PNGs, and reports failures as errors', { skip: !hasMatplotlib && 'matplotlib not installed' }, async () => {
  const fig = api.blocks.find(b => b.type === 'figure').examples.find(e => e.perUnit);
  const svg = api.renderBlock(fig, { mode: 'doc', baseDir: exDir });
  assert.deepEqual(svg.errors, []);
  const d = dom(`<body>${svg.html}</body>`);
  const el = d.querySelector('.blk-figure .fg svg');
  assert.ok(el && el.getAttribute('viewBox'));
  assert.equal(el.hasAttribute('width'), false);
  assert.match(svg.html, /var\(--text\)/); assert.match(svg.html, /var\(--blue\)/); assert.match(svg.html, /var\(--orange\)/);
  // Small multiples, no empty panels: the example has 3 conditions with data and 2 models → 6 axes at most, none blank.
  assert.ok((svg.html.match(/id="axes_/g) ?? []).length >= 3);
  assert.doesNotMatch(svg.html, /#0b0b/i);
  assert.doesNotMatch(el.outerHTML, /未跑/, 'conditions not run are not drawn');
  assert.match(d.querySelector('.fg-miss').textContent, /未跑/, 'they are one line under the chart');
  assert.equal(d.querySelectorAll('script').length, 0);
  const png = api.renderBlock({ ...fig, format: 'png' }, { mode: 'doc', baseDir: exDir });
  assert.deepEqual(png.errors, []);
  const pd = dom(`<body>${png.html}</body>`);
  assert.match(pd.querySelector('img.fg-l').src, /^data:image\/png;base64,/);
  assert.match(pd.querySelector('img.fg-d').src, /^data:image\/png;base64,/);
  assert.notEqual(pd.querySelector('img.fg-l').src, pd.querySelector('img.fg-d').src);
  // Failures: missing script, Python error, nothing drawn, timeout, not a .py file.
  const scripts = await mkdtemp(join(tmpdir(), 'figure-test-'));
  await writeFile(join(scripts, 'boom.py'), 'raise ValueError("bad data file")\n');
  await writeFile(join(scripts, 'empty.py'), 'x = 1\n');
  await writeFile(join(scripts, 'slow.py'), 'import time\ntime.sleep(30)\n');
  await writeFile(join(scripts, 'args.py'), 'import sys, matplotlib.pyplot as plt\nplt.title(sys.argv[1])\nplt.plot([0, 1], [0, 1])\n');
  const run = extra => api.renderBlock({ type: 'figure', alt: 'x', ...extra }, { mode: 'doc', baseDir: scripts });
  assert.match(run({ script: 'missing.py' }).errors[0].message, /figure failed: figure script not found/);
  assert.match(run({ script: 'boom.py' }).errors[0].message, /figure script failed.*ValueError: bad data file/);
  assert.match(run({ script: 'empty.py' }).errors[0].message, /drew no figure/);
  assert.match(run({ script: 'slow.py', timeout: 5 }).errors[0].message, /timed out after 5 s/);
  assert.match(run({ script: 'x.sh' }).errors[0].message, /\.py/);
  const withArgs = run({ script: 'args.py', args: ['標題參數'] });
  assert.deepEqual(withArgs.errors, []); assert.match(withArgs.html, /標題參數/);
  const page = api.renderV2({ ...base, sections: [{ title: 'x', takeaway: '圖壞了', blocks: [{ type: 'figure', alt: 'x', script: 'boom.py' }] }] }, { baseDir: scripts });
  assert.equal(page.ok, false); assert.equal(page.errors[0].path, 'sections[0].blocks[0]');
  await rm(scripts, { recursive: true, force: true });
});

test('figure: the CLI resolves scripts next to the spec', { skip: !hasMatplotlib && 'matplotlib not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'figure-cli-'));
  await mkdir(join(dir, 'artifacts'));
  await writeFile(join(dir, 'artifacts', 'plot.py'), 'import matplotlib.pyplot as plt\nplt.bar(["a", "b"], [1, 2])\n');
  await writeFile(join(dir, 'artifacts', 'spec.json'), JSON.stringify({ ...base, sections: [{ title: 'x', takeaway: 'b 比 a 高', blocks: [{ type: 'figure', title: 'b 比 a 高', alt: 'a 與 b 的長條', script: 'plot.py' }] }] }));
  const r = spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), join(dir, 'artifacts', 'spec.json'), join(dir, 'artifacts', 'out.html')], { encoding: 'utf8', cwd: tmpdir() });
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true, r.stdout);
  assert.match(await readFile(join(dir, 'artifacts', 'out.html'), 'utf8'), /class="fg"[^>]*><svg/);
  await rm(dir, { recursive: true, force: true });
});

test('charts first: collapsed sections render after the main ones as closed <details>, also in slides', async () => {
  const s = { ...base, sections: [
    { title: '細節', takeaway: '補充的精確數值', collapsed: true, blocks: [{ type: 'table', columns: ['a', 'b'], rows: [['x', 1], ['y', 2]] }] },
    { title: '主圖', takeaway: '主要的結論', blocks: [{ type: 'prose', text: '說明。' }] },
  ] };
  const d = dom(api.renderV2(s).html);
  const kids = [...d.querySelectorAll('.rp > *')].map(e => e.tagName.toLowerCase() + '.' + e.className.split(' ')[0]);
  assert.deepEqual(kids.slice(-4), ['section.sec', 'p.more-h', 'details.more', 'footer.rp-foot']);
  const det = d.querySelector('details.more');
  assert.equal(det.hasAttribute('open'), false);
  assert.match(det.querySelector('summary').textContent, /細節補充的精確數值/);
  assert.ok(det.querySelector('section.sec table'));
  const slides = api.planSlides(api.validateSpec(s).spec, api.registry);
  assert.deepEqual(slides.filter(x => x.section !== undefined).map(x => x.section), [1, 0], 'main sections first in the deck too');
});

test('layout lint: numeric tables, long lists and callouts in the main part, the same figure twice, a missing flowchart', () => {
  const lint = (sections, extra = {}) => api.lintSpec(api.validateSpec({ ...base, sections, ...extra }).spec, api.registry);
  const numeric = { type: 'table', columns: ['設定', '不加 → 加', '差距'], rows: [['A', '41.9 → 50.8', '+8.9（2.2～15.6）'], ['B', '74.9 → 75.5', '+0.6（-1.2～2.5）']] };
  const words = { type: 'table', columns: ['工作線', '狀態'], rows: [['報告', '進行中'], ['安裝', '完成']] };
  let w = lint([{ title: 'a', takeaway: '主結論', blocks: [numeric, words] }]);
  assert.deepEqual(w.filter(x => /table of numbers/.test(x.message)).map(x => x.path), ['sections[0].blocks[0]']);
  assert.equal(w.find(x => /table of numbers/.test(x.message)).example.type, 'figure');
  assert.equal(lint([{ title: 'a', takeaway: '主結論', collapsed: true, blocks: [numeric] }]).filter(x => /table of numbers/.test(x.message)).length, 0, 'collapsed is fine');
  w = lint([{ title: 'a', takeaway: '主結論', blocks: [{ type: 'prose', text: '- a\n- b\n- c\n- d' }, { type: 'callout', tone: 'info', text: 'x' }, { type: 'callout', tone: 'warn', text: 'y' }] }]);
  assert.ok(w.some(x => x.path === 'sections[0].blocks[0].text' && /4 bullets in the main part/.test(x.message) && x.example.collapsed === true));
  assert.ok(w.some(x => x.path === 'sections[0].blocks[1]' && /2 callouts in the main part/.test(x.message)));
  assert.equal(lint([{ title: 'a', takeaway: '主結論', blocks: [{ type: 'prose', text: '- a\n- b\n- c' }] }]).filter(x => /bullets in the main/.test(x.message)).length, 0);
  const fig = { type: 'figure', title: '圖', script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: '圖' };
  const card = { type: 'experiment', question: 'q', hypothesis: 'h', success: 's', baseline: 'b', baselineTuned: true, runs: 3, spread: 'sd', verdict: 'inconclusive', figure: { script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: 'x' } };
  w = lint([{ title: 'a', takeaway: '主結論', blocks: [fig, { ...fig, args: ['figures/other.csv'] }] }, { title: 'b', takeaway: '次結論', blocks: [card] }]);
  assert.deepEqual(w.filter(x => /same figure/.test(x.message)).map(x => x.path), ['sections[1].blocks[0].figure.script']);
  assert.match(w.find(x => /same figure/.test(x.message)).message, /already drawn at sections\[0\]\.blocks\[0\]/);
  // Experiment: no flowchart → warned with a valid example; one or more flowcharts → quiet.
  const exp = { kind: 'experiment', overview: { question: 'q', compare: 'c', setup: 's', complete: '350 代' } };
  const noFlow = lint([{ title: 'a', takeaway: '主結論', blocks: [{ ...fig, perUnit: true }] }], exp).find(x => /without a flowchart/.test(x.message));
  assert.ok(noFlow); assert.equal(noFlow.example.role, 'flowchart'); assert.equal(api.registry.get('figure').schema.safeParse(noFlow.example).success, true);
  const flows = [1, 2].map(i => ({ type: 'figure', role: 'flowchart', title: `流程 ${i}`, script: 'figures/flowchart.py', args: [`figures/flow${i}.json`], alt: '流程' }));
  w = lint([{ title: '流程', takeaway: '兩張流程圖', blocks: flows }, { title: '結果', takeaway: '主結論', blocks: [{ ...fig, perUnit: true }] }, { title: '卡', takeaway: '次結論', blocks: [{ type: 'prose', text: '只有字。' }] }], exp);
  assert.equal(w.filter(x => /flowchart/.test(x.message)).length, 0, 'flowcharts before the complete-results chart are fine');
  assert.ok(w.some(x => x.path === 'sections[2]' && /has no chart/.test(x.message)));
  for (const issue of w.filter(x => x.example)) if (issue.example.type) assert.equal(api.registry.get(issue.example.type).schema.safeParse(issue.example).success, true, issue.message);
});

test('experiment card: draws its own figure from a .py and keeps the design collapsed under it', { skip: !hasMatplotlib && 'matplotlib not installed' }, () => {
  const card = api.registry.get('experiment').examples[0];
  const r = api.renderBlock(card, { mode: 'doc', baseDir: exDir });
  assert.deepEqual(r.errors, []);
  const d = dom(`<body>${r.html}</body>`);
  assert.ok(d.querySelector('.blk-experiment .xfig .fg svg'));
  assert.match(d.querySelector('.xfig figcaption').textContent, /一位受試者/);
  const more = d.querySelector('.blk-experiment details.xmore');
  assert.ok(more && !more.hasAttribute('open') && more.querySelector('dl.xg'));
  const bad = api.renderBlock({ ...card, figure: { ...card.figure, script: 'figures/missing.py' } }, { mode: 'doc', baseDir: exDir });
  assert.match(bad.errors[0].message, /figure failed: figure script not found/);
  const flow = api.renderBlock(api.registry.get('figure').examples.find(e => e.role === 'flowchart'), { mode: 'doc', baseDir: exDir });
  assert.deepEqual(flow.errors, []);
  assert.ok(dom(`<body>${flow.html}</body>`).querySelector('.blk-figure.fg-flow .fg svg'));
  assert.match(flow.html, /var\(--blue\)/, 'the coloured step follows the theme');
});
