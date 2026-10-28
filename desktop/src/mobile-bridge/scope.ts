/** The owner's verified Google browser session sees every bot the desktop app lists (the core
 * resolves the list on each request). Bearer clients never get it: their client file must name
 * explicit bot ids (bridge.ts `Client`). `*` can never be a real bot id (contract `BotId`). */
export const ALL_BOTS = '*';
export const botAllowed = (allowed: readonly string[], botId: string) => allowed.includes(ALL_BOTS) || allowed.includes(botId);
