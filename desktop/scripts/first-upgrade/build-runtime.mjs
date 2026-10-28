// Focused standalone bridge bundle, not an app/package build. Never invoked by CLI.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [sourceArg, revision, outputArg, ...extra] = process.argv.slice(2);
if (!sourceArg || !/^[a-f0-9]{40}$/.test(revision || '') || !outputArg || extra.length) throw new Error('Usage: build-runtime.mjs REVIEWED_SOURCE FULL_COMMIT OUTPUT.mjs');
const source = resolve(sourceArg), output = resolve(outputArg);
const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=no', '--', 'desktop/src', 'desktop/scripts/release-manifest.mjs'])) throw new Error('Runtime source must be pinned and clean');
const require = createRequire(join(source, 'desktop/package.json'));
const { build } = require('esbuild');
await mkdir(dirname(output), { recursive: true });
const input = [
  'export { authenticateLocalBuild } from "./desktop/src/main/hot-auth.ts";',
  'export { openApp } from "./desktop/src/main/hot-install.ts";',
  'export { VerifiedInstaller, resumeMaintenance } from "./desktop/src/main/update-install.ts";',
  'export * from "./desktop/src/main/update-maintenance.ts";',
  'export { durableJSON } from "./desktop/src/main/hot-transaction.ts";',
  'export { checkStorageStartup, authorizeStorageStartup } from "./desktop/src/main/storage-startup.ts";',
  'export { UPDATE_RECORDS } from "./desktop/src/main/update-state.ts";',
].join('\n');
await build({ stdin: { contents: input, resolveDir: source, sourcefile: 'reviewed-offline-runtime.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent', metafile: true }).then(result => {
  for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) if (!dependency.path.startsWith('node:') && !['fs', 'path', 'crypto', 'stream', 'util', 'child_process', 'os'].includes(dependency.path)) throw new Error('Runtime has an unbundled dependency; review before use');
});
console.log(JSON.stringify({ revision, runtimePath: output, runtimeSha256: createHash('sha256').update(await readFile(output)).digest('hex') }));
