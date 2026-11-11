// Botling's end of the relay path for remote workers: the desk of its own machines room (relay/src/relay.ts). It keeps
// one outbound WebSocket to the relay while a relay machine is trusted or a pairing offer is open, puts the trusted
// machines' token hashes (and open offers' pairing tokens) on the room's allow list, takes pairing requests, and keeps
// one end-to-end channel per connected machine. RelayTransport opens the session's connections as links on that
// channel. Wire: ./wire.ts.
//   <data>/remote/relay.json   this room's key and Botling's static key for it (0600)
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, deriveChannel, exportPrivateKey, generateKeyPair, importKeyPair, offerIdOf, pairTokenOf, randomBytes, sha256Hex, type Channel, type KeyPair } from "../../mobile-relay/e2e";
import type { SocketLike } from "../../mobile-relay/connector";
import { FrameLink } from "../link";
import type { Machine, MachineStore } from "../machines";
import type { DownFrame, UpFrame } from "../protocol";
import type { LinkHandlers, SessionLink, SessionTransport } from "../session";
import { openSocket } from "./ws";
import {
  MACHINE_WIRE, MUX_CLOSE, MUX_OPEN, MuxSender, PAIR_TTL_MS, Pacer, encodeOffer, fingerprintOf, machineNameFrom, muxItems, normalizeCode, sasOf,
} from "./wire";

export type HubState = "off" | "connecting" | "online" | "offline";

export interface MachineRelayOptions {
  /** <data>/remote */
  dir: string;
  /** The relay address (Settings › Phone's, unless Settings › Machines gives its own). */
  url(): string | null;
  machines: MachineStore;
  socket?(url: string): SocketLike;
  /** How long a session's connection waits for the machine's channel before it gives up (the session retries). */
  channelWaitMs?: number;
  /** How long a pairing offer stays open. */
  pairTtlMs?: number;
  now?(): number;
  log?(line: string): void;
}

interface Offer { id: string; secret: Uint8Array; token: string; hash: string; expiresAt: number; machine: string | null }
interface Peer {
  peer: string;
  hash: string;
  kind: "new" | "pair" | "session" | "gone";
  channel?: Channel;
  machine?: string;
  /** Pairing: the code to match, wrong tries, the offer, and the agent's "saved" when it comes. */
  sas?: string;
  tries?: number;
  offer?: string;
  saved?: () => void;
  mux?: MuxSender;
  links?: Map<number, AppLink>;
  /** Frames are taken one at a time, in order. */
  queue: Promise<void>;
}
interface AppLink { c: number; frame(frame: UpFrame): void; closed(error?: string): void }

interface Saved { roomKey: string; privateKey: string; publicKey: string }

const WAITS = [1_000, 2_000, 5_000, 10_000, 30_000];
const QUIET_MS = 60_000;
const PING_MS = 20_000;

export class MachineRelay {
  state: HubState = "off";
  private socket: SocketLike | null = null;
  private keys: Promise<{ room: string; roomKey: string; pair: KeyPair }> | null = null;
  private room: string | null = null;
  private offers = new Map<string, Offer>();
  private peers = new Map<string, Peer>();
  private channels = new Map<string, Peer>();
  private waiters = new Map<string, Set<() => void>>();
  private pacer = new Pacer();
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private heard = 0;
  private stopped = false;
  private nextLink = 1;
  private listeners = new Set<() => void>();
  private offMachines: () => void;

