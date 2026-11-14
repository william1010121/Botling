// Botling 3 wire protocol v1: the messages of a session, each a plaintext `{t, ...}` JSON frame (§5.2).
// Design: protocol-v1.md §4 (roster, pairing), §5.4 (roles), §8 (streams), §9.2 (live), §9A.4 (content), §11 (commands),
// §13.1 (attach). M1 and M2 messages have schemas here; M3's (`rows`, `prefs.*`, `join.*`) are in messages-m3.ts and
// read only by `decodeWireFrame` (frame.ts); `fetch.*` (M5) has none yet, so a frame naming one is refused as unsupported.
import { z } from "zod";
import { BotId, Command, MessageView, WireError } from "../contract";
import { ContentRef, ContentVariant, Entry } from "./entries";
import { ContentTicket, EntryRef, VariantName } from "./content-url";
import { AdminEvent, AdminOp } from "./pairing";
import { PublicKey, RevocationStatement, Signature, SignedStatement, StatementId } from "./roster";
import {
  ContentId, Cursor, EntryHash, LocalContentId, Id, LogId, OriginEpoch, Outcome, PROTOCOL_VERSION, Scope, Seq, ServerId, ServerState, Slot, StreamId, Target,
} from "./ids";

/** A request id chosen by the asker, echoed by the answer. */
export const ReqId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
/**
 * The tag of a forwarded subscription (M3, §10.3): the attached server S forwards a front end's `sub` to the owner B
 * with `via` set to an id S chose for that front end's subscription; B echoes it on every `batch`, `snap`, `reset` and
 * `rows` it sends for it, and S takes it off before it relays the frame. Only a peer server states it.
 */
export const SubTag = ReqId;
/** A version number of the front end, e.g. "3.0.0". */
const Version = z.string().min(1).max(40).regex(/^[0-9A-Za-z.+-]+$/);
/** At most this many entries in one batch (catch-up page, §20). */
export const BATCH_ENTRIES_LIMIT = 500;

/** The `cmd` envelope without its `t` (also what `hello.outbox` lists). */
export const CmdBody = z.strictObject({
  slot: Slot,
  /** The smallest `n` this origin incarnation still holds unresolved for this target (§11.1, D12). */
  floor: z.number().int().min(1),
  /** The target owner's `srv:` logId as the origin knows it when it sends (§11.1, D49). */
  inc: LogId,
  cmd: Command,
  /** Stated by the server that accepted the command, never by a front end (§11.1). */
  scope: Scope.optional(),
  /** The bot cursor the front end showed, for acts on visible things (§11.5). */
  basis: Cursor.optional(),
}).refine((body) => body.floor <= body.slot.n, { message: "floor must not be above the slot's n", path: ["floor"] });
export type CmdBody = z.infer<typeof CmdBody>;

const msg = <T extends string, S extends z.core.$ZodLooseShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

// ---------------------------------------------------------------------------------------------
// Attach (§13.1)

export const Hello = msg("hello", {
  deviceId: Id,
  feVersion: Version,
  protocol: z.literal(PROTOCOL_VERSION),
  originEpoch: OriginEpoch,
  cursors: z.record(StreamId, Cursor),
  outbox: z.array(CmdBody).max(1_000),
  want: z.array(StreamId).max(1_000),
  /** The local token (local socket only; other transports authenticate in the handshake, §5.1, §6.1). */
  token: z.string().min(16).max(256).optional(),
});
export const Welcome = msg("welcome", {
  serverId: ServerId,
  protocol: z.strictObject({ min: z.number().int().min(1), max: z.number().int().min(1) }).refine((range) => range.min <= range.max, { message: "min above max" }),
  minFeVersion: Version,
  rosterDigest: EntryHash.nullable(),
  servers: z.array(z.strictObject({ id: ServerId, name: z.string().min(1).max(200), state: ServerState, since: z.number().int().nonnegative().nullable() })).max(64),
  /** The owner's `next` for this front end's current epoch, per target this server owns (§11.4). */
  next: z.record(Target, z.number().int().min(1)),
  views: z.record(z.string().max(100), z.unknown()),
});

// ---------------------------------------------------------------------------------------------
// Streams (§8, §10.2)

