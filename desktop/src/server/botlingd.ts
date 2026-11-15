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
import { fromBase64Url, type StreamId } from "../protocol";
import { backupCheckMs, DailyBackups } from "./backup-schedule";
import { BotlingdEngine } from "./botlingd-engine";
import { DbBotStores } from "./botstore";
import { ContentService } from "./content";
import { ChunkCache, PeerCacheBudget } from "./content/chunk-cache";
import { LocalPeerReads } from "./content/local-peer-read";
import { LOCAL_WINDOW, PeerContent, PeerContentOwner } from "./content/peer-content";
import { PluginContentRead } from "./content/plugin-read";
import { RemoteContent } from "./content/remote";
import { Uploads } from "./content/put";
import { ContentTickets } from "./content/tickets";
import { MediaJobs } from "./media";
import { effectCheckpointSink, ensureBot } from "./effects";
import { BotExports } from "./exports";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { serverNotes } from "./notes";
import { botlingdPaths, refuse2xData, RemoteSessions, SessionServer, slotAuthorize, writeToken, type BotlingdPaths, type SessionHost, type SessionOptions } from "./session";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "./identity";
import { Gossip, PrefsStore, RosterStore, type RosterView } from "./roster";
import { defaultPageDir, LISTEN_FILE, LISTEN_HOST, listenPort, loadRelayRoomKey, LoopbackListener, RELAY_KEY_FILE, relayConnectOrigin, RelayConnector, relayTestOptions, relayUrl } from "./net";
import { relayDeviceToken, relayPairToken, relayRoomOf, relayTokenHash } from "../session";
import { PairingService, ServerJoin } from "./pairing";
import { addressesValue, advertisedPort, peerAddresses, PeerSessions, peerTimers, SessionRouter, type PeerSession, type RelayAddress } from "./peer";
import { ShellBridge } from "./shell-bridge";
import { openServerStore, type ServerStore } from "./store";
import { followedStreams, ownTableStream, PassThrough, PassThroughOwner, passThroughSettings, PEER_CACHE_BYTES, PeerLogCache, PeerTables, putRow, SummaryRows, TableFeeds } from "./replica";
import { installedFromRegistry, pluginsDigestOf, reconcilePluginRows } from "./replica/plugin-rows";
import { Directory, Forwarder, OwnerInbox } from "./forward";
import { release as osRelease } from "node:os";

/** Where a pairing link points while no tailnet origin is set (BOTLING_SERVER_TAILNET_ORIGIN; `tailscale serve`, step 6). */
export const PLACEHOLDER_TAILNET_ORIGIN = "https://tailnet-name.invalid";

