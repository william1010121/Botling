// spec/driver/relaypair-driver.ts against the real code.
// RelayPair: a real RelayConnector (and RelayStore on disk) behind a relay played here: it forwards what phones send
// at once and keeps what the desktop sends to each phone, decoded, until that phone reads it; a kick or a drop
// stops delivery. The phones are played here too, with the real handshake and channel (e2e.ts). The connector's
// onStep holds each modelled step until step() lets it go; a call returns once every peer waits at a step or for a
// frame (its inbox has settled).
// The phones speak pairing v2 (they announce it in {t:'pair'} and acknowledge `paired`); the ack timer is fired by
// timeout(), never by the clock.
// LanPair: one real PairingStore per process on one pairing folder, with a clock the driver moves. Phones redeem
// asking for the ack, each at its own moment (the clock moves a millisecond per redeem).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  LanPairDriver, LanPairDriverOptions, RelayPairDriver, RelayPairDriverOptions, RelayPairStep,
} from "../../spec/driver/relaypair-driver";
import type { RelayDown, RelayPc } from "../../spec/reference/relaypair";
import { okResponse } from "../src/contract";
import type { MobileCore } from "../src/mobile-bridge/bridge";
import { PAIR_ACK_MS, PAIR_TTL_MS, PairingStore } from "../src/mobile-bridge/pairing";
import { RELAY_PAIR_TTL_MS, RelayConnector, type SocketLike } from "../src/mobile-relay/connector";
import { b64u, deriveChannel, deviceIdOf, generateKeyPair, offerIdOf, pairTokenOf, type Channel, type KeyPair } from "../src/mobile-relay/e2e";
import { RELAY_PAIR_ACK } from "../src/mobile-relay/protocol";
import { RelayStore } from "../src/mobile-relay/store";

const ROOM = "r".repeat(43);
const hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Saved { keys: KeyPair; deviceId: string; token: string }
interface Phone {
  mode: "pair" | "session";
  keys: KeyPair; eph: KeyPair; deviceId: string; secret?: Uint8Array;
  channel?: Channel;
  ph: "wait" | "keys" | "ready" | "refused" | "lost";
  /** Frames on their way to this phone, decoded in arrival order. */
  down: { kind: RelayDown; raw?: any }[];
  decoding: Promise<unknown>;
  cut: boolean; kicked: boolean;
}
interface PeerRef { stage: string; inbox: Promise<unknown> }

