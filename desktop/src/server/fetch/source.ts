// Source side of on-demand fetch between servers (§16, D51, M5-07a).
//
// - Free requests (bot artifacts, referenced blobs with nlink === 1) run with a `once` grant bound to `fetchId`
//   (10-minute TTL); `ask` requests reuse an active `always` grant (unless any target file has nlink > 1) or call the
//   approval hook (`approval.ts`'s card in the Maintainer's chat; without one, `"deny"`). Anything but "once" /
//   "always" from the hook is a deny (M5-06c).
// - An audit row (`audit:<fetchId>`, `act: "fetch.serve"`) commits to `srv:<self>` BEFORE the first byte leaves.
// - Fixed 64 KiB (`PEER_CONTENT_FRAME`) frames on every transport (direct & relay) so resume indices never drift.
// - Before EVERY chunk frame: wait if `queuedBytes > 1 MiB`, re-check grant validity/revocation/expiry, peer &
//   requester validity (bot still live or device still valid, bound to asking server, holding reply/manage),
//   string containment against stored real prefix, `isDeniedPath`, and open with `O_NOFOLLOW` re-verifying realpath,
//   lstat `(dev, ino)` equality, size, and `mtimeNs`.
// - Daily byte usage is persisted per day in `server.db` `meta` (`fetchDailyBytes:<day>`).
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import type { ChunkMessage, EntryRef, WireMessage, WireMessageOf } from "../../protocol";
import type { FetchDenyReason, FetchRequester } from "../../protocol/fetch";
import type { DeviceScope } from "../../protocol/scopes";
import { PEER_CONTENT_FRAME } from "../content/peer-content";
import { sameSig, statSig, type StatSig } from "../content/pin";
import type { ContentService } from "../content/service";
import { ownTableStream, putRow, readRowBody } from "../replica/tables";
import type { RosterView } from "../roster";
import type { Db, ServerStore } from "../store";
import { classify, isDeniedPath, Limits, type BotId, type FetchWhat } from "./policy";

const realpath = realpathSync.native ?? realpathSync;
const DAY_MS = 24 * 60 * 60 * 1000;
const ONCE_GRANT_TTL_MS = 10 * 60_000;
const FETCH_HIGH_WATER = 1 * 1024 * 1024;
const DAILY_FLUSH_INTERVAL = 16;

export interface FetchSink {
  readonly peer: string | null;
  readonly state: string;
  readonly queuedBytes: number;
  readonly transport?: "tailnet" | "relay";
  sendWire(message: WireMessage): boolean;
  sendChunk(message: ChunkMessage): boolean;
}

export interface FetchAskRequest {
  fetchId: string;
  requester: FetchRequester;
  requesterServer: string;
  what: FetchWhat;
  purpose: string;
  maxBytes: number;
  prefix: string;
  realPath: string;
  hardLinks?: boolean;
}

/** `cancelled` settles when the serve is over (session closed, source stopping, a racing resume): the card is then dead. */
export type FetchAskHook = (fetch: FetchAskRequest, cancelled: Promise<void>) => Promise<"once" | "always" | "deny">;

