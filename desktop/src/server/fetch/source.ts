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
import { lstatSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { EntryRef, WireMessage, WireMessageOf } from "../../protocol";
import type { FetchDenyReason, FetchRequester } from "../../protocol/fetch";
import { PEER_CONTENT_FRAME } from "../content/peer-content";
import { sameSig, statSig, type StatSig } from "../content/pin";
import { ownTableStream, putRow, readRowBody } from "../replica/tables";
import type { Db } from "../store";
import { DailyLimit } from "./daily-limit";
import { classify, isDeniedPath, Limits, type BotId, type FetchWhat } from "./policy";
import { SourceFiles } from "./source-files";
import {
  DAILY_FLUSH_INTERVAL, FETCH_HIGH_WATER, isSubpathOrEqual, newServe, ONCE_GRANT_TTL_MS, parseStatSig, safeRealpath,
  sha256Hex, sleep,
  type ActiveServe, type FetchAskHook, type FetchAskRequest, type FetchSink, type FetchSourceOptions, type FileEntry,
  type GrantRow, type InflightEntry,
} from "./source-shared";

export type { FetchAskHook, FetchAskRequest, FetchSink, FetchSourceOptions } from "./source-shared";


export class FetchSource {
  private readonly askHook: FetchAskHook;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly dailyLimitBytes: number;
  private readonly active = new Map<FetchSink, Set<ActiveServe>>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly daily: DailyLimit;
  private readonly files: SourceFiles;
  private closed = false;

  constructor(private readonly options: FetchSourceOptions) {
    this.askHook = options.ask ?? (async () => "deny");
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.dailyLimitBytes = options.dailyLimitBytes ?? Limits.PER_DAY_BYTES_PER_BOT;
    this.daily = new DailyLimit({ store: options.store, reader: options.reader, log: this.log });
    this.files = new SourceFiles({
      options,
      now: () => this.now(),
      checkRequester: (db, requester, requesterServer, midStream) => this.checkRequester(db, requester, requesterServer, midStream),
    });
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
    await this.daily.flush();
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
    let tmpBundleDir: string | null = null;
    const cleanupBundle = () => {
      if (!tmpBundleDir) return;
      const dir = tmpBundleDir;
      tmpBundleDir = null;
      rmSync(dir, { recursive: true, force: true });
    };
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
      cleanupBundle();
      await this.daily.flush();
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
      const isGit = message.what.kind === "git";
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
      // For git, we serve a freshly created single bundle file rather than the working tree or .git/objects.
      let hasHardLinks = false;
      if (!isGit) {
        const scan = this.files.scanTarget(realTarget, isBlob);
        if (!scan.ok) { await terminalDeny(scan.reason); return; }
        hasHardLinks = !isBlob && scan.hasHardLinks;
      }

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

      // Collect files (or create temporary git bundle), verify M5 post-open realpath/lstat/dev/ino, and compute SHA-256 & manifest.
      let files: FileEntry[];
      let totalBytes: number;
      let manifest: string;
      let gitTarget: { repoPath: string; bundleDir: string } | undefined;
      if (isGit) {
        if (!resolvedTarget.isDirectory) {
          await terminalDeny("gone", "not a git repository");
          return;
        }
        const bundled = await this.files.createGitBundle(realTarget, grantPrefix!, task);
        if (bundled.bundleDir) tmpBundleDir = bundled.bundleDir;
        if (!bundled.ok) {
          if (bundled.reason) await terminalDeny(bundled.reason, bundled.detail);
          return;
        }
        files = bundled.files;
        totalBytes = bundled.totalBytes;
        manifest = bundled.manifest;
        gitTarget = { repoPath: realTarget, bundleDir: bundled.bundleDir };
      } else {
        const collected = await this.files.collectFiles(realTarget, isBlob ? realTarget : grantPrefix!, isBlob);
        if (!collected.ok) { await terminalDeny(collected.reason); return; }
        files = collected.files;
        totalBytes = collected.totalBytes;
        manifest = collected.manifest;
      }
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
      if (!isBlob && !isGit && !toldHardLinks && files.some((f) => f.nlink > 1)) {
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
            await this.daily.flush();
            return;
          }

          const check = this.files.checkBeforeChunk(session, task, message.requester, requesterServer, grantId!, grantPrefix!, file.absPath, isBlob, gitTarget);
          if (!check.ok) {
            if (check.reason) await terminalDeny(check.reason, check.detail);
            else await this.daily.flush();
            return;
          }

          const offset = slice * frameLimit;
          const pieceLen = file.size === 0 ? 0 : Math.min(frameLimit, file.size - offset);
          const read = await this.files.readVerifiedSlice(file, gitTarget ? gitTarget.bundleDir : grantPrefix!, isBlob, requireSingleLink, offset, pieceLen);
          if (!read.ok) {
            if (read.reason === "gone" && message.what.kind === "blob" && resolvedTarget.blobPin === "path") {
              { const targetId = message.what.id; await this.options.content?.markChanged(targetId).catch((err) => this.log(`fetch: markChanged ${targetId} failed: ${String((err as Error)?.message ?? err)}`)); }
            }
            await terminalDeny(read.reason);
            return;
          }

          if (bytesSent + read.bytes.length > effectiveMaxBytes) { await terminalDeny("limit"); return; }
          const nowAt = this.now();
          if (this.daily.get(botDailyKey, nowAt) + read.bytes.length > this.dailyLimitBytes) {
            await terminalDeny("limit");
            return;
          }

          const sent = session.sendChunk({
            t: "fetch.chunk",
            fetchId: message.fetchId,
            index,
            // M5-07b: the requester splits the stream into files by this name.
            file: file.relPath,
            sha256: sha256Hex(read.bytes),
            bytes: read.bytes,
          });
          if (!sent) {
            // L5: while session is open, an unsent chunk is a terminal error rather than a silent hang.
            if (!task.cancelled && session.state === "open") await terminalDeny("gone");
            else await this.daily.flush();
            return;
          }

          bytesSent += read.bytes.length;
          this.daily.add(botDailyKey, nowAt, read.bytes.length);
          if (++sentSinceFlush >= DAILY_FLUSH_INTERVAL) {
            sentSinceFlush = 0;
            void this.daily.flush();
          }

          await this.options.onChunk?.(message.fetchId, index);
          // Yield between frames so roster revocations, session closes, and control frames run promptly.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      await this.daily.flush();
      if (task.cancelled || session.state !== "open") return;
      if (grantKind! === "once") {
        onceGrantToRevoke = null;
        await this.options.store.submit((tx) => {
          tx.prepare("UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL").run(this.now(), grantId!);
        });
      }
      if (task.cancelled || session.state !== "open") return;
      cleanupBundle();
      session.sendWire({
        t: "fetch.done",
        fetchId: message.fetchId,
        manifest,
        bytes: totalBytes,
      } as WireMessage);
    } catch (error) {
      this.log(`fetch: serving ${message.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
      await terminalDeny("gone");
    } finally {
      cleanupBundle();
    }
  }

  private resolveTargetPath(
    db: Db,
    what: FetchWhat,
    botFolders: Map<BotId, string>,
  ): { ok: true; realPath: string; isDirectory: boolean; blobPin: string | null; blobStatSig: StatSig | null } | { ok: false; reason: FetchDenyReason } {
    let rawPath: string;
    let blobPin: string | null = null;
    let blobStatSig: StatSig | null = null;
    if (what.kind === "path" || what.kind === "git") {
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
}
