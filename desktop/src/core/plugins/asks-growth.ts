// What a new version of a plugin asks for that the old one did not (the "asks more" rule of a plugin update). One function for
// the two places that decide it: the core before a one-click update (plugin-store.ts: asks more -> the install card) and the
// server's grant carry (server/replica/plugin-grant-carry.ts: asks more -> no grant at the new hash). Pure: no files, no clock.
//
// Counted as more (any one): a 2.x permission (`ccb.permissions`) the old code did not list; a program part (`ccb.host`) or a bot
// tools folder (`ccb.claude`) the old code did not have. Not more: version, description, views, commands, menus, settings, the web
// bundle and styles (the same list as plugin-grant-carry.ts).

/** What a plugin's package.json says about the power it asks for. */
export interface AskFacts {
  /** `ccb.permissions`. */
  permissions: readonly string[];
  /** The parts that run code or give bots tools: "host" (`ccb.host`), "claude" (`ccb.claude`). */
  parts: readonly string[];
}

/** The facts of one manifest (the shape `PluginManifest` has: `ccb.permissions`, `ccb.host`, `ccb.claude`). */
export function askFactsOf(manifest: { ccb?: { permissions?: readonly string[]; host?: string; claude?: string } }): { permissions: string[]; parts: string[] } {
  const ccb = manifest.ccb;
  return {
    permissions: [...new Set(ccb?.permissions ?? [])].map((item) => String(item).slice(0, 40)).slice(0, 20).sort(),
    parts: [...(ccb?.host ? ["host"] : []), ...(ccb?.claude ? ["claude"] : [])],
  };
}

/** A name from a manifest as one short, safe line (plain, or quoted with its control characters escaped). */
export const askItem = (text: string): string => (/^[A-Za-z0-9._-]{1,60}$/.test(text) ? text : JSON.stringify(text.slice(0, 60)));

/** What `after` asks for that `before` did not: `permission <name>` and `part <host|claude>`, in the order of `after` (empty: nothing more). */
export function askGrowth(before: AskFacts, after: AskFacts): string[] {
  const grew: string[] = [];
  for (const permission of after.permissions) if (!before.permissions.includes(permission)) grew.push(`permission ${askItem(permission)}`);
  for (const part of after.parts) if (!before.parts.includes(part)) grew.push(`part ${part}`);
  return grew;
}
