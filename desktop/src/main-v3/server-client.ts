// Botling 3's replacement for src/main/core-client.ts (M1 step 11). The 2.x main (src/main/main.ts) runs unchanged; the
// v3 build (build.mjs `buildMainV3`) resolves its `./core-client` import to this file. Where 2.x forked the core as a
// utility process, this client talks to botlingd over its local Unix socket through the front-end link (src/fe-link),
// and the renderer adapter turns the server's streams into the 2.x events and views the renderer knows.
//
// Kept from 2.x: the same constructor options and the members main.ts uses (checked at compile time below). The
// server's asks of the window (`shell.*`) are answered by main's `app(op, args)`, the 2.x app ops, unchanged.
// Not carried over in M1 (step 9 / later milestones decide): the restart checkpoint (`prepareRestart`), release
// announcements, plugin hosts and secret sealing all lived in the core process; botlingd owns them now.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import {
  PROTOCOL_VERSION, errorResponse, okResponse,
  type Command, type CommandType, type ResponseEnvelope, type ResultOf,
} from "../contract";
import type { Message } from "../protocol";
import { FeLink, systemClock, type Clock, type Dial, type FeLinkOptions, type FeStorage } from "../fe-link";
import type { AppOp, CoreClient as CoreClient2x, CoreClientOptions } from "../main/core-client";
import { RendererAdapter, type LinkPort } from "./renderer-adapter";
import { unixDial } from "./unix-dial";
import { INHERITED_IMPORT_VARS } from "../server/inherited-env";
import { isPackagedElectron } from "../server/packaged-electron";

/** The frontend's version told in `hello` (an update is asked for when the server needs a newer one). */
export const FE_VERSION = "3.0.0-m1";

export interface ServerPaths {
  /** botlingd's data folder (server.db, the socket, the token). */
  serverDir: string;
  socket: string;
  token: string;
  /** The front end's own durable state (outbox, cursors). */
  feStorage: string;
}

/**
 * Where botlingd lives for this app (step 9 must use the same): `<app data>/server/` holds `botlingd.sock` and
 * `botlingd.token` (mode 0600, ≥ 16 characters, §6.1). `BOTLING_SERVER_DATA_DIR` / `BOTLING_SERVER_SOCKET` move them
 * (a macOS socket path is at most 104 bytes). The front end's outbox is `<app data>/electron/fe-link.sqlite`.
 */
export function serverPaths(env: Record<string, string | undefined>): ServerPaths {
  const appData = env.BOTLING_APP_DATA_DIR || (env.BOTLING_DATA_DIR ? dirname(env.BOTLING_DATA_DIR) : ".");
  const serverDir = env.BOTLING_SERVER_DATA_DIR || join(appData, "server");
  return {
    serverDir,
    socket: env.BOTLING_SERVER_SOCKET || join(serverDir, "botlingd.sock"),
    token: join(serverDir, "botlingd.token"),
    feStorage: join(appData, "electron", "fe-link.sqlite"),
  };
}

/**
 * The environment the window starts botlingd with: its own, Electron as Node when unpackaged (or plain `--botlingd`
 * when packaged, because the `runAsNode` fuse stays off), the server's data folder, and never the variables that would
 * make it import 1.x/2.x data (M1 demo bug 4: importing is M6's explicit step; botlingd also drops them itself,
 * server/inherited-env.ts).
 */
export function botlingdLaunchEnv(
  env: Record<string, string | undefined>,
  paths: ServerPaths,
  options: { packaged?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((INHERITED_IMPORT_VARS as readonly string[]).includes(key)) continue;
    if (options.packaged && key === "ELECTRON_RUN_AS_NODE") continue;
    out[key] = value;
  }
  if (options.packaged) {
    Object.assign(out, { BOTLING_DATA_DIR: paths.serverDir });
  } else {
    Object.assign(out, { ELECTRON_RUN_AS_NODE: "1", BOTLING_DATA_DIR: paths.serverDir, BOTLING_PLUGIN_HOST: "node" });
  }
  if (env.BOTLING_SERVER_SOCKET) out.BOTLING_SERVER_SOCKET = env.BOTLING_SERVER_SOCKET;
  return out;
}

