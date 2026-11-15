// Botling 3 wire protocol v1: the rows of a `srv:<serverId>` table stream (protocol-v1.md §8.2, §7.3 `rows`) and the
// `rows` message that carries them (§10.2 "batch … rows[]", M3).
//
// M3 brief Q1: servers replicate the `rows` table only (bot summaries, `machine`, `settings`, `audit:*`) with `rev`
// catch-up; the M1/M2 entry stream of `srv:` stays the local window's feed and is never sent to peers.
//
// A row is `{key, rev, body}` or a tombstone `{key, rev, deleted: true}` (kept 30 days). `rev` is the owner's table
// counter at the row's last change, so a catch-up is every row with `rev > after`, sorted by `rev`, read in one
// transaction: the reader's table then equals the owner's at `to`. The §8.2 limits (≤ 5 waiting items, ≤ 3 lines of
// ≤ 140 characters, a small row) are enforced here, so an over-size summary is refused as malformed.
import { z } from "zod";
import { BotId, type CommandType, Engine } from "../contract";
import { canonicalJson } from "./entries";
import { ContentId, EntryHash, Id, LogId, Seq, ServerId } from "./ids";
import { SubTag } from "./messages";
import { COMMAND_SCOPES } from "./scopes";

/** At most this many waiting items in a bot's summary (§8.2, §20). */
export const SUMMARY_WAITING_LIMIT = 5;
/** At most this many short lines in a bot's summary, each at most `SUMMARY_LINE_CHARS` (§8.2, §20). */
export const SUMMARY_LINES_LIMIT = 3;
export const SUMMARY_LINE_CHARS = 140;
/** The most a summary row's canonical JSON may be (v1 plans 0.5–1 KB; this leaves room, never a page of text). */
export const SUMMARY_ROW_CHARS = 3 * 1024;
/** The most a `machine`, `settings`, `audit:` or `plugin:` row's canonical JSON may be. */
export const TABLE_ROW_CHARS = 32 * 1024;
/** At most this many rows in one `rows` frame (as a catch-up page of entries, §20). */
export const ROWS_LIMIT = 500;
/** A bot's summary is rewritten at most once per this many ms, at once on a `status` or `waiting` change (§8.2). */
export const SUMMARY_WRITE_INTERVAL_MS = 2_000;
/** Tombstones are kept this long, then purged (§8.2). */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const fitsIn = (limit: number) => (value: unknown) => {
  try { return canonicalJson(value).length <= limit; } catch { return false; }
};

/** A table stream: `srv:<serverId>`. */
export const TableStreamId = z.string().max(80).regex(/^srv:[A-Za-z0-9_.:-]{1,64}$/);

/**
 * A row key: `bot:<botId>`, `machine`, `settings`, `audit:<id>` (§8.2), `plugin:<name>` (D52, M5), or a kind this
 * version does not know yet: `<kind>` or `<kind>:<id>`, kind in lower case. Plan change N4: readers keep and pass on
 * rows of a kind they do not know, and ignore them; they never refuse or drop them, so servers of different versions
 * can share one cluster.
 */
export const RowKey = z.string().max(100).regex(/^[a-z][a-z0-9_-]{0,31}(:[A-Za-z0-9_.:-]{1,64})?$/);
export type RowKey = z.infer<typeof RowKey>;

/** What a bot is doing, as its summary says (§8.2). */
export const SummaryStatus = z.enum(["idle", "running", "waiting", "error", "stopped"]);
export type SummaryStatus = z.infer<typeof SummaryStatus>;

/** A waiting item: a card the user can answer from the list without opening the bot (`card.answer{cardId, cardRev}`). */
export const SummaryWaiting = z.strictObject({ cardId: Id, cardRev: z.number().int().nonnegative(), kind: z.string().min(1).max(40), title: z.string().max(200) });

