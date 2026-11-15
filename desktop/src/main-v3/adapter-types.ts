// What `renderer-adapter.ts` shares with `adapter-entries.ts`: the link port, the options, the per-bot model, the
// notice words, the command sets and the small pure helpers (M7-S95: moved out of renderer-adapter.ts unchanged;
// `renderer-adapter.ts` re-exports every name it exported before). Pure TypeScript: no Electron, no Node built-ins.
import {
  type BotView, type Command, type CommandType, type EventEnvelope as EventEnvelopeT, type MessageView, type ResultOf, type WireError,
} from "../contract";
import {
  slotKey, REFUSE_REASON_TEXT, ProtocolEntryEvent,
  type ConnectionState, type Cursor, type MessageOf, type Outcome, type Slot, type StreamId, type Target, type Via,
} from "../protocol";
import type { SummaryRow } from "../protocol/table-rows";
import type { Clock, ConnModel, FeLinkEvent, OutboxItem, PendingView, ServerView, StoredCursor } from "../fe-link";
import type { ChatView } from "../renderer/store";

/** What the adapter needs of the front-end link (src/fe-link FeLink has it all). */
export interface LinkPort {
  readonly status: ConnModel;
  /** The server's id from `welcome`. */
  readonly server: string | null;
  on(listener: (event: FeLinkEvent) => void): () => void;
  subscribe(stream: StreamId): void;
  unsubscribe(stream: StreamId): void;
  dropCache(stream: StreamId): Promise<void>;
  submit(target: Target, cmd: Command, basis?: Cursor, via?: Via): Promise<OutboxItem>;
  dismiss(slot: Slot): Promise<void>;
  dismissRestored(): void;
  pending(target?: Target): PendingView[];
  cursor(stream: StreamId): StoredCursor | null;
  request(cmd: Command): Promise<unknown>;
  history(stream: StreamId, before: string, bytes?: number): Promise<MessageOf<"history.page">>;
  /** M3 step 11 (FeLink has them; a one-server port may leave them out): every server, the directory, peers' tables. */
  servers?(): ServerView[];
  ownerOf?(target: Target | StreamId): string | null;
  table?(serverId: string): { rows: ReadonlyMap<string, unknown> } | null;
  staleSince?(stream: StreamId): number | null;
}

export type AdapterAnswer = { ok: true; result: unknown } | { ok: false; error: WireError };
export type Snapshot = ResultOf<"chat.snapshot">;
export type ChatSnapshot = NonNullable<Snapshot["chat"]>;

export interface RendererAdapterOptions {
  link: LinkPort;
  /** The renderer port: every event goes to every app window (main's `broadcast`). */
  emit: (envelope: EventEnvelopeT) => void;
  clock: Clock;
  /** A new epoch id (default: random). */
  newEpoch?: () => string;
  /** Bot streams followed at once (the shown one, recently shown ones, and any with pending lines). Default 8. */
  followLimit?: number;
  /** How long a snapshot waits for the bot stream's `snap` before it answers from the server's chat (default 3 s). */
  snapWaitMs?: number;
  /** Before the first attach, how long reads wait for it (default 15 s); later, reads fail at once while detached. */
  firstAttachWaitMs?: number;
  /** "connecting" / "offline" / "catching up" show only after this long (default 400 ms). */
  noticeDelayMs?: number;
  audit?: (text: string) => void;
}

/**
 * Commands that only read (requests on the session, §11.1): no slot, no outcome. `chat.read` and `chat.shown` are
 * idempotent window hints, sent as reads so opening a chat does not write a log entry each time. Anything not listed
 * is a slot. Every server read, `COMMAND_ROUTES` kind "read", must be listed here (a test checks): a slot's result that
 * does not fit one log entry is kept by the owner and fetched with one more round trip (`slot.result`, N2).
 * The phone commands (`COMMAND_ROUTES` kind "local": botlingd's pairing, Settings › Phone) are listed too: botlingd
 * answers them only as a req, and their answers (a pairing link, a recovery code) never enter the durable outbox.
 */
