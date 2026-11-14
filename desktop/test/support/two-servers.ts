// The Botling 3 two-server test harness (M3 brief §3, step 2): N `botlingd` processes on this machine (default 2,
// "A" and "B"), each with its own temp data folder, socket and loopback port, the fake engine, no window; and fault
// proxies (fault-proxy.ts) between them. Later M3 steps (peer sessions, pairing, gossip, replication, forwarding, peer
// content) drive real servers through it; its own self-test is test/unit/two-servers-harness.test.ts.
//
//   const cluster = await startServers({ name: "gossip" });         // A and B running, ready
//   const { a, b } = cluster;
//   const client = await a.client();                                 // a scripted front end on A's socket
//   await b.kill();  await b.start();                                 // SIGKILL + restart (store kept)
//   const file = b.backup();  await b.restore(file);                 // `botlingd backup` / `restore` (stopped first)
//   const proxy = await cluster.proxy(b, "websocket");               // A dials proxy.port instead of B's port
//   a.assertLoopbackOnly();                                          // every TCP/UDP socket it listens on is 127.0.0.1
//   await cluster.cleanup();                                         // every process stopped, every folder removed
//
// Environment: every server gets a fresh environment with none of this process's BOTLING_* / ELECTRON_* / CLAUDE*
// variables (botlingdEnv), only its data folder, the fake engine and the harness's own settings. Its port is passed
// as `BOTLING_SERVER_PORT` (LISTEN_PORT_ENV); botlingd has no TCP listener until M2 step 6 (`server/net/http.ts`), so
// until then the port is reserved for it and `assertLoopbackOnly` checks that whatever it listens on is loopback;
// `expectListener` makes the listener itself required once it exists.
//
// Temp data goes under the external work volume when it is mounted (testRoot), one root folder per harness, removed by
// `cleanup` (afterAll). Built botlingd (out/server/main.cjs) is required: `npm run build` first.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { botlingdEnv, botlingdScript, ScriptClient, testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import { FaultProxy } from "./fault-proxy";
import { LOOPBACK, type Framing } from "./framed";

/** The variable that names botlingd's loopback port (read once M2 step 6's listener exists). */
export const LISTEN_PORT_ENV = "BOTLING_SERVER_PORT";
export const SERVER_NAMES = ["A", "B", "C", "D"] as const;

/** A socket a process listens on (TCP in LISTEN state, or a bound UDP socket). */
export interface ListeningSocket { proto: "tcp" | "udp"; address: string; port: number }

/** Free loopback ports, held for a moment to learn them (the OS will not hand them out again right away). */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, LOOPBACK, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Every socket `pid` listens on: lsof on macOS, /proc on Linux. */
export function listeningSockets(pid: number): ListeningSocket[] {
  if (process.platform === "linux") return linuxListening(pid);
  const run = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-i"], { encoding: "utf8", timeout: 20_000 });
  if (run.error) throw run.error;
  // lsof exits 1 when the process has no internet socket at all.
  if (run.status !== 0 && run.status !== 1) throw new Error(`lsof failed (${run.status}): ${run.stderr}`);
  const found: ListeningSocket[] = [];
  for (const line of run.stdout.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const proto = columns[7]?.toLowerCase();
    const name = columns.slice(8).join(" ");
    if (proto === "tcp" && !name.includes("(LISTEN)")) continue;
    if (proto !== "tcp" && proto !== "udp") continue;
    if (name.includes("->")) continue; // a connected socket, not a listener
    const local = name.replace(/\s*\(.*\)$/, "");
    const cut = local.lastIndexOf(":");
    found.push({ proto, address: local.slice(0, cut).replace(/^\[|\]$/g, ""), port: Number(local.slice(cut + 1)) || 0 });
  }
  return found;
}

