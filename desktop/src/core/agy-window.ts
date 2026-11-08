/**
 * agy's context window per conversation. The ACP server reports it in `session/update` `usage_update` as `size`: the
 * model's full window (about 1M tokens), not where agy compacts (earlier, around 290k). Only `size` is kept: `used`
 * is the last call's token delta, and the conversation file already gives the exact context. Nothing is guessed: no
 * event yet (or a size that is not a positive number) means null.
 */
const windows = new Map<string, { size: number; at: number }>();

export function recordAgyWindow(sessionId: string, size: unknown, at = Date.now()) {
  if (!sessionId || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return;
  windows.set(sessionId, { size, at });
  if (windows.size > 256) windows.delete(windows.keys().next().value!);
}

export const agyWindowOf = (sessionId: string): { size: number; at: number } | null => windows.get(sessionId) ?? null;

export const forgetAgyWindows = () => windows.clear();
