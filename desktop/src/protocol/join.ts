// Botling 3 wire protocol v1: pairing a server N through a member server S (protocol-v1.md §4.5, D46).
//
// 1. On N, `botlingd join` prints N's name, fingerprint, a code (`53RV-XFK8`) and a link holding the join offer
//    (N's id, keys, addresses and a one-time secret mixed into the handshake, as a device pairing offer, §4.4). The code
//    is not in the link: the user reads it off N and types it into S.
// 2. S (`botlingd add-machine <link>`, or the desktop window over the local socket) runs the pairing handshake with N;
//    both say who they are (`join.hello`), both show the other's fingerprint.
// 3. S sends the typed code (`join.code`); N answers `join.wrong{left}`, `join.declined{code}` on the third wrong one,
//    or `join.checked`.
// 4. S commits `Add{N, server, by S}` and sends it with the full statement set, the cluster VAPID key and the
//    preferences (`join.welcome`). N takes the cluster id, commits `Add{S, server, by N}` and the statements, endorses
//    every member it finds valid, then answers `join.done{add}`; S stores N's `Add`. Both commits happen before either
//    side calls the pairing done; a retry after a cut repeats the same statements (same ids) or is declined.
// 5. A server joins only while it has no other members (`join.declined{member}`); N never becomes the root.
//
// Every `join.*` message travels in a pairing session between two servers (sender "peer"), never anywhere else.
import { z } from "zod";
import { canonicalJson } from "./entries";
import { fromBase64Url, toBase64Url, utf8Bytes } from "./encoding";
import { PROTOCOL_VERSION } from "./ids";
import { PairSecret } from "./pairing";
import { PrefRow } from "./prefs";
import { ClusterId, MemberId, MemberKeys, PublicKey, Signature, SignedStatement } from "./roster";

/** A join offer lives as long as a device pairing offer (§20: 5 min, single use). */
export const JOIN_OFFER_TTL_MS = 5 * 60 * 1000;
/** Wrong codes before the join is declined (§4.5). */
export const JOIN_CODE_TRIES = 3;
/** The most statements one `join.welcome` carries (v1: tens; the frame limit applies as well). */
export const JOIN_ROSTER_LIMIT = 500;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The code N shows and the user types into S: 8 characters of Crockford base32 (`53RV-XFK8`). Typed text is read
 * forgivingly: case, spaces and dashes do not matter, O reads as 0 and I or L as 1.
 */
export const JoinCode = z.string().max(32)
  .transform((text) => text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1"))
  .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/));

/** A join code in its shown form, `XXXX-XXXX`, from 5 random bytes (40 bits). */
export function joinCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 5) throw new RangeError("a join code is made of 5 bytes");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  for (let i = 0; i < 8; i++) { text = CODE_ALPHABET[Number(value & 31n)]! + text; value >>= 5n; }
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

/** Where S reaches N: WebSocket URLs (loopback in tests; tailnet or relay paths are M4). */
export const JoinAddresses = z.array(z.string().max(500).regex(/^wss?:\/\/[^\s/]+(\/[^\s]*)?$/)).min(1).max(8);

export const JoinOffer = z.strictObject({
  v: z.literal(1),
  offer: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
  server: MemberId,
  name: z.string().min(1).max(100),
  keys: MemberKeys,
  secret: PairSecret,
  expiresAt: z.number().int().nonnegative(),
  addresses: JoinAddresses,
});
export type JoinOffer = z.infer<typeof JoinOffer>;

const LINK_PREFIX = "botling-join:";

/** The link `botlingd join` prints: `botling-join:` and the offer's canonical JSON in base64url. */
export function joinLink(offer: JoinOffer): string {
  return LINK_PREFIX + toBase64Url(utf8Bytes(canonicalJson(JoinOffer.parse(offer))));
}

/** The offer in a join link, or null when it is not one or is malformed. */
export function parseJoinLink(link: string): JoinOffer | null {
  const text = link.trim();
  if (!text.startsWith(LINK_PREFIX) || text.length > 4_000) return null;
  const bytes = fromBase64Url(text.slice(LINK_PREFIX.length));
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  const parsed = JoinOffer.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether a join offer is past its time. */
export function joinOfferExpired(offer: Pick<JoinOffer, "expiresAt">, now: number): boolean {
  return now >= offer.expiresAt;
}

/**
 * A server's fingerprint as both screens show it: its member id (130 bits of the SHA-256 of its signing key, §3) in
 * upper case, in groups of four.
 */
export function memberFingerprint(memberId: string): string {
  const id = MemberId.parse(memberId).toUpperCase();
  return id.match(/.{1,4}/g)!.join(" ");
}

/** The cluster's Web Push key pair (§18.4): P-256, the public key uncompressed (65 bytes), the private scalar (32 bytes). */
export const VapidPublicKey = z.string().regex(/^[A-Za-z0-9_-]{87}$/).refine((text) => { const bytes = fromBase64Url(text); return bytes?.length === 65 && bytes[0] === 4; }, { message: "an uncompressed P-256 point" });
export const VapidKeys = z.strictObject({
  publicKey: VapidPublicKey,
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((text) => fromBase64Url(text)?.length === 32, { message: "a 32-byte scalar" }),
});
export type VapidKeys = z.infer<typeof VapidKeys>;

const ServerAdd = SignedStatement.refine((statement) => statement.body.type === "add" && statement.body.kind === "server", { message: "a server's Add" });
const msg = <T extends string, S extends z.core.$ZodLooseShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

/**
 * Each side names itself and proves its signing key (`proof`: Ed25519 over the handshake transcript hash, as
 * `pair.hello`). `cluster` is the sender's cluster (null: none yet); `members` how many other members its roster holds.
 */
export const JoinHello = msg("join.hello", {
  name: z.string().min(1).max(100), sign: PublicKey, proof: Signature, version: z.string().min(1).max(40).regex(/^[0-9A-Za-z.+-]+$/),
  protocol: z.literal(PROTOCOL_VERSION), cluster: ClusterId.nullable(), members: z.number().int().nonnegative().max(100_000),
});
/** S → N: the code the user typed. */
export const JoinCodeMsg = msg("join.code", { code: JoinCode });
/** N → S: the code was wrong; `left` tries remain. */
export const JoinWrong = msg("join.wrong", { left: z.number().int().min(1).max(JOIN_CODE_TRIES - 1) });
/** N → S: the code was right. */
export const JoinChecked = msg("join.checked", {});
/** S → N: S committed N's `Add`; the statements, the cluster VAPID key and the preferences. */
export const JoinWelcome = msg("join.welcome", {
  add: ServerAdd,
  roster: z.array(SignedStatement).min(1).max(JOIN_ROSTER_LIMIT),
  vapid: VapidKeys,
  prefs: z.array(PrefRow).max(500),
});
/** N → S: N committed S's `Add` and the statements, and wrote its endorsements. */
export const JoinDone = msg("join.done", { add: ServerAdd });
/** Either side ends the join. `member`: N already has members; `cluster`: S has no cluster to offer. */
export const JoinDeclined = msg("join.declined", { reason: z.enum(["code", "expired", "used", "busy", "cancelled", "member", "cluster", "unsupported"]) });