/** `bot:<botId>` — a bot's summary (§8.2). Only names, never folder paths; no message bodies beyond three short lines. */
export const SummaryRow = z.strictObject({
  name: z.string().min(1).max(200),
  /** The settled avatar shape and colour; null before one is settled. */
  face: z.strictObject({ avatar: z.string().max(40), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).nullable(),
  role: z.enum(["main", "manager", "bot"]),
  parent: BotId.nullable(),
  /** The project folder's name (its last part), never a path. */
  folderName: z.string().max(255).refine((name) => !/[\\/]/.test(name), { message: "a folder name, not a path" }).nullable(),
  engine: Engine,
  model: z.string().max(200).nullable(),
  status: SummaryStatus,
  turn: z.strictObject({ turnId: Id, startedAt: z.number().int().nonnegative() }).optional(),
  waiting: z.array(SummaryWaiting).max(SUMMARY_WAITING_LIMIT),
  unread: z.number().int().nonnegative(),
  /** When its newest line was said (ms); null: no lines. */
  lastAt: z.number().int().nonnegative().nullable(),
  lines: z.array(z.string().max(SUMMARY_LINE_CHARS)).max(SUMMARY_LINES_LIMIT),
  board: z.strictObject({ blob: ContentId, at: z.number().int().nonnegative() }).optional(),
  usage: z.strictObject({ today: z.record(z.string().min(1).max(40), z.number().nonnegative()).refine((today) => Object.keys(today).length <= 20, { message: "at most 20 counters" }) }).optional(),
}).refine(fitsIn(SUMMARY_ROW_CHARS), { message: `a summary row is at most ${SUMMARY_ROW_CHARS} characters of JSON` });
export type SummaryRow = z.infer<typeof SummaryRow>;

/** `machine` — the server itself (§8.2): name, OS, versions, advertised addresses, designated, plugin list digest. */
export const MachineRow = z.strictObject({
  name: z.string().min(1).max(100),
  os: z.string().max(100),
  versions: z.record(z.string().min(1).max(40), z.string().max(100)).refine((versions) => Object.keys(versions).length <= 20, { message: "at most 20 versions" }),
  addresses: z.array(z.string().min(1).max(500)).max(10),
  designated: z.boolean().optional(),
  pluginsDigest: EntryHash.nullable(),
}).refine(fitsIn(TABLE_ROW_CHARS), { message: "the machine row is too large" });
export type MachineRow = z.infer<typeof MachineRow>;

/** A settings key that names a secret: never in the `settings` row (§8.2 "no secrets"). */
export const SECRET_KEY = /secret|token|password|passphrase|private|credential|api_?key|vapid|recovery/i;

/** `settings` — the machine settings view, without secrets (§8.2). */
export const SettingsRow = z.record(z.string().min(1).max(100), z.unknown())
  .refine((settings) => !Object.keys(settings).some((key) => SECRET_KEY.test(key)), { message: "the settings row carries no secret" })
  .refine(fitsIn(TABLE_ROW_CHARS), { message: "the settings row is too large" });
export type SettingsRow = z.infer<typeof SettingsRow>;

/**
 * `audit:<id>` — pairing, revocation, fetch, restore, slot conflicts: who, what, when, size, hash (§8.2). M2's roster
 * store writes `{act, at, statement, by, member?, name?, reason?}`; M3 adds acts (`server.join`, …) of the same shape.
 */
export const AuditRow = z.strictObject({
  act: z.string().min(1).max(40).regex(/^[a-z]+([.-][a-z]+)*$/),
  at: z.number().int().nonnegative(),
  statement: EntryHash.optional(),
  by: Id.optional(),
  member: Id.optional(),
  name: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  size: z.number().int().nonnegative().optional(),
  hash: z.string().max(80).optional(),
}).refine(fitsIn(TABLE_ROW_CHARS), { message: "an audit row is too large" });
export type AuditRow = z.infer<typeof AuditRow>;

/** A plugin grant tier (D52, §8.2). */
export const Tier = z.enum(["read", "request", "write"]);
export type Tier = z.infer<typeof Tier>;

/** Same format as `Via.codeHash` (protocol/messages.ts). */
const PluginCodeHash = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_.-]+$/);
const PluginManifestItem = z.string().max(200);
const PluginManifestList = z.array(PluginManifestItem).max(100);
const PluginCommandType = z.enum(Object.keys(COMMAND_SCOPES) as [CommandType, ...CommandType[]]);

/** One per-codeHash grant recorded in a `plugin:<name>` row (D52, §8.2). */
export const PluginGrant = z.strictObject({
  tier: Tier,
  reads: z.array(PluginManifestItem).max(50),
  requests: z.array(PluginCommandType).max(100),
  grantedBy: z.enum(["user", "import", "builtin"]),
  at: z.number().int().nonnegative(),
});
export type PluginGrant = z.infer<typeof PluginGrant>;

const PluginManifest = z.strictObject({
  tier: Tier,
  reads: PluginManifestList,
  requests: z.array(PluginCommandType).max(100),
  owns: PluginManifestList,
  provides: PluginManifestList,
  requires: PluginManifestList,
  uses: PluginManifestList,
  clients: PluginManifestList,
  needsShell: PluginManifestList,
});