export function botlingdLaunchSpec(
  env: Record<string, string | undefined>,
  paths: ServerPaths,
  options: { packaged?: boolean; execPath?: string; script?: string } = {},
): { program: string; args: string[]; env: Record<string, string> } {
  const packaged = options.packaged ?? isPackagedElectron();
  const program = options.execPath ?? process.execPath;
  const launchEnv = botlingdLaunchEnv(env, paths, { packaged });
  if (packaged) return { program, args: ["--botlingd", "start"], env: launchEnv };
  if (!options.script) throw new Error("botlingd script path is required when unpackaged");
  return { program, args: [options.script, "start"], env: launchEnv };
}

/** The server build beside a core build: `<out>/server/main.cjs` beside `<out>/core/main.cjs`. */
export function serverScriptFor(coreScript: string): string {
  return join(dirname(dirname(coreScript)), "server", "main.cjs");
}

export interface ServerClientDeps {
  dial?: Dial;
  storage?: () => FeStorage | Promise<FeStorage>;
  /** Starts botlingd when nothing listens on the socket (default: `<server script> start` or `--botlingd start` when packaged, detached). */
  launch?: () => void;
  readToken?: () => string | undefined;
  clock?: Clock;
  feVersion?: string;
  /** FeLink timing overrides (tests). */
  link?: Partial<FeLinkOptions>;
  /** Overrides Electron packaged detection (tests). */
  packaged?: boolean;
  /** Overrides child_process.spawn (tests). */
  spawn?: typeof spawn;
}

const SHELL_OPS: Record<string, AppOp> = {
  "shell.screenshot": "screenshot", "shell.browser": "browser", "shell.install": "installRelease", "shell.quit": "quit",
};
const LAUNCH_EVERY_MS = 10_000;

/** The client main.ts made (one per window process): content-install.ts asks the server through it. */
let active: ServerClient | null = null;
export function activeServerClient(): ServerClient | null { return active; }

export class ServerClient {
  private link: FeLink | null = null;
  private adapter: RendererAdapter | null = null;
  private opening: Promise<void> | null = null;
  private counter = 0;
  private lastLaunch = -Infinity;
  private stopped = false;
  readonly paths: ServerPaths;
  /** botlingd is its own process, not a child of the window: no pid here. */
  readonly pid: number | undefined = undefined;
  readonly hostPids: number[] = [];
  readonly pluginGroups: number[] = [];

  constructor(private readonly options: CoreClientOptions, private readonly deps: ServerClientDeps = {}) {
    this.paths = serverPaths(options.env);
    active = this;
  }

  /** The content path's local part (§9A.4): `content.find` / `content.open` on the link. Rejects while detached. */
  content(message: Parameters<FeLink["content"]>[0]): ReturnType<FeLink["content"]> {
    if (!this.link) return Promise.reject(new Error("The Botling server link is not open."));
    return this.link.content(message);
  }

  /** Content reads over the session (§9A.4, M4-01b): `content.get` / `.credit` / `.cancel` and `onContent`. */
  postContent(message: Parameters<FeLink["postContent"]>[0]): boolean {
    return this.link?.postContent(message) ?? false;
  }

  onContent(req: string, listener: Parameters<FeLink["onContent"]>[1]): () => void {
    if (!this.link) return () => {};
    return this.link.onContent(req, listener);
  }

  newReq(): string {
    return this.link ? this.link.newReq() : `detached.${++this.counter}`;
  }

  attachedServerId(): string | null {
    return this.link?.attachedServerId() ?? null;
  }

  get script(): string { return this.options.script; }
  private get clock(): Clock { return this.deps.clock ?? systemClock; }

