// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { settingsView } from '../../src/core/settings';
import type { BotView } from '../../src/contract';
import type { Client } from '../../src/renderer/client';
import { WorkspaceStore, type WorkspaceView } from '../../src/renderer/store';

it('updates the actual chat header to the selected bot engines, including single Antigravity and all three', async () => {
  const bot: BotView = { id: 'B', name: 'Project', role: 'manager', avatar: 'square', folder: '/w', phase: 'awake', working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ['codex'], job: null, subagentRows: [] };
  const defaults = new WorkspaceStore(async () => { throw Error('Unexpected snapshot'); }).getView();
  let view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), chat: { botId: bot.id, messages: [], running: null, live: [], tasks: [] } };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  const store = { getView: () => view, getChatView: () => view, subscribe, subscribeChat: subscribe } as unknown as WorkspaceStore;
  const client = { request: vi.fn(async () => ({ specs: [] })), onEvent: () => () => {} } as unknown as Client;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement(App, { client, store })));
    for (const [heads, text] of [
      [['codex'], 'Codex'], [['agy'], 'Antigravity'], [['claude'], 'Claude'],
      [['claude', 'codex', 'agy'], 'Claude & Codex & Antigravity'],
    ] as [BotView['heads'], string][]) {
      await act(async () => { view = { ...view, bots: [{ ...bot, heads }] }; listeners.forEach(fn => fn()); });
      const label = host.querySelector('.chat-header .chat-heads');
      expect(label?.textContent).toBe(text);
      expect(label?.getAttribute('data-heads')).toBe(heads.join(' '));
    }
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
