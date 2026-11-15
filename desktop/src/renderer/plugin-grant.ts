// Botling 3: the desktop window approves a plugin from Settings › Plugins (D74 Q-C10's local grant, from the window instead
// of the CLI). The window sends the same `plugin.grant` the CLI and the paired page's sheet send: no `via` (the user, not a
// plugin, is the sender), at the hash the window shows (`PluginView.asks.codeHash`), with exactly the asks it shows. The
// owner checks it again where it is applied (a changed hash is refused as "changed", a tier above the asks as "invalid").
import type { Command, PluginView } from "../contract";

export type WindowGrantTier = "read" | "request" | "write";
const RANK: Record<WindowGrantTier, number> = { read: 1, request: 2, write: 3 };
export const WINDOW_GRANT_TIERS: readonly WindowGrantTier[] = ["read", "request", "write"];

/** Words of the tier choices (the same as the paired page's grant sheet, web-v3/shell/plugins.ts). */
export const WINDOW_GRANT_WORDS: Record<WindowGrantTier, string> = {
  read: "Read only",
  request: "Send what it asks for",
  write: "Change its own data on the server",
};

/** The tiers the window offers: up to what the plugin asks; none for a built-in plugin or without asks. */
export function grantTiersFor(plugin: PluginView): WindowGrantTier[] {
  if (plugin.builtIn || plugin.grant === undefined || !plugin.asks) return [];
  const ask = plugin.asks.tier;
  return WINDOW_GRANT_TIERS.filter((tier) => RANK[tier] <= RANK[ask]);
}

/** `It asks to: …` for the shown hash. Manifest text is the plugin author's: quoted with its own quotes escaped (L-004). */
export function asksLine(asks: NonNullable<PluginView["asks"]>): string {
  const parts = ["read the chat it is shown in", ...asks.reads.map((item) => `read ${JSON.stringify(item)}`)];
  for (const type of asks.requests) {
    if (type === "plugin.grant") continue; // D54: never offered
    parts.push(type === "chat.send" ? "send messages in that chat (chat.send)" : `send ${type}`);
  }
  if (asks.tier === "write") parts.push("change its own data on the server");
  return `It asks to: ${parts.join("; ")}.`;
}

/** The one `plugin.grant` for `tier`, or null when the window does not offer that tier for this plugin. */
export function windowGrantCommand(plugin: PluginView, tier: WindowGrantTier): Extract<Command, { type: "plugin.grant" }> | null {
  if (!grantTiersFor(plugin).includes(tier) || !plugin.asks) return null;
  return {
    type: "plugin.grant",
    plugin: plugin.name,
    codeHash: plugin.asks.codeHash,
    tier,
    reads: [...plugin.asks.reads],
    // `plugin.grant` is never put in a grant's requests (D54); a read grant carries none.
    requests: tier === "read" ? [] : plugin.asks.requests.filter((type) => type !== "plugin.grant"),
  };
}
