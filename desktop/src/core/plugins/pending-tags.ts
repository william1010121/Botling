// Reply tags that could not be handed to their plugin yet (plugin-extraction.md W5): the host is not running, or
// has not loaded the plugin (Botling just started, the plugin was off or crashed and restarts). A tag leaves the
// reply text the moment it is read, so one dropped here is lost for good; instead the last one for each plugin,
// tag and bot is kept on disk until the plugin is loaded, and then handed over (once) in the order they came.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../durable/atomic";

export interface HeldTag {
  bot: { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean };
  tag: string;
  attributes: Record<string, string>;
  body: string;
  /** When it was held (epoch ms). */
  at: number;
}

/** The most one plugin may have held, the longest body kept, and how long a held tag waits for its plugin. */
export const HELD_MOST = 500;
export const HELD_BODY_MAX = 600_000;
export const HELD_DAYS = 30;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class PendingTags {
  private held: Record<string, HeldTag[]> = {};

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!isObject(raw)) return;
      for (const [plugin, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        const kept = list.flatMap((entry): HeldTag[] => {
          if (!isObject(entry) || !isObject(entry.bot) || typeof entry.bot.id !== "string" || typeof entry.tag !== "string" || typeof entry.body !== "string") return [];
          const attributes = isObject(entry.attributes) ? Object.fromEntries(Object.entries(entry.attributes).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {};
          return [{ bot: entry.bot as unknown as HeldTag["bot"], tag: entry.tag, attributes, body: entry.body.slice(0, HELD_BODY_MAX), at: typeof entry.at === "number" ? entry.at : 0 }];
        });
        if (kept.length) this.held[plugin] = kept.slice(-HELD_MOST);
      }
    } catch { /* unreadable: none held */ }
  }

  /** Holds a tag for `plugin`; it replaces the one held for the same tag and bot (the last one counts). */
  hold(plugin: string, bot: HeldTag["bot"], tag: { tag: string; attributes: Record<string, string>; body: string }) {
    const list = (this.held[plugin] ?? []).filter((entry) => !(entry.tag === tag.tag && entry.bot.id === bot.id));
    list.push({ bot, tag: tag.tag, attributes: tag.attributes, body: tag.body.slice(0, HELD_BODY_MAX), at: this.now() });
    this.held[plugin] = list.slice(-HELD_MOST);
    this.save();
  }

  /** Whether anything is held for `plugin`. */
  has(plugin: string): boolean {
    return (this.held[plugin]?.length ?? 0) > 0;
  }

  /** What is held for `plugin` (older than HELD_DAYS dropped), oldest first; emptied from the disk too. */
  take(plugin: string): HeldTag[] {
    const list = this.held[plugin] ?? [];
    if (!list.length) return [];
    delete this.held[plugin];
    this.save();
    const oldest = this.now() - HELD_DAYS * 86_400_000;
    return list.filter((entry) => entry.at >= oldest);
  }

  private save() {
    const rest = Object.fromEntries(Object.entries(this.held).filter(([, list]) => list.length));
    try { writeFileAtomic(this.file, JSON.stringify(rest)); } catch { /* the next hold writes it again */ }
  }
}
