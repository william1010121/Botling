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
// outlives windows), and plugin secrets when no window is attached (bound per plugin/key, sealed via `ShellBridge.sealer()`).
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../core/server";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "../core/store/data-dir-lock";
import { backupCheckMs, DailyBackups, removeFutureDailyBackups } from "./backup-schedule";
import { DbBotStores } from "./botstore";
import { ContentService } from "./content";
import { ChunkCache } from "./content/chunk-cache";
import { PeerContent, PeerContentOwner } from "./content/peer-content";
import { RemoteContent } from "./content/remote";
import { FetchRequester } from "./fetch/requester";
import { FetchSource } from "./fetch/source";
import { MediaJobs } from "./media";
import { BotExports } from "./exports";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { serverNotes } from "./notes";
import { botlingdPaths, refuse2xData, RemoteSessions, SessionServer, writeToken, type BotlingdPaths } from "./session";
import { ClusterSetup } from "./identity";
import { RosterStore } from "./roster";
import { defaultPageDir, LISTEN_FILE, LISTEN_HOST, listenPort, loadRelayRoomKey, LoopbackListener, redact, RELAY_KEY_FILE, RelayConnector, relayTestOptions } from "./net";
import { relayRoomOf } from "../session";
import { PairingService, ServerJoin } from "./pairing";
import { PushTriggers } from "./push";
import { addressesValue, advertisedPort, PeerSessions, peerTimers, SessionRouter, type RelayAddress } from "./peer";
import { VapidKeySync } from "./push";
import { NO_SAFE_STORAGE, ShellBridge, answerSystemQuit } from "./shell-bridge";
import { openServerStore, startBackgroundPrune, type BackgroundPrune, type ServerStore } from "./store";
import { PeerChatMirror } from "./replica/peer-chat-mirror";
import { PassThrough, PassThroughOwner, PeerLogCache, PeerTables, SummaryRows, TableFeeds } from "./replica";
import { ServerOrigin } from "./forward";
import { BOTLINGD_VERSION, clusterOrigins, DataDirInUseError, peerChatList, PEERS_FILE, relayAllowList, type BotlingdOptions } from "./botlingd-cluster";
import { originTestHookEnabled, startOriginTestHook } from "./botlingd-setup";
import { NETWORK_STOP_BUDGET_MS, PhaseClock, START_PHASE_LOG_MS, withinBudget } from "./phase-clock";
import { openIdentity, startCore, startRuntime, startPush, startContent, startPairing, startForwarding, startSessions, startPeers } from "./botlingd-start";
import type { Later, StartContext } from "./botlingd-start-context";
export {
  authorizeRoster, BOTLINGD_VERSION, clusterOrigins, DataDirInUseError, mayRunPluginServerPart, ownMachineName, pairingAddresses, pairingPageUrl,
  peerChatList, peerMachines, peerRemoteMembers, PEERS_FILE, PLACEHOLDER_TAILNET_ORIGIN, PLUGIN_POLL_MS, readPluginAsks, readPluginGrant,
  relayAllowList, relayShown, remoteCommandVia, SERVER_NAME, storeKeyOf, tailnetOrigin,
} from "./botlingd-cluster";
export type { BotlingdOptions } from "./botlingd-cluster";
export {
  ensureSoleServerVapidKeys, isSoleServerInRoster, originTestHookEnabled, outDirOf, TEST_CORRUPT_CONTENT_ENV, TEST_ORIGIN_HOOK_ALLOW_ENV,
  TEST_ORIGIN_HOOK_ENV, testCorruptContent,
} from "./botlingd-setup";
export type { VapidSyncState } from "./botlingd-setup";

export { MIN_FE_VERSION } from "./botlingd-start";
export { NO_SAFE_STORAGE };

type Ctx = StartContext<Botlingd>;


