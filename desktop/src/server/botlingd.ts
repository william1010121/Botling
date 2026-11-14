// botlingd, assembled (M1 step 9): the 2.x core running inside the server process, without Electron, on server.db.
//
//   data folder lock (core/store/data-dir-lock.ts: one botlingd, or 2.x core, per folder)
//   → server.db (openServerStore) → LogHub (bot streams + this server's srv: stream) → LiveChannel (checkpoints into
//     the effect rows) → BotExports + DbBotStores (the bots' stores on server.db rows; each commit schedules the 2.x
//     export files) → the 2.x Core on those stores (plugins through the Node plugin host, app ops to the attached
//     window through the ShellBridge, turns kept aside through CoreEngine) → IntentRuntime (intents, legacy apply,
//     effect worker, event tap, recovery at start) → content index (step 13: recover, then lines are indexed)
//   → the 2.x exports brought up to date → a new local token → the Unix socket → the loopback listener (M2 step 6:
//     127.0.0.1 only, the page and the device WebSocket; `tailscale serve` publishes it) → daily backups (step 12).
//
// Not in botlingd (M1): the 2.x phone bridge and relay connector, the restart checkpoint and core hot swap (botlingd
// outlives windows), plugin secrets (risk 3: no safe storage without the window, see `noSafeStorage`).
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { coreProcessOptions, plainHostNode } from "../core/core-process";
import type { Sealer } from "../core/plugins/secrets";
import { Core } from "../core/server";
import { MAIN_BOT_ID } from "../core/store/records";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "../core/store/data-dir-lock";
import type { StreamId } from "../protocol";
import { backupCheckMs, DailyBackups } from "./backup-schedule";
import { BotlingdEngine } from "./botlingd-engine";
import { DbBotStores } from "./botstore";
import { ContentService } from "./content";
import { effectCheckpointSink, ensureBot } from "./effects";
import { BotExports } from "./exports";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { serverNotes } from "./notes";
import { botlingdPaths, refuse2xData, RemoteSessions, SessionServer, slotAuthorize, writeToken, type BotlingdPaths, type SessionHost, type SessionOptions } from "./session";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "./identity";
import { RosterStore } from "./roster";
import { defaultPageDir, LISTEN_FILE, LISTEN_HOST, listenPort, LoopbackListener } from "./net";
import { PairingService } from "./pairing";
import { ShellBridge } from "./shell-bridge";
import { openServerStore, type ServerStore } from "./store";

/** Where a pairing link points while no tailnet origin is set (BOTLING_SERVER_TAILNET_ORIGIN; `tailscale serve`, step 6). */
export const PLACEHOLDER_TAILNET_ORIGIN = "https://tailnet-name.invalid";

