// RFC 8292 VAPID ES256 JWT signing using Node built-in `node:crypto` (`ieee-p1363`).
// `aud` = endpoint origin, `exp` <= 12 hours, `sub` = neutral https project URL (never an email by default).
import { createPrivateKey, sign } from "node:crypto";
import { fromBase64Url, toBase64Url, type VapidKeys } from "../../protocol";

/** Neutral project URL for the VAPID `sub` contact (Q-P2). */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/william1010121/Botling";

/** Maximum VAPID JWT lifetime allowed (12 hours, in seconds). */
export const MAX_VAPID_EXP_SECONDS = 12 * 60 * 60;
export const DEFAULT_VAPID_EXP_SECONDS = 12 * 60 * 60;

export interface SignVapidJwtOptions {
  keys: VapidKeys;
  endpoint: string;
  /** Contact URI (`https:` URL, or explicit `mailto:`); defaults to `DEFAULT_VAPID_SUBJECT`. */
  subject?: string;
  /** Token lifetime in seconds (must be in (0, 12h]). */
  ttlSeconds?: number;
  now?: () => number;
}

function validateSubject(subject: string): string {
  if (!subject || /[\s\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error("vapid: invalid subject");
  }
  if (subject.startsWith("https://")) {
    const parsed = new URL(subject);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("vapid: invalid https subject");
    }
    return subject;
  }
  if (subject.startsWith("mailto:") && subject.length > "mailto:".length && subject.includes("@")) {
    return subject;
  }
  throw new Error("vapid: subject must be an https URL or mailto URI");
}

function endpointOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("vapid: invalid endpoint URL");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("vapid: endpoint must use https");
  }
  return url.origin;
}

function privateKeyFromVapid(keys: VapidKeys) {
  const pub = fromBase64Url(keys.publicKey);
  const priv = fromBase64Url(keys.privateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 0x04 || !priv || priv.length !== 32) {
    throw new Error("vapid: malformed VAPID key pair");
  }
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(pub.subarray(1, 33)),
      y: toBase64Url(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: "jwk",
  });
}

/** Signs an RFC 8292 ES256 VAPID JWT (`aud` = endpoint origin, `exp` <= 12 h). */
export function signVapidJwt(options: SignVapidJwtOptions): string {
  const aud = endpointOrigin(options.endpoint);
  const sub = validateSubject(options.subject ?? DEFAULT_VAPID_SUBJECT);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_VAPID_EXP_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_VAPID_EXP_SECONDS) {
    throw new RangeError(`vapid: ttlSeconds must be an integer in [1, ${MAX_VAPID_EXP_SECONDS}]`);
  }

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const exp = nowSeconds + ttlSeconds;

  const headerB64 = toBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify({ aud, exp, sub }), "utf8"));
  const signingInput = `${headerB64}.${payloadB64}`;

  const keyObj = privateKeyFromVapid(options.keys);
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: keyObj,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${toBase64Url(signature)}`;
}

/** Formats the RFC 8292 `Authorization` header (`vapid t=<jwt>, k=<publicKey>`). */
export function vapidAuthorizationHeader(options: SignVapidJwtOptions): string {
  const jwt = signVapidJwt(options);
  return `vapid t=${jwt}, k=${options.keys.publicKey}`;
}
