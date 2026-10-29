import { z } from 'zod';
const identity = { botId: z.string().min(1).max(128), sessionId: z.string().uuid() };
export const TerminalRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('open'), botId: identity.botId, shell: z.string().max(4096).optional() }),
  z.strictObject({ type: z.literal('shells') }),
  z.strictObject({ type: z.literal('list'), botId: identity.botId }),
  z.strictObject({ type: z.literal('close'), ...identity }),
  z.strictObject({ type: z.literal('attach'), ...identity }),
  z.strictObject({ type: z.literal('ack'), ...identity, offset: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('input'), ...identity, data: z.string().max(65536), binary: z.boolean().optional() }),
  z.strictObject({ type: z.literal('resize'), ...identity, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) }),
  z.strictObject({ type: z.literal('restart'), ...identity, shell: z.string().max(4096).optional() }),
]);
export type TerminalRequest = z.infer<typeof TerminalRequest>;
export interface TerminalState { botId: string; sessionId: string; shell: string; output: string; offset: number; exitCode: number | null }
export type TerminalEvent = { type: 'data'; botId: string; sessionId: string; data: string; offset: number } | { type: 'exit'; botId: string; sessionId: string; exitCode: number };
export interface TerminalBridge {
  request(request: TerminalRequest): Promise<TerminalState | TerminalState[] | { shells: string[]; defaultShell: string } | null>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
  onToggle(listener: () => void): () => void;
}
