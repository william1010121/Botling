// Drives the built botlingd (out/server/main.cjs) under plain Node, the fake engine behind it, and talks to it over its
// Unix socket the way a front end does (hello, sub, cmd, req, content.*), frame by frame. No window, no Electron.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { decodeFrame, decodeWireFrame, encodeFrame, FrameSplitter, packFrame, type Cursor, type Entry, type Message, type MessageOf, type Slot } from "../src/protocol";
import { desktop, fakeCli, fakeCodex, until } from "./helpers";

export const botlingdScript = join(desktop, "out", "server", "main.cjs");
/** The 2.x main bot id. A data folder made since M5-04g mints its own (meta `ids.main`): read it with mainBotOf. */
export const MAIN = "6A0B0000-0000-4000-8000-000000000002";

/** The main bot id a botlingd data folder minted (`ids.main` in server.db), read once the server is ready. */
export function mainBotOf(dataDir: string): string {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'ids.main'").get() as { value: string } | undefined;
    if (!row) throw new Error(`no ids.main in ${dataDir}/server.db`);
    return String(row.value);
  } finally { db.close(); }
}

/** A folder for test data: on the external work disk when it is there (never a Botling data folder). */
export function testRoot(name: string): string {
  // On macOS the default tmpdir is long (/private/var/folders/xx/<28 chars>/T, 57 bytes real) and a data dir's botlingd.sock
  // then passes the 103-byte socket limit (the macOS CI runner failed 12 tests that way): /tmp (real /private/tmp) is short.
  const fallback = process.platform === "darwin" ? "/tmp/botling-test" : tmpdir();
  const base = process.env.BOTLING_TEST_TMP || (existsSync("/Volumes/My-SSD/botling-work") ? "/Volumes/My-SSD/botling-work/tmp" : fallback);
  mkdirSync(base, { recursive: true });
  // The real path: a macOS tmpdir is under /var, a link to /private/var, and the server reports the folders it reads by their real path.
  return realpathSync(mkdtempSync(join(base, `${name}-`)));
}

/** The environment botlingd gets: none of this process's Botling variables (a test never reads the user's data). */
export function botlingdEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("BOTLING_") || key.startsWith("ELECTRON_") || key.startsWith("FAKE_CLAUDE") || key.startsWith("CLAUDE")) continue;
    env[key] = value;
  }
  return {
    // BOTLING_SERVER_PORT=0: botlingd's loopback listener (M2 step 6) on a free port, so test servers never take the default one.
    ...env, BOTLING_SERVER_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_FAKE_CODEX: fakeCodex, BOTLING_PLUGIN_HOST: "node", BOTLING_SERVER_PORT: "0", ...extra,
  };
}