/**
 * `plugin:<name>` — an installed plugin and its per-codeHash grants (D52, §8.2). `files` is left optional and never
 * written in 3.0 so a later version can add it without breaking readers (Q-C9).
 */
export const PluginRow = z.strictObject({
  codeHash: PluginCodeHash,
  manifest: PluginManifest,
  author: z.enum(["builtin", "user", "bot", "import"]),
  files: z.unknown().optional(),
  grants: z.record(PluginCodeHash, PluginGrant).refine((grants) => Object.keys(grants).length <= 20, { message: "at most 20 grants" }),
}).refine(fitsIn(TABLE_ROW_CHARS), { message: "a plugin row is too large" });
export type PluginRow = z.infer<typeof PluginRow>;

/** The body schema a row key takes; null for a kind this version does not know (kept as it is, N4). */
export function rowBodySchema(key: string): z.ZodType | null {
  if (key.startsWith("bot:")) return SummaryRow;
  if (key === "machine") return MachineRow;
  if (key === "settings") return SettingsRow;
  if (key.startsWith("audit:")) return AuditRow;
  if (key.startsWith("plugin:")) return PluginRow;
  return null;
}

/** Whether this version knows the row's kind (and so checks its body); a reader ignores the others (N4). */
export function knownRowKey(key: string): boolean {
  return rowBodySchema(key) !== null;
}

/** The body of a row of an unknown kind: any JSON value up to the size of a table row, kept and passed on verbatim. */
export const UnknownRowBody = z.unknown().refine((body) => body !== undefined && fitsIn(TABLE_ROW_CHARS)(body), { message: "a row of an unknown kind is at most a table row of JSON" });

/** One row of a table stream: a body checked against its key, or a tombstone. */
export const TableRow = z.strictObject({
  key: RowKey,
  rev: Seq.min(1),
  body: z.unknown().optional(),
  deleted: z.literal(true).optional(),
}).superRefine((row, ctx) => {
  if (row.deleted) {
    if (row.body !== undefined) ctx.addIssue({ code: "custom", path: ["body"], message: "a tombstone has no body" });
    return;
  }
  if (row.body === undefined) { ctx.addIssue({ code: "custom", path: ["body"], message: "a row has a body or is deleted" }); return; }
  // A kind this version does not know: kept and passed on, never refused (N4); only its size is checked.
  const schema = rowBodySchema(row.key) ?? UnknownRowBody;
  const parsed = schema.safeParse(row.body);
  if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 5)) ctx.addIssue({ code: "custom", path: ["body", ...issue.path.map(String)], message: issue.message });
});
export type TableRow = z.infer<typeof TableRow>;

/**
 * Rows of a table stream with `after < rev ≤ to`, sorted by `rev` (each key once): one atomic catch-up batch (§8.2).
 * A batch too large for one frame is cut into parts that share `after` and `to`, every part but the last `more: true`;
 * the reader applies it only once the last part is in. `via` tags a forwarded subscription (peer only, as on `batch`).
 */
export const Rows = z.strictObject({
  t: z.literal("rows"),
  stream: TableStreamId,
  logId: LogId,
  /** The cursor's rev the batch starts after (exclusive). */
  after: Seq,
  /** The owner's table rev the batch brings the reader to. */
  to: Seq,
  rows: z.array(TableRow).max(ROWS_LIMIT),
  more: z.boolean(),
  via: SubTag.optional(),
}).superRefine((batch, ctx) => {
  if (batch.after > batch.to) ctx.addIssue({ code: "custom", path: ["after"], message: "after must not be above to" });
  const keys = new Set<string>();
  let last = batch.after;
  batch.rows.forEach((row, index) => {
    if (row.rev <= last) ctx.addIssue({ code: "custom", path: ["rows", index, "rev"], message: "revs rise and are above after" });
    if (row.rev > batch.to) ctx.addIssue({ code: "custom", path: ["rows", index, "rev"], message: "a rev above to" });
    if (keys.has(row.key)) ctx.addIssue({ code: "custom", path: ["rows", index, "key"], message: "a key is in a batch once" });
    keys.add(row.key);
    last = row.rev;
  });
});
export type Rows = z.infer<typeof Rows>;

/** The server a table stream belongs to. */
export function tableOwner(stream: string): string | null {
  const parsed = TableStreamId.safeParse(stream);
  if (!parsed.success) return null;
  const owner = stream.slice(4);
  return ServerId.safeParse(owner).success ? owner : null;
}
