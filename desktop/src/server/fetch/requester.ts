// Requester side of on-demand fetch between servers (§16, D51, M5-07b).
//
// - `fetch(botId, source, what, purpose, maxBytes)` asks the source server and writes what arrives into the requesting
//   bot's folder, under `.bot/incoming/<source name, made safe>-<first 8 of its id>/<fetchId>/` and nowhere else.
// - Every chunk is checked before a byte is kept: its index is the next one, its SHA-256 matches, its `file` is a
//   relative path that cannot leave the folder (the requester never trusts the wire: the schema is checked again here).
//   Bytes go to a staging folder NEXT TO `<dest>` (`<source>/.<fetchId>.partial/<file>`); `<dest>` appears only when
//   `fetch.done`'s manifest equals the one recomputed from what arrived (size + SHA-256 per file, counted here, not
//   taken from the source), by ONE rename of the staging folder inside the same parent folder.
// - The bot may write its own folder (`.bot/incoming` included) while this server writes, and may plant symlinks
//   there. So: the staging folder is checked by inode (and must be a plain folder) and folders under it are made one at
//   a time, each checked by `lstat`, before a file is opened. The file is opened with `O_EXCL` and, on macOS,
//   `O_NOFOLLOW_ANY` (no symlink anywhere on the path, so a racing swap cannot redirect the open); on Linux the opened
//   file's real path (`/proc/self/fd`) must be the target. After the open and before a byte is written, the opened file
//   must be the one at its path (same inode, one link, regular). No file is ever renamed across folders. Remaining risk
//   (no `openat`/`mkdirat` in Node): a bot that swaps a staging sub folder in the microseconds between a check and a
//   `mkdir` (both systems) or the open (Linux only) can make this server create one EMPTY folder or file outside; no
//   byte is written into it and nothing is overwritten.
// - A lost session: back within `resumeWindowMs` (10 minutes) the same `fetch.ask` goes out again with `from` = the
//   last verified chunk; after the window the fetch ends `unreachable`. `from.index` means "after this chunk" (07a), so
//   a session lost before chunk 0 cannot resume: the fetch starts again under a NEW fetchId (for an ask grant the
//   source's user is asked again) and the old folder is removed (L-c).
// - Every failure removes the staging folder and `<dest>`. A fetch lives in memory only: a restart of this
//   server ends it (the folder, if any, is left to the user; nothing resumes).
// - One audit row (`audit:<fetchId>`, `act: "fetch.receive"`) in this server's `srv:` table after the files are in
//   place (the source wrote its `fetch.serve` row before the first byte).
import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { WireMessage, WireMessageOf } from "../../protocol";
import { FETCH_MAX_BYTES, FETCH_MAX_FILES, FetchRelPath, type FetchDenyReason, type FetchWhat } from "../../protocol/fetch";
import { ownTableStream, putRow } from "../replica/tables";
import type { ServerStore } from "../store";

const realpath = realpathSync.native ?? realpathSync;
export const FETCH_RESUME_WINDOW_MS = 10 * 60_000;
const PARTIAL = ".partial";
/** macOS `O_NOFOLLOW_ANY` (open fails with ELOOP if any part of the path is a symlink); not in `fs.constants`. */
const O_NOFOLLOW_ANY = process.platform === "darwin" ? 0x20000000 : 0;
// (macOS refuses O_NOFOLLOW together with O_NOFOLLOW_ANY with EINVAL; ANY covers the last part too.)
const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (O_NOFOLLOW_ANY || constants.O_NOFOLLOW);
/** Linux: the real path of an open file, to check where an open really landed. */
const PROC_FD = process.platform === "linux" && existsSync("/proc/self/fd") ? "/proc/self/fd" : null;

/** What `FetchRequester` needs from a peer session (`PeerSession` has all of it). */
export interface FetchPeer {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
}

export type FetchFailure = FetchDenyReason | "corrupt" | "unreachable";

export type FetchResult =
  | { ok: true; fetchId: string; /** relative to the bot's folder: `.bot/incoming/<source>/<fetchId>` */ dest: string; absDest: string; files: number; bytes: number; manifest: string }
  | { ok: false; reason: FetchFailure; detail?: string };

