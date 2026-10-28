import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConfiguredMobile } from './start';
import { startBridge } from './bridge';
vi.mock('./bridge', async original => ({ ...await original<typeof import('./bridge')>(), startBridge: vi.fn(() => ({ close: vi.fn() })) }));
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'mobile-startup-')); dirs.push(d); return d; };
const core = () => ({ mobileCommand: vi.fn(), shutdown: vi.fn(async () => {}) });
function config(root: string) {
  const dir = join(root, 'mobile'); mkdirSync(dir, { mode: 0o700 });
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  // startBridge is mocked: these tests cover discovery, not TLS validity or sockets.
  writeFileSync(cert, 'fixture'); writeFileSync(key, 'fixture');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ origin: 'https://botling-bridge.driseam.com', host: '127.0.0.1', port: 8443,
    certFile: cert, keyFile: key, clientsFile: join(dir, 'clients.json'), assets: dir }), { mode: 0o600 });
  return file;
}
beforeEach(() => { vi.stubEnv('BOTLING_MOBILE_CONFIG', undefined); vi.stubEnv('BOTLING_CORE_PROBE', undefined); vi.mocked(startBridge).mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('profile-local mobile opt-in', () => {
  it('leaves an absent configuration disabled without creating profile files', () => {
    const root = temp(); expect(startConfiguredMobile(core(), root, vi.fn())).toBeNull();
    expect(existsSync(join(root, 'mobile'))).toBe(false); expect(startBridge).not.toHaveBeenCalled();
  });
  it('rediscovers on restart but never exports or carries the selected profile into another', () => {
    const a = temp(), b = temp(); config(a);
    startConfiguredMobile(core(), a, vi.fn()); startConfiguredMobile(core(), a, vi.fn());
    expect(startBridge).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startBridge).mock.calls[0]![0]).toMatchObject({ origin: 'https://botling-bridge.driseam.com', host: '127.0.0.1', port: 8443 });
    expect(process.env.BOTLING_MOBILE_CONFIG).toBeUndefined();
    expect(startConfiguredMobile(core(), b, vi.fn())).toBeNull(); expect(startBridge).toHaveBeenCalledTimes(2);
  });
  it('keeps explicit env override precedence, even when the profile default is malformed', () => {
    const a = temp(), b = temp(); writeFileSync(config(a), 'bad json'); const override = config(b);
    vi.stubEnv('BOTLING_MOBILE_CONFIG', override); startConfiguredMobile(core(), a, vi.fn());
    expect(vi.mocked(startBridge).mock.calls[0]![0].assets).toBe(join(b, 'mobile'));
  });
  it('preserves explicit empty env as disabled despite an available default', () => {
    const root = temp(); config(root); vi.stubEnv('BOTLING_MOBILE_CONFIG', '');
    expect(startConfiguredMobile(core(), root, vi.fn())).toBeNull(); expect(startBridge).not.toHaveBeenCalled();
  });
  it('fails closed for a missing explicit override, without falling back', () => {
    const root = temp(); config(root); vi.stubEnv('BOTLING_MOBILE_CONFIG', join(root, 'missing.json'));
    expect(() => startConfiguredMobile(core(), root, vi.fn())).toThrow(); expect(startBridge).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'file-mode', 'directory-mode', 'file-link', 'directory-link'])('fails closed for %s default config', kind => {
    const root = temp(), file = config(root);
    if (kind === 'malformed') writeFileSync(file, 'not JSON');
    if (kind === 'file-mode') chmodSync(file, 0o644);
    if (kind === 'directory-mode') chmodSync(join(root, 'mobile'), 0o755);
    if (kind === 'file-link') { rmSync(file); symlinkSync(config(temp()), file); }
    if (kind === 'directory-link') { rmSync(join(root, 'mobile'), { recursive: true }); const other = temp(); config(other); symlinkSync(join(other, 'mobile'), join(root, 'mobile')); }
    expect(() => startConfiguredMobile(core(), root, vi.fn())).toThrow(); expect(startBridge).not.toHaveBeenCalled();
  });
  it('probe ignores even a malformed default before reading it', () => {
    const root = temp(); writeFileSync(config(root), 'not JSON'); vi.stubEnv('BOTLING_CORE_PROBE', '1');
    expect(startConfiguredMobile(core(), root, vi.fn())).toBeNull(); expect(startBridge).not.toHaveBeenCalled();
  });
});
