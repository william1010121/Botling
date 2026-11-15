// The state `Botlingd.start` builds up phase by phase (M7-S84), as types only: `StartContext` is what the phases have made so far,
// `Later` is what a closure made in an early phase reads once a later phase has made it. `D` is the `Botlingd` class (a type
// parameter, so this file does not import botlingd.ts and the two files make no import cycle).
import type { Core } from "../core/server";
import type { DataDirLock } from "../core/store/data-dir-lock";
import type { BotlingdEngine } from "./botlingd-engine";
import type { BotlingdOptions } from "./botlingd-cluster";
import type { DbBotStores } from "./botstore";
import type { CallInHost } from "./callin";
import type { ContentService } from "./content";
import type { ChunkCache, PeerCacheBudget } from "./content/chunk-cache";
import type { PeerContent, PeerContentOwner } from "./content/peer-content";
import type { PluginContentRead } from "./content/plugin-read";
import type { Uploads } from "./content/put";
import type { RemoteContent } from "./content/remote";
import type { BotExports } from "./exports";
import type { FetchApproval } from "./fetch/approval";
import type { FetchRequester } from "./fetch/requester";
import type { FetchSource } from "./fetch/source";
import type { fixedIds } from "./fixed-ids";
import type { Directory, Forwarder, OwnerInbox, ServerOrigin } from "./forward";
import type { ClusterSetup, loadOrCreateServerIdentity } from "./identity";
import type { CoreEngine, IntentRuntime } from "./intents";
import type { LiveChannel } from "./live";
import type { LogHub } from "./log";
import type { MediaJobs } from "./media";
import type { listenPort } from "./net";
import type { PairingService, ServerJoin } from "./pairing";
import type { PhoneDesk } from "./pairing/phone-desk";
import type { peerTimers, PeerSessions, RelayAddress } from "./peer";
import type { PluginAdmin } from "./plugin-admin";
import type { PushTriggers, VapidKeySync } from "./push";
import type { PassThrough, PassThroughOwner, PeerLogCache, PeerTables, SummaryRows, TableFeeds } from "./replica";
import type { PluginHashCache } from "./replica/plugin-rows";
import type { Gossip, PrefsStore, RosterStore } from "./roster";
import type { BotlingdPaths, RemoteSessions, SessionServer } from "./session";
import type { ShellBridge } from "./shell-bridge";
import type { ServerStore } from "./store";
import type { createUtilityHostLauncher, createUtilityScriptRunner } from "./utility-process";

/**
 * Values that a closure made in an early phase of `Botlingd.start` reads after a later phase has made them. Before then a
 * call finds the empty value and answers "not ready" (fail closed), as it did when `start` was one function.
 */
export interface Later<D> {
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
  daemon: D | null;
}

/** What `Botlingd.start` has made so far. Each phase takes what it reads (`Pick`) and returns what later phases read. */
export interface StartContext<D> {
  options: BotlingdOptions;
  env: BotlingdOptions["env"];
  paths: BotlingdPaths;
  port: ReturnType<typeof listenPort>;
  timers: ReturnType<typeof peerTimers>;
  log: (line: string) => void;
  later: Later<D>;
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
  daemon: D;
}
