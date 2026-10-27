// Change notification for folders the core used to poll (the plugin and component library every 1.5 s,
// bots' memory files every 5 s). The file system tells us when something there changes; `changed` then
// runs once per burst (`debounceMs`). Notifications can be lost (a disk unplugged and plugged in again, a
// watcher that errors, a folder that is not there yet), so a slow reconcile (`reconcileMs`) still runs
// `changed`, re-arms watchers whose folder went away or came back (another inode: an external disk
// remounted), and picks up targets that were added. A target that cannot be watched at all is looked at
// on the old clock (`fallbackMs`), so nothing is noticed later than before.
import { statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname, sep } from "node:path";

export interface WatchTarget {
  /** A folder (watched with its subfolders when `recursive`), or a file (`file: true`: its folder, only that name). */
  path: string;
  recursive?: boolean;
  file?: boolean;
}

export type WatchFunction = (path: string, options: { recursive: boolean; persistent: boolean }, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher;

export interface FolderWatchOptions {
  /** What to watch now (asked at start, at each reconcile and on `sync`). */
  targets: () => WatchTarget[];
  /** Something under a target changed (or a reconcile came round): look again. */
  changed: () => void;
  /** Events within this long make one `changed` (ms). */
  debounceMs?: number;
  /** How often everything is looked at anyway, and watchers checked (ms; 0: never). */
  reconcileMs: number;
  /** How often to look when a target cannot be watched (ms). */
  fallbackMs?: number;
  /** Relative names under a recursive target that never count (default: anything in a .git folder). */
  ignore?: (relative: string) => boolean;
  /** Tests: fs.watch and stat. */
  watch?: WatchFunction;
  identity?: (path: string) => string | null;
  log?: (line: string) => void;
}

interface Armed {
  target: WatchTarget;
  /** The watched folder's dev:ino when armed; a different one later means it was replaced or remounted. */
  identity: string | null;
  watcher: FSWatcher | null;
  /** fs.watch refused it: looked at on the fallback clock. */
  unwatchable: boolean;
}

const defaultIdentity = (path: string): string | null => {
  try { const stat = statSync(path); return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null; } catch { return null; }
};
const defaultIgnore = (relative: string) => relative.split(/[\\/]/).includes(".git");
const keyOf = (target: WatchTarget) => `${target.file ? "f" : target.recursive ? "r" : "d"}:${target.path}`;

export class FolderWatch {
  private armed = new Map<string, Armed>();
  private pending: NodeJS.Timeout | null = null;
  private burstStart: number | null = null;
  private reconcileClock: NodeJS.Timeout | null = null;
  private fallbackClock: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly watch: WatchFunction;
  private readonly identity: (path: string) => string | null;
  private readonly ignore: (relative: string) => boolean;

  constructor(private readonly options: FolderWatchOptions) {
    this.watch = options.watch ?? (fsWatch as unknown as WatchFunction);
    this.identity = options.identity ?? defaultIdentity;
    this.ignore = options.ignore ?? defaultIgnore;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.sync();
    if (this.options.reconcileMs > 0) {
      this.reconcileClock = setInterval(() => this.reconcile(), this.options.reconcileMs);
      this.reconcileClock.unref?.();
    }
  }

  stop() {
    this.stopped = true;
    for (const armed of this.armed.values()) this.close(armed);
    this.armed.clear();
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    this.burstStart = null;
    if (this.reconcileClock) { clearInterval(this.reconcileClock); this.reconcileClock = null; }
    if (this.fallbackClock) { clearInterval(this.fallbackClock); this.fallbackClock = null; }
  }

  /** How many targets have a live watcher (tests, logs). */
  get watching(): number {
    return [...this.armed.values()].filter((armed) => armed.watcher).length;
  }

  /**
   * Brings the watchers in line with `targets()`: new ones armed, gone ones closed. With `verify`, each
   * watched folder is checked to be the same one (same dev:ino) and re-armed when it is not; a target that
   * was missing and is there now is armed. True when anything was (re)armed, i.e. events may have been missed.
   */
  sync(verify = false): boolean {
    if (this.stopped) return false;
    const wanted = new Map<string, WatchTarget>();
    for (const target of this.options.targets()) wanted.set(keyOf(target), target);
    let rearmed = false;
    for (const [key, armed] of this.armed) {
      if (!wanted.has(key)) { this.close(armed); this.armed.delete(key); }
    }
    for (const [key, target] of wanted) {
      const armed = this.armed.get(key);
      if (!armed) { rearmed = this.arm(key, target) || rearmed; continue; }
      if (!verify && (armed.watcher || armed.unwatchable)) continue;
      const now = this.identity(this.folderOf(target));
      if (armed.watcher && now !== null && now === armed.identity) continue;
      // Gone, replaced, remounted, errored or not there before: start again.
      this.close(armed);
      this.armed.delete(key);
      rearmed = this.arm(key, target) || rearmed;
    }
    this.updateFallback();
    return rearmed;
  }

  /** The slow clock: watchers checked, then everything looked at once. */
  reconcile() {
    if (this.stopped) return;
    this.sync(true);
    this.fire();
  }

  private folderOf(target: WatchTarget) {
    return target.file ? dirname(target.path) : target.path;
  }

  private arm(key: string, target: WatchTarget): boolean {
    const folder = this.folderOf(target);
    const identity = this.identity(folder);
    const armed: Armed = { target, identity, watcher: null, unwatchable: false };
    this.armed.set(key, armed);
    // Not there (yet, or its disk is away): the reconcile tries again.
    if (identity === null) return false;
    const name = target.file ? basename(target.path) : null;
    try {
      const watcher = this.watch(folder, { recursive: !!target.recursive && !target.file, persistent: false }, (_event, changed) => {
        const relative = changed === null ? null : String(changed);
        if (name !== null && relative !== null && relative !== name) return;
        if (name === null && relative !== null && this.ignore(relative.split(sep).join("/"))) return;
        this.soon();
      });
      watcher.on("error", (error) => {
        this.options.log?.(`watch ${folder}: ${(error as Error).message}; looked at on the old clock until the next reconcile`);
        this.close(armed);
        // Until the reconcile re-arms it, it is looked at as an unwatchable one is; and once now.
        armed.unwatchable = true;
        this.updateFallback();
        this.soon();
      });
      armed.watcher = watcher;
      return true;
    } catch (error) {
      armed.unwatchable = true;
      this.options.log?.(`watch ${folder}: ${(error as Error).message}; looked at every ${this.options.fallbackMs ?? 1_500} ms instead`);
      return false;
    }
  }

  private close(armed: Armed) {
    try { armed.watcher?.close(); } catch { /* already closed */ }
    armed.watcher = null;
  }

  private updateFallback() {
    const need = [...this.armed.values()].some((armed) => armed.unwatchable);
    if (need && !this.fallbackClock) {
      this.fallbackClock = setInterval(() => this.fire(), this.options.fallbackMs ?? 1_500);
      this.fallbackClock.unref?.();
    } else if (!need && this.fallbackClock) {
      clearInterval(this.fallbackClock);
      this.fallbackClock = null;
    }
  }

  /**
   * A burst of events makes one `changed`: `debounceMs` after the last of them, but never later than four
   * times that after the first (a file written without pause is still looked at).
   */
  private soon() {
    if (this.stopped) return;
    const wait = this.options.debounceMs ?? 250;
    const now = Date.now();
    this.burstStart ??= now;
    if (this.pending) clearTimeout(this.pending);
    const delay = Math.max(0, Math.min(wait, this.burstStart + wait * 4 - now));
    this.pending = setTimeout(() => { this.pending = null; this.burstStart = null; this.fire(); }, delay);
    this.pending.unref?.();
  }

  private fire() {
    if (this.stopped) return;
    try { this.options.changed(); } catch (error) { this.options.log?.(`watch: ${(error as Error).message}`); }
  }
}
