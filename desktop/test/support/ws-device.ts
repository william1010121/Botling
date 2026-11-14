// A scripted phone for real botlingd (M3 step 5 tests): it pairs at a server over that server's loopback `/v3/ws`
// (pair mode, the offer's secret mixed in, `pair.hello` → `pair.added` → `pair.ack`) while the test confirms the code
// over the server's local socket (`admin pair.offer` / `pair.confirm`), and it opens normal IK sessions to any server
// of the cluster (hello → welcome; a refused handshake or `bye{revoked}` is seen as the session's end).
import { decodeFrame, encodeFrame, fromBase64Url, memberIdFromKey, parsePairLink, statementId, toBase64Url, type AdminEvent, type Message, type MessageOf } from "../../src/protocol";
import { generateDhKeyPair, SessionLink, signPairProof, type SessionEnd } from "../../src/session";
import { webSocketConnector } from "../../src/server/peer";
import type { ScriptClient } from "../botlingd-harness";
import { until } from "../helpers";

const encoder = new TextEncoder();
const PAIRING = { local: false, pairing: true } as const;
const REMOTE = { local: false } as const;

export interface DeviceKeys {
  member: string;
  sign: CryptoKeyPair;
  dh: { publicKey: Uint8Array; privateKey: CryptoKey };
  keys: { sign: string; dh: string };
}

export async function deviceKeys(): Promise<DeviceKeys> {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  return { member: await memberIdFromKey(signPub), sign, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

let reqs = 0;
/** An `admin` request over a ScriptClient (local socket); resolves with the result or throws the error. */
export async function admin(client: ScriptClient, op: Record<string, unknown>): Promise<unknown> {
  const req = `admin${++reqs}`;
  client.send({ t: "admin", req, op } as Message);
  const res = await client.wait((m): m is MessageOf<"res"> => m.t === "res" && m.req === req, `admin ${String(op.op)}`);
  if (!res.ok) throw new Error(`admin ${String(op.op)}: ${JSON.stringify(res.error)}`);
  return res.result;
}

/** Pairs a new phone at the server whose local socket `client` is on, listening at `port`. Returns its keys and Add id. */
export async function pairPhone(client: ScriptClient, port: number, name = "Phone"): Promise<{ keys: DeviceKeys; addId: string }> {
  const keys = await deviceKeys();
  const offered = await admin(client, { op: "pair.offer", name: "phone test" }) as { offer: string; link: string };
  const offer = parsePairLink(offered.link);
  if (!offer) throw new Error("the pairing link does not parse");
  const from = client.received.length;
  const connection = await webSocketConnector.connect(`ws://127.0.0.1:${port}/v3/ws`);
  let added: string | null = null;
  let link!: SessionLink;
  link = SessionLink.initiate(connection, {
    mode: "pair", transport: "tailnet", cluster: offer.cluster,
    self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
    responder: { memberId: offer.server, dhPub: fromBase64Url(offer.keys.dh)! },
    pair: { offer: offer.offer, secret: fromBase64Url(offer.secret)! },
  }, {
    onFrame: async (bytes) => {
      const decoded = decodeFrame(bytes, "server", PAIRING);
      if (!decoded.ok || decoded.message.t !== "pair.added") return;
      added = await statementId(decoded.message.add.body);
      const ack = encodeFrame({ t: "pair.ack", addId: added } as Message, "fe", PAIRING);
      if (ack.ok) link.send("control", encoder.encode(ack.text));
    },
    onEnd: () => undefined,
  });
  connection.bind({ frame: (frame) => link.receive(frame), closed: () => link.transportClosed() });
  const info = await link.established;
  const proof = await signPairProof(keys.sign.privateKey, info.transcriptHash);
  const hello = encodeFrame({ t: "pair.hello", name, sign: keys.keys.sign, proof: toBase64Url(proof), feVersion: "3.0.0", protocol: 1 } as Message, "fe", PAIRING);
  if (!hello.ok) throw new Error(hello.detail);
  link.send("control", encoder.encode(hello.text));
  const event = (kind: AdminEvent["kind"]) => client.wait((m): m is MessageOf<"admin.event"> => m.t === "admin.event" && m.event.kind === kind && (m.event as { offer?: string }).offer === offer.offer, `admin event ${kind}`, { from });
  await event("pair.code");
  await admin(client, { op: "pair.confirm", offer: offer.offer, accept: true });
  await event("pair.done");
  await until(() => added, { what: "pair.added at the phone" });
  link.close();
  return { keys, addId: added! };
}

/** A phone's normal session with one server. */
export class PhoneSession {
  readonly got: Message[] = [];
  ended: SessionEnd | null = null;
  link!: SessionLink;

  static async open(keys: DeviceKeys, port: number, server: { memberId: string; dh: string }, cluster: string): Promise<PhoneSession> {
    const session = new PhoneSession();
    const connection = await webSocketConnector.connect(`ws://127.0.0.1:${port}/v3/ws`);
    session.link = SessionLink.initiate(connection, {
      mode: "ik", transport: "tailnet", cluster,
      self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: server.memberId, dhPub: fromBase64Url(server.dh)! },
    }, {
      onFrame: (bytes) => { const decoded = decodeFrame(bytes, "server", REMOTE); if (decoded.ok) session.got.push(decoded.message); },
      onEnd: (end) => { session.ended = end; },
    });
    connection.bind({ frame: (frame) => session.link.receive(frame), closed: () => session.link.transportClosed() });
    session.link.established.then(() => {
      session.send({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: "e".repeat(32), cursors: {}, outbox: [], want: [] } as Message);
    }, () => undefined);
    return session;
  }

  send(message: Message): boolean {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok || this.link.state !== "open") return false;
    try { this.link.send("control", encoder.encode(encoded.text)); return true; } catch { return false; }
  }

  get welcomed(): boolean { return this.got.some((m) => m.t === "welcome"); }
  bye(): MessageOf<"bye"> | undefined { return this.got.find((m): m is MessageOf<"bye"> => m.t === "bye"); }
  close(): void { this.link.close(); }
}