/** Runs a botlingd command (status, backup, stop…) to its end. */
export function botlingdCommand(dataDir: string, args: string[], extra: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ["--no-warnings", botlingdScript, ...args], { env: botlingdEnv(dataDir, extra), encoding: "utf8", timeout: 90_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

export class BotlingdProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  private readonly closed: Promise<number | null>;

  /** `script`: another build of the server to run (default out/server/main.cjs), e.g. a copy beside a page of its own (M7-08). */
  constructor(readonly dataDir: string, extra: Record<string, string> = {}, script: string = botlingdScript) {
    this.child = spawn(process.execPath, ["--no-warnings", script, "start"], { env: botlingdEnv(dataDir, extra), stdio: "pipe" });
    this.closed = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
    createInterface({ input: this.child.stdout }).on("line", (line) => { this.stdout += `${line}\n`; });
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
  }

  get socket(): string { return join(this.dataDir, "botlingd.sock"); }
  get token(): string { return readFileSync(join(this.dataDir, "botlingd.token"), "utf8").trim(); }
  get log(): string { try { return readFileSync(join(this.dataDir, "botlingd.log"), "utf8"); } catch { return ""; } }

  async ready(timeout = 60_000): Promise<void> {
    await until(() => {
      if (this.child.exitCode !== null) throw new Error(`botlingd exited ${this.child.exitCode}\n${this.stderr}\n${this.log.slice(-4_000)}`);
      return this.stdout.includes("ready ");
    }, { timeout, what: "botlingd ready" });
  }

  /** SIGTERM and wait for the exit code. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
    return this.closed;
  }

  exited(): Promise<number | null> { return this.closed; }
}

/** A scripted front end on the local socket. */
export class ScriptClient {
  readonly received: Message[] = [];
  /** Entries per stream, by seq, as batches brought them. */
  readonly entries = new Map<string, Map<number, Entry>>();
  readonly originEpoch = randomBytes(16).toString("hex");
  welcome: MessageOf<"welcome"> | null = null;
  closed = false;
  private readonly splitter = new FrameSplitter();
  private socket: Socket | null = null;
  private counter = 0;

  constructor(readonly deviceId = "script", originEpoch?: string) {
    if (originEpoch) (this as { originEpoch: string }).originEpoch = originEpoch;
  }

  async connect(path: string, token: string): Promise<MessageOf<"welcome">> {
    const socket = createConnection(path);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
    socket.on("data", (chunk: Buffer) => {
      const split = this.splitter.push(chunk);
      if (!split.ok) throw new Error(split.detail);
      for (const frame of split.frames) {
        // `rows` of a `srv:` stream (M3): the own table's plugin rows that botlingd sends beside the log sub of its `srv:`
        // stream (M5-14e); this v1-shaped client reads the log only. Every other frame must still be a v1 message.
        const wire = decodeWireFrame(frame, "server", { local: true });
        if (wire.ok && wire.message.t === "rows" && wire.message.stream.startsWith("srv:")) continue;
        const decoded = decodeFrame(frame, "server", { local: true });
        if (!decoded.ok) throw new Error(`bad frame from botlingd: ${decoded.detail}`);
        this.onMessage(decoded.message);
      }
    });
    socket.on("close", () => { this.closed = true; });
    this.send({ t: "hello", deviceId: this.deviceId, feVersion: "3.0.0", protocol: 1, originEpoch: this.originEpoch, cursors: {}, outbox: [], want: [], token } as Message);
    this.welcome = await this.wait((m): m is MessageOf<"welcome"> => m.t === "welcome", "welcome");
    return this.welcome;
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", { local: true });
    if (!encoded.ok) throw new Error(`cannot send ${message.t}: ${encoded.detail}`);
    this.socket!.write(packFrame(encoded.text));
  }

  /** Raw bytes (a bad frame, a wrong token…). */
  write(bytes: Uint8Array): void { this.socket!.write(bytes); }

  close(): void { this.socket?.destroy(); }

  get srv(): `srv:${string}` { return `srv:${this.welcome!.serverId}`; }

  /** The newest message matching `test` from `from` on (index into `received`). */
  async wait<T extends Message>(test: (m: Message) => m is T, what: string, { from = 0, timeout = 30_000 } = {}): Promise<T> {
    return until(() => {
      for (let i = from; i < this.received.length; i++) if (test(this.received[i])) return this.received[i] as T;
      if (this.closed) throw new Error(`session closed while waiting for ${what}: ${JSON.stringify(this.received.slice(-3))}`);
      return null;
    }, { timeout, what });
  }

  async sub(stream: string, cursor: Cursor | null = null): Promise<void> {
    this.send({ t: "sub", stream, cursor } as Message);
  }

  /** The current logId of a stream, from its last snap/batch/reset. */
  logIdOf(stream: string): string | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i] as { t: string; stream?: string; logId?: string };
      if (m.stream === stream && (m.t === "snap" || m.t === "batch" || m.t === "reset") && m.logId) return m.logId;
    }
    return null;
  }

  cmd(slot: Slot, cmd: unknown, inc: string, floor = slot.n): void {
    this.send({ t: "cmd", slot, floor, inc, cmd } as Message);
  }

  async req(cmd: unknown, timeout = 30_000): Promise<MessageOf<"res">> {
    const req = `r${++this.counter}`;
    this.send({ t: "req", req, cmd } as Message);
    return this.wait((m): m is MessageOf<"res"> => m.t === "res" && m.req === req, `res ${req}`, { timeout });
  }

  async content(message: Omit<MessageOf<"content.find">, "req"> | Omit<MessageOf<"content.open">, "req">): Promise<Message> {
    const req = `c${++this.counter}`;
    this.send({ ...message, req } as Message);
    return this.wait((m): m is Message => (m.t === "content.found" || m.t === "content.file" || m.t === "content.gone") && (m as { req: string }).req === req, `content ${req}`);
  }

  entriesOf(stream: string): Entry[] {
    return [...(this.entries.get(stream)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
  }

  private onMessage(message: Message): void {
    this.received.push(message);
    if (message.t === "batch") {
      let map = this.entries.get(message.stream);
      if (!map) this.entries.set(message.stream, (map = new Map()));
      for (const entry of message.entries) {
        if (map.has(entry.seq) && map.get(entry.seq)!.hash !== entry.hash) throw new Error(`seq ${entry.seq} of ${message.stream} came twice with different hashes`);
        map.set(entry.seq, entry);
      }
      this.send({ t: "ack", stream: message.stream, cursor: { logId: message.logId, seq: message.to } } as Message);
    }
  }
}