  constructor(readonly options: MachineRelayOptions) {
    this.offMachines = options.machines.onChange((machine, change) => {
      if (machine.via !== "relay") return;
      if (change === "revoked" || change === "removed") this.dropMachine(machine.id, "The machine was revoked.");
      this.pushAllow();
      this.sync();
    });
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private log(line: string) { this.options.log?.(`machine relay: ${line}`); }
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const l of this.listeners) { try { l(); } catch { /* a listener's problem */ } } }

  /** Whether the machine's agent is connected now. */
  connected(machineId: string) { return this.channels.has(machineId); }

  /** Waits for the machine's agent to connect again on a new channel (after it restarted); false on timeout. */
  async reconnected(machineId: string, ms = 20_000): Promise<boolean> {
    const before = this.channels.get(machineId);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const now = this.channels.get(machineId);
      if (now && now !== before) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  // ---- Keys.

  private loadKeys() {
    return this.keys ??= (async () => {
      const file = join(this.options.dir, "relay.json");
      let saved: Saved | null = null;
      try { saved = JSON.parse(readFileSync(file, "utf8")) as Saved; } catch { saved = null; }
      if (!saved?.roomKey || !saved.privateKey || !saved.publicKey) {
        const pair = await generateKeyPair(true);
        saved = { roomKey: nodeRandomBytes(32).toString("base64url"), privateKey: b64u.encode(await exportPrivateKey(pair)), publicKey: b64u.encode(pair.publicKey) };
        mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
        renameSync(tmp, file);
      }
      const pair = await importKeyPair(b64u.decode(saved.privateKey), b64u.decode(saved.publicKey));
      const room = createHash("sha256").update(Buffer.from(saved.roomKey, "base64url")).digest("base64url");
      return { room, roomKey: saved.roomKey, pair };
    })();
  }

  // ---- The socket to the relay.

  private wanted(): boolean {
    if (this.stopped || !this.options.url()) return false;
    this.expireOffers();
    return this.offers.size > 0 || this.options.machines.list().some((m) => m.via === "relay" && m.trust === "trusted");
  }

  /** Connects or disconnects as needed (a machine trusted or revoked, an offer made, the address changed). */
  sync() {
    if (this.wanted()) {
      if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      if (!this.socket && !this.timer) void this.connect();
    } else if ((this.socket || this.timer) && !this.idle) {
      // Leave a little later: what was just sent (a "declined") still reaches the machine.
      this.idle = setTimeout(() => { this.idle = null; if (!this.wanted()) this.disconnect("off"); }, this.stopped ? 0 : 2_000);
      this.idle.unref?.();
    }
  }

  private async connect() {
    const url = this.options.url();
    if (!url || this.socket || this.stopped) return;
    const { roomKey } = await this.loadKeys();
    if (this.socket || this.stopped) return;
    this.state = "connecting";
    this.changed();
    let socket: SocketLike;
    try { socket = (this.options.socket ?? openSocket)(url); } catch (error) { this.log(`cannot connect: ${(error as Error).message}`); this.retry(); return; }
    this.socket = socket;
    socket.onopen = () => { this.heard = this.now(); socket.send(JSON.stringify({ t: "desk", v: 1, key: roomKey })); };
    socket.onmessage = (event) => { if (this.socket === socket) { this.heard = this.now(); this.fromRelay(String(event.data)); } };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lost(`The relay connection closed (${(event as { code?: number })?.code ?? "?"}).`);
      if (this.wanted()) this.retry(); else { this.state = "off"; this.changed(); }
    };
  }

  private retry() {
    this.state = "offline";
    this.changed();
    if (this.timer || this.stopped) return;
    const wait = WAITS[Math.min(this.failures, WAITS.length - 1)]!;
    this.failures += 1;
    this.timer = setTimeout(() => { this.timer = null; if (this.wanted()) void this.connect(); else { this.state = "off"; this.changed(); } }, wait);
    this.timer.unref?.();
  }

  private disconnect(state: HubState) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.close(1000, "bye"); } catch { /* gone */ } }
    this.lost("Botling left the relay.");
    this.state = state;
    this.changed();
  }

  /** The socket is gone: every channel and pairing on it ends. */
  private lost(reason: string) {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    this.room = null;
    for (const peer of [...this.peers.values()]) this.dropPeer(peer, reason);
  }

  private raw(msg: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try { socket.send(JSON.stringify(msg)); } catch { /* onclose follows */ }
  }

  private fromRelay(text: string) {
    let msg: { t?: string; room?: string; peer?: string; h?: string; d?: string };
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case "ready":
        this.room = msg.room ?? null;
        this.failures = 0;
        this.state = "online";
        this.pushAllow();
        if (this.beat) clearInterval(this.beat);
        this.beat = setInterval(() => {
          if (this.now() - this.heard > QUIET_MS) { try { this.socket?.close(4000, "quiet"); } catch { /* gone */ } return; }
          this.raw({ t: "ping" });
        }, PING_MS);
        this.beat.unref?.();
        this.changed();
        return;
      case "open":
        if (typeof msg.peer === "string" && typeof msg.h === "string") this.peers.set(msg.peer, { peer: msg.peer, hash: msg.h, kind: "new", queue: Promise.resolve() });
        return;
      case "from": {
        const peer = typeof msg.peer === "string" ? this.peers.get(msg.peer) : undefined;
        if (!peer || typeof msg.d !== "string") return;
        const d = msg.d;
        peer.queue = peer.queue.then(() => this.fromPeer(peer, d)).catch((error) => {
          this.log(`peer ${peer.peer}: ${(error as Error).stack ?? error}`);
          this.kick(peer, "The machine sent something Botling could not read.");
        });
        return;
      }
      case "close": {
        const peer = typeof msg.peer === "string" ? this.peers.get(msg.peer) : undefined;
        if (peer) this.dropPeer(peer, "The machine's connection to the relay ended.");
        return;
      }
      default: return;
    }
  }

  /** The room's allow list: trusted machines' tokens and open offers' pairing tokens. */
  private pushAllow() {
    if (!this.room) return;
    this.expireOffers();
    const tokens: { h: string; exp?: number }[] = [];
    for (const m of this.options.machines.list()) if (m.via === "relay" && m.trust === "trusted" && m.relay?.tokenHash) tokens.push({ h: m.relay.tokenHash });
    for (const offer of this.offers.values()) tokens.push({ h: offer.hash, exp: offer.expiresAt });
    this.raw({ t: "allow", tokens });
  }

  private kick(peer: Peer, reason: string) {
    this.raw({ t: "kick", peer: peer.peer });
    this.dropPeer(peer, reason);
  }

  private dropPeer(peer: Peer, reason: string) {
    if (peer.kind === "gone") return;
    const was = peer.kind;
    peer.kind = "gone";
    this.peers.delete(peer.peer);
    peer.channel?.close();
    peer.mux?.close();
    if (was === "session" && peer.machine) {
      if (this.channels.get(peer.machine) === peer) this.channels.delete(peer.machine);
      for (const link of [...(peer.links?.values() ?? [])]) link.closed(reason);
      peer.links?.clear();
      this.changed();
    }
    // A machine still waiting for its code cannot be told the outcome any more: its request ends.
    if (was === "pair" && peer.machine) {
      const offer = peer.offer ? this.offers.get(peer.offer) : undefined;
      if (offer) { this.offers.delete(offer.id); this.pushAllow(); }
      if (this.options.machines.get(peer.machine)?.trust === "asked") this.options.machines.decline(peer.machine);
    }
  }

  private dropMachine(machineId: string, reason: string) {
    const peer = this.channels.get(machineId);
    if (peer) this.kick(peer, reason);
    for (const p of [...this.peers.values()]) if (p.machine === machineId) this.kick(p, reason);
  }

  // ---- Handshakes and channels.

  private async fromPeer(peer: Peer, d: string) {
    if (peer.kind === "gone") return;
    if (peer.channel) {
      const value = await peer.channel.open(d);
      if (peer.kind === "pair") { if ((value as { p?: string })?.p === "saved") peer.saved?.(); return; }
      if (peer.kind === "session") { this.fromMachine(peer, value); return; }
      return;
    }
    const hello = JSON.parse(d) as { h?: string; v?: number; offer?: string; key?: string; eph?: string; name?: string; id?: string; platform?: string };
    if (hello.v !== MACHINE_WIRE || typeof hello.eph !== "string") { this.nope(peer, "This botling-agent speaks another version; update it."); return; }
    const { room, pair } = await this.loadKeys();
    if (hello.h === "mpair") {
      const offer = typeof hello.offer === "string" ? this.offers.get(hello.offer) : undefined;
      if (!offer || offer.hash !== peer.hash || offer.machine || offer.expiresAt <= this.now() || typeof hello.key !== "string") { this.nope(peer, "This pairing code was used already or has expired. Make a new one in Botling."); return; }
      const key = b64u.decode(hello.key);
      const fingerprint = await fingerprintOf(key);
      const ephemeral = await generateKeyPair();
      const channel = await deriveChannel("desk", { static: pair, ephemeral }, {
        mode: "pair", room, deviceId: fingerprint, deskStatic: pair.publicKey, phoneStatic: key,
        phoneEphemeral: b64u.decode(hello.eph), deskEphemeral: ephemeral.publicKey, pairSecret: offer.secret,
      });
      const machine = this.options.machines.add({
        name: this.freeName(machineNameFrom(String(hello.name ?? ""))), via: "relay",
        relay: { publicKey: hello.key, fingerprint, tokenHash: null, expiresAt: offer.expiresAt },
        ...(typeof hello.platform === "string" ? { info: { platform: hello.platform.slice(0, 64), at: this.now() } } : {}),
      });
      offer.machine = machine.id;
      Object.assign(peer, { kind: "pair", channel, machine: machine.id, sas: await sasOf(channel), tries: 0, offer: offer.id });
      this.raw({ t: "to", peer: peer.peer, d: JSON.stringify({ h: "mack", eph: b64u.encode(ephemeral.publicKey) }) });
      this.changed();
      return;
    }
    if (hello.h === "mhello") {
      const machine = this.options.machines.list().find((m) => m.via === "relay" && m.trust === "trusted" && m.relay?.tokenHash === peer.hash);
      if (!machine?.relay || machine.relay.fingerprint !== hello.id) { this.nope(peer, "Botling does not know this machine any more. Pair it again."); return; }
      const ephemeral = await generateKeyPair();
      const channel = await deriveChannel("desk", { static: pair, ephemeral }, {
        mode: "session", room, deviceId: machine.relay.fingerprint, deskStatic: pair.publicKey, phoneStatic: b64u.decode(machine.relay.publicKey),
        phoneEphemeral: b64u.decode(hello.eph), deskEphemeral: ephemeral.publicKey,
      });
      const old = this.channels.get(machine.id);
      if (old) this.kick(old, "The machine connected again.");
      Object.assign(peer, {
        kind: "session", channel, machine: machine.id, links: new Map(),
        mux: new MuxSender(channel, (sealed) => this.raw({ t: "to", peer: peer.peer, d: sealed }), this.pacer),
      });
      this.channels.set(machine.id, peer);
      this.raw({ t: "to", peer: peer.peer, d: JSON.stringify({ h: "mack", eph: b64u.encode(ephemeral.publicKey) }) });
      this.log(`${machine.name} connected`);
      for (const wake of [...(this.waiters.get(machine.id) ?? [])]) wake();
      this.changed();
      return;
    }
    this.nope(peer, "Botling did not understand this machine.");
  }

  private nope(peer: Peer, why: string) {
    this.raw({ t: "to", peer: peer.peer, d: JSON.stringify({ h: "nope", why }) });
    // Let the refusal reach the machine before the relay closes it.
    setTimeout(() => this.kick(peer, why), 200).unref?.();
  }

  private fromMachine(peer: Peer, value: unknown) {
    for (const [c, frame] of muxItems(value)) {
      const link = peer.links?.get(c);
      if (!link) continue;
      if (frame === MUX_CLOSE) { peer.links!.delete(c); link.closed("The machine closed the connection."); continue; }
      if (frame && typeof frame === "object" && typeof (frame as { t?: unknown }).t === "string") link.frame(frame as UpFrame);
    }
  }

  private freeName(base: string) {
    const taken = new Set(this.options.machines.list().filter((m) => m.trust !== "revoked").map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) { const name = `${base.slice(0, 60)}-${i}`; if (!taken.has(name.toLowerCase())) return name; }
  }

  // ---- Pairing (Settings › Machines).

  private expireOffers() {
    const now = this.now();
    for (const offer of [...this.offers.values()]) {
      if (offer.expiresAt > now) continue;
      this.offers.delete(offer.id);
      // Expire: a request still waiting for its code is forgotten, and its connection ends.
      if (offer.machine && this.options.machines.get(offer.machine)?.trust === "asked") {
        for (const p of [...this.peers.values()]) if (p.offer === offer.id) { this.raw({ t: "kick", peer: p.peer }); p.kind = "gone"; this.peers.delete(p.peer); p.channel?.close(); }
        this.options.machines.decline(offer.machine);
      }
    }
  }

  /** A new pairing offer: the code the install line carries to the machine. */
  async offer(): Promise<{ offer: string; expiresAt: number }> {
    const url = this.options.url();
    if (!url) throw new Error("Set a relay address first (Settings › Phone › Relay).");
    const { room, pair } = await this.loadKeys();
    const secret = randomBytes(32);
    const token = await pairTokenOf(secret);
    const offer: Offer = {
      id: await offerIdOf(secret), secret, token, hash: await sha256Hex(token),
      expiresAt: this.now() + (this.options.pairTtlMs ?? PAIR_TTL_MS), machine: null,
    };
    this.offers.set(offer.id, offer);
    const expiry = setTimeout(() => { this.expireOffers(); this.pushAllow(); this.sync(); this.changed(); }, offer.expiresAt - this.now() + 50);
    expiry.unref?.();
    this.pushAllow();
    this.sync();
    return { offer: encodeOffer({ u: url, r: room, k: b64u.encode(pair.publicKey), s: b64u.encode(secret), e: offer.expiresAt }), expiresAt: offer.expiresAt };
  }

  private pairPeer(machineId: string): Peer | undefined {
    return [...this.peers.values()].find((p) => p.kind === "pair" && p.machine === machineId);
  }

  /** Whether a machine is waiting for its code here (its pairing connection is open). */
  waiting(machineId: string) { return !!this.pairPeer(machineId); }

  /**
   * Approve with the code the machine shows: Botling sends the machine its token, waits for it to be saved there,
   * then trusts the machine (its token on the allow list). A wrong code three times declines the request.
   */
  async approve(machineId: string, code: string): Promise<Machine> {
    this.expireOffers();
    const peer = this.pairPeer(machineId);
    const machine = this.options.machines.get(machineId);
    if (!peer || !machine || machine.trust !== "asked" || !peer.channel) throw new Error("That machine is no longer waiting (its pairing ended). Run the install line again.");
    if (normalizeCode(code) !== normalizeCode(peer.sas!)) {
      peer.tries = (peer.tries ?? 0) + 1;
      if (peer.tries >= 3) { await this.decline(machineId); throw new Error("Wrong code three times: the request was declined."); }
      throw new Error("That code does not match the one this machine shows.");
    }
    const token = b64u.encode(randomBytes(32));
    const saved = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      timer.unref?.();
      peer.saved = () => { clearTimeout(timer); resolve(true); };
    });
    this.raw({ t: "to", peer: peer.peer, d: await peer.channel.seal({ p: "granted", token, name: machine.name }) });
    if (!await saved) {
      this.kick(peer, "The machine did not confirm its pairing.");
      throw new Error("The machine did not confirm its pairing. Run the install line again.");
    }
    const offer = peer.offer ? this.offers.get(peer.offer) : undefined;
    if (offer) this.offers.delete(offer.id);
    peer.kind = "gone"; // the pairing connection is done; the relay closes it when the allow list drops its token
    this.peers.delete(peer.peer);
    peer.channel.close();
    const approved = this.options.machines.approve(machineId, { relay: { ...machine.relay!, tokenHash: await sha256Hex(token), expiresAt: undefined } });
    this.pushAllow();
    return approved;
  }

  /** Decline a machine waiting for its code: it is told so and forgotten. */
  async decline(machineId: string) {
    const peer = this.pairPeer(machineId);
    if (peer?.channel) {
      try { this.raw({ t: "to", peer: peer.peer, d: await peer.channel.seal({ p: "declined" }) }); } catch { /* gone */ }
      const p = peer;
      setTimeout(() => this.kick(p, "Declined."), 200).unref?.();
    }
    const offer = peer?.offer ? this.offers.get(peer.offer) : undefined;
    if (offer) { this.offers.delete(offer.id); this.pushAllow(); }
    if (peer) peer.kind = "gone";
    return this.options.machines.decline(machineId);
  }

  // ---- Sessions' connections.

  /** Waits for the machine's channel (its agent's daemon may be reconnecting). */
  private channelFor(machineId: string, ms: number): Promise<Peer | null> {
    const now = this.channels.get(machineId);
    if (now) return Promise.resolve(now);
    this.sync();
    return new Promise((resolve) => {
      const set = this.waiters.get(machineId) ?? new Set();
      this.waiters.set(machineId, set);
      const done = (peer: Peer | null) => { clearTimeout(timer); set.delete(wake); resolve(peer); };
      const wake = () => done(this.channels.get(machineId) ?? null);
      const timer = setTimeout(() => done(null), ms);
      set.add(wake);
    });
  }

  /** Opens connection g of a session to the machine as a link on its channel. */
  openLink(machineId: string, name: () => string, handlers: LinkHandlers): SessionLink {
    const c = this.nextLink++;
    let peer: Peer | null = null;
    let ended = false;
    const early: DownFrame[] = [];
    const end = (error?: string) => {
      if (ended) return;
      ended = true;
      if (peer) peer.links?.delete(c);
      link.end(error);
      handlers.closed(error);
    };
    const link = new FrameLink((frame) => { if (peer) peer.mux!.push([c, frame]); else early.push(frame); }, (frame) => handlers.frame(frame));
    void this.channelFor(machineId, this.options.channelWaitMs ?? 10_000).then((found) => {
      if (ended) return;
      if (!found || found.kind !== "session") {
        end(this.state === "online" ? `${name()} is not connected to the relay. Is botling-agent running there (\`~/.botling-agent/bin/botling-agent relay\`)?`
          : `Botling cannot reach the relay (${this.state}).`);
        return;
      }
      peer = found;
      peer.links!.set(c, { c, frame: (f) => link.receive(f as unknown as Record<string, unknown> & { t: string }), closed: (error) => end(error) });
      peer.mux!.push([c, MUX_OPEN]);
      for (const frame of early.splice(0)) peer.mux!.push([c, frame]);
    });
    return {
      send: (frame) => link.send(frame),
      close: () => {
        if (ended) return;
        if (peer && peer.kind === "session") peer.mux!.push([c, MUX_CLOSE]);
        queueMicrotask(() => end());
      },
      rpc: (op, args) => link.rpc(op, args),
      sendBlob: (data) => link.sendBlob(data),
      takeBlob: (id) => link.takeBlob(id),
    };
  }

  stop() {
    this.stopped = true;
    this.offMachines();
    this.disconnect("off");
  }

  exists() { return existsSync(join(this.options.dir, "relay.json")); }
}

/** The relay path's SessionTransport for one machine. */
export class RelayTransport implements SessionTransport {
  constructor(private hub: MachineRelay, private machine: { id: string; name(): string }, private upgrader?: () => Promise<void>) {}

  open(_session: string, _gen: number, handlers: LinkHandlers): SessionLink {
    return this.hub.openLink(this.machine.id, this.machine.name, handlers);
  }

  /** What the machine's agent reports (node, git, claude, its version). */
  async info(): Promise<Record<string, unknown>> {
    let closed: string | undefined;
    const link = this.open("", 0, { frame: () => {}, closed: (error) => { closed = error; } });
    try { return await link.rpc("info", {}) as Record<string, unknown>; }
    catch (error) { throw new Error(closed ?? (error as Error).message); }
    finally { link.close(); }
  }

  /** The agent there updates itself from the GitHub release of the app's version (milestone 3). */
  upgrade(): Promise<void> {
    if (this.upgrader) return this.upgrader();
    return Promise.reject(new Error(`botling-agent on ${this.machine.name()} is another version than Botling; update it there.`));
  }
}
