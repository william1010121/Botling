// @vitest-environment jsdom
// Settings → Engines and models: collapsible, saves its choices, and "Apply to all bots" asks first.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { SettingsSheet, BotSettings } from '../../src/renderer/Settings';
import { settingsView } from '../../src/core/settings';
import type { Client } from '../../src/renderer/client';

const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;

it('shows the section, folds it, and saves engine, primary, model and effort changes', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'settings.set') return settingsView({ defaultEngines: ['claude', 'codex'] }); return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({ defaultEngines: ['claude', 'codex'], defaultPrimaryEngine: 'codex' }), bot: null, bots: [{ id: 'B1' } as any], plugins: null, initialSection: 'engines', onClose() {} })));
    expect(host.querySelector('section[aria-label="Engines and models"]')).not.toBeNull();
    expect((host.querySelector('select[aria-label="Primary engine"]') as HTMLSelectElement).value).toBe('codex');
    // The only choices are the enabled engines; Antigravity is off so it cannot be primary.
    expect([...host.querySelectorAll('select[aria-label="Primary engine"] option')].map(o => (o as HTMLOptionElement).value)).toEqual(['', 'claude', 'codex']);
    // One effort control per enabled engine, each with only the levels that engine supports.
    const levels = (label: string) => [...host.querySelectorAll(`select[aria-label="${label}"] option`)].map(o => (o as HTMLOptionElement).value);
    expect(levels('Claude default thinking effort')).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('Codex default thinking effort')).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
    expect(host.querySelector('select[aria-label="Antigravity default thinking effort"]')).toBeNull();
    await click(host.querySelector('input[aria-label="Antigravity"]')!);
    expect(calls.find(c => c.type === 'settings.set')?.change).toEqual({ key: 'defaultEngines', value: ['claude', 'codex', 'agy'] });
    await click(host.querySelector('.settings-fold')!);
    expect(host.querySelector('select[aria-label="Primary engine"]')).toBeNull();
    await click(host.querySelector('.settings-fold')!);
    expect(host.querySelector('select[aria-label="Primary engine"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});

it('asks before applying to all bots, and only then sends the confirmed command', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'engineDefaults.applyAll') return { applied: 3, failed: [] }; return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({}), bot: null, bots: [{ id: 'B1' } as any, { id: 'B2' } as any], plugins: null, initialSection: 'engines', onClose() {} })));
    await click(button(host, 'Apply to all bots…'));
    expect(calls.some(c => c.type === 'engineDefaults.applyAll')).toBe(false);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('all 2 bots');
    await click(button(host, 'Cancel'));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calls.some(c => c.type === 'engineDefaults.applyAll')).toBe(false);
    await click(button(host, 'Apply to all bots…'));
    await click(button(host, 'Overwrite all bots'));
    expect(calls.find(c => c.type === 'engineDefaults.applyAll')).toEqual({ type: 'engineDefaults.applyAll', confirmed: true });
    expect(host.textContent).toContain('Applied to 3 bots.');
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});

it("a bot's own settings can override the primary or follow the app's", async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const view = { botId: 'B1', engines: ['claude', 'codex'], primary: null, primaryEffective: 'codex', model: null, effort: null, efforts: { claude: 'high', codex: null, agy: null }, subagentModel: null, codexModel: null };
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'bot.settings') return view; if (cmd.type === 'bot.configure') return { ...view, primary: cmd.primary }; return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(BotSettings, { client, bot: { id: 'B1', heads: ['claude', 'codex'] } as any })));
    const select = () => host.querySelector('select[aria-label="Primary engine"]') as HTMLSelectElement;
    expect(select().options[0]!.textContent).toBe('Follow app default (Codex)');
    // An effort control for each of the bot's engines, showing the effective value, with that engine's levels.
    expect((host.querySelector('select[aria-label="Claude thinking effort"]') as HTMLSelectElement).value).toBe('high');
    expect([...host.querySelectorAll('select[aria-label="Codex thinking effort"] option')].map(o => (o as HTMLOptionElement).value)).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
    expect(host.querySelector('select[aria-label="Antigravity thinking effort"]')).toBeNull();
    const codexEffort = host.querySelector('select[aria-label="Codex thinking effort"]') as HTMLSelectElement;
    await act(async () => { codexEffort.value = 'low'; codexEffort.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(calls.find(c => c.type === 'bot.configure' && c.efforts)).toMatchObject({ botId: 'B1', efforts: { codex: 'low' } });
    await act(async () => { select().value = 'claude'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(calls.find(c => c.type === 'bot.configure' && c.primary)).toMatchObject({ botId: 'B1', primary: 'claude' });
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
