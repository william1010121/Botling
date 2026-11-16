// M5-14c: the local admin ops `plugins.list` and `plugins.grant` (D74 Q-C10: "in 3.0 the window grants with a CLI on that
// machine … a local admin request that sends `plugin.grant` with scope `local`"). The grant is not applied here: it is
// the same `plugin.grant` command a local window sends, received by the intent runtime with scope `local`, so every
// check of M5-14a runs (a tier above the plugin's asks, a built-in's fixed grant, an old hash, `plugin.grant` never
// grantable) and the audit row commits in the same transaction. No `via`: the user, not a plugin, is the sender.
import { randomBytes } from "node:crypto";
import type { Command } from "../contract";
import type { CmdBody, StreamId } from "../protocol";
import { PluginRow, RowKey } from "../protocol/table-rows";
import type { IntentRuntime } from "./intents";
import { carryNoteAt } from "./replica/plugin-grant-carry";
import { readRowBody } from "./replica/tables";
import { grantTierOf } from "./slots/grant-check";
import type { Db } from "./store";

export type GrantTier = "none" | "read" | "request" | "write";

/** One plugin as `botlingd plugins` lists it. */
export interface PluginListRow {
  name: string;
  codeHash: string;
  /** The grant at the row's current codeHash (`none` when there is none). */
  tier: GrantTier;
  /** What the plugin's manifest asks for. */
  asks: Exclude<GrantTier, "none">;
  /** The grant at this hash was carried from an older hash's (the update asked for nothing more). */
  carriedFrom?: string;
  /** The update asked for more than the code granted before: needs Allow again; what grew. */
  grewFrom?: { codeHash: string; grew: string[] };
}

export type PluginGrantAnswer =
  | { ok: true; name: string; codeHash: string; tier: GrantTier }
  | { ok: false; reason: "no-plugin" }
  | { ok: false; reason: "refused"; detail: string };

/** What the list shows: see `grantTierOf` (the tier at the current hash, or "write" for an installed plugin with an older record). */
export function grantTierAt(row: PluginRow): GrantTier {
  return grantTierOf(row);
}

/** The local window's origin (`deviceId` "desktop"); the audit row names it as the member. */
const LOCAL_ORIGIN = "desktop";

export interface PluginAdminOptions {
  runtime: Pick<IntentRuntime, "receive">;
  /** A read connection on server.db (called each time, so a restore's new connection is seen). */
  reader: () => Db;
  serverId: string;
}

export class PluginAdmin {
  constructor(private readonly options: PluginAdminOptions) {}

  private get stream(): StreamId { return `srv:${this.options.serverId}` as StreamId; }

  /** This server's live `plugin:<name>` rows, by name. A malformed row is left out (N4). */
  list(): PluginListRow[] {
    const rows = this.options.reader().prepare("SELECT key, body FROM rows WHERE stream = ? AND deleted = 0 AND substr(key, 1, 7) = 'plugin:' ORDER BY key").all(this.stream);
    const out: PluginListRow[] = [];
    for (const row of rows) {
      let body: unknown;
      try { body = JSON.parse(String(row.body)); } catch { continue; }
      const parsed = PluginRow.safeParse(body);
      if (!parsed.success) continue;
      const name = String(row.key).slice(7);
      const tier = grantTierAt(parsed.data);
      const entry: PluginListRow = { name, codeHash: parsed.data.codeHash, tier, asks: parsed.data.manifest.tier };
      // Truthful only while it still describes the grant: a carried grant later changed by the user is the user's own.
      const note = carryNoteAt(this.options.reader(), name, parsed.data.codeHash);
      if (note && !note.grew && tier !== "none" && Object.hasOwn(parsed.data.grants, parsed.data.codeHash) && parsed.data.grants[parsed.data.codeHash]!.at === note.at) entry.carriedFrom = note.from;
      if (note?.grew && tier === "none") entry.grewFrom = { codeHash: note.from, grew: note.grew };
      out.push(entry);
    }
    return out;
  }

  /** Reads the row as an exact key (`plugin:my` is never `plugin:my.plugin`); null when it is missing or malformed. */
  private row(name: string): PluginRow | null {
    const key = `plugin:${name}`;
    if (!RowKey.safeParse(key).success) return null;
    const parsed = PluginRow.safeParse(readRowBody(this.options.reader(), this.stream, key));
    return parsed.success ? parsed.data : null;
  }

  async grant(name: string, tier: GrantTier): Promise<PluginGrantAnswer> {
    const row = this.row(name);
    if (!row) return { ok: false, reason: "no-plugin" };
    const { codeHash, manifest } = row;
    // The plugin's own asks at its current code. `plugin.grant` is never grantable (D54): leave it out here as the
    // page's sheet does, so a manifest that lists it can still be granted the rest.
    const requests = manifest.requests.filter((item) => item !== "plugin.grant");
    const cmd: Command = { type: "plugin.grant", plugin: name, codeHash, tier, reads: [...manifest.reads], requests: tier === "none" || tier === "read" ? [] : requests };
    // One slot per request: a fresh originEpoch, so this never shares a queue with the window's own slots.
    const body = {
      slot: { origin: LOCAL_ORIGIN, originEpoch: randomBytes(16).toString("hex"), target: this.stream, n: 1 },
      floor: 1,
      inc: this.inc(),
      cmd,
    } as CmdBody;
    let status = await this.options.runtime.receive(body, { scope: "local" });
    // The owner started a new incarnation since the read (a restore): once more with the incarnation it names.
    if (status.status === "retry") status = await this.options.runtime.receive({ ...body, inc: status.message.inc }, { scope: "local" });
    if (status.status !== "result") return { ok: false, reason: "refused", detail: "the command was not decided" };
    const outcome = status.message.outcome;
    if (outcome.kind === "applied") return { ok: true, name, codeHash, tier };
    if (outcome.kind === "refused") return { ok: false, reason: "refused", detail: outcome.detail ?? outcome.reason };
    return { ok: false, reason: "refused", detail: outcome.kind };
  }

  /** The `admin.handle` entry for both ops. */
  async handle(op: { op: "plugins.list" } | { op: "plugins.grant"; plugin: string; tier: GrantTier }): Promise<unknown> {
    if (op.op === "plugins.list") return { plugins: this.list() };
    return this.grant(op.plugin, op.tier);
  }

  private inc(): string {
    const row = this.options.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(this.stream);
    return String(row?.logId ?? "");
  }
}