/** Subscribe from a cursor (none: from a fresh `snap`). */
export const Sub = msg("sub", { stream: StreamId, cursor: Cursor.nullable(), via: SubTag.optional() });
export const Unsub = msg("unsub", { stream: StreamId, via: SubTag.optional() });
/** The reader applied everything up to `cursor`. */
export const Ack = msg("ack", { stream: StreamId, cursor: Cursor, via: SubTag.optional() });
/** Older lines before message `before` (the 2.x `chat.history` paging, §8.4). */
export const History = msg("history", { req: ReqId, stream: StreamId, before: Id, bytes: z.number().int().min(1024).max(8 * 1024 * 1024).optional() });
/** One page of older lines; `logId` is the incarnation it was read from. */
export const HistoryPage = msg("history.page", {
  req: ReqId, stream: StreamId, logId: LogId, messages: z.array(MessageView).max(2_000), hasMore: z.boolean(), older: z.number().int().nonnegative(),
});

/** Entries `from`…`to` of one incarnation; `prevHash` is the hash before `from` (§8.1). */
export const Batch = msg("batch", {
  stream: StreamId, logId: LogId, from: Seq.min(1), to: Seq.min(1), prevHash: EntryHash, entries: z.array(Entry).min(1).max(BATCH_ENTRIES_LIMIT), more: z.boolean(), via: SubTag.optional(),
}).superRefine((batch, ctx) => {
  if (batch.to - batch.from + 1 !== batch.entries.length) ctx.addIssue({ code: "custom", path: ["entries"], message: "entries do not cover from…to" });
  batch.entries.forEach((entry, index) => {
    if (entry.stream !== batch.stream || entry.logId !== batch.logId) ctx.addIssue({ code: "custom", path: ["entries", index], message: "entry of another stream or logId" });
    if (entry.seq !== batch.from + index) ctx.addIssue({ code: "custom", path: ["entries", index, "seq"], message: "seq out of order" });
  });
});
/** The read model at `seq` (newest page of messages, open cards, bot state; or a table's rows), then entries after it (§8.4). */
export const Snap = msg("snap", { stream: StreamId, logId: LogId, seq: Seq, hash: EntryHash, view: z.record(z.string().max(100), z.unknown()), via: SubTag.optional() });
/**
 * The stream has a new incarnation `logId`; `retired` lists every earlier one with the last seq the restore kept of it.
 * A reader never goes back to a retired logId (§7.6, §8.3, D50).
 */
export const Reset = msg("reset", {
  stream: StreamId, logId: LogId, retired: z.array(z.strictObject({ logId: LogId, keptSeq: Seq })).min(1).max(1_000), reason: z.enum(["restored", "rewind"]),
  /** A restore from a backup: when that backup was taken (ms), so the window can say "restored to <time>". */
  restoredTo: z.number().int().nonnegative().optional(),
  via: SubTag.optional(),
}).refine((reset) => !reset.retired.some((old) => old.logId === reset.logId), { message: "the new logId cannot be retired", path: ["retired"] });
/** The serving server lost the stream's owner (§10.2). */
export const Stale = msg("stale", { stream: StreamId, since: z.number().int().nonnegative() });
/** A server's state as the attached server sees it (§10.5). */
export const Peer = msg("peer", { serverId: ServerId, state: ServerState, since: z.number().int().nonnegative().nullable() });

// ---------------------------------------------------------------------------------------------
// Live channel (§9.2)

export const Live = msg("live", {
  stream: StreamId, turnId: Id, seg: z.number().int().nonnegative(), rev: z.number().int().nonnegative(), at: z.number().int().nonnegative(), text: z.string().max(200_000),
});
export const LiveResync = msg("live.resync", { stream: StreamId });

// ---------------------------------------------------------------------------------------------
// Commands (§11)

export const Cmd = z.strictObject({ t: z.literal("cmd"), ...CmdBody.shape })
  .refine((body) => body.floor <= body.slot.n, { message: "floor must not be above the slot's n", path: ["floor"] });
/** The origin no longer wants slot `slot` (§11.3). */
export const Cancel = msg("cancel", { slot: Slot });
/** A non-owner stored the command and forwards it (§11.2). */
export const Held = msg("held", { slot: Slot, at: ServerId });
/**
 * The slot's outcome, from the owner's incarnation `logId` (D50); `seq` is the entry that carried it, or null when
 * nothing was appended (`slot conflict`). Sent again for every duplicate.
 */
