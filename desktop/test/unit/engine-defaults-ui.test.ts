// @vitest-environment jsdom
// Settings → Models & workers: one engine's head × workers table at a time, new bots' engines and primary, the folded
// "bots with their own settings" line with "Apply to all bots" (which asks first), and a bot's panel marking its own choices.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { SettingsSheet, BotSettings } from '../../src/renderer/Settings';
import { settingsView } from '../../src/core/settings';
import type { Client } from '../../src/renderer/client';

const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;
const radios = (host: HTMLElement, label: string) => [...host.querySelectorAll(`[role="radiogroup"][aria-label="${label}"] button`)].map(b => b.textContent);

it('shows one engine at a time and saves engine, primary, model and effort changes', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'settings.set') return settingsView({ defaultEngines: ['claude', 'codex'] }); if (cmd.type === 'agy.runtime.check') return { valid: true }; return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({ defaultEngines: ['claude', 'codex'], defaultPrimaryEngine: 'codex' }), bot: null, bots: [{ id: 'B1' } as any], plugins: null, initialSection: 'models', onClose() {} })));
    expect(host.querySelector('section[aria-label="New bots"]')).not.toBeNull();
    expect((host.querySelector('select[aria-label="Primary engine"]') as HTMLSelectElement).value).toBe('codex');
    // The only choices are the enabled engines; Antigravity is off so it cannot be primary.
    expect([...host.querySelectorAll('select[aria-label="Primary engine"] option')].map(o => (o as HTMLOptionElement).value)).toEqual(['', 'claude', 'codex']);
    // Only the chosen engine's table, with only the levels that engine supports; workers say "subagents" once.
    expect(radios(host, 'Claude head effort')).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect(host.querySelector('[aria-label="Codex head effort"]')).toBeNull();
    expect(host.textContent).toContain('Claude calls them subagents');
    await click(button(host, 'High'));
    expect(calls.find(c => c.type === 'settings.set')?.change).toEqual({ key: 'defaultEffort', value: { engine: 'claude', effort: 'high' } });
    await click([...host.querySelectorAll('[role="tab"]')].find(t => t.textContent?.startsWith('Codex'))!);
    expect(radios(host, 'Codex head effort')).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high']);
    expect(host.querySelector('[aria-label="Claude head effort"]')).toBeNull();
    // Antigravity is not in new bots: its tab says so, and turning it on saves the engines.
    expect([...host.querySelectorAll('[role="tab"]')].find(t => t.textContent?.startsWith('Antigravity'))!.textContent).toContain('not in new bots');
    await click(host.querySelector('input[aria-label="Antigravity"]')!);
    expect(calls.filter(c => c.type === 'settings.set').at(-1)?.change).toEqual({ key: 'defaultEngines', value: ['claude', 'codex', 'agy'] });
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});

it('asks before applying to all bots, and only then sends the confirmed command', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'engineDefaults.applyAll') return { applied: 3, failed: [] }; return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({}), bot: null, bots: [{ id: 'B1' } as any, { id: 'B2' } as any], plugins: null, initialSection: 'models', onClose() {} })));
    // Folded until asked for.
    expect(button(host, 'Apply to all bots…')).toBeUndefined();
    await click(host.querySelector('.mw-own-toggle')!);
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

it('lists the bots with their own settings, and "Use defaults" puts one back on the app defaults', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const plain = { botId: 'B1', engines: ['claude'], primary: null, primaryEffective: 'claude', model: null, effort: null, efforts: { claude: null, codex: null, agy: null }, subagentModel: null, codexModel: null };
  const own = { ...plain, botId: 'B2', model: 'opus', subagentModel: 'sonnet' };
  const opened: string[] = [];
  const client = { request: async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === 'bot.settings') return cmd.botId === 'B2' ? own : plain;
    if (cmd.type === 'bot.configure') return { ...own, model: null, subagentModel: null };
    return { models: [], status: 'error', source: '', message: 'x' };
  } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({}), bot: null, bots: [{ id: 'B1', name: 'Plain' } as any, { id: 'B2', name: 'Picky' } as any], plugins: null, initialSection: 'models', onOpenBot: (id: string) => opened.push(id), onClose() {} })));
    expect(host.querySelector('.mw-own-toggle')!.textContent).toContain('1 bot uses its own settings');
    await click(host.querySelector('.mw-own-toggle')!);
    const row = host.querySelector('.mw-own-row')!;
    expect(row.textContent).toContain('Picky');
    expect(row.textContent).not.toContain('Plain');
    await click([...row.querySelectorAll('button')].find(b => b.textContent === 'Open')!);
    expect(opened).toEqual(['B2']);
    await click([...row.querySelectorAll('button')].find(b => b.textContent === 'Use defaults')!);
    expect(calls.find(c => c.type === 'bot.configure')).toMatchObject({ botId: 'B2', model: null, subagentModel: null, primary: null });
    expect(host.querySelector('.mw-own-row')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});

it("a bot's panel marks its own choices against the app defaults and can override the primary", async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: any[] = [];
  const view = { botId: 'B1', engines: ['claude', 'codex'], primary: null, primaryEffective: 'codex', model: null, effort: null, efforts: { claude: 'high', codex: null, agy: null }, subagentModel: null, codexModel: null };
  const client = { request: async (cmd: any) => { calls.push(cmd); if (cmd.type === 'bot.settings') return view; if (cmd.type === 'bot.configure') return { ...view, primary: cmd.primary ?? null }; return { models: [], status: 'error', source: '', message: 'x' }; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(BotSettings, { client, bot: { id: 'B1', heads: ['claude', 'codex'] } as any, settings: settingsView({ defaultEngines: ['claude', 'codex'] }) })));
    const select = () => host.querySelector('select[aria-label="Primary engine"]') as HTMLSelectElement;
    expect(select().options[0]!.textContent).toBe('Follow app default (Codex)');
    // Claude's effort is the bot's own (High against the app's default); Codex follows the app.
    const claudeEffort = host.querySelector('select[aria-label="Claude head effort"]') as HTMLSelectElement;
    expect(claudeEffort.value).toBe('high');
    expect(claudeEffort.closest('.settings-row')!.className).toContain('own');
    expect(claudeEffort.closest('.settings-row')!.textContent).toContain('Own · app default');
    expect(host.querySelector('button[aria-label="Claude: use app defaults"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Codex: use app defaults"]')).toBeNull();
    expect([...host.querySelectorAll('select[aria-label="Codex head effort"] option')].map(o => (o as HTMLOptionElement).value)).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
    expect(host.querySelector('select[aria-label="Antigravity head effort"]')).toBeNull();
    const codexEffort = host.querySelector('select[aria-label="Codex head effort"]') as HTMLSelectElement;
    await act(async () => { codexEffort.value = 'low'; codexEffort.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(calls.find(c => c.type === 'bot.configure' && c.efforts)).toMatchObject({ botId: 'B1', efforts: { codex: 'low' } });
    await act(async () => { select().value = 'claude'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(calls.find(c => c.type === 'bot.configure' && c.primary)).toMatchObject({ botId: 'B1', primary: 'claude' });
    await click(host.querySelector('button[aria-label="Claude: use app defaults"]')!);
    expect(calls.filter(c => c.type === 'bot.configure').at(-1)).toMatchObject({ botId: 'B1', efforts: { claude: null } });
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
