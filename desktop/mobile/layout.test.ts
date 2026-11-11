import { describe, expect, it } from 'vitest';
import { PHONE_QUERY, phoneLayout, phoneWidth } from './layout';
import { WebBridge } from './web-bridge';

describe('phone layout', () => {
  it('a phone never gets the folded column; a wide screen keeps the setting', () => {
    expect(phoneLayout({ railCollapsed: true, pinnedBots: ['a'] }, true)).toEqual({ railCollapsed: false, pinnedBots: ['a'] });
    expect(phoneLayout({ railCollapsed: true }, false)).toEqual({ railCollapsed: true });
    expect(phoneLayout({ railCollapsed: false }, true)).toEqual({ railCollapsed: false });
  });
  it('asks the phone-width media query, and is wide where it cannot ask', () => {
    const asked: string[] = [];
    expect(phoneWidth(query => { asked.push(query); return { matches: true }; })).toBe(true);
    expect(asked).toEqual([PHONE_QUERY]);
    expect(phoneWidth(undefined)).toBe(false);
    expect(phoneWidth(() => { throw new Error('no'); })).toBe(false);
  });
  it('the web bridge gives the renderer the open column on a phone, even when the desktop or this browser folded it', async () => {
    let narrow = true;
    const snapshot = { epoch: 'e', seq: 1, settings: { railCollapsed: true, rightPanelCollapsed: false }, bots: [], chat: null };
    const storage = { getItem: () => JSON.stringify({ railCollapsed: true }), setItem: () => {} };
    const bridge = new WebBridge({ transport: { request: async () => snapshot }, storage, narrow: () => narrow });
    const read = () => new Promise<any>(resolve => {
      const off = bridge.subscribe((message: any) => { if (message.id === 'r') { off(); resolve(message.result); } });
      bridge.post({ v: 10, id: 'r', cmd: { type: 'chat.snapshot' } });
    });
    expect((await read()).settings.railCollapsed).toBe(false);
    narrow = false;
    expect((await read()).settings.railCollapsed).toBe(true);
  });
});
