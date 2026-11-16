// botlingd's cluster helpers (M7-S20): the pure functions `botlingd.ts` hands to the core, the session host and the relay
// connector (plugin run check, tailnet and relay addresses, cluster origins, device and peer roster views, the relay allow list,
// the peer lists, `remoteCommandVia`), the server constants and `BotlingdOptions`. Moved out of `botlingd.ts` unchanged;
// `botlingd.ts` re-exports every name.
import { relative, sep } from "node:path";
import type { RemoteMember } from "../core/conversations";
import { CORE_EXIT_DATA_DIR_IN_USE } from "../core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../core/store/records";
import { PluginView, type Command } from "../contract";
import { fromBase64Url, slotKey, type Outcome, type Slot, type Target } from "../protocol";
import { PluginRow, RowKey } from "../protocol/table-rows";
import { relayDeviceToken, relayPageOrigin, relayPairToken, relayTokenHash } from "../session";
import type { ServerOrigin } from "./forward";
import { RELAY_URL_ENV, relayConnectOrigin } from "./net";
import type { ElectronUtilityContext } from "./packaged-electron";
import { peerAddresses, type RelayAddress } from "./peer";
import type { PushTransport } from "./push";
import { readRowBody } from "./replica";
import type { MirrorBot } from "./replica/peer-chat-mirror";
import type { RosterStore, RosterView } from "./roster";
import type { DeviceRoster, SessionOptions } from "./session";
import { grantTierOf, pluginApproved } from "./slots/grant-check";
import type { CompactionOptions, Db } from "./store";

/**
 * M5-18a (D56, §18.3): a plugin's server (program) part runs only when the own `plugin:<name>` row says
 * either it is a built-in at its shipped hash (`author === "builtin"` and `codeHash` matches), or the plugin is installed
 * (2026-11-16: approved by name, whatever its code hash, so a new version runs with no new question).
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
  return pluginApproved(row);
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

/** How `welcome.servers` names this server (M1: one server, this Mac). */
export const SERVER_NAME = "This Mac";
export const BOTLINGD_VERSION = "3.0.0-m1";
/** Fallback poll interval (ms) for catching non-manifest plugin edits when plugins.updated does not fire. */
export const PLUGIN_POLL_MS = 60_000;
/** Each peer server's state (`botlingd.peers.json`, 0600), rewritten on every change, removed on stop (M3 step 3). */
export const PEERS_FILE = "botlingd.peers.json";

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

/**
 * Reads this server's `plugin:<name>` row (M5-13b) and returns what the window shows: the tier recorded at the row's
 * current `codeHash` when there is one, `"write"` for an installed plugin whose record is at an older hash (a new
 * version needs no new question), else `"none"` (not installed: the window offers the install card).
 */
export function readPluginGrant(db: Db, serverId: string, name: string): "none" | "read" | "request" | "write" {
  try {
    const parsed = PluginRow.safeParse(readRowBody(db, `srv:${serverId}`, `plugin:${name}`));
    if (!parsed.success) return "none";
    return grantTierOf(parsed.data);
  } catch {
    return "none";
  }
}

/**
 * What this server's `plugin:<name>` row asks at its running hash, for the window's Settings › Plugins approval: the hash
 * the window shows and grants at, and the manifest's tier, reads and requests (`plugin.grant` left out: never grantable,
 * D54). Null when there is no valid row or the read fails (L-009: the window then offers no approval).
 */
export function readPluginAsks(db: Db, serverId: string, name: string): PluginView["asks"] | null {
  try {
    const parsed = PluginRow.safeParse(readRowBody(db, `srv:${serverId}`, `plugin:${name}`));
    if (!parsed.success) return null;
    const { codeHash, manifest } = parsed.data;
    const asks = { codeHash, tier: manifest.tier, reads: [...manifest.reads], requests: manifest.requests.filter((type) => type !== "plugin.grant") };
    // The row allows asks the view (and a `plugin.grant`) cannot carry, e.g. an empty or 51st read: such a plugin is offered
    // no approval, rather than one bad PluginView making the adapter drop every `plugins.updated` (EventEnvelope check).
    const fits = PluginView.shape.asks.safeParse(asks);
    return fits.success && fits.data ? fits.data : null;
  } catch {
    return null;
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
  /** The one-time prune + VACUUM of an oversized old server.db (store/compaction.ts): `false` is off; tests lower the sizes and `delayMs`. */
  compaction?: (CompactionOptions & { delayMs?: number; batchEntries?: number; scanSpan?: number }) | false;
  /** Packaged Electron run: launch child Node work (plugin host, pdf-text) via utilityProcess.fork. */
  packaged?: boolean;
  electronUtility?: ElectronUtilityContext;
  /** Optional Web Push transport override (used by tests to point at a local fake push server). */
  pushTransport?: PushTransport;
  /** Optional per-bot push coalescing window override in ms (defaults to 60,000 ms). */
  pushCoalesceMs?: number;
  /** Stops this process for an install of a developer build (default: SIGTERM to itself, as `botlingd stop` sends). Tests replace it. */
  stopSelf?: () => void;
}
