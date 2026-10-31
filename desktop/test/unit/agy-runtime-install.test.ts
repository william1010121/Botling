import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers';
import { AgyRuntimeInstaller, verifyArchive, assertLocalDestination } from '../../src/core/agy-runtime-install';

function fixture() {
  const root = tempDir('agy-install'), destination = join(root, '1.4.3');
  const download = vi.fn(async (file: string) => { writeFileSync(file, 'archive'); });
  const extract = vi.fn(async (_file: string, dir: string) => {
    writeFileSync(join(dir, 'agy_acp_server.par'), 'server');
    writeFileSync(join(dir, 'localharness_external'), 'harness');
  });
  const validate = vi.fn();
  const installer = new AgyRuntimeInstaller({ destination, platform: 'darwin', arch: 'arm64', assertLocal: vi.fn(), download, extract, helper: () => Buffer.from('helper'), validate });
  return { root, destination, download, extract, validate, installer };
}
it('publishes the complete trio once, coalesces concurrent installs and reuses valid bytes', async () => {
  const f = fixture();
  const [a,b] = await Promise.all([f.installer.install(f.root), f.installer.install(f.root)]);
  expect(a).toBe(b);
  expect(readFileSync(a, 'utf8')).toBe('server');
  expect(readFileSync(join(f.destination,'botling-agy-file-helper'),'utf8')).toBe('helper');
  expect(f.download).toHaveBeenCalledTimes(1);
  await f.installer.install(f.root);
  expect(f.download).toHaveBeenCalledTimes(1);
});
it('a failed staged validation preserves the previous installation and permits retry', async () => {
  const f = fixture(); mkdirSync(f.destination); writeFileSync(join(f.destination,'agy_acp_server.par'),'old');
  f.validate.mockImplementation(() => { throw Error('signature mismatch'); });
  await expect(f.installer.install(f.root)).rejects.toThrow('signature mismatch');
  expect(readFileSync(join(f.destination,'agy_acp_server.par'),'utf8')).toBe('old');
  f.validate.mockReset();
  await f.installer.install(f.root);
});
it('download failures do not publish partial runtimes', async () => {
  const f = fixture(); f.download.mockRejectedValueOnce(Error('offline'));
  await expect(f.installer.install(f.root)).rejects.toThrow('offline');
  expect(existsSync(f.destination)).toBe(false);
  await f.installer.install(f.root);
});
it('rejects modified archives, unsupported hosts and external destinations before download', async () => {
  expect(() => verifyArchive(Buffer.from('tampered'))).toThrow('hash mismatch');
  const linkRoot = tempDir('agy-install-link'), link = join(linkRoot, 'link');
  symlinkSync(linkRoot, link);
  expect(() => assertLocalDestination(link)).toThrow('local');
  const download = vi.fn();
  await expect(new AgyRuntimeInstaller({platform:'linux',download}).install('/tmp')).rejects.toThrow('macOS arm64');
  expect(download).not.toHaveBeenCalled();
});
it('keeps install locks and invalid helper packaging from starting a download', async () => {
  const f = fixture(); mkdirSync(f.destination + '.install-lock');
  await expect(f.installer.install(f.root)).rejects.toThrow('Another Antigravity installation');
  expect(f.download).not.toHaveBeenCalled();
  const download = vi.fn();
  await expect(new AgyRuntimeInstaller({destination:join(f.root,'other'),platform:'darwin',arch:'arm64',assertLocal:()=>{},download,helper:()=>{throw Error('helper hash mismatch');}}).install(f.root)).rejects.toThrow('helper hash mismatch');
  expect(download).not.toHaveBeenCalled();
});
// Opt-in archived official fixture; never runs the runtime, signs in, or touches user settings.
it.skipIf(!process.env.BOTLING_TEST_AGY_ARCHIVE)('installs the real pinned archive and packaged helper, then rejects tampered download bytes', async () => {
  const archive = readFileSync(process.env.BOTLING_TEST_AGY_ARCHIVE!);
  const root = tempDir('agy-official-install');
  const destination = join(root,'runtime','1.4.3'), workspace = join(root,'workspace'); mkdirSync(workspace);
  const fetcher = vi.fn(async () => new Response(archive)); vi.stubGlobal('fetch',fetcher);
  try {
    const installer = new AgyRuntimeInstaller({destination,assertLocal:()=>{},helper:()=>Buffer.from(readFileSync(join(process.cwd(),'out/core/agy-file-helper.base64'),'utf8'),'base64')});
    const path = await installer.install(workspace);
    expect(path).toBe(join(destination,'agy_acp_server.par'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await installer.install(workspace);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => new Response('corrupt'));
    await expect(new AgyRuntimeInstaller({destination:join(root,'bad'),assertLocal:()=>{},helper:()=>Buffer.from(readFileSync(join(process.cwd(),'out/core/agy-file-helper.base64'),'utf8'),'base64')}).install(workspace)).rejects.toThrow('hash mismatch');
    expect(existsSync(join(root,'bad'))).toBe(false);
  } finally { vi.unstubAllGlobals(); }
},30000);
