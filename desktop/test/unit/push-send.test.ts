// Botling 3 M4-23: Web Push sender (RFC 8291 aes128gcm, RFC 8292 VAPID ES256, protocol v1 §18.4).
// - RFC 8291 Appendix A example vector (exact 144-byte encrypted payload) plus fresh-key round-trip decryption
//   (single-record, empty plaintext, and multi-record framing);
// - RFC 8292 ES256 VAPID JWT (`aud` = endpoint origin, `exp` <= 12 h, `sub` = neutral project https URL);
// - Send-time SSRF guard: non-public DNS resolutions (RFC 1918, loopback, CGNAT/Tailscale 100.64/10, link-local
//   metadata, IPv6 ULA/link-local, IPv4-mapped IPv6) are refused before dialing, and resolved public IPs are pinned;
// - PushSender: sends only for bots this server owns, reads VAPID private key from vapid-keys.json, never sends to
//   revoked devices, supports excludeDevices, picks up rotated vapid-keys.json, and never logs private keys or
//   subscription secrets.
import { createDecipheriv, createECDH, createPublicKey, createVerify, generateKeyPairSync, hkdfSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encodePushSubscription, fromBase64Url, toBase64Url, type PushSubscription, type VapidKeys } from "../../src/protocol";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, writeVapidKeys } from "../../src/server/identity";
import {
  createPushTransport,
  DEFAULT_VAPID_SUBJECT,
  encryptPushPayload,
  isPublicIp,
  MAX_VAPID_EXP_SECONDS,
  PushSender,
  signVapidJwt,
  vapidAuthorizationHeader,
  type HttpsRequestFn,
  type PushTransport,
} from "../../src/server/push";
import { RosterStore } from "../../src/server/roster";
import { openServerStore } from "../../src/server/store";
import { generateDhKeyPair } from "../../src/session";
import { testRoot } from "../botlingd-harness";

const root = testRoot("push-send");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

let folderSeq = 0;

