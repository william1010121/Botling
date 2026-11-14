// Botling 3 wire protocol v1: which side may send what (protocol-v1.md §5.4, D24).
// A message outside the sender's role ends the session with `bye{reason: "role"}`.
import type { WireMessageType } from "./messages-m3";

/** Who sends a frame, on which kind of session. */
export type Sender =
  | "fe"      // a front end to its attached server
  | "server"  // a server to an attached front end
  | "peer";   // a server to another server

export interface RoleRule {
  /** FE → server. */
  fe: boolean;
  /** server → FE. */
  server: boolean;
  /** server ↔ server. */
  peer: boolean;
  /** Only on the local socket (the desktop window and its own server, §6.1). */
  localOnly?: true;
}

const rule = (fe: boolean, server: boolean, peer: boolean, extra: Partial<RoleRule> = {}): RoleRule => ({ fe, server, peer, ...extra });
/** Other `pair.*` messages (server pairing, §4.5, M3): any side, in a pairing session only; no schema yet. */
const PAIR_RULE: RoleRule = rule(true, true, true);
const isPair = (type: string) => /^pair\.[a-z]{1,40}$/.test(type);
/** `join.*` (server pairing, §4.5, M3): peer servers, in a pairing session only. */
const isJoin = (type: string) => type.startsWith("join.");

/**
 * The role table, one row per message type. §5.4's rows as written, plus:
 * - M1's local-socket messages (`history.page`, `content.find`/`content.found`, `content.open`/`content.file`, `shell.*`);
 * - M2: `req`/`res` opened to remote front ends (a v1 addition, M2 brief Q2: what a remote `req` may name is the
 *   read allowlist in scopes.ts, checked by the remote session); uploads, so `content.chunk` also goes FE → server and
 *   `content.credit` server → FE; the URL ticket answer `content.granted` and the upload answer `content.stored`
 *   (server → FE); the device pairing messages; and the local-only `admin` requests and `admin.event`.
 * - M3 (a second server): the table-stream batch `rows` (server → FE and server ↔ server), `prefs.ids` / `prefs.want`
 *   beside `prefs.have` / `prefs.rows` (server ↔ server), and server pairing `join.*` (peer servers, pairing session only).
 *   The forwarded rows (`sub`/`ack`/`history`/`cmd`/`cancel`, `batch`/`snap`/`reset`/`stale`, `held`/`cmd.result`/
 *   `cmd.retry`, `content.get/credit/cancel/meta/chunk/gone`) were in the server ↔ server column since M1/M2.
 * - D59: `cancel.noted`, the answer to a `cancel` that came before its slot was decided (server → FE, and server ↔
 *   server for the forwarding server's `forwardq`).
 * Rows for messages that have no schema yet (`fetch.*`) are here so the table is whole; a frame naming one is refused
 * as unsupported. `ROLE_ROWS` must hold a row for every message type (checked by the compiler below).
 */
