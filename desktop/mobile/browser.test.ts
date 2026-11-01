import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM helper shared with isolation-check.mjs
import { findHeadlessBrowser, HEADLESS_ARGS } from './browser.mjs';

const CACHE = '/cache/ms-playwright';
const shell = (n: number) => `${CACHE}/chromium_headless_shell-${n}/chrome-mac/headless_shell`;
const make = (present: string[], dirs: string[]) => ({ exists: (p: string) => present.includes(p), list: () => dirs, cache: CACHE, platform: 'darwin' });

describe('which browser the isolation check may use', () => {
  it('uses BOTLING_CHROMIUM when it exists, and says so when it does not', () => {
    expect(findHeadlessBrowser({ BOTLING_CHROMIUM: '/x/chrome' }, make(['/x/chrome'], []))).toEqual({ path: '/x/chrome' });
    expect(findHeadlessBrowser({ BOTLING_CHROMIUM: '/x/chrome' }, make([], []))).toMatchObject({ error: expect.stringContaining('BOTLING_CHROMIUM') });
  });
  it('takes the newest installed headless shell, never a windowed browser, and reports none instead of waiting', () => {
    const dirs = ['chromium-1248', 'chromium_headless_shell-1194', 'chromium_headless_shell-1201', 'ffmpeg-1011'];
    expect(findHeadlessBrowser({}, make([shell(1194), shell(1201)], dirs))).toEqual({ path: shell(1201) });
    expect(findHeadlessBrowser({}, make([shell(1194)], dirs))).toEqual({ path: shell(1194) });
    const none = findHeadlessBrowser({}, make([], ['chromium-1248']));
    expect(none).toMatchObject({ error: expect.stringContaining('headless') });
  });
  it('finds the new Playwright layout (chrome-headless-shell-<platform>/chrome-headless-shell) on every OS', () => {
    const at = (platform: string, rel: string) => { const p = `${CACHE}/chromium_headless_shell-1248/${rel}`; return findHeadlessBrowser({}, { exists: (x: string) => x === p, list: () => ['chromium_headless_shell-1248'], cache: CACHE, platform, arch: 'arm64' }); };
    expect(at('darwin', 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).toMatchObject({ path: expect.stringContaining('chrome-headless-shell-mac-arm64/chrome-headless-shell') });
    expect(at('darwin', 'chrome-headless-shell-mac-x64/chrome-headless-shell')).toMatchObject({ path: expect.stringContaining('mac-x64') });
    expect(at('linux', 'chrome-headless-shell-linux64/chrome-headless-shell')).toMatchObject({ path: expect.stringContaining('linux64') });
    expect(at('win32', 'chrome-headless-shell-win64/chrome-headless-shell.exe')).toMatchObject({ path: expect.stringContaining('win64') });
    expect(at('darwin', 'chrome-mac-arm64/headless_shell')).toMatchObject({ path: expect.stringContaining('chrome-mac-arm64/headless_shell') });
    expect(at('linux', 'chrome-linux/headless_shell')).toMatchObject({ path: expect.stringContaining('chrome-linux/headless_shell') });
    expect(at('win32', 'chrome-win/chrome-headless-shell.exe')).toMatchObject({ path: expect.stringContaining('chrome-win') });
  });
  it('prefers a newer revision in the new layout over an older one in the old layout', () => {
    const o = `${CACHE}/chromium_headless_shell-1194/chrome-mac/headless_shell`, n = `${CACHE}/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    expect(findHeadlessBrowser({}, { exists: (x: string) => x === o || x === n, list: () => ['chromium_headless_shell-1194', 'chromium_headless_shell-1248'], cache: CACHE, platform: 'darwin', arch: 'arm64' })).toEqual({ path: n });
  });
  it('starts without a window or focus', () => {
    expect(HEADLESS_ARGS).toEqual(expect.arrayContaining(['--no-first-run', '--disable-gpu']));
  });
});
