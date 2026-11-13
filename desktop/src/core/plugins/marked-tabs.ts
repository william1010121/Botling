// The bots each plugin's `forRole: "marked"` main-area tab shows for (`ui.showTab`), kept in <data>/plugin-tabs.json as
// { "<plugin>/<view id>": [the core's bot ids] } so a tab a plugin gave a bot is there again after a restart.
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { readJSON } from "../store/bot-store";
import { MARKED_BOTS_MAX } from "./views";

export class MarkedTabs {
  private marks: Record<string, string[]> | null = null;

  constructor(private readonly dataDir: string) {}

  private file() {
    return join(this.dataDir, "plugin-tabs.json");
  }

  private read(): Record<string, string[]> {
    if (this.marks) return this.marks;
    const marks: Record<string, string[]> = {};
    try {
      const value = readJSON(this.file());
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, bots] of Object.entries(value)) {
          if (Array.isArray(bots)) marks[key] = bots.filter((bot): bot is string => typeof bot === "string").slice(0, MARKED_BOTS_MAX);
        }
      }
    } catch { /* a broken file reads as none; it is written anew */ }
    this.marks = marks;
    return marks;
  }

  private write() {
    try { writeFileAtomic(this.file(), JSON.stringify(this.marks ?? {})); } catch { /* kept in memory until the next write */ }
  }

  /** The bots marked for a plugin's tab, oldest first. */
  bots(plugin: string, view: string): string[] {
    return this.read()[`${plugin}/${view}`] ?? [];
  }

  /** Marks (or unmarks) a bot for a plugin's tab; whether anything changed. */
  set(plugin: string, view: string, botId: string, on: boolean): boolean {
    const marks = this.read();
    const key = `${plugin}/${view}`;
    const now = marks[key] ?? [];
    if (on === now.includes(botId)) return false;
    if (on && now.length >= MARKED_BOTS_MAX) throw new Error(`A tab can be shown for at most ${MARKED_BOTS_MAX} bots.`);
    const next = on ? [...now, botId] : now.filter((bot) => bot !== botId);
    if (next.length) marks[key] = next; else delete marks[key];
    this.write();
    return true;
  }

  /** A bot left Botling: no tab is marked for it any more; whether anything changed. */
  forget(botId: string): boolean {
    const marks = this.read();
    let changed = false;
    for (const [key, bots] of Object.entries(marks)) {
      if (!bots.includes(botId)) continue;
      const next = bots.filter((bot) => bot !== botId);
      if (next.length) marks[key] = next; else delete marks[key];
      changed = true;
    }
    if (changed) this.write();
    return changed;
  }
}
