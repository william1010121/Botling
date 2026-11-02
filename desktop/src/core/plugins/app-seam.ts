// The `app` seam (plugin-extraction.md §3.2 #6): what botling.dev, the developer tools, asks of the app around the core.
// Privileged: the "app" permission, and only a plugin shipped with Botling (a library plugin of the same name replaces a
// built-in one, so the name alone proves nothing). It carries no logic of its own: the install and restart handshake
// stays here in the core (`installAndRestart` checkpoints running work, starts the script outside the app and asks main
// to quit), while the plugin decides whether and what to install.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../durable/atomic";

/** The app as the developer tools see it (`app.state`). */
export interface AppStateView {
  /** Main's pid (the install script waits for it to quit); null: no app around (tests, a headless core). */
  pid: number | null;
  /** The core's data folder (state, script, log and screenshots live under self-update/) and the app's own data folder. */
  dataDir: string;
  appDataDir: string | null;
  /** The app bundle running now (null: not running from a bundle, as in development). */
  bundle: string | null;
  developerMode: boolean;
  /** The project that is Botling's own source while developer mode is on. */
  developer: { id: string; name: string; folder: string } | null;
}

/** What the core lends the app seam. */
export interface AppWorld {
  state(): AppStateView;
  /** Checkpoints running work, starts the install script detached and asks main to quit; throws (and cancels the checkpoint) when it cannot. */
  installAndRestart(command: string[], log: string): void;
  /** A PNG of the app's window (null: none). */
  captureWindow(): Promise<string | null>;
  /** A card in the main bot's chat; with choices, resolves with the index picked. `source`: the bot it is about. */
  card(text: string, choices: { label: string; recommended?: boolean }[] | undefined, source: string | undefined): Promise<number | null>;
  /** A relay line (`relay`, optionally with files) in a bot's chat or a note it hears at its next wake/turn (`note`); false: no such bot. */
  tell(botId: string, kind: "relay" | "note", text: string, files: string[]): boolean;
}

const str = (max: number) => z.string().max(max);
export const AppCardParams = z.object({
  plugin: str(214), text: str(100_000),
  choices: z.array(z.object({ label: str(200).min(1), recommended: z.boolean().optional() })).max(5).optional(),
  source: str(64).optional(),
});
export const AppTellParams = z.object({ plugin: str(214), bot: str(64), kind: z.enum(["relay", "note"]), text: z.string().min(1).max(100_000), files: z.array(str(4_000)).max(20).optional() });
export const AppInstallParams = z.object({ plugin: str(214), command: z.array(str(8_000)).length(12), log: str(4_000) });
export const AppBriefingParams = z.object({ plugin: str(214), briefing: z.object({ bot: str(64), plain: str(20_000), worktree: str(20_000) }).nullable() });

/**
 * The only command the app starts for a plugin: `nohup bash <data>/self-update/install.sh <pid> <target> <new> <backup> <healthy>
 * <rolled-back> <seconds> <data-dir> <previous>` (twelve words), the script the plugin wrote into the core's own self-update folder.
 */
export function installCommandOK(command: string[], root: string): boolean {
  const script = resolve(root, "self-update", "install.sh");
  return command.length === 12 && command[0] === "/usr/bin/nohup" && command[1] === "/bin/bash" && resolve(command[2]!) === script && /^\d+$/.test(command[3]!);
}

/** The developer briefing the plugin pushed (`app.briefing`), kept on disk so a bot's first wake after a restart already has it. */
export interface DevBriefing { bot: string; plain: string; worktree: string }

export class BriefingBook {
  private by: Record<string, DevBriefing> = {};

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<DevBriefing>>;
      for (const [plugin, entry] of Object.entries(raw)) {
        if (entry && typeof entry.bot === "string" && typeof entry.plain === "string" && typeof entry.worktree === "string") this.by[plugin] = { bot: entry.bot, plain: entry.plain, worktree: entry.worktree };
      }
    } catch { /* unreadable: none kept */ }
  }

  get(plugin: string): DevBriefing | null { return this.by[plugin] ?? null; }

  set(plugin: string, briefing: DevBriefing | null) {
    const before = JSON.stringify(this.by[plugin] ?? null);
    if (briefing) this.by[plugin] = briefing; else delete this.by[plugin];
    if (JSON.stringify(this.by[plugin] ?? null) === before) return;
    try { writeFileAtomic(this.file, JSON.stringify(this.by)); } catch { /* the next change writes it again */ }
  }
}
