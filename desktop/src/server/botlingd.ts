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
import { coreProcessOptions, plainHostNode } from "../core/core-process";
import { createUtilityHostLauncher, createUtilityScriptRunner } from "./utility-process";
import { Core } from "../core/server";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "../core/store/data-dir-lock";
import { type StreamId } from "../protocol";
import { backupCheckMs, DailyBackups } from "./backup-schedule";
import { BotlingdEngine } from "./botlingd-engine";
import { DbBotStores } from "./botstore";
import { ContentService } from "./content";
import { ChunkCache, PeerCacheBudget } from "./content/chunk-cache";
import { LocalPeerReads } from "./content/local-peer-read";
import { LOCAL_WINDOW, PeerContent, PeerContentOwner } from "./content/peer-content";
import { lineContentRef } from "./content/line-content";
import { PluginContentRead } from "./content/plugin-read";
import { RemoteContent } from "./content/remote";
import { Uploads } from "./content/put";
import { ContentTickets } from "./content/tickets";
import { clusterNames, FetchApproval } from "./fetch/approval";
import { createAppFetch } from "./fetch/app-fetch";
import { FetchRequester } from "./fetch/requester";
import { FetchSource } from "./fetch/source";
import { MediaJobs } from "./media";
import { effectCheckpointSink, ensureBot } from "./effects";
import { BotExports } from "./exports";
import { callInCrash, callInTimers, type CallInHost } from "./callin";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { serverNotes } from "./notes";
import { botlingdPaths, refuse2xData, RemoteSessions, SessionServer, slotAuthorize, writeToken, type BotlingdPaths, type SessionHost } from "./session";
import { fixedIds } from "./fixed-ids";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, readVapidKeyRecord } from "./identity";
import { Gossip, PrefsStore, RosterStore } from "./roster";
import { changeRelaySetting, defaultPageDir, effectiveRelayUrl, LISTEN_FILE, LISTEN_HOST, listenPort, loadRelayRoomKey, LoopbackListener, redact, RELAY_KEY_FILE, RELAY_SETTING_FILE, RELAY_URL_ENV, RelayConnector, relayTestOptions } from "./net";
import { relayRoomOf } from "../session";
import { PairingService, ServerJoin } from "./pairing";
import { PhoneDesk } from "./pairing/phone-desk";
import { attachedDeviceIds, PushSender, PushTriggers } from "./push";
import { addressesValue, advertisedPort, PeerSessions, peerTimers, SessionRouter, type PeerSession, type RelayAddress } from "./peer";
import { VapidKeySync } from "./push";
import { NO_SAFE_STORAGE, ShellBridge, answerSystemQuit, appBundleOf } from "./shell-bridge";
import { openServerStore, type ServerStore } from "./store";
import { PeerChatMirror } from "./replica/peer-chat-mirror";
import { followedStreams, ownTableStream, PassThrough, PassThroughOwner, passThroughSettings, PEER_CACHE_BYTES, PeerLogCache, PeerTables, putRow, SummaryRows, TableFeeds } from "./replica";
import { PluginAdmin } from "./plugin-admin";
import { PluginHashCache, pluginsDigestOf, reconcilePluginRows } from "./replica/plugin-rows";
import { Directory, Forwarder, OwnerInbox, ServerOrigin } from "./forward";
import { designatedServer, machineLabel } from "./designated";
import { release as osRelease } from "node:os";
import {
  authorizeRoster, BOTLINGD_VERSION, clusterOrigins, DataDirInUseError, mayRunPluginServerPart, ownMachineName, pairingAddresses, pairingPageUrl,
  peerChatList, peerMachines, peerRemoteMembers, PEERS_FILE, PLUGIN_POLL_MS, readPluginAsks, readPluginGrant, relayAllowList, relayShown,
  remoteCommandVia, SERVER_NAME, storeKeyOf, tailnetOrigin, type BotlingdOptions,
} from "./botlingd-cluster";
import {
  ensureSoleServerVapidKeys, originTestHookEnabled, startOriginTestHook, testCorruptContent, type VapidSyncState,
} from "./botlingd-setup";
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

/** The oldest Botling 3 window this server serves (fe-link compares it without the -suffix). */
export const MIN_FE_VERSION = "3.0.0-m1";
export { NO_SAFE_STORAGE };


/**
 * Values that a closure made in an early phase of `Botlingd.start` reads after a later phase has made them. Before then a
 * call finds the empty value and answers "not ready" (fail closed), as it did when `start` was one function.
 */
interface Later {
  /** `peers` as a nullable view (machine names): null until the peer sessions exist. */
  peerSessions: PeerSessions | null;
  /** M3 step 3: peer servers. Set by `startPeers`; earlier phases use it only in callbacks that run once sessions exist. */
  peers: PeerSessions;
  /** Plugin content reads through peers (set by `startSessions`). */
  pluginRead: PluginContentRead | null;
  /** M5-07d: `app_fetch` resolves a machine name to a valid peer and uses the requester, which is built after the core. */
  fetchRequester: FetchRequester | null;
  /** M5-13b/M5-13c: publishes one plugin:<name> row per installed plugin (plus audit rows for bot writes) and keeps machine.pluginsDigest current. */
  syncPlugins: (force?: boolean) => Promise<void>;
  /** M5-04c: this server as its own command origin (a call before the origin is built is "not ready"). */
  origin: ServerOrigin | null;
  /** M5-02c: the host's side of call-ins (the runtime owns it; until it is wired a call-in is "not reachable"). */
  callInHost: CallInHost | null;
  /** M3 step 6: the server's own summary rows in its srv: table (written from what the event tap stores). */
  summary: SummaryRows | null;
  /** M4-24: Web Push triggers for owned bots needing the user (wired after remote sessions exist). */
  pushTriggers: PushTriggers | null;
  attachedDevices: () => Set<string>;
  /** fu-callin-outbox review: interrupted call-ins waiting for a host's server are answered when a copy fills (bound once the guest is attached). */
  copyChanged: () => void;
  /** The server itself, once it exists (the relay, the listener's port and the token are read through it). */
  daemon: Botlingd | null;
}

