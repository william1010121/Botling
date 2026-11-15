// Types a session shares with its host and its shells (M7-S22, moved unchanged out of session-core.ts): botlingd's parts
// as a session reads them (`SessionHost` and the optional parts it hands over), and the session's options.
import type { Command, CommandType } from "../../contract";
import type { AdminEvent, AdminOp, CmdBody, Cursor, Message, MessageOf, ServerAddresses, ServerState, VapidKeyId, WireMessage } from "../../protocol";
import type { TurnEngine } from "../effects";
import type { IntentRuntime } from "../intents";
import type { LogHub } from "../log";
import type { LocalPeerReads } from "../content/local-peer-read";
import type { LocatedRef } from "../content/peer-content";
import type { LiveChannel } from "../live";
import type { RosterView } from "../roster";
import type { ShellBridge } from "../shell-bridge";
import type { LiveGateClock } from "./live-gate";

/** botlingd's own answers to the `local` commands (Settings › Phone: server/pairing/phone-desk.ts), local sessions only. */
export interface PhoneHost {
  handles(type: CommandType): boolean;
  run(cmd: Command): Promise<unknown>;
}

/** The content path's local part (step 13, src/server/content `ContentService.handle`). */
export interface ContentHandler {
  handle(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">>;
}

/** Pairing and devices for the local socket's `admin` requests (server/pairing). */
export interface AdminHost {
  /** The `res` result of one request; throws (with an optional `code`) to refuse it. */
  handle(op: AdminOp, session?: object): Promise<unknown>;
  onEvent(listener: (event: AdminEvent) => void): () => void;
  /** M4-46 (J8): called when a local admin session closes so its open offers/attempts are cancelled. */
  sessionClosed?(session: object): void;
}

/** What every session shares: botlingd's parts. */
export interface SessionHost {
  serverId: string;
  /** Shown in `welcome.servers` (this Mac). */
  serverName: string;
  startedAt: number;
  minFeVersion: string;
  /** The local token as it is now (§6.1). */
  token(): string;
  hub: LogHub;
  live: LiveChannel;
  runtime: IntentRuntime;
  engine: TurnEngine;
  content: ContentHandler | null;
  shell: ShellBridge;
  /** `slots.next` per target for one origin incarnation (welcome.next, §11.4). */
  nextFor(origin: string, originEpoch: string): Record<string, number>;
  /** A bot the engine has whose stream is not made yet: make it (true: the stream exists now). */
  ensureBotStream(botId: string): Promise<boolean>;
  log(text: string): void;
  /** Local `admin` requests (M2 step 5); without it they are answered with an error. */
  admin?: AdminHost;
  /** The `local` commands (Settings › Phone in the Botling 3 window); without it the engine answers them as before. */
  phone?: PhoneHost;
  /** M3 step 7: peer servers' states and their `srv:` tables from this server's copies (none on a lone server). */
  tables?: SessionTables;
  /** M3 step 9: commands and cancels for targets a peer owns go to the forward queue (none on a lone server). */
  forward?: SessionForward;
  /** M3 step 8: subscriptions to bots a peer owns pass through to that peer (none on a lone server). */
  passThrough?: SessionPassThrough;
  /** M2 step 12: uploads (`content.put` + chunks); a `chat.send` naming files waits for their bytes (held). */
  uploads?: SessionUploads;
  /** M4-01a: local socket reads of a peer's content (`content.get` / `.credit` / `.cancel`). */
  peerReads?: () => LocalPeerReads | null;
  /** M4-01a: local socket `content.find` fallback for a peer bot's line (`LOCAL_WINDOW`). */
  peerLocate?: (message: MessageOf<"content.locate">) => Promise<LocatedRef | null>;
  /** D70: roster + own DH key for filling `dh` and K12 Profile `addresses` on `welcome.servers` and `peer`. */
  roster?: SessionRoster;
  self?: { readonly dhPub: Uint8Array };
  /** M4-26 (§18.4, Q-P3/F3): current cluster VAPID public key + `(gen, id)` read atomically for remote `welcome`. */
  vapidKey?: () => { publicKey: string; id: VapidKeyId } | null;
  /** M4-26 / M4-25 fallback when only `vapidPublicKey` is wired on a host. */
  vapidPublicKey?: () => string | null;
}

/** Shared subset of `RosterView` used by session hosts and remote rosters. */
export type SessionRosterView = Pick<RosterView, "valid" | "revoked" | "members">;

/** Optional roster view and K12 profile reader used to populate `welcome.servers` and `peer` (D70). */
export interface SessionRoster {
  readonly clusterId?: string | null;
  readonly view?: SessionRosterView;
  profile?(member: string, field: "addresses"): string | null;
}

/** server/content/put.ts `Uploads` as a session uses it. */
export interface SessionUploads {
  complete(id: string): { path: string; size: number } | null;
  whenComplete(ids: string[], closed: Promise<void>, idleMs?: number): Promise<"ready" | "closed" | "idle" | "refused">;
  put(owner: string, message: MessageOf<"content.put">): Promise<Message[]>;
  chunk(owner: string, message: MessageOf<"content.chunk">): Promise<Message[]>;
  ended(owner: string): Promise<void>;
}

/**
 * Pass-through as a front end's session uses it (server/replica/pass-through.ts, v1 §10.3): a `sub` of a bot a peer owns
 * becomes a leg forwarded to that owner; its frames come back unchanged (no `via`) through `sink`; `ack` and `unsub` go to
 * the leg; `history` is asked of the owner. Never the log hub: this server builds no state of a peer's bot.
 */
export interface SessionPassThrough {
  isPeerStream(stream: string): boolean;
  /** `live` gets the running turn's live frames from the owner (no `via`); the leg's `liveResync` asks the owner again. */
  open(stream: string, cursor: Cursor | null, sink: (message: Message) => boolean, live?: (frame: MessageOf<"live">) => void): { ack(cursor: Cursor): void; liveResync?(): void; close(): void };
  history(request: MessageOf<"history">, sink: (message: Message) => boolean): void;
}

/**
 * Forwarding as a front end's session uses it (server/forward). A target a peer owns is committed into `forwardq` and
 * answered `held{slot, at: this server}`; this server never answers it with an outcome of its own (D58, F3). The
 * owner's `cmd.result` / `cmd.retry` / `cancel.noted` come back through `attach` to every open session of the origin.
 */
export interface SessionForward {
  /** The peer that owns `target`, or null when this server decides it (also every target on a lone server). */
  ownerOf(target: string): string | null;
  /** Commits the command (scope stated) for `owner`; resolves after the commit. */
  commit(envelope: CmdBody, owner: string): Promise<void>;
  /** Commits the cancel for `owner`; resolves after the commit. */
  cancel(slot: MessageOf<"cancel">["slot"], owner: string): Promise<void>;
  attach(origin: string, sink: (message: Message) => boolean): () => void;
}

/** What a front end's session reads of peer servers and their tables (server/replica/peer-tables.ts, server/peer). */
export interface SessionTables {
  /** Every peer server as `welcome.servers` lists it. */
  peers(): Array<{ id: string; name: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }>;
  /** A peer's state changed (`peer{serverId, state, since}` to front ends, §10.5). */
  onPeer(listener: (peer: { id: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }) => void): () => void;
  /** A peer's `srv:` table, served from this server's copy (not the log hub). */
  isPeerTable(stream: string): boolean;
  /**
   * This server's own `srv:` table stream (M5-14e). A front end that subs it gets the log as always and, besides, the
   * table's `plugin:` rows as `rows` frames (`ownTableFrame`), so a page attached to one server reads its plugins as it
   * reads a peer's. Absent: no rows (a host without table feeds).
   */
  isOwnTable?(stream: string): boolean;
  subscribe(stream: string, cursor: Cursor | null, sink: (message: WireMessage) => boolean): { close(): void };
}

/** The kinds of own-table rows a front end gets (M5-14e); the table's other rows (`machine`, `settings`, `audit:`, `bot:`) stay on the log path. */
const OWN_ROW_PREFIXES = ["plugin:"] as const;

/**
 * What of the own table's feed a front end gets: `rows` frames cut to the `plugin:` rows (`after`/`to` stay, so the
 * reader's rev still moves); anything else of the feed (its `reset`, which the log path sends itself) is dropped.
 */
export function ownTableFrame(frame: WireMessage): WireMessage | null {
  if (frame.t !== "rows") return null;
  return { ...frame, rows: frame.rows.filter((row) => OWN_ROW_PREFIXES.some((prefix) => row.key.startsWith(prefix))) };
}

export interface SessionOptions {
  helloTimeoutMs?: number;
  pingAfterMs?: number;
  deadAfterMs?: number;
  /** Bytes waiting to be written (socket buffer, or a remote session's send queue) above which the session is dropped. */
  maxBuffered?: number;
  liveIntervalMs?: number;
  liveClock?: LiveGateClock;
  /** A held `chat.send` waits this long without a new byte of its files before its handler decides (UPLOAD_IDLE_MS). */
  uploadIdleMs?: number;
  /** After a `bye`, the local socket gets this long to write what is queued (the `bye` last) before it is destroyed. */
  byeFlushMs?: number;
}