/** The https origin a device reaches this server at over the tailnet (set by the user once `tailscale serve` runs), or null. */
export function tailnetOrigin(env: Record<string, string | undefined>): string | null {
  const value = (env.BOTLING_SERVER_TAILNET_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(value) ? value : null;
}

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
  private backups: DailyBackups | null = null;
  /** M2 step 6: the loopback listener (page, `/v3/ws`), or null when it is off or its port was taken. */
  listener: LoopbackListener | null = null;

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
    /** M2: the roster (validity of devices and servers) and the cluster setup of the first pairing. */
    readonly roster: RosterStore,
    readonly cluster: ClusterSetup,
    /** M2: remote device sessions (accept a transport; a revoked device's sessions end at once). */
    readonly remote: RemoteSessions,
    /** M2 step 5: device pairing (offers, the pairing sessions, local admin requests). */
    readonly pairing: PairingService,
  ) {}

  get token(): string { return this.tokenValue; }

  static async start(options: BotlingdOptions): Promise<Botlingd> {
    const env = options.env;
    const paths = botlingdPaths(env);
    const port = listenPort(env);
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
      // M2: the server's keys (made on the first start, server-keys.json 0600) and server.db bound to them before
      // anything reads meta.serverId (a fresh data folder is named by its member id, v1 §3).
      const identity = await loadOrCreateServerIdentity(paths.dataDir, { create: store.meta("memberId") === undefined });
      const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
      const roster = await RosterStore.open(store, identity, { log });
      const clusterSetup = new ClusterSetup(roster);
      log(`identity: member ${memberId}${identity.created ? " (new keys)" : ""}, cluster ${roster.clusterId ?? "none yet"}`);
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
        store, engine, hub, live, log: (line) => log(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true, content,
        // §11.3 audits (a floor that skipped slots after a restore, a slot conflict, a held slot dropped).
        audit: (_tx, event) => log(`audit: ${JSON.stringify(event)}`),
      });
      const report = await runtime.start();
      log(`recovery: ${JSON.stringify(report)}`);
      // Step 13: pins left by a crash are swept and every file still preparing is hashed before front ends attach.
      const recovered = await content.recover();
      log(`content recovery: ${JSON.stringify(recovered)}`);
      exports.start([...opened.entries()].map(([botId, directory]) => ({ botId, directory })));

      const startedAt = Date.now();
      let daemon: Botlingd | null = null;
      const origin = tailnetOrigin(env);
      const pairing = new PairingService({
        roster, cluster: clusterSetup, identity, serverName: SERVER_NAME, log,
        addresses: () => ({ tailnet: origin ?? PLACEHOLDER_TAILNET_ORIGIN }),
        pageUrl: () => `${origin ?? PLACEHOLDER_TAILNET_ORIGIN}/v3/`,
        addressNote: () => (origin ? null : "no tailnet address is set yet (BOTLING_SERVER_TAILNET_ORIGIN, once tailscale serve publishes this server), so the link names a placeholder."),
      });
      const sessionHost: SessionHost = {
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
        admin: { handle: (op) => pairing.admin(op), onEvent: (listener) => pairing.onEvent(listener) },
      };
      const server = new SessionServer(paths.socket, sessionHost, options.session);
      // M2 step 4: paired devices' encrypted sessions (the transports come with steps 6 and 13).
      const remote = new RemoteSessions({ ...sessionHost, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing }, options.session);
      daemon = new Botlingd(paths, serverId, lock, store, hub, live, exports, stores, core, runtime, content, shell, server, log, roster, clusterSetup, remote, pairing);
      daemon.tokenValue = writeToken(paths.token);
      await server.listen();
      await daemon.listen(port, options.outDir, origin);
      daemon.watchLock();
      const schedule = backupCheckMs(env);
      if (schedule) {
        daemon.backups = new DailyBackups({ backupsDir: openStore.backupsDir, take: () => openStore.backup("daily"), log, ...schedule });
        daemon.backups.start();
      } else log("daily backups are off (BOTLING_SERVER_BACKUP_CHECK_MS=0)");
      for (const note of serverNotes(paths.dataDir, hub.reader())) log(`note (${note.id}): ${note.text}`);
      log(`started: server ${serverId}, data ${paths.dataDir}, ${core.botIds().length} bots, pid ${process.pid}`);
      return daemon;
    } catch (error) {
      await store?.close().catch(() => undefined);
      lock.release();
      throw error;
    }
  }

  /**
   * The loopback listener on 127.0.0.1:`port` (null = off). A port already taken does not stop the server: the local
   * socket keeps working, the log and `botlingd status` say why devices cannot reach it.
   */
  private async listen(port: number | null, outDir: string, origin: string | null): Promise<void> {
    const file = join(this.paths.dataDir, LISTEN_FILE);
    rmSync(file, { force: true });
    if (port === null) { this.log("listener: off (BOTLING_SERVER_PORT=off)"); return; }
    let state: Record<string, unknown>;
    try {
      this.listener = await LoopbackListener.start({
        port, remote: this.remote, pageDir: defaultPageDir(outDir), origins: () => (origin ? [origin] : []), log: this.log,
      });
      state = { pid: process.pid, address: LISTEN_HOST, port: this.listener.port };
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      this.log(`listener: not listening on ${LISTEN_HOST}:${port}: ${text}`);
      state = { pid: process.pid, address: LISTEN_HOST, port, error: text };
    }
    try { writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 }); } catch { /* status then says nothing about it */ }
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
    await step("daily backups", () => this.backups?.stop());
    await step("sessions", () => this.server.close());
    await step("pairing", () => this.pairing.close());
    await step("remote sessions", () => this.remote.close());
    await step("listener", () => this.listener?.close());
    rmSync(join(this.paths.dataDir, LISTEN_FILE), { force: true });
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
