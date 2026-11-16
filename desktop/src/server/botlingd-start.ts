// The phases of `Botlingd.start` (M7-S84 cut them in place, M7-S85 moved them here, bodies unchanged): each takes the
// `StartContext` of what the earlier phases made and returns what later phases read. `Botlingd.start` calls them in order;
// `assembleDaemon` and `listenAll` stay in botlingd.ts because they build and drive the `Botlingd` itself.
import { join } from "node:path";
import { coreProcessOptions, plainHostNode } from "../core/core-process";
import { createUtilityHostLauncher, createUtilityScriptRunner } from "./utility-process";
import { Core } from "../core/server";
import { type StreamId } from "../protocol";
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
import { callInCrash, callInTimers } from "./callin";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { RemoteSessions, SessionServer, slotAuthorize, type SessionHost } from "./session";
import { fixedIds } from "./fixed-ids";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, readVapidKeyRecord } from "./identity";
import { Gossip, PrefsStore, RosterStore } from "./roster";
import { changeRelaySetting, effectiveRelayUrl, LISTEN_HOST, loadRelayRoomKey, redact, RELAY_KEY_FILE, RELAY_SETTING_FILE, RELAY_URL_ENV } from "./net";
import { relayRoomOf } from "../session";
import { PairingService, ServerJoin } from "./pairing";
import { PhoneDesk } from "./pairing/phone-desk";
import { attachedDeviceIds, PushSender, PushTriggers } from "./push";
import { addressesValue, advertisedPort, PeerSessions, type PeerSession, type RelayAddress } from "./peer";
import { VapidKeySync } from "./push";
import { ShellBridge, appBundleOf } from "./shell-bridge";
import { followedStreams, ownTableStream, PassThrough, PassThroughOwner, passThroughSettings, PEER_CACHE_BYTES, PeerLogCache, PeerTables, putRow, SummaryRows, TableFeeds } from "./replica";
import { PluginAdmin } from "./plugin-admin";
import { PluginHashCache, pluginsDigestOf, reconcilePluginRows } from "./replica/plugin-rows";
import { Directory, Forwarder, OwnerInbox, ServerOrigin } from "./forward";
import { designatedServer, machineLabel } from "./designated";
import { release as osRelease } from "node:os";
import { authorizeRoster, BOTLINGD_VERSION, mayRunPluginServerPart, ownMachineName, pairingAddresses, pairingPageUrl, peerMachines, peerRemoteMembers, PEERS_FILE, PLUGIN_POLL_MS, readPluginAsks, readPluginGrant, relayShown, remoteCommandVia, SERVER_NAME, storeKeyOf, tailnetOrigin } from "./botlingd-cluster";
import { ensureSoleServerVapidKeys, testCorruptContent, type VapidSyncState } from "./botlingd-setup";
import type { StartContext } from "./botlingd-start-context";

type Ctx = StartContext;

/** The oldest Botling 3 window this server serves (fe-link compares it without the -suffix). */
export const MIN_FE_VERSION = "3.0.0-m1";

/** The server's keys, the fixed bot ids, the roster, the cluster preferences and the gossip, on the opened server.db. */
export async function openIdentity(s: Ctx): Promise<Partial<Ctx>> {
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

/** The log hub, the live channel, the bots' stores and exports, the shell bridge and the 2.x Core on them (plugins through the Node plugin host). What its closures read from later phases goes through `later`. */
export async function startCore(s: Ctx): Promise<Partial<Ctx>> {
  const { options, env, paths, log, later, store, serverId, memberId, ids, roster, prefs } = s;
  const hub = new LogHub(store, { serverStreams: true, log });
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

/** The engine over the core, the content index and media jobs, the table feeds, uploads and the intent runtime (recovery at start), and this server's summary rows. */
export async function startRuntime(s: Ctx): Promise<Partial<Ctx>> {
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
  const pluginHashCache = new PluginHashCache({ dataRoot: join(paths.dataDir, "plugin-data"), bundlesDir: join(paths.dataDir, "plugin-bundles") });
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

/** Web Push for owned bots that need the user, and the summary rows reconciled with what the event tap stored. */
export async function startPush(s: Ctx): Promise<Partial<Ctx>> {
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

/** One `plugin:<name>` row per installed plugin, kept current (`later.syncPlugins`) with a 60 s poll; then the content index, the media jobs and the 2.x exports are brought up to date. */
export async function startContent(s: Ctx): Promise<Partial<Ctx>> {
  const { log, later, core, runtime, feeds, pendingBotWrites, pluginHashCache, readInstalledPlugins, machineRow, content, media, exports, opened } = s;
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
  // Step 13: pins left by a crash are swept and every file still preparing is hashed before front ends attach.
  const recovered = await content.recover();
  log(`content recovery: ${JSON.stringify(recovered)}`);
  const mediaStart = await media.start();
  log(`media jobs: ${JSON.stringify({ ...mediaStart, h264: media.tools.h264, found: Object.entries(media.tools.paths).filter(([, at]) => at).map(([name]) => name) })}`);
  for (const note of media.notes()) log(`media note: ${note}`);
  exports.start([...opened.entries()].map(([botId, directory]) => ({ botId, directory })));
  return { pluginTimer };
}

/** The relay setting and room, device pairing and server pairing (`botlingd join` / `add-machine`). */
export async function startPairing(s: Ctx): Promise<Partial<Ctx>> {
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

/** Command forwarding to the servers that own a target, this server as its own command origin, the host side of call-ins, the pass-through of a peer's bot to a front end, the CLI's plugin admin and Settings › Phone. */
export async function startForwarding(s: Ctx): Promise<Partial<Ctx>> {
  const { log, later, store, roster, serverId, hub, engine, runtime, feeds, core, env, paths, live, prefs, pairing } = s;
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
  return { directory, forwarder, serverOrigin, inbox, followed, peerBudget, peerLogs, passThrough, passOwner, pluginAdmin, phone };
}

/** What a front end or a device reaches: the session host (admin ops, tables, forwarding, pass-through), the Unix socket server, content tickets, peers' content, remote device sessions, and the fetch approval card. */
export async function startSessions(s: Ctx): Promise<Partial<Ctx>> {
  const { options, env, paths, log, later, store, serverId, memberId, identity, roster, prefs, hub, live, runtime, engine, content, shell, uploads, core, startedAt, phone, pluginAdmin, pairing, serverJoin, feeds, directory, forwarder, passThrough, peerTables, peerBudget, followed, deviceReadable } = s;
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
  const remoteContent = new RemoteContent({ service: content, tickets, roster, reader: () => hub.reader(), pluginBundlesDir: join(paths.dataDir, "plugin-bundles"), log, peer: peerContent });
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

/** On-demand fetch between servers (source and requester side), cluster VAPID key distribution and the peer sessions (a lone server has no server in its roster, so it dials nothing). */
export async function startPeers(s: Ctx): Promise<Partial<Ctx>> {
  const { paths, log, later, store, serverId, hub, roster, content, engine, feeds, approval, identity, memberId, timers, gossip, peerTables, forwarder, inbox, followed, passThrough, passOwner, peerContent, peerContentOwner } = s;
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
  return { fetchSource, fetchRequester, vapidSync, peers };
}
