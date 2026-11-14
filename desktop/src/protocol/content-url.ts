// Botling 3 wire protocol v1: the tailnet content URL and its ticket (protocol-v1.md §9A.4, §9A.7).
//
// Deviation from v1 (M2 brief Q1, decided by the coordinator): v1 §9A.4 gives the page a `__Host-` device cookie
// (`SameSite=Strict`). The chat runs in a sandboxed, opaque-origin frame, which sends no such cookie, so a remote
// front end gets a short-lived **URL ticket** instead:
//   - the page asks over its session: `content.ticket{req, owner, id, entry}` → `content.granted{req, ticket, expiresAt}`;
//   - the ticket is bound to (device, owner, content id, entry), lives 10 minutes, and is asked for again while the
//     session lives;
//   - the server re-checks on every request that the ticket is known and unexpired, that the device is still valid
//     (§4.6) with `read`, and that the entry still references the id (§9A.7), exactly as it would for the cookie;
//   - a ticket is never logged (`contentUrlForLog` drops it) and is random: it carries no claim of its own.
// URL: `/v3/c/<owner>/<id>/<variant>?e=<stream>.<seq>&t=<ticket>`.
import { z } from "zod";
import { ContentId, Id, Seq, ServerId, StreamId } from "./ids";

/** A content ticket: 32 random bytes as base64url. */
export const ContentTicket = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type ContentTicket = z.infer<typeof ContentTicket>;
/** How long a ticket lives (Q1: 10 minutes). */
export const CONTENT_TICKET_TTL_MS = 10 * 60 * 1000;
/** A variant's name in a content URL (`original`, `poster`, `preview`, `thumb`, …). */
export const VariantName = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/);
/** The entry that holds a reference: the proof of reference (§9A.7). */
export const EntryRef = z.strictObject({ stream: StreamId, seq: Seq.min(1) });
export type EntryRef = z.infer<typeof EntryRef>;

/** What the server keeps for a ticket it gave out (in memory, never in a log). */
export const ContentTicketGrant = z.strictObject({
  ticket: ContentTicket, deviceId: Id, owner: ServerId, id: ContentId, entry: EntryRef, expiresAt: z.number().int().nonnegative(),
});
export type ContentTicketGrant = z.infer<typeof ContentTicketGrant>;

/** The parts of a tailnet content URL. */
export interface ContentUrl {
  owner: string;
  id: string;
  variant: string;
  entry: EntryRef;
  ticket?: string;
}

/** The prefix every content URL starts with. */
export const CONTENT_URL_PREFIX = "/v3/c/";

/** The path (with query) a player loads for a reference (§9A.4). */
export function contentUrlPath(url: ContentUrl): string {
  const query = `e=${encodeURIComponent(`${url.entry.stream}.${url.entry.seq}`)}${url.ticket ? `&t=${url.ticket}` : ""}`;
  return `${CONTENT_URL_PREFIX}${encodeURIComponent(url.owner)}/${encodeURIComponent(url.id)}/${encodeURIComponent(url.variant)}?${query}`;
}

/** Parses a content URL's path and query; null when it is not one (every part checked, nothing extra allowed). */
export function parseContentUrl(pathAndQuery: string): ContentUrl | null {
  if (!pathAndQuery.startsWith(CONTENT_URL_PREFIX)) return null;
  const mark = pathAndQuery.indexOf("?");
  if (mark < 0) return null;
  const parts = pathAndQuery.slice(CONTENT_URL_PREFIX.length, mark).split("/");
  if (parts.length !== 3) return null;
  let owner: string, id: string, variant: string;
  try { [owner, id, variant] = parts.map((part) => decodeURIComponent(part)) as [string, string, string]; } catch { return null; }
  if (!ServerId.safeParse(owner).success || !ContentId.safeParse(id).success || !VariantName.safeParse(variant).success) return null;
  const query = new URLSearchParams(pathAndQuery.slice(mark + 1));
  for (const key of query.keys()) if (key !== "e" && key !== "t") return null;
  if (query.getAll("e").length !== 1 || query.getAll("t").length > 1) return null;
  const e = query.get("e")!;
  const dot = e.lastIndexOf(".");
  if (dot < 0 || !/^[1-9][0-9]{0,15}$/.test(e.slice(dot + 1))) return null;
  const entry = EntryRef.safeParse({ stream: e.slice(0, dot), seq: Number(e.slice(dot + 1)) });
  if (!entry.success) return null;
  const ticket = query.get("t");
  if (ticket !== null && !ContentTicket.safeParse(ticket).success) return null;
  return { owner, id, variant, entry: entry.data, ...(ticket !== null ? { ticket } : {}) };
}

/** A content URL as it may be written to a log: the ticket is replaced, never kept. */
export function contentUrlForLog(pathAndQuery: string): string {
  return pathAndQuery.replace(/([?&]t=)[^&#]*/g, "$1<ticket>");
}
