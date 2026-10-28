import type { ChatState, MessageView } from '../../../Web/src/types';
import type { ShellMessage } from './chat-frame/protocol';

const PREFIX = 'botling-avatar:';
type StateMessage = Extract<ShellMessage, { botling: 'state' | 'stateDelta' }>;

// Cute avatars contain embedded image bytes. Repeating them in hundreds of rows can exceed
// the authenticated native bridge's 16 MiB budget. Only avatar fields are interned, within
// this packet: no cache lifetime, dropped history, higher IPC limit, or new resource authority.
function mapRows(rows: MessageView[], transform: (source: string) => string): MessageView[] {
  return rows.map(row => typeof row.avatar === 'string' ? { ...row, avatar: transform(row.avatar) } : row);
}
function mapBase<T extends Partial<ChatState>>(state: T, transform: (source: string) => string): T {
  return { ...state,
    ...(typeof state.avatar === 'string' ? { avatar: transform(state.avatar) } : {}),
    ...(state.seenHeads ? { seenHeads: Object.fromEntries(Object.entries(state.seenHeads).map(([k, v]) => [k, transform(v)])) } : {}),
  };
}
function mapMessage(message: StateMessage, transform: (source: string) => string): StateMessage {
  if (message.botling === 'state') return { ...message, state: {
    ...mapBase(message.state, transform), messages: mapRows(message.state.messages, transform),
  } };
  return { ...message, patch: { ...message.patch,
    ...(message.patch.base ? { base: mapBase(message.patch.base, transform) } : {}),
    changed: mapRows(message.patch.changed, transform),
  } };
}

export function packChatAvatars(message: ShellMessage): ShellMessage {
  if (message.botling !== 'state' && message.botling !== 'stateDelta') return message;
  const sources: string[] = [], indexes = new Map<string, number>();
  const packed = mapMessage(message, source => {
    if (!source.startsWith('data:image/') || source.length < 1024) return source;
    let index = indexes.get(source);
    if (index === undefined) { index = sources.length; sources.push(source); indexes.set(source, index); }
    return PREFIX + index;
  });
  return sources.length ? { ...packed, avatarSources: sources } : message;
}

/** Reject broken references before touching chat identity, revision, or rendered content. */
export function unpackChatAvatars(message: StateMessage): StateMessage | null {
  if (message.avatarSources === undefined) return message;
  const sources = message.avatarSources;
  if (!Array.isArray(sources) || !sources.every(source => typeof source === 'string' && source.startsWith('data:image/'))) return null;
  let valid = true;
  const unpacked = mapMessage(message, source => {
    if (!source.startsWith(PREFIX)) return source;
    const index = source.slice(PREFIX.length);
    if (!/^(0|[1-9][0-9]*)$/.test(index) || !Number.isSafeInteger(Number(index)) || Number(index) >= sources.length) {
      valid = false; return source;
    }
    return sources[Number(index)]!;
  });
  return valid ? unpacked : null;
}
