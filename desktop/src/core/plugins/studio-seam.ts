// The `studio` seam (plugin-extraction.md §3.2 #4): what botling.component-studio, the component studio ("Make into component",
// <suggest-component>, the spec workspace), asks of the core. Privileged like the `app` seam: the "studio" permission, and
// only a plugin shipped with Botling. It carries no studio logic of its own. The specs themselves stay where the core always
// kept them (specs.json beside each chat, 1.x's format, so the import and a restart behave as before): the plugin reads and
// writes the whole list of a chat (`specs`, `writeSpecs`), and asks for the few things only the core can do: hand Maintainer
// a job, put a component on a bot's list or take it off, run an allowed command, ask the bot that wrote a reply a quiet question.
import { z } from "zod";
import type { GuestAnswer } from "../bot";

/** A chat (a bot's) as the studio sees it; `id` is the bot's id as plugins name it ("main" for the main bot). */
export interface StudioChat {
  id: string;
  name: string;
  /** Its working folder (absolute). */
  folder: string;
  /** A turn is under way in it. */
  working: boolean;
  /** Its component list (null: it keeps none) and the names on it that are in the library. */
  components: string[] | null;
  own: string[];
}

/** A line of a chat with what the studio needs around it (`studio.line`). */
export interface StudioLine {
  /** The line as chat.json keeps it. */
  record: Record<string, unknown>;
  /** The user's own words that led to it (the last line of theirs before it), if any. */
  asked: string | null;
  /** Its result pages' preview cards (what the chat shows under it). */
  previews: string[] | null;
  /** Its first line, at most 60 characters (what a reply to it quotes). */
  preview: string;
  /** The ids of the lines since the user's last one: the turn it is in. */
  turn: string[];
}

/** A library component as the studio reads it (the library itself is the core's). */
export interface StudioLibraryEntry {
  version: number;
  command: string | null;
  detailCommand: string | null;
  /** The first line of its about.md, and the whole of it (`summaries`, `catalog`). */
  summary: string;
  catalog: string;
  /** Its template and the rest of what the page draws it with (only for the names asked). */
  info?: { template: string; version: number; updated: boolean; working: boolean; hasPrevious: boolean; sizes: string[]; icon: string | null; title: string | null } | null;
}
export interface StudioLibrary { names: string[]; entries: Record<string, StudioLibraryEntry> }

export interface StudioCommandState { status: "approve" | "idle" | "running" | "done" | "failed"; data: string | null; error: string | null; ranAt: number | null }

/** What the core lends the studio seam. */
export interface StudioWorld {
  /** Every chat a spec can be in, in the left column's order (`chatsWithPins`). */
  chats(): StudioChat[];
  /** One bot's chat by id, or the one whose name is `name` (a bot a component can go to, Maintainer left out). */
  chat(id: string): StudioChat | null;
  /** The names of the bots a component can go to. */
  componentBots(): string[];
  /** Maintainer's id and whether it is at work (null: there is none). */
  maintainer(): { id: string; working: boolean } | null;
  /** A line by id, or the newest line of a bot's own (`last: "bot"`). null: no such chat or line. */
  line(botId: string, query: { id: string } | { last: "bot" }): StudioLine | null;
  /** Every chat's specs, as specs.json has them (chats with none left out). */
  specs(): Record<string, unknown[]>;
  /** A chat's whole list of specs (saved if it differs from what is kept). Returns whether anything changed. */
  writeSpecs(botId: string, specs: unknown[]): boolean;
  library(withInfo: string[]): StudioLibrary;
  /** The library's working state for a component (`change`: what is being done; null: done). */
  working(name: string, change: string | null): void;
  /** Gives Maintainer a job (`handToMaintainer`). */
  handTo(text: string): void;
  /** The bot a component list belongs to, by its name (`holder`). */
  holder(name: string): StudioChat | null;
  give(name: string, botId: string): boolean;
  unlist(name: string, botId: string): boolean;
  /** A note the bot hears with its next message, and a line the app says in its chat. */
  note(botId: string, text: string): void;
  notice(botId: string, text: string): void;
  /** A quiet turn of a bot's (`groupTurn`): waits up to `waitMs` for it to be free, then `answerMs` for its answer. */
  ask(botId: string, text: string, waitMs: number, answerMs: number): Promise<GuestAnswer>;
  commands: {
    isApproved(command: string, folder: string): boolean;
    isDetailApproved(detail: string | null, folder: string): boolean;
    run(card: string, command: string, folder: string, force: boolean): Promise<void>;
    state(card: string, command: string, detail: string | null, folder: string): StudioCommandState;
    runOf(card: string, command: string, folder: string): StudioCommandState | null;
    lastRan(card: string): number | null;
    /** The user allowed `command` (and the Detail command `detail`) in `folder` on the app page's ApprovalSheet: the core records it. Never reachable from a plugin's own asks. */
    approve(command: string, folder: string, detail: string | null): void;
  };
}

