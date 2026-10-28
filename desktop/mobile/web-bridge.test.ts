import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../src/contract';
import { Client, RequestFailed } from '../src/renderer/client';
import { WorkspaceStore } from '../src/renderer/store';
import { MobileError } from './transport';
import { WebBridge, type CommandTransport } from './web-bridge';

const snapshot = (seq: number, botId = 'main') => ({ epoch: 'e', seq, imported: null, components: {}, waiting: { items: [], doing: {} }, teams: [],
  settings: { effectiveLanguage: 'en', botLook: 'cute', rightPanelCollapsed: false, railCollapsed: false, pinnedBots: [] },
  bots: ['main', 'maintainer', 'project'].map(id => ({ id, name: id, role: id === 'main' ? 'main' : 'manager' })),
  chat: { botId, messages: [], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [] } });
function setup(extra: Partial<ConstructorParameters<typeof WebBridge>[0]> = {}) {
  let seq = 1;
  const calls: any[] = [];
  const transport: CommandTransport = { request: vi.fn(async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === 'chat.snapshot') return snapshot(seq, cmd.botId);
    return { messageId: 'm', turnId: null };
  }) };
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  const bridge = new WebBridge({ transport, storage, ...extra });
  const client = new Client(bridge);
  return { bridge, client, calls, storage: store, bump: () => { seq++; } };
}

describe('WebBridge (the renderer bridge over the mobile bridge)', () => {
  it('carries the four mobile commands to the server and answers in the renderer protocol', async () => {
    const onMutated = vi.fn();
    const { client, calls } = setup({ onMutated });
    const view = await client.request({ type: 'chat.snapshot', botId: 'project' });
    expect(view.bots.map(bot => bot.id)).toEqual(['main', 'maintainer', 'project']);
    expect(view.chat?.botId).toBe('project');
    await client.request({ type: 'chat.send', botId: 'project', text: 'hello', to: 'codex' });
    await client.request({ type: 'chat.choose', botId: 'main', messageId: 'q', index: 0 });
    await client.request({ type: 'chat.answer', botId: 'main', messageId: 'q', text: 'yes' });
    expect(calls.map(cmd => cmd.type)).toEqual(['chat.snapshot', 'chat.send', 'chat.choose', 'chat.answer']);
    expect(calls[1]).toEqual({ type: 'chat.send', botId: 'project', text: 'hello', to: 'codex' });
    expect(onMutated).toHaveBeenCalledTimes(3);
  });

  it('refuses every other desktop command without contacting the server', async () => {
    const { client, calls } = setup();
    for (const cmd of [{ type: 'bots.remove', botId: 'project' }, { type: 'settings.set', change: { key: 'botLook', value: 'original' } },
      { type: 'plugins.web' }, { type: 'turn.stop', botId: 'main', turnId: 't' }, { type: 'files.pick', botId: 'main' }, { type: 'link.open', botId: 'main', url: 'file:///etc/passwd', source: 'user' }] as any[]) {
      await expect(client.request(cmd)).rejects.toSatisfy((error: unknown) => error instanceof RequestFailed && error.error.code === 'forbidden');
    }
    expect(calls).toEqual([]);
  });

  it('keeps layout settings in this browser and opens only http(s) links', async () => {
    const openURL = vi.fn(), onLocalChange = vi.fn();
    const { client, calls, storage } = setup({ openURL, onLocalChange });
    await client.request({ type: 'chat.snapshot' });
    await client.request({ type: 'settings.set', change: { key: 'railCollapsed', value: true } });
    await client.request({ type: 'settings.set', change: { key: 'pinnedBots', value: ['project'] } });
    await Promise.resolve();
    expect(onLocalChange).toHaveBeenCalled();
    const again = await client.request({ type: 'chat.snapshot' });
    expect(again.settings).toMatchObject({ railCollapsed: true, pinnedBots: ['project'] });
    expect(calls.filter(cmd => cmd.type === 'settings.set')).toEqual([]);
    expect(calls.filter(cmd => cmd.type === 'chat.snapshot')).toHaveLength(1); // The second came from the primed read.
    expect(JSON.parse(storage.get('botling-web-layout')!)).toEqual({ railCollapsed: true, pinnedBots: ['project'] });
    await client.request({ type: 'chat.read', botId: 'main' });
    await client.request({ type: 'link.open', botId: 'main', url: 'https://example.com/a', source: 'user' });
    expect(openURL).toHaveBeenCalledWith('https://example.com/a');
    expect(calls).toHaveLength(1);
  });

  it('poll reports a change only when epoch or seq moved, and the store resyncs from that read', async () => {
    const { bridge, client, calls, bump } = setup();
    const store = new WorkspaceStore(botId => client.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) }));
    await store.resync();
    expect(store.getView().bots).toHaveLength(3);
    expect(await bridge.poll('main')).toBe(false);
    bump();
    expect(await bridge.poll('main')).toBe(true);
    const before = calls.length;
    await store.resync();
    expect(calls.length).toBe(before);
    expect(await bridge.poll('main')).toBe(false);
  });

  it('a lost session signs out; a cancelled request drops its late answer', async () => {
    const onAuthLost = vi.fn();
    let release!: () => void;
    const transport: CommandTransport = { request: vi.fn(async (cmd: any) => {
      if (cmd.type === 'chat.send') { await new Promise<void>(resolve => { release = resolve; }); return { messageId: 'late', turnId: null }; }
      throw new MobileError('expired', true);
    }) };
    const bridge = new WebBridge({ transport, onAuthLost });
    const client = new Client(bridge);
    await expect(client.request({ type: 'chat.snapshot' })).rejects.toBeInstanceOf(RequestFailed);
    expect(onAuthLost).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const sent = client.request({ type: 'chat.send', botId: 'main', text: 'x' }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(sent).rejects.toSatisfy((error: unknown) => error instanceof RequestFailed && error.error.code === 'cancelled');
    const heard: unknown[] = []; bridge.subscribe(message => heard.push(message));
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(heard).toEqual([]);
    expect(PROTOCOL_VERSION).toBe(10);
  });
});
