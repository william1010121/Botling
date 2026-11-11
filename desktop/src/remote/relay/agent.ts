// botling-agent's end of the relay path (./wire.ts): `pair` takes the offer the install line carries, shows the
// machine's name, fingerprint and code, and saves the token Botling sends once the user typed the code there; `relay`
// (the daemon) keeps one connection to the relay with that token and serves Botling's links on it, one AgentLink
// each, as `serve` does for one ssh process.
//   ~/.botling-agent/relay.json   this machine's static key, the relay, the room, Botling's key and the token (0600)
//   ~/.botling-agent/relay.pid    the daemon running now
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform, arch } from "node:os";
import { join } from "node:path";
import { b64u, deriveChannel, exportPrivateKey, generateKeyPair, importKeyPair, offerIdOf, pairTokenOf, type Channel, type KeyPair } from "../../mobile-relay/e2e";
import type { SocketLike } from "../../mobile-relay/connector";
import type { AgentLink, AgentServer } from "../agent/server";
import { openSocket } from "./ws";
import {
  MACHINE_WIRE, MUX_CLOSE, MUX_OPEN, MuxSender, Pacer, decodeOffer, fingerprintOf, machineNameFrom, muxItems, sasOf, showFingerprint,
} from "./wire";

export interface AgentRelayConfig {
  url: string; room: string;
  /** Botling's static public key. */
  desk: string;
  /** The token this machine joins with (null: not paired yet). */
  token: string | null;
  /** This machine's static key (pkcs8 and raw, base64url) and its fingerprint. */
  key: string; pub: string; id: string;
  name: string;
  pairedAt?: number;
}

const configFile = (home: string) => join(home, "relay.json");

export function readRelayConfig(home: string): AgentRelayConfig | null {
  try { return JSON.parse(readFileSync(configFile(home), "utf8")) as AgentRelayConfig; } catch { return null; }
}
function writeRelayConfig(home: string, config: AgentRelayConfig) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${configFile(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, configFile(home));
}

/** This machine's static key: kept across pairings (Botling knows the machine by it). */
async function machineKey(home: string): Promise<{ pair: KeyPair; key: string; pub: string; id: string }> {
  const saved = readRelayConfig(home);
  if (saved?.key && saved.pub) return { pair: await importKeyPair(b64u.decode(saved.key), b64u.decode(saved.pub)), key: saved.key, pub: saved.pub, id: saved.id };
  const pair = await generateKeyPair(true);
  return { pair, key: b64u.encode(await exportPrivateKey(pair)), pub: b64u.encode(pair.publicKey), id: await fingerprintOf(pair.publicKey) };
}

/** A relay socket's first steps: open, join the room, then hand back strings until it closes. */
function join_(socket: SocketLike, room: string, token: string, on: { joined(): void; d(d: string): void; closed(code: number, why: string): void }) {
  let refused = "";
  socket.onopen = () => socket.send(JSON.stringify({ t: "join", v: 1, room, token }));
  socket.onmessage = (event) => {
    let msg: { t?: string; d?: string; code?: string };
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.t === "joined") on.joined();
    else if (msg.t === "d" && typeof msg.d === "string") on.d(msg.d);
    else if (msg.t === "error") refused = String(msg.code ?? "");
  };
  socket.onerror = () => { /* onclose follows */ };
  socket.onclose = (event) => on.closed((event as { code?: number })?.code ?? 1006, refused);
}

export interface PairOptions {
  home: string;
  offer: string;
  name?: string;
  socket?(url: string): SocketLike;
  print?(line: string): void;
  now?(): number;
}

