// Source side of on-demand fetch between servers (§16, D51, M5-07a).
//
// - Free requests (bot artifacts, referenced blobs) run with a `once` grant bound to `fetchId`; `ask` requests reuse an
//   active `always` grant or call the approval hook (default `"deny"` until M5-06b wires Maintainer cards).
// - An audit row (`audit:<fetchId>`, `act: "fetch.serve"`) commits to `srv:<self>` BEFORE the first byte leaves.
// - Before EVERY chunk frame: re-check grant validity/revocation/expiry, peer validity in the roster, string containment
//   against the stored real prefix (never re-realpath the prefix), `isDeniedPath` on the real path, and open with
//   `O_NOFOLLOW` verifying `(dev, ino)` via `fstat`.
// - A `once` grant is marked used at `fetch.done` and refused for any other `fetchId` (D51 `bug_oncereuse`).
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import {
  CONTENT_FRAME_CHUNK_LIMIT, type ChunkMessage, type EntryRef, type WireMessage, type WireMessageOf,
} from "../../protocol";
import { FETCH_GRANT_BYTES_LIMIT, type FetchDenyReason, type FetchRequester } from "../../protocol/fetch";
import type { DeviceScope } from "../../protocol/scopes";
import { PEER_CONTENT_FRAME } from "../content/peer-content";
import { ownTableStream, putRow, readRowBody } from "../replica/tables";
import type { RosterView } from "../roster";
import type { Db, ServerStore } from "../store";
import { classify, isDeniedPath, Limits, type BotId, type FetchWhat } from "./policy";

const realpath = realpathSync.native ?? realpathSync;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FetchSink {
  readonly peer: string | null;
  readonly state: string;
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
}

export type FetchAskHook = (fetch: FetchAskRequest) => Promise<"once" | "always" | "deny">;

export interface FetchSourceOptions {
  self: string;
  dataDir: string;
  store: Pick<ServerStore, "submit">;
  reader(): Db;
  roster: { readonly view: RosterView; device(member: string): { scope?: readonly DeviceScope[] } | null };
  botFolders(): Map<BotId, string>;
  ask?: FetchAskHook;
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
}