export class Botlingd {
  /** How long the network closes of a stop may take together (a test shortens it). */
  static networkStopBudgetMs = NETWORK_STOP_BUDGET_MS;
  private stopping: Promise<void> | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  /** The one-time background prune of an oversized server.db (store/compaction.ts), started after the listeners are up. */
  private prune: BackgroundPrune | null = null;
  private pluginTimer: NodeJS.Timeout | null = null;
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
    /** M3 step 6: this server's summary rows (`srv:` table). */
    readonly summary: SummaryRows,
    /** M4-24: Web Push triggers for owned bots needing the user. */
    readonly pushTriggers: PushTriggers,
    /** M3 step 3: peer servers (KK sessions over `/v3/ws`, one per pair, the D47 exchange). */
    readonly peers: PeerSessions,
    /** M3 step 4: server pairing (join offers on this server, add-machine attempts from it). */
    readonly join: ServerJoin,
    /** M3 step 7: feeds of `srv:` tables (own to peers and front ends, copies to front ends) and the copies of peers' tables. */
    readonly feeds: TableFeeds,
    readonly peerTables: PeerTables,
    /** M3 step 8: front ends' subscriptions to peers' bots (attached side), its cache, and peers' subscriptions here (owner side). */
    readonly passThrough: PassThrough,
    readonly peerLogs: PeerLogCache,
    readonly passOwner: PassThroughOwner,
  ) {}

  /**
   * M3 step 4 / M4-14: this server's own `Profile{addresses}` (loopback, tailnet, relay room), written when it is in
   * a cluster with another server and the value changed (a lone server writes nothing, as before). Peers dial what it
   * names.
   */
  async writeOwnProfile(advertise: (port: number) => number = (port) => port): Promise<void> {
    const listening = this.listener?.port;
    const port = listening === undefined ? null : advertise(listening);
    const view = this.roster.view;
    if (this.roster.clusterId === null || !view.valid.has(view.self)) return;
    if (![...view.members.values()].some((info) => info.kind === "server" && info.member !== view.self)) return;
    if (port === null && !this.relayAddress) return;
    const value = addressesValue(port, { tailnet: this.tailnetOrigins, relay: this.relayAddress });
    try {
      if (await this.roster.writeProfile(view.self, "addresses", value)) {
        this.log(`roster: this server's address profile written (${port !== null ? `port ${port}` : "relay"})`);
      }
    } catch (error) { this.log(`roster: the address profile was not written: ${String((error as Error)?.message ?? error)}`); }
  }

  private tailnetOrigins: string[] = [];
  relayAddress: RelayAddress | null = null;

  /** M2 step 9: `/v3/c/…` and the sessions' content lookups and tickets. */
  remoteContent: RemoteContent | null = null;
  /** M2 step 13: this server's room on the relay (null: the relay path is off). */
  relay: RelayConnector | null = null;
  /** Makes the room's connector for a relay address (set at start; useRelay makes a new one on each switch). */
  private relayMaker: ((url: string, key: string) => RelayConnector) | null = null;
  /** The port this server's address profile names for its listener's (the advertised-port setting). */
  private advertise: (port: number) => number = (port) => port;
  private relaySwitch: Promise<void> = Promise.resolve();

  /**
   * Settings › Phone switched the relay (relay.json is already written): leave the old room's connection (its sessions
   * end; devices dial again) and join the room at `url` (the same room key, so the same room id), or stay off for null.
   * Pairing links, the page's allowed origins and this server's address profile follow at once. One switch at a time.
   */
  useRelay(url: string | null): Promise<void> {
    const run = this.relaySwitch.then(() => this.switchRelay(url));
    this.relaySwitch = run.catch(() => undefined);
    return run;
  }

  private async switchRelay(url: string | null): Promise<void> {
    if (this.stopping) throw new Error("botlingd is stopping");
    if ((this.relayAddress?.url ?? null) === url && (url === null) === (this.relay === null)) return;
    const old = this.relay;
    this.relay = null;
    this.relayAddress = null;
    old?.close();
    if (url !== null) {
      if (!this.relayMaker) throw new Error("botlingd is still starting; try again in a moment");
      const key = loadRelayRoomKey(join(this.paths.dataDir, RELAY_KEY_FILE));
      const room = await relayRoomOf(key);
      if (this.stopping) return;
      const relay = this.relayMaker(url, key);
      this.relay = relay;
      this.relayAddress = { url, room };
      await relay.start();
    }
    this.log(url ? `relay: ${redact(url)} (from Settings › Phone)` : "relay: off (from Settings › Phone)");
    await this.writeOwnProfile(this.advertise);
  }
  /** M2 step 10: the media jobs (variants). */
  media: MediaJobs | null = null;
  /** M3 step 10: peers' content read through this server (attached side), and this server's content read by peers. */
  peerContent: PeerContent | null = null;
  peerContentOwner: PeerContentOwner | null = null;
  chunkCache: ChunkCache | null = null;
  private utilityHostShutdown: (() => Promise<void>) | null = null;
  /** M5-04a: this server acting as its own command origin. */
  serverOrigin: ServerOrigin | null = null;
  private originHookStop: (() => void) | null = null;
  fetchSource: FetchSource | null = null;
  /** M5-07b: requester side of on-demand fetch (`app_fetch`, M5-07d, calls `fetch`). */
  fetchRequester: FetchRequester | null = null;
  /** M5-04e: the read-only copies of peer bots' chats in the main bot's folder. */
  chatMirror: PeerChatMirror | null = null;
  /** M4-26: cluster VAPID key rotation & distribution over full peer sessions after server revocation. */
  vapidSync: VapidKeySync | null = null;

  get token(): string { return this.tokenValue; }

  /** Starts botlingd: the phases in order (botlingd-start.ts, then assembleDaemon and listenAll below). A failure closes the store and lets go of the lock. */
  static async start(options: BotlingdOptions): Promise<Botlingd> {
    const env = options.env;
    const paths = botlingdPaths(env);
    const port = listenPort(env);
    const timers = peerTimers(env);
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
    // What a closure made in an early phase reads from a later one (before then it is "not ready", as it was in one function).
    const later = {
      peerSessions: null, pluginRead: null, fetchRequester: null, syncPlugins: async () => undefined, origin: null, callInHost: null,
      summary: null, pushTriggers: null, attachedDevices: () => new Set<string>(), copyChanged: () => {}, daemon: null,
    } as Later<Botlingd>; // `peers` is set by startPeers

    let store: ServerStore | null = null;
    try {
      // Each phase that takes 100 ms or more says so in the log (an install waits for these one after another); the
      // `timing:` lines of startCore, startRuntime and startPush and of the core itself say where a long one went.
      const clock = new PhaseClock(log, START_PHASE_LOG_MS);
      const began = Date.now();
      store = await clock.time("start", "open the store", () => openServerStore(paths.dataDir, {
        compaction: options.compaction === false ? false : { log, ...options.compaction },
        // Startup timing: a write batch (BEGIN to the end of COMMIT, one fsync) that took 100 ms or more.
        onBatch: (info) => { if (info.ms >= 100) log(`timing: server.db: batch of ${info.size} command(s) ${Math.round(info.ms)} ms`); },
      }));
      const s = { options, env, paths, port, timers, log, later, lock, store } as Ctx;
      Object.assign(s, await clock.time("start", "identity", () => openIdentity(s)));
      Object.assign(s, await clock.time("start", "core", () => startCore(s)));
      Object.assign(s, await clock.time("start", "runtime and recovery", () => startRuntime(s)));
      Object.assign(s, await clock.time("start", "summary rows and push", () => startPush(s)));
      Object.assign(s, await clock.time("start", "plugin rows, content and media", () => startContent(s)));
      Object.assign(s, await clock.time("start", "pairing", () => startPairing(s)));
      Object.assign(s, await clock.time("start", "forwarding", () => startForwarding(s)));
      Object.assign(s, await clock.time("start", "sessions", () => startSessions(s)));
      Object.assign(s, await clock.time("start", "peers", () => startPeers(s)));
      Object.assign(s, await Botlingd.assembleDaemon(s));
      await clock.time("start", "listen", () => Botlingd.listenAll(s, began));
      return s.daemon;
    } catch (error) {
      await store?.close().catch(() => undefined);
      lock.release();
      throw error;
    }
  }

  /** The `Botlingd` itself, with what the phases made: the token, the relay room maker, the chat mirror, the origin test hook. */
  private static async assembleDaemon(s: Ctx): Promise<Partial<Ctx>> {
    const { env, paths, log, later, lock, store, serverId, identity, roster, clusterSetup, hub, live, exports, stores, core, runtime, content, shell, server, remote, pairing, summary, push, peers, serverJoin, feeds, peerTables, passThrough, peerLogs, passOwner, remoteContent, peerContent, peerContentOwner, chunkCache, serverOrigin, fetchSource, fetchRequester, vapidSync, media, pluginTimer, utilityHost, origin, relayAddress, relayRoom } = s;
    const daemon = new Botlingd(paths, serverId, lock, store, hub, live, exports, stores, core, runtime, content, shell, server, log, roster, clusterSetup, remote, pairing, summary, push, peers, serverJoin, feeds, peerTables, passThrough, peerLogs, passOwner);
    later.daemon = daemon;
    daemon.remoteContent = remoteContent;
    daemon.peerContent = peerContent;
    daemon.peerContentOwner = peerContentOwner;
    daemon.chunkCache = chunkCache;
    daemon.serverOrigin = serverOrigin;
    if (originTestHookEnabled(env)) daemon.originHookStop = startOriginTestHook(paths.dataDir, serverOrigin, log);
    daemon.fetchSource = fetchSource;
    daemon.fetchRequester = fetchRequester;
    daemon.vapidSync = vapidSync;
    // M5-04e: the main bot reads a peer bot's chat in `<main folder>/.bot/peers/<botId>/chat.md` (read-only; written only here).
    // Until M5-04i's `runMainBot` is merged every server runs it.
    const mainFolder = join(paths.dataDir, "main");
    daemon.chatMirror = new PeerChatMirror({
      peerLogs, passThrough, root: mainFolder,
      folder: (botId) => join(mainFolder, ".bot", "peers", botId),
      list: () => peerChatList(roster, hub.reader()),
      log: (line) => log(line),
    });
    daemon.media = media;
    daemon.pluginTimer = pluginTimer;
    daemon.utilityHostShutdown = utilityHost?.shutdown ?? null;
    daemon.tailnetOrigins = origin ? [origin] : [];
    daemon.relayAddress = relayAddress;
    daemon.tokenValue = writeToken(paths.token);
    // The room on the relay: made here at start, and again whenever Settings › Phone switches the relay (useRelay).
    const allowList = relayAllowList({ roster, identity, pairing });
    daemon.relayMaker = (url, key) => new RelayConnector({ url, roomKey: key, sessions: new SessionRouter(remote, peers, undefined, serverJoin), allowList, log, ...relayTestOptions(env) });
    daemon.advertise = (at) => advertisedPort(env, at);
    roster.onChange(() => { void daemon?.relay?.refreshAllow(); });
    pairing.onOffersChanged(() => { void daemon?.relay?.refreshAllow(); });
    if (relayRoom) daemon.relay = daemon.relayMaker(relayRoom.url, relayRoom.key);
    return { daemon };
  }

  /** Goes live: the Unix socket, the loopback listener, the relay room, the peer sessions, the call-in answers, the lock watch and the daily backups. */
  private static async listenAll(s: Ctx, began: number): Promise<void> {
    const { options, env, paths, log, port, origin, later, store, serverId, hub, core, runtime, roster, server, peers, vapidSync, forwarder, serverOrigin, daemon } = s;
    await server.listen();
    await daemon.listen(port, options.outDir, origin);
    await daemon.relay?.start();
    await daemon.writeOwnProfile(daemon.advertise);
    peers.start();
    vapidSync.start();
    // M5-02b: a guest's answer to a call-in goes out as this server's own command (ServerOrigin checks it before it commits).
    // Bound only now (M5-03b review): `attach` answers the call-ins a crash interrupted at once, and before `peers.start()`
    // the directory knows no peer, so every such answer was refused and lost (marked sent, never queued). Until here an ask
    // is refused "not ready" (fail closed) and a queued call-in waits.
    runtime.callIns.attach({ ownerOf: (target) => forwarder.ownerOf(target), submit: (target, cmd) => serverOrigin.submit(target, cmd), submitIn: (tx, target, cmd) => serverOrigin.submitIn(tx, target, cmd) });
    roster.onChange(() => { runtime.callIns.retry(); }); // interrupted call-ins waiting for a host's server
    later.copyChanged = () => { runtime.callIns.retry(); };
    daemon.chatMirror?.start();
    daemon.watchLock();
    // A daily backup stamped in the future is bogus (it would hold the real ones back): removed whether or not they are on.
    for (const path of removeFutureDailyBackups(store.backupsDir)) log(`removed a daily backup stamped in the future: ${path}`);
    const schedule = backupCheckMs(env);
    if (schedule) {
      daemon.backups = new DailyBackups({ backupsDir: store.backupsDir, take: () => store.backup("daily"), log, ...schedule });
      daemon.backups.start();
    } else log("daily backups are off (the default; BOTLING_SERVER_DAILY_BACKUP=1 turns them on)");
    for (const note of serverNotes(paths.dataDir, hub.reader(), Date.now(), process.platform, schedule !== null)) log(`note (${note.id}): ${note.text}`);
    // After the start, so it never holds up the window's attach (and with it `healthy`): it is many short writer commands.
    if (options.compaction !== false) daemon.prune = startBackgroundPrune({ log, ...options.compaction, submit: (command) => store.submit(command), changed: (stream) => hub.committed([stream]) });
    log(`started: server ${serverId}, data ${paths.dataDir}, ${core.botIds().length} bots, pid ${process.pid}, ${Date.now() - began} ms`);
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
        port,
        remote: new SessionRouter(this.remote, this.peers, undefined, this.join),
        pageDir: defaultPageDir(outDir),
        // D71: exact origins of valid cluster servers, own tailnet origin, and the relay; revoked servers drop out at once.
        origins: () => clusterOrigins(this.roster, origin, this.relayAddress?.url ?? null).origins,
        connectOrigins: () => clusterOrigins(this.roster, null, this.relayAddress?.url ?? null).connectOrigins,
        log: this.log,
        ...(this.remoteContent ? { content: this.remoteContent } : {}),
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

  /**
   * A quit from macOS reached this process (the packaged botlingd is the same app bundle as the window): "kept" when the
   * attached windows were asked to quit and botlingd keeps running, "stop" when the caller should stop it (shell-bridge.ts).
   */
  answerSystemQuit(systemEnding: boolean): "kept" | "stop" {
    if (this.stopping) return "stop";
    return answerSystemQuit(this.shell, systemEnding, this.log);
  }

  /** Stops in order: sessions (bye closing), the core (turns end, plugins stop), then what stores what they did. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.lockTimer) clearInterval(this.lockTimer);
    await this.prune?.stop().catch(() => undefined);
    if (this.pluginTimer) clearInterval(this.pluginTimer);
    const failures: unknown[] = [];
    const clock = new PhaseClock(this.log);
    const step = async (what: string, run: () => unknown) => {
      try { await clock.time("stop", what, run); } catch (error) { failures.push(error); this.log(`stop: ${what}: ${String((error as Error)?.message ?? error)}`); }
    };
    // The closes of sessions, sockets and peer links share one budget: a link that never answers must not hold the core's
    // stop (and so an install, then the new build waiting for it). What they hold is not durable; the store closes later.
    const until = Date.now() + Botlingd.networkStopBudgetMs;
    const network = (what: string, run: () => unknown) => step(what, () => withinBudget(until, what, run, this.log));
    await step("daily backups", () => this.backups?.stop());
    await network("sessions", () => this.server.close());
    await network("pairing", () => this.pairing.close());
    await network("server pairing", () => this.join.close());
    await network("remote sessions", () => this.remote.close());
    await step("relay", () => this.relay?.closeAfterDrain(1_000));
    this.vapidSync?.close();
    await network("peer sessions", () => this.peers.close());
    this.chatMirror?.stop();
    this.passThrough.close();
    this.passOwner.close();
    this.fetchSource?.close();
    this.fetchRequester?.close();
    this.peerContent?.close();
    await step("peer log cache", () => this.peerLogs.idle());
    await step("peer content", () => this.peerContent?.flushed());
    this.originHookStop?.();
    this.serverOrigin?.close();
    await step("fetch source", () => this.fetchSource?.flushed());
    await step("fetch requester", () => this.fetchRequester?.flushed());
    this.feeds.close();
    await network("listener", () => this.listener?.close());
    rmSync(join(this.paths.dataDir, LISTEN_FILE), { force: true });
    rmSync(join(this.paths.dataDir, PEERS_FILE), { force: true });
    this.shell.close();
    await step("core", () => this.core.shutdown());
    await step("plugin host utility", () => this.utilityHostShutdown?.());
    // What the core emitted while stopping is written (with the summary rows still waiting), then the worker stops.
    await step("events", () => this.runtime.scope.submit(() => undefined));
    await step("summary rows", () => this.summary.flush());
    this.summary.close();
    this.pushTriggers.close();
    await step("push triggers", () => this.pushTriggers.idle());
    await step("runtime", () => this.runtime.close());
    await step("media jobs", () => this.media?.close());
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