const str = (max: number) => z.string().max(max);
const Plugin = { plugin: str(214) };
const BotId = str(128).min(1);
export const StudioParams = {
  "studio.chats": z.object(Plugin),
  "studio.chat": z.object({ ...Plugin, bot: BotId }),
  "studio.componentBots": z.object(Plugin),
  "studio.maintainer": z.object(Plugin),
  "studio.line": z.object({ ...Plugin, bot: BotId, id: str(200).min(1).optional(), last: z.literal("bot").optional() }),
  "studio.specs": z.object(Plugin),
  "studio.writeSpecs": z.object({ ...Plugin, bot: BotId, specs: z.array(z.record(z.string(), z.unknown())).max(2_000) }),
  "studio.library": z.object({ ...Plugin, withInfo: z.array(str(200)).max(20).optional() }),
  "studio.working": z.object({ ...Plugin, name: str(200).min(1), change: str(2_000).nullable() }),
  "studio.handTo": z.object({ ...Plugin, text: str(400_000).min(1) }),
  "studio.holder": z.object({ ...Plugin, name: str(400).min(1) }),
  "studio.give": z.object({ ...Plugin, name: str(200).min(1), bot: BotId }),
  "studio.unlist": z.object({ ...Plugin, name: str(200).min(1), bot: BotId }),
  "studio.note": z.object({ ...Plugin, bot: BotId, text: str(20_000).min(1) }),
  "studio.notice": z.object({ ...Plugin, bot: BotId, text: str(20_000).min(1) }),
  "studio.ask": z.object({ ...Plugin, bot: BotId, text: str(400_000).min(1), waitMs: z.number().int().min(0).max(24 * 3_600_000), answerMs: z.number().int().min(1).max(3_600_000) }),
  "studio.isApproved": z.object({ ...Plugin, command: str(20_000).min(1), folder: str(4_000).min(1) }),
  "studio.isDetailApproved": z.object({ ...Plugin, detail: str(20_000).nullable(), folder: str(4_000).min(1) }),
  "studio.run": z.object({ ...Plugin, card: str(300).min(1), command: str(20_000).min(1), folder: str(4_000).min(1), force: z.boolean() }),
  "studio.commandState": z.object({ ...Plugin, card: str(300).min(1), command: str(20_000).min(1), detail: str(20_000).nullable(), folder: str(4_000).min(1) }),
  "studio.runOf": z.object({ ...Plugin, card: str(300).min(1), command: str(20_000).min(1), folder: str(4_000).min(1) }),
  "studio.lastRan": z.object({ ...Plugin, card: str(300).min(1) }),
} as const;
export type StudioMethod = keyof typeof StudioParams;
export const isStudioMethod = (method: string): method is StudioMethod => Object.hasOwn(StudioParams, method);

/** Answers one `studio.*` request (its params are already checked against `StudioParams`). */
export async function studioAnswer(world: StudioWorld, method: StudioMethod, raw: unknown): Promise<unknown> {
  const missing = (what: string) => new Error(`No such ${what}.`);
  switch (method) {
    case "studio.chats": return world.chats();
    case "studio.chat": return world.chat((raw as { bot: string }).bot);
    case "studio.componentBots": return world.componentBots();
    case "studio.maintainer": return world.maintainer();
    case "studio.line": {
      const data = raw as { bot: string; id?: string; last?: "bot" };
      if (!world.chat(data.bot)) throw missing("bot");
      return world.line(data.bot, data.id !== undefined ? { id: data.id } : { last: "bot" });
    }
    case "studio.specs": return world.specs();
    case "studio.writeSpecs": {
      const data = raw as { bot: string; specs: unknown[] };
      if (!world.chat(data.bot)) throw missing("bot");
      return { changed: world.writeSpecs(data.bot, data.specs) };
    }
    case "studio.library": return world.library((raw as { withInfo?: string[] }).withInfo ?? []);
    case "studio.working": { const data = raw as { name: string; change: string | null }; world.working(data.name, data.change); return null; }
    case "studio.handTo": world.handTo((raw as { text: string }).text); return null;
    case "studio.holder": return world.holder((raw as { name: string }).name);
    case "studio.give": { const data = raw as { name: string; bot: string }; return world.give(data.name, data.bot); }
    case "studio.unlist": { const data = raw as { name: string; bot: string }; return world.unlist(data.name, data.bot); }
    case "studio.note": { const data = raw as { bot: string; text: string }; world.note(data.bot, data.text); return null; }
    case "studio.notice": { const data = raw as { bot: string; text: string }; world.notice(data.bot, data.text); return null; }
    case "studio.ask": { const data = raw as { bot: string; text: string; waitMs: number; answerMs: number }; return world.ask(data.bot, data.text, data.waitMs, data.answerMs); }
    case "studio.isApproved": { const data = raw as { command: string; folder: string }; return world.commands.isApproved(data.command, data.folder); }
    case "studio.isDetailApproved": { const data = raw as { detail: string | null; folder: string }; return world.commands.isDetailApproved(data.detail, data.folder); }
    case "studio.run": { const data = raw as { card: string; command: string; folder: string; force: boolean }; await world.commands.run(data.card, data.command, data.folder, data.force); return null; }
    case "studio.commandState": { const data = raw as { card: string; command: string; detail: string | null; folder: string }; return world.commands.state(data.card, data.command, data.detail, data.folder); }
    case "studio.runOf": { const data = raw as { card: string; command: string; folder: string }; return world.commands.runOf(data.card, data.command, data.folder); }
    case "studio.lastRan": return world.commands.lastRan((raw as { card: string }).card);
  }
}
