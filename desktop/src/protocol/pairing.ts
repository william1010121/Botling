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
  /** A new pairing offer; the answer carries the link and its expiry. */
  z.strictObject({ op: z.literal("pair.offer"), name: z.string().min(1).max(100).optional(), scope: z.array(DeviceScope).min(1).max(4).optional() }),
  /** The user compared the 6-digit codes: accept (commit `Add`) or decline. */
  z.strictObject({ op: z.literal("pair.confirm"), offer: PairOffer.shape.offer, accept: z.boolean() }),
  z.strictObject({ op: z.literal("pair.cancel"), offer: PairOffer.shape.offer }),
  z.strictObject({ op: z.literal("devices.list") }),
  z.strictObject({ op: z.literal("device.revoke"), deviceId: MemberId, reason: z.string().max(500).optional() }),
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
]);
export type AdminEvent = z.infer<typeof AdminEvent>;
