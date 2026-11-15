// The types of the front end's link (M7-S94, moved from link.ts): the socket, clock and options, the events the link
// emits, the views the UI renders, the session and the constants the stream half shares with the shell; plus `LinkHost`,
// the names `LinkStreams` (link-streams.ts) borrows from `FeLink`.
import type { Command } from "../contract";
import type { Cursor, DeliveryState, MessageOf, Message, OriginEpoch, ServerAddresses, ServerState, Slot, StreamId, Entry, Target } from "../protocol";
import type { ResAssembler } from "../protocol";
import type { LiveReceiver, LiveSegmentView } from "../server/live/receiver";
import type { ConnModel } from "./connection-state";
import type { StreamCursors } from "./cursors";
import type { OwnRows } from "./own-rows";
import type { Outbox } from "./outbox";
import type { TableCopies } from "./tables";
import type { FeStorage, OutboxItem, SerialWriter } from "./storage";

/** One transport connection. Frames are whole messages (a byte-stream transport packs them with `packFrame`). */
export interface FeSocket {
  send(frame: string): void;
  /** A binary frame (an upload's `content.chunk`, M2 step 12) on the bulk lane; absent: the transport carries none. */
  sendBytes?(frame: Uint8Array): void;
  close(): void;
}
/** What a content read hears from the server (M2 step 14). */
export type ContentReadMessage = MessageOf<"content.meta"> | MessageOf<"content.chunk"> | MessageOf<"content.gone">;

export interface SocketHandlers {
  open(): void;
  frame(frame: string | Uint8Array): void;
  close(detail?: string): void;
}
/** Opens a connection; reports through the handlers (open may come before or after it returns). */
export type Dial = (handlers: SocketHandlers) => FeSocket;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FeLinkOptions {
  storage: FeStorage;
  dial: Dial;
  /** The origin of this front end's slots (§2). */
  deviceId: string;
  feVersion: string;
  /** The local token (local socket, §6.1). */
  token?: string;
  /** The session runs on the local socket (default true). */
  local?: boolean;
  clock?: Clock;
  newEpoch?: () => OriginEpoch;
  /** Reconnect backoff (default 250 ms doubling to 5 s). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Without a session this long, "connecting" turns "offline" (default 10 s). */
  offlineAfterMs?: number;
  /** §5.2: ping after 15 s of sending nothing; no frame for 45 s ends the session. */
  pingAfterMs?: number;
  deadAfterMs?: number;
  /**
   * M3 step 11: a peer's `srv:` table the attached server has no copy of (no catch-up comes) stops holding the outbox
   * after this long (default 5 s); a table the front end had is always waited for.
   */
  absentTableMs?: number;
  /** §13.4: the "sending" marker shows only after this long without `held` or an outcome (default 150 ms). */
  sendingMarkerMs?: number;
}

export type FeLinkEvent =
  | { type: "state"; status: ConnModel }
  | { type: "pending" }
  /** An item got its outcome (also for items removed right away). */
  | { type: "outcome"; item: OutboxItem }
  | { type: "snap"; snap: MessageOf<"snap"> }
  | { type: "entries"; stream: StreamId; entries: Entry[] }
  | { type: "reset"; reset: MessageOf<"reset"> }
  /** The stream's cache must be dropped (hash mismatch); a snap follows. */
  | { type: "dropped"; stream: StreamId; why: string }
  | { type: "live"; stream: StreamId; view: LiveSegmentView | null; stale: boolean }
  /** Any other server message (stale, peer, shell.*, content.*). */
  | { type: "message"; message: Message }
  /** A session was welcomed (true) or ended (false): uploads (M2 step 12) put again from what the server has. */
  | { type: "attached"; attached: boolean }
  /**
   * M3 step 11: what the link knows of the servers changed: a server's state (`welcome.servers`, `peer`), a peer's
   * `srv:` table (`table`: its stream, the row keys changed and removed), or a stream served from the attached server's
   * cache (`stale`).
   */
  | { type: "servers"; table?: { stream: string; changed: string[]; removed: string[] } }
  /** The server ended the session with `bye` (M2 step 11: `revoked` tells the page to drop what it cached). */
  | { type: "bye"; reason: string; detail?: string }
  | { type: "error"; error: unknown };

