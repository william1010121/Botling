// Signatures of roster statements (protocol v1 §4.1): sign, check, and turn a set of stored statements into the
// verified set validity.ts takes. WebCrypto Ed25519 only.
//
// Which key checks which statement:
// - Add, Endorse, Revoke (signed by `by`) and Profile (signed by its member or a server): the signer's signing key. A
//   member id is the hash of its signing key (§3), so any key that hashes to the signer's id is that member's key: the
//   evaluating server's own, or one an Add carries. An Add whose `member` is not the hash of its `keys.sign` is
//   dropped (it could otherwise lend a forged key to a real id).
// - Root (signed by the recovery key): every recovery public key named by some Root of the set is tried; the one that
//   verifies is recorded with the cluster id it derives (§3). Whether that key may sign this Root is the chain rule in
//   validity.ts (R2).
// A statement no key verifies is left out of the result (it stays stored; a later Add may name its signer's key).
import { canonicalJson, clusterIdFromRecoveryKey, fromBase64Url, memberIdFromKey, SignedStatement, statementBytes, statementId, toBase64Url, type StatementBody } from "../../protocol";
import type { VerifiedStatement } from "./validity";

const subtle = () => globalThis.crypto.subtle;
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

/** Signs a statement body with an Ed25519 private key; `signer` is the member id, or "recovery" for a Root. */
export async function signStatement(body: StatementBody, signer: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<{ id: string; statement: SignedStatement }> {
  const statement = SignedStatement.parse({ body, signer, sig: toBase64Url(await sign(statementBytes(body))) });
  return { id: await statementId(statement.body), statement };
}

/** A signer for `signStatement` from a CryptoKey. */
export const signWith = (key: CryptoKey) => async (bytes: Uint8Array) => new Uint8Array(await subtle().sign({ name: "Ed25519" }, key, buf(bytes)));

/** The bytes a statement is stored as (`roster.bytes`): the canonical JSON of the signed statement. */
export function storedBytes(statement: SignedStatement): Uint8Array {
  return new TextEncoder().encode(canonicalJson(statement));
}

/** A stored statement back, or null when the bytes are not a well-formed signed statement. */
export function parseStored(bytes: Uint8Array): SignedStatement | null {
  try {
    const parsed = SignedStatement.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, CryptoKey>();
async function publicKey(raw: string): Promise<CryptoKey | null> {
  const cached = keyCache.get(raw);
  if (cached) return cached;
  const bytes = fromBase64Url(raw);
  if (!bytes || bytes.length !== 32) return null;
  try {
    const key = await subtle().importKey("raw", buf(bytes), { name: "Ed25519" }, false, ["verify"]);
    if (keyCache.size > 4_096) keyCache.clear();
    keyCache.set(raw, key);
    return key;
  } catch {
    return null;
  }
}

/** Whether `sig` is a valid Ed25519 signature of the statement's canonical bytes under the raw public key `pub`. */
export async function verifySignature(statement: SignedStatement, pub: string): Promise<boolean> {
  const key = await publicKey(pub);
  const sig = fromBase64Url(statement.sig);
  if (!key || !sig) return false;
  try {
    return await subtle().verify({ name: "Ed25519" }, key, buf(sig), buf(statementBytes(statement.body)));
  } catch {
    return false;
  }
}

/** Memo of finished checks, keyed by statement id, signature and key (a statement's verdict never changes). */
const verdicts = new Map<string, boolean>();
async function checked(id: string, statement: SignedStatement, pub: string): Promise<boolean> {
  const key = `${id}\n${statement.sig}\n${pub}`;
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const verdict = await verifySignature(statement, pub);
  if (verdicts.size > 65_536) verdicts.clear();
  verdicts.set(key, verdict);
  return verdict;
}

export interface StoredStatement {
  id: string;
  statement: SignedStatement;
  /** Local receipt time (`roster.receivedAt`), when known from the store. */
  receivedAt?: number;
}

/**
 * The verified subset of `statements`: each with the key that checked it (see the file comment). `self` is the
 * evaluating server (its own key is known without an Add).
 */
export async function verifyStatements(statements: Iterable<StoredStatement>, self: { memberId: string; signPub: string }): Promise<VerifiedStatement[]> {
  const list = [...statements];
  const signKeys = new Map<string, string>([[self.memberId, self.signPub]]);
  const badAdds = new Set<string>();
  for (const { id, statement } of list) {
    if (statement.body.type !== "add") continue;
    const raw = fromBase64Url(statement.body.keys.sign);
    if (!raw || (await memberIdFromKey(raw)) !== statement.body.member) { badAdds.add(id); continue; }
    signKeys.set(statement.body.member, statement.body.keys.sign);
  }
  const recoveryKeys = [...new Set(list.flatMap(({ statement }) => (statement.body.type === "root" ? [statement.body.recoveryPub] : [])))].sort();
  const clusterOf = new Map<string, string>();
  const out: VerifiedStatement[] = [];
  for (const { id, statement, receivedAt } of list) {
    if (badAdds.has(id)) continue;
    const at = receivedAt !== undefined ? { receivedAt } : {};
    if (statement.body.type === "root") {
      for (const pub of recoveryKeys) {
        if (!(await checked(id, statement, pub))) continue;
        let cluster = clusterOf.get(pub);
        if (cluster === undefined) { cluster = await clusterIdFromRecoveryKey(fromBase64Url(pub)!); clusterOf.set(pub, cluster); }
        out.push({ id, body: statement.body, signer: "recovery", recoveryKey: pub, recoveryKeyCluster: cluster, ...at });
        break;
      }
      continue;
    }
    const pub = signKeys.get(statement.signer);
    if (pub && (await checked(id, statement, pub))) out.push({ id, body: statement.body, signer: statement.signer, ...at });
  }
  return out;
}
