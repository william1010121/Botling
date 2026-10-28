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
  for (const t of types) assert.ok(doc.includes(`### \`${t}\``), t);
  for (const kind of ['status', 'decision', 'investigation', 'comparison', 'plan', 'results', 'explainer']) assert.ok(doc.includes(`### ${kind}`));
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
    const one = await api.renderBlock(ex, { mode });
    assert.deepEqual(one.errors, [], b.type);
    const again = await api.renderBlock(ex, { mode });
    assert.equal(one.html, again.html, `${b.type} ${mode} is not deterministic`);
    const d = dom(`<body>${one.html}</body>`);
    assert.ok(d.querySelector(`.blk-${b.type}`), `${b.type} ${mode} root`);
    assert.equal(d.querySelectorAll('script,link,iframe').length, 0);
    assert.doesNotMatch(one.html, /(src|href)="https?:/);
    if (b.visual) assert.ok(d.querySelector('[role=img],table,[role=progressbar],img,ol,ul'), `${b.type} needs an accessible text/table fallback`);
  }
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
    const doc = await api.renderV2(s, { mode: 'doc' });
    assert.equal(doc.ok, true, `${f}: ${JSON.stringify(doc.errors)}`);
    assert.deepEqual(doc.warnings, [], f);
    const d = dom(doc.html);
    assert.equal(d.querySelectorAll('script').length, 0);
    assert.equal(d.querySelector('h1').textContent, s.title);
    assert.equal(d.querySelectorAll('section.sec').length, s.sections.length);
    const slides = await api.renderV2(s, { mode: 'slide' });
    const sd = dom(slides.html);
    assert.equal(sd.querySelectorAll('script').length, 1);
    assert.ok(sd.querySelector('script').textContent.length < 1200);
    assert.equal(sd.querySelectorAll('.sv').length, slides.slides);
    assert.ok(sd.querySelector('.m-cover') && sd.querySelector('.sv:last-child .m-closing'));
    for (const sec of s.sections.filter(x => x.takeaway)) assert.ok([...sd.querySelectorAll('.sl>h2')].some(h => h.textContent.startsWith(sec.takeaway)), sec.takeaway);
  }
  assert.deepEqual([...kinds].sort(), ['decision', 'investigation', 'results', 'status']);
});

test('text is escaped everywhere, including markdown and closing tags', async () => {
  const evil = '</style><script>alert(1)</script><img src=x onerror=1>';
  const r = await api.renderV2({ ...spec([{ type: 'prose', text: `**粗** ${evil}` }, { type: 'flow', title: evil, nodes: [{ id: 'a', label: evil.slice(0, 30) }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }]), title: evil.slice(0, 40) }, { mode: 'slide' });
  const d = dom(r.html);
  assert.equal(d.querySelectorAll('script').length, 1); // only the pager
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
  await writeFile(good, await readFile(join(exDir, 'results-performance.json')));
  await writeFile(broken, JSON.stringify(spec([{ type: 'kpi', items: [{ label: 'a', value: 1 }] }, { type: 'donut', parts: [{ label: 'a', value: 1 }] }])));
  let r = cli('--check', good); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, errors: [], warnings: [] });
  const out = join(temp, 'artifacts', 'deck.html');
  r = cli(good, out, '--slides'); assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.htmlPath, out); assert.ok(res.slides > 3); assert.match(res.link, /^\[Botling \.11 的效能變化\]\(file:/);
  assert.match(await readFile(out, 'utf8'), /class="sv"/);
  const out2 = join(temp, 'artifacts', 'broken.html');
  r = cli(broken, out2); assert.equal(r.status, 1);
  const b = JSON.parse(r.stdout);
  assert.equal(b.ok, false); assert.equal(b.errors[0].path, 'sections[0].blocks[1].parts'); assert.equal(b.errors[0].example.type, 'donut');
  assert.equal(dom(await readFile(out2, 'utf8')).querySelectorAll('.blk-error').length, 1);
});
