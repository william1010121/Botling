// Cheap startup timestamps (no Electron here, so it is testable and the core could share it): each launch
// appends one JSON line per milestone to `startup.log` in the app's log folder, with how long after the
// process began it came. Milestones are written once each per launch; the file is kept small.
//
//   {"launch":"…","mark":"app.ready","ms":412,"at":"2026-10-27T11:02:03.456Z","pid":123}
//
// Main's milestones: process.entry, app.ready (whenReady), recovery.done, core.spawn, core.ready (the
// core's first message), window.loaded (the shell's document), snapshot.first (the first chat.snapshot
// answered to a page), window.shown (first paint: the window revealed). The core adds core.loaded (its
// bots and their chats read: `BOTLING_STARTUP_LOG`), with its own process's start as origin.
import { appendFile, mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The log is cut back to its newer half past this size. */
export const STARTUP_LOG_MAX_BYTES = 128 * 1024;

export interface StartupMarksOptions {
  /** The log file (`<logs>/startup.log`); null: kept in memory only. */
  file: string | null;
  /** When the process began, in epoch ms (default: now − process.uptime()). */
  origin?: number;
  now?: () => number;
  pid?: number;
}

export class StartupMarks {
  readonly launch: string;
  readonly origin: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private file: string | null;
  private writing: Promise<void> = Promise.resolve();
  /** The folder made and the log trimmed (before the first line of this launch). */
  private prepared = false;

  constructor(private readonly options: StartupMarksOptions) {
    this.now = options.now ?? Date.now;
    this.origin = options.origin ?? Math.round(this.now() - process.uptime() * 1000);
    this.launch = `${new Date(this.origin).toISOString()}-${options.pid ?? process.pid}`;
    this.file = options.file;
  }

  /** Where the log goes; until set (the log folder is known a little later) marks are kept and written then. */
  setFile(file: string) {
    if (this.file) return;
    this.file = file;
    for (const [mark, at] of this.seen) this.write(mark, at, undefined);
  }

  /** A milestone, once per launch; later calls of the same name are ignored. Returns ms since the process began. */
  mark(name: string, detail?: Record<string, string | number | boolean>): number | null {
    if (this.seen.has(name)) return null;
    const at = this.now();
    this.seen.set(name, at);
    if (this.file) this.write(name, at, detail);
    return at - this.origin;
  }

  /** The milestones so far, ms since the process began (tests, diagnostics). */
  marks(): Record<string, number> {
    return Object.fromEntries([...this.seen].map(([name, at]) => [name, at - this.origin]));
  }

  /** Waits for what was written so far (tests, quitting). */
  flush(): Promise<void> {
    return this.writing;
  }

  private write(mark: string, at: number, detail: Record<string, string | number | boolean> | undefined) {
    const file = this.file!;
    const line = JSON.stringify({ launch: this.launch, mark, ms: at - this.origin, at: new Date(at).toISOString(), pid: this.options.pid ?? process.pid, ...(detail ? { detail } : {}) }) + "\n";
    const first = !this.prepared;
    this.prepared = true;
    this.writing = this.writing.then(() => new Promise<void>((resolve) => {
      try {
        if (first) {
          mkdirSync(dirname(file), { recursive: true });
          trim(file);
        }
      } catch { /* the log is best effort */ }
      appendFile(file, line, { mode: 0o600 }, () => resolve());
    }));
  }
}

/** Keeps the log under STARTUP_LOG_MAX_BYTES: past it, only the newer half (whole lines) is kept. */
export function trim(file: string) {
  let size = 0;
  try { size = statSync(file).size; } catch { return; }
  if (size <= STARTUP_LOG_MAX_BYTES) return;
  const text = readFileSync(file, "utf8");
  const half = text.slice(text.length - Math.floor(STARTUP_LOG_MAX_BYTES / 2));
  const cut = half.indexOf("\n");
  writeFileSync(file, cut >= 0 ? half.slice(cut + 1) : "", { mode: 0o600 });
}
