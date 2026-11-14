// Botling 3 wire protocol v1: log entries, content references and the canonical form the hash chain is taken over.
// Design: protocol-v1.md §8.1 (entries, hash chain), §9.3 (interrupted turns), §9A.2 (references), §11.3 (outcomes), §12.
import { z } from "zod";
import { Event as ContractEvent, BotId, MESSAGE_TEXT_LIMIT } from "../contract";
import { ContentId, Cursor, EntryHash, Hlc, Id, LogId, Origin, OriginEpoch, Outcome, RefuseReason, Seq, ServerId, Slot, StreamId, Target } from "./ids";

/** A reference to file bytes: names them by hash, carries no token and no permission (§9A.2). */
export const ContentRef = z.strictObject({
  owner: ServerId,
  id: ContentId,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.string().min(1).max(200),
  name: z.string().min(1).max(1_000),
  kind: z.enum(["video", "audio", "image", "pdf", "page", "file"]),
  pin: z.enum(["clone", "copy", "path"]),
  state: z.enum(["preparing", "ready", "changed", "gone"]),
  meta: z.strictObject({
    duration: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    bitrate: z.number().nonnegative().optional(),
    pages: z.number().int().positive().optional(),
    poster: ContentId.optional(),
    variants: z.array(z.strictObject({
      name: z.string().min(1).max(100), id: ContentId, size: z.number().int().nonnegative(), type: z.string().min(1).max(200),
      bitrate: z.number().nonnegative().optional(), height: z.number().int().positive().optional(),
    })).max(20).optional(),
  }).optional(),
});
export type ContentRef = z.infer<typeof ContentRef>;

/**
 * Entry kinds that are new in Botling 3 (the rest are the contract's events, §8.1). Each body is validated as
 * `{type: kind, ...body}`.
 */
export const ProtocolEntryEvent = z.discriminatedUnion("type", [
  /** `chat.send` committed with its effect row; the turn starts later (§12). */
  z.strictObject({ type: z.literal("turn.queued"), botId: BotId, turnId: Id, effectId: Id, messageId: Id.optional() }),
  /** The server stopped while the turn ran: the checkpoint text, never restarted by itself (§9.3, §12). */
  z.strictObject({ type: z.literal("turn.interrupted"), botId: BotId, turnId: Id, messageId: Id.optional(), text: z.string().max(MESSAGE_TEXT_LIMIT * 4) }),
  /** A queued turn stopped before it started (§12). */
  z.strictObject({ type: z.literal("turn.cancelled"), botId: BotId, turnId: Id }),
  /** Outcomes of slots that targeted this stream (§11.3). */
  z.strictObject({ type: z.literal("cmd.applied"), slot: Slot, result: z.unknown().optional() }),
  z.strictObject({ type: z.literal("cmd.cancelled"), slot: Slot }),
  z.strictObject({ type: z.literal("cmd.refused"), slot: Slot, reason: RefuseReason, detail: z.string().max(2_000).optional() }),
  /** After a rewind the owner skips the origin's slots `from`…`to` below its `floor` (§11.3, D12). */
  z.strictObject({ type: z.literal("cmd.skipped"), origin: Origin, originEpoch: OriginEpoch, target: Target, from: z.number().int().min(1), to: z.number().int().min(1) })
    .refine((skip) => skip.from <= skip.to, { message: "from must not be above to" }),
  /** The hash and meta of a file a finished line named are ready (§9A.2). */
  z.strictObject({ type: z.literal("content.ready"), botId: BotId, lineId: Id, url: z.string().min(1).max(8_000), ref: ContentRef }),
  /** A `pin: path` file no longer matches its hash (§9A.3). */
  z.strictObject({ type: z.literal("content.changed"), id: ContentId }),
]);
export type ProtocolEntryEvent = z.infer<typeof ProtocolEntryEvent>;

/** Contract events that are never entries: running text goes on the live channel (§8.1, D10). */
export const NOT_ENTRY_KINDS: ReadonlySet<string> = new Set(["turn.delta"]);

const protocolKinds = new Set<string>(ProtocolEntryEvent.options.map((option) => option.shape.type.value));
const contractKinds = new Set<string>(ContractEvent.options.map((option) => option.shape.type.value));

/** Every kind an entry may have. */
export const ENTRY_KINDS: ReadonlySet<string> = new Set([...protocolKinds, ...[...contractKinds].filter((kind) => !NOT_ENTRY_KINDS.has(kind))]);

const EntryKind = z.string().min(1).max(64).refine((kind) => ENTRY_KINDS.has(kind), { message: "unknown entry kind" });

/** An entry's body checked against its kind (a contract event, or a protocol one, without its `type`). */
function checkBody(kind: string, body: unknown, ctx: z.RefinementCtx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) { ctx.addIssue({ code: "custom", path: ["body"], message: "body must be an object" }); return; }
  if ("type" in body) { ctx.addIssue({ code: "custom", path: ["body", "type"], message: "the kind is not repeated in the body" }); return; }
  const schema = protocolKinds.has(kind) ? ProtocolEntryEvent : ContractEvent;
  const result = schema.safeParse({ type: kind, ...body });
  if (!result.success) for (const issue of result.error.issues.slice(0, 5)) ctx.addIssue({ code: "custom", path: ["body", ...issue.path.map(String)], message: issue.message });
}

/**
 * One durable, numbered event of a stream (§8.1). `seq` is gapless per (stream, logId); `hash` =
 * SHA-256(prevHash ‖ canonical entry without `hash`); `slot` is set when a command made it.
 */
export const Entry = z.strictObject({
  stream: StreamId,
  logId: LogId,
  seq: Seq.min(1),
  hlc: Hlc,
  kind: EntryKind,
  body: z.record(z.string(), z.unknown()),
  slot: Slot.optional(),
  hash: EntryHash,
}).superRefine((entry, ctx) => { if (ENTRY_KINDS.has(entry.kind)) checkBody(entry.kind, entry.body, ctx); });
export type Entry = z.infer<typeof Entry>;

/** The entry as the hash covers it: everything but `hash`. */
export type EntryContent = Omit<Entry, "hash">;

/** The cursor right after an entry. */
export function entryCursor(entry: Pick<Entry, "logId" | "seq">): Cursor {
  return { logId: entry.logId, seq: entry.seq };
}

/**
 * The canonical JSON text of a value: object keys sorted, no spaces, `undefined` members left out. The hash chain
 * (§8.1) and command hashes (§11.1) are taken over this text, on the server and on every front end alike.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: a number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: cannot encode a ${typeof value}`);
}

/** The text an entry's hash is taken over: the previous hash, a newline, the canonical entry without `hash`. */
export function entryHashInput(prevHash: string, entry: EntryContent | Entry): string {
  const { hash: _hash, ...content } = entry as Entry;
  return `${prevHash}\n${canonicalJson(content)}`;
}

/** The outcome an outcome entry states, for `cmd.result` (§11.2). Null for any other kind. */
export function outcomeOf(entry: Pick<Entry, "kind" | "body">): Outcome | null {
  const body = entry.body as Record<string, unknown>;
  switch (entry.kind) {
    case "cmd.applied": return body.result === undefined ? { kind: "applied" } : { kind: "applied", result: body.result };
    case "cmd.cancelled": return { kind: "cancelled" };
    case "cmd.refused": return { kind: "refused", reason: body.reason as RefuseReason, ...(typeof body.detail === "string" ? { detail: body.detail } : {}) };
    case "cmd.skipped": return { kind: "skipped" };
    default: return null;
  }
}