/** The https origin a device reaches this server at over the tailnet (set by the user once `tailscale serve` runs), or null. */
export function tailnetOrigin(env: Record<string, string | undefined>): string | null {
  const value = (env.BOTLING_SERVER_TAILNET_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * D71: exact origins for the page's `connect-src` (`wss://` tailnet origins of valid cluster servers and the relay)
 * and for `/v3/ws` (`https://` tailnet origins of valid cluster servers, own tailnet origin, and the relay HTTP origin).
 */
export function clusterOrigins(
  roster: Pick<RosterStore, "view" | "profile">,
  ownTailnetOrigin: string | null,
  relayUrlValue: string | null,
): { origins: string[]; connectOrigins: string[] } {
  const origins = new Set<string>();
  const connectOrigins = new Set<string>();
  if (ownTailnetOrigin) origins.add(ownTailnetOrigin);
  if (relayUrlValue) {
    connectOrigins.add(relayConnectOrigin(relayUrlValue));
    const parsed = new URL(relayUrlValue);
    origins.add(`${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`);
  }
  const view = roster.view;
  for (const member of view.valid) {
    if (!view.servers.has(member)) continue;
    const tailnet = peerAddresses(roster.profile(member, "addresses")).tailnet;
    if (!tailnet) continue;
    const host = new URL(tailnet).host;
    origins.add(`https://${host}`);
    connectOrigins.add(`wss://${host}`);
  }
  return { origins: [...origins].sort(), connectOrigins: [...connectOrigins].sort() };
}

/** The oldest Botling 3 window this server serves (fe-link compares it without the -suffix). */
export const MIN_FE_VERSION = "3.0.0-m1";
/** How `welcome.servers` names this server (M1: one server, this Mac). */
export const SERVER_NAME = "This Mac";
export const BOTLINGD_VERSION = "3.0.0-m1";
/** Each peer server's state (`botlingd.peers.json`, 0600), rewritten on every change, removed on stop (M3 step 3). */
export const PEERS_FILE = "botlingd.peers.json";

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

/**
 * The relay room's allow list (protocol v1 §6.3, §4.6, M4-16a): join tokens for pending pairing offers, valid devices,
 * and valid peer servers ≠ self (each member token derived via static X25519 and cached by member + DH key).
 */
export function relayAllowList(options: {
  roster: { readonly view: RosterView };
  identity: { readonly dhKey: CryptoKey };
  pairing: { relayOffers(): Array<{ offer: string; secret: Uint8Array; expiresAt: number }> };
}): () => Promise<Array<{ h: string; exp?: number }>> {
  const memberTokens = new Map<string, string>();
  return async () => {
    const view = options.roster.view;
    const offers = options.pairing.relayOffers().map((offer) => ({ ...offer, secret: new Uint8Array(offer.secret) }));
    const tokens: Array<{ h: string; exp?: number }> = [];
    for (const offer of offers) {
      tokens.push({ h: await relayTokenHash(await relayPairToken(offer.offer, offer.secret)), exp: offer.expiresAt });
      offer.secret.fill(0);
    }
    for (const member of view.valid) {
      if (member === view.self) continue;
      const info = view.members.get(member);
      const dhPub = info ? fromBase64Url(info.keys.dh) : null;
      if (!info || !dhPub) continue;
      const key = `${member} ${info.keys.dh}`;
      let hash = memberTokens.get(key);
      if (!hash) {
        try { hash = await relayTokenHash(await relayDeviceToken(member, options.identity.dhKey, dhPub)); } catch { continue; }
        memberTokens.set(key, hash);
      }
      tokens.push({ h: hash });
    }
    return tokens;
  };
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
  /** M2 step 10: the media jobs (variants). */
  media: MediaJobs | null = null;
  /** M3 step 10: peers' content read through this server (attached side), and this server's content read by peers. */
  peerContent: PeerContent | null = null;
  peerContentOwner: PeerContentOwner | null = null;
  chunkCache: ChunkCache | null = null;

  get token(): string { return this.tokenValue; }

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

    let store: ServerStore | null = null;
    try {
      store = await openServerStore(paths.dataDir);
      // M2: the server's keys (made on the first start, server-keys.json 0600) and server.db bound to them before
      // anything reads meta.serverId (a fresh data folder is named by its member id, v1 §3).
      const identity = await loadOrCreateServerIdentity(paths.dataDir, { create: store.meta("memberId") === undefined });
      const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
      const roster = await RosterStore.open(store, identity, { log });
      const clusterSetup = new ClusterSetup(roster);
      // M3 step 5: cluster preferences (LWW per key) and the gossip of statements and preferences between servers.
      const prefs = await PrefsStore.open(store, { self: memberId, knownWriter: (writer) => roster.view.servers.has(writer), log });
      const gossip = new Gossip({ roster, prefs, log });
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
      let pluginRead: PluginContentRead | null = null;
      const core = new Core({
        ...coreProcessOptions({
          env: env as NodeJS.ProcessEnv, dataDir: paths.dataDir, outDir: options.outDir, emit, log: (line) => log(`core: ${line}`),
          node: plainHostNode(env as NodeJS.ProcessEnv), sealer: noSafeStorage, app: shell.appBridge(),
        }),
        deferTurn,
        content: {
          read: async (ref, offset, length) => {
            if (!pluginRead) throw new Error("The machine that has this file is not reachable.");
            return pluginRead.read(ref, offset, length);
          },
          fetch: async (storageDir, ref) => {
            if (!pluginRead) throw new Error("The machine that has this file is not reachable.");
            return pluginRead.fetch(storageDir, ref);
          },
        },
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
      // M2 step 10: media jobs (posters, previews, thumbnails) for every content made ready; tools found on PATH.
      const media = new MediaJobs({ store, dataDir: paths.dataDir, onCommitted: (streams: StreamId[]) => hub.committed(streams), audit: log });
      content.attachMedia(media);
      // M3 step 7: the own table's feed (to peers and front ends) and the copies of peers' tables.
      const feeds = new TableFeeds({ reader: () => hub.reader(), ownStream: `srv:${serverId}`, log });
      const peerTables = new PeerTables({ store, reader: () => hub.reader(), feeds, log });
      // M3 step 6: the server's own summary rows in its srv: table (written from what the event tap stores).
      let summary: SummaryRows | null = null;
      let syncPlugins: (force?: boolean) => Promise<void> = async () => undefined;
      // M2 step 12: uploads from pages (`content.put`), kept in <data>/uploads; a chat.send naming them waits for them.
      const uploads = new Uploads({ dir: join(paths.dataDir, "uploads"), log: (line) => log(line) });
      coreEngine.useUploads((id) => uploads.complete(id)?.path ?? null);
      const runtime = new IntentRuntime({
        store, engine, hub, live, log: (line) => log(line), authorize: slotAuthorize({
          memberId: roster.memberId,
          device: (member) => roster.device(member),
          server: (member) => { const view = roster.view; return member !== view.self && view.servers.has(member) && view.valid.has(member); },
        }), serverEvents: "all", mirrorBotUpdates: true, content, uploads,
        tapHooks: {
          eventSeen: (event) => {
            summary?.seen(event);
            if (event.type === "plugins.updated") void syncPlugins();
          },
          eventStored: (tx, event) => summary?.stored(tx, event),
        },
        // §11.3 audits (a floor that skipped slots after a restore, a slot conflict, a held slot dropped).
        audit: (_tx, event) => log(`audit: ${JSON.stringify(event)}`),
      });
      const readInstalledPlugins = () => installedFromRegistry(core.plugins.registry.plugins, log);
      const machineRow = (pluginsDigest: string | null) => ({
        name: SERVER_NAME,
        os: `${process.platform} ${osRelease()}`.slice(0, 100),
        versions: { botlingd: BOTLINGD_VERSION, node: process.versions.node },
        addresses: [],
        pluginsDigest,
      });
      summary = new SummaryRows({
        scope: runtime.scope, engine, live, log, onWritten: () => feeds.notify(feeds.ownStream),
        machine: () => machineRow(pluginsDigestOf(readInstalledPlugins().filter((plugin) => plugin.name.length <= 64))),
      });
      const report = await runtime.start();
      log(`recovery: ${JSON.stringify(report)}`);
      const summaries = summary;
      const reconciled = await runtime.scope.submit((tx) => summaries.reconcile(tx));
      log(`summary rows: ${JSON.stringify({ ...reconciled, unknown: reconciled.unknown.length })}`);
      summaries.startPurging();
      // M5-13b: publish one plugin:<name> row per installed plugin and keep machine.pluginsDigest current.
      let lastPluginsSignature = "";
      let pluginSyncQueue: Promise<void> = Promise.resolve();
      syncPlugins = (force = false) => {
        pluginSyncQueue = pluginSyncQueue.then(async () => {
          const installed = readInstalledPlugins();
          const signature = JSON.stringify(installed);
          if (!force && signature === lastPluginsSignature) return;
          await runtime.scope.submit((tx) => {
            const stream = ownTableStream(tx);
            let touched = false;
            const pluginResult = reconcilePluginRows(tx, stream, installed, Date.now(), { log, onWritten: () => { touched = true; } });
            const machineRev = putRow(tx, stream, "machine", machineRow(pluginResult.digest));
            if (touched || machineRev != null) runtime.scope.afterCommit(() => feeds.notify(feeds.ownStream));
          });
          lastPluginsSignature = signature;
        }).catch((error) => { log(`plugin rows: ${String((error as Error)?.message ?? error)}`); });
        return pluginSyncQueue;
      };
      await syncPlugins(true);
      // core/server.ts suppresses plugins.updated when only non-manifest plugin files change (codeHash changes without PluginsView changing), so also poll every 5 s.
      const pluginTimer = setInterval(() => { void syncPlugins(); }, 5_000);
      pluginTimer.unref?.();
      // Step 13: pins left by a crash are swept and every file still preparing is hashed before front ends attach.
      const recovered = await content.recover();
      log(`content recovery: ${JSON.stringify(recovered)}`);
      const mediaStart = await media.start();
      log(`media jobs: ${JSON.stringify({ ...mediaStart, h264: media.tools.h264, found: Object.entries(media.tools.paths).filter(([, at]) => at).map(([name]) => name) })}`);
      for (const note of media.notes()) log(`media note: ${note}`);
      exports.start([...opened.entries()].map(([botId, directory]) => ({ botId, directory })));

      const startedAt = Date.now();
      let daemon: Botlingd | null = null;
      const origin = tailnetOrigin(env);
      // M2 step 13: the relay path (off unless BOTLING_SERVER_RELAY_URL names a relay): botlingd's own room, named in offers.
      const relayAt = relayUrl(env);
      const relayRoom = relayAt ? await (async () => { const key = loadRelayRoomKey(join(paths.dataDir, RELAY_KEY_FILE)); return { url: relayAt, key, room: await relayRoomOf(key) }; })() : null;
      const relayAddress: RelayAddress | null = relayRoom ? { url: relayRoom.url, room: relayRoom.room } : null;
      const pairing = new PairingService({
        roster, cluster: clusterSetup, identity, serverName: SERVER_NAME, log,
        addresses: () => ({ tailnet: origin ?? PLACEHOLDER_TAILNET_ORIGIN, ...(relayAddress ? { relay: relayAddress } : {}) }),
        pageUrl: () => `${origin ?? PLACEHOLDER_TAILNET_ORIGIN}/v3/`,
        addressNote: () => (origin ? null : "no tailnet address is set yet (BOTLING_SERVER_TAILNET_ORIGIN, once tailscale serve publishes this server), so the link names a placeholder."),
      });
      // M3 step 4: server pairing (`botlingd join` / `add-machine`), reached at the loopback listener's `/v3/ws`.
      const listenerPort = () => daemon?.listener?.port ?? null;
      const serverJoin = new ServerJoin({
        roster, identity, serverName: SERVER_NAME, version: BOTLINGD_VERSION, dataDir: paths.dataDir, log,
        ownAddresses: () => {
          const at = listenerPort();
          const portArg = at === null ? null : advertisedPort(env, at);
          if (portArg === null && !relayAddress) return null;
          return addressesValue(portArg, { tailnet: origin, relay: relayAddress });
        },
        joinAddresses: () => { const at = listenerPort(); return at === null ? [] : [`ws://${LISTEN_HOST}:${at}/v3/ws`]; },
        prefs,
      });
      // M3 step 9: commands for targets a peer owns are queued and forwarded; a peer's forwarded commands for targets
      // this server owns go to the slot engine. A lone server has no peers: every target is its own, as before.
      // (`peers` is made below; these run only once sessions exist.)
      const peerIds = (): string[] => peers.states().map((state) => state.member);
      const directory: Directory = new Directory({ self: serverId, reader: () => hub.reader(), peers: peerIds, hasBot: (botId) => engine.hasBot(botId) });
      const forwarder: Forwarder = new Forwarder({
        self: serverId, submit: (command) => openStore.submit(command), reader: () => hub.reader(), directory, log,
        session: (peer): PeerSession | null => peers.session(peer),
        isRevoked: (peer) => !roster.view.valid.has(peer),
      });
      roster.onChange((change) => { void forwarder.revoked(change.invalidated); });
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
        session: (peer) => peers.session(peer),
        peerState: (peer) => { const state = peers.states().find((item) => item.member === peer); return state ? { state: state.state, since: state.since } : null; },
        ...(passSettings.keepMs !== undefined ? { keepMs: passSettings.keepMs } : {}),
      });
      prefs.onChange(() => passThrough.ensureFollowed([...followed()]));
      const passOwner = new PassThroughOwner({
        hub, log, live,
        ensureBotStream: async (botId) => {
          if (!engine.hasBot(botId)) return false;
          await openStore.submit((tx) => { ensureBot(tx, botId); });
          return true;
        },
      });
      let localReads: LocalPeerReads | null = null;
      const sessionHost: SessionHost = {
        serverId, serverName: SERVER_NAME, startedAt, minFeVersion: MIN_FE_VERSION,
        token: () => daemon?.token ?? "",
        hub, live, runtime, engine, content, shell, uploads,
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
        admin: {
          handle: async (op, session) => {
            if (op.op === "prefs.set") return { row: await prefs.set(op.key, op.value) };
            if (op.op === "prefs.list") return { rows: prefs.rows() };
            if (op.op === "machine.removePreview" || op.op === "machine.remove") return pairing.admin(op, session);
            return op.op.startsWith("join.") || op.op.startsWith("machine.") ? serverJoin.admin(op, session) : pairing.admin(op, session);
          },
          onEvent: (listener) => { const a = pairing.onEvent(listener); const b = serverJoin.onEvent(listener); return () => { a(); b(); }; },
          sessionClosed: (session) => { serverJoin.adminClosed(session); pairing.adminClosed(session); },
        },
        // M3 step 7: peers' states (`welcome.servers`, `peer{…}`) and their tables, from this server's copies.
        // (`peers` is made below; no session opens before the listeners start.)
        tables: {
          peers: () => peers.states().map((state) => ({ id: state.member, name: state.name.slice(0, 200) || state.member, state: state.state, since: state.since })),
          onPeer: (listener) => peers.onState((state) => listener({ id: state.member, state: state.state, since: state.since })),
          // Only a server this roster names as a peer (a lone server serves srv: streams from its log hub as before).
          isPeerTable: (stream) => peerTables.isPeerTable(stream) && peers.states().some((state) => `srv:${state.member}` === stream),
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
      };
      const server = new SessionServer(paths.socket, sessionHost, options.session);
      // M2 step 4: paired devices' encrypted sessions (the transports come with steps 6 and 13).
      // M2 step 9: content over the tailnet (URL tickets in memory; a device that leaves the roster loses its tickets).
      const tickets = new ContentTickets();
      roster.onChange((change) => { for (const member of change.invalidated) tickets.dropDevice(member); });
      // M3 step 10: content owned by a peer, passed through and verified per chunk; this server's content read by peers.
      const deviceReadable = (member: string) => { const device = roster.device(member); return !!device && (device.scope ?? []).includes("read"); };
      const chunkCache: ChunkCache = new ChunkCache({
        store, reader: () => hub.reader(), dataDir: paths.dataDir, budget: peerBudget, log,
        priority: (key, stream) => peerContent.priority(key, stream),
      });
      const peerContent: PeerContent = new PeerContent({
        self: serverId, store, reader: () => hub.reader(), cache: chunkCache, log,
        session: (owner) => peers.session(owner),
        ownerOf: (stream) => directory.peerOwner(stream),
        readable: deviceReadable,
        followed: (stream) => followed().has(stream),
      });
      localReads = new LocalPeerReads({ peer: peerContent, self: serverId, log });
      pluginRead = new PluginContentRead({ serverId, service: content, peer: peerContent, roster });
      const peerContentOwner = new PeerContentOwner({ service: content, roster, log, corruptId: testCorruptContent(env) });
      roster.onChange((change) => { for (const member of change.invalidated) peerContent.dropDevice(member); });
      const remoteContent = new RemoteContent({ service: content, tickets, roster, log, peer: peerContent });
      const remote = new RemoteSessions({ ...sessionHost, peerReads: undefined, peerLocate: undefined, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing, remoteContent, deviceContent: peerContentOwner }, options.session);
      // M3 step 3: peer servers. A lone server has no server in its roster, so it dials nothing.
      const peers: PeerSessions = new PeerSessions({
        roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, timers, log,
        // M3 step 7: every peer's srv: table is subscribed while its session is open (§10.1).
        // M3 step 5: gossip frames first (roster sync is the first exchange, §4.6), then the tables.
        // M3 step 9: forwarded commands (owner side) and the owners' answers (forwarding side).
        // M3 step 8: forwarded front-end subscriptions (owner side) and the frames that answer them (attached side).
        // M3 step 10: content gets and their answers (bulk lane), both sides.
        onMessage: async (session, message) => (await gossip.onMessage(session, message)) || peerContent.onMessage(session, message) || peerContentOwner.onMessage(session, message)
          || inbox.onMessage(session, message) || (await forwarder.onMessage(session, message))
          || passThrough.onMessage(session, message) || (await passOwner.onMessage(session, message)) || peerTables.onMessage(session, message),
        sessionOpened: (session) => { gossip.opened(session); void peerTables.opened(session); forwarder.opened(session); passThrough.sessionOpened(session); passThrough.ensureFollowed([...followed()]); },
        sessionClosed: (session) => { gossip.closed(session); peerTables.sessionClosed(session); forwarder.closed(session); inbox.closed(session); passThrough.sessionClosed(session); passOwner.sessionClosed(session); peerContent.sessionClosed(session); peerContentOwner.sessionClosed(session); },
      }, { stateFile: join(paths.dataDir, PEERS_FILE) });
      peers.onState((state) => { void peerTables.peerState(state.member, state.state, state.since); passThrough.peerStateChanged(state.member, state.state, state.since); });
      feeds.start();
      gossip.start();
      daemon = new Botlingd(paths, serverId, lock, store, hub, live, exports, stores, core, runtime, content, shell, server, log, roster, clusterSetup, remote, pairing, summaries, peers, serverJoin, feeds, peerTables, passThrough, peerLogs, passOwner);
      daemon.remoteContent = remoteContent;
      daemon.peerContent = peerContent;
      daemon.peerContentOwner = peerContentOwner;
      daemon.chunkCache = chunkCache;
      daemon.media = media;
      daemon.pluginTimer = pluginTimer;
      daemon.tailnetOrigins = origin ? [origin] : [];
      daemon.relayAddress = relayAddress;
      daemon.tokenValue = writeToken(paths.token);
      if (relayRoom) {
        const allowList = relayAllowList({ roster, identity, pairing });
        const relay = new RelayConnector({ url: relayRoom.url, roomKey: relayRoom.key, sessions: new SessionRouter(remote, peers, undefined, serverJoin), allowList, log, ...relayTestOptions(env) });
        roster.onChange(() => { void relay.refreshAllow(); });
        pairing.onOffersChanged(() => { void relay.refreshAllow(); });
        daemon.relay = relay;
      }
      await server.listen();
      await daemon.listen(port, options.outDir, origin);
      await daemon.relay?.start();
      await daemon.writeOwnProfile((at) => advertisedPort(env, at));
      peers.start();
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
    await step("peer sessions", () => this.peers.close());
    this.passThrough.close();
    this.passOwner.close();
    this.peerContent?.close();
    await step("peer log cache", () => this.peerLogs.idle());
    await step("peer content", () => this.peerContent?.flushed());
    this.feeds.close();
    await step("listener", () => this.listener?.close());
    rmSync(join(this.paths.dataDir, LISTEN_FILE), { force: true });
    rmSync(join(this.paths.dataDir, PEERS_FILE), { force: true });
    this.shell.close();
    await step("core", () => this.core.shutdown());
    // What the core emitted while stopping is written (with the summary rows still waiting), then the worker stops.
    await step("events", () => this.runtime.scope.submit(() => undefined));
    await step("summary rows", () => this.summary.flush());
    this.summary.close();
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

/**
 * Test hook (M3 step 10): `BOTLING_SERVER_TEST_CORRUPT_CONTENT=sha256:<hex>` makes this server flip one byte in every
 * chunk of that content it sends to a peer, so a test can show the attached server refuses it. Unset in real use.
 */
export const TEST_CORRUPT_CONTENT_ENV = "BOTLING_SERVER_TEST_CORRUPT_CONTENT";
export function testCorruptContent(env: Record<string, string | undefined>): string | null {
  const value = (env[TEST_CORRUPT_CONTENT_ENV] ?? "").trim();
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Where the built server's out/ folder is: `<out>/server/main.cjs` → `<out>`. */
export function outDirOf(script: string): string {
  return dirname(dirname(script));
}
