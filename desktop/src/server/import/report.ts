// 2.x -> 3.x import report sections (protocol v1 §14.4; M6-03b).
import { PluginRow, type Tier } from "../../protocol/table-rows";
import { ownTableStream } from "../replica/tables";
import type { Db } from "../store";

export interface PluginReportRowEntry {
  name: string;
  row: PluginRow;
}

export interface PluginReportDryRunEntry {
  name: string;
  author: PluginRow["author"];
  ask: Tier;
  granted?: Tier | null;
}

export type PluginReportEntry = PluginReportRowEntry | PluginReportDryRunEntry;

const AUTHOR_WORDS: Record<PluginRow["author"], string> = {
  builtin: "built in",
  user: "added by you",
  bot: "written by a bot",
  import: "from Botling 2",
};

const TIER_RANK: Record<Tier, number> = {
  read: 0,
  request: 1,
  write: 2,
};

function canTierPhrase(tier: Tier): string {
  switch (tier) {
    case "read":
      return "read only";
    case "request":
      return "can send messages";
    case "write":
      return "can change its own data";
  }
}

function askTierPhrase(tier: Tier): string {
  switch (tier) {
    case "read":
      return "read only";
    case "request":
      return "send messages";
    case "write":
      return "change its own data";
  }
}

function normalizeEntry(entry: PluginReportEntry): {
  name: string;
  author: PluginRow["author"];
  ask: Tier;
  granted: Tier;
} {
  if ("row" in entry) {
    const granted = entry.row.grants[entry.row.codeHash]?.tier ?? "read";
    return {
      name: entry.name,
      author: entry.row.author,
      ask: entry.row.manifest.tier,
      granted,
    };
  }
  return {
    name: entry.name,
    author: entry.author,
    ask: entry.ask,
    granted: entry.granted ?? "read",
  };
}

function statusPhrase(author: PluginRow["author"], ask: Tier, granted: Tier): string {
  if (author === "builtin") {
    return canTierPhrase(granted);
  }
  if (TIER_RANK[granted] >= TIER_RANK[ask]) {
    return canTierPhrase(granted);
  }
  return `${canTierPhrase(granted)} now · asks to ${askTierPhrase(ask)} · approve to restore`;
}

/** Reads all live `plugin:<name>` rows from `server.db` for the import report (built-ins first, then by name). */
export function readPluginReportEntries(db: Db, stream = ownTableStream(db)): PluginReportRowEntry[] {
  const rows = db
    .prepare("SELECT key, body FROM rows WHERE stream = ? AND key LIKE 'plugin:%' AND deleted = 0")
    .all(stream) as Array<{ key: string; body: string }>;

  const entries: PluginReportRowEntry[] = [];
  for (const raw of rows) {
    const name = raw.key.slice("plugin:".length);
    const row = PluginRow.parse(JSON.parse(raw.body));
    entries.push({ name, row });
  }

  entries.sort((a, b) => {
    const aBuiltIn = a.row.author === "builtin" ? 0 : 1;
    const bBuiltIn = b.row.author === "builtin" ? 0 : 1;
    if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}

/** Formats the `Plugins` section of the Botling 2 import report (§14.4, M6-03b). */
export function formatPluginsReportSection(entries: readonly PluginReportEntry[]): string {
  if (entries.length === 0) {
    return "Plugins\n  (none)";
  }

  const normalized = entries.map(normalizeEntry);
  const nameWidth = Math.max(16, ...normalized.map((item) => item.name.length + 2));
  const authorWidth = Math.max(16, ...normalized.map((item) => AUTHOR_WORDS[item.author].length + 2));

  const lines = ["Plugins"];
  for (const item of normalized) {
    const authorLabel = AUTHOR_WORDS[item.author];
    const status = statusPhrase(item.author, item.ask, item.granted);
    lines.push(`  ${item.name.padEnd(nameWidth)}${authorLabel.padEnd(authorWidth)}${status}`);
  }
  return lines.join("\n");
}
