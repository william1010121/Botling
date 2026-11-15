// The page's plugin list and grant sheet, as data (M5-14b; protocol v1 §11.7, D54). Pure TypeScript, no DOM: Shell.tsx
// draws it. The rows are the `plugin:<name>` rows of each server's `srv:` table as the page holds them (fe-link/tables.ts);
// one user act sends one `plugin.grant` per server that holds the shown code hash, never with `via` (a plugin frame can
// never send it, D54: the shell owns this sheet).
import type { Command } from "../../src/contract";
import { PluginRow } from "../../src/protocol/table-rows";

/** What the sheet reads from: the servers this page knows and each one's rows. */
export interface PluginSource {
  servers(): ReadonlyArray<{ id: string; name: string }>;
  /** The server's `srv:` table rows by key; null when this page has no copy of that table. */
  rows(serverId: string): ReadonlyMap<string, unknown> | null;
}

/** The slice of the front-end link the source reads (a peer's table copy; fe-link/link.ts `table`, `servers`). */
interface TableLink {
  servers(): ReadonlyArray<{ id: string; name: string }>;
  table(serverId: string): { rows: ReadonlyMap<string, unknown> } | null;
}

/**
 * The rows provider for the real page: `link.table(id)`, which holds peers' tables only.
 * TODO(M5-14e): the attached server's own `srv:<id>` table is not delivered to the page as rows (fe-link/link.ts drops
 * it from the table cache on welcome; server/session/session-core.ts serves `rows` only for peer tables), so its row
 * set is null here and its plugins are missing until M5-14e gives the page a read path for it. On one machine the list
 * is empty until then.
 */
export function linkPluginSource(link: TableLink): PluginSource {
  return {
    servers: () => link.servers(),
    rows: (serverId) => link.table(serverId)?.rows ?? null,
  };
}

export type GrantTier = "read" | "request" | "write";
const RANK: Record<GrantTier, number> = { read: 1, request: 2, write: 3 };
const TIERS: GrantTier[] = ["read", "request", "write"];

/** Words of the sheet's options (exact, user-approved). */
export const TIER_OPTION_WORDS: Record<GrantTier, string> = {
  read: "Read only",
  request: "Send what it asks for",
  write: "Change its own data on the server",
};
/** Words of the list line (exact for `read` and `write`; `request` and nothing yet follow their style). */
const TIER_LIST_WORDS: Record<GrantTier | "none", string> = {
  read: "read only",
  request: "can send what it asks for",
  write: "can change its own data",
  none: "nothing yet",
};
const AUTHOR_WORDS: Record<PluginRow["author"], string> = {
  builtin: "built in",
  user: "added by you",
  bot: "written by a bot",
  import: "from Botling 2",
};

export const DIFFERENT_VERSION = "a different version (cannot be allowed together)";
export const ONLY_MANAGE = "Only a device allowed to manage can change this.";

interface Held {
  serverId: string;
  serverName: string;
  row: PluginRow;
}

function currentTier(row: PluginRow): GrantTier | null { return row.grants[row.codeHash]?.tier ?? null; }
function isBuiltinGrant(row: PluginRow): boolean { return row.grants[row.codeHash]?.grantedBy === "builtin"; }

/** Every valid row of one plugin, in the source's server order. Rows that are not a plugin row are ignored (N4). */
function heldBy(source: PluginSource, name: string): { held: Held[]; unread: string[] } {
  const held: Held[] = [];
  const unread: string[] = [];
  for (const server of source.servers()) {
    const rows = source.rows(server.id);
    if (!rows) { unread.push(server.name); continue; }
    const parsed = PluginRow.safeParse(rows.get(`plugin:${name}`));
    if (parsed.success) held.push({ serverId: server.id, serverName: server.name, row: parsed.data });
  }
  return { held, unread };
}

export interface PluginListItem {
  name: string;
  authorWords: string;
  /** The lowest grant across the servers, at each one's current hash. */
  tierWords: string;
  /** Every server's grant at its current hash is the built-in one: nothing to review (3.0). */
  builtIn: boolean;
}

