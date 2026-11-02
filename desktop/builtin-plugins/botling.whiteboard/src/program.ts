// botling.whiteboard's program part (runs in the plugin host): what the board's frame asks for. It shapes the
// workspace into a `BoardView` (data the core used to put together for `whiteboard.view`), keeps each bot's
// picture (the <whiteboard> tag) in the plugin's own storage and runs its command again while the board is shown.
// The workspace is read only when it changed (`workspace.onChange`, listened to only while the board is being
// looked at), so a board nobody changes costs the host nothing between asks. Running a command the user allowed
// is Botling's (`approvals.run`: a time limit, an output cap, the process ledger); allowing is the user's alone
// (the frame's `requestApproval`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotlingApi, BotSummary, ReplyTag } from "../../../../Web/host/src/api";
import { botDescription, latestAction } from "./data";
import type { Approval, BoardView, Bot, Entry, Lang, Look, Picture, Task, Waiting } from "./types";

/** The most a picture's data may be (as `ccb.save`'s), as JSON characters. */
export const PICTURE_DATA_LIMIT = 256_000;
/** A picture's command runs again when the board is shown, at most this often (ms). */
export const SHOWN_COOLDOWN_MS = 30_000;
/** The board is looked at while its frame asked within this long (ms); then the host stops listening for changes. */
export const SHOWN_FOR_MS = 20_000;
/** The key of a picture's command runs (the core keeps them under the plugin's name). */
const RUN_KEY = "picture";

/** A bot's picture as the plugin keeps it (the shape of whiteboard.json, which it imports). */
export interface PictureRecord { name: string; data: string; command?: string; size: "1x1" | "2x1"; savedAt: number }

/** whiteboard.json's content as a record, or null when it is not one (as the core read it). */
export function readPicture(value: unknown): PictureRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name || typeof raw.data !== "string") return null;
  return {
    name: raw.name, data: raw.data, ...(typeof raw.command === "string" && raw.command ? { command: raw.command } : {}),
    size: raw.size === "2x1" ? "2x1" : "1x1", savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
  };
}

/** What the program part needs besides the api (so tests can give it). */
export interface Deps {
  now(): number;
  /** A bot's whiteboard.json from before this plugin, as parsed; null: none. */
  legacy(botId: string): unknown;
  /** The frame has not asked for this long: stop listening (a timer; tests run it by hand). */
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

/** whiteboard.json files of Botling's data folder: a project bot's or a bot of its own's (the plugin's storage is two folders below the data folder). */
export function legacyReader(storageDir: string): Deps["legacy"] {
  const data = dirname(dirname(storageDir));
  return (botId) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(botId)) return null;
    for (const folder of ["projects", "bots"]) {
      const file = join(data, folder, botId, "whiteboard.json");
      if (!existsSync(file)) continue;
      try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
    }
    return null;
  };
}

const looks: readonly Look[] = ["original", "cute"];
const toBot = (summary: BotSummary): Bot => ({
  id: summary.id, name: summary.name, role: summary.role, folder: summary.folder, job: summary.job, phase: summary.asleep ? "asleep" : "awake",
  working: summary.busy, subagents: summary.subagents, guest: summary.guest, approvals: summary.approvals, lastActivity: summary.lastActivity,
});

export class Program {
  private pictures: Record<string, PictureRecord>;
  /** The workspace as last read, until something changes. */
  private read: { look: Look; bots: BotSummary[]; waiting: Waiting; entries: Entry[]; faces: Record<string, string> } | null = null;
  private dirty = true;
  private listening: (() => void) | null = null;
  private idle: { cancel(): void } | null = null;
  private lastText = "";
  private counter = 0;
  private readonly epoch: string;
  private faces = new Map<string, string>();
  /** A build at a time: asks that come meanwhile wait for its result. */
  private building: Promise<BoardView> | null = null;

  constructor(private readonly api: BotlingApi, private readonly deps: Deps) {
    this.epoch = String(deps.now());
    const kept = api.storage.get("pictures");
    this.pictures = kept && typeof kept === "object" && !Array.isArray(kept) ? { ...(kept as Record<string, PictureRecord>) } : {};
  }