/** What `Botlingd.start` has made so far. Each phase takes what it reads (`Pick`) and returns what later phases read. */
interface StartContext {
  options: BotlingdOptions;
  env: BotlingdOptions["env"];
  paths: BotlingdPaths;
  port: ReturnType<typeof listenPort>;
  timers: ReturnType<typeof peerTimers>;
  log: (line: string) => void;
  later: Later;
  lock: DataDirLock;
  store: ServerStore;
  identity: Awaited<ReturnType<typeof loadOrCreateServerIdentity>>;
  serverId: string;
  memberId: string;
  ids: ReturnType<typeof fixedIds>;
  roster: RosterStore;
  clusterSetup: ClusterSetup;
  prefs: PrefsStore;
  gossip: Gossip;
  hub: LogHub;
  live: LiveChannel;
  exports: BotExports;
  stores: DbBotStores;
  opened: Map<string, string>;
  coreEngine: CoreEngine;
  shell: ShellBridge;
  utilityHost: ReturnType<typeof createUtilityHostLauncher> | null;
  pdfTextRunner: ReturnType<typeof createUtilityScriptRunner> | undefined;
  core: Core;
  pendingBotWrites: Map<string, { botId: string; at: number }>;
  engine: BotlingdEngine;
  content: ContentService;
  media: MediaJobs;
  feeds: TableFeeds;
  peerTables: PeerTables;
  uploads: Uploads;
  runtime: IntentRuntime;
  pluginHashCache: PluginHashCache;
  readInstalledPlugins: () => ReturnType<PluginHashCache["read"]>;
  machineRow: (pluginsDigest: string | null) => unknown;
  summary: SummaryRows;
  push: PushTriggers;
  deviceReadable: (member: string) => boolean;
  pluginTimer: NodeJS.Timeout;
  startedAt: number;
  origin: string | null;
  relayRoom: { url: string; key: string; room: string } | null;
  relayAddress: RelayAddress | null;
  pairing: PairingService;
  serverJoin: ServerJoin;
  directory: Directory;
  forwarder: Forwarder;
  serverOrigin: ServerOrigin;
  inbox: OwnerInbox;
  followed: () => Set<string>;
  peerBudget: PeerCacheBudget;
  peerLogs: PeerLogCache;
  passThrough: PassThrough;
  passOwner: PassThroughOwner;
  pluginAdmin: PluginAdmin;
  phone: PhoneDesk;
  server: SessionServer;
  chunkCache: ChunkCache;
  peerContent: PeerContent;
  peerContentOwner: PeerContentOwner;
  remoteContent: RemoteContent;
  remote: RemoteSessions;
  approval: FetchApproval;
  fetchSource: FetchSource;
  fetchRequester: FetchRequester;
  vapidSync: VapidKeySync;
  peers: PeerSessions;
  daemon: Botlingd;
}


export class Botlingd {
  private stopping: Promise<void> | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
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
  private relayAddress: RelayAddress | null = null;

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

  /** Starts botlingd: the phases in order (each one below), then the listeners. A failure closes the store and lets go of the lock. */
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
    const lock = await Botlingd.claimLock(options, paths);
    // What a closure made in an early phase reads from a later one (before then it is "not ready", as it was in one function).
    const later = {
      peerSessions: null, pluginRead: null, fetchRequester: null, syncPlugins: async () => undefined, origin: null, callInHost: null,
      summary: null, pushTriggers: null, attachedDevices: () => new Set<string>(), copyChanged: () => {}, daemon: null,
    } as Later; // `peers` is set by startPeers

