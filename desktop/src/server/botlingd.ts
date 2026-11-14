// botlingd, assembled (M1 step 9): the 2.x core running inside the server process, without Electron, on server.db.
//
//   data folder lock (core/store/data-dir-lock.ts: one botlingd, or 2.x core, per folder)
//   → server.db (openServerStore) → LogHub (bot streams + this server's srv: stream) → LiveChannel (checkpoints into
//     the effect rows) → BotExports + DbBotStores (the bots' stores on server.db rows; each commit schedules the 2.x
//     export files) → the 2.x Core on those stores (plugins through the Node plugin host, app ops to the attached
//     window through the ShellBridge, turns kept aside through CoreEngine) → IntentRuntime (intents, legacy apply,
//     effect worker, event tap, recovery at start) → content index (step 13: recover, then lines are indexed)
//   → the 2.x exports brought up to date → a new local token → the Unix socket.
//
// Not in botlingd (M1): the phone bridge and relay (no new network listener here), the restart checkpoint and core hot
// swap (botlingd outlives windows), plugin secrets (risk 3: no safe storage without the window, see `noSafeStorage`).
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { coreProcessOptions, plainHostNode } from "../core/core-process";
import type { Sealer } from "../core/plugins/secrets";
import { Core } from "../core/server";
import { MAIN_BOT_ID } from "../core/store/records";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "../core/store/data-dir-lock";
import type { StreamId } from "../protocol";
import { BotlingdEngine } from "./botlingd-engine";
import { DbBotStores } from "./botstore";
import { ContentService } from "./content";
import { effectCheckpointSink, ensureBot } from "./effects";
import { BotExports } from "./exports";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { botlingdPaths, refuse2xData, SessionServer, writeToken, type BotlingdPaths, type SessionOptions } from "./session";
import { ShellBridge } from "./shell-bridge";
import { localOnly } from "./slots";
import { openServerStore, type ServerStore } from "./store";

/** The oldest Botling 3 window this server serves (fe-link compares it without the -suffix). */
export const MIN_FE_VERSION = "3.0.0-m1";
/** How `welcome.servers` names this server (M1: one server, this Mac). */
export const SERVER_NAME = "This Mac";
export const BOTLINGD_VERSION = "3.0.0-m1";

/**
 * Risk 3: plugin secrets were sealed with Electron's safeStorage (the Keychain key of the app), which a plain Node
 * process cannot reach. M1 does not seal them another way: a plugin that asks to keep a secret is told to wait for
 * the window to provide safe storage (a later step seals through the attached window). A fresh botlingd data folder
 * holds no sealed secrets, so nothing already stored is lost.
 */
export const NO_SAFE_STORAGE = "Plugin secrets need the Botling 3 window's safe storage (the Keychain), which this M1 server does not reach yet; open Botling 2.x for plugins that keep secrets.";
const noSafeStorage: Sealer = {
  seal: async () => { throw new Error(NO_SAFE_STORAGE); },
  open: async () => { throw new Error(NO_SAFE_STORAGE); },
};

export class DataDirInUseError extends Error {
  readonly exitCode = CORE_EXIT_DATA_DIR_IN_USE;
  constructor(readonly dataDir: string, readonly pid: number) {
    super(`Another Botling server or core (pid ${pid}) already uses ${dataDir}; not starting a second one.`);
    this.name = "DataDirInUseError";
  }
}

/** The key of the bot store kept in `directory`: the bot's id, or `<id>/partner-<engine>` for a second head's store. */
export function storeKeyOf(dataDir: string, directory: string): string {
  const rel = relative(dataDir, directory).split(sep).join("/");
  if (rel === "main") return MAIN_BOT_ID;
  if (rel.startsWith("main/")) return `${MAIN_BOT_ID}/${rel.slice(5)}`;
  if (rel.startsWith("projects/")) return rel.slice("projects/".length);
  return rel || MAIN_BOT_ID;
}