export const CmdResult = msg("cmd.result", { slot: Slot, outcome: Outcome, logId: LogId, seq: Seq.min(1).nullable() })
  .refine((result) => result.seq !== null || (result.outcome.kind === "refused" && result.outcome.reason === "slot conflict"), { message: "only a slot conflict has no entry", path: ["seq"] });
/** Sent to an earlier incarnation of the owner: re-send with `inc` once you have its `reset`. Not an outcome (D49). */
export const CmdRetry = msg("cmd.retry", { slot: Slot, inc: LogId });

// ---------------------------------------------------------------------------------------------
// Reads that need no slot (§11.1): local socket requests answered by `res`

export const Req = msg("req", { req: ReqId, cmd: Command });
export const Res = z.union([
  msg("res", { req: ReqId, ok: z.literal(true), result: z.unknown() }),
  msg("res", { req: ReqId, ok: z.literal(false), error: WireError }),
]);
/** The most UTF-16 units of a `res` one `res.part` carries: even all escaped (6 bytes each) it fits a frame. */
export const RES_PART_CHARS = 32 * 1024;
/** The most parts one answer is cut into (a `res` of at most 64 Mi characters of JSON). */
export const RES_PARTS_MAX = 2048;
/**
 * A `res` too large for one frame (a v1 addition, demo fix): its JSON text cut into `n` parts, sent in order (`i` from
 * 0). The front end joins the texts and reads them as the `res` frame they are (same `req`); nothing else is in them.
 */
export const ResPart = msg("res.part", {
  req: ReqId, i: z.number().int().min(0).max(RES_PARTS_MAX - 1), n: z.number().int().min(2).max(RES_PARTS_MAX), text: z.string().min(1).max(RES_PART_CHARS),
}).refine((part) => part.i < part.n, { message: "i is below n", path: ["i"] });

// ---------------------------------------------------------------------------------------------
// Content, local part (§9A.4): Electron main asks the server for the pinned file of a reference

/**
 * The renderer names a line's file the 2.x way (`botling-chat://chat/attachment/<bot>/<file URL>?line=<id>`); main asks
 * which reference that line holds for the file, then opens it. Local socket only (M1 step 13).
 */
export const ContentFind = msg("content.find", { req: ReqId, botId: BotId, line: Id, url: z.string().min(1).max(8_000) });
/** The reference a line holds for a file, with the entry that proves it; null when the line names no such file. */
export const ContentFound = msg("content.found", {
  req: ReqId,
  ref: z.strictObject({
    owner: ServerId, id: LocalContentId, type: z.string().min(1).max(200), state: ContentRef.shape.state,
    entry: z.strictObject({ stream: StreamId, seq: Seq.min(1) }),
  }).nullable(),
});
/** `entry` names the entry that holds the reference: the proof of reference checked on every open (§9A.7). */
export const ContentOpen = msg("content.open", {
  req: ReqId, owner: ServerId, id: LocalContentId, variant: z.string().min(1).max(100), entry: z.strictObject({ stream: StreamId, seq: Seq.min(1) }),
});
/** The stat signature main re-checks before it streams a pinned file (§9A.3). Nanoseconds and inodes as decimal text. */
export const StatSignature = z.strictObject({ size: z.number().int().nonnegative(), mtimeNs: z.string().regex(/^[0-9]{1,24}$/), ino: z.string().regex(/^[0-9]{1,24}$/) });
/** One SHA-256 per 1 MiB of a file, as the raw digests one after another in base64 (≤ 5,625 chunks in one frame). */
export const ChunkHashes = z.string().max(240_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const CONTENT_CHUNK_BYTES = 1024 * 1024;
/**
 * The pinned file of a reference. For `pin: path`, `chunkHashes` (when the hash is ready and the list fits) lets main
 * check every chunk it streams: a reference serves the bytes of its hash or nothing (§9A.3).
 */
export const ContentFile = msg("content.file", {
  req: ReqId, id: LocalContentId, path: z.string().min(1).max(4_096), type: z.string().min(1).max(200), pin: ContentRef.shape.pin, sig: StatSignature,
  chunkHashes: ChunkHashes.optional(),
});
export const ContentGone = msg("content.gone", { req: ReqId, id: LocalContentId, reason: z.enum(["changed", "deleted", "denied", "offline", "too-large"]) });

// ---------------------------------------------------------------------------------------------
// Content, remote part (§9A.4, §9A.9): range reads over the session (the service-worker path, server ↔ server), the
// tailnet URL ticket (M2 brief Q1, content-url.ts) and uploads. Bulk lane (§5.3).

/** The most a `content.chunk` frame carries: 128 KiB (relay sessions; direct sessions send 64 KiB, §9A.4). */
export const CONTENT_FRAME_CHUNK_LIMIT = 128 * 1024;
/** The largest credit one `content.credit` grants (the windows are 4 MiB direct, 1 MiB relay; §9A.4). */
export const CONTENT_CREDIT_LIMIT = 64 * 1024 * 1024;
/** The largest upload (§9A.9, D40: 500 MB). */
export const CONTENT_PUT_LIMIT = 500_000_000;

/** Read `length` bytes of a variant from `offset`; `entry` is the proof of reference checked on every get (§9A.7). */
export const ContentGet = msg("content.get", {
  req: ReqId, owner: ServerId, id: ContentId, variant: VariantName, offset: Seq, length: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), entry: EntryRef,
});
/** The first answer to a get: what the bytes are, their chunk hashes (when the list fits) and the variants. */
export const ContentMeta = msg("content.meta", {
  req: ReqId, id: ContentId, size: Seq, type: z.string().min(1).max(200), chunkSize: z.literal(CONTENT_CHUNK_BYTES), chunkHashes: ChunkHashes.optional(),
  variants: z.array(ContentVariant).max(20),
});
/**
 * Bytes of a get (server → reader) or of a put (FE → server). Always a binary frame (`encodeChunkFrame`): a short JSON
 * header, then the raw bytes, never base64 inside JSON (§9A.4).
 */