    let store: ServerStore | null = null;
    try {
      store = await openServerStore(paths.dataDir);
      const s1 = { options, env, paths, port, timers, log, later, lock, store };
      const s2 = { ...s1, ...(await Botlingd.openIdentity(s1)) };
      const s3 = { ...s2, ...(await Botlingd.startCore(s2)) };
      const s4 = { ...s3, ...(await Botlingd.startRuntime(s3)) };
      const s5 = { ...s4, ...(await Botlingd.startPush(s4)) };
      const s6 = { ...s5, ...(await Botlingd.startPlugins(s5)) };
      await Botlingd.recoverContent(s6);
      const s7 = { ...s6, ...(await Botlingd.startPairing(s6)) };
      const s8 = { ...s7, ...(await Botlingd.startForwarding(s7)) };
      const s9 = { ...s8, ...(await Botlingd.startPassThrough(s8)) };
      const s10 = { ...s9, ...(await Botlingd.startSessions(s9)) };
      const s11 = { ...s10, ...(await Botlingd.startFetch(s10)) };
      const s12 = { ...s11, ...(await Botlingd.startPeers(s11)) };
      const s13 = { ...s12, ...(await Botlingd.assembleDaemon(s12)) };
      await Botlingd.listenAll(s13);
      return s13.daemon;
    } catch (error) {
      await store?.close().catch(() => undefined);
      lock.release();
      throw error;
    }
  }

  /** One server per data folder, before anything is read: claims the data folder lock (waits `lockWaitMs` for another holder to let go). */
  private static async claimLock(options: BotlingdOptions, paths: BotlingdPaths): Promise<DataDirLock> {
    const lock = new DataDirLock(paths.dataDir, { version: BOTLINGD_VERSION, app: "botlingd" });
    const waitUntil = Date.now() + (options.lockWaitMs ?? 3_000);
    let claim = lock.claim();
    while (!claim.ok && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      claim = lock.claim();
    }
    if (!claim.ok) throw new DataDirInUseError(paths.dataDir, claim.holder.pid);
    return lock;
  }

  /**
   * The server's keys, the fixed bot ids, the roster, the cluster preferences and the gossip, on the opened server.db.
   */
  private static async openIdentity(
    s: Pick<StartContext, "paths" | "store" | "log">,
  ) {
    const { paths, store, log } = s;
    // M2: the server's keys (made on the first start, server-keys.json 0600) and server.db bound to them before
    // anything reads meta.serverId (a fresh data folder is named by its member id, v1 §3).
    const identity = await loadOrCreateServerIdentity(paths.dataDir, { create: store.meta("memberId") === undefined });
    const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
    const hadFixedIds = store.meta("ids.main") !== undefined;
    const ids = await store.submit((tx) => fixedIds(tx, { created: identity.created }));
    if (!ids.minted && !hadFixedIds) {
      log("ids: this data folder keeps the 2.x ids for its main bot and Maintainer (made before Botling 3 M5); a new folder gets its own.");
    }
    const roster = await RosterStore.open(store, identity, { log });
    const clusterSetup = new ClusterSetup(roster);
    // M3 step 5: cluster preferences (LWW per key) and the gossip of statements and preferences between servers.
    const prefs = await PrefsStore.open(store, { self: memberId, knownWriter: (writer) => roster.view.servers.has(writer), log });
    const gossip = new Gossip({ roster, prefs, log });
    log(`identity: member ${memberId}${identity.created ? " (new keys)" : ""}, cluster ${roster.clusterId ?? "none yet"}`);
    return { identity, serverId, memberId, ids, roster, clusterSetup, prefs, gossip };
  }

  /**
   * The log hub, the live channel, the bots' stores and exports, the shell bridge and the 2.x Core on them (plugins through the
   * Node plugin host). What its closures read from later phases goes through `later`.
   */
  private static async startCore(
    s: Pick<StartContext, "options" | "env" | "paths" | "log" | "later" | "store" | "serverId"
      | "memberId" | "ids" | "roster" | "prefs">,
  ) {
    const { options, env, paths, log, later, store, serverId, memberId, ids, roster, prefs } = s;
    const hub = new LogHub(store, { serverStreams: true });
    const live = new LiveChannel({ sink: effectCheckpointSink(store), onError: (error) => log(`live: ${String((error as Error)?.message ?? error)}`) });
    const exports = new BotExports({
      openReader: () => store.openReader(),
      settled: (botId) => stores.settled(botId),
      onError: (botId, error) => log(`exports of ${botId}: ${String((error as Error)?.message ?? error)}`),
    });
    const stores: DbBotStores = new DbBotStores(store, { onCommitted: (botId, directory) => exports.committed(botId, directory) });
    const opened = new Map<string, string>();
    const resolveDesignated = (raw: unknown): string => designatedServer(roster.view, raw);
    const machineName = (id: string): string =>
      later.peerSessions?.states().find((state) => state.member === id)?.name
      ?? roster.profile(id, "name")
      ?? roster.view.members.get(id)?.name
      ?? (id === memberId ? SERVER_NAME : id);
    const machineLine = (id: string): string => machineLabel(machineName(id));
    const designated = resolveDesignated(prefs.get("designatedServer")?.value);
    prefs.onChange((rows) => {
      for (const row of rows) {
        if (row.key === "designatedServer") {
          log(`designatedServer is now ${machineLine(resolveDesignated(row.value))}; the main bot moves when each server next starts.`);
        }
      }
    });
    const coreEngine = new CoreEngine();
    // Installing a developer build (botling.dev): the script waits for this process and reopens the app on these folders.
    const shell = new ShellBridge({
      appDataDir: env.BOTLING_APP_DATA_DIR || null,
      pid: process.pid,
      bundle: appBundleOf(process.execPath, !!options.packaged),
      serverDataDir: paths.dataDir,
      stopServer: () => {
        log("stopping for an install of a developer build (the windows have quit)");
        (options.stopSelf ?? (() => process.kill(process.pid, "SIGTERM")))();
      },
    });
    const { emit, deferTurn } = coreEngine.coreOptions();
    const utilityHost = options.packaged && options.electronUtility
      ? createUtilityHostLauncher({
          ...options.electronUtility,
          utilityScript: join(options.outDir, "host", "host-utility.mjs"),
          ledgerFile: join(paths.dataDir, "core", "children.json"),
          log: (text) => log(`plugin host: ${text}`),
        })
      : null;
    const pluginNode = options.packaged
      ? (utilityHost ? { command: "", launch: utilityHost.launch } : null)
      : plainHostNode(env as NodeJS.ProcessEnv);
    const pdfTextRunner = options.packaged && options.electronUtility
      ? createUtilityScriptRunner(options.electronUtility.utilityProcess)
      : undefined;
    // M5-07d: `app_fetch` resolves a machine name to a valid peer and uses the requester, which is built after the core.
    const pendingBotWrites = new Map<string, { botId: string; at: number }>();
    const core = new Core({
      ...coreProcessOptions({
        env: env as NodeJS.ProcessEnv, dataDir: paths.dataDir, outDir: options.outDir, emit, log: (line) => log(`core: ${line}`),
        node: pluginNode, sealer: shell.sealer(), boundSecrets: true, app: shell.appBridge(),
      }),
      deferTurn,
      mainBotId: ids.main,
      maintainerId: ids.maintainer,
      runMainBot: designated === memberId,
      mainBotMachine: () => (designated === memberId ? null : machineLine(designated)),
      mayRunServerPart: (name, codeHash) => mayRunPluginServerPart(() => hub.reader(), `srv:${serverId}`, name, codeHash),
      separateHosts: true,
      pluginWritten: (name, botId) => { pendingBotWrites.set(name, { botId, at: Date.now() }); void later.syncPlugins(); },
      content: {
        read: async (ref, offset, length) => {
          if (!later.pluginRead) throw new Error("The machine that has this file is not reachable.");
          return later.pluginRead.read(ref, offset, length);
        },
        fetch: async (storageDir, ref) => {
          if (!later.pluginRead) throw new Error("The machine that has this file is not reachable.");
          return later.pluginRead.fetch(storageDir, ref);
        },
      },
      // M5-09: a link button's file that is no longer on this disk is given as the line's content reference.
      lineContent: (botId, messageId, link) => lineContentRef(hub.reader(), serverId, botId, messageId, link),
      remoteMembers: () => peerRemoteMembers(roster, hub.reader()),
      machines: () => peerMachines(roster, hub.reader()),
      // M5-04c: the origin is built below, after the core; a call before then is "not ready".
      remoteCommand: (target, cmd) => remoteCommandVia(later.origin, target, cmd),
      machineName: () => ownMachineName(roster, serverId, SERVER_NAME),
      // M5-02c: the host's side of call-ins (the runtime below owns it; until it exists a call-in is "not reachable").
      remoteTurn: (call) => later.callInHost ? later.callInHost.remoteTurn(call) : Promise.resolve({ kind: "failed", why: "its machine cannot take call-ins yet" }),
      fetch: createAppFetch({ roster, requester: () => later.fetchRequester }),
      pluginGrant: (name) => readPluginGrant(hub.reader(), serverId, name),
      pluginAsks: (name) => readPluginAsks(hub.reader(), serverId, name),
      botStore: (directory) => {
        const key = storeKeyOf(paths.dataDir, directory, ids.main);
        opened.set(key, directory);
        return stores.open(key, directory);
      },
    });
    coreEngine.bind(core);
    shell.onAttach(() => { void core.reloadPluginSecrets().catch((error) => log(`plugins: ${String((error as Error)?.message ?? error)}`)); });
    return { hub, live, exports, stores, opened, coreEngine, shell, utilityHost, pdfTextRunner, core, pendingBotWrites };
  }

  /**
   * The engine over the core, the content index and media jobs, the table feeds, uploads and the intent runtime (recovery at start),
   * and this server's summary rows.
   */
  private static async startRuntime(
    s: Pick<StartContext, "options" | "env" | "paths" | "log" | "later" | "store" | "serverId"
      | "roster" | "hub" | "live" | "exports" | "core" | "coreEngine" | "pdfTextRunner">,
  ) {
    const { options, env, paths, log, later, store, serverId, roster, hub, live, exports, core, coreEngine, pdfTextRunner } = s;
    const engine = new BotlingdEngine(coreEngine, { live, feed: (event) => { void exports.feed(event)?.catch?.(() => undefined); } });
    const content = new ContentService({
      store, dataDir: paths.dataDir, serverId, onCommitted: (streams: StreamId[]) => hub.committed(streams), audit: (text) => log(`content: ${text}`),
    });
    // M2 step 10: media jobs (posters, previews, thumbnails) for every content made ready; tools found on PATH.
    const media = new MediaJobs({
      store, dataDir: paths.dataDir, onCommitted: (streams: StreamId[]) => hub.committed(streams), audit: log,
      ...(options.packaged ? { packaged: true } : {}),
      ...(pdfTextRunner ? { pdfTextRunner } : {}),
    });
    content.attachMedia(media);
    // M3 step 7: the own table's feed (to peers and front ends) and the copies of peers' tables.
    const feeds = new TableFeeds({ reader: () => hub.reader(), ownStream: `srv:${serverId}`, log });
    // fu-callin-outbox review: a copy that fills after its session opened can make a host bot's server known with no roster
    // change; interrupted call-ins waiting for it are answered then (bound once the guest is attached, below).
    const peerTables = new PeerTables({ store, reader: () => hub.reader(), feeds, log, copyChanged: () => later.copyChanged() });
    // M2 step 12: uploads from pages (`content.put`), kept in <data>/uploads; a chat.send naming them waits for them.
    const uploads = new Uploads({ dir: join(paths.dataDir, "uploads"), log: (line) => log(line) });
    coreEngine.useUploads((id) => uploads.complete(id)?.path ?? null);
    const runtime = new IntentRuntime({
      store, engine, hub, live, log: (line) => log(line), authorize: slotAuthorize(authorizeRoster(roster, { plainWaiting: (botId, text) => core.peerMayIgnoreWaiting(botId, text) })), serverEvents: "all", mirrorBotUpdates: true, content, uploads,
      callHostTimers: callInTimers(env),
      callInCrash: callInCrash(env),
      // M5-14d / M5-18a: a grant changed. Peers and front ends get the row; the core decides again which program parts
      // may run and re-announces its list once (core.pluginGrantsChanged).
      pluginRowsChanged: () => {
        feeds.notify(feeds.ownStream);
        core.pluginGrantsChanged();
      },
      tapHooks: {
        eventSeen: (event) => {
          later.summary?.seen(event);
          if (event.type === "plugins.updated") void later.syncPlugins();
        },
        eventStored: (tx, event) => { later.summary?.stored(tx, event); later.pushTriggers?.stored(tx, event); },
      },
      // §11.3 audits (a floor that skipped slots after a restore, a slot conflict, a held slot dropped).
      audit: (_tx, event) => log(`audit: ${JSON.stringify(event)}`),
    });
    const pluginHashCache = new PluginHashCache({ dataRoot: join(paths.dataDir, "plugin-data") });
    const readInstalledPlugins = () => pluginHashCache.read(core.plugins.registry.plugins, log);
    const machineRow = (pluginsDigest: string | null) => ({
      name: SERVER_NAME,
      os: `${process.platform} ${osRelease()}`.slice(0, 100),
      versions: { botlingd: BOTLINGD_VERSION, node: process.versions.node },
      addresses: [],
      pluginsDigest,
    });
    const summary = new SummaryRows({
      scope: runtime.scope, engine, live, log, onWritten: () => feeds.notify(feeds.ownStream),
      machine: () => machineRow(pluginsDigestOf(readInstalledPlugins().filter((plugin) => plugin.name.length <= 64))),
    });
    later.summary = summary;
    const report = await runtime.start();
    log(`recovery: ${JSON.stringify(report)}`);
    return { engine, content, media, feeds, peerTables, uploads, runtime, pluginHashCache, readInstalledPlugins, machineRow, summary };
  }

  /**
   * Web Push for owned bots that need the user, and the summary rows reconciled with what the event tap stored.
   */
  private static async startPush(
    s: Pick<StartContext, "options" | "paths" | "log" | "later" | "roster" | "hub" | "runtime"
      | "engine" | "summary">,
  ) {
    const { options, paths, log, later, roster, hub, runtime, engine, summary } = s;
    const pushSender = new PushSender({
      dataDir: paths.dataDir,
      ownsBot: (botId) => engine.hasBot(botId),
      roster,
      log,
      ...(options.pushTransport ? { transport: options.pushTransport } : {}),
    });
    const deviceReadable = (member: string) => { const device = roster.device(member); return !!device && (device.scope ?? []).includes("read"); };
    const push = new PushTriggers({
      scope: runtime.scope,
      sender: pushSender,
      roster,
      canPushDevice: deviceReadable,
      reader: () => hub.reader(),
      botName: (botId) => engine.botView(botId)?.name ?? null,
      attachedDevices: () => later.attachedDevices(),
      ...(options.pushCoalesceMs !== undefined ? { coalesceMs: options.pushCoalesceMs } : {}),
      log,
    });
    later.pushTriggers = push;
    const summaries = summary;
    const reconciled = await runtime.scope.submit((tx) => { push.seed(tx); return summaries.reconcile(tx); });
    log(`summary rows: ${JSON.stringify({ ...reconciled, unknown: reconciled.unknown.length })}`);
    summaries.startPurging();
    return { push, deviceReadable };
  }

  /**
   * One `plugin:<name>` row per installed plugin, kept current (`later.syncPlugins`), and the 60 s poll that notices file changes.
   */
  private static async startPlugins(
    s: Pick<StartContext, "log" | "later" | "core" | "runtime" | "feeds" | "pendingBotWrites"
      | "pluginHashCache" | "readInstalledPlugins" | "machineRow">,
  ) {
    const { log, later, core, runtime, feeds, pendingBotWrites, pluginHashCache, readInstalledPlugins, machineRow } = s;
    // M5-13b/M5-13c: publish one plugin:<name> row per installed plugin (plus audit row for bot writes) and keep machine.pluginsDigest current.
    let lastPluginsSignature = "";
    let lastPluginsStatSignature: string | null = null;
    let pluginSyncQueue: Promise<void> = Promise.resolve();
    later.syncPlugins = (force = false) => {
      pluginSyncQueue = pluginSyncQueue.then(async () => {
        const botWrites = pendingBotWrites.size ? new Map(pendingBotWrites) : null;
        const statSig = pluginHashCache.statSignature(core.plugins.registry.plugins);
        if (!force && !botWrites && statSig !== null && statSig === lastPluginsStatSignature) return;
        const installed = readInstalledPlugins().map((plugin) => {
          const write = botWrites?.get(plugin.name);
          return write ? { ...plugin, author: "bot" as const, writtenBy: write } : plugin;
        });
        const signature = JSON.stringify(installed);
        if (!force && !botWrites && signature === lastPluginsSignature) {
          lastPluginsStatSignature = statSig;
          return;
        }
        await runtime.scope.submit((tx) => {
          const stream = ownTableStream(tx);
          let touched = false;
          const pluginResult = reconcilePluginRows(tx, stream, installed, Date.now(), { log, onWritten: () => { touched = true; } });
          const machineRev = putRow(tx, stream, "machine", machineRow(pluginResult.digest));
          if (touched) runtime.scope.afterCommit(() => core.pluginGrantsChanged());
          if (touched || machineRev != null) runtime.scope.afterCommit(() => feeds.notify(feeds.ownStream));
        });
        if (botWrites) {
          for (const [name, write] of botWrites) {
            if (pendingBotWrites.get(name) === write) pendingBotWrites.delete(name);
          }
        }
        lastPluginsSignature = signature;
        lastPluginsStatSignature = statSig;
      }).catch((error) => { log(`plugin rows: ${String((error as Error)?.message ?? error)}`); });
      return pluginSyncQueue;
    };
    await later.syncPlugins(true);
    // core/server.ts suppresses plugins.updated when only non-manifest plugin files change (codeHash changes without PluginsView changing), so also poll every 60 s using mtime/size stat signatures.
    const pluginTimer = setInterval(() => { void later.syncPlugins(); }, PLUGIN_POLL_MS);
    pluginTimer.unref?.();
    return { pluginTimer };
  }

  /**
   * Pins left by a crash are swept, files still preparing are hashed, the media jobs start and the 2.x exports are brought up to date.
   */
  private static async recoverContent(
    s: Pick<StartContext, "log" | "content" | "media" | "exports" | "opened">,
  ): Promise<void> {
    const { log, content, media, exports, opened } = s;
    // Step 13: pins left by a crash are swept and every file still preparing is hashed before front ends attach.
    const recovered = await content.recover();
    log(`content recovery: ${JSON.stringify(recovered)}`);
    const mediaStart = await media.start();
    log(`media jobs: ${JSON.stringify({ ...mediaStart, h264: media.tools.h264, found: Object.entries(media.tools.paths).filter(([, at]) => at).map(([name]) => name) })}`);
    for (const note of media.notes()) log(`media note: ${note}`);
    exports.start([...opened.entries()].map(([botId, directory]) => ({ botId, directory })));
  }

  /**
   * The relay setting and room, device pairing and server pairing (`botlingd join` / `add-machine`).
   */
  private static async startPairing(
    s: Pick<StartContext, "env" | "paths" | "log" | "later" | "roster" | "clusterSetup"
      | "identity" | "prefs">,
  ) {
    const { env, paths, log, later, roster, clusterSetup, identity, prefs } = s;
    const startedAt = Date.now();
    const origin = tailnetOrigin(env);
    // M2 step 13: the relay path (off unless `botlingd relay set` kept an address, or BOTLING_SERVER_RELAY_URL names a
    // relay): botlingd's own room, named in offers.
    const relaySetting = effectiveRelayUrl(env, paths.dataDir, log);
    const relayAt = relaySetting.url;
    if (relayAt) log(`relay: ${redact(relayAt)} (from ${relaySetting.source === "env" ? RELAY_URL_ENV : RELAY_SETTING_FILE})`);
    const relayRoom = relayAt ? await (async () => { const key = loadRelayRoomKey(join(paths.dataDir, RELAY_KEY_FILE)); return { url: relayAt, key, room: await relayRoomOf(key) }; })() : null;
    const relayAddress: RelayAddress | null = relayRoom ? { url: relayRoom.url, room: relayRoom.room } : null;
    const relayNow = (): RelayAddress | null => (later.daemon ? later.daemon.relayAddress : relayAddress);
    const pairing = new PairingService({
      roster, cluster: clusterSetup, identity, serverName: SERVER_NAME, log,
      // The relay in use now (Settings › Phone may switch it while botlingd runs: Botlingd.useRelay). Once the daemon
      // exists its address is the only truth: null there means off, never the address botlingd started with.
      addresses: () => pairingAddresses(origin, relayNow()),
      pageUrl: () => pairingPageUrl(origin, relayNow()?.url ?? null),
      addressNote: () => (origin || relayNow() ? null : "no tailnet address is set yet (BOTLING_SERVER_TAILNET_ORIGIN, once tailscale serve publishes this server), and no relay (botlingd relay set <url>), so the link names a placeholder."),
    });
    // M3 step 4: server pairing (`botlingd join` / `add-machine`), reached at the loopback listener's `/v3/ws`.
    const listenerPort = () => later.daemon?.listener?.port ?? null;
    const serverJoin = new ServerJoin({
      roster, identity, serverName: SERVER_NAME, version: BOTLINGD_VERSION, dataDir: paths.dataDir, log,
      ownAddresses: () => {
        const at = listenerPort();
        const portArg = at === null ? null : advertisedPort(env, at);
        const relay = relayNow();
        if (portArg === null && !relay) return null;
        return addressesValue(portArg, { tailnet: origin, relay });
      },
      joinAddresses: () => { const at = listenerPort(); return at === null ? [] : [`ws://${LISTEN_HOST}:${at}/v3/ws`]; },
      prefs,
    });
    return { startedAt, origin, relayRoom, relayAddress, pairing, serverJoin };
  }

  /**
   * Command forwarding to the servers that own a target, this server as its own command origin, and the host side of call-ins.
   */
  private static async startForwarding(
    s: Pick<StartContext, "log" | "later" | "store" | "roster" | "serverId" | "hub"
      | "engine" | "runtime" | "feeds" | "core">,
  ) {
    const { log, later, store, roster, serverId, hub, engine, runtime, feeds, core } = s;
    // M3 step 9: commands for targets a peer owns are queued and forwarded; a peer's forwarded commands for targets
    // this server owns go to the slot engine. A lone server has no peers: every target is its own, as before.
    // (`peers` is made below; these run only once sessions exist.)
    const peerIds = (): string[] => later.peers.states().map((state) => state.member);
    const directory: Directory = new Directory({ self: serverId, reader: () => hub.reader(), peers: peerIds, hasBot: (botId) => engine.hasBot(botId) });
    const forwarder: Forwarder = new Forwarder({
      self: serverId, submit: (command) => store.submit(command), reader: () => hub.reader(), directory, log,
      session: (peer): PeerSession | null => later.peers.session(peer),
      isRevoked: (peer) => !roster.view.valid.has(peer),
    });
    roster.onChange((change) => { void forwarder.revoked(change.invalidated); });
    // M5-04a: this server acting as its own command origin (call-ins, main bot); slot.origin is always roster.memberId.
    const serverOrigin = new ServerOrigin({
      self: roster.memberId, submit: (command) => store.submit(command), reader: () => hub.reader(), forwarder,
      isRevoked: (peer) => !roster.view.valid.has(peer),
      subscribeTable: (stream, sink) => feeds.subscribe(stream, null, sink), log,
    });
    later.origin = serverOrigin;
    roster.onChange((change) => { void serverOrigin.revoked(change.invalidated); });
    // M5-02c: the host's side asks through the same origin, and hears how each ask ended (a refused ask ends its wait at once).
    later.callInHost = runtime.callHost;
    // M5-03a (D51): a reply after the host gave up is appended marked late and wakes nobody.
    runtime.callHost.bindLate((late) => core.conversations.postLate(late));
    runtime.callHost.attach({
      self: roster.memberId, ownerOf: (target) => forwarder.ownerOf(target), submit: (target, cmd) => serverOrigin.submit(target, cmd),
      onOutcome: (listener) => serverOrigin.on(listener), outcome: (slot) => serverOrigin.outcome(slot),
      // The peer sessions' own bookkeeping (live / stale since the last frame / gone): the wait is a liveness wait.
      peerState: (server) => { const state = later.peers.states().find((entry) => entry.member === server); return state ? { state: state.state, since: state.since } : null; },
    });
    return { directory, forwarder, serverOrigin };
  }

  /**
   * The owner inbox, the pass-through of a peer's bot to a front end and the cache it fills, the CLI's plugin admin and Settings › Phone.
   */
  private static async startPassThrough(
    s: Pick<StartContext, "env" | "paths" | "log" | "later" | "store" | "serverId" | "hub"
      | "live" | "prefs" | "runtime" | "engine" | "directory" | "pairing">,
  ) {
    const { env, paths, log, later, store, serverId, hub, live, prefs, runtime, engine, directory, pairing } = s;
    const inbox = new OwnerInbox({ self: serverId, runtime, log });
    // M3 step 8: a front end's sub of a bot a peer owns passes through to that peer; this server caches what it relays.
    const passSettings = passThroughSettings(env);
    const followed = () => new Set(followedStreams(prefs.get("followedBots")?.value));
    // M3 step 10 (Q5): one budget for peers' logs and peers' content chunks, followed bots evicted last.
    const peerBudget = new PeerCacheBudget(Math.max(64 * 1024, passSettings.capBytes ?? PEER_CACHE_BYTES), log);
    const peerLogs: PeerLogCache = new PeerLogCache({
      store, reader: () => hub.reader(), log, priority: (stream) => passThrough.priority(stream), budget: peerBudget,
    });
    const passThrough: PassThrough = new PassThrough({
      cache: peerLogs, log, followed: (stream) => followed().has(stream),
      ownerOf: (stream) => directory.peerOwner(stream),
      session: (peer) => later.peers.session(peer),
      peerState: (peer) => { const state = later.peers.states().find((item) => item.member === peer); return state ? { state: state.state, since: state.since } : null; },
      ...(passSettings.keepMs !== undefined ? { keepMs: passSettings.keepMs } : {}),
    });
    prefs.onChange(() => passThrough.ensureFollowed([...followed()]));
    const passOwner = new PassThroughOwner({
      hub, log, live,
      ensureBotStream: async (botId) => {
        if (!engine.hasBot(botId)) return false;
        await store.submit((tx) => { ensureBot(tx, botId); });
        return true;
      },
    });
    const pluginAdmin = new PluginAdmin({ runtime, reader: () => hub.reader(), serverId });
    // Settings › Phone in the Botling 3 window: botlingd's own pairing and relay setting, never the 2.x core's (it has
    // neither). The relay goes on, off or elsewhere at once (useRelay), and stays so across restarts (relay.json).
    const phone = new PhoneDesk({
      pairing,
      relay: {
        view: () => relayShown(later.daemon?.relayAddress ?? null, later.daemon?.relay ?? null, env),
        set: async (url) => {
          await changeRelaySetting({
            env, dataDir: paths.dataDir, url,
            apply: async (clean) => { if (!later.daemon) throw new Error("botlingd is still starting; try again in a moment"); await later.daemon.useRelay(clean); },
          });
        },
      },
    });
    return { inbox, followed, peerBudget, peerLogs, passThrough, passOwner, pluginAdmin, phone };
  }

  /**
   * What a front end or a device reaches: the session host (admin ops, tables, forwarding, pass-through), the Unix socket server, content
   * tickets, peers' content, remote device sessions, and the fetch approval card.
   */
  private static async startSessions(
    s: Pick<StartContext, "options" | "env" | "paths" | "log" | "later" | "store" | "serverId"
      | "memberId" | "identity" | "roster" | "prefs" | "hub" | "live" | "runtime" | "engine" | "content" | "shell" | "uploads"
      | "core" | "startedAt" | "phone" | "pluginAdmin" | "pairing" | "serverJoin" | "feeds" | "directory" | "forwarder"
      | "passThrough" | "peerTables" | "peerBudget" | "followed" | "deviceReadable">,
  ) {
    const { options, env, paths, log, later, store, serverId, memberId, identity, roster, prefs, hub, live, runtime, engine, content,
      shell, uploads, core, startedAt, phone, pluginAdmin, pairing, serverJoin, feeds, directory, forwarder, passThrough, peerTables,
      peerBudget, followed, deviceReadable } = s;
    let localReads: LocalPeerReads | null = null;
    // M5-06c: the fetch approval card and grants (built with the fetch source below; the admin ops read it).
    let fetchApproval: FetchApproval | null = null;
    // M5-14c: the CLI's plugin list and grant (a local-window `plugin.grant` through the intent runtime).
    const sessionHost: SessionHost = {
      serverId, serverName: SERVER_NAME, startedAt, minFeVersion: MIN_FE_VERSION,
      token: () => later.daemon?.token ?? "",
      hub, live, runtime, engine, content, shell, uploads,
      nextFor: (origin, originEpoch) => {
        const next: Record<string, number> = {};
        for (const row of hub.reader().prepare("SELECT target, next FROM slots WHERE origin = ? AND originEpoch = ?").all(origin, originEpoch)) next[String(row.target)] = Number(row.next);
        return next;
      },
      ensureBotStream: async (botId) => {
        if (!engine.hasBot(botId)) return false;
        await store.submit((tx) => { ensureBot(tx, botId); });
        return true;
      },
      log,
      phone,
      admin: {
        handle: async (op, session) => {
          if (op.op === "prefs.set") {
            // M5-04i: only a server this one holds valid can be designated (the CLI and every window are told why not).
            if (op.key === "designatedServer" && designatedServer(roster.view, op.value) !== op.value) {
              throw new Error(`${JSON.stringify(op.value)?.slice(0, 80) ?? "undefined"} is not a server of this cluster that can run the main bot (unknown, revoked or not valid)`);
            }
            return { row: await prefs.set(op.key, op.value) };
          }
          if (op.op === "prefs.list") return { rows: prefs.rows() };
          if (op.op === "fetch.grants" || op.op === "fetch.revoke") {
            if (!fetchApproval) throw new Error("fetch is not ready yet");
            return op.op === "fetch.grants" ? { rows: fetchApproval.grants() } : { revoked: await fetchApproval.revoke(op.grantId) };
          }
          if (op.op === "plugins.list" || op.op === "plugins.grant") return pluginAdmin.handle(op);
          if (op.op === "machine.removePreview" || op.op === "machine.remove") return pairing.admin(op, session);
          return op.op.startsWith("join.") || op.op.startsWith("machine.") ? serverJoin.admin(op, session) : pairing.admin(op, session);
        },
        onEvent: (listener) => { const a = pairing.onEvent(listener); const b = serverJoin.onEvent(listener); return () => { a(); b(); }; },
        sessionClosed: (session) => { serverJoin.adminClosed(session); pairing.adminClosed(session); },
      },
      // M3 step 7: peers' states (`welcome.servers`, `peer{…}`) and their tables, from this server's copies.
      // (`peers` is made below; no session opens before the listeners start.)
      tables: {
        peers: () => later.peers.states().map((state) => ({ id: state.member, name: state.name.slice(0, 200) || state.member, state: state.state, since: state.since })),
        onPeer: (listener) => later.peers.onState((state) => listener({ id: state.member, state: state.state, since: state.since })),
        // Only a server this roster names as a peer (a lone server serves srv: streams from its log hub as before).
        isPeerTable: (stream) => peerTables.isPeerTable(stream) && later.peers.states().some((state) => `srv:${state.member}` === stream),
        isOwnTable: (stream) => stream === feeds.ownStream,
        subscribe: (stream, cursor, sink) => feeds.subscribe(stream, cursor, sink),
      },
      forward: {
        ownerOf: (target) => forwarder.ownerOf(target),
        commit: (envelope, owner) => forwarder.commit(envelope, owner),
        cancel: (slot, owner) => forwarder.cancel(slot, owner),
        attach: (origin, sink) => forwarder.attach(origin, sink),
      },
      passThrough: {
        isPeerStream: (stream) => passThrough.isPeerStream(stream),
        open: (stream, cursor, sink, live) => passThrough.open(stream, cursor, sink, live ?? null),
        history: (request, sink) => passThrough.history(request, sink),
      },
      peerReads: () => localReads,
      peerLocate: (m) => peerContent.locate(LOCAL_WINDOW, m),
      vapidKey: () => { const rec = readVapidKeyRecord(paths.dataDir); return rec ? { publicKey: rec.keys.publicKey, id: { gen: rec.gen, id: rec.id } } : null; },
    };
    const server = new SessionServer(paths.socket, sessionHost, options.session);
    // M2 step 4: paired devices' encrypted sessions (the transports come with steps 6 and 13).
    // M2 step 9: content over the tailnet (URL tickets in memory; a device that leaves the roster loses its tickets).
    const tickets = new ContentTickets();
    roster.onChange((change) => { for (const member of change.invalidated) tickets.dropDevice(member); });
    // M3 step 10: content owned by a peer, passed through and verified per chunk; this server's content read by peers.
    const chunkCache: ChunkCache = new ChunkCache({
      store, reader: () => hub.reader(), dataDir: paths.dataDir, budget: peerBudget, log,
      priority: (key, stream) => peerContent.priority(key, stream),
    });
    const peerContent: PeerContent = new PeerContent({
      self: serverId, store, reader: () => hub.reader(), cache: chunkCache, log,
      session: (owner) => later.peers.session(owner),
      ownerOf: (stream) => directory.peerOwner(stream),
      readable: deviceReadable,
      followed: (stream) => followed().has(stream),
    });
    localReads = new LocalPeerReads({ peer: peerContent, self: serverId, log });
    later.pluginRead = new PluginContentRead({ serverId, service: content, peer: peerContent, roster });
    const peerContentOwner = new PeerContentOwner({ service: content, roster, log, corruptId: testCorruptContent(env) });
    roster.onChange((change) => { for (const member of change.invalidated) peerContent.dropDevice(member); });
    const remoteContent = new RemoteContent({ service: content, tickets, roster, reader: () => hub.reader(), log, peer: peerContent });
    const vapidState: VapidSyncState = { known: false, warnedMissing: false };
    if (roster.clusterId) {
      await ensureSoleServerVapidKeys(paths.dataDir, roster, log, vapidState).catch((error) => {
        log(`vapid: ${String((error as Error)?.message ?? error)}`);
      });
    }
    roster.onChange(() => {
      if (!roster.clusterId || vapidState.known) return;
      void ensureSoleServerVapidKeys(paths.dataDir, roster, log, vapidState).catch((error) => {
        log(`vapid: ${String((error as Error)?.message ?? error)}`);
      });
    });
    const remote = new RemoteSessions({ ...sessionHost, peerReads: undefined, peerLocate: undefined, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing, remoteContent, deviceContent: peerContentOwner }, options.session);
    later.attachedDevices = () => attachedDeviceIds(remote.open);
    // M5-06c: a fetch that asks puts a card into the Maintainer's chat; asks left open by the last run are `gone`.
    const approval = new FetchApproval({
      core, store, reader: () => hub.reader(), self: serverId, names: clusterNames(roster, () => hub.reader()), log,
    });
    await approval.recover();
    fetchApproval = approval;
    return { server, chunkCache, peerContent, peerContentOwner, remoteContent, remote, approval };
  }

  /**
   * On-demand fetch between servers: the source side, the requester side, and the staging folders a killed process left behind.
   */
  private static async startFetch(
    s: Pick<StartContext, "paths" | "log" | "later" | "store" | "serverId" | "hub" | "roster"
      | "content" | "engine" | "feeds" | "approval">,
  ) {
    const { paths, log, later, store, serverId, hub, roster, content, engine, feeds, approval } = s;
    // M5-07a: source side of on-demand fetch between servers.
    const fetchSource = new FetchSource({
      self: serverId,
      dataDir: paths.dataDir,
      store,
      reader: () => hub.reader(),
      roster,
      content,
      botFolders: () => {
        const map = new Map<string, string>();
        for (const botId of engine.bots()) {
          const folder = engine.botView(botId)?.folder;
          if (folder) map.set(botId, folder);
        }
        return map;
      },
      ask: approval.ask,
      gone: (fetchId) => approval.gone(fetchId),
      onAudit: () => feeds.notify(feeds.ownStream),
      log,
    });
    // M5-07b: requester side of on-demand fetch (`peers` is made below; no session exists before it starts).
    const fetchRequester = new FetchRequester({
      store,
      session: (member) => later.peers.session(member),
      botFolder: (botId) => engine.botView(botId)?.folder ?? null,
      serverName: (member) => later.peers.states().find((state) => state.member === member)?.name || null,
      onAudit: () => feeds.notify(feeds.ownStream),
      log,
    });
    // Staging folders of a fetch that a killed process never finished are removed now, before any session exists.
    try {
      const folders: string[] = [];
      for (const botId of engine.bots()) { const folder = engine.botView(botId)?.folder; if (folder) folders.push(folder); }
      const removed = fetchRequester.removeLeftoverStaging(folders);
      if (removed > 0) log(`fetch: removed ${removed} unfinished staging folder(s) left by an earlier run`);
    } catch (error) { log(`fetch: leftover staging cleanup failed: ${JSON.stringify(String((error as Error)?.message ?? error).slice(0, 200))}`); }
    later.fetchRequester = fetchRequester;
    return { fetchSource, fetchRequester };
  }

  /**
   * Cluster VAPID key distribution and the peer sessions (a lone server has no server in its roster, so it dials nothing), with the
   * handlers of every frame a peer sends.
   */
  private static async startPeers(
    s: Pick<StartContext, "paths" | "log" | "later" | "identity" | "memberId" | "roster"
      | "timers" | "gossip" | "feeds" | "peerTables" | "forwarder" | "inbox" | "followed" | "passThrough" | "passOwner"
      | "peerContent" | "peerContentOwner" | "fetchSource" | "fetchRequester">,
  ) {
    const { paths, log, later, identity, memberId, roster, timers, gossip, feeds, peerTables, forwarder, inbox, followed,
      passThrough, passOwner, peerContent, peerContentOwner, fetchSource, fetchRequester } = s;
    // M4-26: cluster VAPID key rotation on server revocation & encrypted distribution to valid servers.
    const vapidSync = new VapidKeySync({ dataDir: paths.dataDir, roster, sessions: () => later.peers.all, log });
    // M3 step 3: peer servers. A lone server has no server in its roster, so it dials nothing.
    const peers = new PeerSessions({
      roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, timers, log,
      // M3 step 7: every peer's srv: table is subscribed while its session is open (§10.1).
      // M3 step 5: gossip frames first (roster sync is the first exchange, §4.6), then the tables.
      // M3 step 9: forwarded commands (owner side) and the owners' answers (forwarding side).
      // M3 step 8: forwarded front-end subscriptions (owner side) and the frames that answer them (attached side).
      // M3 step 10: content gets and their answers (bulk lane), both sides.
      onMessage: async (session, message) => (await gossip.onMessage(session, message)) || vapidSync.onMessage(session, message) || peerContent.onMessage(session, message) || peerContentOwner.onMessage(session, message) || fetchSource.onMessage(session, message) || fetchRequester.onMessage(session, message)
        || inbox.onMessage(session, message) || (await forwarder.onMessage(session, message))
        || passThrough.onMessage(session, message) || (await passOwner.onMessage(session, message)) || peerTables.onMessage(session, message),
      sessionOpened: (session) => { gossip.opened(session); vapidSync.sessionOpened(session); fetchRequester.sessionOpened(session); void peerTables.opened(session); forwarder.opened(session); passThrough.sessionOpened(session); passThrough.ensureFollowed([...followed()]); },
      sessionClosed: (session) => { gossip.closed(session); peerTables.sessionClosed(session); forwarder.closed(session); inbox.closed(session); passThrough.sessionClosed(session); passOwner.sessionClosed(session); peerContent.sessionClosed(session); peerContentOwner.sessionClosed(session); fetchSource.sessionClosed(session); fetchRequester.sessionClosed(session); },
    }, { stateFile: join(paths.dataDir, PEERS_FILE) });
    later.peers = peers;
    later.peerSessions = peers;
    peers.onState((state) => { void peerTables.peerState(state.member, state.state, state.since); passThrough.peerStateChanged(state.member, state.state, state.since); });
    feeds.start();
    gossip.start();
    return { vapidSync, peers };
  }

  /**
   * The `Botlingd` itself, with what the phases made: the token, the relay room maker, the chat mirror, the origin test hook.
   */
  private static async assembleDaemon(
    s: Pick<StartContext, "env" | "paths" | "log" | "later" | "lock" | "store" | "serverId"
      | "identity" | "roster" | "clusterSetup" | "hub" | "live" | "exports" | "stores" | "core" | "runtime" | "content" | "shell"
      | "server" | "remote" | "pairing" | "summary" | "push" | "peers" | "serverJoin" | "feeds" | "peerTables" | "passThrough"
      | "peerLogs" | "passOwner" | "remoteContent" | "peerContent" | "peerContentOwner" | "chunkCache" | "serverOrigin"
      | "fetchSource" | "fetchRequester" | "vapidSync" | "media" | "pluginTimer" | "utilityHost" | "origin" | "relayAddress"
      | "relayRoom">,
  ): Promise<Botlingd> {
    const { env, paths, log, later, lock, store, serverId, identity, roster, clusterSetup, hub, live, exports, stores, core, runtime,
      content, shell, server, remote, pairing, summary, push, peers, serverJoin, feeds, peerTables, passThrough, peerLogs, passOwner,
      remoteContent, peerContent, peerContentOwner, chunkCache, serverOrigin, fetchSource, fetchRequester, vapidSync, media,
      pluginTimer, utilityHost, origin, relayAddress, relayRoom } = s;
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

  /**
   * Goes live: the Unix socket, the loopback listener, the relay room, the peer sessions, the call-in answers, the lock watch and the daily backups.
   */
  private static async listenAll(
    s: Pick<StartContext, "options" | "env" | "paths" | "log" | "port" | "origin" | "later"
      | "store" | "hub" | "core" | "runtime" | "roster" | "server" | "peers" | "vapidSync" | "forwarder" | "serverOrigin" | "daemon">,
  ): Promise<void> {
    const { options, env, paths, log, port, origin, later, store, hub, core, runtime, roster, server, peers, vapidSync, forwarder,
      serverOrigin, daemon } = s;
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
    const schedule = backupCheckMs(env);
    if (schedule) {
      daemon.backups = new DailyBackups({ backupsDir: store.backupsDir, take: () => store.backup("daily"), log, ...schedule });
      daemon.backups.start();
    } else log("daily backups are off (BOTLING_SERVER_BACKUP_CHECK_MS=0)");
    for (const note of serverNotes(paths.dataDir, hub.reader())) log(`note (${note.id}): ${note.text}`);
    log(`started: server ${serverId}, data ${paths.dataDir}, ${core.botIds().length} bots, pid ${process.pid}`);
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
    if (this.pluginTimer) clearInterval(this.pluginTimer);
    const failures: unknown[] = [];
    const step = async (what: string, run: () => unknown) => {
      try { await run(); } catch (error) { failures.push(error); this.log(`stop: ${what}: ${String((error as Error)?.message ?? error)}`); }
    };
    await step("daily backups", () => this.backups?.stop());
    await step("sessions", () => this.server.close());
    await step("pairing", () => this.pairing.close());
    await step("server pairing", () => this.join.close());
    await step("remote sessions", () => this.remote.close());
    await step("relay", () => this.relay?.closeAfterDrain(1_000));
    this.vapidSync?.close();
    await step("peer sessions", () => this.peers.close());
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
    await step("listener", () => this.listener?.close());
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
