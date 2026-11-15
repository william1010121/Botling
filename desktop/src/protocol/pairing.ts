// Botling 3 wire protocol v1: a device pairing offer (protocol-v1.md §4.4) and the local-socket admin requests that
// make and confirm one (M2 brief Q5: the desktop window pairs through the same requests as `botlingd pair`).
//
// The offer travels as a QR code or a link: `<page origin>/v3/#pair=<base64url of its canonical JSON>`. It is in the
// URL fragment, so no server ever receives it (§4.4); its one-time secret is mixed into the `pair` handshake (§5.1).
// An offer lives 5 minutes, works once, and a server holds at most 5 pending.
import { z } from "zod";
import { Id } from "./ids";
import { canonicalJson } from "./entries";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./encoding";
import { ClusterId, MemberId, MemberKeys, RecoveryCode, StatementId } from "./roster";
import { DeviceScope } from "./scopes";
import { PrefKey } from "./prefs";

/** A server join offer's id (`JoinOffer.offer`, join.ts). */
const JoinOfferId = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);

export const PAIR_OFFER_TTL_MS = 5 * 60 * 1000;
export const PAIR_PENDING_LIMIT = 5;
/** The 6-digit code both screens show, derived from the handshake transcript (§4.4 step 3). */
export const PairingCode = z.string().regex(/^[0-9]{6}$/);
/** The one-time secret `P`: 32 random bytes as base64url. */
export const PairSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((text) => fromBase64Url(text)?.length === 32, { message: "not 32 bytes" });

/** Where a device reaches the server (§4.4 step 1). Tailnet: the page's https origin; relay: its WebSocket URL and room. */
export const PairAddresses = z.strictObject({
  tailnet: z.string().max(500).regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/).optional(),
  relay: z.strictObject({ url: z.string().max(500).regex(/^wss?:\/\/[^\s]+$/), room: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).optional(),
}).refine((addresses) => addresses.tailnet !== undefined || addresses.relay !== undefined, { message: "an offer names at least one address" });

export const PairOffer = z.strictObject({
  v: z.literal(1),
  /** The offer's id, so the server can tell its pending offers apart (not secret). */
  offer: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
  server: MemberId,
  name: z.string().min(1).max(100),
  keys: MemberKeys,
  cluster: ClusterId,
  secret: PairSecret,
  expiresAt: z.number().int().nonnegative(),
  addresses: PairAddresses,
});
export type PairOffer = z.infer<typeof PairOffer>;

const FRAGMENT_KEY = "pair=";

/** The link a QR code holds: the page URL with the offer in its fragment. */
export function pairLink(pageUrl: string, offer: PairOffer): string {
  const checked = PairOffer.parse(offer);
  const base = pageUrl.split("#")[0]!;
  return `${base}#${FRAGMENT_KEY}${toBase64Url(utf8Bytes(canonicalJson(checked)))}`;
}

