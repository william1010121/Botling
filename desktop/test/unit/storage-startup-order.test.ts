import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import * as storage from '../../src/main/storage-startup';
import * as environment from '../../src/main/main-environment';
import { StartupMarks } from '../../src/startup-marks';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { runInNewContext } from 'node:vm';
import { tempDir } from '../helpers';

it('actual main bootstrap refuses legacy storage before renderer lookup, Electron profile setup or startup logging', async () => {
  const root = tempDir('startup-order'), data = path.join(root, 'trial'), bundle = path.join(root, 'Botling 2.app');
  const appRoot = path.join(bundle, 'Contents/Resources/app');
  fs.mkdirSync(path.join(appRoot, 'out/core'), { recursive: true }); fs.mkdirSync(path.join(data, 'core'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ botlingDevTrial: true, botlingStorageContract: { version: 1, epoch: 2 } }));
  fs.writeFileSync(path.join(appRoot, 'out/core/storage-contract.json'), '{"version":1,"epoch":2}');
  fs.writeFileSync(path.join(data, 'core/history.json'), '[{"text":"retained"}]');
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
    './update-state': { dataVolumeError: () => null, persistentDataIdentity: () => undefined, blockingRecovery: () => null },
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
  expect(exitCode).toBe(1);
  expect(profiles).toEqual([]); expect(renderReads).toBe(0);
  expect(fs.readdirSync(data, { recursive: true })).toEqual(before);
  expect(fs.readFileSync(path.join(data, 'core/history.json'), 'utf8')).toBe('[{"text":"retained"}]');
});
