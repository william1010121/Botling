// The process groups plugins started in a utility-process plugin host (Phase 5c; the host side is
// src/host/children.ts). Main keeps them per host and ends them all when that host exits — however
// it went: shut down by the core, killed, crashed — and when the app quits. Each group is also
// written to the core's process ledger (`<data>/core/children.json`, owner: main's pid), so that if
// the whole app dies before it could end them, the next core start ends them (ledger.ts checks the
// leader's start time, so a reused pid is never killed).
//
// The host is untrusted, so what it reports is checked: a positive pid, not main's, the core's or a
// host's own, and only a group whose leader is still alive at report time. It gains nothing it could
// not do itself (it runs as the same user and can signal any of the user's processes).
//
// Windows (unverified): there are no process groups; each reported pid is ended with
// `taskkill /PID <pid> /T /F` (the tree by parent links at that moment). Planned: a Job Object with
// KILL_ON_JOB_CLOSE per host that main assigns each reported pid to.
import { spawn } from "node:child_process";
import { ProcessLedger, processStartTime } from "../core/process/ledger";

const LIMIT = 2_000;

export interface PluginChildrenOptions {
  /** The core's ledger file; none: groups are only ended while main lives. */
  ledgerFile?: string;
  /** Pids that are never a plugin's group (main, the core, the hosts). */
  protectedPids?: () => number[];
  platform?: NodeJS.Platform;
  log?: (text: string) => void;
}

export class PluginChildren {
  private readonly groups = new Map<number, Set<number>>();
  private readonly ledger: ProcessLedger | null;
  private readonly platform: NodeJS.Platform;
  /** Each leader's start time, once looked up: a pid reused by another group leader is never signalled. */
  private readonly started = new Map<number, string>();

  constructor(private readonly options: PluginChildrenOptions = {}) {
    this.ledger = options.ledgerFile ? new ProcessLedger(options.ledgerFile) : null;
    this.platform = options.platform ?? process.platform;
  }

  /** The groups kept for a host now (for tests). */
  of(host: number): number[] { return [...(this.groups.get(host) ?? [])]; }

  /** A host reported a child it started (its pid leads the child's group). */
  add(host: number, pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
    if (pid === process.pid || (this.options.protectedPids?.() ?? []).includes(pid)) return;
    if (!alive(pid)) return;
    let set = this.groups.get(host);
    if (!set) { set = new Set(); this.groups.set(host, set); }
    if (set.has(pid)) return;
    if (set.size >= LIMIT) this.prune(host, set);
    if (set.size >= LIMIT) { this.options.log?.(`plugin host ${host} started over ${LIMIT} processes at once; not keeping more`); return; }
    set.add(pid);
    if (this.platform !== "win32") {
      // `ps` for the leader's start time: off main's current task (the host may start many at once).
      setImmediate(() => {
        if (!set!.has(pid)) return;
        const started = processStartTime(pid);
        if (started) this.started.set(pid, started);
        try { this.ledger?.record(pid); } catch { /* best effort */ }
      });
    }
  }

  private readonly ending = new Set<Promise<void>>();

  /** Ends every group a host started (SIGTERM now, SIGKILL after `graceMs` to what is left). Resolves when done. */
  end(host: number, graceMs = 1_000): Promise<void> {
    const ending = this.ending_(host, graceMs);
    this.ending.add(ending);
    void ending.finally(() => this.ending.delete(ending));
    return ending;
  }

  private ending_(host: number, graceMs: number): Promise<void> {
    const set = this.groups.get(host);
    this.groups.delete(host);
    if (!set?.size) return Promise.resolve();
    // Only groups that are still this host's: gone ones are skipped, and so is a live leader whose start
    // time differs (its pid was reused). A group whose leader is gone is still ours: POSIX does not
    // reuse a pid while a process group of that id exists.
    const pids = [...set].filter((pid) => {
      const recorded = this.started.get(pid);
      this.started.delete(pid);
      if (this.platform === "win32") return alive(pid);
      if (!groupExists(pid)) { try { this.ledger?.forget(pid); } catch { /* best effort */ } return false; }
      if (recorded && alive(pid)) {
        const now = processStartTime(pid);
        if (now && now !== recorded) return false;
      }
      return true;
    });
    if (!pids.length) return Promise.resolve();
    this.options.log?.(`ending ${pids.length} process group${pids.length === 1 ? "" : "s"} plugin host ${host} started`);
    if (this.platform === "win32") {
      return Promise.all(pids.map((pid) => taskkill(pid))).then(() => {});
    }
    for (const pid of pids) signal(pid, "SIGTERM");
    return new Promise((resolve) => {
      const finish = () => {
        for (const pid of pids) {
          signal(pid, "SIGKILL");
          try { this.ledger?.forget(pid); } catch { /* best effort */ }
        }
        resolve();
      };
      if (graceMs <= 0 || pids.every((pid) => !groupExists(pid))) { finish(); return; }
      const started = Date.now();
      const timer = setInterval(() => {
        if (pids.every((pid) => !groupExists(pid)) || Date.now() - started >= graceMs) { clearInterval(timer); finish(); }
      }, 50);
    });
  }

  /** Ends every host's groups (the app quits). */
  endAll(graceMs = 500): Promise<void> {
    // Also waits for hosts already being ended (their SIGKILL comes after the grace).
    return Promise.all([...this.ending, ...[...this.groups.keys()].map((host) => this.end(host, graceMs))]).then(() => {});
  }

  /** Forgets groups that are gone (so a long-running host's list stays short). */
  private prune(host: number, set: Set<number>) {
    for (const pid of set) {
      if (this.platform === "win32" ? !alive(pid) : !groupExists(pid)) {
        set.delete(pid);
        this.started.delete(pid);
        try { this.ledger?.forget(pid); } catch { /* best effort */ }
      }
    }
    if (!set.size) this.groups.delete(host);
  }
}

function signal(pgid: number, name: NodeJS.Signals) {
  try { process.kill(-pgid, name); } catch { /* the group is gone */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const kill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    kill.once("exit", () => resolve());
    kill.once("error", () => resolve());
  });
}