  /** Opens the link (the window starts at once; the renderer shows "connecting" until the server answers). */
  start(): void {
    this.stopped = false;
    if (this.link) { this.link.start(); return; }
    if (this.opening) return;
    this.opening = this.open().catch((error) => {
      this.options.audit(`server link did not open: ${String((error as Error)?.message ?? error)}`);
    }).finally(() => { this.opening = null; });
  }

  /** Waits for `start()`'s link to be open (tests). */
  async ready(): Promise<void> { await this.opening; }

  private async open(): Promise<void> {
    const storage = this.deps.storage ? await this.deps.storage() : await this.defaultStorage();
    const readToken = this.deps.readToken ?? (() => this.readTokenFile());
    const baseDial = this.deps.dial ?? unixDial({ path: this.paths.socket, onError: (error) => this.onDialError(error) });
    const dial: Dial = (handlers) => baseDial({
      open: () => { this.options.milestone?.("core.spawn"); handlers.open(); },
      frame: handlers.frame,
      close: handlers.close,
    });
    // `token` is read at each hello: botlingd writes a new one when it starts.
    const linkOptions: FeLinkOptions = {
      storage, dial, deviceId: "desktop", feVersion: this.deps.feVersion ?? FE_VERSION, clock: this.clock, ...this.deps.link,
      get token() { return readToken(); },
    };
    const link = await FeLink.open(linkOptions);
    if (this.stopped) { void link.close(); return; }
    this.link = link;
    const adapter = new RendererAdapter({ link: link as unknown as LinkPort, emit: (envelope) => this.options.onEvent(envelope), clock: this.clock, audit: this.options.audit });
    this.adapter = adapter;
    let welcomed = false;
    link.on((event) => {
      if (event.type === "state" && event.status.attached && !welcomed) { welcomed = true; this.options.milestone?.("core.ready"); }
      if (event.type === "state" && !event.status.attached) welcomed = false;
      if (event.type === "message") void this.onServerMessage(event.message);
    });
    adapter.start();
    link.start();
  }

  private async defaultStorage(): Promise<FeStorage> {
    mkdirSync(dirname(this.paths.feStorage), { recursive: true });
    // Imported here so the module loads (and tests run) without node:sqlite until a real link opens.
    const { SqliteFeStorage } = await import("../fe-link/sqlite-storage");
    return new SqliteFeStorage(this.paths.feStorage);
  }

  private readTokenFile(): string | undefined {
    try { return readFileSync(this.paths.token, "utf8").trim() || undefined; } catch { return undefined; }
  }

  /** Nothing listens on the socket: start botlingd (at most once every 10 s), when its build is there. */
  private onDialError(error: NodeJS.ErrnoException): void {
    if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") return;
    const now = this.clock.now();
    if (now - this.lastLaunch < LAUNCH_EVERY_MS) return;
    this.lastLaunch = now;
    if (this.deps.launch) { this.deps.launch(); return; }
    const packaged = this.deps.packaged ?? isPackagedElectron();
    const script = serverScriptFor(this.options.script);
    if (!packaged && !existsSync(script)) { this.options.audit(`botlingd is not running and ${script} is not built`); return; }
    mkdirSync(this.paths.serverDir, { recursive: true });
    const launch = botlingdLaunchSpec(this.options.env, this.paths, { packaged, script });
    try {
      const child = (this.deps.spawn ?? spawn)(launch.program, launch.args, { env: launch.env, detached: true, stdio: "ignore" });
      child.unref();
      this.options.audit(`started botlingd (pid ${child.pid ?? "?"})`);
    } catch (error) {
      this.options.audit(`botlingd did not start: ${String(error)}`);
    }
  }

