// Focused hidden Electron check. Disposable storage; optional source is read-only.
// From desktop/: node_modules/.bin/esbuild test/read-image-preview-check.ts --bundle
// --platform=node --format=cjs --packages=external --outfile=test/.read-image-preview-check.cjs
// Then: node test/.read-image-preview-check.cjs (READ_IMAGE_SOURCE / READ_IMAGE_SCREENSHOT optional).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './e2e/launch';
import { swiftLine, tempDir, until } from './helpers';
import { attachmentURL } from '../src/contract/attachment-url';
import { MAIN } from './core-harness';

async function main() {
  // A worker can inherit the installed app's boot receipt and runtime roots.
  for (const key of Object.keys(process.env)) if (key.startsWith('BOTLING_')) delete process.env[key];
  const dir = tempDir('read-image-preview');
  const png = join(dir, '圖 space.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC', 'base64'));
  const jpeg = join(dir, 'photo.jpg');
  const gif = join(dir, 'still.gif');
  writeFileSync(gif, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const source = process.env.READ_IMAGE_SOURCE || png;
  const original = readFileSync(source);
  const gone = join(dir, 'missing.png'), malformed = join(dir, 'invalid.png'), unnamed = join(dir, 'unnamed.png');
  writeFileSync(malformed, 'not an image'); writeFileSync(unnamed, original);
  const steps = [source, png, gone, malformed, jpeg, gif].map((detail, i) => ({ id: `read-${i}`, kind: 'tool', tool: 'Read', title: `Read ${basename(detail)}`, detail, output: '', done: true, failed: false }));
  const dataDir = join(dir, 'data');
  const fixture = [swiftLine({ id: '00000000-0000-4000-8000-0000000000A1', role: 'bot', text: 'Image Read regression fixture', state: 'done', steps })];
  const evidence: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const { app } = await launch({ waitForState: false, dataDir, ...(pass === 0 ? { chat: fixture } : {}) });
    try {
    const jpegBytes = await app.evaluate(({ nativeImage }) => Array.from(nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 255), { width: 4, height: 4 }).toJPEG(90)));
    assert.ok(jpegBytes.length > 0);
    writeFileSync(jpeg, Buffer.from(jpegBytes));
    const page = await until(() => app.context().pages().find(p => p.url() === 'app://botling/index.html'));
    page.setDefaultTimeout(15_000);
    await page.waitForSelector('.shell[data-ready="1"]');
    if (await page.locator('.chat-column.whiteboard-on').count()) await page.locator('.board-switch').getByRole('button', { name: 'Chat', exact: true }).click();
    const chat = await until(() => app.context().pages().find(p => p.url().startsWith('botling-chat://chat/chat.html')));
    chat.setDefaultTimeout(15_000);
      const row = chat.locator('.row.bot[data-id]').last();
      await row.locator('.steps-toggle').click();
      for (const i of [0, 1, 4, 5]) {
        const line = row.locator('.step.tool').nth(i);
        await line.locator('.step-head').click();
        const img = line.locator('img.step-image');
        await img.waitFor();
        await img.evaluate(async (el: HTMLImageElement) => { await el.decode(); });
        const decoded = await img.evaluate((el: HTMLImageElement) => ({ complete: el.complete, width: el.naturalWidth, height: el.naturalHeight, src: el.src }));
        assert.ok(decoded.complete && decoded.width > 0);
        assert.ok(decoded.src.startsWith('botling-chat://chat/attachment/'));
        evidence.push({ pass, image: i, complete: decoded.complete, width: decoded.width, height: decoded.height, route: new URL(decoded.src).protocol + '//' + new URL(decoded.src).host });
        const served = await app.evaluate(async ({ net }, url) => { const r = await net.fetch(url); return Array.from(new Uint8Array(await r.arrayBuffer())); }, decoded.src);
        assert.deepEqual(Buffer.from(served), readFileSync([source, png, gone, malformed, jpeg, gif][i]));
        if (i === 0 && pass === 1) {
          const output = process.env.READ_IMAGE_SCREENSHOT || join(dir, 'preview.png');
          mkdirSync(dirname(output), { recursive: true });
          await line.locator('.step-head').evaluate(el => { if (el.getAttribute('aria-expanded') !== 'true') (el as HTMLElement).click(); });
          await img.waitFor({ state: 'visible' });
          assert.ok((await line.boundingBox())!.height > 100);
          await line.screenshot({ path: output });
          console.log('screenshot', output);
        }
        if (i === 0) {
          await img.click();
          await chat.locator('.lightbox-image').evaluate(async (el: HTMLImageElement) => { await el.decode(); });
          await chat.locator('.lightbox-close').click();
        }
      }
      for (const i of [2, 3]) {
        const line = row.locator('.step.tool').nth(i);
        await line.locator('.step-head').click();
        await line.locator('.step-image-unavailable').waitFor();
        assert.match(await line.innerText(), /Image unavailable:/);
      }
      const statuses = await app.evaluate(async ({ net }, urls) => Promise.all(urls.map(async url => (await net.fetch(url)).status)), [unnamed, '/etc/passwd', gone].map(path => attachmentURL(MAIN, pathToFileURL(path).href)));
      assert.deepEqual(statuses, [404, 404, 404]);

    } finally { await app.close(); }
  }
  assert.deepEqual(readFileSync(source), original);
  console.log(JSON.stringify({ ok: true, reopened: true, bytePreserved: true, evidence }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
