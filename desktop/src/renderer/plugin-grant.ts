// Botling 3: the desktop window installs a plugin from Settings › Plugins with one tap (the install card). The window sends
// the same `plugin.grant` the CLI sends: no `via` (the user, not a plugin, is the sender), at the hash the window shows
// (`PluginView.asks.codeHash`), with exactly the asks it shows. The owner checks it again where it is applied (a changed
// hash is refused as "changed"). Since 2026-11-16 that one card is the whole decision: an installed plugin is fully allowed,
// a new version of it too, and there are no tiers to pick.
import type { Command, PluginView } from "../contract";

/**
 * Whether the window offers the install card for this plugin: a plugin that is not installed yet (`grant` is "none"), not
 * a built-in, from a server that sends its asks. Once installed it is fully allowed, and so are its new versions (no tiers).
 */
export function canInstall(plugin: PluginView): boolean {
  return !plugin.builtIn && plugin.grant === "none" && plugin.asks !== undefined;
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

/**
 * The one `plugin.grant` the install card sends: at the hash shown, at the tier the plugin asks (the owner refuses more),
 * with exactly the asks shown. Null when the window does not offer the card for this plugin.
 */
export function installCommand(plugin: PluginView): Extract<Command, { type: "plugin.grant" }> | null {
  if (!canInstall(plugin) || !plugin.asks) return null;
  const tier = plugin.asks.tier;
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

/** The plugins that still wait for the user's Allow (the install card). The window badges them and lists them first. */
export function waitingForAllow(plugins: readonly PluginView[] | undefined): PluginView[] {
  return (plugins ?? []).filter(canInstall);
}
