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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { RemoteMember } from "../core/conversations";
import { coreProcessOptions, plainHostNode } from "../core/core-process";
import type { ElectronUtilityContext } from "./packaged-electron";
import { createUtilityHostLauncher, createUtilityScriptRunner } from "./utility-process";
import { Core } from "../core/server";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../core/store/records";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_CHECK_MS } from "../core/store/data-dir-lock";
import { fromBase64Url, slotKey, type Outcome, type Slot, type StreamId } from "../protocol";
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
import { callInTimers, type CallInHost } from "./callin";
import { CoreEngine, IntentRuntime } from "./intents";
import { LogHub } from "./log";
import { LiveChannel } from "./live";
import { serverNotes } from "./notes";
import { botlingdPaths, refuse2xData, RemoteSessions, SessionServer, slotAuthorize, writeToken, type BotlingdPaths, type DeviceRoster, type SessionHost, type SessionOptions } from "./session";
import { fixedIds } from "./fixed-ids";
import { bindServerIdentity, ClusterSetup, ensureVapidKeys, loadOrCreateServerIdentity, readVapidKeyRecord, readVapidKeys, revokedServerIds } from "./identity";
import { Gossip, PrefsStore, RosterStore, type RosterView } from "./roster";
import { changeRelaySetting, defaultPageDir, effectiveRelayUrl, LISTEN_FILE, LISTEN_HOST, listenPort, loadRelayRoomKey, LoopbackListener, redact, RELAY_KEY_FILE, RELAY_SETTING_FILE, RELAY_URL_ENV, relayConnectOrigin, RelayConnector, relayTestOptions } from "./net";
import { relayDeviceToken, relayPageOrigin, relayPairToken, relayRoomOf, relayTokenHash } from "../session";
import { PairingService, ServerJoin } from "./pairing";
import { PhoneDesk } from "./pairing/phone-desk";
import { attachedDeviceIds, PushSender, PushTriggers, type PushTransport } from "./push";
import { addressesValue, advertisedPort, peerAddresses, PeerSessions, peerTimers, SessionRouter, type PeerSession, type RelayAddress } from "./peer";
import { VapidKeySync } from "./push";
import { NO_SAFE_STORAGE, ShellBridge } from "./shell-bridge";
import { PluginRow, RowKey } from "../protocol/table-rows";
import { openServerStore, type Db, type ServerStore } from "./store";
import { PeerChatMirror, type MirrorBot } from "./replica/peer-chat-mirror";
import { followedStreams, ownTableStream, PassThrough, PassThroughOwner, passThroughSettings, PEER_CACHE_BYTES, PeerLogCache, PeerTables, putRow, readRowBody, SummaryRows, TableFeeds } from "./replica";
import { PluginAdmin } from "./plugin-admin";
import { PluginHashCache, pluginsDigestOf, reconcilePluginRows } from "./replica/plugin-rows";
import type { Command } from "../contract";
import type { Target } from "../protocol";
import { Directory, Forwarder, OwnerInbox, ServerOrigin } from "./forward";
import { designatedServer, machineLabel } from "./designated";
import { release as osRelease } from "node:os";

/**
 * M5-18a (D56, §18.3): a plugin's server (program) part runs only when the own `plugin:<name>` row says
 * either it is a built-in at its shipped hash (`author === "builtin"` and `codeHash` matches), or its
 * current `codeHash` holds a `write` grant.
 */
export function mayRunPluginServerPart(reader: () => Db, ownStream: string, name: string, codeHash: string): boolean {
  const key = `plugin:${name}`;
  if (!RowKey.safeParse(key).success) return false;
  let raw: unknown;
  try {
    raw = readRowBody(reader(), ownStream, key);
  } catch {
    return false;
  }
  const parsed = PluginRow.safeParse(raw);
  if (!parsed.success) return false;
  const row = parsed.data;
  if (row.author === "builtin") return row.codeHash === codeHash;
  return Object.hasOwn(row.grants, codeHash) && row.grants[codeHash]?.tier === "write";
}

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
 * The page a pairing link opens (§1 decision 3, the relay serving the 3.x page): this server's tailnet page when it has a
 * tailnet origin, else the relay's page when a relay is set (the relay's root also sends a phone there), else the
 * placeholder tailnet page the person has to fix.
 */
