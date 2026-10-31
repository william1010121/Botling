// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { detailsFixture } from './task-details-fixture';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((media: string) => ({ media, matches: true, addEventListener() {}, removeEventListener() {} })) as any;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const click = async (selector: string) => { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); };
async function mount() {
  const fixture = detailsFixture(); await fixture.store.resync();
  await act(async () => root.render(<App client={fixture.client} store={fixture.store} web={{ railFooter: null }} />));
  await click('[aria-label="Details"]');
  return fixture;
}
it('narrow Bot settings uses the actual App handler without changing the saved collapsed preference', async () => {
  const fixture = await mount();
  await click('[aria-label="Bot settings"]');
  expect(host.querySelector('.panel-back')).not.toBeNull();
  expect(host.textContent).toContain('Engines in this bot');
  expect(fixture.commands.filter(cmd => cmd.type === 'settings.set')).toEqual([]);
  expect(fixture.savedCollapsed()).toBe(true);
  await click('[aria-label="Back"]');
  await click('[aria-label="Close Details"]');
  expect(host.querySelector<HTMLDivElement>('.task-details-drawer')!.hidden).toBe(true);
  expect(fixture.store.getView().settings?.rightPanelCollapsed).toBe(true);
  console.log('SETTINGS commands:', JSON.stringify(fixture.commands));
});
it('desktop Bot settings still expands the saved collapsed panel through the original App handler', async () => {
  window.matchMedia = ((media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  const fixture = detailsFixture(); await fixture.store.resync();
  await act(async () => root.render(<App client={fixture.client} store={fixture.store} web={{ railFooter: null }} />));
  expect(host.querySelector('.right-strip')).not.toBeNull();
  await click('[aria-label="Bot settings"]');
  expect(fixture.commands).toContainEqual({ type: 'settings.set', change: { key: 'rightPanelCollapsed', value: false } });
  expect(fixture.savedCollapsed()).toBe(false);
  expect(host.textContent).toContain('Engines in this bot');
  expect(host.querySelector('.task-details-drawer')).toBeNull();
});

