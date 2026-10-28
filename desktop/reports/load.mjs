// Bundle reports/render.tsx (React + Zod + d3 + elkjs) into one temporary CommonJS module and load it.
// Shared by the CLI, tests, screenshot and showcase scripts; nothing is left on disk afterwards.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadReports() {
  const temp = await mkdtemp(join(tmpdir(), 'botling-report-'));
  try {
    const bundle = join(temp, 'render.cjs');
    await build({ entryPoints: [join(root, 'reports/render.tsx')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } });
    return createRequire(import.meta.url)(bundle);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