export function pairingPageUrl(tailnet: string | null, relay: string | null): string {
  if (tailnet) return `${tailnet}/v3/`;
  if (relay) return `${relayPageOrigin(relay)}/v3/`;
  return `${PLACEHOLDER_TAILNET_ORIGIN}/v3/`;
}

/** The relay as Settings › Phone shows it: its address, whether this server's room is connected, whether the environment fixes it. */
export function relayShown(
  address: RelayAddress | null,
  relay: { readonly state: "connecting" | "ready" | "down" | "closed" } | null,
  env: Record<string, string | undefined>,
): { url: string | null; state: "off" | "connecting" | "online" | "offline"; fixed: boolean } {
  const fixed = (env[RELAY_URL_ENV] ?? "").trim() !== "";
  if (!address || !relay) return { url: null, state: "off", fixed };
  const state = relay.state === "ready" ? "online" : relay.state === "down" ? "offline" : relay.state === "closed" ? "off" : "connecting";
  return { url: address.url, state, fixed };
}

/** Where an offer says the device reaches this server: the placeholder tailnet address only when nothing else is there. */
export function pairingAddresses(tailnet: string | null, relay: RelayAddress | null): { tailnet?: string; relay?: RelayAddress } {
  if (tailnet) return { tailnet, ...(relay ? { relay } : {}) };
  return relay ? { relay } : { tailnet: PLACEHOLDER_TAILNET_ORIGIN };
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

/**
 * Device & peer-server roster view passed to `slotAuthorize` (M5-04b): a peer server is accepted only when it is in
 * `view.servers` AND `view.valid` (not root-revoked and not unvouched/not-yet-effective).
 */
export function authorizeRoster(roster: Pick<RosterStore, "memberId" | "view" | "device">, hooks: Pick<DeviceRoster, "plainWaiting"> = {}): DeviceRoster {
  return {
    memberId: roster.memberId,
    ...(hooks.plainWaiting ? { plainWaiting: hooks.plainWaiting } : {}),
    device: (member) => roster.device(member),
    server: (member) => {
      const view = roster.view;
      return member !== view.self && view.servers.has(member) && view.valid.has(member);
    },
  };
}

/** The oldest Botling 3 window this server serves (fe-link compares it without the -suffix). */
export const MIN_FE_VERSION = "3.0.0-m1";
/** How `welcome.servers` names this server (M1: one server, this Mac). */
export const SERVER_NAME = "This Mac";
export const BOTLINGD_VERSION = "3.0.0-m1";
/** Fallback poll interval (ms) for catching non-manifest plugin edits when plugins.updated does not fire. */
export const PLUGIN_POLL_MS = 60_000;
/** Each peer server's state (`botlingd.peers.json`, 0600), rewritten on every change, removed on stop (M3 step 3). */
export const PEERS_FILE = "botlingd.peers.json";

export { NO_SAFE_STORAGE };

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

/** Reads this server's `plugin:<name>` row (M5-13b) and returns its grant tier at the row's current `codeHash`, or `"none"`. */
export function readPluginGrant(db: Db, serverId: string, name: string): "none" | "read" | "request" | "write" {
  try {
    const parsed = PluginRow.safeParse(readRowBody(db, `srv:${serverId}`, `plugin:${name}`));
    if (!parsed.success) return "none";
    return (Object.hasOwn(parsed.data.grants, parsed.data.codeHash) ? parsed.data.grants[parsed.data.codeHash]?.tier : undefined) ?? "none";
  } catch {
    return "none";
  }
}

/** The key of the bot store kept in `directory`: the bot's id, or `<id>/partner-<engine>` for a second head's store. */
export function storeKeyOf(dataDir: string, directory: string, mainId: string): string {
  const rel = relative(dataDir, directory).split(sep).join("/");
  if (rel === "main") return mainId;
  if (rel.startsWith("main/")) return `${mainId}/${rel.slice(5)}`;
  if (rel.startsWith("projects/")) return rel.slice("projects/".length);
  return rel || mainId;
}

/**
 * Peer bots callable with @ from this server (M5-02a): live `bot:` summary rows of valid peer servers (role `bot`
 * or `manager`, top-level only), leaving out the 2.x constants `MAIN_BOT_ID` and `MAINTAINER_ID`.
 */
export function peerRemoteMembers(roster: Pick<RosterStore, "view">, db: Db): RemoteMember[] {
  const botRows = db.prepare("SELECT key, body FROM rows WHERE stream = ? AND key LIKE 'bot:%' AND deleted = 0 ORDER BY rev");
  const result: RemoteMember[] = [];
  for (const { id: server, name: serverName } of peerMachines(roster, db)) {
    const stream = `srv:${server}`;
    for (const row of botRows.all(stream)) {
      const id = String(row.key).slice(4);
      if (!id || id === MAIN_BOT_ID || id === MAINTAINER_ID) continue;
      let body: { name?: unknown; role?: unknown; parent?: unknown };
      try { body = JSON.parse(String(row.body ?? "{}")); } catch { continue; }
      if (body.role !== "bot" && body.role !== "manager") continue;
      if (body.parent !== null && body.parent !== undefined) continue;
      if (typeof body.name !== "string" || !body.name.trim()) continue;
      result.push({ id, name: body.name, server, serverName });
    }
  }
  return result;
}

/**
 * The other machines of this cluster (M5-04d, `CoreOptions.machines`; M5-02a's peers): valid servers of the roster that
 * are not this one and whose table is not gone, each named as the main bot's tags and the call-in list name it: the roster
 * member name, else the machine row's name, else the server id.
 */
export function peerMachines(roster: Pick<RosterStore, "view">, db: Db): Array<{ id: string; name: string }> {
  const view = roster.view;
  const peers = [...view.valid].filter((member) => member !== view.self && view.servers.has(member)).sort();
  if (!peers.length) return [];
  const streamState = db.prepare("SELECT state FROM streams WHERE stream = ?");
  const machineRow = db.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'machine' AND deleted = 0");
  const result: Array<{ id: string; name: string }> = [];
  for (const server of peers) {
    const stream = `srv:${server}`;
    const meta = streamState.get(stream);
    if (meta && String(meta.state) === "gone") continue;
    let machineName = "";
    try {
      const m = machineRow.get(stream);
      if (m?.body != null) {
        const parsed = JSON.parse(String(m.body)) as { name?: unknown };
        if (typeof parsed.name === "string") machineName = parsed.name.trim();
      }
    } catch { /* ignore malformed machine row */ }
    result.push({ id: server, name: view.members.get(server)?.name?.trim() || machineName || server });
  }
  return result;
}

/**
 * The peer bots whose chats are copied for the main bot (M5-04e): the same bots as `peerRemoteMembers`, each with the
 * time of its last line from its `bot:` summary row (`lastAt`), so the most recently active are followed first. The
 * mirror checks every id and name itself; nothing here is trusted.
 */
export function peerChatList(roster: Pick<RosterStore, "view">, db: Db): MirrorBot[] {
  const row = db.prepare("SELECT body FROM rows WHERE stream = ? AND key = ? AND deleted = 0");
  return peerRemoteMembers(roster, db).map((member) => {
    let at: number | undefined;
    try {
      const found = row.get(`srv:${member.server}`, `bot:${member.id}`);
      const parsed = found?.body != null ? JSON.parse(String(found.body)) as { lastAt?: unknown } : null;
      if (typeof parsed?.lastAt === "number" && Number.isFinite(parsed.lastAt)) at = parsed.lastAt;
    } catch { /* an unreadable row: no activity time */ }
    return { botId: member.id, owner: member.server, name: member.name, machine: member.serverName, at };
  });
}

/**
 * This server's own name as its peers show it (M5-04c, U1): the roster member name of this server (what
 * `peerRemoteMembers` calls a peer), else its machine row's name, else its server id. `SERVER_NAME` is the same
 * constant on every server, so it alone would make B's bot read "From the main bot on This Mac" about itself.
 */
export function ownMachineName(roster: Pick<RosterStore, "memberId" | "view">, serverId: string, machineRowName: string): string {
  return roster.view.members.get(roster.memberId)?.name?.trim().split(/\r?\n/)[0]?.trim() || machineRowName.trim() || serverId;
}

/**
 * M5-04c: `CoreOptions.remoteCommand` on a `ServerOrigin`. `committed` is the slot being queued (`submit`); `outcome`
 * the first thing the origin hears for that slot. The listener is on before `submit` so an outcome that comes first
 * (a revoked owner ends at once) is not missed. Before the origin exists (it is built after the core) it rejects.
 */
export function remoteCommandVia(origin: Pick<ServerOrigin, "submit" | "on" | "outcome"> | null, target: string, cmd: Command) {
  type Result = { ok: true } | { ok: false; why: string };
  if (!origin) return { committed: Promise.reject(new Error("not ready")), outcome: Promise.resolve<Result>({ ok: false, why: "not ready" }) };
  const answer = (outcome: Outcome): Result => outcome.kind === "applied" ? { ok: true }
    : { ok: false, why: outcome.kind === "refused" ? outcome.detail ?? outcome.reason : outcome.kind };
  let slot: Slot | null = null;
  const early: Array<{ slot: Slot; outcome: Outcome }> = [];
  let settle!: (result: Result) => void;
  const outcome = new Promise<Result>((resolve) => { settle = resolve; });
  const off = origin.on((heard, result) => {
    if (!slot) { early.push({ slot: heard, outcome: result }); return; }
    if (slotKey(heard) === slotKey(slot)) { off(); settle(answer(result)); }
  });
  const committed = origin.submit(target as Target, cmd).then((made) => {
    slot = made;
    const known = early.find((entry) => slotKey(entry.slot) === slotKey(made))?.outcome ?? origin.outcome(made);
    if (known) { off(); settle(answer(known)); }
  }, (error: unknown) => { off(); settle({ ok: false, why: (error as Error).message }); throw error; });
  return { committed, outcome };
}

export interface BotlingdOptions {
  env: Record<string, string | undefined>;
  /** The built app's out/ folder (host/, agent/, builtin-plugins/). */
  outDir: string;
  log?: (line: string) => void;
  session?: SessionOptions;
  /** How long to wait for another holder of the data folder to let go (ms). */
  lockWaitMs?: number;
  /** Packaged Electron run: launch child Node work (plugin host, pdf-text) via utilityProcess.fork. */
  packaged?: boolean;
  electronUtility?: ElectronUtilityContext;
  /** Optional Web Push transport override (used by tests to point at a local fake push server). */
  pushTransport?: PushTransport;
  /** Optional per-bot push coalescing window override in ms (defaults to 60,000 ms). */
  pushCoalesceMs?: number;
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
      let peerSessions: PeerSessions | null = null;
      const resolveDesignated = (raw: unknown): string => designatedServer(roster.view, raw);
      const machineName = (id: string): string =>
        peerSessions?.states().find((state) => state.member === id)?.name
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
      const shell = new ShellBridge({ appDataDir: env.BOTLING_APP_DATA_DIR || null });
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
      let pluginRead: PluginContentRead | null = null;
      // M5-07d: `app_fetch` resolves a machine name to a valid peer and uses the requester, which is built after the core.
      let fetchRequesterRef: FetchRequester | null = null;
      const pendingBotWrites = new Map<string, { botId: string; at: number }>();
      let syncPlugins: (force?: boolean) => Promise<void> = async () => undefined;
      let originRef: ServerOrigin | null = null;
      let hostCallIns: CallInHost | null = null;
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
        pluginWritten: (name, botId) => { pendingBotWrites.set(name, { botId, at: Date.now() }); void syncPlugins(); },
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
        // M5-09: a link button's file that is no longer on this disk is given as the line's content reference.
        lineContent: (botId, messageId, link) => lineContentRef(hub.reader(), serverId, botId, messageId, link),
        remoteMembers: () => peerRemoteMembers(roster, hub.reader()),
        machines: () => peerMachines(roster, hub.reader()),
        // M5-04c: the origin is built below, after the core; a call before then is "not ready".
        remoteCommand: (target, cmd) => remoteCommandVia(originRef, target, cmd),
        machineName: () => ownMachineName(roster, serverId, SERVER_NAME),
        // M5-02c: the host's side of call-ins (the runtime below owns it; until it exists a call-in is "not reachable").
        remoteTurn: (call) => hostCallIns ? hostCallIns.remoteTurn(call) : Promise.resolve({ kind: "failed", why: "its machine cannot take call-ins yet" }),
        fetch: createAppFetch({ roster, requester: () => fetchRequesterRef }),
        pluginGrant: (name) => readPluginGrant(hub.reader(), serverId, name),
        botStore: (directory) => {
          const key = storeKeyOf(paths.dataDir, directory, ids.main);
          opened.set(key, directory);
          return stores.open(key, directory);
        },
      });
      coreEngine.bind(core);
      shell.onAttach(() => { void core.reloadPluginSecrets().catch((error) => log(`plugins: ${String((error as Error)?.message ?? error)}`)); });
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
      const peerTables = new PeerTables({ store, reader: () => hub.reader(), feeds, log });
      // M3 step 6: the server's own summary rows in its srv: table (written from what the event tap stores).
      let summary: SummaryRows | null = null;
      // M4-24: Web Push triggers for owned bots needing the user (wired after remote sessions exist).
      let pushTriggers: PushTriggers | null = null;
      let attachedDevices = (): Set<string> => new Set();
      // M2 step 12: uploads from pages (`content.put`), kept in <data>/uploads; a chat.send naming them waits for them.
      const uploads = new Uploads({ dir: join(paths.dataDir, "uploads"), log: (line) => log(line) });
      coreEngine.useUploads((id) => uploads.complete(id)?.path ?? null);
      const runtime = new IntentRuntime({
        store, engine, hub, live, log: (line) => log(line), authorize: slotAuthorize(authorizeRoster(roster, { plainWaiting: (botId, text) => core.peerMayIgnoreWaiting(botId, text) })), serverEvents: "all", mirrorBotUpdates: true, content, uploads,
        callHostTimers: callInTimers(env),
        // M5-14d / M5-18a: a grant changed. Peers and front ends get the row; the core decides again which program parts
        // may run and re-announces its list once (core.pluginGrantsChanged).
        pluginRowsChanged: () => {
          feeds.notify(feeds.ownStream);
          core.pluginGrantsChanged();
        },
        tapHooks: {
          eventSeen: (event) => {
            summary?.seen(event);
            if (event.type === "plugins.updated") void syncPlugins();
          },
          eventStored: (tx, event) => { summary?.stored(tx, event); pushTriggers?.stored(tx, event); },
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
      summary = new SummaryRows({
        scope: runtime.scope, engine, live, log, onWritten: () => feeds.notify(feeds.ownStream),
        machine: () => machineRow(pluginsDigestOf(readInstalledPlugins().filter((plugin) => plugin.name.length <= 64))),
      });
      const report = await runtime.start();
      log(`recovery: ${JSON.stringify(report)}`);
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
        attachedDevices: () => attachedDevices(),
        ...(options.pushCoalesceMs !== undefined ? { coalesceMs: options.pushCoalesceMs } : {}),
        log,
      });
      pushTriggers = push;
      const summaries = summary;
      const reconciled = await runtime.scope.submit((tx) => { push.seed(tx); return summaries.reconcile(tx); });
      log(`summary rows: ${JSON.stringify({ ...reconciled, unknown: reconciled.unknown.length })}`);
      summaries.startPurging();
      // M5-13b/M5-13c: publish one plugin:<name> row per installed plugin (plus audit row for bot writes) and keep machine.pluginsDigest current.
      let lastPluginsSignature = "";
      let lastPluginsStatSignature: string | null = null;
      let pluginSyncQueue: Promise<void> = Promise.resolve();
      syncPlugins = (force = false) => {
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
      await syncPlugins(true);
      // core/server.ts suppresses plugins.updated when only non-manifest plugin files change (codeHash changes without PluginsView changing), so also poll every 60 s using mtime/size stat signatures.
      const pluginTimer = setInterval(() => { void syncPlugins(); }, PLUGIN_POLL_MS);
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
      // M2 step 13: the relay path (off unless `botlingd relay set` kept an address, or BOTLING_SERVER_RELAY_URL names a
      // relay): botlingd's own room, named in offers.
      const relaySetting = effectiveRelayUrl(env, paths.dataDir, log);
      const relayAt = relaySetting.url;
      if (relayAt) log(`relay: ${redact(relayAt)} (from ${relaySetting.source === "env" ? RELAY_URL_ENV : RELAY_SETTING_FILE})`);
      const relayRoom = relayAt ? await (async () => { const key = loadRelayRoomKey(join(paths.dataDir, RELAY_KEY_FILE)); return { url: relayAt, key, room: await relayRoomOf(key) }; })() : null;
      const relayAddress: RelayAddress | null = relayRoom ? { url: relayRoom.url, room: relayRoom.room } : null;
      const pairing = new PairingService({
        roster, cluster: clusterSetup, identity, serverName: SERVER_NAME, log,
        // The relay in use now (Settings › Phone may switch it while botlingd runs: Botlingd.useRelay).
        addresses: () => pairingAddresses(origin, daemon?.relayAddress ?? relayAddress),
        pageUrl: () => pairingPageUrl(origin, (daemon?.relayAddress ?? relayAddress)?.url ?? null),
        addressNote: () => (origin || (daemon?.relayAddress ?? relayAddress) ? null : "no tailnet address is set yet (BOTLING_SERVER_TAILNET_ORIGIN, once tailscale serve publishes this server), and no relay (botlingd relay set <url>), so the link names a placeholder."),
      });
      // M3 step 4: server pairing (`botlingd join` / `add-machine`), reached at the loopback listener's `/v3/ws`.
      const listenerPort = () => daemon?.listener?.port ?? null;
      const serverJoin = new ServerJoin({
        roster, identity, serverName: SERVER_NAME, version: BOTLINGD_VERSION, dataDir: paths.dataDir, log,
        ownAddresses: () => {
          const at = listenerPort();
          const portArg = at === null ? null : advertisedPort(env, at);
          const relayNow = daemon?.relayAddress ?? relayAddress;
          if (portArg === null && !relayNow) return null;
          return addressesValue(portArg, { tailnet: origin, relay: relayNow });
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
      // M5-04a: this server acting as its own command origin (call-ins, main bot); slot.origin is always roster.memberId.
      const serverOrigin = new ServerOrigin({
        self: roster.memberId, submit: (command) => openStore.submit(command), reader: () => hub.reader(), forwarder,
        isRevoked: (peer) => !roster.view.valid.has(peer),
        subscribeTable: (stream, sink) => feeds.subscribe(stream, null, sink), log,
      });
      originRef = serverOrigin;
      roster.onChange((change) => { void serverOrigin.revoked(change.invalidated); });
      // M5-02c: the host's side asks through the same origin, and hears how each ask ended (a refused ask ends its wait at once).
      hostCallIns = runtime.callHost;
      // M5-03a (D51): a reply after the host gave up is appended marked late and wakes nobody.
      runtime.callHost.bindLate((late) => core.conversations.postLate(late));
      runtime.callHost.attach({
        self: roster.memberId, ownerOf: (target) => forwarder.ownerOf(target), submit: (target, cmd) => serverOrigin.submit(target, cmd),
        onOutcome: (listener) => serverOrigin.on(listener), outcome: (slot) => serverOrigin.outcome(slot),
        // The peer sessions' own bookkeeping (live / stale since the last frame / gone): the wait is a liveness wait.
        peerState: (server) => { const state = peers.states().find((entry) => entry.member === server); return state ? { state: state.state, since: state.since } : null; },
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
      // M5-06c: the fetch approval card and grants (built with the fetch source below; the admin ops read it).
      let fetchApproval: FetchApproval | null = null;
      // M5-14c: the CLI's plugin list and grant (a local-window `plugin.grant` through the intent runtime).
      const pluginAdmin = new PluginAdmin({ runtime, reader: () => hub.reader(), serverId });
      // Settings › Phone in the Botling 3 window: botlingd's own pairing and relay setting, never the 2.x core's (it has
      // neither). The relay goes on, off or elsewhere at once (useRelay), and stays so across restarts (relay.json).
      const phone = new PhoneDesk({
        pairing,
        relay: {
          view: () => relayShown(daemon?.relayAddress ?? null, daemon?.relay ?? null, env),
          set: async (url) => {
            await changeRelaySetting({
              env, dataDir: paths.dataDir, url,
              apply: async (clean) => { if (!daemon) throw new Error("botlingd is still starting; try again in a moment"); await daemon.useRelay(clean); },
            });
          },
        },
      });
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
          peers: () => peers.states().map((state) => ({ id: state.member, name: state.name.slice(0, 200) || state.member, state: state.state, since: state.since })),
          onPeer: (listener) => peers.onState((state) => listener({ id: state.member, state: state.state, since: state.since })),
          // Only a server this roster names as a peer (a lone server serves srv: streams from its log hub as before).
          isPeerTable: (stream) => peerTables.isPeerTable(stream) && peers.states().some((state) => `srv:${state.member}` === stream),
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
        session: (owner) => peers.session(owner),
        ownerOf: (stream) => directory.peerOwner(stream),
        readable: deviceReadable,
        followed: (stream) => followed().has(stream),
      });
      localReads = new LocalPeerReads({ peer: peerContent, self: serverId, log });
      pluginRead = new PluginContentRead({ serverId, service: content, peer: peerContent, roster });
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
      attachedDevices = () => attachedDeviceIds(remote.open);
      // M5-06c: a fetch that asks puts a card into the Maintainer's chat; asks left open by the last run are `gone`.
      const approval = new FetchApproval({
        core, store, reader: () => hub.reader(), self: serverId, names: clusterNames(roster, () => hub.reader()), log,
      });
      await approval.recover();
      fetchApproval = approval;
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
        session: (member) => peers.session(member),
        botFolder: (botId) => engine.botView(botId)?.folder ?? null,
        serverName: (member) => peers.states().find((state) => state.member === member)?.name || null,
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
      fetchRequesterRef = fetchRequester;
      // M4-26: cluster VAPID key rotation on server revocation & encrypted distribution to valid servers.
      let peers!: PeerSessions;
      const vapidSync = new VapidKeySync({ dataDir: paths.dataDir, roster, sessions: () => peers.all, log });
      // M3 step 3: peer servers. A lone server has no server in its roster, so it dials nothing.
      peers = new PeerSessions({
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
      peerSessions = peers;
      peers.onState((state) => { void peerTables.peerState(state.member, state.state, state.since); passThrough.peerStateChanged(state.member, state.state, state.since); });
      feeds.start();
      gossip.start();
      daemon = new Botlingd(paths, serverId, lock, store, hub, live, exports, stores, core, runtime, content, shell, server, log, roster, clusterSetup, remote, pairing, summaries, push, peers, serverJoin, feeds, peerTables, passThrough, peerLogs, passOwner);
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
      runtime.callIns.attach({ ownerOf: (target) => forwarder.ownerOf(target), submit: (target, cmd) => serverOrigin.submit(target, cmd) });
      daemon.chatMirror.start();
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

/**
 * Test hook (M3 step 10): `BOTLING_SERVER_TEST_CORRUPT_CONTENT=sha256:<hex>` makes this server flip one byte in every
 * chunk of that content it sends to a peer, so a test can show the attached server refuses it. Unset in real use.
 */
export const TEST_CORRUPT_CONTENT_ENV = "BOTLING_SERVER_TEST_CORRUPT_CONTENT";
export function testCorruptContent(env: Record<string, string | undefined>): string | null {
  const value = (env[TEST_CORRUPT_CONTENT_ENV] ?? "").trim();
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}


/** Test hook (M5-04a): requires `BOTLING_AGENT=fake` and both test flags (`BOTLING_SERVER_TEST_ORIGIN_HOOK=1` and `BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW=1`). */
export const TEST_ORIGIN_HOOK_ENV = "BOTLING_SERVER_TEST_ORIGIN_HOOK";
export const TEST_ORIGIN_HOOK_ALLOW_ENV = "BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW";
export function originTestHookEnabled(env: Record<string, string | undefined>): boolean {
  return env.BOTLING_AGENT === "fake"
    && env[TEST_ORIGIN_HOOK_ENV] === "1"
    && env[TEST_ORIGIN_HOOK_ALLOW_ENV] === "1";
}
function startOriginTestHook(dataDir: string, serverOrigin: ServerOrigin, log: (line: string) => void): () => void {
  const reqDir = join(dataDir, "test-server-origin-requests");
  const submittedFile = join(dataDir, "test-server-origin-submitted.jsonl");
  const outcomesFile = join(dataDir, "test-server-origin-outcomes.jsonl");
  const off = serverOrigin.on((slot, outcome) => {
    try { appendFileSync(outcomesFile, `${JSON.stringify({ slot, outcome })}\n`, { mode: 0o600 }); } catch (error) {
      log(`server-origin hook: writing outcome failed: ${String((error as Error)?.message ?? error)}`);
    }
  });
  let busy = false;
  const poll = () => {
    if (busy || !existsSync(reqDir)) return;
    busy = true;
    void (async () => {
      try {
        for (const name of readdirSync(reqDir).filter((f) => f.endsWith(".json")).sort()) {
          const full = join(reqDir, name);
          let raw: string;
          try { raw = readFileSync(full, "utf8"); unlinkSync(full); } catch { continue; }
          let req: { id?: unknown; target?: unknown; cmd?: unknown } | null = null;
          try {
            req = JSON.parse(raw) as { id?: unknown; target?: unknown; cmd?: unknown };
            if (!req || typeof req.id !== "string" || typeof req.target !== "string" || !req.cmd || typeof req.cmd !== "object") {
              throw new TypeError("malformed server-origin test hook request");
            }
            const slot = await serverOrigin.submit(req.target as Target, req.cmd as Command);
            appendFileSync(submittedFile, `${JSON.stringify({ id: req.id, slot })}\n`, { mode: 0o600 });
          } catch (error) {
            if (req && typeof req.id === "string") {
              appendFileSync(submittedFile, `${JSON.stringify({ id: req.id, error: String((error as Error)?.message ?? error) })}\n`, { mode: 0o600 });
            } else {
              log(`server-origin hook: bad request ${name}: ${String((error as Error)?.message ?? error)}`);
            }
          }
        }
      } finally {
        busy = false;
      }
    })();
  };
  const timer = setInterval(poll, 25);
  timer.unref();
  return () => { clearInterval(timer); off(); };
}

export interface VapidSyncState {
  known: boolean;
  warnedMissing: boolean;
}

/** True when this server belongs to a cluster and is the sole server member in the current roster view (M4-25 F4). */
export function isSoleServerInRoster(roster: Pick<RosterStore, "clusterId" | "memberId" | "view">): boolean {
  if (!roster.clusterId) return false;
  const servers = roster.view.servers;
  return servers.size === 1 && servers.has(roster.memberId);
}

/**
 * Ensures `vapid-keys.json` exists only when this server is the sole server in the cluster roster (M4-25 F4).
 * In a multi-server cluster, a missing or unreadable key file fails closed (logs once, leaves Web Push disabled)
 * instead of minting a divergent pair that would desync from peers.
 */
export async function ensureSoleServerVapidKeys(
  dataDir: string,
  roster: Pick<RosterStore, "clusterId" | "memberId" | "view">,
  log: (line: string) => void,
  state: VapidSyncState,
): Promise<boolean> {
  if (!roster.clusterId) return false;
  if (state.known) return true;
  if (readVapidKeys(dataDir)) {
    state.known = true;
    state.warnedMissing = false;
    return true;
  }
  const root = roster.view.root;
  if (isSoleServerInRoster(roster) && !root) {
    // No valid root chain: the gen is unknown, so do not mint a gen-1 pair (fail closed, retried on the next call).
    if (!state.warnedMissing) {
      state.warnedMissing = true;
      log("vapid: the cluster root is not known yet; leaving Web Push disabled on this server");
    }
    return false;
  }
  if (isSoleServerInRoster(roster) && root) {
    // Same (gen, covers) as the first server pairing (pairing/join.ts), so VapidKeySync does not rotate it again.
    await ensureVapidKeys(dataDir, { gen: root.gen, covers: revokedServerIds(roster.view) });
    state.known = true;
    state.warnedMissing = false;
    return true;
  }
  if (!state.warnedMissing) {
    state.warnedMissing = true;
    log("vapid: cluster vapid-keys.json is missing or invalid in a multi-server cluster; leaving Web Push disabled on this server");
  }
  return false;
}

/** Where the built server's out/ folder is: `<out>/server/main.cjs` → `<out>`. */
export function outDirOf(script: string): string {
  return dirname(dirname(script));
}
