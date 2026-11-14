// Botling 3 wire protocol v1: roster statements, their canonical bytes, ids and signatures (protocol-v1.md §3, §4.1).
// The rules about which statements count (§4.2 validity, the root chain of §4.8) are the server's (src/server/roster);
// this file only says what a statement is and the exact bytes everyone signs, hashes and checks.
//
// - A statement's canonical bytes: `ROSTER_DOMAIN` then the canonical JSON of its body (keys sorted, no spaces, §8.1).
// - Its id: SHA-256 of those bytes, as 64 hex digits. The signature is not part of the id, so one body has one id
//   whoever signed it, and duplicates collapse (§4.1).
// - Its signature: Ed25519 over the same bytes, by `body.by` (Add, Endorse, Revoke), by the recovery key (Root), or by
//   the member itself or any server (Profile).
// - A member's id (server or device): the first 26 characters of the lower-case base32 SHA-256 of its raw Ed25519
//   public key (§3). The cluster id: the first 16 bytes of SHA-256("botling-cluster" ‖ raw recovery public key), hex.
import { z } from "zod";
import { canonicalJson } from "./entries";
import { fromBase64Url, sha256, toBase32, toHex, utf8Bytes } from "./encoding";
import { EntryHash, Hlc } from "./ids";
import { DeviceScope } from "./scopes";

/** The text in front of every statement's canonical JSON: a roster statement of protocol v1, never anything else. */
export const ROSTER_DOMAIN = "botling/3 roster v1\n";

/** A raw 32-byte public key (Ed25519 or X25519) as base64url. */
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((text) => fromBase64Url(text)?.length === 32, { message: "not a 32-byte key" });
/** A 64-byte Ed25519 signature as base64url. */
export const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/).refine((text) => fromBase64Url(text)?.length === 64, { message: "not a 64-byte signature" });
/** A member's id (§3): 26 lower-case base32 characters (130 bits of the SHA-256 of its signing key). */
export const MemberId = z.string().regex(/^[a-z2-7]{26}$/);
/** The cluster id (§3): 16 bytes as 32 lower-case hex digits. */
export const ClusterId = z.string().regex(/^[0-9a-f]{32}$/);
/** A statement id: SHA-256 of its canonical bytes. */
export const StatementId = EntryHash;
/** A member's two public keys. */
export const MemberKeys = z.strictObject({ sign: PublicKey, dh: PublicKey });

const uniqueScopes = (scopes: readonly string[]) => new Set(scopes).size === scopes.length;

/** `Add{cluster, member, kind, keys, name, scope, by, at}` (§4.1): a server adds a server or a device. */
export const AddStatement = z.strictObject({
  type: z.literal("add"),
  cluster: ClusterId,
  member: MemberId,
  kind: z.enum(["server", "device"]),
  keys: MemberKeys,
  name: z.string().min(1).max(100),
  /** A device's scopes (§11.7); a server has none (it acts with `manage` on other servers' bots). */
  scope: z.array(DeviceScope).min(1).max(4).refine(uniqueScopes, { message: "a scope is listed once" }).optional(),
  by: MemberId,
  at: z.number().int().nonnegative(),
}).superRefine((add, ctx) => {
  if (add.kind === "device" && !add.scope) ctx.addIssue({ code: "custom", path: ["scope"], message: "a device's Add states its scope" });
  if (add.kind === "server" && add.scope) ctx.addIssue({ code: "custom", path: ["scope"], message: "a server's Add has no scope" });
  if (add.member === add.by) ctx.addIssue({ code: "custom", path: ["by"], message: "a member does not add itself" });
});
/** `Endorse{cluster, member, addId, by}`: a server found the member valid and keeps it valid (§4.2). */
export const EndorseStatement = z.strictObject({ type: z.literal("endorse"), cluster: ClusterId, member: MemberId, addId: StatementId, by: MemberId });
/** `Revoke{cluster, member, reason, by, gen, cascade}` (§4.6); `gen` is the root generation its signer held. */
export const RevokeStatement = z.strictObject({
  type: z.literal("revoke"),
  cluster: ClusterId,
  member: MemberId,
  reason: z.string().max(500),
  by: MemberId,
  gen: z.number().int().min(1),
  cascade: z.array(MemberId).max(1_000),
}).superRefine((revoke, ctx) => {
  if (new Set(revoke.cascade).size !== revoke.cascade.length) ctx.addIssue({ code: "custom", path: ["cascade"], message: "a member is listed once" });
  if (revoke.cascade.includes(revoke.member)) ctx.addIssue({ code: "custom", path: ["cascade"], message: "the revoked member is not in its own cascade" });
});
/** `Root{cluster, gen, root, recoveryPub, keep, prev}` (§4.8): signed by the recovery key; gen 1 has no prev and keeps nothing. */
export const RootStatement = z.strictObject({
  type: z.literal("root"),
  cluster: ClusterId,
  gen: z.number().int().min(1),
  root: MemberId,
  recoveryPub: PublicKey,
  keep: z.array(StatementId).max(1_000),
  prev: StatementId.nullable(),
}).superRefine((root, ctx) => {
  if ((root.gen === 1) !== (root.prev === null)) ctx.addIssue({ code: "custom", path: ["prev"], message: "only gen 1 has no prev" });
  if (root.gen === 1 && root.keep.length > 0) ctx.addIssue({ code: "custom", path: ["keep"], message: "gen 1 keeps nothing" });
  if (new Set(root.keep).size !== root.keep.length) ctx.addIssue({ code: "custom", path: ["keep"], message: "a revocation is kept once" });
});
/** `Profile{cluster, member, field, value, hlc}`: a member's display fields (last writer by hlc). */
export const ProfileStatement = z.strictObject({
  type: z.literal("profile"),
  cluster: ClusterId,
  member: MemberId,
  field: z.enum(["name", "icon", "addresses"]),
  value: z.string().max(2_000),
  hlc: Hlc,
});

