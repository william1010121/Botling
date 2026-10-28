// Headless screenshots of every v2 example: doc at 1200 / 390 px in light and dark, plus the first
// slides. Uses a headless shell (no window, no focus change). Usage:
//   node desktop/reports/shots.mjs /abs/out/dir [--browser /path/to/headless_shell]
import { chromium } from 'playwright-core';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadReports, root } from './load.mjs';

async function findBrowser(explicit) {
  if (explicit) return explicit;
  if (process.env.BOTLING_CHROMIUM) return process.env.BOTLING_CHROMIUM;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined; // let Playwright use its own default
  for (const dir of (await readdir(cache)).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    for (const sub of ['chrome-mac/headless_shell', 'chrome-mac-arm64/headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell']) {
      if (existsSync(join(cache, dir, sub))) return join(cache, dir, sub);
    }
  }
  return undefined;
}

const args = process.argv.slice(2);
const out = args[0];
if (!out) throw Error('Usage: node desktop/reports/shots.mjs /abs/out/dir [--browser path]');
const bi = args.indexOf('--browser');
const executablePath = await findBrowser(bi >= 0 ? args[bi + 1] : undefined);

const api = await loadReports();
const exDir = join(root, 'reports/v2/examples');
const htmlDir = join(out, 'html');
await mkdir(htmlDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const summary = [];
try {
  for (const file of (await readdir(exDir)).filter(f => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '');
    const spec = JSON.parse(await readFile(join(exDir, file), 'utf8'));
    for (const mode of ['doc', 'slide']) {
      const r = await api.renderV2(spec, { mode });
      const path = join(htmlDir, `${name}${mode === 'slide' ? '-slides' : ''}.html`);
      await writeFile(path, r.html);
      if (mode === 'doc') {
        for (const [w, scheme] of [[1200, 'dark'], [1200, 'light'], [390, 'dark'], [390, 'light']]) {
          const page = await browser.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
          await page.goto('file://' + path);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          const scripts = await page.evaluate(() => document.scripts.length);
          await page.screenshot({ path: join(out, `${name}-${w}-${scheme}.png`), fullPage: true });
          summary.push({ name, w, scheme, overflow, scripts, errors: r.errors.length, warnings: r.warnings.map(x => x.message) });
          await page.close();
        }
      } else {
        for (const scheme of ['dark', 'light']) {
          const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, colorScheme: scheme });
          await page.goto('file://' + path);
          const frames = await page.locator('.sv').all();
          for (let i = 0; i < Math.min(frames.length, 3); i++) await frames[i].screenshot({ path: join(out, `${name}-slide${i + 1}-${scheme}.png`) });
          if (scheme === 'dark') for (let i = 3; i < frames.length; i++) await frames[i].screenshot({ path: join(out, `${name}-slide${i + 1}-${scheme}.png`) });
          const overflowing = await page.evaluate(() => [...document.querySelectorAll('.sl')].map((s, i) => {
            const ev = s.querySelector('.sev') ?? s; const box = s.getBoundingClientRect(), k = box.width / 1280;
            const blocks = [...ev.querySelectorAll('.blk')];
            if (!blocks.length) return 0;
            const bottom = Math.max(...blocks.map(b => b.getBoundingClientRect().bottom));
            return (bottom - box.top) / k > 720 - 44 ? i + 1 : 0;
          }).filter(Boolean));
          summary.push({ name, mode: 'slides', scheme, slides: frames.length, overflowing });
          await page.close();
        }
      }
    }
  }
} finally { await browser.close(); }
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