function makeTempDir(): string {
  const dir = join(root, `d${++folderSeq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function makeDevicePushKeys(seedAuth = 1): { p256dh: string; auth: string; privateKey: Buffer } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, seedAuth);
  return {
    p256dh: toBase64Url(ecdh.getPublicKey()),
    auth: toBase64Url(auth),
    privateKey: ecdh.getPrivateKey(),
  };
}

function decryptAes128Gcm(body: Uint8Array, uaPrivateKey: Uint8Array, uaPublicKey: Uint8Array, authSecret: Uint8Array): Uint8Array {
  expect(body.length).toBeGreaterThanOrEqual(86 + 17);
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false);
  expect(rs).toBeGreaterThanOrEqual(18);
  const idlen = body[20];
  expect(idlen).toBe(65);
  const asPublic = body.subarray(21, 21 + idlen);
  expect(asPublic[0]).toBe(4);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivateKey);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\x00", "ascii"), uaPublicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\x00", "ascii"), 16));
  const baseNonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\x00", "ascii"), 12));

  const records: Buffer[] = [];
  let offset = 21 + idlen;
  let seq = 0;
  let sawFinal = false;
  while (offset < body.length) {
    expect(sawFinal).toBe(false);
    const end = Math.min(offset + rs, body.length);
    const chunk = body.subarray(offset, end);
    expect(chunk.length).toBeGreaterThanOrEqual(17);
    const ciphertext = chunk.subarray(0, chunk.length - 16);
    const tag = chunk.subarray(chunk.length - 16);
    const nonce = Buffer.from(baseNonce);
    let carry = seq;
    for (let i = 11; i >= 0 && carry > 0; i--) {
      nonce[i] ^= carry & 0xff;
      carry >>>= 8;
    }
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(tag);
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Strip trailing 0x00 padding, then verify delimiter byte (0x01 non-final, 0x02 final).
    let delimIdx = padded.length - 1;
    while (delimIdx >= 0 && padded[delimIdx] === 0) delimIdx--;
    expect(delimIdx).toBeGreaterThanOrEqual(0);
    const delim = padded[delimIdx];
    const isLast = end === body.length;
    expect(delim).toBe(isLast ? 2 : 1);
    if (delim === 2) sawFinal = true;
    records.push(padded.subarray(0, delimIdx));
    offset = end;
    seq++;
  }
  expect(sawFinal).toBe(true);
  return Buffer.concat(records);
}

function generateTestVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const rawPub = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, "base64url"), Buffer.from(pubJwk.y, "base64url")]);
  return { publicKey: toBase64Url(rawPub), privateKey: privJwk.d };
}

function verifyEs256Jwt(jwt: string, publicKeyB64u: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [hB64, pB64, sB64] = parts;
  const header = JSON.parse(Buffer.from(hB64, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8")) as Record<string, unknown>;
  const pubBytes = fromBase64Url(publicKeyB64u)!;
  expect(pubBytes).not.toBeNull();
  const keyObj = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(pubBytes.subarray(1, 33)),
      y: toBase64Url(pubBytes.subarray(33, 65)),
    },
    format: "jwk",
  });
  const sig = fromBase64Url(sB64)!;
  expect(sig).not.toBeNull();
  expect(sig.length).toBe(64);
  const verifier = createVerify("sha256");
  verifier.update(`${hB64}.${pB64}`, "ascii");
  expect(verifier.verify({ key: keyObj, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  return { header, payload };
}

describe("M4-23 RFC 8291 aes128gcm encryption", () => {
  it("matches the RFC 8291 Appendix A test vector byte-for-byte", () => {
    const uaPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const auth = "BTBZMqHH6r4Tts7J_aSIgg";
    const salt = fromBase64Url("DGv6ra1nlYgDCS1FRnbzlw")!;
    const asPrivate = fromBase64Url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")!;
    const plaintext = "When I grow up, I want to be a watermelon";

    const encrypted = encryptPushPayload({
      p256dh: uaPublic,
      auth,
      plaintext,
      salt,
      localPrivateKey: asPrivate,
      recordSize: 4096,
    });

    expect(encrypted.contentEncoding).toBe("aes128gcm");
    expect(encrypted.body.length).toBe(144);
    expect(toBase64Url(encrypted.body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips fresh keys for single-record, empty, and multi-record payloads", () => {
    const dev = makeDevicePushKeys(7);
    const uaPub = fromBase64Url(dev.p256dh)!;
    const authBytes = fromBase64Url(dev.auth)!;

    for (const [text, rs] of [["", 4096], ["{\"botName\":\"Alpha\"}", 4096], ["A".repeat(120), 40]] as const) {
      const encrypted = encryptPushPayload({ p256dh: dev.p256dh, auth: dev.auth, plaintext: text, recordSize: rs });
      const decrypted = decryptAes128Gcm(encrypted.body, dev.privateKey, uaPub, authBytes);
      expect(Buffer.from(decrypted).toString("utf8")).toBe(text);
    }
  });

  it("rejects malformed device keys, invalid P-256 points, and invalid record sizes", () => {
    const dev = makeDevicePushKeys(9);
    const offCurve = new Uint8Array(65).fill(1);
    offCurve[0] = 4;
    expect(() => encryptPushPayload({ p256dh: toBase64Url(offCurve), auth: dev.auth, plaintext: "hi" })).toThrow();
    expect(() => encryptPushPayload({ p256dh: toBase64Url(new Uint8Array(32)), auth: dev.auth, plaintext: "hi" })).toThrow();
    expect(() => encryptPushPayload({ p256dh: dev.p256dh, auth: toBase64Url(new Uint8Array(15)), plaintext: "hi" })).toThrow();
    expect(() => encryptPushPayload({ p256dh: dev.p256dh, auth: dev.auth, plaintext: "hi", recordSize: 17 })).toThrow();
  });
});

describe("M4-23 RFC 8292 VAPID JWT", () => {
  it("signs an ES256 JWT with endpoint origin aud, exp <= 12 h, and neutral https sub", () => {
    const keys = generateTestVapidKeys();
    const nowMs = 1_763_200_000_000;
    const jwt = signVapidJwt({
      keys,
      endpoint: "https://fcm.googleapis.com/fcm/send/secret-token?x=1",
      now: () => nowMs,
    });
    const { header, payload } = verifyEs256Jwt(jwt, keys.publicKey);
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe(DEFAULT_VAPID_SUBJECT);
    expect(String(payload.sub)).toMatch(/^https:\/\//);
    expect(String(payload.sub)).not.toContain("mailto:");
    const nowSec = Math.floor(nowMs / 1000);
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - nowSec).toBeGreaterThan(0);
    expect((payload.exp as number) - nowSec).toBeLessThanOrEqual(MAX_VAPID_EXP_SECONDS);

    const authHeader = vapidAuthorizationHeader({
      keys,
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
      now: () => nowMs,
    });
    expect(authHeader.startsWith("vapid t=")).toBe(true);
    expect(authHeader.endsWith(`, k=${keys.publicKey}`)).toBe(true);
  });

  it("refuses exp > 12 h, non-positive ttl, and non-https endpoints", () => {
    const keys = generateTestVapidKeys();
    expect(() => signVapidJwt({ keys, endpoint: "https://push.example/sub", ttlSeconds: MAX_VAPID_EXP_SECONDS + 1 })).toThrow();
    expect(() => signVapidJwt({ keys, endpoint: "https://push.example/sub", ttlSeconds: 0 })).toThrow();
    expect(() => signVapidJwt({ keys, endpoint: "http://push.example/sub" })).toThrow();
    expect(() => signVapidJwt({ keys, endpoint: "https://push.example/sub", subject: "http://not-https.example" })).toThrow();
  });
});

describe("M4-23 send-time SSRF guard", () => {
  it("classifies private, loopback, CGNAT/Tailscale, link-local, multicast, and IPv4-mapped IPv6 addresses as non-public", () => {
    const blocked = [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.254",
      "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.168.1.1", "192.0.2.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:169.254.169.254", "::ffff:7f00:1",
    ];
    for (const ip of blocked) expect(isPublicIp(ip), ip).toBe(false);

    const allowed = ["1.1.1.1", "8.8.8.8", "142.250.185.78", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"];
    for (const ip of allowed) expect(isPublicIp(ip), ip).toBe(true);
  });

  it("refuses non-public URLs and private DNS resolutions before dialing, and pins the resolved public IP", async () => {
    let dialed = 0;
    let lookedUp = 0;
    let pinnedLookupAddr: string | null = null;
    const transportPrivate = createPushTransport({
      lookup: async () => {
        lookedUp++;
        return [{ address: "142.250.185.78", family: 4 }, { address: "10.0.0.2", family: 4 }];
      },
      request: () => {
        dialed++;
        throw new Error("must not dial");
      },
    });
    await expect(transportPrivate({
      url: "https://127.0.0.1/sub/1",
      headers: {},
      body: new Uint8Array([1, 2]),
      timeoutMs: 1_000,
    })).rejects.toThrow(/public https/i);
    expect(lookedUp).toBe(0);
    expect(dialed).toBe(0);

    await expect(transportPrivate({
      url: "https://push.example/sub/1",
      headers: {},
      body: new Uint8Array([1, 2]),
      timeoutMs: 1_000,
    })).rejects.toThrow(/private|non-public/i);
    expect(dialed).toBe(0);

    const fakeReq = ((_url: unknown, opts: unknown, cb?: (res: unknown) => void) => {
      const options = opts as { lookup?: (h: string, o: unknown, fn: (e: null, a: unknown, f?: number) => void) => void };
      options.lookup?.("push.example", { all: true }, (_e, addrs) => {
        pinnedLookupAddr = (addrs as Array<{ address: string }>)[0]?.address ?? null;
      });
      const req = new EventEmitter() as EventEmitter & { write(b: Uint8Array): void; end(): void; destroy(): void; setTimeout(ms: number, fn: () => void): void };
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume(): void; destroy(): void };
        res.destroy = () => {};
        res.statusCode = 201;
        res.headers = {};
        res.resume = () => {};
        cb?.(res);
        res.emit("end");
      };
      return req;
    }) as unknown as HttpsRequestFn;

    const transportPublic = createPushTransport({
      lookup: async () => [{ address: "142.250.185.78", family: 4 }],
      request: fakeReq,
    });
    const res = await transportPublic({
      url: "https://push.example/sub/1",
      headers: {},
      body: new Uint8Array([1, 2]),
      timeoutMs: 1_000,
    });
    expect(res.status).toBe(201);
    expect(pinnedLookupAddr).toBe("142.250.185.78");
  });
});

describe("M4-23 review: send-time names, deadline and response handling", () => {
  type FakeReq = EventEmitter & { end(b?: Uint8Array): void; destroy(e?: Error): void; setTimeout(ms: number, fn: () => void): void };
  const body = new Uint8Array([1]);

  it("refuses public-looking names that resolve to private addresses (nip.io, .lan, .corp, localhost.localdomain)", async () => {
    const answers: Record<string, string> = {
      "127.0.0.1.nip.io": "127.0.0.1", "printer.lan": "192.168.1.20", "intranet.corp": "10.1.2.3",
      "localhost.localdomain": "::1", "meta.example": "::ffff:169.254.169.254", "tail.example": "100.100.1.1",
    };
    const asked: string[] = [];
    let dialed = 0;
    const transport = createPushTransport({
      lookup: async (host) => { asked.push(host); return [{ address: answers[host] ?? "1.1.1.1", family: answers[host]?.includes(":") ? 6 : 4 }]; },
      request: () => { dialed++; throw new Error("must not dial"); },
    });
    for (const host of Object.keys(answers)) {
      await expect(transport({ url: `https://${host}/p`, headers: {}, body, timeoutMs: 1_000 }), host).rejects.toThrow(/private|non-public/i);
    }
    expect(asked).toEqual(Object.keys(answers)); // the schema let them through; the address check refused them
    expect(dialed).toBe(0);
  });

  it("gives the pinned address on the single-answer lookup path too", async () => {
    let got: unknown = null;
    const transport = createPushTransport({
      lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
      request: ((_u: unknown, opts: { lookup: (h: string, o: unknown, cb: (...a: unknown[]) => void) => void }, cb?: (r: unknown) => void) => {
        opts.lookup("push.example", {}, (...a) => { got = a; });
        const req = new EventEmitter() as FakeReq;
        req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => cb?.({ statusCode: 201, destroy() {} });
        return req;
      }) as unknown as HttpsRequestFn,
    });
    expect((await transport({ url: "https://push.example/p", headers: {}, body, timeoutMs: 1_000 })).status).toBe(201);
    expect(got).toEqual([null, "2606:4700:4700::1111", 6]);
  });

  it("ends a send that hangs in DNS, before headers, or while the body trickles, within the deadline", async () => {
    const hangingDns = createPushTransport({ lookup: () => new Promise(() => {}), request: () => { throw new Error("must not dial"); } });
    await expect(hangingDns({ url: "https://push.example/p", headers: {}, body, timeoutMs: 50 })).rejects.toThrow(/timed out/);

    let destroyed = 0;
    const silent = createPushTransport({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: (() => {
        const req = new EventEmitter() as FakeReq;
        req.setTimeout = () => {}; // an idle timer that never fires: only the overall deadline can end it
        req.destroy = () => { destroyed++; };
        req.end = () => {};
        return req;
      }) as unknown as HttpsRequestFn,
    });
    await expect(silent({ url: "https://push.example/p", headers: {}, body, timeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(destroyed).toBeGreaterThan(0);

    let resDestroyed = 0;
    const trickle = createPushTransport({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: ((_u: unknown, _o: unknown, cb?: (r: unknown) => void) => {
        const req = new EventEmitter() as FakeReq;
        req.setTimeout = () => {}; req.destroy = () => {};
        // headers arrive, the body never ends
        req.end = () => cb?.(Object.assign(new EventEmitter(), { statusCode: 201, resume() {}, destroy() { resDestroyed++; } }));
        return req;
      }) as unknown as HttpsRequestFn,
    });
    expect((await trickle({ url: "https://push.example/p", headers: {}, body, timeoutMs: 1_000 })).status).toBe(201);
    expect(resDestroyed).toBe(1);
  });
});

describe("M4-23 PushSender with RosterStore, vapid-keys.json, and local fake push endpoint", () => {
  async function startFakePushServer(handler?: (reqUrl: string) => number) {
    const received: Array<{ url: string; method: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "/";
        received.push({ url, method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        const status = handler ? handler(url) : 201;
        res.statusCode = status;
        if (status >= 300 && status < 400) res.setHeader("Location", "https://127.0.0.1/redirected");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const transport: PushTransport = (req) => new Promise((resolve, reject) => {
      const parsed = new URL(req.url);
      const localReq = httpRequest(
        { host: "127.0.0.1", port, path: `${parsed.pathname}${parsed.search}`, method: "POST", headers: req.headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      localReq.on("error", reject);
      localReq.end(req.body);
    });

    return { received, transport };
  }

  async function setupCluster() {
    const dir = makeTempDir();
    const store = await openServerStore(dir);
    cleanups.push(() => store.close());
    const identity = await loadOrCreateServerIdentity(dir, { create: true });
    await store.submit((tx) => bindServerIdentity(tx, identity));
    const logs: string[] = [];
    const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
    const setup = new ClusterSetup(roster);
    const started = await setup.begin();
    expect((await setup.confirm(started.code)).ok).toBe(true);

    const addDevice = async (name: string, seed: number) => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
      const dh = await generateDhKeyPair();
      const devKeys = makeDevicePushKeys(seed);
      const sub: PushSubscription = {
        endpoint: `https://push.example/sub/${name}-secret-cap`,
        keys: { p256dh: devKeys.p256dh, auth: devKeys.auth },
      };
      const added = await roster.addDevice({
        name,
        keys: { sign: toBase64Url(rawPub), dh: toBase64Url(dh.publicKey) },
      });
      await roster.writeProfile(added.member, "push", encodePushSubscription(sub));
      return { memberId: added.member, sub, devKeys };
    };

    return { dir, roster, logs, addDevice };
  }

  it("encrypts and sends to valid unrevoked devices for owned bots only, reading vapid-keys.json", async () => {
    const { dir, roster, logs, addDevice } = await setupCluster();
    const d1 = await addDevice("phone1", 11);
    const d2 = await addDevice("phone2", 22);
    const dRevoked = await addDevice("stolen", 33);
    await roster.revokeDevice(dRevoked.memberId);

    const vapid = generateTestVapidKeys();
    writeVapidKeys(dir, vapid);

    const fakePush = await startFakePushServer();
    const OWNED_BOT = "6A0B0000-0000-4000-8000-000000000001";
    const PEER_BOT = "6A0B0000-0000-4000-8000-000000000002";

    const sender = new PushSender({
      dataDir: dir,
      ownsBot: (botId) => botId === OWNED_BOT,
      roster,
      transport: fakePush.transport,
      log: (line) => logs.push(line),
    });

    // Peer bot: server does NOT own it -> sends nothing.
    const peerRes = await sender.notify({ botId: PEER_BOT, botName: "Peer" });
    expect(peerRes).toMatchObject({ sent: 0, skipped: "not-owned" });
    expect(fakePush.received).toHaveLength(0);

    // Owned bot with d2 excluded (e.g., attached page): only d1 receives push; revoked dRevoked never receives push.
    const ownedRes = await sender.notify({ botId: OWNED_BOT, botName: "Researcher", excludeDevices: [d2.memberId] });
    expect(ownedRes.sent).toBe(1);
    expect(ownedRes.results.map((r) => r.device)).toEqual([d1.memberId]);
    expect(fakePush.received).toHaveLength(1);

    const req = fakePush.received[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/sub/phone1-secret-cap");
    expect(req.headers["content-type"]).toBe("application/octet-stream");
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(Number(req.headers["ttl"])).toBeGreaterThan(0);

    const authHeader = String(req.headers["authorization"] ?? "");
    const match = /^vapid t=([^,]+),\s*k=([A-Za-z0-9_-]+)$/.exec(authHeader);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(vapid.publicKey);
    const { payload: jwtPayload } = verifyEs256Jwt(match![1], vapid.publicKey);
    expect(jwtPayload.aud).toBe("https://push.example");
    expect(jwtPayload.sub).toBe(DEFAULT_VAPID_SUBJECT);

    const plain = decryptAes128Gcm(req.body, d1.devKeys.privateKey, fromBase64Url(d1.sub.keys.p256dh)!, fromBase64Url(d1.sub.keys.auth)!);
    expect(JSON.parse(Buffer.from(plain).toString("utf8"))).toEqual({
      v: 1,
      kind: "needs-you",
      botId: OWNED_BOT,
      botName: "Researcher",
    });

    // Without excludeDevices, both valid devices d1 and d2 get a push (still never dRevoked).
    const allRes = await sender.notify({ botId: OWNED_BOT, botName: "Researcher" });
    expect(allRes.sent).toBe(2);
    expect(allRes.results.map((r) => r.device).sort()).toEqual([d1.memberId, d2.memberId].sort());

    // Ensure no secrets leaked into logs.
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).not.toContain(vapid.privateKey);
    expect(joinedLogs).not.toContain(d1.sub.keys.auth);
    expect(joinedLogs).not.toContain(d1.sub.keys.p256dh);
  });

  it("picks up rotated vapid-keys.json, handles missing keys / redirects / 410, and never logs secrets on failure", async () => {
    const { dir, roster, logs, addDevice } = await setupCluster();
    const d1 = await addDevice("phone1", 41);
    let nextStatus = 410;
    const fakePush = await startFakePushServer(() => nextStatus);

    const OWNED_BOT = "6A0B0000-0000-4000-8000-000000000001";
    const sender = new PushSender({
      dataDir: dir,
      ownsBot: () => true,
      roster,
      transport: fakePush.transport,
      log: (line) => logs.push(line),
    });

    // No vapid-keys.json yet -> skips cleanly.
    expect(await sender.notify({ botId: OWNED_BOT, botName: "Bot" })).toMatchObject({ sent: 0, skipped: "no-vapid-keys" });

    // Write rotated key and trigger a 410 Gone failure.
    const rotated = generateTestVapidKeys();
    writeVapidKeys(dir, rotated);
    const res = await sender.notify({ botId: OWNED_BOT, botName: "Bot" });
    expect(res.sent).toBe(0);
    expect(res.results[0]).toMatchObject({ device: d1.memberId, ok: false, status: 410, gone: true });
    expect(String(fakePush.received[0].headers["authorization"])).toContain(`k=${rotated.publicKey}`);

    // 3xx redirect is not followed and reports failure.
    nextStatus = 302;
    const redirRes = await sender.notify({ botId: OWNED_BOT, botName: "Bot" });
    expect(redirRes.sent).toBe(0);
    expect(redirRes.results[0]).toMatchObject({ device: d1.memberId, ok: false, status: 302, reason: "http-302" });
    expect(fakePush.received).toHaveLength(2);

    const joinedLogs = logs.join("\n");
    expect(joinedLogs).not.toContain(rotated.privateKey);
    expect(joinedLogs).not.toContain(d1.sub.keys.auth);
    expect(joinedLogs).not.toContain(d1.sub.keys.p256dh);
    expect(joinedLogs).not.toContain("phone1-secret-cap");
  });

  it("captures Retry-After on 429 in createPushTransport without reading body and parses retryAfterMs in PushSender", async () => {
    const res = new EventEmitter() as unknown as import("node:http").IncomingMessage;
    res.statusCode = 429;
    res.headers = { "retry-after": "12" };
    let destroyed = false;
    (res as unknown as { destroy: () => void }).destroy = () => { destroyed = true; };
    const reqObj = new EventEmitter() as unknown as import("node:http").ClientRequest;
    (reqObj as unknown as { setTimeout: () => void }).setTimeout = () => {};
    (reqObj as unknown as { destroy: () => void }).destroy = () => {};
    (reqObj as unknown as { end: () => void }).end = () => {};

    const transport = createPushTransport({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: (_url, _opts, cb) => {
        queueMicrotask(() => cb?.(res));
        return reqObj;
      },
    });

    const out = await transport({
      url: "https://push.example/sub/retry-after",
      headers: {},
      body: new Uint8Array([1]),
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ status: 429, retryAfter: "12" });
    expect(destroyed).toBe(true);

    const { dir, roster, addDevice } = await setupCluster();
    const d1 = await addDevice("phone-ra", 49);
    writeVapidKeys(dir, generateTestVapidKeys());
    const sender = new PushSender({
      dataDir: dir,
      ownsBot: () => true,
      roster,
      transport,
    });
    const report = await sender.notify({ botId: "6A0B0000-0000-4000-8000-000000000001", botName: "Bot" });
    expect(report.results[0]).toMatchObject({
      device: d1.memberId,
      ok: false,
      status: 429,
      retryable: true,
      retryAfterMs: 12_000,
    });
  });
});
