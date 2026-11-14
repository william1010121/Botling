// The unchanged relay (relay/src/main.ts) started locally for Botling 3 tests (M2 step 13): its own process on 127.0.0.1,
// configured only through its environment (no BOTLING_* variable passes), never the online relay. And a meter: a
// loopback WebSocket hop between botlingd and the relay that forwards every message both ways and records when each
// message from botlingd arrived and how the relay closed the connection, so a test can check the relay's view of
// botlingd's rate (50/s, burst 200 at the relay; botlingd's pacer keeps to 45/s, burst 150).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { desktop, until } from "../helpers";

export const RELAY_MAIN = join(desktop, "..", "relay", "src", "main.ts");

export class LocalRelay {
  readonly child: ChildProcessWithoutNullStreams;
  port = 0;
  output = "";
  private readonly closed: Promise<number | null>;

  constructor(env: Record<string, string> = {}, port = 0) {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("BOTLING_")) base[key] = value;
    // The relay reads only its own settings; none of the deployment's (STATIC_DIR, PUBLIC_ORIGIN, TRUST_PROXY) apply here.
    for (const key of ["ALLOWED_ORIGINS", "STATIC_DIR", "PUBLIC_ORIGIN", "TRUST_PROXY", "PORT", "HOST", "MESSAGES_PER_SECOND", "MESSAGE_BURST", "MAX_FRAME_BYTES"]) delete base[key];
    this.child = spawn(process.execPath, ["--no-warnings", RELAY_MAIN], { env: { ...base, HOST: "127.0.0.1", PORT: String(port), ...env }, stdio: "pipe" });
    this.closed = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.output += `${line}\n`;
      const match = /listening on 127\.0\.0\.1:([0-9]+)/.exec(line);
      if (match) this.port = Number(match[1]);
    });
    this.child.stderr.on("data", (chunk) => { this.output += String(chunk); });
  }

  async ready(): Promise<this> {
    await until(() => {
      if (this.child.exitCode !== null) throw new Error(`the relay exited ${this.child.exitCode}: ${this.output}`);
      return this.port > 0;
    }, { timeout: 15_000, what: "the local relay" });
    return this;
  }

  get url(): string { return `ws://127.0.0.1:${this.port}/ws`; }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 6_000))]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

/** What the meter saw of one botlingd connection. */
export interface MeteredConnection {
  /** Arrival times (ms, performance clock) of botlingd's messages, and their kinds (`to`, `allow`, `desk`, `kick`). */
  times: number[];
  kinds: string[];
  /** Messages per kind. */
  counts: Record<string, number>;
  /** The relay's close of the connection to it (code, reason), when it closed it. */
  relayClosed: { code: number; reason: string } | null;
  botlingdClosed: { code: number } | null;
}

/** The relay as a token bucket counts it (relay/src/limits.ts): how many of these arrivals it would refuse. */
export function bucketRefusals(times: number[], rate: number, burst: number): { refused: number; minTokens: number } {
  let tokens = burst, at = times[0] ?? 0, refused = 0, minTokens = burst;
  for (const t of times) {
    tokens = Math.min(burst, tokens + ((t - at) / 1000) * rate);
    at = t;
    if (tokens < 1) { refused++; continue; }
    tokens -= 1;
    minTokens = Math.min(minTokens, tokens);
  }
  return { refused, minTokens };
}

/** The most arrivals inside any window of `ms`. */
export function maxInWindow(times: number[], ms = 1_000): number {
  let max = 0, j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= ms) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

export class RelayMeter {
  readonly connections: MeteredConnection[] = [];
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  port = 0;

  constructor(private readonly relayUrl: () => string) {
    this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (inbound) => this.pipe(inbound, typeof req.headers.origin === "string" ? req.headers.origin : undefined));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url(): string { return `ws://127.0.0.1:${this.port}/ws`; }

  /** One connection: the browser's Origin goes on to the relay (its ALLOWED_ORIGINS check still applies). */
  private pipe(inbound: WebSocket, origin: string | undefined): void {
    const seen: MeteredConnection = { times: [], kinds: [], counts: {}, relayClosed: null, botlingdClosed: null };
    this.connections.push(seen);
    const outbound = new WebSocket(this.relayUrl(), origin ? { origin } : undefined);
    const early: string[] = [];
    inbound.on("message", (data) => {
      const text = String(data);
      seen.times.push(performance.now());
      let kind = "?";
      try { kind = String((JSON.parse(text) as { t?: unknown }).t); } catch { /* counted as ? */ }
      seen.kinds.push(kind);
      seen.counts[kind] = (seen.counts[kind] ?? 0) + 1;
      if (outbound.readyState === 1) outbound.send(text); else early.push(text);
    });
    outbound.on("open", () => { for (const text of early.splice(0)) outbound.send(text); });
    outbound.on("message", (data) => { if (inbound.readyState === 1) inbound.send(String(data)); });
    outbound.on("close", (code: number, reason: Buffer) => {
      if (!seen.botlingdClosed) seen.relayClosed = { code, reason: String(reason) };
      try { inbound.close(code >= 4000 ? code : 1001, String(reason).slice(0, 100)); } catch { /* gone */ }
    });
    inbound.on("close", (code: number) => { seen.botlingdClosed = { code }; try { outbound.close(1000); } catch { /* gone */ } });
    outbound.on("error", () => undefined);
    inbound.on("error", () => undefined);
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }
}
