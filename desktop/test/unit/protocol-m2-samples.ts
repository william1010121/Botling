// One valid sample of every message M2 adds to the Botling 3 protocol (src/protocol), with a sender and session that
// may send it. Shared by protocol-v1.test.ts (the coverage check) and protocol-m2.test.ts.
import { toBase64Url, type Message, type SessionKind, type Sender, type SignedStatement } from "../../src/protocol";

export const key = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
export const sig = (fill: number) => toBase64Url(new Uint8Array(64).fill(fill));
export const hex = (digit: string) => digit.repeat(64);
export const cluster = "0123456789abcdef0123456789abcdef";
export const serverA = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const serverB = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const device = "dddddddddddddddddddddddddd";
export const contentId = `sha256:${"cd".repeat(32)}`;
export const botStream = "bot:6A0B0000-0000-4000-8000-000000000002";

export const addDevice: SignedStatement = {
  body: { type: "add", cluster, member: device, kind: "device", keys: { sign: key(1), dh: key(2) }, name: "Phone", scope: ["read", "reply", "approve"], by: serverA, at: 1_763_100_000_000 },
  signer: serverA,
  sig: sig(3),
};
export const addServer: SignedStatement = {
  body: { type: "add", cluster, member: serverB, kind: "server", keys: { sign: key(4), dh: key(5) }, name: "Linux host", by: serverA, at: 1_763_100_000_000, joined: true },
  signer: serverA,
  sig: sig(6),
};
export const endorse: SignedStatement = { body: { type: "endorse", cluster, member: device, addId: hex("a"), by: serverB }, signer: serverB, sig: sig(7) };
export const revoke: SignedStatement = { body: { type: "revoke", cluster, member: serverB, reason: "stolen", by: serverA, gen: 1, cascade: true }, signer: serverA, sig: sig(8) };
export const root: SignedStatement = { body: { type: "root", cluster, gen: 1, root: serverA, recoveryPub: key(9), keep: [], prev: null }, signer: "recovery", sig: sig(10) };
export const reroot: SignedStatement = { body: { type: "root", cluster, gen: 2, root: serverB, recoveryPub: key(9), keep: [hex("e")], prev: hex("f") }, signer: "recovery", sig: sig(11) };
export const profile: SignedStatement = { body: { type: "profile", cluster, member: device, field: "name", value: "Phone 2", hlc: { ms: 1_763_100_000_000, c: 1 } }, signer: device, sig: sig(12) };
export const statements = [addDevice, addServer, endorse, revoke, root, reroot, profile];

const entry = { stream: botStream, seq: 7 };
const ticket = toBase64Url(new Uint8Array(32).fill(13));

export type Sample = { message: Message; sender: Sender; session?: SessionKind };
const pairing: SessionKind = { local: false, pairing: true };
const remote: SessionKind = { local: false };
const local: SessionKind = { local: true };

export const m2Samples = {
  "content.get": { sender: "fe", session: remote, message: { t: "content.get", req: "g1", owner: serverA, id: contentId, variant: "original", offset: 1_048_576, length: 4_194_304, entry } },
  "content.meta": { sender: "server", session: remote, message: { t: "content.meta", req: "g1", id: contentId, size: 12_000_000, type: "video/mp4", chunkSize: 1_048_576, chunkHashes: "AAAA", variants: [{ name: "preview", id: `sha256:${"ef".repeat(32)}`, size: 3_000_000, type: "video/mp4", bitrate: 1_100_000, height: 720 }] } },
  "content.chunk": { sender: "server", session: remote, message: { t: "content.chunk", req: "g1", offset: 1_048_576, bytes: new Uint8Array([0, 1, 2, 0x7b, 0xff, 9]) } },
  "content.credit": { sender: "fe", session: remote, message: { t: "content.credit", req: "g1", bytes: 4_194_304 } },
  "content.cancel": { sender: "fe", session: remote, message: { t: "content.cancel", req: "g1" } },
  "content.ticket": { sender: "fe", session: remote, message: { t: "content.ticket", req: "k1", owner: serverA, id: contentId, entry } },
  "content.granted": { sender: "server", session: remote, message: { t: "content.granted", req: "k1", ticket, expiresAt: 1_763_100_600_000 } },
  "content.put": { sender: "fe", session: remote, message: { t: "content.put", req: "u1", id: contentId, size: 52_428_800, type: "image/jpeg", name: "photo.jpg" } },
  "content.stored": { sender: "server", session: remote, message: { t: "content.stored", req: "u1", id: contentId, have: 1_048_576 } },
  "pair.hello": { sender: "fe", session: pairing, message: { t: "pair.hello", name: "Phone", sign: key(1), proof: sig(14), feVersion: "3.0.0", protocol: 1 } },
  "pair.added": { sender: "server", session: pairing, message: { t: "pair.added", add: addDevice, roster: [root, addServer] } },
  "pair.ack": { sender: "fe", session: pairing, message: { t: "pair.ack", addId: hex("a") } },
  "pair.declined": { sender: "server", session: pairing, message: { t: "pair.declined", reason: "code" } },
  "roster.have": { sender: "peer", session: remote, message: { t: "roster.have", digest: hex("b") } },
  "roster.ids": { sender: "peer", session: remote, message: { t: "roster.ids", ids: [hex("a"), hex("b")] } },
  "roster.want": { sender: "peer", session: remote, message: { t: "roster.want", ids: [hex("b")] } },
  "roster.statements": { sender: "peer", session: remote, message: { t: "roster.statements", statements } },
  "roster.revocations": { sender: "peer", session: remote, message: { t: "roster.revocations", statements: [revoke, root, reroot] } },
  admin: { sender: "fe", session: local, message: { t: "admin", req: "a1", op: { op: "pair.offer", name: "Phone", scope: ["read", "reply"] } } },
  "admin.event": { sender: "server", session: local, message: { t: "admin.event", event: { kind: "pair.code", offer: "offer-0123456789ab", code: "042137", deviceId: device, deviceName: "Phone" } } },
} satisfies Record<string, Sample>;
export type M2Type = keyof typeof m2Samples;