export async function relaypairDriver({ conns, offers, root }: RelayPairDriverOptions): Promise<RelayPairDriver> {
  let now = Date.now();
  const store = new RelayStore(join(root, "mobile"), () => now);
  const core: MobileCore = { async mobileCommand(raw: any) { return okResponse(raw.id, { epoch: "e", seq: 1, bots: [], chat: { botId: "main", messages: [], tasks: [] } }); } };
  const gates = new Map<string, { step: RelayPairStep; release: () => void }>();
  const waiters = new Map<string, () => void>();
  const phones = new Map<string, Phone>();
  const peers = new Map<string, PeerRef>();
  const saved = new Map<string, Saved>();
  const secrets = new Map<string, Uint8Array>();
  const offerObjects = new Map<string, any>();
  let desk: SocketLike | null = null;

  const toDesk = (msg: unknown) => desk!.onmessage!({ data: JSON.stringify(msg) });
  /** The desktop sent something to the relay. */
  const fromDesk = (msg: any) => {
    if (msg.t === "desk") queueMicrotask(() => toDesk({ t: "ready", room: ROOM }));
    if (msg.t !== "to" && msg.t !== "kick") return;
    const phone = phones.get(msg.peer);
    if (!phone || phone.cut || phone.kicked) return;
    if (msg.t === "kick") {
      phone.kicked = true;
      phone.decoding = phone.decoding.then(() => { phone.down.push({ kind: "bye" }); });
      return;
    }
    phone.decoding = phone.decoding.then(async () => {
      if (!phone.channel) {
        const clear = JSON.parse(msg.d);
        phone.down.push({ kind: clear.h === "ack" ? "ack" : "nope", raw: clear });
      } else {
        const message: any = await phone.channel.open(msg.d);
        phone.down.push({ kind: message.t, raw: message });
      }
    });
  };

  const connector = new RelayConnector({
    store, core, coreId: () => "c".repeat(32), now: () => now, waits: [60_000], ackMs: 3_600_000,
    ledger: () => { throw new Error("no mutations here"); },
    socket: () => {
      const sock: SocketLike & { readyState: number } = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        send(text: string) { fromDesk(JSON.parse(text)); },
        close() { sock.readyState = 3; },
      };
      desk = sock;
      queueMicrotask(() => { sock.readyState = 1; sock.onopen?.({}); });
      return sock;
    },
    onStep: (step, peer) => new Promise<void>((release) => {
      gates.set(peer, { step, release });
      const wake = waiters.get(peer);
      waiters.delete(peer);
      wake?.();
    }),
  });
  connector.start();
  await connector.setURL("wss://relay.example/ws");
  for (let i = 0; connector.view().state !== "online"; i++) { if (i > 1_000) throw new Error("relay not online"); await tick(); }

  const gateHit = (conn: string) => new Promise<void>((resolve) => waiters.set(conn, resolve));
  /** Until every peer waits at a step or for a frame, and every frame to a phone is decoded. */
  const settle = async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all([...phones.values()].map((p) => p.decoding));
      // A revoke's `revoked` is sealed outside the inbox (fromPhone does not wait for end()).
      await Promise.all([...peers.values()].map((p: any) => p.channel?.sealing));
      await Promise.all([...peers.entries()].map(([conn, peer]) => (gates.has(conn) ? undefined : Promise.race([peer.inbox, gateHit(conn)]))));
      for (let i = 0; i < 5; i++) await tick();
    }
    waiters.clear();
  };
  const phoneOf = (conn: string) => { const p = phones.get(conn); if (!p) throw new Error(`no phone on ${conn}`); return p; };
  const send = (conn: string, d: string) => toDesk({ t: "from", peer: conn, d });
  const open = async (conn: string, token: string, phone: Phone, hello: unknown) => {
    phones.set(conn, phone);
    toDesk({ t: "open", peer: conn, h: hex(token) });
    peers.set(conn, (connector as any).peers.get(conn));
    send(conn, JSON.stringify(hello));
    await settle();
  };
  const connOfDevice = (id: string) => [...phones.entries()].find(([, p]) => p.mode === "pair" && p.deviceId === id)?.[0];
  const connOfPeer = (peer: unknown) => [...peers.entries()].find(([, p]) => p === peer)?.[0] ?? null;

  return {
    async make(offer) {
      const before = new Set(((connector as any).offers as Map<string, unknown>).keys());
      const { url } = await connector.pair();
      secrets.set(offer, b64u.decode(new URLSearchParams(new URL(url).hash.slice(1)).get("s")!));
      for (const [id, o] of (connector as any).offers as Map<string, unknown>) if (!before.has(id)) offerObjects.set(offer, o);
    },
    async expire() { now += RELAY_PAIR_TTL_MS; },
    async joinPair(conn, offer) {
      const secret = secrets.get(offer)!;
      const keys = await generateKeyPair(), eph = await generateKeyPair();
      const phone: Phone = { mode: "pair", keys, eph, deviceId: await deviceIdOf(keys.publicKey), secret, ph: "wait", down: [], decoding: Promise.resolve(), cut: false, kicked: false };
      await open(conn, await pairTokenOf(secret), phone,
        { h: "pair", v: 1, offer: await offerIdOf(secret), device: b64u.encode(keys.publicKey), eph: b64u.encode(eph.publicKey) });
    },
    async joinSession(conn, device) {
      const was = saved.get(device)!;
      const eph = await generateKeyPair();
      const phone: Phone = { mode: "session", keys: was.keys, eph, deviceId: was.deviceId, ph: "wait", down: [], decoding: Promise.resolve(), cut: false, kicked: false };
      await open(conn, was.token, phone, { h: "hello", v: 1, device: was.deviceId, eph: b64u.encode(eph.publicKey) });
    },
    async recv(conn) {
      const phone = phoneOf(conn);
      await phone.decoding;
      const frame = phone.down.shift();
      if (!frame) throw new Error(`nothing on its way to ${conn}`);
      if (frame.kind === "ack" && phone.ph === "wait") {
        phone.channel = await deriveChannel("phone", { static: phone.keys, ephemeral: phone.eph }, {
          mode: phone.mode, room: ROOM, deviceId: phone.deviceId, deskStatic: b64u.decode(store.settings()!.publicKey),
          phoneStatic: phone.keys.publicKey, phoneEphemeral: phone.eph.publicKey, deskEphemeral: b64u.decode(frame.raw.eph), pairSecret: phone.secret,
        });
        phone.ph = "keys";
        send(conn, await phone.channel.seal(phone.mode === "pair" ? { t: "pair", name: "Phone", v: RELAY_PAIR_ACK } : { t: "hello" }));
      } else if ((frame.kind === "paired" || frame.kind === "ready") && phone.ph === "keys") {
        phone.ph = "ready";
        if (frame.kind === "paired") {
          saved.set(conn, { keys: phone.keys, deviceId: frame.raw.deviceId, token: frame.raw.token });
          send(conn, await phone.channel!.seal({ t: "ack" }));
        }
      } else if ((frame.kind === "nope" || frame.kind === "revoked") && phone.ph !== "refused" && phone.ph !== "lost") phone.ph = "refused";
      else if (frame.kind === "bye" && (phone.ph === "wait" || phone.ph === "keys")) phone.ph = "lost";
      await settle();
      return frame.kind;
    },
    async request(conn) {
      const phone = phoneOf(conn);
      send(conn, await phone.channel!.seal({ t: "req", id: "r1", cmd: { type: "chat.snapshot", botId: "main" } }));
      await settle();
    },
    async drop(conn) {
      const phone = phoneOf(conn);
      await phone.decoding;
      phone.cut = true;
      phone.down = [];
      if (phone.ph !== "ready") phone.ph = "lost";
    },
    async deskClose(conn) {
      toDesk({ t: "close", peer: conn });
      await settle();
    },
    async timeout(conn) {
      const peer: any = peers.get(conn);
      clearTimeout(peer.timer);
      (connector as any).ackLate(peer);
      await settle();
    },
    async step(conn) {
      const gate = gates.get(conn);
      if (!gate) throw new Error(`${conn} waits at no step`);
      gates.delete(conn);
      gate.release();
      await settle();
      return gate.step;
    },
    waiting() { return Object.fromEntries(conns.map((c) => [c, gates.get(c)?.step ?? null])); },
    async revoke(device) {
      const phone = phoneOf(device);
      const id = saved.get(device)?.deviceId ?? phone.deviceId;
      await connector.revoke(id);
      await settle();
    },
    observe() {
      const pc = (conn: string): RelayPc => {
        const peer = peers.get(conn);
        if (!peer) return "idle";
        if (peer.stage === "closed") return "closed";
        const gate = gates.get(conn)?.step;
        if (peer.stage === "new") return gate === "HsKeys" ? "hs" : "new";
        if (peer.stage === "keys") return "keys";
        if (peer.stage === "held") return gate === "Grant" ? "granting" : "held";
        return gate === "Grant" ? "granting" : gate === "ReqSend" ? "serving" : "ready";
      };
      const busy = (conn: string) => ["HsCheck", "Confirm", "Commit", "ReqCheck"].includes(gates.get(conn)?.step ?? "");
      return {
        used: Object.fromEntries(offers.map((o) => [o, offerObjects.get(o)?.used === true])),
        claim: Object.fromEntries(offers.map((o) => [o, connOfPeer(offerObjects.get(o)?.claim)])),
        store: connector.devices().map((d) => connOfDevice(d.id) ?? `?${d.id}`).sort(),
        pc: Object.fromEntries(conns.map((c) => [c, pc(c)])),
        busy: Object.fromEntries(conns.map((c) => [c, busy(c)])),
        down: Object.fromEntries(conns.map((c) => [c, phones.get(c)?.down.map((f) => f.kind) ?? []])),
        saved: [...saved.keys()].sort(),
      };
    },
    close() {
      for (const gate of gates.values()) gate.release();
      connector.stop();
    },
  };
}

