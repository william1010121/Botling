// Botling 3 wire protocol v1: identifiers, cursors, slots and the states a front end may show.
// Design: protocol-v1.md §2 (terms), §8.1 (cursors), §11.1 (slots), §11.6 (delivery), §13.3 (connection states).
// Pure schemas: no Electron, no core, no Node built-ins, so the phone page can use it too (M2).
import { z } from "zod";
import { ContractId } from "../contract/editor-card";

/** The protocol name and version the handshake binds (`botling/3`, v1). */
export const PROTOCOL_NAME = "botling/3" as const;
export const PROTOCOL_VERSION = 1 as const;

/** A bot, server, device or turn id: the contract's id rule (bots keep their 2.x ids). */
export const Id = ContractId;

/** A server's id (`serverId`), as members are named in the roster. */
export const ServerId = Id;

/** A random id of one incarnation of a stream; it changes on restore or a detected rewind (§2, §7.6). */
export const LogId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type LogId = z.infer<typeof LogId>;

/** 128 random bits made when an origin creates its counter store, as 32 lower-case hex digits (§11.1). */
export const OriginEpoch = z.string().regex(/^[0-9a-f]{32}$/);
export type OriginEpoch = z.infer<typeof OriginEpoch>;

/** Who issues a command: a device id, the local desktop front end, or a server id (§2). */
export const Origin = Id;

/** A stream: `bot:<botId>` (a log stream, §8.1) or `srv:<serverId>` (a table stream, §8.2). */
export const StreamId = z.string().max(80).regex(/^(bot|srv):[A-Za-z0-9_.:-]{1,64}$/);
export type StreamId = z.infer<typeof StreamId>;
/** A command's target names the stream whose owner applies it (§11.1). */
export const Target = StreamId;
export type Target = StreamId;

/** A log `seq` (log stream) or `rev` (table stream). 0 means "nothing yet". */
export const Seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A reader's position `(logId, n)`: the last `seq` (or `rev`) it applied (§2, §8.3). */
export const Cursor = z.strictObject({ logId: LogId, seq: Seq });
export type Cursor = z.infer<typeof Cursor>;

/** An entry hash in the chain: SHA-256 as 64 lower-case hex digits (§8.1). */
export const EntryHash = z.string().regex(/^[0-9a-f]{64}$/);
/** The `prevHash` before the first entry of a stream incarnation. */
export const GENESIS_HASH = "0".repeat(64);

/** A content id: the SHA-256 of the exact bytes (§9A.2). */
export const ContentId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/**
 * The id of a pinned version whose hash is not ready yet (local socket only, M1 step 13). A line's `content_refs` are
 * written with its entry, before hashing ends (D44); `content.ready` later moves them to the `sha256:` id. Main may open
 * a pending pin meanwhile: its bytes were fixed when the line finished (a clone or copy), or it is a checked path.
 */
export const PendingContentId = z.string().regex(/^pending:[0-9a-f]{32}$/);
/** What a local `content.open` may name: a content id, or a pin whose hash is still being taken. */
export const LocalContentId = z.union([ContentId, PendingContentId]);

/** A hybrid logical clock for display order only; no safety rule reads it (§8.1). */
export const Hlc = z.strictObject({ ms: z.number().int().nonnegative(), c: z.number().int().nonnegative().max(0xffff) });
export type Hlc = z.infer<typeof Hlc>;

// ---------------------------------------------------------------------------------------------
// Slots (§11.1, §11.3)

/** The n-th command one origin incarnation sends to one target. `n` starts at 1 and is gapless. */
export const Slot = z.strictObject({ origin: Origin, originEpoch: OriginEpoch, target: Target, n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export type Slot = z.infer<typeof Slot>;

/** One key for a slot, for maps and the receipts table. */
export function slotKey(slot: Slot): string {
  return `${slot.origin}\u0000${slot.originEpoch}\u0000${slot.target}\u0000${slot.n}`;
}
/** One key for the (origin, originEpoch, target) queue a slot belongs to. */
export function queueKey(slot: Pick<Slot, "origin" | "originEpoch" | "target">): string {
  return `${slot.origin}\u0000${slot.originEpoch}\u0000${slot.target}`;
}

/** Scopes (§11.7). `local` is the desktop window on its own server, stated by that server (M1 has only it). */
export const Scope = z.enum(["read", "reply", "approve", "manage", "admin", "local"]);
export type Scope = z.infer<typeof Scope>;

/** Why an owner refused a slot (§11.3, §11.5, §12). */
export const RefuseReason = z.enum(["slot conflict", "changed", "scope", "origin", "invalid", "turn ended"]);
export type RefuseReason = z.infer<typeof RefuseReason>;

/** The outcome of a slot: exactly one of applied / cancelled / refused, or skipped below a `floor` (§11.3). */
export const Outcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("applied"), result: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("cancelled") }),
  z.strictObject({ kind: z.literal("refused"), reason: RefuseReason, detail: z.string().max(2_000).optional() }),
  z.strictObject({ kind: z.literal("skipped") }),
]);
export type Outcome = z.infer<typeof Outcome>;

/** The command hash a receipt stores: SHA-256 hex over `cmd`, `scope` and `basis`, never `floor` or `inc` (§11.1). */
export const CmdHash = EntryHash;

/** The owner's stored outcome of a slot (§2). `seq` is the entry that carried it. */
export const Receipt = z.strictObject({ slot: Slot, cmdHash: CmdHash, outcome: Outcome, logId: LogId, seq: Seq });
export type Receipt = z.infer<typeof Receipt>;

// ---------------------------------------------------------------------------------------------
// What the UI may show

/** Delivery states, the only ones the UI may show for an outbox item (§11.6). "Failed" is not one. */
export const DeliveryState = z.enum(["waiting", "held", "delivered", "not sent"]);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** Connection states, the only ones the UI may show (§13.3). */
export const ConnectionState = z.enum([
  "connecting", "live", "offline", "machine stale", "catching up", "history restored", "gone", "needs pairing", "update required",
]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/** A server as a front end sees it (`welcome.servers`, `peer`). */
export const ServerState = z.enum(["live", "stale", "gone"]);
export type ServerState = z.infer<typeof ServerState>;
