// 2026-11-16 (the user's decision): "install once, everything allowed; an update just replaces it". A plugin the user allowed in
// Settings › Plugins (the card that lets its program part run) has been allowed everything its package.json declares, workers
// included: the core's `pluginCapability` answers true for it, so `workers.start` / `workers.send` raise no card per worker.
// The question is the one the program part already answers (`mayRunPluginServerPart`), asked at the row's running hash, so this
// follows whatever model decides that (a grant at the running hash today; the by-name approval of review/v3-plugin-trust-fix).
// Fail closed: no row, a row that does not parse, a throwing reader, an unknown capability: false (L-009).
import type { Db } from "./store";
import { PluginRow, RowKey } from "../protocol/table-rows";
import { readRowBody } from "./replica";
import { mayRunPluginServerPart } from "./botlingd-cluster";

/** What `Core` asks about a plugin: `orchestrate` (may start workers at all) and `installed` (needs no card per worker). */
export type PluginCapabilityName = "orchestrate" | "installed";

export function pluginCapability(reader: () => Db, serverId: string, name: string, capability: PluginCapabilityName): boolean {
  if (capability !== "orchestrate" && capability !== "installed") return false;
  try {
    const key = `plugin:${name}`;
    if (!RowKey.safeParse(key).success) return false;
    const row = PluginRow.safeParse(readRowBody(reader(), `srv:${serverId}`, key));
    if (!row.success) return false;
    return mayRunPluginServerPart(reader, `srv:${serverId}`, name, row.data.codeHash);
  } catch {
    return false;
  }
}
