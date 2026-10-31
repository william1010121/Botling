// Which browser the web isolation check may drive. Only a HEADLESS one: no window opens and nothing takes focus
// (a normal Chrome for Testing would pop a window on macOS). The Playwright build the repo pins may not be installed
// (its cache holds older revisions), so the newest installed headless shell is used; with none, say so and stop.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HEADLESS_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio'];

function cacheDir(platform) {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  return platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : platform === 'win32' ? join(homedir(), 'AppData/Local/ms-playwright') : join(homedir(), '.cache/ms-playwright');
}
const shellName = platform => platform === 'win32' ? 'chrome-headless-shell.exe' : platform === 'darwin' ? 'headless_shell' : 'headless_shell';
const shellDirs = platform => platform === 'darwin' ? ['chrome-mac', 'chrome-mac-arm64'] : platform === 'win32' ? ['chrome-win'] : ['chrome-linux'];

export function findHeadlessBrowser(env = process.env, host = {}) {
  const exists = host.exists ?? existsSync, platform = host.platform ?? process.platform, cache = host.cache ?? cacheDir(platform);
  if (env.BOTLING_CHROMIUM) {
    return exists(env.BOTLING_CHROMIUM) ? { path: env.BOTLING_CHROMIUM } : { error: `BOTLING_CHROMIUM does not exist: ${env.BOTLING_CHROMIUM}` };
  }
  let names = [];
  try { names = host.list ? host.list() : readdirSync(cache); } catch { /* no cache */ }
  const revisions = names.map(n => /^chromium_headless_shell-(\d+)$/.exec(n)).filter(Boolean).map(m => ({ name: m[0], n: Number(m[1]) })).sort((a, b) => b.n - a.n);
  for (const { name } of revisions) {
    for (const dir of shellDirs(platform)) {
      const path = join(cache, name, dir, shellName(platform));
      if (exists(path)) return { path };
    }
  }
  return { error: 'No headless Chromium found (looked for chromium_headless_shell in the Playwright cache). Install one with `npx playwright install --only-shell chromium` or set BOTLING_CHROMIUM. A windowed browser is never used.' };
}
