// File scanning, hashing and git bundles of `FetchSource` (§16, M7-S88): the pre-hash scan, the file list with its
// hashes, the git bundle, the checks before every chunk and the verified slice read. Moved out of `source.ts` as is;
// `host` carries the three things the moved bodies borrow from `FetchSource` (`options`, `now`, `checkRequester`).
import { constants, lstatSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FETCH_MAX_DEPTH, FetchRelPath, type FetchDenyReason, type FetchRequester } from "../../protocol/fetch";
import type { Db } from "../store";
import { isDeniedPath, Limits } from "./policy";
import {
  execFileAsync, GIT_SAFE_ARGS, GIT_STRIPPED_ENV_KEYS, GIT_TIMEOUT_MS, hashRegularFile, isSubpathOrEqual, isSymlink,
  objectStoreIsClosed, realpath, safeRealpath, sha256Hex,
  type ActiveServe, type FetchSink, type FetchSourceOptions, type FileEntry,
} from "./source-shared";

export type SourceFilesHost = {
  readonly options: FetchSourceOptions;
  now(): number;
  checkRequester(
    db: Db,
    requester: FetchRequester,
    requesterServer: string,
    midStream: boolean,
  ): { ok: true; requesterId: string } | { ok: false; reason: "denied" | "revoked"; detail?: string };
};

export class SourceFiles {
  constructor(private readonly host: SourceFilesHost) {}

  // Bridge block: the names the moved bodies use through `this`.
  private get options() { return this.host.options; }
  private now() { return this.host.now(); }
  private checkRequester(db: Db, requester: FetchRequester, requesterServer: string, midStream: boolean) {
    return this.host.checkRequester(db, requester, requesterServer, midStream);
  }

