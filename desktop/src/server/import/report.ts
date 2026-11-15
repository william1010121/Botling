// 2.x -> 3.x import report sections (protocol v1 §14.4; M6-03b, M6-01d).
import { PluginRow, type Tier } from "../../protocol/table-rows";
import { ownTableStream } from "../replica/tables";
import type { Db } from "../store";
import type { IdMapRow } from "./id-map";

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

export interface ImportBotReportEntry {
  oldId: string;
  newId: string;
  kind: IdMapRow["kind"];
  name: string;
  clash?: boolean;
  lines: number;
  skipped: number;
  pins: number;
  missingPinLines: number;
  specs: number;
  tasks: number;
  subagents: number;
  subagentSteps: number;
}

export interface ImportReportData {
  dryRun: boolean;
  reportPath: string;
  bots: readonly ImportBotReportEntry[];
  totalLines: number;
  totalSkipped: number;
  totalPins: number;
  totalMissingPinLines: number;
  idMap: readonly IdMapRow[];
  settings: {
    movedPrefs: readonly string[];
    machineKeys: readonly string[];
    layoutKeys: readonly string[];
    oversizedKeys: readonly string[];
  };
  approvals: {
    folders: number;
    movedFolders: number;
    approvedCommandFolders: number;
    movedCommandFolders: number;
    alwaysAllowedCount: number;
  };
  plugins: readonly PluginReportEntry[];
  mediaLines?: readonly string[];
  secretLines?: readonly string[];
  hasSecrets?: boolean;
  problems: readonly string[];
}

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

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function fmtCount(n: number): string {
  return COUNT_FORMAT.format(n);
}

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

function cleanName(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function normalizeEntry(entry: PluginReportEntry): {
  name: string;
  author: PluginRow["author"];
  ask: Tier;
  granted: Tier;
} {
  if ("row" in entry) {
    const granted = (Object.hasOwn(entry.row.grants, entry.row.codeHash) ? entry.row.grants[entry.row.codeHash]?.tier : undefined) ?? "read";
    return {
      name: cleanName(entry.name),
      author: entry.row.author,
      ask: entry.row.manifest.tier,
      granted,
    };
  }
  return {
    name: cleanName(entry.name),
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

export function countUngrantedPlugins(entries: readonly PluginReportEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    const item = normalizeEntry(entry);
    if (item.author !== "builtin" && TIER_RANK[item.granted] < TIER_RANK[item.ask]) {
      count += 1;
    }
  }
  return count;
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

function formatList(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}

/** Formats the full Botling 2 -> Botling 3 import report (M6-01d). */
export function formatImportReport(data: ImportReportData): string {
  const ungranted = countUngrantedPlugins(data.plugins);
  const skippedPart = data.totalSkipped > 0 ? ` (${fmtCount(data.totalSkipped)} skipped)` : "";
  const pluginsPart = ungranted > 0 ? ` (${fmtCount(ungranted)} read only until you approve them)` : "";

  const header = [
    data.dryRun
      ? "Dry run: would import from Botling 2 (read only; nothing was changed)."
      : "Imported from Botling 2 (read only; Botling 2's folder was not changed).",
    `Bots: ${fmtCount(data.bots.length)} · lines: ${fmtCount(data.totalLines)}${skippedPart} · pins: ${fmtCount(data.totalPins)} · plugins: ${fmtCount(data.plugins.length)}${pluginsPart}`,
    data.dryRun ? `Report: ${data.reportPath} (not written: dry run)` : `Report: ${data.reportPath}`,
  ];

  const botsLines = ["Bots"];
  if (data.bots.length === 0) {
    botsLines.push("  (none)");
  } else {
    for (const bot of data.bots) {
      const skippedText = bot.skipped > 0 ? ` (${fmtCount(bot.skipped)} skipped)` : "";
      const missingPinsText = bot.missingPinLines > 0 ? ` (${fmtCount(bot.missingPinLines)} missing line)` : "";
      botsLines.push(
        `  ${bot.name} [${bot.kind}]  lines: ${fmtCount(bot.lines)}${skippedText} · pins: ${fmtCount(bot.pins)}${missingPinsText} · specs: ${fmtCount(bot.specs)} · tasks: ${fmtCount(bot.tasks)} · subagents: ${fmtCount(bot.subagents)} (${fmtCount(bot.subagentSteps)} steps)`,
      );
    }
  }

  const idMapLines = ["ID map"];
  if (data.idMap.length === 0) {
    idMapLines.push("  (none)");
  } else {
    for (const row of data.idMap) {
      const clash = row.clash ? " [clash: re-minted]" : "";
      idMapLines.push(`  ${row.oldId} -> ${row.newId}  (${row.kind}, ${row.name})${clash}`);
    }
  }

  const settingsLines = [
    "Settings",
    `  Cluster preferences moved: ${formatList(data.settings.movedPrefs)}`,
    `  Machine settings kept:     ${formatList(data.settings.machineKeys)}`,
    `  Layout keys left behind:   ${formatList(data.settings.layoutKeys)}`,
  ];
  if (data.settings.oversizedKeys.length > 0) {
    settingsLines.push(`  Oversized preferences dropped: ${formatList(data.settings.oversizedKeys)}`);
  }

  const approvalsLines = [
    "Approvals",
    `  Readable folders: ${fmtCount(data.approvals.folders)} (${fmtCount(data.approvals.movedFolders)} remapped)`,
    `  Approved command folders: ${fmtCount(data.approvals.approvedCommandFolders)} (${fmtCount(data.approvals.movedCommandFolders)} remapped)`,
    `  Always-allowed tool rules: ${fmtCount(data.approvals.alwaysAllowedCount)}`,
  ];

  const pluginsSection = formatPluginsReportSection(data.plugins);

  const mediaLines = data.mediaLines && data.mediaLines.length > 0
    ? ["Media", ...data.mediaLines.map((line) => `  ${line}`)]
    : ["Media", "  not imported yet (M6-05)."];

  const secretLines = data.secretLines && data.secretLines.length > 0
    ? ["Secrets", ...data.secretLines.map((line) => `  ${line}`)]
    : [
      "Secrets",
      "  not imported yet (M6-06).",
      ...(data.hasSecrets ? ["  plugin-secrets.json was not copied (Botling 2 keeps them sealed to its own app)."] : []),
    ];

  const problemLines = ["Problems"];
  if (data.problems.length === 0) {
    problemLines.push("  (none)");
  } else {
    for (const problem of data.problems) {
      problemLines.push(`  - ${problem}`);
    }
  }

  return [
    header.join("\n"),
    botsLines.join("\n"),
    idMapLines.join("\n"),
    settingsLines.join("\n"),
    approvalsLines.join("\n"),
    pluginsSection,
    mediaLines.join("\n"),
    secretLines.join("\n"),
    problemLines.join("\n"),
  ].join("\n\n") + "\n";
}