export interface BotlingdOptions {
  env: Record<string, string | undefined>;
  /** The built app's out/ folder (host/, agent/, builtin-plugins/). */
  outDir: string;
  log?: (line: string) => void;
  session?: SessionOptions;
  /** How long to wait for another holder of the data folder to let go (ms). */
  lockWaitMs?: number;
}

export class Botlingd {
  private stopping: Promise<void> | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  private tokenValue = "";

  private constructor(
    readonly paths: BotlingdPaths,
    readonly serverId: string,
    private readonly lock: DataDirLock,
    readonly store: ServerStore,
    readonly hub: LogHub,
    readonly live: LiveChannel,
    readonly exports: BotExports,
    readonly stores: DbBotStores,
    readonly core: Core,
    readonly runtime: IntentRuntime,
    readonly content: ContentService,
    readonly shell: ShellBridge,
    readonly server: SessionServer,
    private readonly log: (line: string) => void,
  ) {}

  get token(): string { return this.tokenValue; }

  static async start(options: BotlingdOptions): Promise<Botlingd> {
    const env = options.env;
    const paths = botlingdPaths(env);
    refuse2xData(paths.dataDir);
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dataDir, 0o700);
    const logFile = join(paths.dataDir, "botlingd.log");
    const log = options.log ?? ((line: string) => {
      const text = `${new Date().toISOString()} ${line}\n`;
      try { appendFileSync(logFile, text, { mode: 0o600 }); } catch { /* the log never stops the server */ }
    });

    // One server per data folder, before anything is read.
    const lock = new DataDirLock(paths.dataDir, { version: BOTLINGD_VERSION, app: "botlingd" });
    const waitUntil = Date.now() + (options.lockWaitMs ?? 3_000);
    let claim = lock.claim();
    while (!claim.ok && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      claim = lock.claim();
    }
    if (!claim.ok) throw new DataDirInUseError(paths.dataDir, claim.holder.pid);

