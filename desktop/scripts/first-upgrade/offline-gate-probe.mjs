// Read-only source input; only synthetic temp directories are mutated.
// This probes the real startup API, not a production maintenance adapter.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const source = resolve(process.argv[2] || 'MISSING_SOURCE');
const revision = 'f91e790a0e35764afb14ed135a9c00a9b0b2aa52';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), revision);
const tracked = ['desktop/src/main/storage-startup.ts', 'desktop/src/main/hot-transaction.ts', 'desktop/src/storage-contract.ts'];
assert.equal(execFileSync('git', ['diff', 'HEAD', '--', ...tracked], { cwd: source, encoding: 'utf8' }), '');
const require = createRequire(join(source, 'desktop/package.json'));
const { build } = require('esbuild');
const root = fs.mkdtempSync(join(tmpdir(), 'botling-offline-gate-'));
try {
  const output = join(root, 'gate.cjs');
  await build({ entryPoints: [join(source, tracked[0])], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { checkStorageStartup } = require(output);
  const dataDir = join(root, 'profile');
  fs.mkdirSync(join(dataDir, 'core'), { recursive: true });
  fs.writeFileSync(join(dataDir, 'core/history'), 'untouched');
  const options = { dataDir, target: join(root, 'Botling 2.app'), version: '2.0.0', packageContract: { version: 1, epoch: 2 }, coreContract: { version: 1, epoch: 2 }, argv: [], fs };
  assert.throws(() => checkStorageStartup(options), /snapshot-protected/);
  assert.equal(fs.readFileSync(join(dataDir, 'core/history'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(dataDir), ['core']);
  // A proposed maintenance marker cannot extend the existing gate's contract.
  fs.writeFileSync(join(dataDir, 'maintenance-pending.json'), JSON.stringify({ state: 'exclusive-offline' }));
  fs.writeFileSync(join(dataDir, 'installed-storage-contract.json'), JSON.stringify({ version: 1, epoch: 2 }));
  assert.deepEqual(checkStorageStartup(options), { version: 1, epoch: 2 });
  console.log(JSON.stringify({ revision, passed: 2, observations: [
    'Unknown-epoch first hop refused without profile mutation',
    'Compatible epoch passes despite synthetic maintenance marker: storage gate is not a maintenance exclusion gate'
  ], liveAppAccess: false, liveProfileAccess: false, transactionExecuted: false }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