/** `botling-agent pair <code>`: resolves once Botling approved this machine (and its token is saved here). */
export async function pairMachine(options: PairOptions): Promise<AgentRelayConfig> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const offer = decodeOffer(options.offer);
  if (offer.e <= (options.now?.() ?? Date.now())) throw new Error("This pairing code has expired. Make a new one in Botling (Settings › Machines).");
  const me = await machineKey(options.home);
  const name = machineNameFrom(options.name ?? hostname().split(".")[0] ?? "machine");
  const secret = b64u.decode(offer.s);
  const ephemeral = await generateKeyPair();
  const [token, offerId] = await Promise.all([pairTokenOf(secret), offerIdOf(secret)]);
  const socket = (options.socket ?? openSocket)(offer.u);
  return new Promise<AgentRelayConfig>((resolve, reject) => {
    let channel: Channel | null = null;
    let granted: AgentRelayConfig | null = null;
    let settled = false;
    let queue: Promise<void> = Promise.resolve();
    const finish = (error: Error | null, config?: AgentRelayConfig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(1000, "done"); } catch { /* gone */ }
      if (error) reject(error); else resolve(config!);
    };
    const timer = setTimeout(() => finish(new Error("The pairing code expired before it was approved in Botling.")), Math.max(1_000, offer.e - (options.now?.() ?? Date.now())));
    timer.unref?.();
    const take = async (d: string) => {
      if (!channel) {
        const msg = JSON.parse(d) as { h?: string; eph?: string; why?: string };
        if (msg.h === "nope") { finish(new Error(msg.why ?? "Botling refused this pairing.")); return; }
        if (msg.h !== "mack" || typeof msg.eph !== "string") { finish(new Error("Botling answered something this agent does not understand.")); return; }
        channel = await deriveChannel("phone", { static: me.pair, ephemeral }, {
          mode: "pair", room: offer.r, deviceId: me.id, deskStatic: b64u.decode(offer.k), phoneStatic: me.pair.publicKey,
          phoneEphemeral: ephemeral.publicKey, deskEphemeral: b64u.decode(msg.eph), pairSecret: secret,
        });
        const code = await sasOf(channel);
        print("Pairing request sent to Botling.");
        print(`  Machine:      ${name}`);
        print(`  Fingerprint:  ${showFingerprint(me.id)}`);
        print(`  Code:         ${code}`);
        print("In Botling, open Settings › Machines, check the name and fingerprint, and type this code to approve.");
        return;
      }
      const value = await channel.open(d) as { p?: string; token?: string; name?: string };
      if (value?.p === "declined") { finish(new Error("Botling declined this machine.")); return; }
      if (value?.p === "granted" && typeof value.token === "string") {
        const config: AgentRelayConfig = {
          url: offer.u, room: offer.r, desk: offer.k, token: value.token, key: me.key, pub: me.pub, id: me.id,
          name: typeof value.name === "string" ? value.name : name, pairedAt: Date.now(),
        };
        writeRelayConfig(options.home, config);
        socket.send(JSON.stringify({ t: "d", d: await channel.seal({ p: "saved" }) }));
        print(`Approved: Botling knows this machine as ${config.name}.`);
        granted = config;
        // Botling ends the pairing connection once it has "saved"; until then keep the socket open.
        setTimeout(() => finish(null, config), 5_000).unref?.();
      }
    };
    join_(socket, offer.r, token, {
      joined: () => socket.send(JSON.stringify({ t: "d", d: JSON.stringify({ h: "mpair", v: MACHINE_WIRE, offer: offerId, key: me.pub, eph: b64u.encode(ephemeral.publicKey), name, platform: `${platform()}-${arch()}` }) })),
      d: (d) => { queue = queue.then(() => take(d)).catch((error) => finish(error instanceof Error ? error : new Error(String(error)))); },
      // What arrived before the close is read first (a "declined" just before the relay hangs up).
      closed: (code, why) => void queue.then(() => granted ? finish(null, granted) : finish(new Error(why === "denied" ? "The relay refused this pairing code (expired, or used already)."
        : why === "desk_offline" ? "Botling is not connected to the relay right now. Open Botling and try again."
          : `The relay connection closed (${code}${why ? ` ${why}` : ""}) before the pairing finished.`))),
    });
  });
}

export type AgentRelayState = "off" | "connecting" | "online" | "offline" | "revoked";

export interface AgentRelayOptions {
  home: string;
  server: AgentServer;
  socket?(url: string): SocketLike;
  log?(line: string): void;
  waits?: number[];
}

const WAITS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** After Botling refused the token (revoked, or paired again elsewhere): try again rarely. */
const REVOKED_WAIT = 10 * 60_000;
const QUIET_MS = 60_000;
const PING_MS = 20_000;

/** `botling-agent relay`: this machine's connection to Botling over the relay, kept up until stopped. */
export class AgentRelay {
  state: AgentRelayState = "off";
  private socket: SocketLike | null = null;
  private channel: Channel | null = null;
  private mux: MuxSender | null = null;
  private links = new Map<number, AgentLink>();
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private heard = 0;
  private stopped = false;
  private pacer = new Pacer();

  constructor(readonly options: AgentRelayOptions) {}
  private log(line: string) { this.options.log?.(line); }

  start() { this.stopped = false; void this.connect(); }