/** The offer in a link or a fragment (`#pair=…`), or null when there is none or it is malformed. */
export function parsePairLink(linkOrFragment: string): PairOffer | null {
  const hash = linkOrFragment.indexOf("#");
  const fragment = hash >= 0 ? linkOrFragment.slice(hash + 1) : linkOrFragment;
  if (!fragment.startsWith(FRAGMENT_KEY) || fragment.length > 4_000) return null;
  const bytes = fromBase64Url(fragment.slice(FRAGMENT_KEY.length));
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  const parsed = PairOffer.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether an offer is past its time. */
export function pairOfferExpired(offer: Pick<PairOffer, "expiresAt">, now: number): boolean {
  return now >= offer.expiresAt;
}

// ---------------------------------------------------------------------------------------------
// Local-socket admin requests (`admin` → `res`, events as `admin.event`). Only the desktop window on this machine and
// `botlingd`'s own CLI send them (§4.3); the role table keeps them off every other session.

export const AdminOp = z.discriminatedUnion("op", [
  /** Make the cluster (first pairing, §4.8): the answer carries the recovery code, shown once and never stored. */
  z.strictObject({ op: z.literal("cluster.create") }),
  /** The recovery code typed back; the cluster exists only after this (M2 step 5). */
  z.strictObject({ op: z.literal("cluster.confirm"), code: RecoveryCode }),
  /** Whether a cluster exists, and the status note while a shown recovery code waits to be typed back (M2 step 5). */
  z.strictObject({ op: z.literal("cluster.status") }),
  /** A new pairing offer; the answer carries the link and its expiry. */
  z.strictObject({ op: z.literal("pair.offer"), name: z.string().min(1).max(100).optional(), scope: z.array(DeviceScope).min(1).max(4).optional() }),
  /** The user compared the 6-digit codes: accept (commit `Add`) or decline. */
  z.strictObject({ op: z.literal("pair.confirm"), offer: PairOffer.shape.offer, accept: z.boolean() }),
  z.strictObject({ op: z.literal("pair.cancel"), offer: PairOffer.shape.offer }),
  z.strictObject({ op: z.literal("devices.list") }),
  z.strictObject({ op: z.literal("device.revoke"), deviceId: MemberId, reason: z.string().max(500).optional() }),
  // Server pairing (§4.5, M3 step 4). On the joining server N: a join offer (the answer carries the link, the code to
  // read off this screen and this server's fingerprint) and its cancel. On the member S: the link opens a pairing
  // session with N (the answer shows both fingerprints), then the code typed off N's screen (three tries).
  z.strictObject({ op: z.literal("join.offer"), name: z.string().min(1).max(100).optional() }),
  z.strictObject({ op: z.literal("join.cancel"), offer: JoinOfferId }),
  z.strictObject({ op: z.literal("machine.add"), link: z.string().min(1).max(4_000) }),
  /** The code as typed (read forgivingly by the server: `JoinCode`); a malformed one costs no try. */
  z.strictObject({ op: z.literal("machine.code"), attempt: JoinOfferId, code: z.string().min(1).max(32) }),
  z.strictObject({ op: z.literal("machine.cancel"), attempt: JoinOfferId }),
  // Server removal (§4.3, D61, M4-05). Local socket only.
  z.strictObject({ op: z.literal("machine.removePreview"), member: z.string().min(1).max(100) }),
  z.strictObject({ op: z.literal("machine.remove"), member: MemberId, cascade: z.boolean(), reason: z.string().max(500).optional() }),
  // Dropped server revocations (D63, §4.8, M4-10). Local socket only.
  z.strictObject({ op: z.literal("roster.dropped") }),
  z.strictObject({ op: z.literal("roster.dismiss"), revokeId: StatementId }),
  // Recovery code replacement (§4.8, M4-12). Local socket only.
  z.strictObject({ op: z.literal("recovery.status") }),
  z.strictObject({ op: z.literal("recovery.replace"), code: z.string().max(64) }),
  z.strictObject({ op: z.literal("recovery.confirm"), code: z.string().max(64) }),
  z.strictObject({ op: z.literal("recovery.cancel") }),
  // Cluster preferences (§17, M3 step 5): a write from the window or CLI on this machine (LWW per key, gossiped to
  // every peer server) and the current registers.
  z.strictObject({ op: z.literal("prefs.set"), key: PrefKey, value: z.unknown() }),
  z.strictObject({ op: z.literal("prefs.list") }),
]);
export type AdminOp = z.infer<typeof AdminOp>;

/** What the server tells the local window about a pairing in progress. */
export const AdminEvent = z.discriminatedUnion("kind", [
  /** A device ran the handshake for this offer: show the code to compare. */
  z.strictObject({ kind: z.literal("pair.code"), offer: PairOffer.shape.offer, code: PairingCode, deviceId: MemberId, deviceName: z.string().min(1).max(100) }),
  /** The device acknowledged its `Add`. */
  z.strictObject({ kind: z.literal("pair.done"), offer: PairOffer.shape.offer, deviceId: MemberId, addId: StatementId }),
  z.strictObject({ kind: z.literal("pair.declined"), offer: PairOffer.shape.offer, reason: z.enum(["code", "expired", "cancelled", "ack lost"]) }),
  /** A device was revoked (here or by gossip later): its sessions were closed. */
  z.strictObject({ kind: z.literal("device.revoked"), deviceId: Id }),
  // Server pairing on the joining server (M3 step 4): who opened the pairing session (show its fingerprint), a wrong
  // code typed there, the join finished, or the offer ended. The code itself is never in an event.
  z.strictObject({ kind: z.literal("join.hello"), offer: JoinOfferId, server: MemberId, name: z.string().min(1).max(100), fingerprint: z.string().max(64) }),
  z.strictObject({ kind: z.literal("join.wrong"), offer: JoinOfferId, left: z.number().int().min(0).max(3) }),
  z.strictObject({ kind: z.literal("join.done"), offer: JoinOfferId, server: MemberId, cluster: ClusterId }),
  z.strictObject({ kind: z.literal("join.declined"), offer: JoinOfferId, reason: z.enum(["code", "expired", "cancelled", "member", "lost"]) }),
]);
export type AdminEvent = z.infer<typeof AdminEvent>;