/** The list under "This device › Plugins": one line per plugin name, in name order. */
export function listPlugins(source: PluginSource): PluginListItem[] {
  const names = new Set<string>();
  for (const server of source.servers()) {
    for (const key of source.rows(server.id)?.keys() ?? []) if (key.startsWith("plugin:")) names.add(key.slice("plugin:".length));
  }
  const items: PluginListItem[] = [];
  for (const name of [...names].sort()) {
    const { held } = heldBy(source, name);
    if (held.length === 0) continue;
    const tiers = held.map((h) => currentTier(h.row));
    const lowest = tiers.some((t) => t === null) ? "none" : tiers.reduce((a, b) => (RANK[a!] <= RANK[b!] ? a : b))!;
    items.push({
      name,
      authorWords: AUTHOR_WORDS[held[0]!.row.author],
      tierWords: TIER_LIST_WORDS[lowest],
      builtIn: held.every((h) => isBuiltinGrant(h.row)),
    });
  }
  return items;
}

export interface SheetModel {
  name: string;
  /** `<name> (on <machines>)`: the machines the grant is sent to. */
  title: string;
  /** `It asks to: …`. */
  askLine: string;
  /** Tiers up to the plugin's ask, lowest first. Empty for a built-in plugin. */
  options: Array<{ tier: GrantTier; words: string }>;
  /** The tier ticked when the sheet opens: the grant all machines already have; never a higher one; null: none ticked. */
  selected: GrantTier | null;
  builtIn: boolean;
  /** The code hash being granted. */
  codeHash: string;
  /** The machines that get one `plugin.grant` each. */
  targets: Held[];
  /** `<machine>: a different version (cannot be allowed together)` per machine whose hash is not the shown one. */
  differing: string[];
  /** Servers this page has no rows for (M5-14e): not asked, not sent to. */
  unreadServers: string[];
}

function askLine(row: PluginRow): string {
  const parts = ["read the chat it is shown in", ...row.manifest.reads.map((item) => `read ${item}`)];
  for (const type of row.manifest.requests) {
    if (type === "plugin.grant") continue; // D54: never offered as a request
    parts.push(type === "chat.send" ? "send messages in that chat (chat.send)" : `use ${type}`);
  }
  if (row.manifest.tier === "write") parts.push("change its own data on the server");
  return `It asks to: ${parts.join("; ")}.`;
}

/**
 * The sheet for one plugin. The shown hash is the one most servers hold (the first server's on a tie); servers with
 * another hash are listed and left out, so one act never grants code the user was not shown (§11.7).
 */
export function pluginSheet(source: PluginSource, name: string): SheetModel | null {
  const { held, unread } = heldBy(source, name);
  if (held.length === 0) return null;
  const counts = new Map<string, number>();
  for (const h of held) counts.set(h.row.codeHash, (counts.get(h.row.codeHash) ?? 0) + 1);
  const shown = [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const same = held.filter((h) => h.row.codeHash === shown);
  // 3.0: a built-in grant is not changed from here (the owner refuses it); those machines are not sent to.
  const targets = same.filter((h) => !isBuiltinGrant(h.row));
  const reference = (targets[0] ?? same[0]!).row;
  const builtIn = targets.length === 0;
  const options = builtIn ? [] : TIERS.filter((tier) => RANK[tier] <= RANK[reference.manifest.tier]).map((tier) => ({ tier, words: TIER_OPTION_WORDS[tier] }));
  const tiers = new Set(targets.map((h) => currentTier(h.row)));
  const only = tiers.size === 1 ? [...tiers][0]! : null;
  const selected = only !== null && options.some((o) => o.tier === only) ? only : null;
  return {
    name,
    title: `${name} (on ${(targets.length > 0 ? targets : same).map((h) => h.serverName).join(", ")})`,
    askLine: askLine(reference),
    options,
    selected,
    builtIn,
    codeHash: shown,
    targets,
    differing: held.filter((h) => h.row.codeHash !== shown).map((h) => `${h.serverName}: ${DIFFERENT_VERSION}`),
    unreadServers: unread,
  };
}

/** One `plugin.grant` per target server, sent as that server's own item and never with `via` (D54). */
export function grantCommands(sheet: SheetModel, tier: GrantTier): Array<{ target: `srv:${string}`; cmd: Extract<Command, { type: "plugin.grant" }> }> {
  if (!sheet.options.some((option) => option.tier === tier)) throw new Error(`plugins: ${tier} is not offered for ${sheet.name}`);
  return sheet.targets.map((h) => ({
    target: `srv:${h.serverId}` as const,
    cmd: {
      type: "plugin.grant" as const,
      plugin: sheet.name,
      codeHash: sheet.codeHash,
      tier,
      reads: [...h.row.manifest.reads],
      // `plugin.grant` is never put in a grant's requests (D54, M5-14a F3); a read grant carries none.
      requests: tier === "read" ? [] : h.row.manifest.requests.filter((type) => type !== "plugin.grant"),
    },
  }));
}
