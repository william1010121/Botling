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
  it('starts without a window or focus', () => {
    expect(HEADLESS_ARGS).toEqual(expect.arrayContaining(['--no-first-run', '--disable-gpu']));
  });
});
