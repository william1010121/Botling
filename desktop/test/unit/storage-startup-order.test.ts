import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import * as storage from '../../src/main/storage-startup';
import { blockingRecovery } from '../../src/main/update-state';
import * as environment from '../../src/main/main-environment';
import { StartupMarks } from '../../src/startup-marks';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { runInNewContext } from 'node:vm';
import { tempDir } from '../helpers';

it.each(['refuse', 'recovery', 'maintenance'] as const)('actual main bootstrap %s uses no real profile or renderer before storage authorization', async mode => {
  const root = tempDir('startup-order'), data = path.join(root, 'trial'), bundle = path.join(root, 'Botling 2.app');
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  fs.mkdirSync(path.join(appRoot, 'out/core'), { recursive: true }); fs.mkdirSync(path.join(data, 'core'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ botlingDevTrial: true, botlingStorageContract: { version: 1, epoch: 2 } }));
  fs.writeFileSync(path.join(appRoot, 'out/core/storage-contract.json'), '{"version":1,"epoch":2}');
  fs.writeFileSync(path.join(data, 'core/history.json'), '[{"text":"retained"}]');
  if (mode === 'maintenance') {
    fs.writeFileSync(path.join(data, 'installed-storage-contract.json'), '{"version":1,"epoch":2}');
    fs.writeFileSync(path.join(data, 'update-maintenance.json'), '{"phase":"maintenance"}');
  }
  if (mode === 'recovery') {
    const transaction = fs.mkdtempSync(path.join(root, '.botling-update-'));
    fs.mkdirSync(path.join(transaction, 'previous.app'));
    fs.mkdirSync(path.join(transaction, 'data-before'));
    fs.writeFileSync(path.join(transaction, 'owner.json'), JSON.stringify({ target: bundle, dataDir: data, token: 'test' }));
    fs.writeFileSync(path.join(transaction, 'snapshot.complete'), 'complete');
    fs.writeFileSync(path.join(transaction, 'result'), 'failed:15');
    fs.writeFileSync(path.join(data, 'installed-storage-contract.json'), '{"version":1,"epoch":1}');
    expect(blockingRecovery(data, bundle)).toMatchObject({ code: 15, blocked: true });
  }
  const before = fs.readdirSync(data, { recursive: true });
  const profiles: string[] = []; let renderReads = 0, exitCode: number | undefined, marks: StartupMarks | undefined;
  const STOP = new Error('stop before app initialization');
  const native = { ...fs, writeSync: () => 0 };
  const fakeApp = { isPackaged: true, getPath: () => path.join(root, 'Application Support'), getVersion: () => '2.0.1',
    setPath: (_key: string, value: string) => { profiles.push(value); fs.mkdirSync(value, { recursive: true }); }, commandLine: { appendSwitch() {} } };
  const modules: Record<string, unknown> = {
    electron: { app: fakeApp }, 'node:fs': native, 'original-fs': native, 'node:path': path, 'node:os': os, 'node:url': url,
    './storage-startup': storage, './main-environment': environment,
    './hidden-mode': { configureHiddenApp() {} }, './packaged': { scrubEnvironment: () => [] },
    '../core/component-shot': { isRequested: () => false },
    './renderer-loading': { rendererFiles: () => { renderReads++; return { directory: appRoot, development: false }; }, preloadFiles: () => ({ directory: appRoot }) },
    './update-state': { dataVolumeError: () => null, persistentDataIdentity: () => undefined, blockingRecovery },
    './input-trace': { syntheticTraceContext: () => null },
    '../startup-marks': { StartupMarks: class extends StartupMarks { constructor(options: any) { super(options); marks = this; } } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/main.ts'), 'utf8');
  const prefix = source.slice(0, source.indexOf('const APP_ORIGIN'));
  const script = transpileModule(prefix, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  try {
    runInNewContext(script, { exports: {}, require: (id: string) => modules[id] ?? {}, __dirname: path.join(appRoot, 'out/main'), __filename: path.join(appRoot, 'out/main/main.cjs'), console,
      process: { argv: ['Botling'], env: { BOTLING_DATA_DIR: data }, execPath: path.join(bundle, 'Contents/MacOS/Botling 2'), exit: (code: number) => { exitCode = code; throw STOP; } } });
  } catch (error) { if (error !== STOP) throw error; }
  await marks?.flush();
  expect(exitCode).toBe(mode === 'recovery' ? undefined : 1);
  if (mode !== 'recovery') expect(profiles).toEqual([]);
  else { expect(profiles).toHaveLength(4); expect(profiles.every(p => p.includes('botling-recovery-ui-') && !p.startsWith(data))).toBe(true); }
  expect(renderReads).toBe(0);
  expect(fs.readdirSync(data, { recursive: true })).toEqual(before);
  expect(fs.readFileSync(path.join(data, 'core/history.json'), 'utf8')).toBe('[{"text":"retained"}]');
});