function linuxListening(pid: number): ListeningSocket[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try { const link = readlinkSync(`/proc/${pid}/fd/${fd}`); const match = /^socket:\[(\d+)\]$/.exec(link); if (match) inodes.add(match[1]); } catch { /* gone */ }
  }
  const found: ListeningSocket[] = [];
  for (const [file, proto, v6] of [["tcp", "tcp", false], ["tcp6", "tcp", true], ["udp", "udp", false], ["udp6", "udp", true]] as const) {
    let text = "";
    try { text = readFileSync(`/proc/${pid}/net/${file}`, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10 || !inodes.has(columns[9])) continue;
      if (proto === "tcp" && columns[3] !== "0A") continue; // 0A = LISTEN
      const [hex, portHex] = columns[1].split(":");
      found.push({ proto, address: v6 ? ipv6FromProc(hex) : ipv4FromProc(hex), port: parseInt(portHex, 16) });
    }
  }
  return found;
}
const ipv4FromProc = (hex: string) => [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
function ipv6FromProc(hex: string): string {
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    const word = hex.slice(i * 8, i * 8 + 8);
    const bytes = [3, 2, 1, 0].map((j) => word.slice(j * 2, j * 2 + 2)).join("");
    words.push(bytes.slice(0, 4), bytes.slice(4, 8));
  }
  const text = words.map((word) => word.replace(/^0+(?=.)/, "")).join(":");
  return text === "0:0:0:0:0:0:0:1" ? "::1" : text === "0:0:0:0:0:0:0:0" ? "::" : text;
}

export interface ServerOptions {
  /** Extra environment for this server (BOTLING_* knobs the test means to set). */
  env?: Record<string, string>;
}

/** One botlingd of the harness. Survives kill/restart: same data folder, same port. */
export class TestServer {
  child: ChildProcessWithoutNullStreams | null = null;
  stdout = "";
  stderr = "";
  /** How many times it was started. */
  starts = 0;
  private closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve({ code: null, signal: null });
  private readonly clients: ScriptClient[] = [];

  constructor(readonly name: string, readonly dataDir: string, readonly port: number, private readonly env: Record<string, string>) {}

  get socket(): string { return join(this.dataDir, "botlingd.sock"); }
  get token(): string { return readFileSync(join(this.dataDir, "botlingd.token"), "utf8").trim(); }
  get log(): string { try { return readFileSync(join(this.dataDir, "botlingd.log"), "utf8"); } catch { return ""; } }
  get pid(): number | null { return this.child?.pid ?? null; }
  get alive(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }
  /** The environment it is started with (tests check that nothing of this process leaks in). */
  get environment(): Record<string, string> { return botlingdEnv(this.dataDir, { [LISTEN_PORT_ENV]: String(this.port), BOTLING_SERVER_BACKUP_CHECK_MS: "0", ...this.env }); }

  /** Starts botlingd and waits for "ready". */
  async start(timeout = 60_000): Promise<void> {
    if (this.alive) throw new Error(`server ${this.name} is already running`);
    this.stdout = "";
    const child = spawn(process.execPath, ["--no-warnings", botlingdScript, "start"], { env: this.environment, stdio: "pipe" });
    this.child = child;
    this.starts++;
    this.closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    createInterface({ input: child.stdout }).on("line", (line) => { this.stdout += `${line}\n`; });
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`botlingd ${this.name} exited ${child.exitCode ?? child.signalCode}\n${this.stderr}\n${this.log.slice(-4_000)}`);
      return this.stdout.includes("ready ");
    }, { timeout, every: 20, what: `botlingd ${this.name} ready` });
  }

  /** `kill -9`: no shutdown at all; waits until the process is gone. */
  async kill(): Promise<void> {
    this.closeClients();
    if (this.alive) this.child!.kill("SIGKILL");
    await this.closed;
  }

  /** SIGTERM and wait. */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.closeClients();
    if (this.alive) this.child!.kill("SIGTERM");
    return this.closed;
  }

  /** `kill -9` (default) or a clean stop, then start again on the same folder and port. */
  async restart({ hard = true } = {}): Promise<void> {
    if (hard) await this.kill(); else await this.stop();
    await this.start();
  }

  /** A scripted front end connected to its local socket (closed by kill/stop/cleanup). */
  async client(deviceId = "script", originEpoch?: string): Promise<ScriptClient> {
    const client = new ScriptClient(deviceId, originEpoch);
    await client.connect(this.socket, this.token);
    this.clients.push(client);
    return client;
  }

  /** Runs a botlingd command (status, backup, restore…) on this server's folder to its end. */
  command(args: string[]): { code: number | null; stdout: string; stderr: string } {
    const run = spawnSync(process.execPath, ["--no-warnings", botlingdScript, ...args], { env: this.environment, encoding: "utf8", timeout: 90_000 });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /** `botlingd backup` (online); returns the backup file. */
  backup(): string {
    const run = this.command(["backup"]);
    if (run.code !== 0) throw new Error(`backup of ${this.name} failed: ${run.stderr}`);
    return run.stdout.trim().split("\n").at(-1)!;
  }

  /** Stops the server, `botlingd restore <file>`, starts it again. */
  async restore(file: string): Promise<string> {
    await this.stop();
    const run = this.command(["restore", file]);
    if (run.code !== 0) throw new Error(`restore of ${this.name} failed: ${run.stderr}`);
    await this.start();
    return run.stdout;
  }

  /** Every socket it listens on. */
  listeners(): ListeningSocket[] {
    if (!this.alive) throw new Error(`server ${this.name} is not running`);
    return listeningSockets(this.pid!);
  }

  /** Throws unless every listening socket is on 127.0.0.1 (and, with `expectListener`, its own port is one). */
  assertLoopbackOnly({ expectListener = false } = {}): ListeningSocket[] {
    const sockets = this.listeners();
    const outside = sockets.filter((socket) => socket.address !== LOOPBACK);
    if (outside.length) throw new Error(`server ${this.name} listens outside 127.0.0.1: ${JSON.stringify(outside)}`);
    if (expectListener && !sockets.some((socket) => socket.proto === "tcp" && socket.port === this.port)) {
      throw new Error(`server ${this.name} does not listen on 127.0.0.1:${this.port}: ${JSON.stringify(sockets)}`);
    }
    return sockets;
  }

  private closeClients(): void { for (const client of this.clients.splice(0)) client.close(); }
}

