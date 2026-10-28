import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktop, tempDir, swiftLine, until } from '../helpers';
import { writeLibrary } from '../fixtures/components';

// Real shell -> native editor boundary -> Web chat, including pinned and floating cards.
// Every writable path and project belongs to this fixture; no installed profile or agent is used.
test('switching to a long Cute chat keeps native messages, composer and pins on the selected bot', async () => {
  const root = tempDir('avatar-switch'), data = join(root, 'data'), core = join(data, 'core');
  const botling = '11111111-1111-4111-8111-111111111111', hotel = '22222222-2222-4222-8222-222222222222';
  const projects = [{ id: botling, name: 'botling' }, { id: hotel, name: 'hotel' }].map(p => {
    const folder = join(root, p.name); mkdirSync(folder, { recursive: true });
    const dir = join(core, 'projects', p.id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.json'), JSON.stringify({ engine: 'codex' }));
    writeFileSync(join(dir, 'chat.json'), JSON.stringify(Array.from({ length: p.id === botling ? 600 : 1 }, (_, i) => swiftLine({
      id: `${p.id.slice(0,24)}${String(i).padStart(12,'0')}`, role: 'bot', text: `${p.name} message ${i}`, engine: 'codex',
    }))));
    return { ...p, avatar: 'cloud', folder: pathToFileURL(folder).href + '/' };
  });
  writeFileSync(join(core, 'projects.json'), JSON.stringify(projects));
  writeFileSync(join(core, 'settings.json'), JSON.stringify({ botLookChoice: 'cute' }));
  writeLibrary(core, ['status']);
  writeFileSync(join(core, 'projects', botling, 'pins.json'), JSON.stringify([
    { id: '33333333-3333-4333-8333-333333333333', name: 'status', data: '{"ok":true}', status: 'ready', size: '2x1', place: 'dock', refresh: 'manual' },
    { id: '44444444-4444-4444-8444-444444444444', name: 'status', data: '{"ok":true}', status: 'ready', size: '2x1', place: 'float', refresh: 'manual', float: { corner: 'topRight', width: 300, height: 180, collapsed: false } },
  ]));
  const appData = join(root, 'appdata'); mkdirSync(appData);
  const bootstrap = join(root, 'bootstrap.cjs');
  writeFileSync(bootstrap, `require('electron').app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(join(desktop, 'out/main/main.cjs'))});`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BOTLING_DATA_DIR: data, BOTLING_IMPORT_FROM: '', BOTLING_AGENT: 'fake', BOTLING_HIDDEN: '1', BOTLING_NO_EXTERNAL: '1', BOTLING_MOCK_KEYCHAIN: '1', BOTLING_QUIT_ON_CLOSE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: desktop, env });
  try {
    const shell = await until(() => app.context().pages().find(p => p.url() === 'app://botling/index.html'));
    const chat = await until(() => app.context().pages().find(p => p.url().includes('nativeHost=1')));
    const errors: string[] = []; chat.on('pageerror', e => errors.push(e.message));
    await shell.locator('.shell[data-ready="1"]').waitFor();
    expect(await app.evaluate(({ app }) => app.getPath('appData'))).toBe(appData);
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(data, 'electron'));
    for (const name of ['hotel', 'botling', 'hotel', 'botling']) {
      await shell.locator('.bot-row').filter({ hasText: name }).first().click();
      const id = name === 'botling' ? botling : hotel;
      await expect.poll(() => shell.evaluate(() => (window as any).__botlingStore.getView().chat?.botId)).toBe(id);
      await expect(chat.locator('html')).toHaveAttribute('data-chat', id, { timeout: 5000 });
      await expect(chat.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', `Message ${name}…`);
      await expect(chat.locator(`.row[data-id="${id.slice(0,24)}${String(name === 'botling' ? 599 : 0).padStart(12,'0')}"]`)).toContainText(name === 'botling' ? 'botling message 599' : 'hotel message 0');
      if (name === 'botling') {
        const pin = chat.locator('.pin-chip[data-id="33333333-3333-4333-8333-333333333333"]');
        await expect(pin).toBeVisible();
        await pin.click();
        await expect(chat.frameLocator('.pin-sheet iframe.component-frame').locator('#ok')).toHaveText('OK');
        await pin.click();
        await expect.poll(() => chat.locator('img.avatar').evaluateAll(imgs => imgs.length > 0 && imgs.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
      }
    }
    expect(errors).toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible()))).toBe(false);
    await chat.screenshot({ path: join(root, 'native-chat.png') });
    console.log('Native switch evidence:', root);
  } finally { await app.close(); }
});