export const READ_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  "chat.snapshot", "chat.history", "chat.read", "chat.shown", "task.output", "subagent.view", "turn.await", "routines.list",
  "results.list", "storage.list", "attachment.file", "link.authorize", "settings.get", "bot.settings", "engine.models", "codex.models",
  "usage.view", "doctor.view", "doctor.run", "mobile.view", "mobile.pair", "mobile.revoke", "mobile.relay", "mobile.cluster", "mobile.confirm", "machines.view", "machines.hosts", "waiting.list", "plugins.list", "plugins.store",
  "plugins.panel", "plugins.web", "plugins.file", "plugins.linkTarget", "plugins.loaded", "plugins.failed", "plugins.notice", "card.image",
  "project.files", "project.preview", "worker.cwd", "agent.targets", "agy.runtime.check", "component.detail", "slot.result",
]);
/** Card answers carry the bot cursor the window showed as `basis` (§11.5). */
export const CARD_COMMANDS: ReadonlySet<string> = new Set(["chat.choose", "chat.answer", "chat.ignoreQuestion", "component.approve"]);
export const PROTOCOL_KINDS: ReadonlySet<string> = new Set(ProtocolEntryEvent.options.map((option) => option.shape.type.value));

/** The id of the connection-state notice line. */
export const NOTICE_ID = "fe-conn-notice";

export const streamOf = (botId: string) => `bot:${botId}` as StreamId;
export const botOfStream = (stream: string) => (stream.startsWith("bot:") ? stream.slice(4) : null);
export const botIdOf = (cmd: Command): string | null => {
  const value = (cmd as { botId?: unknown }).botId;
  return typeof value === "string" ? value : null;
};

/** A short stable id for a pending line, from its slot (FNV-1a, 64 bits as two 32-bit halves). */
export function pendingLineId(slot: Slot): string {
  const text = slotKey(slot);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `fe-p-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function randomEpoch(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `v3-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const hhmm = (ms: number | null) => {
  if (ms === null) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** A backup's time as the notice says it: the date (YYYY-MM-DD) and hh:mm, local time. */
const stamp = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hhmm(ms)}`;
};

/** The words of the notice line for a connection state; null: no notice ("live"). */
export function noticeText(status: ConnModel): string | null {
  switch (status.state) {
    case "live": return null;
    case "connecting": return "Connecting to the Botling server…";
    case "offline": return `Offline${status.asOf !== null ? ` · as of ${hhmm(status.asOf)}` : ""}. New messages wait here and go when the Botling server is back.`;
    case "catching up": return "Catching up…";
    case "history restored":
      if (status.restoredTo != null) return `This machine's history was restored to ${stamp(status.restoredTo)} from a backup. Lines after that are gone.`;
      return `This machine's history was restored from a backup${status.restoredAt !== null ? ` (noticed at ${hhmm(status.restoredAt)})` : ""}. Lines after the backup are gone.`;
    case "update required": return `This Botling window needs an update to use the server${status.minFeVersion ? ` (version ${status.minFeVersion} or later)` : ""}. What you write is kept until then.`;
    default: return `Botling server: ${status.state}.`;
  }
}

/**
 * The notice over a peer's bot while its machine is not live (M3 step 11, §13.3 "one machine stale"): "<machine>
 * offline · as of <time>" over the cached chat, and the messages held for it ("waiting for <machine>", held at the
 * attached server). Null while the owner is live (or is the attached server).
 */
export function peerNoticeText(owner: ServerView | null, attached: ServerView | null, pending: PendingView[], staleSince: number | null = null): string | null {
  if (!owner || owner.self || owner.state === "live") return null;
  const name = owner.name;
  const at = attached?.name ?? "this server";
  const asOf = owner.since ?? staleSince;
  const head = owner.state === "gone" ? `${name} removed · read-only.` : `${name} offline${asOf !== null ? ` · as of ${hhmm(asOf)}` : ""}.`;
  const held = pending.filter((item) => !item.lost && item.waitingFor === name && (item.state === "held" || item.state === "waiting"));
  const heldAt = held.filter((item) => item.state === "held").length;
  const tail = held.length
    ? ` ${held.length} ${held.length === 1 ? "message" : "messages"} waiting for ${name}${heldAt ? ` (held at ${held.find((item) => item.state === "held")?.heldAtName ?? at})` : ""}; ${held.length === 1 ? "it goes" : "they go"} when ${name} is back.`
    : ` New messages are held at ${at} and go when ${name} is back.`;
  return head + tail;
}

