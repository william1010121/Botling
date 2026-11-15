// Shared types and file helpers of the fetch source (`source.ts`), moved out of it (M7-S86). Bodies are unchanged;
// `source.ts` imports these names and re-exports the public types, so no importer changes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { ChunkMessage, WireMessage } from "../../protocol";
import type { FetchDenyReason, FetchRequester } from "../../protocol/fetch";
import type { DeviceScope } from "../../protocol/scopes";
import type { StatSig } from "../content/pin";
import type { ContentService } from "../content/service";
import type { RosterView } from "../roster";
import type { Db, ServerStore } from "../store";
import { isDeniedPath, type BotId, type FetchWhat } from "./policy";

const execFileAsync = promisify(execFile);
const realpath = realpathSync.native ?? realpathSync;
const GIT_STRIPPED_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;
// M5-07c: the repository's own config is untrusted (a free `.bot/artifacts` repo is bot-written). `-c` beats repo
// config, and GIT_ALLOW_PROTOCOL (set below) overrides every `protocol.*.allow`, so a promisor remote's lazy fetch
// (which runs `remote.*.uploadpack` / `core.sshCommand`) never starts; no hooks or fsmonitor either.
const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"] as const;
const GIT_TIMEOUT_MS = 10 * 60_000;
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
  /** Parent folder for temporary git bundles (defaults to `os.tmpdir()`). */
  bundleTmpDir?: string;
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

/** No `info/alternates` / `info/http-alternates`, and no symlink in the object store's top two levels. */
function objectStoreIsClosed(objectsDir: string): boolean {
  try {
    for (const name of ["alternates", "http-alternates"]) {
      try { lstatSync(join(objectsDir, "info", name)); return false; } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      }
    }
    for (const top of readdirSync(objectsDir, { withFileTypes: true })) {
      if (top.isSymbolicLink()) return false;
      if (!top.isDirectory()) continue;
      for (const entry of readdirSync(join(objectsDir, top.name), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
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

export {
  execFileAsync, realpath, GIT_STRIPPED_ENV_KEYS, GIT_SAFE_ARGS, GIT_TIMEOUT_MS, DAY_MS, ONCE_GRANT_TTL_MS,
  FETCH_HIGH_WATER, DAILY_FLUSH_INTERVAL, newServe, isSubpathOrEqual, safeRealpath, isSymlink, objectStoreIsClosed,
  sha256Hex, parseStatSig, sleep, hashRegularFile,
};
export type { GrantRow, FileEntry, ActiveServe, InflightEntry };