  /** The server's asks of the window (§6.3 `shell.*`): `shell.seal`/`shell.open` and the 2.x app ops, answered with `shell.done`. */
  private async onServerMessage(message: Message): Promise<void> {
    if (message.t === "shell.seal" || message.t === "shell.open") {
      let answer: { ok: boolean; error?: string; data?: unknown };
      if (!this.options.seal) answer = { ok: false, error: "This window cannot keep secrets." };
      else {
        try {
          answer = message.t === "shell.seal"
            ? { ok: true, data: { sealed: this.options.seal("seal", message.text) } }
            : { ok: true, data: { text: this.options.seal("open", message.sealed) } };
        } catch (error) {
          answer = { ok: false, error: String((error as Error)?.message ?? error) };
        }
      }
      const done = {
        t: "shell.done" as const, req: message.req, ok: answer.ok,
        ...(answer.error ? { error: answer.error.slice(0, 2_000) } : {}),
        ...(answer.data !== undefined ? { data: answer.data } : {}),
      };
      if (!this.link?.post(done)) this.options.audit(`${message.t}: the answer was not sent (link detached)`);
      return;
    }
    const op = SHELL_OPS[message.t];
    if (!op) return;
    const { req, args } = message as { req: string; args?: Record<string, string> };
    let answer: { ok: boolean; file?: string; error?: string; data?: unknown };
    if (!this.options.app) answer = { ok: false, error: "This window cannot do that." };
    else {
      try {
        answer = await this.options.app(op, op === "browser" && args?.request !== undefined ? { request: args.request } : {});
      } catch (error) {
        answer = { ok: false, error: String((error as Error)?.message ?? error) };
      }
    }
    const done = {
      t: "shell.done" as const, req, ok: answer.ok,
      ...(answer.file ? { file: answer.file.slice(0, 4_096) } : {}),
      ...(answer.error ? { error: answer.error.slice(0, 2_000) } : {}),
      ...(answer.data !== undefined ? { data: answer.data } : {}),
    };
    if (!this.link?.post(done)) this.options.audit(`${message.t}: the answer was not sent (link detached)`);
  }

  /** Sends a command; resolves with the response (never rejects), as 2.x. */
  async request(cmd: Command, id = `main.${++this.counter}`): Promise<ResponseEnvelope> {
    if (!this.adapter) {
      if (this.opening) await this.opening;
      if (!this.adapter) return errorResponse(id, { code: "core_unavailable", message: "The Botling server link is not open." });
    }
    const answer = await this.adapter.request(cmd);
    return answer.ok ? okResponse(id, answer.result) : errorResponse(id, answer.error);
  }

  async call<T extends CommandType>(cmd: Extract<Command, { type: T }>): Promise<ResultOf<T>> {
    const response = await this.request(cmd);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as ResultOf<T>;
  }

  /** 2.x cancelled a request in the core; a v3 read cannot be withdrawn and a slot is cancelled from its line (M2). */
  cancel(_id: string): void { /* nothing to do in M1 */ }

  /** The window closes; botlingd keeps running (bots go on working without a window). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.adapter?.stop();
    this.link?.stop();
  }

  /** The restart checkpoint lived in the 2.x core; botlingd keeps its own work across window restarts. */
  async prepareRestart(_options: { onlyIfBusy?: boolean; timeoutMs?: number } = {}): Promise<boolean> { return false; }
  cancelRestart(): void { /* nothing armed */ }

  /** Release announcements went to the 2.x core's self-update; botlingd's updates are M6. */
  announceRelease(_release: { version: string; name: string; url: string; current: string; unavailable: string | null }): void {
    this.options.audit("release announcement not passed on (Botling 3 M1)");
  }

  /** For tests and diagnostics. */
  get linkForTests(): FeLink | null { return this.link; }
  get adapterForTests(): RendererAdapter | null { return this.adapter; }
}

// main.ts only uses these members of the 2.x client: the v3 one must have them with compatible types.
type UsedMembers = "request" | "call" | "cancel" | "start" | "stop" | "prepareRestart" | "cancelRestart" | "announceRelease" | "pid" | "hostPids" | "pluginGroups";
const compatible: (client: ServerClient) => Pick<CoreClient2x, UsedMembers> = (client) => client;
void compatible;
void PROTOCOL_VERSION;

/** The name main.ts imports from `./core-client`, so the v3 build can swap the module (build.mjs `buildMainV3`). */
export { ServerClient as CoreClient };
export type { AppOp, CoreClientOptions };