export interface FetchRequesterOptions {
  store: Pick<ServerStore, "submit">;
  /** The open session with `member`, if any. */
  session(member: string): FetchPeer | null;
  /** The folder of one of this server's bots, or null. */
  botFolder(botId: string): string | null;
  /** The source server's name (null: unknown; the folder is then named `server-<id8>`). */
  serverName(member: string): string | null;
  /** How long a lost session may take to come back (default 10 minutes). */
  resumeWindowMs?: number;
  onAudit?: () => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** `build-box-1a2b3c4d`: the name made safe (`[A-Za-z0-9._-]`, else `_`, at most 64) and the first 8 characters of the id. */
export function incomingDirName(name: string | null, serverId: string): string {
  const safe = (name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "server";
  return `${safe}-${serverId.slice(0, 8)}`;
}

interface Pending {
  fetchId: string;
  botId: string;
  source: string;
  what: FetchWhat;
  purpose: string;
  maxBytes: number;
  botFolder: string;
  srvDir: string;
  dest: string;
  partial: string;
  /** dev:ino of the staging folder when it was made. */
  partialId: string;
  session: FetchPeer;
  state: "asking" | "lost" | "finishing" | "ended";
  /** The next chunk index (also: how many chunks are verified). */
  expected: number;
  lastFile: string | null;
  grant: { bytes: number; files: number } | null;
  done: Array<{ rel: string; size: number; sha256: string }>;
  seen: Set<string>;
  cur: { rel: string; handle: FileHandle; hash: Hash; size: number } | null;
  total: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  resolve(result: FetchResult): void;
}

export class FetchRequester {
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly resumeWindowMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: FetchRequesterOptions) {
    this.resumeWindowMs = options.resumeWindowMs ?? FETCH_RESUME_WINDOW_MS;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** Asks `source` for `what` on behalf of the bot `botId`; resolves when the files are in place or the fetch failed. */
  fetch(botId: string, source: string, what: FetchWhat, purpose: string, maxBytes: number): Promise<FetchResult> {
    const folder = this.options.botFolder(botId);
    if (this.closed) return Promise.resolve({ ok: false, reason: "unreachable", detail: "this server is stopping" });
    if (!folder) return Promise.resolve({ ok: false, reason: "denied", detail: "this server has no such bot" });
    const session = this.options.session(source);
    if (!session || session.state !== "open") return Promise.resolve({ ok: false, reason: "unreachable" });

    return new Promise<FetchResult>((resolve) => {
      const p: Pending = {
        fetchId: randomUUID(), botId, source, what, purpose: purpose.slice(0, 500),
        maxBytes: Math.max(1, Math.min(FETCH_MAX_BYTES, Math.floor(Number.isFinite(maxBytes) ? maxBytes : FETCH_MAX_BYTES))),
        botFolder: folder, srvDir: incomingDirName(this.options.serverName(source), source), dest: "", partial: "", partialId: "",
        session, state: "asking", expected: 0, lastFile: null, grant: null, done: [], seen: new Set(), cur: null, total: 0,
        timer: null, chain: Promise.resolve(), resolve,
      };
      try {
        this.prepare(p);
      } catch (error) {
        this.removeDest(p);
        resolve({ ok: false, reason: "denied", detail: `cannot prepare the incoming folder: ${String((error as Error)?.message ?? error)}`.slice(0, 500) });
        return;
      }
      this.pending.set(p.fetchId, p);
      if (!this.sendAsk(p)) { void this.end(p, { ok: false, reason: "unreachable" }); }
    });
  }

  /** Takes `fetch.grant`, `fetch.chunk`, `fetch.done` and `fetch.denied` of a fetch this server asked for. */
  onMessage(session: FetchPeer, message: WireMessage): boolean {
    switch (message.t) {
      case "fetch.grant": case "fetch.chunk": case "fetch.done": case "fetch.denied": break;
      default: return false;
    }
    const p = this.pending.get(message.fetchId);
    // Unknown fetch (ended, never asked) or a frame from another server than the source: dropped, nothing changes.
    if (!p || p.state !== "asking" || session.peer !== p.source || session !== p.session) return true;
    this.enqueue(p, () => this.handle(p, message));
    return true;
  }

  /** A session to a peer opened: resume the fetches that lost theirs to it. */
  sessionOpened(session: FetchPeer): void {
    for (const p of [...this.pending.values()]) {
      if (p.state === "lost" && p.source === session.peer) this.enqueue(p, () => this.resume(p, session));
    }
  }

  /** A session closed: the fetches on it wait for the next one (at most the resume window). */
  sessionClosed(session: FetchPeer): void {
    for (const p of this.pending.values()) {
      if (p.state !== "asking" || p.session !== session) continue;
      p.state = "lost";
      p.timer = setTimeout(() => this.enqueue(p, () => this.end(p, { ok: false, reason: "unreachable" })), this.resumeWindowMs);
      p.timer.unref?.();
    }
  }

  /** Ends every fetch still running (the server stops): `unreachable`, folders removed. */
  close(): void {
    this.closed = true;
    for (const p of [...this.pending.values()]) this.enqueue(p, () => this.end(p, { ok: false, reason: "unreachable" }));
  }

  /** Resolves once every queued step finished (cleanup included). */
  async flushed(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  // ---- internals ----

  private enqueue(p: Pending, step: () => Promise<void>): void {
    const next = p.chain.then(step).catch((error) => {
      this.log(`fetch: receiving ${p.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
      return this.end(p, { ok: false, reason: "corrupt", detail: `could not keep the files: ${String((error as Error)?.message ?? error)}`.slice(0, 500) });
    });
    p.chain = next;
    this.running.add(next);
    void next.finally(() => this.running.delete(next));
  }

  /**
   * Makes `<bot>/.bot/incoming/<source>/` step by step (an existing part must be a real folder, never a symlink) and the
   * staging folder `<source>/.<fetchId>.partial` NEXT TO `<dest>`: `<dest>` itself appears only at
   * `fetch.done`, by one rename inside the same parent, so no file is ever moved across a folder the bot could swap.
   */
  private prepare(p: Pending): void {
    const incoming = join(p.botFolder, ".bot", "incoming");
    const parts = [join(p.botFolder, ".bot"), incoming, join(incoming, p.srvDir), join(incoming, p.srvDir, `.${p.fetchId}${PARTIAL}`)];
    p.dest = join(incoming, p.srvDir, p.fetchId); // so a failure half way still cleans up what was made
    p.partial = parts[3]!;
    for (const part of parts) {
      let existing = null;
      try { existing = lstatSync(part); } catch { /* not there yet */ }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`${part} is not a plain folder`);
        if (part === parts[3]) throw new Error("the fetch folder already exists");
        continue;
      }
      mkdirSync(part);
    }
    const srvReal = join(realpath(p.botFolder), ".bot", "incoming", p.srvDir);
    p.dest = join(srvReal, p.fetchId);
    p.partial = join(srvReal, `.${p.fetchId}${PARTIAL}`);
    if (realpath(parts[3]!) !== p.partial) throw new Error("the incoming folder is not inside the bot folder");
    if (exists(p.dest)) throw new Error("the fetch folder already exists");
    // the inode kept is a plain folder's (a symlink swapped in after the realpath check would otherwise be "the
    // staging folder" from then on, and every later check would pass through it).
    const staged = lstatSync(p.partial);
    if (staged.isSymbolicLink() || !staged.isDirectory()) throw new Error("the fetch folder is not a plain folder");
    p.partialId = idOf(staged);
  }

  private sendAsk(p: Pending, from?: { file: string; index: number }): boolean {
    return p.session.sendWire({
      t: "fetch.ask", fetchId: p.fetchId, requester: { bot: p.botId }, source: p.source, what: p.what,
      purpose: p.purpose, maxBytes: p.maxBytes, ...(from ? { from } : {}),
    } as WireMessage);
  }

  private async resume(p: Pending, session: FetchPeer): Promise<void> {
    if (p.state !== "lost") return;
    if (p.expected === 0) {
      // L-c: nothing verified yet, so there is no "after this chunk" to resume from. Start again under a new fetchId.
      const oldId = p.fetchId;
      await this.discard(p);
      p.fetchId = randomUUID();
      p.grant = null; p.done = []; p.seen = new Set(); p.total = 0; p.lastFile = null;
      try { this.prepare(p); } catch (error) {
        this.pending.delete(oldId);
        this.removeDest(p);
        this.settle(p, { ok: false, reason: "denied", detail: `cannot prepare the incoming folder: ${String((error as Error)?.message ?? error)}`.slice(0, 500) });
        return;
      }
      this.pending.delete(oldId);
      this.pending.set(p.fetchId, p);
    }
    p.session = session;
    p.state = "asking";
    const from = p.expected > 0 ? { file: p.lastFile!, index: p.expected - 1 } : undefined;
    if (!this.sendAsk(p, from)) { p.state = "lost"; return; }
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  }

  private async handle(p: Pending, message: WireMessage): Promise<void> {
    // A frame that was delivered before the session closed still counts (the queue runs it before any resume).
    if (p.state !== "asking" && p.state !== "lost") return;
    switch (message.t) {
      case "fetch.grant": p.grant = { bytes: message.bytes, files: message.files }; return;
      case "fetch.denied": await this.end(p, { ok: false, reason: message.reason, ...(message.detail ? { detail: message.detail } : {}) }); return;
      case "fetch.chunk": await this.chunk(p, message); return;
      case "fetch.done": await this.finish(p, message); return;
      default: return;
    }
  }

  private corrupt(p: Pending, detail: string): Promise<void> {
    return this.end(p, { ok: false, reason: "corrupt", detail });
  }

  private async chunk(p: Pending, message: WireMessageOf<"fetch.chunk">): Promise<void> {
    // the source sends fetch.grant (its audit receipt) before chunk 0; a chunk before it is not a fetch.
    if (!p.grant) return this.corrupt(p, "a chunk came before fetch.grant");
    if (message.index !== p.expected) return this.corrupt(p, `chunk ${message.index} came where ${p.expected} was due`);
    const bytes = message.bytes;
    if (createHash("sha256").update(bytes).digest("hex") !== message.sha256) return this.corrupt(p, `chunk ${message.index} does not match its SHA-256`);
    // The schema is checked again: this class is also called with frames that never went through the codec.
    const file = FetchRelPath.safeParse(message.file);
    if (!file.success) return this.corrupt(p, "a chunk names a file path that is not allowed");
    const rel = file.data;
    const target = join(p.partial, ...rel.split("/"));
    if (!target.startsWith(p.partial + sep)) return this.corrupt(p, "a chunk names a path outside the fetch folder");

    if (!p.cur || p.cur.rel !== rel) {
      await this.closeCurrent(p);
      const folded = rel.toLowerCase();
      if (p.seen.has(folded)) return this.corrupt(p, `file ${rel} comes twice (or differs only by case)`);
      if (p.done.length + 1 > FETCH_MAX_FILES || (p.grant && p.done.length + 1 > p.grant.files)) return this.corrupt(p, "more files than the grant names");
      p.seen.add(folded);
      // the staging folder is still the one made for this fetch, and every folder under it on the way to the file is
      // made here one at a time and is a plain folder (no symlink planted by the bot; a recursive mkdir would follow
      // one and make folders outside). Compared by inode / lstat, never realpath vs realpath.
      if (!this.makeFolders(p, rel) || !this.stagingIntact(p, rel)) return this.corrupt(p, "a chunk's folder leads out of the fetch folder");
      // O_EXCL: the file is new (fails on anything there, a symlink included); O_NOFOLLOW_ANY (macOS): no symlink on the way.
      const handle = await open(target, NEW_FILE_FLAGS, 0o600);
      // the file opened is the one at `target` (a folder swapped between the check and the open would
      // put it elsewhere): same inode, one link, regular, and (Linux) its real path is `target`. Checked before a byte
      // is written.
      let placed = false;
      try { const st = await handle.stat(); const at = lstatSync(target); placed = st.isFile() && at.isFile() && st.nlink === 1 && idOf(st) === idOf(at) && (!PROC_FD || readlinkSync(`${PROC_FD}/${handle.fd}`) === target) && this.stagingIntact(p, rel); } catch { /* not placed */ }
      if (!placed) { await handle.close().catch(() => undefined); return this.corrupt(p, "a chunk's file did not land in the fetch folder"); }
      p.cur = { rel, handle, hash: createHash("sha256"), size: 0 };
    }
    if (p.total + bytes.length > p.maxBytes) {
      return this.end(p, { ok: false, reason: "limit", detail: "more bytes than the request allows" });
    }
    if (p.grant && p.total + bytes.length > p.grant.bytes) return this.corrupt(p, "more bytes than the grant names");
    await p.cur.handle.write(bytes);
    p.cur.hash.update(bytes);
    p.cur.size += bytes.length;
    p.total += bytes.length;
    p.expected = message.index + 1;
    p.lastFile = rel;
  }

  private async closeCurrent(p: Pending): Promise<void> {
    const cur = p.cur;
    if (!cur) return;
    p.cur = null;
    await cur.handle.close();
    p.done.push({ rel: cur.rel, size: cur.size, sha256: cur.hash.digest("hex") });
  }

  private async finish(p: Pending, message: WireMessageOf<"fetch.done">): Promise<void> {
    await this.closeCurrent(p);
    const files = [...p.done].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const manifest = createHash("sha256").update(files.map((f) => `${f.rel}\t${f.size}\t${f.sha256}\n`).join("")).digest("hex");
    if (manifest !== message.manifest) return this.corrupt(p, "the manifest does not match what arrived");
    if (message.bytes !== p.total) return this.corrupt(p, "the byte count does not match what arrived");
    if (!p.grant || (p.grant.files !== files.length || p.grant.bytes !== p.total)) return this.corrupt(p, "what arrived is not what the grant named");
    p.state = "finishing";
    // verified, so the staging folder becomes `<dest>` in ONE rename inside the same parent folder.
    // Both names go through the same parent, so a swapped parent cannot carry the files anywhere the bot could not
    // already write; `<dest>` must not exist (an empty folder or a link the bot made there is refused).
    if (exists(p.dest)) return this.corrupt(p, "something already sits where the fetch folder goes");
    let intact = false;
    try { const st = lstatSync(p.partial); intact = st.isDirectory() && !st.isSymbolicLink() && idOf(st) === p.partialId; } catch { /* gone */ }
    if (!intact) return this.corrupt(p, "the staging folder was replaced");
    renameSync(p.partial, p.dest);
    const absDest = p.dest;
    const at = this.now();
    try {
      await this.options.store.submit((tx) => {
        putRow(tx, ownTableStream(tx), `audit:${p.fetchId}`, {
          act: "fetch.receive", at, by: p.source, member: p.botId,
          name: `.bot/incoming/${p.srvDir}/${p.fetchId}`.slice(0, 200), size: p.total, hash: manifest,
        });
      });
      this.options.onAudit?.();
    } catch (error) {
      this.log(`fetch: audit row for ${p.fetchId} failed: ${String((error as Error)?.message ?? error)}`);
    }
    this.settle(p, { ok: true, fetchId: p.fetchId, dest: `.bot/incoming/${p.srvDir}/${p.fetchId}`, absDest, files: files.length, bytes: p.total, manifest });
  }

  /** Ends the fetch with a failure: handle closed, `<dest>` removed, the caller told. Safe to call twice. */
  private async end(p: Pending, result: FetchResult): Promise<void> {
    if (p.state === "ended") return;
    await this.discard(p);
    this.settle(p, result);
  }

  private async discard(p: Pending): Promise<void> {
    if (p.cur) { const handle = p.cur.handle; p.cur = null; await handle.close().catch(() => undefined); }
    this.removeDest(p);
  }

  private settle(p: Pending, result: FetchResult): void {
    p.state = "ended";
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    this.pending.delete(p.fetchId);
    p.resolve(result);
  }

  /** The staging folder is the one made for this fetch and every folder from it down to `rel`'s folder is plain. */
  private stagingIntact(p: Pending, rel: string): boolean {
    try {
      const staged = lstatSync(p.partial);
      if (staged.isSymbolicLink() || !staged.isDirectory() || idOf(staged) !== p.partialId) return false;
      const parts = rel.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const st = lstatSync(join(p.partial, ...parts.slice(0, i)));
        if (st.isSymbolicLink() || !st.isDirectory()) return false;
      }
      return true;
    } catch { return false; }
  }

  /** Makes the folders from the staging folder down to `rel`'s folder one at a time; each must be a plain folder. */
  private makeFolders(p: Pending, rel: string): boolean {
    try {
      const staged = lstatSync(p.partial);
      if (staged.isSymbolicLink() || !staged.isDirectory() || idOf(staged) !== p.partialId) return false;
      const parts = rel.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = join(p.partial, ...parts.slice(0, i));
        let st: Stats | null = null;
        try { st = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false; }
        if (!st) { mkdirSync(dir); st = lstatSync(dir); }
        if (st.isSymbolicLink() || !st.isDirectory()) return false;
      }
      return true;
    } catch { return false; }
  }

  /** Removes the fetch folder, and the source folder and `.bot/incoming` when that leaves them empty. */
  private removeDest(p: Pending): void {
    if (!p.dest) return;
    if (p.partial) rmSync(p.partial, { recursive: true, force: true });
    rmSync(p.dest, { recursive: true, force: true });
    for (const dir of [dirname(p.dest), dirname(dirname(p.dest))]) {
      try { rmdirSync(dir); } catch { break; }
    }
  }
}

const idOf = (st: Pick<Stats, "dev" | "ino">): string => `${st.dev}:${st.ino}`;
const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