  /** Pre-hash scan via lstat/stat: enforces 500 MiB and 20,000-file limits, avoids symlink loops (L1), and spots nlink > 1 (L2). */
  scanTarget(
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

    // `depth` is the number of folders above a file in `dir` (the target itself is 0), the requester's count: a file
    // deeper than FETCH_MAX_DEPTH is dropped there, so say `limit` here, before an approval, a grant or the daily quota.
    const walk = (dir: string, depth: number): FetchDenyReason | null => {
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
          if (depth > FETCH_MAX_DEPTH) return "limit";
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
          const err = walk(full, depth + 1);
          if (err) return err;
        } else if (lst.isFile()) {
          if (!isBlob && isDeniedPath(full, this.options.dataDir)) continue;
          if (depth > FETCH_MAX_DEPTH) return "limit";
          if (++fileCount > Limits.PER_REQUEST_FILES) return "limit";
          totalBytes += Number(lst.size);
          if (totalBytes > Limits.PER_REQUEST_BYTES) return "limit";
          if (Number(lst.nlink) > 1) hasHardLinks = true;
        }
      }
      return null;
    };

    const err = walk(realTarget, 0);
    if (err) return { ok: false, reason: err };
    return { ok: true, hasHardLinks };
  }

  async collectFiles(
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
            // F-a again here: the scan counts only links inside the target, this walk serves any link inside the prefix.
            if (rel.split("/").length - 1 > FETCH_MAX_DEPTH) return "limit";
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
            if (rel.split("/").length - 1 > FETCH_MAX_DEPTH) return "limit";
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

    // M5-07b: names go on the wire in NFC (the chunk's `file` schema); the manifest and `from.file` use the same form.
    // Two names that become one after NFC cannot be told apart by the requester, so the fetch is refused.
    for (const entry of entries) entry.relPath = entry.relPath.normalize("NFC");
    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i]!.relPath === entries[i - 1]!.relPath) return { ok: false, reason: "denied" };
    }
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

  async createGitBundle(
    realTarget: string,
    grantPrefix: string,
    task: ActiveServe,
  ): Promise<
    | { ok: true; files: FileEntry[]; totalBytes: number; manifest: string; bundleDir: string }
    | { ok: false; reason: FetchDenyReason | null; detail?: string; bundleDir?: string }
  > {
    if (task.cancelled) return { ok: false, reason: null };
    if (isSymlink(join(realTarget, ".git"))) return { ok: false, reason: "outside" };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "none",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    for (const key of GIT_STRIPPED_ENV_KEYS) delete env[key];
    const parent = dirname(realTarget);
    if (parent !== realTarget) env.GIT_CEILING_DIRECTORIES = parent;

    const ac = new AbortController();
    void task.whenCancelled.then(() => ac.abort());

    // Verify realTarget itself is a git repository (GIT_CEILING_DIRECTORIES stops walk-up into parent repos)
    // and ensure .git / common-dir stay inside grantPrefix and outside DENY.
    let revParseOut: string;
    try {
      const res = await execFileAsync("git", [...GIT_SAFE_ARGS, "-C", realTarget, "rev-parse", "--git-dir", "--git-common-dir", "--git-path", "objects"], {
        env,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        signal: ac.signal,
      });
      revParseOut = res.stdout;
    } catch (error) {
      if (task.cancelled || (error as NodeJS.ErrnoException)?.name === "AbortError") return { ok: false, reason: null };
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "gone", detail: "git is not available" };
      return { ok: false, reason: "gone", detail: "not a git repository" };
    }

    const lines = revParseOut.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return { ok: false, reason: "gone", detail: "not a git repository" };
    for (const rawDir of lines.slice(0, 3)) {
      const absGitDir = resolve(realTarget, rawDir);
      const realGitDir = safeRealpath(absGitDir);
      if (!realGitDir.ok) return { ok: false, reason: realGitDir.symlink ? "outside" : "gone" };
      if (isDeniedPath(realGitDir.path, this.options.dataDir)) return { ok: false, reason: "deny-list" };
      if (!isSubpathOrEqual(grantPrefix, realGitDir.path)) return { ok: false, reason: "outside" };
    }
    // Alternates or a symlink inside the object store would pack objects from outside the grant into the bundle.
    if (!objectStoreIsClosed(resolve(realTarget, lines[2]!))) return { ok: false, reason: "outside" };

    const repoName = (basename(realTarget) || "repo").normalize("NFC");
    const bundleRelPath = `${repoName}.bundle`.normalize("NFC");
    if (!FetchRelPath.safeParse(bundleRelPath).success) return { ok: false, reason: "denied" };

    let bundleDir: string;
    try {
      const baseTmp = realpath(this.options.bundleTmpDir ?? tmpdir());
      bundleDir = realpath(mkdtempSync(join(baseTmp, "botling-git-")));
    } catch {
      return { ok: false, reason: "denied" };
    }
    if (isDeniedPath(bundleDir, this.options.dataDir)) {
      return { ok: false, reason: "deny-list", bundleDir };
    }

    const tmpBundlePath = join(bundleDir, "repo.bundle");
    try {
      await execFileAsync("git", [...GIT_SAFE_ARGS, "-C", realTarget, "bundle", "create", tmpBundlePath, "--all"], {
        env,
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        signal: ac.signal,
      });
    } catch (error) {
      if (task.cancelled || (error as NodeJS.ErrnoException)?.name === "AbortError") {
        return { ok: false, reason: null, bundleDir };
      }
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: false, reason: "gone", detail: "git is not available", bundleDir };
      }
      const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
      if (/not a git repository/i.test(stderr)) {
        return { ok: false, reason: "gone", detail: "not a git repository", bundleDir };
      }
      if (/refusing to create empty bundle/i.test(stderr)) {
        return { ok: false, reason: "gone", detail: "git repository has no commits", bundleDir };
      }
      return { ok: false, reason: "gone", detail: "could not create git bundle", bundleDir };
    }

    if (task.cancelled) return { ok: false, reason: null, bundleDir };

    const hashed = await hashRegularFile(tmpBundlePath, bundleDir, this.options.dataDir, false);
    if (!hashed.ok) return { ok: false, reason: hashed.reason, bundleDir };
    if (hashed.size > Limits.PER_REQUEST_BYTES) return { ok: false, reason: "limit", bundleDir };

    const file: FileEntry = {
      absPath: tmpBundlePath,
      relPath: bundleRelPath,
      size: hashed.size,
      sha256: hashed.sha256,
      dev: hashed.dev,
      ino: hashed.ino,
      mtimeNs: hashed.mtimeNs,
      nlink: hashed.nlink,
    };
    const manifestLines = `${file.relPath}\t${file.size}\t${file.sha256}\n`;
    return {
      ok: true,
      files: [file],
      totalBytes: file.size,
      manifest: sha256Hex(manifestLines),
      bundleDir,
    };
  }

  checkBeforeChunk(
    session: FetchSink,
    task: ActiveServe,
    requester: FetchRequester,
    requesterServer: string,
    grantId: string,
    grantPrefix: string,
    fileAbsPath: string,
    isBlob: boolean,
    gitTarget?: { repoPath: string; bundleDir: string },
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

    const checkedPath = gitTarget ? gitTarget.repoPath : fileAbsPath;
    if (!isBlob && !isSubpathOrEqual(grantPrefix, checkedPath)) return { ok: false, reason: "outside" };
    if (isSymlink(checkedPath)) return { ok: false, reason: "outside" };

    const resolved = safeRealpath(checkedPath);
    if (!resolved.ok) return { ok: false, reason: resolved.symlink ? "outside" : "gone" };
    if (resolved.path !== checkedPath) return { ok: false, reason: "outside" };
    if (!isBlob && !isSubpathOrEqual(grantPrefix, resolved.path)) return { ok: false, reason: "outside" };
    if (!isBlob && isDeniedPath(resolved.path, this.options.dataDir)) return { ok: false, reason: "deny-list" };

    if (gitTarget) {
      if (isSymlink(join(gitTarget.repoPath, ".git"))) return { ok: false, reason: "outside" };
      if (!isSubpathOrEqual(gitTarget.bundleDir, fileAbsPath)) return { ok: false, reason: "outside" };
      if (isSymlink(fileAbsPath)) return { ok: false, reason: "outside" };
      const resolvedBundle = safeRealpath(fileAbsPath);
      if (!resolvedBundle.ok) return { ok: false, reason: resolvedBundle.symlink ? "outside" : "gone" };
      if (resolvedBundle.path !== fileAbsPath) return { ok: false, reason: "outside" };
      if (!isSubpathOrEqual(gitTarget.bundleDir, resolvedBundle.path)) return { ok: false, reason: "outside" };
      if (isDeniedPath(resolvedBundle.path, this.options.dataDir)) return { ok: false, reason: "deny-list" };
    }
    return { ok: true };
  }

  async readVerifiedSlice(
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
