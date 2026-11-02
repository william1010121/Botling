// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SidebarSettings } from '../../src/renderer/SidebarSettings';
import { observeEditorLayout } from '../../src/renderer/editor-surface';
import { editorBridge } from '../../src/preload/editor-bridge';
import { EDITOR_CHANNEL } from '../../src/editor-host-wire';
import { settingsView } from '../../src/core/settings';
import type { Client } from '../../src/renderer/client';
import type { PluginsView } from '../../src/contract';
const usagePlugin = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  settingsSections: [{ plugin: 'botling.usage', id: 'botling.usage.settings', title: 'Usage', terms: '', after: 'engines', link: 'Usage by bot' }],
  quickSettings: [{ plugin: 'botling.usage', id: 'botling.usage.quota', title: 'Subscription usage' }] } as PluginsView;
let host: HTMLDivElement, root: Root, stop: () => void;
const stamp = { surfaceId: 'surface', documentGeneration: 'document' };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); stop?.(); host.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});
async function mount() {
  const callbacks = new Map<string, Function>(), send = vi.fn();
  const bridge = editorBridge({ on: (channel, fn) => callbacks.set(channel, fn), send }, 'shell');
  callbacks.get(EDITOR_CHANNEL.bound)!({}, stamp);
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ x: 200, y: 60, width: 600, height: 600 } as DOMRect);
  stop = observeEditorLayout(host, bridge, () => true);
  const off = vi.fn(), onOpen = vi.fn();
  // A plugin block whose frame never loads (its page request never settles) must not hold any controls or focus hostage.
  const request = vi.fn((cmd: any) => cmd.type === 'plugins.panel' ? new Promise(() => {}) : Promise.resolve(settingsView({ developerMode: true })));
  const client = { request, onEvent: () => off } as unknown as Client;
  await act(async () => root.render(createElement(SidebarSettings, {
    client, settings: settingsView({}), plugins: usagePlugin, settingsOpen: false, onOpen,
  })));
  const gear = host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!;
  await act(async () => gear.click());
  return { gear, send, request, off, onOpen };
}
it('opens and focuses the shell with an unresolved plugin block, sends immediate native reveal, and restores on Escape', async () => {
  const ui = await mount();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close quick settings');
  expect(ui.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout, { stamp, bounds: { x: 200, y: 60, width: 600, height: 600 }, occluded: true, revealImmediately: true });
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(ui.gear);
  expect(ui.send.mock.calls.at(-1)?.[1].occluded).toBeUndefined();
});
it('keeps developer controls and navigation usable while the usage block is pending', async () => {
  const ui = await mount();
  await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  expect(ui.request).toHaveBeenCalledWith({ type: 'settings.set', change: { key: 'developerMode', value: true } });
  expect(host.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
  for (const [label, section] of [['Plugins', 'plugins'], ['Usage by bot', 'botling.usage/botling.usage.settings'], ['Developer settings…', 'developer'], ['All settings…', undefined]] as const) {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith(label))!;
    await act(async () => button.click());
    expect(ui.onOpen).toHaveBeenLastCalledWith(section);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => ui.gear.click());
  }
});
it('closes by button and outside click, and reopens without waiting for old requests', async () => {
  const ui = await mount();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close quick settings"]')!.click());
  expect(document.activeElement).toBe(ui.gear);
  await act(async () => ui.gear.click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