/** A summary row of a peer's table as the renderer's bot list shows it (no folder paths: the folder's name only). */
export function botViewOfSummary(botId: string, row: SummaryRow): BotView {
  return {
    id: botId, name: row.name, role: row.role, avatar: row.face?.avatar ?? "circle", folder: row.folderName ?? "",
    phase: row.status === "running" ? "awake" : "asleep", working: row.status === "running", approvals: row.waiting.length,
    unread: row.unread, subagents: 0, problem: row.status === "error" ? "This bot reports an error on its machine." : null,
    heads: [row.engine], job: null, parent: row.parent, subagentRows: [],
    lastActivity: row.lastAt !== null ? new Date(row.lastAt).toISOString() : null,
  } as BotView;
}

/** A byte count as people read it ("1.2 MB"). */
export function sizeText(bytes: number): string {
  if (bytes < 1_000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export const IMMEDIATE_NOTICE: ReadonlySet<ConnectionState> = new Set(["history restored", "update required"]);

export function wireError(outcome: Outcome): WireError {
  switch (outcome.kind) {
    case "refused": {
      const code = outcome.reason === "changed" || outcome.reason === "turn ended" ? "conflict" : outcome.reason === "invalid" ? "bad_request" : "forbidden";
      return { code, message: `Not sent: ${REFUSE_REASON_TEXT[outcome.reason] ?? outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`.slice(0, 2_000) };
    }
    case "cancelled": return { code: "cancelled", message: "Not sent: cancelled." };
    case "skipped": return { code: "cancelled", message: "Not sent: skipped after a restore." };
    default: return { code: "internal", message: "No outcome." };
  }
}

export interface LiveOverlay {
  turnId: string;
  seg: number;
  /** Text of the turn's earlier segments. */
  prefix: string;
  /** The current segment. */
  segText: string;
}

export interface BotModel {
  botId: string;
  stream: StreamId;
  /** A `snap` was applied: `chat` mirrors the renderer's lines. */
  ready: boolean;
  chat: ChatView;
  /** Message ids the renderer may hold for this chat (lines, history pages, pending lines, notice). */
  known: Set<string>;
  /** Each line's text as the log has it (live text not included), for the live overlay. */
  committed: Map<string, string>;
  /** Running turns this stream told of: turnId → the reply line's id. */
  turns: Map<string, string>;
  live: LiveOverlay | null;
  /** A live view that came before its `turn.started`. */
  liveWaiting: { turnId: string; seg: number; text: string } | null;
  /** A snapshot answered without this stream's snap: the snap, when it comes, makes a new epoch. */
  servedFallback: boolean;
  waiters: Array<() => void>;
  shownAt: number;
}

export interface PendingLine { botId: string; id: string; rendered: string }

export function emptyChat(botId: string): ChatView {
  return { botId, messages: [], running: null, live: [], runs: [] };
}

/** How an outbox `chat.send` item is drawn in place (§11.6, §13.4). */
export function pendingLine(item: PendingView): MessageView {
  const cmd = item.cmd as Extract<Command, { type: "chat.send" }>;
  const id = pendingLineId(item.slot);
  const time = new Date(item.createdAt).toISOString();
  if (item.lost) return { id, role: "error", text: `Delivered, then lost when ${item.ownerName ?? "this machine's history"} was restored: ${cmd.text}`, time };
  if (item.state === "not sent") return { id, role: "error", text: `Not sent (${item.reasonText ?? item.reason ?? "refused"}): ${cmd.text}`, time };
  return {
    id, role: "user", text: cmd.text, time,
    ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}),
    // The "sending" marker only after ~150 ms with no outcome (the link says when), so a normal ack never flashes it.
    ...(item.sending && (item.state === "waiting" || item.state === "held") ? { queued: true } : {}),
  };
}
