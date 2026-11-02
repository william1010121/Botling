// What a terminal frame may ask of this plugin's program part (the one exposed method "terminal"), and what it hears back (the
// "terminal" push). Strict: a request with a field not listed here (a folder, a command) is no request at all.
import { z } from 'zod';
const identity = { botId: z.string().min(1).max(128), sessionId: z.string().uuid() };
export const TerminalRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('open'), botId: identity.botId, shell: z.string().max(4096).optional() }),
  z.strictObject({ type: z.literal('shells') }),
  /** The terminal font (Meslo, for Powerlevel10k glyphs): its bytes, base64. A frame has no files of its own. */
  z.strictObject({ type: z.literal('font') }),
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
/** What a frame gets back from a request. */
export type TerminalAnswer = TerminalState | TerminalState[] | { shells: string[]; defaultShell: string } | { font: string } | null;
/** How the frame talks to the program part: requests, and the pushed events of its bot. */
export interface TerminalBridge {
  request(request: TerminalRequest): Promise<TerminalAnswer>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
}
