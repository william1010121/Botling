import { describe, expect, it } from 'vitest';
import { packChatAvatars, unpackChatAvatars } from '../../src/renderer/chat-avatar-wire';
import { editorMessageAllowed } from '../../src/editor-host-wire';
import { chatState } from '../../src/renderer/payload';
import type { BotView } from '../../src/contract';
import type { ShellMessage } from '../../src/renderer/chat-frame/protocol';

const avatar = 'data:image/png;base64,' + 'A'.repeat(34_000);
const bot: BotView = { id: 'B', name: 'botling', role: 'manager', avatar: 'cloud', folder: '/fixture', phase: 'asleep', working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ['codex'], job: null, subagentRows: [] };
function full(): Extract<ShellMessage, { botling: 'state' }> {
  const { state, extras } = chatState(bot, { botId: 'B', running: null, live: [], tasks: [], messages: Array.from({ length: 600 }, (_, i) => ({ id: String(i), role: 'bot', text: 'message ' + i, time: '2026-10-28T00:00:00Z' })) });
  return { botling: 'state', state: { ...state, avatar, seenHeads: { X: avatar }, messages: state.messages.map(m => ({ ...m, avatar })) }, extras, revision: 8 };
}
describe('native avatar transport', () => {
  it('delivers an over-budget Cute history without dropping content or relaxing the boundary', () => {
    const message = full();
    expect(editorMessageAllowed('down', message)).toBe(false);
    const packed = packChatAvatars(message) as typeof message;
    expect(editorMessageAllowed('down', packed)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(1_000_000);
    expect(unpackChatAvatars(packed)).toEqual({ ...message, avatarSources: packed.avatarSources });
    expect(message.state.messages[0].avatar).toBe(avatar);
  });
  it('restores delta avatars independently of earlier packets and leaves text and cards intact', () => {
    const message = full(), { messages, components, ...base } = message.state;
    const delta: Extract<ShellMessage, { botling: 'stateDelta' }> = { botling: 'stateDelta', botID: 'B', baseRevision: 8, revision: 9, extras: message.extras,
      patch: { order: messages.map(m => m.id), changed: messages, base, components } };
    delta.patch.changed[0] = { ...messages[0], text: 'botling-avatar:0' };
    const packed = packChatAvatars(delta) as typeof delta;
    expect(editorMessageAllowed('down', packed)).toBe(true);
    expect(unpackChatAvatars(packed)).toEqual({ ...delta, avatarSources: packed.avatarSources });
    expect(unpackChatAvatars(message)).toBe(message);
  });
  it('refuses invalid avatar references before applying state', () => {
    const packed = packChatAvatars(full()) as ReturnType<typeof full>;
    packed.state.messages[0].avatar = 'botling-avatar:999';
    expect(unpackChatAvatars(packed)).toBeNull();
    packed.avatarSources = ['https://example.invalid/avatar'];
    expect(unpackChatAvatars(packed)).toBeNull();
  });
});