export const StatementBody = z.discriminatedUnion("type", [AddStatement, EndorseStatement, RevokeStatement, RootStatement, ProfileStatement]);
export type StatementBody = z.infer<typeof StatementBody>;
export type StatementType = StatementBody["type"];

/** Who signed: a member (by id) or the cluster's recovery key. */
export const Signer = z.union([MemberId, z.literal("recovery")]);

/**
 * A statement as it is stored and sent: the body, who signed it, and the signature over its canonical bytes. The
 * signer must be the one the kind names: `by` for Add/Endorse/Revoke, the recovery key for Root; a Profile is signed by
 * its member or a server (which one counts is the server's validity rule).
 */
export const SignedStatement = z.strictObject({ body: StatementBody, signer: Signer, sig: Signature }).superRefine((statement, ctx) => {
  const { body, signer } = statement;
  if (body.type === "root") { if (signer !== "recovery") ctx.addIssue({ code: "custom", path: ["signer"], message: "a Root is signed by the recovery key" }); return; }
  if (signer === "recovery") { ctx.addIssue({ code: "custom", path: ["signer"], message: "only a Root is signed by the recovery key" }); return; }
  if (body.type !== "profile" && signer !== body.by) ctx.addIssue({ code: "custom", path: ["signer"], message: `a ${body.type} is signed by its by` });
});
export type SignedStatement = z.infer<typeof SignedStatement>;

/** Statements that may cross a refused server handshake (D47): revocations and roots only. */
export const RevocationStatement = SignedStatement.refine((statement) => statement.body.type === "revoke" || statement.body.type === "root", { message: "only Revoke and Root statements" });

/** The bytes a statement's id and signature are taken over. */
export function statementBytes(body: StatementBody): Uint8Array {
  return utf8Bytes(ROSTER_DOMAIN + canonicalJson(body));
}

/** A statement's id: SHA-256 of its canonical bytes, hex. */
export async function statementId(body: StatementBody): Promise<string> {
  return toHex(await sha256(statementBytes(body)));
}

/** A member's id from its raw Ed25519 public key (§3). */
export async function memberIdFromKey(signPub: Uint8Array): Promise<string> {
  if (signPub.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  return toBase32(await sha256(signPub)).slice(0, 26);
}

/** The cluster id from the raw recovery public key (§3). */
export async function clusterIdFromRecoveryKey(recoveryPub: Uint8Array): Promise<string> {
  if (recoveryPub.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  const label = utf8Bytes("botling-cluster");
  const input = new Uint8Array(label.length + 32);
  input.set(label, 0);
  input.set(recoveryPub, label.length);
  return toHex((await sha256(input)).subarray(0, 16));
}

/** The roster digest (`welcome.rosterDigest`, `roster.have`, §4.7): SHA-256 of the sorted statement ids, one per line. */
export async function rosterDigest(ids: Iterable<string>): Promise<string> {
  return toHex(await sha256(utf8Bytes([...new Set(ids)].sort().join("\n"))));
}

/** The recovery code as typed (§4.8): 26 base32 characters, in groups of four with spaces or dashes allowed. */
export const RecoveryCode = z.string().max(64).transform((text) => text.toUpperCase().replace(/[\s-]/g, "")).pipe(z.string().regex(/^[A-Z2-7]{26}$/));
