// What the core keeps of the app replacing itself, now that the developer tools (`<install-build>`, `<app-screenshot/>`,
// the install script and rolling back) are the built-in plugin botling.dev (builtin-plugins/botling.dev):
//  - the restart handshake: a new build says it came up by writing `healthy` once it has run HEALTHY_AFTER_MS. That
//    stays here, since it must not depend on the plugin host (a plugin turned off or slow to load would have the
//    install script put the old build back over a build that works). The plugin tells the bot that asked, afterwards;
//  - newer signed releases (main/updates.ts): an update notice in the main bot's chat, in developer mode only.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** How long a new build must have run before it counts as up (the install script waits HEALTH_WAIT_S for that). */
export const HEALTHY_AFTER_MS = 8_000;

export const updateFolder = (root: string) => join(root, "self-update");
const stateFile = (root: string) => join(updateFolder(root), "state.json");
const healthyFile = (root: string) => join(updateFolder(root), "healthy");
const rolledBackFile = (root: string) => join(updateFolder(root), "rolled-back");
const declinedFile = (root: string) => join(updateFolder(root), "declined-release");

/**
 * At start: an install is under way (the script left its state, and did not roll back). The new build counts as up once
 * it has run `afterMs`; then `healthy` is written, which the script waits for. The state stays for botling.dev, which
 * tells the bot that asked how it went. Returns the timer (null: no install under way).
 */
export function confirmHealthy(root: string, afterMs = HEALTHY_AFTER_MS): NodeJS.Timeout | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(root), "utf8")) as { from?: { path?: unknown }; to?: { path?: unknown }; requesterID?: unknown };
    if (!state?.from?.path || !state?.to?.path || typeof state.requesterID !== "string") return null;
  } catch { return null; }
  if (existsSync(rolledBackFile(root))) return null;
  const timer = setTimeout(() => {
    try {
      mkdirSync(updateFolder(root), { recursive: true });
      writeFileSync(healthyFile(root), "ok\n");
    } catch { /* the script rolls back; the plugin tells why */ }
  }, afterMs);
  timer.unref?.();
  return timer;
}

/** The external volume a path is on (`/Volumes/<name>`), or null when it is on this Mac's own disk. */
export function externalVolume(path: string): string | null {
  const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(resolve(path));
  return match ? join("/Volumes", match[1]!) : null;
}

/** Whether a folder is there: on an external volume only when that volume is mounted (not an empty /Volumes stub). */
export function folderAvailable(path: string): boolean {
  const volume = externalVolume(path);
  try {
    if (volume && statSync(volume).dev === statSync("/Volumes").dev) return false;
    return statSync(path).isDirectory();
  } catch { return false; }
}

/** The external work drive's folder for development (BOTLING_DEV_WORK_DIR; Botling's maintainers use /Volumes/My-SSD/botling-work). */
export const DEV_WORK_DIR = "/Volumes/My-SSD/botling-work";

/** Where developer work (worktrees, builds) goes: the work drive's folder when it is there, else null (beside the project). */
export function devWorkRoot(env: Record<string, string | undefined> = process.env, available = folderAvailable): string | null {
  const dir = env.BOTLING_DEV_WORK_DIR?.trim() || DEV_WORK_DIR;
  return dir.startsWith("/") && available(dir) ? resolve(dir) : null;
}

/** The release the user said Not now to (it is not announced again). */
export function declinedRelease(root: string): string | null {
  try { return readFileSync(declinedFile(root), "utf8").trim() || null; } catch { return null; }
}

function setDeclinedRelease(root: string, version: string) {
  mkdirSync(updateFolder(root), { recursive: true });
  writeFileSync(declinedFile(root), `${version}\n`);
}

/** A newer signed release main found (main/updates.ts), to announce in the main bot's chat. */
export interface ReleaseNotice {
  version: string;
  name: string;
  url: string;
  /** The version running now. */
  current: string;
  /** Null: it can be installed from here; else why not (open the release page instead). */
  unavailable: string | null;
}

/** The main bot's chat, as far as a release notice needs it. */
export interface NoticeBot {
  appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void, more?: { sourceID?: string }): string;
}

export interface ReleaseNoticeDeps {
  /** The core's data folder (self-update/declined-release). */
  root: string;
  /** Whether developer mode is on (Settings → Developer). The chat notice is shown only then. */
  developerMode: () => boolean;
  mainBot: () => NoticeBot;
  /** Main downloads the newer release and restarts on it (`main/updates.ts`). */
  installRelease?: () => Promise<{ ok: boolean; error?: string }>;
  log: (line: string) => void;
}

export class ReleaseNotices {
  constructor(private deps: ReleaseNoticeDeps) {}

  /** Releases announced in this run (a card does not outlive a restart, so the next run announces again). */
  private announced = new Set<string>();

  /**
   * A newer release: an update notice in the main bot's chat, like a build card. Nothing is
   * installed until the user picks Install and restart there; then the app installs it and restarts on it.
   * Not now is remembered for that version.
   */
  announce(release: ReleaseNotice): string | null {
    // Everyone else updates from the sidebar entry (renderer/UpdateEntry.tsx); the chat notice is for developers.
    if (!this.deps.developerMode()) return null;
    if (this.announced.has(release.version) || declinedRelease(this.deps.root) === release.version) return null;
    this.announced.add(release.version);
    const main = this.deps.mainBot();
    const lines = [`**Botling ${release.version}** is available (running ${release.current}).`, "", `[${release.name}](${release.url})`];
    if (release.unavailable || !this.deps.installRelease) {
      lines.push("", `It can't be installed from here: ${release.unavailable ?? "this Botling cannot replace itself."}`);
      return main.appNotice(lines.join("\n"));
    }
    lines.push("", "Bots save their original conversations and unfinished work before restart. Supported work resumes automatically; pending permissions or uncertain execution stay paused for reconciliation.");
    return main.appNotice(lines.join("\n"), [
      { label: "Install and restart", recommended: true },
      { label: "Not now" },
    ], (index) => this.answer(release, index === 0));
  }

  /** Your pick on a release card. */
  answer(release: ReleaseNotice, install: boolean) {
    if (!install) { setDeclinedRelease(this.deps.root, release.version); return; }
    const installRelease = this.deps.installRelease;
    if (!installRelease) return;
    this.deps.log(`installing release ${release.version}`);
    const failed = (why: string) => {
      this.announced.delete(release.version);
      this.deps.mainBot().appNotice(`Couldn't install Botling ${release.version}: ${why}`);
    };
    void installRelease().then((answer) => { if (!answer.ok) failed(answer.error ?? "it did not start."); }, (error) => failed((error as Error).message));
  }
}

/** Starts the install script detached from the core (its output in the install log); it outlives the app. */
export function spawnInstaller(command: string[], log: string) {
  mkdirSync(join(log, ".."), { recursive: true });
  const out = openSync(log, "a");
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", out, out] });
  child.unref();
}