export const ContentChunk = msg("content.chunk", {
  req: ReqId, offset: Seq,
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length >= 1 && bytes.length <= CONTENT_FRAME_CHUNK_LIMIT, { message: `1 to ${CONTENT_FRAME_CHUNK_LIMIT} bytes` }),
});
/** The receiver's window: it may be sent `bytes` more. */
export const ContentCredit = msg("content.credit", { req: ReqId, bytes: z.number().int().min(1).max(CONTENT_CREDIT_LIMIT) });
/** The player seeked away or closed. */
export const ContentCancel = msg("content.cancel", { req: ReqId });
/** Ask for a URL ticket for one reference (Q1). */
export const ContentTicketReq = msg("content.ticket", { req: ReqId, owner: ServerId, id: ContentId, entry: EntryRef });
/** The ticket: bound to this device, the id and the entry; re-checked on every request (Q1). */
export const ContentGranted = msg("content.granted", { req: ReqId, ticket: ContentTicket, expiresAt: z.number().int().nonnegative() });
/** Start (or resume) an upload of the bytes whose hash is `id`; the server answers `content.stored` with what it has. */
export const ContentPut = msg("content.put", {
  req: ReqId, id: ContentId, size: z.number().int().min(1).max(CONTENT_PUT_LIMIT), type: z.string().min(1).max(200), name: z.string().min(1).max(1_000),
});
/** How many bytes of an upload the server holds; `have = size` once the bytes are in and their hash checked. */
export const ContentStored = msg("content.stored", { req: ReqId, id: ContentId, have: Seq });

// ---------------------------------------------------------------------------------------------
// Pairing session (§4.4): after the `pair` handshake, before the device is in the roster

/**
 * The device names itself and proves its signing key: `proof` is its Ed25519 signature over the handshake's transcript
 * hash (src/session). Its X25519 key is the handshake's static key; its member id comes from `sign`.
 */
export const PairHello = msg("pair.hello", { name: z.string().min(1).max(100), sign: PublicKey, proof: Signature, feVersion: Version, protocol: z.literal(PROTOCOL_VERSION) });
/** The user confirmed the code: the device's committed `Add` and the statements it needs to trust this cluster. */
export const PairAdded = msg("pair.added", {
  add: SignedStatement.refine((statement) => statement.body.type === "add" && statement.body.kind === "device", { message: "a device's Add" }),
  roster: z.array(SignedStatement).max(200),
});
/** The device stored its membership (the 2.x held-offer rule: the offer is used up only now). */
export const PairAck = msg("pair.ack", { addId: StatementId });
/** Either side ends the pairing. */
export const PairDeclined = msg("pair.declined", { reason: z.enum(["code", "expired", "used", "busy", "cancelled", "unsupported"]) });

// ---------------------------------------------------------------------------------------------
// Roster gossip, server ↔ server (§4.6, §4.7). M2 runs one server; the shapes are fixed here with the statements.