  /** Listens for what bots say, and opens the methods the frame calls. */
  start() {
    const { api } = this;
    api.subscriptions.push(api.replyTags.on("whiteboard", (tag) => { void this.tag(tag).catch(() => {}); }));
    api.subscriptions.push(
      api.ui.expose("board", (params) => this.board((params as { since?: string } | null)?.since)),
      api.ui.expose("ignore", async (params) => {
        const { botId, text } = params as { botId: string; text: string };
        await api.workspace.ignoreWaiting(String(botId), String(text));
        this.dirty = true;
        return null;
      }),
      api.ui.expose("send", async (params) => {
        const text = String((params as { text?: unknown } | null)?.text ?? "").trim();
        if (!text) throw new Error("Nothing to send.");
        await api.bots.send("main", text, { as: "user" });
        return null;
      }),
      api.ui.expose("run", async (params) => {
        await this.run(String((params as { botId?: unknown } | null)?.botId ?? ""));
        return null;
      }),
      api.ui.expose("shelf", (params) => {
        api.storage.set("shelfOpen", (params as { open?: unknown } | null)?.open === true);
        return null;
      }),
    );
    api.subscriptions.push(() => { this.stopListening(); });
  }

  // ------------------------------------------------------------------------------------------
  // <whiteboard> in a reply

  /**
   * A bot's `<whiteboard name="x" size="2x1">JSON</whiteboard>` (or command="…" instead of JSON, or <whiteboard clear/>), as the core
   * read it: kept when its component is in the library (the command: the tag's, else the component's "Command:" line), the picture
   * before otherwise; nothing is drawn in the chat for it. The main bot has no card.
   */
  async tag(tag: ReplyTag): Promise<void> {
    const botId = tag.bot.id;
    if (tag.bot.role === "main") return;
    const { name: rawName, size, command: rawCommand, ...rest } = tag.attributes;
    const name = (rawName ?? "").trim();
    const body = tag.body.trim();
    // <whiteboard clear/>: a tag with nothing in it (the reply parser drops a bare `clear`).
    if (!name && !body && !rawCommand?.trim() && !Object.keys(rest).length) {
      if (this.pictures[botId]) { delete this.pictures[botId]; this.save(); }
      return;
    }
    if (!name) return;
    if (body) { try { JSON.parse(body); } catch { return; } }
    const data = body || "null";
    const entry = await this.api.workspace.component(botId, name, { data, ...(rawCommand?.trim() ? { command: rawCommand.trim() } : {}) });
    if (!entry.exists) return;
    this.pictures[botId] = {
      name, data: data.length > PICTURE_DATA_LIMIT ? "null" : data, ...(entry.command ? { command: entry.command } : {}),
      size: size?.trim() === "2x1" ? "2x1" : "1x1", savedAt: this.deps.now(),
    };
    this.save();
  }

  private save() {
    this.api.storage.set("pictures", this.pictures);
    this.dirty = true;
  }