interface ActiveServe {
  cancelled: boolean;
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

/** Opens `path` with `O_NOFOLLOW`, reads its whole bytes and SHA-256 while capturing `(dev, ino)` from `fstat`. */
async function hashRegularFile(path: string): Promise<
  | { ok: true; size: number; sha256: string; dev: number; ino: number }
  | { ok: false; reason: FetchDenyReason }
> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") return { ok: false, reason: "outside" };
    if (code === "ENOENT") return { ok: false, reason: "gone" };
    return { ok: false, reason: "denied" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: "denied" };
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { ok: true, size: total, sha256: hash.digest("hex"), dev: Number(st.dev), ino: Number(st.ino) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class FetchSource {
  private readonly askHook: FetchAskHook;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly active = new Map<FetchSink, Set<ActiveServe>>();
  private readonly inflightIds = new Set<string>();
  private readonly dailyBytes = new Map<string, { day: number; bytes: number }>();
  private closed = false;

  constructor(private readonly options: FetchSourceOptions) {
    this.askHook = options.ask ?? (async () => "deny");
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  onMessage(session: FetchSink, message: WireMessage): boolean {
    if (message.t !== "fetch.ask") return false;
    if (this.closed) {
      this.deny(session, message.fetchId, "gone");
      return true;
    }
    if (this.inflightIds.has(message.fetchId)) {
      this.deny(session, message.fetchId, "denied", "fetchId already in progress");
      return true;
    }
    this.inflightIds.add(message.fetchId);
    const task: ActiveServe = { cancelled: false };
    let set = this.active.get(session);
    if (!set) { set = new Set(); this.active.set(session, set); }
    set.add(task);
    void this.handleAsk(session, message as WireMessageOf<"fetch.ask">, task)
      .catch((error) => {
        this.log(`fetch: serving ${message.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
        if (!task.cancelled && session.state === "open") {
          session.sendWire({ t: "fetch.denied", fetchId: message.fetchId, reason: "gone" } as WireMessage);
        }
      })
      .finally(() => {
        this.inflightIds.delete(message.fetchId);
        set!.delete(task);
        if (set!.size === 0) this.active.delete(session);
      });
    return true;
  }

  sessionClosed(session: FetchSink): void {
    const set = this.active.get(session);
    if (!set) return;
    for (const task of set) task.cancelled = true;
    this.active.delete(session);
  }

  close(): void {
    this.closed = true;
    for (const set of this.active.values()) {
      for (const task of set) task.cancelled = true;
    }
    this.active.clear();
  }

  private getDailyBytes(key: string, at: number): number {
    const day = Math.floor(at / DAY_MS);
    const entry = this.dailyBytes.get(key);
    return entry && entry.day === day ? entry.bytes : 0;
  }

  private addDailyBytes(key: string, at: number, delta: number): void {
    const day = Math.floor(at / DAY_MS);
    const prev = this.getDailyBytes(key, at);
    this.dailyBytes.set(key, { day, bytes: prev + delta });
  }

  private deny(session: FetchSink, fetchId: string, reason: FetchDenyReason, detail?: string): void {
    if (session.state !== "open") return;
    session.sendWire({ t: "fetch.denied", fetchId, reason, ...(detail ? { detail } : {}) } as WireMessage);
  }

  private async handleAsk(session: FetchSink, message: WireMessageOf<"fetch.ask">, task: ActiveServe): Promise<void> {
    const deny = (reason: FetchDenyReason, detail?: string) => {
      if (!task.cancelled) this.deny(session, message.fetchId, reason, detail);
    };
    const requesterServer = session.peer;
    const view = this.options.roster.view;
    if (!requesterServer || message.source !== this.options.self) { deny("denied"); return; }
    if (!view.servers.has(requesterServer) || !view.valid.has(requesterServer) || !view.valid.has(view.self)) {
      deny(view.revoked.has(requesterServer) ? "revoked" : "denied");
      return;
    }

    const db = this.options.reader();
    let requesterId: string;
    if ("bot" in message.requester) {
      const botRow = db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0")
        .get(`srv:${requesterServer}`, `bot:${message.requester.bot}`);
      if (!botRow) { deny("denied", "requester bot is not in the asking server's table"); return; }
      requesterId = message.requester.bot;
    } else {
      const device = this.options.roster.device(message.requester.device);
      if (!device) { deny("denied", "unknown requester device"); return; }
      requesterId = message.requester.device;
    }

    if (message.what.kind === "git") {
      deny("denied", "git bundle fetch is handled separately");
      return;
    }

    const existingByFetch = db.prepare(
      "SELECT grantId, requester, requesterServer, prefix, kind, fetchId, expires, revokedAt FROM grants WHERE fetchId = ?",
    ).get(message.fetchId) as GrantRow | undefined;
    if (existingByFetch && existingByFetch.revokedAt !== null) {
      deny("denied", "fetchId already used or revoked");
      return;
    }

    const botFolders = this.options.botFolders();
    const referenced = (id: string, entry: EntryRef) =>
      Boolean(db.prepare("SELECT 1 FROM content_refs WHERE id = ? AND stream = ? AND seq = ?").get(id, entry.stream, entry.seq));
    const classified = classify({ what: message.what, botFolders, referenced, dataDir: this.options.dataDir });
    if (classified.kind === "denied") {
      deny(classified.reason);
      return;
    }

    const resolvedTarget = this.resolveTargetPath(db, message.what, botFolders);
    if (!resolvedTarget.ok) { deny(resolvedTarget.reason); return; }
    const realTarget = resolvedTarget.realPath;
    const isBlob = message.what.kind === "blob";
    if (!isBlob && isDeniedPath(realTarget, this.options.dataDir)) {
      deny("deny-list");
      return;
    }

    // Resolve or create grant. Never re-realpath a stored grant prefix.
    const at = this.now();
    let grantId: string;
    let grantPrefix: string;
    let grantKind: "once" | "always";
    let grantExpires: number | null = null;
    let isNewGrant = false;

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
        deny("denied");
        return;
      }
      if (existingByFetch.expires !== null && Number(existingByFetch.expires) <= at) {
        deny("expired");
        return;
      }
      grantId = existingByFetch.grantId;
      grantPrefix = existingByFetch.prefix;
      grantKind = "once";
      grantExpires = existingByFetch.expires;
    } else if (classified.kind === "free") {
      grantId = randomUUID();
      grantPrefix = classified.prefix;
      grantKind = "once";
      isNewGrant = true;
    } else {
      const alwaysRows = db.prepare(
        "SELECT grantId, prefix, expires FROM grants WHERE requester = ? AND requesterServer = ? AND kind = 'always' AND mode = 'read' AND revokedAt IS NULL ORDER BY createdAt DESC",
      ).all(requesterId, requesterServer) as Array<{ grantId: string; prefix: string; expires: number | null }>;
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
        const decision = await this.askHook({
          fetchId: message.fetchId,
          requester: message.requester,
          requesterServer,
          what: message.what,
          purpose: message.purpose,
          maxBytes: message.maxBytes,
          prefix: classified.prefix,
          realPath: realTarget,
        });
        if (task.cancelled || session.state !== "open") return;
        if (decision === "deny") { deny("denied"); return; }
        grantId = randomUUID();
        grantKind = decision;
        if (decision === "always" && !isBlob) {
          grantPrefix = resolvedTarget.isDirectory ? realTarget : dirname(realTarget);
        } else {
          grantPrefix = classified.prefix;
        }
        isNewGrant = true;
      }
    }

    // Collect files & compute hashes / manifest.
    const collected = await this.collectFiles(realTarget, isBlob ? realTarget : grantPrefix, isBlob);
    if (!collected.ok) { deny(collected.reason); return; }
    const { files, totalBytes, manifest } = collected;
    if (totalBytes > FETCH_GRANT_BYTES_LIMIT) { deny("limit"); return; }
    if (message.from && message.from.file !== "" && !files.some((f) => f.relPath === message.from!.file)) {
      deny("gone");
      return;
    }

    // Commit new grant + audit row BEFORE sending grant or any byte.
    const auditKey = `audit:${message.fetchId}`;
    const auditTime = this.now();
    const auditName = (basename(realTarget) || realTarget).slice(0, 200);
    await this.options.store.submit((tx) => {
      if (isNewGrant) {
        tx.prepare(
          "INSERT INTO grants (grantId, requester, requesterServer, prefix, mode, kind, fetchId, expires, createdAt, revokedAt) VALUES (?, ?, ?, ?, 'read', ?, ?, ?, ?, NULL)",
        ).run(grantId, requesterId, requesterServer, grantPrefix, grantKind, grantKind === "once" ? message.fetchId : null, grantExpires, auditTime);
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
    this.options.onAudit?.();

    if (task.cancelled || session.state !== "open") return;
    session.sendWire({
      t: "fetch.grant",
      fetchId: message.fetchId,
      prefix: grantPrefix,
      mode: "read",
      bytes: totalBytes,
      files: files.length,
      expires: grantExpires,
    } as WireMessage);

    const frameLimit = session.transport === "relay" ? CONTENT_FRAME_CHUNK_LIMIT : PEER_CONTENT_FRAME;
    const effectiveMaxBytes = Math.min(message.maxBytes, Limits.PER_REQUEST_BYTES);
    const botDailyKey = `${requesterServer}\0${requesterId}`;
    let index = 0;
    let bytesSent = 0;

    for (const file of files) {
      const totalSlices = file.size === 0 ? 1 : Math.ceil(file.size / frameLimit);
      for (let slice = 0; slice < totalSlices; slice++, index++) {
        if (message.from && index <= message.from.index) continue;

        const check = this.checkBeforeChunk(session, task, requesterServer, grantId, grantPrefix, file.absPath, isBlob);
        if (!check.ok) {
          if (check.reason) deny(check.reason);
          return;
        }

        const offset = slice * frameLimit;
        const pieceLen = file.size === 0 ? 0 : Math.min(frameLimit, file.size - offset);
        const read = await this.readVerifiedSlice(file, offset, pieceLen);
        if (!read.ok) { deny(read.reason); return; }

        if (bytesSent + read.bytes.length > effectiveMaxBytes) { deny("limit"); return; }
        const nowAt = this.now();
        if (this.getDailyBytes(botDailyKey, nowAt) + read.bytes.length > Limits.PER_DAY_BYTES_PER_BOT) {
          deny("limit");
          return;
        }

        const sent = session.sendChunk({
          t: "fetch.chunk",
          fetchId: message.fetchId,
          index,
          sha256: sha256Hex(read.bytes),
          bytes: read.bytes,
        });
        if (!sent) return;

        bytesSent += read.bytes.length;
        this.addDailyBytes(botDailyKey, nowAt, read.bytes.length);

        await this.options.onChunk?.(message.fetchId, index);
        // Yield between frames so roster revocations, session closes, and control frames run promptly.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    if (task.cancelled || session.state !== "open") return;
    if (grantKind === "once") {
      await this.options.store.submit((tx) => {
        tx.prepare("UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL").run(this.now(), grantId);
      });
    }
    if (task.cancelled || session.state !== "open") return;
    session.sendWire({
      t: "fetch.done",
      fetchId: message.fetchId,
      manifest,
      bytes: totalBytes,
    } as WireMessage);
  }

  private resolveTargetPath(
    db: Db,
    what: Exclude<FetchWhat, { kind: "git" }>,
    botFolders: Map<BotId, string>,
  ): { ok: true; realPath: string; isDirectory: boolean } | { ok: false; reason: FetchDenyReason } {
    let rawPath: string;
    if (what.kind === "path") {
      rawPath = what.path;
    } else if (what.kind === "artifact") {
      const botFolder = botFolders.get(what.botId);
      if (!botFolder) return { ok: false, reason: "outside" };
      const artifactsDir = join(botFolder, ".bot", "artifacts");
      rawPath = isAbsolute(what.path) ? what.path : `${artifactsDir}${sep}${what.path}`;
    } else {
      const row = db.prepare("SELECT path, state FROM content WHERE id = ?").get(what.id) as { path?: string; state?: string } | undefined;
      if (!row || row.state !== "ready" || !row.path) return { ok: false, reason: "gone" };
      rawPath = String(row.path);
    }
    const resolved = safeRealpath(rawPath);
    if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
    try {
      const st = lstatSync(resolved.path);
      return { ok: true, realPath: resolved.path, isDirectory: st.isDirectory() };
    } catch {
      return { ok: false, reason: "gone" };
    }
  }

  private async collectFiles(
    realTarget: string,
    grantPrefix: string,
    isBlob: boolean,
  ): Promise<{ ok: true; files: FileEntry[]; totalBytes: number; manifest: string } | { ok: false; reason: FetchDenyReason }> {
    const entries: Array<{ absPath: string; relPath: string }> = [];
    let rootStat;
    try {
      rootStat = lstatSync(realTarget);
    } catch {
      return { ok: false, reason: "gone" };
    }
    if (rootStat.isFile()) {
      entries.push({ absPath: realTarget, relPath: basename(realTarget) });
    } else if (rootStat.isDirectory()) {
      const walk = (dir: string, relDir: string): FetchDenyReason | null => {
        const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const name of names) {
          const full = join(dir, name);
          const rel = relDir ? `${relDir}/${name}` : name;
          const real = safeRealpath(full);
          if (!real.ok) continue;
          if (!isBlob && !isSubpathOrEqual(grantPrefix, real.path)) continue;
          if (!isBlob && (isDeniedPath(full, this.options.dataDir) || isDeniedPath(real.path, this.options.dataDir))) continue;
          let st;
          try { st = lstatSync(real.path); } catch { continue; }
          if (st.isDirectory()) {
            if (!isBlob && !isSubpathOrEqual(realTarget, real.path)) continue;
            const err = walk(real.path, rel);
            if (err) return err;
          } else if (st.isFile()) {
            if (entries.length >= Limits.PER_REQUEST_FILES) return "limit";
            entries.push({ absPath: real.path, relPath: rel });
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
      if (!isBlob && !isSubpathOrEqual(grantPrefix, entry.absPath)) return { ok: false, reason: "outside" };
      if (!isBlob && isDeniedPath(entry.absPath, this.options.dataDir)) return { ok: false, reason: "deny-list" };
      const hashed = await hashRegularFile(entry.absPath);
      if (!hashed.ok) return hashed;
      files.push({ absPath: entry.absPath, relPath: entry.relPath, size: hashed.size, sha256: hashed.sha256, dev: hashed.dev, ino: hashed.ino });
      totalBytes += hashed.size;
    }
    const manifestLines = files.map((f) => `${f.relPath}\t${f.size}\t${f.sha256}\n`).join("");
    return { ok: true, files, totalBytes, manifest: sha256Hex(manifestLines) };
  }

  private checkBeforeChunk(
    session: FetchSink,
    task: ActiveServe,
    requesterServer: string,
    grantId: string,
    grantPrefix: string,
    fileAbsPath: string,
    isBlob: boolean,
  ): { ok: true } | { ok: false; reason: FetchDenyReason | null } {
    if (task.cancelled || session.state !== "open") return { ok: false, reason: null };

    const view = this.options.roster.view;
    if (!view.servers.has(requesterServer) || !view.valid.has(requesterServer) || !view.valid.has(view.self)) {
      return { ok: false, reason: "revoked" };
    }

    const db = this.options.reader();
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
      const st = await handle.stat();
      if (!st.isFile() || Number(st.dev) !== file.dev || Number(st.ino) !== file.ino) {
        return { ok: false, reason: "outside" };
      }
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