export const RosterHave = msg("roster.have", { digest: EntryHash });
export const RosterIds = msg("roster.ids", { ids: z.array(StatementId).max(2_000) });
export const RosterWant = msg("roster.want", { ids: z.array(StatementId).max(2_000) });
export const RosterStatements = msg("roster.statements", { statements: z.array(SignedStatement).max(200) });
/** Only `Revoke` and `Root` statements; also on a refused server handshake (D47). */
export const RosterRevocations = msg("roster.revocations", { statements: z.array(RevocationStatement).max(200) });

// ---------------------------------------------------------------------------------------------
// Admin, local socket only (§4.3, M2 brief Q5): the desktop window and `botlingd`'s CLI pair and revoke devices

/** An admin request, answered by `res`. */
export const Admin = msg("admin", { req: ReqId, op: AdminOp });
/** What happens in a pairing the window started (the code to compare, done, declined) or a revocation. */
export const AdminEventMsg = msg("admin.event", { event: AdminEvent });

// ---------------------------------------------------------------------------------------------
// The server's requests of the attached window (local socket; the 2.x core's app ops)

/** String arguments of a `shell.*` request. `shell.browser` carries the bot's browser request as JSON in `request` (≤ 64,000, as the 2.x app op). */
const ShellArgs = z.record(z.string().max(100), z.string().max(64_000));
export const ShellScreenshot = msg("shell.screenshot", { req: ReqId, args: ShellArgs.optional() });
export const ShellBrowser = msg("shell.browser", { req: ReqId, args: ShellArgs.optional() });
/** Install the newer release (the core's `installRelease`). */
export const ShellInstall = msg("shell.install", { req: ReqId, args: ShellArgs.optional() });
export const ShellQuit = msg("shell.quit", { req: ReqId, args: ShellArgs.optional() });
/** The window's answer to a `shell.*` request; `data` is what a browser request answered (the 2.x app op's `data`). */
export const ShellDone = msg("shell.done", { req: ReqId, ok: z.boolean(), file: z.string().max(4_096).optional(), error: z.string().max(2_000).optional(), data: z.unknown().optional() });

// ---------------------------------------------------------------------------------------------
// Session (§5.2)

export const Ping = msg("ping", { at: z.number().int().nonnegative().optional() });
/** `revoked`: the peer is not (or no longer) valid in the roster (§4.6). */
export const Bye = msg("bye", { reason: z.enum(["role", "malformed", "too-large", "version", "token", "closing", "dead", "revoked"]), detail: z.string().max(500).optional() });

/** Every v1 message schema, by its `t`. */
export const MESSAGES = {
  hello: Hello, welcome: Welcome,
  sub: Sub, unsub: Unsub, ack: Ack, history: History, "history.page": HistoryPage,
  batch: Batch, snap: Snap, reset: Reset, stale: Stale, peer: Peer,
  live: Live, "live.resync": LiveResync,
  cmd: Cmd, cancel: Cancel, held: Held, "cmd.result": CmdResult, "cmd.retry": CmdRetry,
  req: Req, res: Res, "res.part": ResPart,
  "content.find": ContentFind, "content.found": ContentFound, "content.open": ContentOpen, "content.file": ContentFile, "content.gone": ContentGone,
  "content.get": ContentGet, "content.meta": ContentMeta, "content.chunk": ContentChunk, "content.credit": ContentCredit, "content.cancel": ContentCancel,
  "content.ticket": ContentTicketReq, "content.granted": ContentGranted, "content.put": ContentPut, "content.stored": ContentStored,
  "pair.hello": PairHello, "pair.added": PairAdded, "pair.ack": PairAck, "pair.declined": PairDeclined,
  "roster.have": RosterHave, "roster.ids": RosterIds, "roster.want": RosterWant, "roster.statements": RosterStatements, "roster.revocations": RosterRevocations,
  admin: Admin, "admin.event": AdminEventMsg,
  "shell.screenshot": ShellScreenshot, "shell.browser": ShellBrowser, "shell.install": ShellInstall, "shell.quit": ShellQuit, "shell.done": ShellDone,
  ping: Ping, bye: Bye,
} as const;
export type MessageType = keyof typeof MESSAGES;
export type Message = { [T in MessageType]: z.infer<(typeof MESSAGES)[T]> }[MessageType];
export type MessageOf<T extends MessageType> = z.infer<(typeof MESSAGES)[T]>;