    let store: ServerStore | null = null;
    try {
      store = await openServerStore(paths.dataDir);
      const serverId = store.meta("serverId");
      if (!serverId) throw new Error("server.db has no serverId");
      const hub = new LogHub(store, { serverStreams: true });
      const live = new LiveChannel({ sink: effectCheckpointSink(store), onError: (error) => log(`live: ${String((error as Error)?.message ?? error)}`) });
      const openStore = store;
      const exports = new BotExports({
        openReader: () => openStore.openReader(),
        settled: (botId) => stores.settled(botId),
        onError: (botId, error) => log(`exports of ${botId}: ${String((error as Error)?.message ?? error)}`),
      });
      const stores: DbBotStores = new DbBotStores(store, { onCommitted: (botId, directory) => exports.committed(botId, directory) });
      const opened = new Map<string, string>();
      const coreEngine = new CoreEngine();
      const shell = new ShellBridge({ appDataDir: env.BOTLING_APP_DATA_DIR || null });
      const { emit, deferTurn } = coreEngine.coreOptions();
      const core = new Core({
        ...coreProcessOptions({
          env: env as NodeJS.ProcessEnv, dataDir: paths.dataDir, outDir: options.outDir, emit, log: (line) => log(`core: ${line}`),
          node: plainHostNode(env as NodeJS.ProcessEnv), sealer: noSafeStorage, app: shell.appBridge(),
        }),
        deferTurn,
        botStore: (directory) => {
          const key = storeKeyOf(paths.dataDir, directory);
          opened.set(key, directory);
          return stores.open(key, directory);
        },
      });
      coreEngine.bind(core);
      const engine = new BotlingdEngine(coreEngine, { live, feed: (event) => { void exports.feed(event)?.catch?.(() => undefined); } });
      const content = new ContentService({
        store, dataDir: paths.dataDir, serverId, onCommitted: (streams: StreamId[]) => hub.committed(streams), audit: (text) => log(`content: ${text}`),
      });
      const runtime = new IntentRuntime({
        store, engine, hub, live, log: (line) => log(line), authorize: localOnly, serverEvents: "all", mirrorBotUpdates: true, content,
      });
      const report = await runtime.start();
      log(`recovery: ${JSON.stringify(report)}`);
      // Step 13: pins left by a crash are swept and every file still preparing is hashed before front ends attach.
      const recovered = await content.recover();
      log(`content recovery: ${JSON.stringify(recovered)}`);
      exports.start([...opened.entries()].map(([botId, directory]) => ({ botId, directory })));

      const startedAt = Date.now();
      let daemon: Botlingd | null = null;
      const server = new SessionServer(paths.socket, {
        serverId, serverName: SERVER_NAME, startedAt, minFeVersion: MIN_FE_VERSION,
        token: () => daemon?.token ?? "",
        hub, live, runtime, engine, content, shell,
        nextFor: (origin, originEpoch) => {
          const next: Record<string, number> = {};
          for (const row of hub.reader().prepare("SELECT target, next FROM slots WHERE origin = ? AND originEpoch = ?").all(origin, originEpoch)) next[String(row.target)] = Number(row.next);
          return next;
        },
        ensureBotStream: async (botId) => {
          if (!engine.hasBot(botId)) return false;
          await openStore.submit((tx) => { ensureBot(tx, botId); });
          return true;
        },
        log,
      }, options.session);
      daemon = new Botlingd(paths, serverId, lock, store, hub, live, exports, stores, core, runtime, content, shell, server, log);
      daemon.tokenValue = writeToken(paths.token);
      await server.listen();
      daemon.watchLock();
      log(`started: server ${serverId}, data ${paths.dataDir}, ${core.botIds().length} bots, pid ${process.pid}`);
      return daemon;
    } catch (error) {
      await store?.close().catch(() => undefined);
      lock.release();
      throw error;
    }
  }

  /** Turns under way now (status): from the effect rows, with the live text length when the live channel has it. */
  runningTurns(): Array<{ botId: string; turnId: string; state: string; startedAt: number | null; chars: number }> {
    return this.hub.reader().prepare("SELECT botId, turnId, state, startedAt FROM effects WHERE kind = 'turn' AND state IN ('queued', 'started') ORDER BY startedAt").all()
      .map((row) => {
        const botId = String(row.botId ?? "");
        const running = this.live.running(botId);
        return {
          botId, turnId: String(row.turnId ?? ""), state: String(row.state), startedAt: row.startedAt == null ? null : Number(row.startedAt),
          chars: running && running.turnId === String(row.turnId) ? running.turnText.length : 0,
        };
      });
  }

  /** Stops in order: sessions (bye closing), the core (turns end, plugins stop), then what stores what they did. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.lockTimer) clearInterval(this.lockTimer);
    const failures: unknown[] = [];
    const step = async (what: string, run: () => unknown) => {
      try { await run(); } catch (error) { failures.push(error); this.log(`stop: ${what}: ${String((error as Error)?.message ?? error)}`); }
    };
    await step("sessions", () => this.server.close());
    this.shell.close();
    await step("core", () => this.core.shutdown());
    // What the core emitted while stopping is written, then the worker stops.
    await step("events", () => this.runtime.scope.submit(() => undefined));
    await step("runtime", () => this.runtime.close());
    await step("content", () => this.content.close());
    await step("bot stores", () => this.stores.durable());
    await step("bot stores", () => this.stores.close());
    await step("exports", () => this.exports.close());
    this.live.close();
    this.hub.close();
    await step("store", () => this.store.close());
    this.lock.release();
    this.log(`stopped${failures.length ? ` with ${failures.length} failure(s)` : ""}`);
    if (failures.length) throw failures[0];
  }

  /** The folder swapped out under this server, or another process took it: stop writing at once. */
  private watchLock(): void {
    this.lockTimer = setInterval(() => {
      if (this.lock.owns()) return;
      this.log(`another process now owns ${this.paths.dataDir}; stopping without writing`);
      process.exit(CORE_EXIT_DATA_DIR_IN_USE);
    }, LOCK_CHECK_MS);
    this.lockTimer.unref();
  }
}

/** Where the built server's out/ folder is: `<out>/server/main.cjs` → `<out>`. */
export function outDirOf(script: string): string {
  return dirname(dirname(script));
}
