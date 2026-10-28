#!/usr/bin/env node
// Render a report spec (v1 or v2) to one offline HTML file and print a JSON result line:
//   {"ok", "errors": [{path, message, example?}], "warnings": [{path, message}], "htmlPath", "link", "slides"?}
// Usage:
//   node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report.html [--force] [--slides]
//   node desktop/scripts/report.mjs --check spec.json      validate + lint only, writes nothing
//   node desktop/scripts/report.mjs --docs                 regenerate docs/report-blocks.md + JSON Schema
import { readFile, realpath, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, extname, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReports, root } from '../reports/load.mjs';

const usage = 'Usage: node desktop/scripts/report.mjs input.json /path/.bot/artifacts/report.html [--force] [--slides] | --check input.json | --docs';
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** v2 image blocks may name a file next to the spec; inline it so the HTML stays self-contained. */
async function inlineImages(spec, base) {
  if (spec?.version !== 2 || !Array.isArray(spec.sections)) return;
  for (const sec of spec.sections) for (const b of Array.isArray(sec?.blocks) ? sec.blocks : []) {
    if (b?.type !== 'image' || typeof b.src !== 'string' || /^[a-z]+:/i.test(b.src)) continue;
    const file = resolve(base, b.src), type = mime[extname(file).toLowerCase()];
    if (!type || !(await realpath(file).catch(() => null))?.startsWith(base)) continue;
    b.src = `data:${type};base64,${(await readFile(file)).toString('base64')}`;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const [input, output, ...extra] = args.filter(a => !a.startsWith('--'));
  const known = ['--force', '--slides', '--check', '--docs'];
  if ([...flags].some(f => !known.includes(f)) || extra.length) throw Error(usage);
  const api = await loadReports();
  if (flags.has('--docs')) {
    const doc = join(root, 'docs/report-blocks.md'), schema = join(root, 'reports/v2/report-spec.schema.json');
    await writeFile(doc, api.promptDoc());
    await writeFile(schema, JSON.stringify(api.jsonSchema(), null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, written: [doc, schema] }));
    return;
  }
  if (!input || (!flags.has('--check') && !output)) throw Error(usage);
  const data = JSON.parse(await readFile(resolve(input), 'utf8'));
  await inlineImages(data, await realpath(dirname(resolve(input))));
  const mode = flags.has('--slides') ? 'slide' : 'doc';
  const result = await api.renderAny(data, { mode });
  const report = { ok: result.ok, errors: result.errors, warnings: result.warnings };
  if (flags.has('--check') || !result.html) {
    console.log(JSON.stringify(report));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const destination = resolve(output);
  const parent = await realpath(dirname(destination));
  if (!parent.split(sep).includes('artifacts') || extname(destination).toLowerCase() !== '.html') throw Error('Output must be an .html file inside an existing artifacts folder.');
  // Explicit replacement only; never follow a pre-existing output symlink.
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (flags.has('--force') ? constants.O_TRUNC : constants.O_EXCL), 0o600);
  try { await handle.writeFile(result.html); } finally { await handle.close(); }
  const title = String(data.title).replace(/[[\]\n\r]/g, ' ');
  console.log(JSON.stringify({ ...report, htmlPath: destination, link: `[${title}](${pathToFileURL(destination).href})`, ...(result.slides && mode === 'slide' ? { slides: result.slides } : {}) }));
  if (!result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(`report: ${error.message}`); console.log(JSON.stringify({ ok: false, errors: [{ path: '', message: error.message }], warnings: [] })); process.exitCode = 1; });