export interface FetchSourceOptions {
  self: string;
  dataDir: string;
  store: Pick<ServerStore, "submit">;
  reader(): Db;
  roster: {
    readonly view: RosterView;
    device(member: string): { scope?: readonly DeviceScope[]; by: string } | null;
  };
  botFolders(): Map<BotId, string>;
  content?: Pick<ContentService, "markChanged">;
  dailyLimitBytes?: number;
  ask?: FetchAskHook;
  /** M5-06c: why a fetchId may not be asked at all (it was waiting for its card when the source restarted), or null. */
  gone?: (fetchId: string) => string | null;
  onAudit?: () => void;
  onChunk?: (fetchId: string, index: number) => void | Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

interface GrantRow {
  grantId: string;
  requester: string;
  requesterServer: string;
  prefix: string;
  kind: string;
  fetchId: string | null;
  expires: number | null;
  revokedAt: number | null;
}

interface FileEntry {
  absPath: string;
  relPath: string;
  size: number;
  sha256: string;
  dev: number;
  ino: number;
  mtimeNs: bigint;
  nlink: number;
}

interface ActiveServe {
  cancelled: boolean;
  /** Resolves when the serve is cancelled (session closed, source closed, or replaced by a racing resume). */
  readonly whenCancelled: Promise<void>;
  cancel(): void;
}

function newServe(): ActiveServe {
  let wake!: () => void;
  const whenCancelled = new Promise<void>((resolve) => { wake = resolve; });
  const task: ActiveServe = {
    cancelled: false,
    whenCancelled,
    cancel: () => { if (!task.cancelled) { task.cancelled = true; wake(); } },
  };
  return task;
}

interface InflightEntry {
  task: ActiveServe;
  requesterServer: string | null;
  done: Promise<void>;
}

function isSubpathOrEqual(prefix: string, target: string): boolean {
  if (prefix.endsWith(sep)) return target.startsWith(prefix);
  return target === prefix || target.startsWith(prefix + sep);
}

function safeRealpath(path: string): { ok: true; path: string } | { ok: false; symlink: boolean } {
  try {
    return { ok: true, path: realpath(path) };
  } catch {
    try {
      return { ok: false, symlink: lstatSync(path).isSymbolicLink() };
    } catch {
      return { ok: false, symlink: false };
    }
  }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseStatSig(raw: string | null | undefined): StatSig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StatSig>;
    if (typeof parsed.size === "number" && typeof parsed.mtimeNs === "string" && typeof parsed.ino === "string") {
      return { size: parsed.size, mtimeNs: parsed.mtimeNs, ino: parsed.ino };
    }
  } catch { /* ignore malformed sig */ }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens `absPath` with `O_RDONLY | O_NOFOLLOW`, re-verifies realpath / lstat `(dev, ino)` / containment / deny-list
 * AFTER opening (M5), and hashes its bytes while capturing `(dev, ino, mtimeNs, nlink)`.
 */
async function hashRegularFile(
  absPath: string,
  grantPrefix: string,
  dataDir: string,
  isBlob: boolean,
): Promise<
  | { ok: true; size: number; sha256: string; dev: number; ino: number; mtimeNs: bigint; nlink: number }
  | { ok: false; reason: FetchDenyReason }
> {
  let handle;
  try {
    handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") return { ok: false, reason: "outside" };
    if (code === "ENOENT") return { ok: false, reason: "gone" };
    return { ok: false, reason: "denied" };
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) return { ok: false, reason: "denied" };
    const resolved = safeRealpath(absPath);
    if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
    if (resolved.path !== absPath) return { ok: false, reason: "outside" };
    let lst;
    try { lst = lstatSync(absPath, { bigint: true }); } catch { return { ok: false, reason: "gone" }; }
    if (lst.isSymbolicLink() || lst.dev !== st.dev || lst.ino !== st.ino) return { ok: false, reason: "outside" };
    if (!isBlob && !isSubpathOrEqual(grantPrefix, absPath)) return { ok: false, reason: "outside" };
    if (!isBlob && isDeniedPath(absPath, dataDir)) return { ok: false, reason: "deny-list" };

    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return {
      ok: true,
      size: total,
      sha256: hash.digest("hex"),
      dev: Number(st.dev),
      ino: Number(st.ino),
      mtimeNs: st.mtimeNs,
      nlink: Number(st.nlink),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class FetchSource {
  private readonly askHook: FetchAskHook;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly dailyLimitBytes: number;
  private readonly active = new Map<FetchSink, Set<ActiveServe>>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly dailyBytes = new Map<number, Map<string, number>>();
  private readonly pendingDaily = new Map<number, Map<string, number>>();
  private dailyFlushQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: FetchSourceOptions) {
    this.askHook = options.ask ?? (async () => "deny");
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.dailyLimitBytes = options.dailyLimitBytes ?? Limits.PER_DAY_BYTES_PER_BOT;
  }

  onMessage(session: FetchSink, message: WireMessage): boolean {
    if (message.t !== "fetch.ask") return false;
    if (this.closed) {
      this.deny(session, message.fetchId, "gone");
      return true;
    }
    const existing = this.inflight.get(message.fetchId);
    if (existing) {
      if (existing.requesterServer !== session.peer) {
        this.deny(session, message.fetchId, "denied", "fetchId already in progress");
        return true;
      }
      // Same requesterServer: cancel the in-flight attempt (racing resume) and run after it winds down.
      existing.task.cancel();
    }
    const waitForPrior = existing?.done;
    const task = newServe();
    let set = this.active.get(session);
    if (!set) { set = new Set(); this.active.set(session, set); }
    set.add(task);

    let markDone!: () => void;
    const done = new Promise<void>((resolve) => { markDone = resolve; });
    const entry: InflightEntry = { task, requesterServer: session.peer, done };
    this.inflight.set(message.fetchId, entry);

    void (async () => {
      if (waitForPrior) await waitForPrior.catch(() => undefined);
      if (task.cancelled) return;
      await this.handleAsk(session, message as WireMessageOf<"fetch.ask">, task);
    })()
      .catch((error) => {
        this.log(`fetch: serving ${message.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
        if (!task.cancelled && session.state === "open") {
          session.sendWire({ t: "fetch.denied", fetchId: message.fetchId, reason: "gone" } as WireMessage);
        }
      })
      .finally(() => {
        if (this.inflight.get(message.fetchId) === entry) this.inflight.delete(message.fetchId);
        set!.delete(task);
        if (set!.size === 0) this.active.delete(session);
        markDone();
      });
    return true;
  }

  sessionClosed(session: FetchSink): void {
    const set = this.active.get(session);
    if (!set) return;
    for (const task of set) task.cancel();
    this.active.delete(session);
  }

  close(): void {
    this.closed = true;
    for (const set of this.active.values()) {
      for (const task of set) task.cancel();
    }
    this.active.clear();
  }

  /** Resolves once every active fetch stopped and pending daily byte increments committed to `server.db`. */
  async flushed(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()].map((entry) => entry.done));
    await this.flushDailyBytes();
  }

  private loadDay(day: number): Map<string, number> {
    let map = this.dailyBytes.get(day);
    if (map) return map;
    map = new Map();
    try {
      const row = this.options.reader().prepare("SELECT value FROM meta WHERE key = ?").get(`fetchDailyBytes:${day}`) as
        | { value?: string }
        | undefined;
      if (row?.value) {
        const parsed = JSON.parse(String(row.value)) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) map.set(k, v);
          }
        }
      }
    } catch { /* ignore malformed meta */ }
    this.dailyBytes.set(day, map);
    return map;
  }

  private getDailyBytes(key: string, at: number): number {
    const day = Math.floor(at / DAY_MS);
    return this.loadDay(day).get(key) ?? 0;
  }

  private addDailyBytes(key: string, at: number, delta: number): void {
    const day = Math.floor(at / DAY_MS);
    const dayMap = this.loadDay(day);
    dayMap.set(key, (dayMap.get(key) ?? 0) + delta);
    let pending = this.pendingDaily.get(day);
    if (!pending) { pending = new Map(); this.pendingDaily.set(day, pending); }
    pending.set(key, (pending.get(key) ?? 0) + delta);
  }

  private flushDailyBytes(): Promise<void> {
    const snapshot = new Map<number, Map<string, number>>();
    for (const [day, map] of this.pendingDaily) {
      if (map.size > 0) snapshot.set(day, new Map(map));
    }
    this.pendingDaily.clear();
    if (snapshot.size === 0) return this.dailyFlushQueue;
    this.dailyFlushQueue = this.dailyFlushQueue.then(async () => {
      await this.options.store.submit((tx) => {
        for (const [day, deltas] of snapshot) {
          const metaKey = `fetchDailyBytes:${day}`;
          const existing = tx.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value?: string } | undefined;
          const counts: Record<string, number> = {};
          if (existing?.value) {
            try {
              const parsed = JSON.parse(String(existing.value)) as Record<string, unknown>;
              if (parsed && typeof parsed === "object") {
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === "number" && Number.isFinite(v) && v >= 0) counts[k] = v;
                }
              }
            } catch { /* overwrite corrupt value */ }
          }
          for (const [k, delta] of deltas) {
            counts[k] = (counts[k] ?? 0) + delta;
          }
          tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .run(metaKey, JSON.stringify(counts));
        }
      });
    }).catch((error) => {
      this.log(`fetch: persisting daily byte counts failed: ${String((error as Error)?.message ?? error)}`);
    });
    return this.dailyFlushQueue;
  }

  private deny(session: FetchSink, fetchId: string, reason: FetchDenyReason, detail?: string): void {
    if (session.state !== "open") return;
    session.sendWire({ t: "fetch.denied", fetchId, reason, ...(detail ? { detail } : {}) } as WireMessage);
  }

  private checkRequester(
    db: Db,
    requester: FetchRequester,
    requesterServer: string,
    midStream: boolean,
  ): { ok: true; requesterId: string } | { ok: false; reason: "denied" | "revoked"; detail?: string } {
    if ("bot" in requester) {
      const botRow = db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0")
        .get(`srv:${requesterServer}`, `bot:${requester.bot}`);
      if (!botRow) {
        return { ok: false, reason: midStream ? "revoked" : "denied", detail: "requester bot is not in the asking server's table" };
      }
      return { ok: true, requesterId: requester.bot };
    }
    const device = this.options.roster.device(requester.device);
    if (!device) {
      return { ok: false, reason: midStream ? "revoked" : "denied", detail: "unknown requester device" };
    }
    if (device.by !== requesterServer) {
      return { ok: false, reason: midStream ? "revoked" : "denied", detail: "device is not attached to the asking server" };
    }
    const scope = device.scope ?? [];
    if (!scope.includes("reply") && !scope.includes("manage")) {
      return { ok: false, reason: midStream ? "revoked" : "denied", detail: "scope" };
    }
    return { ok: true, requesterId: requester.device };
  }

  private async handleAsk(session: FetchSink, message: WireMessageOf<"fetch.ask">, task: ActiveServe): Promise<void> {
    let onceGrantToRevoke: string | null = null;
    const revokeOnce = async () => {
      if (!onceGrantToRevoke) return;
      const targetId = onceGrantToRevoke;
      onceGrantToRevoke = null;
      await this.options.store.submit((tx) => {
        tx.prepare("UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL").run(this.now(), targetId);
      }).catch((error) => {
        this.log(`fetch: revoking grant ${targetId} failed: ${String((error as Error)?.message ?? error)}`);
      });
    };
    const terminalDeny = async (reason: FetchDenyReason, detail?: string) => {
      await this.flushDailyBytes();
      if (task.cancelled || session.state !== "open") return;
      await revokeOnce();
      if (!task.cancelled) this.deny(session, message.fetchId, reason, detail);
    };

    try {
      const requesterServer = session.peer;
      const view = this.options.roster.view;
      if (!requesterServer || message.source !== this.options.self) { await terminalDeny("denied"); return; }
      if (!view.servers.has(requesterServer) || !view.valid.has(requesterServer) || !view.valid.has(view.self)) {
        await terminalDeny(view.revoked.has(requesterServer) ? "revoked" : "denied");
        return;
      }

      const db = this.options.reader();
      const reqCheck = this.checkRequester(db, message.requester, requesterServer, false);
      if (!reqCheck.ok) { await terminalDeny(reqCheck.reason, reqCheck.detail); return; }
      const requesterId = reqCheck.requesterId;

      // M5-06c: an ask whose card was open at the last restart is `gone`, never carded a second time.
      const goneDetail = this.options.gone?.(message.fetchId) ?? null;
      if (goneDetail) { await terminalDeny("gone", goneDetail); return; }

      if (message.what.kind === "git") {
        await terminalDeny("denied", "git bundle fetch is handled separately");
        return;
      }

      const existingByFetch = db.prepare(
        "SELECT grantId, requester, requesterServer, prefix, kind, fetchId, expires, revokedAt FROM grants WHERE fetchId = ?",
      ).get(message.fetchId) as GrantRow | undefined;
      if (existingByFetch && existingByFetch.revokedAt !== null) {
        await terminalDeny("denied", "fetchId already used or revoked");
        return;
      }
      if (existingByFetch && !message.from) {
        await terminalDeny("denied", "resuming a once grant requires from");
        return;
      }
      if (
        existingByFetch
        && existingByFetch.kind === "once"
        && existingByFetch.requester === requesterId
        && existingByFetch.requesterServer === requesterServer
      ) {
        onceGrantToRevoke = existingByFetch.grantId;
      }

      const botFolders = this.options.botFolders();
      const referenced = (id: string, entry: EntryRef) =>
        Boolean(db.prepare("SELECT 1 FROM content_refs WHERE id = ? AND stream = ? AND seq = ?").get(id, entry.stream, entry.seq));
      const classified = classify({ what: message.what, botFolders, referenced, dataDir: this.options.dataDir });
      if (classified.kind === "denied") {
        await terminalDeny(classified.reason);
        return;
      }

      const resolvedTarget = this.resolveTargetPath(db, message.what, botFolders);
      if (!resolvedTarget.ok) { await terminalDeny(resolvedTarget.reason); return; }
      const realTarget = resolvedTarget.realPath;
      const isBlob = message.what.kind === "blob";
      if (!isBlob && isDeniedPath(realTarget, this.options.dataDir)) {
        await terminalDeny("deny-list");
        return;
      }

      // M1: verify referenced blob has not changed on disk before scanning/hashing.
      if (message.what.kind === "blob" && resolvedTarget.blobStatSig) {
        let currentSig: StatSig | null = null;
        try { currentSig = statSig(realTarget); } catch { currentSig = null; }
        if (!sameSig(currentSig, resolvedTarget.blobStatSig)) {
          if (resolvedTarget.blobPin === "path") { const targetId = message.what.id; await this.options.content?.markChanged(targetId).catch((err) => this.log(`fetch: markChanged ${targetId} failed: ${String((err as Error)?.message ?? err)}`)); }
          await terminalDeny("gone");
          return;
        }
      }

      // Check existing once grant target & expiry BEFORE scanning/hashing.
      const at = this.now();
      let grantId: string;
      let grantPrefix: string;
      let grantKind: "once" | "always";
      let grantExpires: number | null = null;
      let isNewGrant = false;
      let askedApproval = false;

      if (existingByFetch) {
        const matchesTarget = message.what.kind === "blob"
          ? existingByFetch.prefix === message.what.id
          : isSubpathOrEqual(existingByFetch.prefix, realTarget);
        if (
          existingByFetch.kind !== "once"
          || existingByFetch.requester !== requesterId
          || existingByFetch.requesterServer !== requesterServer
          || !matchesTarget
        ) {
          onceGrantToRevoke = null;
          await terminalDeny("denied");
          return;
        }
        if (existingByFetch.expires !== null && Number(existingByFetch.expires) <= at) {
          await terminalDeny("expired");
          return;
        }
        grantId = existingByFetch.grantId;
        grantPrefix = existingByFetch.prefix;
        grantKind = "once";
        grantExpires = existingByFetch.expires;
      }

      // H3 + L1 + L2: pre-hash scan via lstat/stat checks file count, 500 MiB size cap, symlink loops, and nlink > 1.
      const scan = this.scanTarget(realTarget, isBlob);
      if (!scan.ok) { await terminalDeny(scan.reason); return; }
      const hasHardLinks = !isBlob && scan.hasHardLinks;

      if (!existingByFetch) {
        if (classified.kind === "free" && !hasHardLinks) {
          grantId = randomUUID();
          grantPrefix = classified.prefix;
          grantKind = "once";
          isNewGrant = true;
        } else {
          const alwaysRows = hasHardLinks
            ? []
            : (db.prepare(
              "SELECT grantId, prefix, expires FROM grants WHERE requester = ? AND requesterServer = ? AND kind = 'always' AND mode = 'read' AND revokedAt IS NULL ORDER BY createdAt DESC",
            ).all(requesterId, requesterServer) as Array<{ grantId: string; prefix: string; expires: number | null }>);
          const blobId = message.what.kind === "blob" ? message.what.id : null;
          const matched = alwaysRows.find((row) =>
            (row.expires === null || Number(row.expires) > at)
            && (blobId !== null ? row.prefix === blobId : isSubpathOrEqual(String(row.prefix), realTarget)),
          );
          if (matched) {
            grantId = String(matched.grantId);
            grantPrefix = String(matched.prefix);
            grantKind = "always";
            grantExpires = matched.expires == null ? null : Number(matched.expires);
          } else {
            // L-a: a cancelled serve (session closed, source closed, racing resume) stops waiting for the approval
            // hook at once and counts as "deny", so stop() and a resume never wait on an unanswered card.
            const decision = await Promise.race([this.askHook({
              fetchId: message.fetchId,
              requester: message.requester,
              requesterServer,
              what: message.what,
              purpose: message.purpose,
              maxBytes: message.maxBytes,
              prefix: classified.prefix,
              realPath: realTarget,
              ...(hasHardLinks ? { hardLinks: true } : {}),
            }, task.whenCancelled), task.whenCancelled.then(() => "deny" as const)]);
            if (task.cancelled || session.state !== "open") return;
            // M5-06c: fail closed. Only an explicit "once" / "always" serves; null, undefined or anything else is a deny.
            if (decision !== "once" && decision !== "always") { await terminalDeny("denied"); return; }
            askedApproval = true;
            grantId = randomUUID();
            // H1: never widen a file's "always" grant to its parent directory.
            grantPrefix = classified.prefix;
            // L2: files with nlink > 1 are never covered by an "always" grant (always ask).
            grantKind = (decision === "always" && !hasHardLinks) ? "always" : "once";
            isNewGrant = true;
          }
        }
      }

      // Collect files, verify M5 post-open realpath/lstat/dev/ino, and compute SHA-256 & manifest.
      const collected = await this.collectFiles(realTarget, isBlob ? realTarget : grantPrefix!, isBlob);
      if (!collected.ok) { await terminalDeny(collected.reason); return; }
      const { files, totalBytes, manifest } = collected;
      if (totalBytes > Limits.PER_REQUEST_BYTES) { await terminalDeny("limit"); return; }

      // M1: for a blob, require the single target file's SHA-256 matches the content id.
      if (message.what.kind === "blob" && (files.length !== 1 || `sha256:${files[0]!.sha256}` !== message.what.id)) {
        if (resolvedTarget.blobPin === "path") { const targetId = message.what.id; await this.options.content?.markChanged(targetId).catch((err) => this.log(`fetch: markChanged ${targetId} failed: ${String((err as Error)?.message ?? err)}`)); }
        await terminalDeny("gone");
        return;
      }

      // L2 race guard: a hard link the user was not told about refuses. Only an approval whose card said "this file has
      // other names on disk" (asked with hardLinks) may serve one; a link that appeared after the scan (also while a card
      // without that line waited) under free, always, a plain Allow once or a resume, is refused (M5-06c review).
      const toldHardLinks = askedApproval && hasHardLinks;
      if (!isBlob && !toldHardLinks && files.some((f) => f.nlink > 1)) {
        await terminalDeny("denied");
        return;
      }

      // M2: fixed 64 KiB frame size on every transport; validate from.index and that from.file owns that frame.
      const frameLimit = PEER_CONTENT_FRAME;
      if (message.from) {
        let cursor = 0;
        let ownerFile: FileEntry | null = null;
        for (const f of files) {
          const slices = f.size === 0 ? 1 : Math.ceil(f.size / frameLimit);
          if (message.from.index >= cursor && message.from.index < cursor + slices) {
            ownerFile = f;
            break;
          }
          cursor += slices;
        }
        if (!ownerFile || ownerFile.relPath !== message.from.file) {
          await terminalDeny("gone");
          return;
        }
      }

      // Commit new grant + audit row BEFORE sending fetch.grant or any byte.
      const auditKey = `audit:${message.fetchId}`;
      const auditTime = this.now();
      if (isNewGrant && grantKind! === "once") {
        grantExpires = auditTime + ONCE_GRANT_TTL_MS;
      }
      const auditName = (basename(realTarget) || realTarget).slice(0, 200);
      await this.options.store.submit((tx) => {
        if (isNewGrant) {
          tx.prepare(
            "INSERT INTO grants (grantId, requester, requesterServer, prefix, mode, kind, fetchId, expires, createdAt, revokedAt) VALUES (?, ?, ?, ?, 'read', ?, ?, ?, ?, NULL)",
          ).run(grantId!, requesterId, requesterServer, grantPrefix!, grantKind!, grantKind! === "once" ? message.fetchId : null, grantExpires, auditTime);
        }
        const stream = ownTableStream(tx);
        if (readRowBody(tx, stream, auditKey) === null) {
          putRow(tx, stream, auditKey, {
            act: "fetch.serve",
            at: auditTime,
            by: requesterServer,
            member: requesterId,
            name: auditName,
            size: totalBytes,
            hash: manifest,
          });
        }
      });
      if (grantKind! === "once") onceGrantToRevoke = grantId!;
      this.options.onAudit?.();

      if (task.cancelled || session.state !== "open") return;
      const grantSent = session.sendWire({
        t: "fetch.grant",
        fetchId: message.fetchId,
        prefix: grantPrefix!,
        mode: "read",
        bytes: totalBytes,
        files: files.length,
        expires: grantExpires,
      } as WireMessage);
      if (!grantSent) {
        if (!task.cancelled && session.state === "open") await terminalDeny("gone");
        return;
      }

      const effectiveMaxBytes = Math.min(message.maxBytes, Limits.PER_REQUEST_BYTES);
      const botDailyKey = `${requesterServer}\0${requesterId}`;
      // M5-06c: a file that already had other names when this ask began went through the card with the hard-link line
      // (the user was told), so its approval counts; a link that appears mid-stream in any other fetch (free, always, a
      // plain Allow once, a resume) stops it. dev/ino is checked before every chunk either way (readVerifiedSlice).
      const requireSingleLink = !isBlob && !toldHardLinks;
      let index = 0;
      let bytesSent = 0;
      let sentSinceFlush = 0;

      for (const file of files) {
        const totalSlices = file.size === 0 ? 1 : Math.ceil(file.size / frameLimit);
        for (let slice = 0; slice < totalSlices; slice++, index++) {
          if (message.from && index <= message.from.index) continue;

          // M4: wait while the session's bulk queue has > 1 MiB waiting to seal.
          while (!task.cancelled && session.state === "open" && session.queuedBytes > FETCH_HIGH_WATER) {
            await sleep(2);
          }
          if (task.cancelled || session.state !== "open") {
            await this.flushDailyBytes();
            return;
          }

          const check = this.checkBeforeChunk(session, task, message.requester, requesterServer, grantId!, grantPrefix!, file.absPath, isBlob);
          if (!check.ok) {
            if (check.reason) await terminalDeny(check.reason, check.detail);
            else await this.flushDailyBytes();
            return;
          }

          const offset = slice * frameLimit;
          const pieceLen = file.size === 0 ? 0 : Math.min(frameLimit, file.size - offset);
          const read = await this.readVerifiedSlice(file, grantPrefix!, isBlob, requireSingleLink, offset, pieceLen);
          if (!read.ok) {
            if (read.reason === "gone" && message.what.kind === "blob" && resolvedTarget.blobPin === "path") {
              { const targetId = message.what.id; await this.options.content?.markChanged(targetId).catch((err) => this.log(`fetch: markChanged ${targetId} failed: ${String((err as Error)?.message ?? err)}`)); }
            }
            await terminalDeny(read.reason);
            return;
          }

          if (bytesSent + read.bytes.length > effectiveMaxBytes) { await terminalDeny("limit"); return; }
          const nowAt = this.now();
          if (this.getDailyBytes(botDailyKey, nowAt) + read.bytes.length > this.dailyLimitBytes) {
            await terminalDeny("limit");
            return;
          }

          const sent = session.sendChunk({
            t: "fetch.chunk",
            fetchId: message.fetchId,
            index,
            sha256: sha256Hex(read.bytes),
            bytes: read.bytes,
          });
          if (!sent) {
            // L5: while session is open, an unsent chunk is a terminal error rather than a silent hang.
            if (!task.cancelled && session.state === "open") await terminalDeny("gone");
            else await this.flushDailyBytes();
            return;
          }

          bytesSent += read.bytes.length;
          this.addDailyBytes(botDailyKey, nowAt, read.bytes.length);
          if (++sentSinceFlush >= DAILY_FLUSH_INTERVAL) {
            sentSinceFlush = 0;
            void this.flushDailyBytes();
          }

          await this.options.onChunk?.(message.fetchId, index);
          // Yield between frames so roster revocations, session closes, and control frames run promptly.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      await this.flushDailyBytes();
      if (task.cancelled || session.state !== "open") return;
      if (grantKind! === "once") {
        onceGrantToRevoke = null;
        await this.options.store.submit((tx) => {
          tx.prepare("UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL").run(this.now(), grantId!);
        });
      }
      if (task.cancelled || session.state !== "open") return;
      session.sendWire({
        t: "fetch.done",
        fetchId: message.fetchId,
        manifest,
        bytes: totalBytes,
      } as WireMessage);
    } catch (error) {
      this.log(`fetch: serving ${message.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
      await terminalDeny("gone");
    }
  }

  private resolveTargetPath(
    db: Db,
    what: Exclude<FetchWhat, { kind: "git" }>,
    botFolders: Map<BotId, string>,
  ): { ok: true; realPath: string; isDirectory: boolean; blobPin: string | null; blobStatSig: StatSig | null } | { ok: false; reason: FetchDenyReason } {
    let rawPath: string;
    let blobPin: string | null = null;
    let blobStatSig: StatSig | null = null;
    if (what.kind === "path") {
      rawPath = what.path;
    } else if (what.kind === "artifact") {
      const botFolder = botFolders.get(what.botId);
      if (!botFolder) return { ok: false, reason: "outside" };
      const artifactsDir = join(botFolder, ".bot", "artifacts");
      rawPath = isAbsolute(what.path) ? what.path : `${artifactsDir}${sep}${what.path}`;
    } else {
      const row = db.prepare("SELECT path, state, pin, statSig FROM content WHERE id = ?").get(what.id) as
        | { path?: string; state?: string; pin?: string; statSig?: string | null }
        | undefined;
      if (!row || row.state !== "ready" || !row.path) return { ok: false, reason: "gone" };
      rawPath = String(row.path);
      blobPin = row.pin ? String(row.pin) : null;
      blobStatSig = parseStatSig(row.statSig);
    }
    const resolved = safeRealpath(rawPath);
    if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
    try {
      const st = lstatSync(resolved.path);
      return { ok: true, realPath: resolved.path, isDirectory: st.isDirectory(), blobPin, blobStatSig };
    } catch {
      return { ok: false, reason: "gone" };
    }
  }

  /** Pre-hash scan via lstat/stat: enforces 500 MiB and 20,000-file limits, avoids symlink loops (L1), and spots nlink > 1 (L2). */
  private scanTarget(
    realTarget: string,
    isBlob: boolean,
  ): { ok: true; hasHardLinks: boolean } | { ok: false; reason: FetchDenyReason } {
    let rootStat;
    try {
      rootStat = lstatSync(realTarget, { bigint: true });
    } catch {
      return { ok: false, reason: "gone" };
    }
    if (rootStat.isFile()) {
      if (Number(rootStat.size) > Limits.PER_REQUEST_BYTES) return { ok: false, reason: "limit" };
      return { ok: true, hasHardLinks: Number(rootStat.nlink) > 1 };
    }
    if (!rootStat.isDirectory()) return { ok: false, reason: "denied" };

    const visited = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);
    let folders = 1;
    let fileCount = 0;
    let totalBytes = 0;
    let hasHardLinks = false;

    const walk = (dir: string): FetchDenyReason | null => {
      let names: string[];
      try {
        names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      } catch {
        return "denied";
      }
      for (const name of names) {
        const full = join(dir, name);
        let lst;
        try { lst = lstatSync(full, { bigint: true }); } catch { continue; }
        if (lst.isSymbolicLink()) {
          const real = safeRealpath(full);
          if (!real.ok) continue;
          let targetSt;
          try { targetSt = statSync(real.path, { bigint: true }); } catch { continue; }
          if (targetSt.isDirectory()) continue; // L1: never follow symlinked directories.
          if (!targetSt.isFile()) continue;
          if (!isBlob && !isSubpathOrEqual(realTarget, real.path)) continue;
          if (!isBlob && (isDeniedPath(full, this.options.dataDir) || isDeniedPath(real.path, this.options.dataDir))) continue;
          if (++fileCount > Limits.PER_REQUEST_FILES) return "limit";
          totalBytes += Number(targetSt.size);
          if (totalBytes > Limits.PER_REQUEST_BYTES) return "limit";
          if (Number(targetSt.nlink) > 1) hasHardLinks = true;
        } else if (lst.isDirectory()) {
          if (!isBlob && isDeniedPath(full, this.options.dataDir)) continue;
          const key = `${lst.dev}:${lst.ino}`;
          if (visited.has(key)) continue;
          if (++folders > Limits.PER_REQUEST_FILES) return "limit";
          visited.add(key);
          const err = walk(full);
          if (err) return err;
        } else if (lst.isFile()) {
          if (!isBlob && isDeniedPath(full, this.options.dataDir)) continue;
          if (++fileCount > Limits.PER_REQUEST_FILES) return "limit";
          totalBytes += Number(lst.size);
          if (totalBytes > Limits.PER_REQUEST_BYTES) return "limit";
          if (Number(lst.nlink) > 1) hasHardLinks = true;
        }
      }
      return null;
    };

    const err = walk(realTarget);
    if (err) return { ok: false, reason: err };
    return { ok: true, hasHardLinks };
  }

  private async collectFiles(
    realTarget: string,
    grantPrefix: string,
    isBlob: boolean,
  ): Promise<{ ok: true; files: FileEntry[]; totalBytes: number; manifest: string } | { ok: false; reason: FetchDenyReason }> {
    const entries: Array<{ absPath: string; relPath: string }> = [];
    let rootStat;
    try {
      rootStat = lstatSync(realTarget, { bigint: true });
    } catch {
      return { ok: false, reason: "gone" };
    }
    if (rootStat.isFile()) {
      if (Number(rootStat.size) > Limits.PER_REQUEST_BYTES) return { ok: false, reason: "limit" };
      entries.push({ absPath: realTarget, relPath: basename(realTarget) });
    } else if (rootStat.isDirectory()) {
      const visited = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);
      let folders = 1;
      let estimatedBytes = 0;

      const walk = (dir: string, relDir: string): FetchDenyReason | null => {
        const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const name of names) {
          const full = join(dir, name);
          const rel = relDir ? `${relDir}/${name}` : name;
          let lst;
          try { lst = lstatSync(full, { bigint: true }); } catch { continue; }
          if (lst.isSymbolicLink()) {
            const real = safeRealpath(full);
            if (!real.ok) continue;
            let targetSt;
            try { targetSt = statSync(real.path, { bigint: true }); } catch { continue; }
            if (targetSt.isDirectory()) continue; // L1: never follow symlinked directories.
            if (!targetSt.isFile()) continue;
            if (!isBlob && !isSubpathOrEqual(grantPrefix, real.path)) continue;
            if (!isBlob && (isDeniedPath(full, this.options.dataDir) || isDeniedPath(real.path, this.options.dataDir))) continue;
            if (entries.length >= Limits.PER_REQUEST_FILES) return "limit";
            estimatedBytes += Number(targetSt.size);
            if (estimatedBytes > Limits.PER_REQUEST_BYTES) return "limit";
            entries.push({ absPath: real.path, relPath: rel });
          } else if (lst.isDirectory()) {
            if (!isBlob && !isSubpathOrEqual(grantPrefix, full)) continue;
            if (!isBlob && isDeniedPath(full, this.options.dataDir)) continue;
            const key = `${lst.dev}:${lst.ino}`;
            if (visited.has(key)) continue;
            if (++folders > Limits.PER_REQUEST_FILES) return "limit";
            visited.add(key);
            const err = walk(full, rel);
            if (err) return err;
          } else if (lst.isFile()) {
            if (!isBlob && !isSubpathOrEqual(grantPrefix, full)) continue;
            if (!isBlob && isDeniedPath(full, this.options.dataDir)) continue;
            if (entries.length >= Limits.PER_REQUEST_FILES) return "limit";
            estimatedBytes += Number(lst.size);
            if (estimatedBytes > Limits.PER_REQUEST_BYTES) return "limit";
            entries.push({ absPath: full, relPath: rel });
          }
        }
        return null;
      };
      const err = walk(realTarget, "");
      if (err) return { ok: false, reason: err };
    } else {
      return { ok: false, reason: "denied" };
    }

    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const files: FileEntry[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const hashed = await hashRegularFile(entry.absPath, grantPrefix, this.options.dataDir, isBlob);
      if (!hashed.ok) return hashed;
      totalBytes += hashed.size;
      if (totalBytes > Limits.PER_REQUEST_BYTES) return { ok: false, reason: "limit" };
      files.push({
        absPath: entry.absPath,
        relPath: entry.relPath,
        size: hashed.size,
        sha256: hashed.sha256,
        dev: hashed.dev,
        ino: hashed.ino,
        mtimeNs: hashed.mtimeNs,
        nlink: hashed.nlink,
      });
    }
    const manifestLines = files.map((f) => `${f.relPath}\t${f.size}\t${f.sha256}\n`).join("");
    return { ok: true, files, totalBytes, manifest: sha256Hex(manifestLines) };
  }

  private checkBeforeChunk(
    session: FetchSink,
    task: ActiveServe,
    requester: FetchRequester,
    requesterServer: string,
    grantId: string,
    grantPrefix: string,
    fileAbsPath: string,
    isBlob: boolean,
  ): { ok: true } | { ok: false; reason: FetchDenyReason | null; detail?: string } {
    if (task.cancelled || session.state !== "open") return { ok: false, reason: null };

    const view = this.options.roster.view;
    if (!view.servers.has(requesterServer) || !view.valid.has(requesterServer) || !view.valid.has(view.self)) {
      return { ok: false, reason: "revoked" };
    }

    const db = this.options.reader();
    const reqCheck = this.checkRequester(db, requester, requesterServer, true);
    if (!reqCheck.ok) return { ok: false, reason: reqCheck.reason, detail: reqCheck.detail };

    const grant = db.prepare("SELECT expires, revokedAt FROM grants WHERE grantId = ?").get(grantId) as
      | { expires: number | null; revokedAt: number | null }
      | undefined;
    if (!grant || grant.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (grant.expires !== null && Number(grant.expires) <= this.now()) return { ok: false, reason: "expired" };

    if (!isBlob && !isSubpathOrEqual(grantPrefix, fileAbsPath)) return { ok: false, reason: "outside" };
    if (isSymlink(fileAbsPath)) return { ok: false, reason: "outside" };

    const resolved = safeRealpath(fileAbsPath);
    if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
    if (resolved.path !== fileAbsPath) return { ok: false, reason: "outside" };
    if (!isBlob && !isSubpathOrEqual(grantPrefix, resolved.path)) return { ok: false, reason: "outside" };
    if (!isBlob && isDeniedPath(resolved.path, this.options.dataDir)) return { ok: false, reason: "deny-list" };
    return { ok: true };
  }

  private async readVerifiedSlice(
    file: FileEntry,
    grantPrefix: string,
    isBlob: boolean,
    requireSingleLink: boolean,
    offset: number,
    length: number,
  ): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: FetchDenyReason }> {
    let handle;
    try {
      handle = await open(file.absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ELOOP") return { ok: false, reason: "outside" };
      if (code === "ENOENT") return { ok: false, reason: "gone" };
      return { ok: false, reason: "denied" };
    }
    try {
      const st = await handle.stat({ bigint: true });
      if (!st.isFile() || Number(st.dev) !== file.dev || Number(st.ino) !== file.ino) {
        return { ok: false, reason: "outside" };
      }
      // M5: re-verify realpath and lstat (dev, ino) AFTER opening, plus containment and deny-list.
      const resolved = safeRealpath(file.absPath);
      if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
      if (resolved.path !== file.absPath) return { ok: false, reason: "outside" };
      let lst;
      try { lst = lstatSync(file.absPath, { bigint: true }); } catch { return { ok: false, reason: "gone" }; }
      if (lst.isSymbolicLink() || lst.dev !== st.dev || lst.ino !== st.ino) {
        return { ok: false, reason: "outside" };
      }
      if (!isBlob && !isSubpathOrEqual(grantPrefix, file.absPath)) return { ok: false, reason: "outside" };
      if (!isBlob && isDeniedPath(file.absPath, this.options.dataDir)) return { ok: false, reason: "deny-list" };
      if (requireSingleLink && Number(st.nlink) > 1) return { ok: false, reason: "denied" };
      if (Number(st.size) !== file.size || st.mtimeNs !== file.mtimeNs) return { ok: false, reason: "gone" };

      if (length === 0) return { ok: true, bytes: new Uint8Array(0) };
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buf, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return { ok: true, bytes: new Uint8Array(buf.subarray(0, read)) as Uint8Array<ArrayBuffer> };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
