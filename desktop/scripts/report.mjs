#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, extname, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const [input, output, option, ...extra] = process.argv.slice(2);
  if (!input || !output || (option && option !== '--force') || extra.length) throw Error('Usage: node desktop/scripts/report.mjs input.json /path/.bot/artifacts/report.html [--force]');
  const destination = resolve(output);
  const parent = await realpath(dirname(destination));
  if (!parent.split(sep).includes('artifacts') || extname(destination).toLowerCase() !== '.html') throw Error('Output must be an .html file inside an existing artifacts folder.');
  const data = JSON.parse(await readFile(resolve(input), 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'botling-report-'));
  try {
    // Bundle only this generator; no app build, server, CDN or runtime assets.
    const bundle = join(temp, 'render.cjs');
    await build({ entryPoints: [join(root, 'reports/render.tsx')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const { renderReport } = createRequire(import.meta.url)(bundle);
    const html = renderReport(data);
    // Explicit replacement only; never follow a pre-existing output symlink.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
      | (option === '--force' ? constants.O_TRUNC : constants.O_EXCL);
    const handle = await open(destination, flags, 0o600);
    try { await handle.writeFile(html); } finally { await handle.close(); }
    console.log(`[${data.title.replace(/[\[\]\n\r]/g, ' ')}](${pathToFileURL(destination).href})`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(`report: ${error.message}`); process.exitCode = 1; });