const ROLE_ROWS = {
  hello: rule(true, false, true),
  welcome: rule(false, true, true),
  sub: rule(true, false, true),
  unsub: rule(true, false, true),
  ack: rule(true, false, true),
  history: rule(true, false, true),
  "history.page": rule(false, true, true),
  batch: rule(false, true, true),
  snap: rule(false, true, true),
  reset: rule(false, true, true),
  stale: rule(false, true, true),
  live: rule(false, true, true),
  "live.resync": rule(true, false, true),
  cmd: rule(true, false, true),
  cancel: rule(true, false, true),
  held: rule(false, true, true),
  "cmd.result": rule(false, true, true),
  "cmd.retry": rule(false, true, true),
  "cancel.noted": rule(false, true, true),
  "content.get": rule(true, false, true),
  "content.credit": rule(true, true, true),
  "content.cancel": rule(true, false, true),
  "content.ticket": rule(true, false, false),
  "content.granted": rule(false, true, false),
  "content.put": rule(true, false, false),
  "content.stored": rule(false, true, false),
  "content.meta": rule(false, true, true),
  "content.chunk": rule(true, true, true),
  "content.gone": rule(false, true, true),
  peer: rule(false, true, false),
  "roster.have": rule(false, false, true),
  "roster.ids": rule(false, false, true),
  "roster.want": rule(false, false, true),
  "roster.statements": rule(false, false, true),
  "roster.revocations": rule(false, false, true),
  "prefs.have": rule(false, false, true),
  "prefs.ids": rule(false, false, true),
  "prefs.want": rule(false, false, true),
  "prefs.rows": rule(false, false, true),
  // A table stream's rows (M3, §8.2): to front ends, and between servers.
  rows: rule(false, true, true),
  // Server pairing (§4.5, M3), in a pairing session between two servers only.
  "join.hello": rule(false, false, true),
  "join.code": rule(false, false, true),
  "join.wrong": rule(false, false, true),
  "join.checked": rule(false, false, true),
  "join.welcome": rule(false, false, true),
  "join.done": rule(false, false, true),
  "join.declined": rule(false, false, true),
  "fetch.ask": rule(false, false, true),
  "fetch.grant": rule(false, false, true),
  "fetch.chunk": rule(false, false, true),
  "fetch.done": rule(false, false, true),
  "fetch.denied": rule(false, false, true),
  ping: rule(true, true, true),
  bye: rule(true, true, true),
  // Device pairing (§4.4), in a pairing session only.
  "pair.hello": rule(true, false, false),
  "pair.added": rule(false, true, false),
  "pair.ack": rule(true, false, false),
  "pair.declined": rule(true, true, false),
  // Reads with no slot (§11.1): the local socket, and remote front ends within the read allowlist (M2).
  req: rule(true, false, false),
  res: rule(false, true, false),
  // A `res` over the frame limit, cut into parts (demo fix): wherever a `res` may go.
  "res.part": rule(false, true, false),
  // Local socket only (M2): pairing and revoking from the desktop window or the CLI (§4.3).
  admin: rule(true, false, false, { localOnly: true }),
  "admin.event": rule(false, true, false, { localOnly: true }),
  // Local socket only (M1).
  "content.find": rule(true, false, false, { localOnly: true }),
  "content.found": rule(false, true, false, { localOnly: true }),
  "content.open": rule(true, false, false, { localOnly: true }),
  "content.file": rule(false, true, false, { localOnly: true }),
  "shell.screenshot": rule(false, true, false, { localOnly: true }),
  "shell.browser": rule(false, true, false, { localOnly: true }),
  "shell.install": rule(false, true, false, { localOnly: true }),
  "shell.quit": rule(false, true, false, { localOnly: true }),
  "shell.done": rule(true, false, false, { localOnly: true }),
} satisfies Record<string, RoleRule>;

/** The role table, one row per message type. */
export const ROLE_TABLE: Readonly<Record<string, RoleRule>> = ROLE_ROWS;
// The table stays total: a message type of any registry without a row is a compile error here.
const _everyMessageHasARow: Record<WireMessageType, RoleRule> = ROLE_ROWS;
void _everyMessageHasARow;

/** What a session is: who sends, whether it runs on the local socket, whether it is a pairing session. */
export interface SessionKind {
  local: boolean;
  pairing?: boolean;
}

/** Whether the role table knows this message type (a row, or `pair.*`). */
export function knownType(type: string): boolean {
  return Object.hasOwn(ROLE_TABLE, type) || isPair(type);
}

/** Why a message type may not be sent here, or null when it may. */
export function roleRefusal(type: string, sender: Sender, session: SessionKind): string | null {
  const row = Object.hasOwn(ROLE_TABLE, type) ? ROLE_TABLE[type]! : isPair(type) ? PAIR_RULE : null;
  if (!row) return `unknown message "${type}"`;
  if (!row[sender]) return `a ${sender === "fe" ? "front end" : sender === "server" ? "server (to a front end)" : "peer server"} may not send "${type}"`;
  if (row.localOnly && !session.local) return `"${type}" is only for the local socket`;
  if (isPair(type) && !session.pairing) return `"${type}" is only for a pairing session`;
  if (isJoin(type) && !session.pairing) return `"${type}" is only for a server pairing session`;
  if (session.pairing && !isPair(type) && !isJoin(type) && type !== "bye" && type !== "ping") return `a pairing session carries only pair.*, join.*, ping and bye`;
  return null;
}
