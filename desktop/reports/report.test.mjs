import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minimal = { schemaVersion: 1, title: 'A report', asOf: '2026-10-28', summary: 'Observed evidence only.' };
let temp, api;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'report-test-'));
  await mkdir(join(temp, 'artifacts'));
  await build({ stdin: { contents: `export * from './reports/render'; export * from './src/core/page-preview'; export * from './src/main/preview-response';`, resolveDir: root }, outfile: join(temp, 'api.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' }, logLevel: 'silent' });
  api = createRequire(import.meta.url)(join(temp, 'api.cjs'));
});
after(async () => { await rm(temp, { recursive: true, force: true }); });
test('minimal report renders without optional empty sections or browser JS', () => {
  const html = api.renderReport(minimal);
  assert.ok(html.startsWith('<!doctype html><meta charset="utf-8">'));
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('h1').textContent, minimal.title);
  assert.equal(doc.querySelectorAll('section').length, 0);
  assert.equal(doc.querySelectorAll('script,link,iframe,img,[src]').length, 0);
  assert.ok(doc.querySelector('style').textContent.includes('@media print'));
});
test('malformed, missing, unknown and incompatible data fail clearly', () => {
  for (const input of [null, {}, { ...minimal, title: '' }, { ...minimal, schemaVersion: 2 }, { ...minimal, html: '<b>x</b>' }, { ...minimal, sections: [{ title: 'Table', blocks: [{ type: 'table', caption: 'Data', columns: ['A','B'], rows: [['only one']] }] }] }]) assert.throws(() => api.renderReport(input));
});
test('all supplied text is escaped, including closing style/script tags', () => {
  const text = '</style><script>alert(1)</script><img src="https://example.test/x">';
  const doc = new JSDOM(api.renderReport({ ...minimal, title: text, summary: text, sections: [{ title: text, blocks: [{ type: 'paragraph', text }] }] })).window.document;
  assert.equal(doc.querySelector('h1').textContent, text);
  assert.equal(doc.querySelectorAll('script,img').length, 0);
});
test('audit example preserves seven findings and contains no external subresources', async () => {
  const report = JSON.parse(await readFile(join(root, 'reports/examples/project-status-20261028.json'), 'utf8'));
  const doc = new JSDOM(api.renderReport(report)).window.document;
  assert.equal(doc.querySelectorAll('.finding').length, 7);
  assert.ok(doc.body.textContent.includes('dd0316d'));
  assert.ok(doc.body.textContent.includes('8e4a85d'));
  assert.equal(doc.querySelectorAll('script,link,[src]').length, 0);
  assert.doesNotMatch(doc.querySelector('style').textContent, /@import|url\(/);
});
test('generated file connects through production page card and streaming preview response', async () => {
  const file = join(temp, 'artifacts', 'report.html');
  const html = api.renderReport(minimal); await writeFile(file, html);
  const cards = api.linkedCards(`[Report](${pathToFileURL(file).href})`);
  assert.equal(cards.length, 1);
  const card = JSON.parse(cards[0]); assert.equal(card.missing, false);
  assert.equal(api.previewFile(card.src), await realpath(file));
  const response = await api.previewResponse(file, new Request(card.src));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(response.headers.get('content-type'), /text\/html; charset=utf-8/);
  assert.equal(await response.text(), html);
});
test('CLI creates a ready-to-link artifact and refuses accidental overwrite and invalid data', async () => {
  const input = join(temp, 'input.json'), output = join(temp, 'artifacts', 'cli.html');
  await writeFile(input, JSON.stringify(minimal));
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), input, output, ...args], { encoding: 'utf8' });
  let result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /\[A report\]\(file:/);
  assert.equal(run().status, 1);
  assert.equal(run('--force').status, 0);
  const before = await readFile(output, 'utf8');
  await writeFile(input, '{}'); assert.equal(run('--force').status, 1);
  assert.equal(await readFile(output, 'utf8'), before);
});

test('CLI rejects destinations outside artifacts and cannot overwrite a symlink target', async () => {
  const input = join(temp, 'safe-input.json'), target = join(temp, 'target.html'), link = join(temp, 'artifacts', 'link.html');
  await writeFile(input, JSON.stringify(minimal));
  await writeFile(target, 'keep this');
  await symlink(target, link);
  const run = output => spawnSync(process.execPath, [join(root, 'scripts/report.mjs'), input, output, '--force'], { encoding: 'utf8' });
  assert.equal(run(target).status, 1);
  assert.equal(run(link).status, 1);
  assert.equal(await readFile(target, 'utf8'), 'keep this');
});