  private async connect() {
    if (this.stopped || this.socket) return;
    const config = readRelayConfig(this.options.home);
    const token = config?.token;
    if (!config || !token) { this.state = "off"; this.log("this machine is not paired: run `botling-agent pair <code>` with the line from Botling"); return; }
    const me = await importKeyPair(b64u.decode(config.key), b64u.decode(config.pub));
    this.state = "connecting";
    let socket: SocketLike;
    try { socket = (this.options.socket ?? openSocket)(config.url); } catch (error) { this.log(`cannot connect: ${(error as Error).message}`); this.retry(); return; }
    this.socket = socket;
    let ephemeral: KeyPair | null = null;
    let queue: Promise<void> = Promise.resolve();
    const take = async (d: string) => {
      if (this.socket !== socket) return;
      if (!this.channel) {
        const msg = JSON.parse(d) as { h?: string; eph?: string; why?: string };
        if (msg.h === "nope") { this.log(`Botling refused this machine: ${msg.why ?? ""}`); return; }
        if (msg.h !== "mack" || typeof msg.eph !== "string" || !ephemeral) return;
        const channel = await deriveChannel("phone", { static: me, ephemeral }, {
          mode: "session", room: config.room, deviceId: config.id, deskStatic: b64u.decode(config.desk), phoneStatic: me.publicKey,
          phoneEphemeral: ephemeral.publicKey, deskEphemeral: b64u.decode(msg.eph),
        });
        if (this.socket !== socket) return;
        this.channel = channel;
        this.mux = new MuxSender(channel, (sealed) => this.raw(socket, { t: "d", d: sealed }), this.pacer);
        this.state = "online";
        this.failures = 0;
        this.log("connected to Botling");
        return;
      }
      this.fromBotling(await this.channel.open(d));
    };
    join_(socket, config.room, token, {
      joined: () => {
        this.heard = Date.now();
        void generateKeyPair().then((pair) => {
          ephemeral = pair;
          this.raw(socket, { t: "d", d: JSON.stringify({ h: "mhello", v: MACHINE_WIRE, id: config.id, eph: b64u.encode(pair.publicKey) }) });
        });
        if (this.beat) clearInterval(this.beat);
        this.beat = setInterval(() => {
          if (Date.now() - this.heard > QUIET_MS) { try { socket.close(4000, "quiet"); } catch { /* gone */ } return; }
          this.raw(socket, { t: "ping" });
        }, PING_MS);
        this.beat.unref?.();
      },
      d: (d) => {
        this.heard = Date.now();
        queue = queue.then(() => take(d)).catch((error) => {
          this.log(`the channel failed: ${(error as Error).message}`);
          try { socket.close(4000, "channel"); } catch { /* gone */ }
        });
      },
      closed: (code, why) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.lost();
        if (this.stopped) { this.state = "off"; return; }
        if (why === "denied" || code === 4403) {
          this.state = "revoked";
          this.log("Botling refused this machine's token (revoked, or paired again). Pair it again with a new line from Botling.");
          this.schedule(REVOKED_WAIT);
          return;
        }
        this.retry();
      },
    });
    // Pings from the relay count as hearing from it (the socket answers them); any message does.
    const onmessage = socket.onmessage;
    socket.onmessage = (event) => { this.heard = Date.now(); onmessage?.(event); };
  }

  private raw(socket: SocketLike, msg: unknown) {
    if (socket.readyState !== 1) return;
    try { socket.send(JSON.stringify(msg)); } catch { /* onclose follows */ }
  }

  private fromBotling(value: unknown) {
    const server = this.options.server;
    for (const [c, frame] of muxItems(value)) {
      if (frame === MUX_OPEN) {
        if (!this.links.has(c)) this.links.set(c, server.connect((up) => this.mux?.push([c, up])));
        continue;
      }
      const link = this.links.get(c);
      if (!link) continue;
      if (frame === MUX_CLOSE) { this.links.delete(c); void link.closed(); continue; }
      if (frame && typeof frame === "object" && typeof (frame as { t?: unknown }).t === "string") void link.recv(frame as Record<string, unknown> & { t: string });
    }
  }

  /** The channel is gone: every link on it ends (the model's Notice for their sessions). */
  private lost() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    this.channel?.close();
    this.channel = null;
    this.mux?.close();
    this.mux = null;
    const links = [...this.links.values()];
    this.links.clear();
    for (const link of links) void link.closed();
  }

  private retry() {
    const waits = this.options.waits ?? WAITS;
    this.state = "offline";
    this.schedule(waits[Math.min(this.failures, waits.length - 1)]!);
    this.failures += 1;
  }

  private schedule(ms: number) {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, ms);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.close(1000, "bye"); } catch { /* gone */ } }
    this.lost();
    this.state = "off";
  }
}

/** One daemon per machine: <home>/relay.pid names the one running. Returns a release function, or null if another runs. */
export function relayLock(home: string, alive: (pid: number) => boolean): (() => void) | null {
  const file = join(home, "relay.pid");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return null;
  } catch { /* none */ }
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  return () => { try { if (existsSync(file) && readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file); } catch { /* gone */ } };
}