  /** "Allow and run" was pressed on the app page's sheet for this bot's picture: Botling runs its command now (if it is allowed). */
  async run(botId: string): Promise<void> {
    const picture = this.pictures[botId];
    if (!picture?.command) return;
    await this.api.approvals.run(botId, picture.command, RUN_KEY, { minIntervalMs: 0 });
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------------------
  // The board

  /** Pictures from before this plugin: each bot's whiteboard.json, once (the files stay where they are). */
  private importLegacy(bots: BotSummary[]) {
    const checked = new Set<string>((this.api.storage.get("importedFrom") as string[] | undefined) ?? []);
    let changed = false;
    for (const bot of bots) {
      if (bot.role === "main" || bot.parent || checked.has(bot.id)) continue;
      checked.add(bot.id);
      changed = true;
      const picture = readPicture(this.deps.legacy(bot.id));
      if (picture && !this.pictures[bot.id]) this.pictures[bot.id] = picture;
    }
    if (!changed) return;
    this.api.storage.set("importedFrom", [...checked]);
    this.api.storage.set("pictures", this.pictures);
  }

  private startListening() {
    if (this.listening) return;
    // Listening starts before the next read (the host says so first), so nothing that changes after it goes untold.
    this.listening = this.api.workspace.onChange(() => { this.dirty = true; });
    this.dirty = true;
  }

  private stopListening() {
    this.idle?.cancel();
    this.idle = null;
    this.listening?.();
    this.listening = null;
    this.dirty = true;
  }

  /** The board for the frame's ask; `since` is the stamp it has: while nothing changed the answer is `same`. */
  board(since?: string): Promise<BoardView> {
    // Being asked is what shows the board: listen for changes while it is, and let go a while after the asks stop.
    this.startListening();
    this.idle?.cancel();
    this.idle = this.deps.setTimer(() => this.stopListening(), SHOWN_FOR_MS);
    const building = (this.building ??= this.build().finally(() => { this.building = null; }));
    return building.then((view) => (since !== undefined && since === view.stamp ? { ...view, same: true, bots: [], entries: [], waiting: { items: [], doing: {} }, faces: {}, statuses: {}, pinned: [] } : view));
  }

  private async load() {
    const { workspace } = this.api;
    const summaries = await workspace.bots();
    this.importLegacy(summaries);
    const waiting = (await workspace.waiting()) as Waiting;
    const look = this.look();
    const faces: Record<string, string> = {};
    for (const bot of summaries) {
      const asking = bot.approvals > 0 || waiting.items.some((item) => item.botId === bot.id);
      const key = `${bot.id}|${look}|${bot.asleep}|${bot.busy}|${asking}|${bot.avatar}`;
      let face = this.faces.get(key);
      if (face === undefined) {
        face = await workspace.face(bot.id, look);
        this.faces.set(key, face);
        if (this.faces.size > 500) this.faces.delete(this.faces.keys().next().value!);
      }
      faces[bot.id] = face;
    }
    const entries = await Promise.all(summaries.filter((bot) => bot.role !== "main" && !bot.parent).map(async (bot): Promise<Entry> => {
      const [memory, tasks, results, days, approvals] = await Promise.all([
        workspace.memory(bot.id), workspace.tasks(bot.id, { limit: 100 }), workspace.results(bot.id, { limit: 12 }), workspace.taskHistory(bot.id, 14), workspace.pendingApprovals(bot.id),
      ]);
      const shown = tasks as unknown as Task[];
      return {
        botId: bot.id, currentStatus: memory.currentStatus, inProgress: memory.inProgress, decided: memory.decided, tasks: shown, results,
        picture: null, latest: latestAction(shown), doneDays: days, description: botDescription(bot.job, memory.currentStatus[0], bot.folder), approvals: approvals as Approval[],
      };
    }));
    this.read = { look, bots: summaries, waiting, entries, faces };
    this.dirty = false;
  }

  private look(): Look {
    const look = this.api.settings.app<Look | null>("botLook");
    return look && looks.includes(look) ? look : "original";
  }

  private lang(): Lang {
    return this.api.settings.app<string | null>("language") === "zh-Hant" ? "zh-Hant" : "en";
  }

  /** A bot's picture as the board draws it; null: none, or its component is gone from the library. Its command runs again when allowed (at most every 30 s). */
  private async pictureOf(botId: string): Promise<Picture | null> {
    const record = this.pictures[botId];
    if (!record) return null;
    const entry = await this.api.workspace.component(botId, record.name);
    if (!entry.exists) return null;
    const view: Picture = { name: record.name, data: record.data, size: record.size, command: null, folder: null, status: null, error: null, ranAt: null };
    if (!record.command) return view;
    const state = await this.api.approvals.run(botId, record.command, RUN_KEY, { minIntervalMs: SHOWN_COOLDOWN_MS });
    // A finished run's output is kept with the picture, so it shows after a restart too.
    if (state.status === "done" && state.data !== null && state.data !== record.data && state.data.length <= PICTURE_DATA_LIMIT) {
      record.data = state.data;
      this.api.storage.set("pictures", this.pictures);
    }
    return {
      ...view, data: state.data ?? record.data, command: record.command, folder: state.folder, error: state.error,
      ranAt: state.ranAt === null ? null : new Date(state.ranAt).toISOString(),
      status: state.status === "idle" && record.data !== "null" ? "done" : state.status,
    };
  }

  private async build(): Promise<BoardView> {
    // The app's look changes every face: read again.
    if (this.dirty || !this.read || this.read.look !== this.look()) await this.load();
    const read = this.read!;
    const entries: Entry[] = [];
    for (const entry of read.entries) entries.push({ ...entry, picture: await this.pictureOf(entry.botId) });
    const main = read.bots.find((bot) => bot.role === "main");
    const view: BoardView = {
      stamp: "", look: this.look(), lang: this.lang(), mainBotId: main?.id ?? "main", mainReply: main?.lastReply ?? null,
      bots: read.bots.map(toBot), pinned: read.bots.filter((bot) => bot.pinned).map((bot) => bot.id), waiting: read.waiting, entries, faces: read.faces,
      statuses: Object.fromEntries(read.bots.map((bot) => [bot.id, bot.status])), shelfOpen: this.api.storage.get("shelfOpen") === true,
    };
    // The stamp moves only when what the page shows changed.
    const text = JSON.stringify({ ...view, stamp: undefined });
    if (text !== this.lastText) { this.lastText = text; this.counter++; }
    view.stamp = `${this.epoch}:${this.counter}`;
    return view;
  }
}