export function lanpairDriver({ procs, phones, codes, root }: LanPairDriverOptions): LanPairDriver {
  let now = 1_700_000_000_000;
  const dir = join(root, "pairing");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stores = new Map(procs.map((q) => [q, new PairingStore(dir, () => now)] as const));
  const secrets = new Map<string, string>();
  const tokens = new Map<string, string>();
  const redeemedAt = new Map<string, number>();
  const deviceOf = (phone: string) => `phone-${phone}`.padEnd(16, "0");
  const read = (name: string): any[] => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : []);
  const phoneOfId = (id: string) => phones.find((f) => `pair-${deviceOf(f)}` === id) ?? `?${id}`;
  const phoneOfToken = (hash: string) => [...tokens.entries()].find(([, t]) => hex(t) === hash)?.[0] ?? `?${hash}`;
  return {
    create(proc, code) { secrets.set(code, stores.get(proc)!.createOffer().secret); },
    redeem(proc, phone, code) {
      now += 1;
      const result = stores.get(proc)!.redeem(secrets.get(code), deviceOf(phone), phone, true);
      if (!result.ok && result.reason === "limited") throw new Error("rate limited");
      if (!result.ok) return "invalid";
      if (result.ack !== true) throw new Error("the store did not ask for the ack");
      tokens.set(phone, result.token);
      redeemedAt.set(phone, now);
      return "token";
    },
    ack: (proc, phone) => (stores.get(proc)!.ack(tokens.get(phone)) ? "paired" : "late"),
    revoke: (proc, phone) => stores.get(proc)!.revoke(deviceOf(phone)),
    expire() { now += PAIR_TTL_MS; },
    due(phone) { now = Math.max(now, redeemedAt.get(phone)! + PAIR_ACK_MS); },
    observe() {
      const listed = read("pairing-offers.json");
      const mark = (code: string) => {
        const secret = secrets.get(code);
        const o = secret === undefined ? undefined : listed.find((x) => x.secretHash === hex(secret));
        if (!o) return "no";
        if (o.held) return phoneOfToken(o.held.tokenHash);
        return o.expiresAt > now ? "live" : "no";
      };
      return {
        offers: Object.fromEntries(codes.map((c) => [c, mark(c)])),
        clients: read("paired-clients.json").map((c) => phoneOfId(c.id)).sort(),
        served: stores.get(procs[0]!)!.clients().map((c) => phoneOfId(c.id)).sort(),
      };
    },
  };
}