export interface ClusterOptions {
  /** How many servers (default 2; names A, B, C, D). */
  count?: number;
  /** A prefix for the temp root folder. */
  name?: string;
  /** Per-server extra environment, by name. */
  env?: Partial<Record<string, Record<string, string>>>;
  /** Start them (default true); otherwise call `start()` on each. */
  start?: boolean;
}

export class TestCluster {
  readonly proxies: FaultProxy[] = [];
  constructor(readonly root: string, readonly servers: TestServer[]) {}

  get a(): TestServer { return this.servers[0]; }
  get b(): TestServer { return this.servers[1]; }
  get c(): TestServer { return this.servers[2]; }
  server(name: string): TestServer {
    const found = this.servers.find((server) => server.name === name);
    if (!found) throw new Error(`no server ${name}`);
    return found;
  }

  /** A fault proxy in front of `target`'s port (or any loopback port); closed by cleanup. */
  async proxy(target: TestServer | number, framing: Framing = "websocket", seed?: number): Promise<FaultProxy> {
    const proxy = await FaultProxy.start({ target: typeof target === "number" ? target : target.port, framing, seed });
    this.proxies.push(proxy);
    return proxy;
  }

  /** Stops every server (SIGKILL after SIGTERM times out), closes proxies, removes the temp root. */
  async cleanup(): Promise<void> {
    for (const proxy of this.proxies.splice(0)) await proxy.close().catch(() => undefined);
    await Promise.all(this.servers.map(async (server) => {
      const stopped = server.stop();
      const late = setTimeout(() => { void server.kill(); }, 10_000);
      await stopped;
      clearTimeout(late);
    }));
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Makes the temp root, picks ports and (by default) starts every server. */
export async function startServers(options: ClusterOptions = {}): Promise<TestCluster> {
  const count = options.count ?? 2;
  if (count < 1 || count > SERVER_NAMES.length) throw new Error(`1 to ${SERVER_NAMES.length} servers`);
  const root = testRoot(options.name ?? "two-servers");
  const servers: TestServer[] = [];
  const ports = new Set<number>();
  for (const name of SERVER_NAMES.slice(0, count)) {
    let port = await freeLoopbackPort();
    while (ports.has(port)) port = await freeLoopbackPort();
    ports.add(port);
    // botlingd makes its data folder itself (0700).
    const dataDir = join(root, name);
    servers.push(new TestServer(name, dataDir, port, options.env?.[name] ?? {}));
  }
  const cluster = new TestCluster(root, servers);
  if (options.start !== false) {
    try { await Promise.all(servers.map((server) => server.start())); } catch (error) { await cluster.cleanup(); throw error; }
  }
  return cluster;
}

/** True when nothing of `root` is left (cleanup's check). */
export const gone = (root: string) => !existsSync(root);
