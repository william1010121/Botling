// Botling 3 wire protocol v1: which side may send what (protocol-v1.md §5.4, D24).
// A message outside the sender's role ends the session with `bye{reason: "role"}`.

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
/** `pair.*` (§4.4): any side, in a pairing session only. The design does not name them yet (M2). */
const PAIR_RULE: RoleRule = rule(true, true, true);
const isPair = (type: string) => /^pair\.[a-z]{1,40}$/.test(type);

/**
 * The role table, one row per message type. §5.4's rows as written, plus the local-socket messages M1 adds
 * (`history.page`, `req`/`res`, `content.find`/`content.found`, `content.open`/`content.file`, `shell.*`). Rows for M2 messages (roster, fetch,
 * prefs, the remote content path) are here so the table is whole; M1 has no schema for them, so a frame
 * naming one is refused as unsupported.
 */
export const ROLE_TABLE: Readonly<Record<string, RoleRule>> = {
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
  "content.get": rule(true, false, true),
  "content.credit": rule(true, false, true),
  "content.cancel": rule(true, false, true),
  "content.ticket": rule(true, false, false),
  "content.put": rule(true, false, false),
  "content.meta": rule(false, true, true),
  "content.chunk": rule(false, true, true),
  "content.gone": rule(false, true, true),
  peer: rule(false, true, false),
  "roster.have": rule(false, false, true),
  "roster.ids": rule(false, false, true),
  "roster.want": rule(false, false, true),
  "roster.statements": rule(false, false, true),
  "roster.revocations": rule(false, false, true),
  "prefs.have": rule(false, false, true),
  "prefs.rows": rule(false, false, true),
  "fetch.ask": rule(false, false, true),
  "fetch.grant": rule(false, false, true),
  "fetch.chunk": rule(false, false, true),
  "fetch.done": rule(false, false, true),
  "fetch.denied": rule(false, false, true),
  ping: rule(true, true, true),
  bye: rule(true, true, true),
  // Local socket only (M1).
  req: rule(true, false, false, { localOnly: true }),
  res: rule(false, true, false, { localOnly: true }),
  "content.find": rule(true, false, false, { localOnly: true }),
  "content.found": rule(false, true, false, { localOnly: true }),
  "content.open": rule(true, false, false, { localOnly: true }),
  "content.file": rule(false, true, false, { localOnly: true }),
  "shell.screenshot": rule(false, true, false, { localOnly: true }),
  "shell.browser": rule(false, true, false, { localOnly: true }),
  "shell.install": rule(false, true, false, { localOnly: true }),
  "shell.quit": rule(false, true, false, { localOnly: true }),
  "shell.done": rule(true, false, false, { localOnly: true }),
};

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
  if (session.pairing && !isPair(type) && type !== "bye" && type !== "ping") return `a pairing session carries only pair.*, ping and bye`;
  return null;
}