/** An outbox item as the UI renders it in place (§11.6, §13.4). */
export interface PendingView {
  key: string;
  slot: Slot;
  cmd: Command;
  basis?: Cursor;
  state: DeliveryState;
  heldAt?: string;
  /** For "not sent": refused reason, "cancelled" or "skipped". */
  reason?: string;
  /** For "not sent": the reason's words when it has words of its own (`REFUSE_REASON_TEXT`, e.g. `grant`, N2). */
  reasonText?: string;
  /** "delivered, then lost when <machine> was restored" (D50). */
  lost: boolean;
  /** Show the "sending" marker (waiting longer than ~150 ms). */
  sending: boolean;
  /** The owner committed this item's cancel (D59 `cancel.noted`): its outcome will be "cancelled". */
  cancelNoted?: true;
  /** D67: 5 consecutive sessions ended `unsettled` on this slot; stopped sending until the user gives up. */
  stopped?: true;
  createdAt: number;
  /** M3 step 11: the server that owns the target (the directory), and its name and state as the attached server says. */
  owner?: string;
  ownerName?: string;
  /** The name of the server that holds it (`heldAt`): "held at <S>". */
  heldAtName?: string;
  /** "waiting for <machine>": unresolved while its owner is stale or gone (§11.6). */
  waitingFor?: string;
}

/** A server as the attached server sees it (`welcome.servers`, `peer`, v1 §10.5). */
export interface ServerView { id: string; name: string; state: ServerState; since: number | null; self: boolean; dh?: string; addresses?: ServerAddresses }

/** How many settled delivered items the link remembers for a later reset (D50, M3 step 11). */
const SETTLED_KEPT = 200;
/** D67: consecutive `bye{unsettled}` endings on the same slot before the FE stops sending it. */
const UNSETTLED_STOP_AFTER = 5;

const TURN_END = new Set(["turn.finished", "turn.interrupted", "turn.cancelled"]);

interface Session {
  socket: FeSocket | null;
  openedEarly: boolean;
  helloSent: boolean;
  welcomed: boolean;
  closed: boolean;
  /** Slots sent on this session (each unresolved item goes once per session, again after cmd.retry). */
  sent: Set<string>;
}

interface PendingRequest { resolve(value: never): void; reject(error: Error): void; kind: "res" | "history.page" | "content"; stream?: string }
/** What a content request is answered with (§9A.4, local part). */
export type ContentAnswer = MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">;
/** What a remote page's content request is answered with (§9A.4 tailnet part, M2 step 9). */
export type RemoteContentAnswer = MessageOf<"content.located"> | MessageOf<"content.granted"> | MessageOf<"content.gone">;

export { SETTLED_KEPT, UNSETTLED_STOP_AFTER, TURN_END };
export type { Session, PendingRequest };

export function cleanServerAddresses(addresses?: ServerAddresses): ServerAddresses | undefined {
  if (!addresses) return undefined;
  const out: ServerAddresses = {};
  if (addresses.tailnet) out.tailnet = addresses.tailnet;
  if (addresses.relay) out.relay = addresses.relay;
  return out.tailnet || out.relay ? out : undefined;
}

/** The timers a link keeps (the one object `FeLink` and `LinkStreams` both arm and clear). */
export interface LinkTimers { reconnect?: unknown; offline?: unknown; ping?: unknown; dead?: unknown; absentTable?: unknown }

/** What the stream half borrows from `FeLink`: its state (the fields written by both halves have a setter) and the few methods that stay there. */
export interface LinkHost {
  readonly options: FeLinkOptions;
  readonly clock: Clock;
  readonly writer: SerialWriter;
  readonly outbox: Outbox;
  readonly cursors: StreamCursors;
  readonly tables: TableCopies;
  readonly ownRows: OwnRows;
  readonly receiver: LiveReceiver;
  readonly liveStale: Set<string>;
  readonly subs: Set<StreamId>;
  readonly listeners: Set<(event: FeLinkEvent) => void>;
  readonly requests: Map<string, PendingRequest>;
  readonly resParts: ResAssembler;
  readonly contentReaders: Map<string, (message: ContentReadMessage | null) => void>;
  readonly visibleAt: Map<string, number>;
  readonly cancelNoted: Set<string>;
  readonly unsettledCounts: Map<string, number>;
  readonly unsettledStopped: Set<string>;
  readonly serverViews: Map<string, ServerView>;
  readonly staleStreams: Map<string, number>;
  readonly timers: LinkTimers;
  session: Session | null;
  conn: ConnModel;
  settledRecent: OutboxItem[];
  backoff: number;
  lastByeUnsettled: boolean;
  reqCounter: number;
  readonly serverId: string | null;
  readonly stopped: boolean;
  readonly final: boolean;
  readonly local: boolean;
  send(session: Session, message: Message): boolean;
  sendSub(session: Session, stream: StreamId): void;
  srvStream(): StreamId | null;
  streams(): StreamId[];
  ownerOf(target: Target | StreamId): string | null;
  dial(): void;
}
