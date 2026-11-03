// The pins of every bot: what the core's Bot kept (`pinsView`, `pinAdd`, `pinChange`, `pinArrange`, `pinCommand`, `pinsShown`, `refreshDuePins`),
// now kept here. It asks the core only for what is the core's (the components a chat shows, running a card's command once the user
// allowed it, what the ApprovalSheet asks) through `cards.*`, and tells the chat page what to draw with `chat.setData`.
import { resolve as resolvePath } from "node:path";
import type { CardLibrary, CardState, CardsApi, ShownCard } from "../../../../Web/host/src/api";
import {
  chip, clampMinutes, clampPanelHeight, clampSeconds, floatMenu, headline, isDue, keepable, MAX_FLOATING, readPin, reportWords, SHOWN_COOLDOWN_MS,
  short, spelledSize, spelledTone, SWIFT_EPOCH, toSwiftDate, type PinRecord,
} from "./pin-data";
import type { BoardData, PinChoiceView, PinView } from "./types";

/** What the pin book asks of Botling (the host's `api.cards`, and its own storage). */
export interface BookHost {
  cards: Pick<CardsApi, "library" | "shown" | "states" | "run" | "ask" | "setNotes" | "legacyPins">;
  /** What was stored for a bot (null: nothing yet), and storing it. */
  load(botId: string): unknown[] | null;
  save(botId: string, pins: PinRecord[]): void;
  /** Tells the chat page what to draw for the bot (`chat.setData`). */
  publish(botId: string, data: BoardData): Promise<void>;
  log?(line: string): void;
}

export type PinChange =
  | { kind: "remove" }
  | { kind: "move"; to: number }
  | { kind: "resize"; size: string }
  | { kind: "height"; height: number | null }
  | { kind: "status"; text: string | null; tone: string | null }
  | { kind: "save"; data: string }
  | { kind: "refresh"; refresh: "shown" | "interval" | "manual"; minutes?: number; seconds?: number }
  | { kind: "float"; floating: boolean }
  | { kind: "floatAt"; corner?: "topRight" | "topLeft" | "bottomRight" | "bottomLeft"; width?: number; height?: number; collapsed?: boolean };

export interface Ask { command: string; folder: string; detail: string | null; card: string }

const clock = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const cardOf = (pin: PinRecord) => `pin/${pin.id}`;
const quote = (json: string) => ([...json].length <= 1_500 ? json : `${[...json].slice(0, 1_500).join("")}…`);

/** A pin as the page draws it (`ChatPayload.pin(view:context:)`), from the core's state of its card. */
export function pinView(pin: PinRecord, state: CardState, floating: number): PinView {
  const imagesOf = (urls: Record<string, string>) => (Object.keys(urls).length ? urls : null);
  const display: PinView["display"] = {
    name: pin.name, data: pin.data, at: null, command: null, folder: null, detail: null, card: null, status: null, error: null, ranAt: null,
    images: imagesOf(state.dataImages), every: null,
  };
  const card = cardOf(pin);
  if (state.detail) { display.detail = state.detail; display.card = card; display.folder = state.folder; }
  if (pin.command) {
    let status: PinView["display"]["status"] = state.status;
    if (status === "idle" && pin.data !== "null" && pin.refresh !== "shown") status = "done";
    display.command = pin.command;
    display.folder = state.folder;
    display.every = state.every;
    display.status = status;
    display.error = state.error;
    const ran = state.ranAt ?? (pin.ranAt !== undefined ? SWIFT_EPOCH + pin.ranAt * 1000 : null);
    display.ranAt = ran === null ? null : new Date(ran).toDateString() === new Date().toDateString() ? clock(ran)
      : new Date(ran).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    if (state.data !== null) {
      display.data = state.data;
      display.images = imagesOf(state.images);
    }
  }
  const line = display.status === "approve" && pin.data === "null" ? "Needs your OK"
    : display.status === "failed" ? "Failed"
    : display.status === "running" && pin.data === "null" ? "Running…"
    : headline(display.status === null ? pin.data : display.data!);
  return {
    id: pin.id, name: pin.name, headline: line, chip: chip(pin.status, line, display.status ?? null, pin.data !== "null"), size: pin.size as PinView["size"], place: pin.place ?? null,
    panelHeight: pin.panelHeight ?? null, refresh: pin.refresh, minutes: pin.minutes, seconds: pin.seconds ?? null, display,
    makingLive: pin.makingLive && !pin.command ? true : null,
    float: pin.float ? { corner: pin.float.corner, width: pin.float.width ?? null, height: pin.float.height ?? null, collapsed: pin.float.collapsed } : null,
    floatMenu: floatMenu(pin, floating) as PinView["floatMenu"],
  };
}

export class PinBook {
  private readonly pins = new Map<string, PinRecord[]>();
  /** The library as the core last said it, per bot (it changes with `componentsChanged`, or after a while). */
  private readonly libraries = new Map<string, { at: number; library: CardLibrary | null }>();
  /** The id each name a bot goes by in this plugin's calls stands for ("main" is the main bot's own id). */
  private readonly ids = new Map<string, string>();
  /** What the chat page was last told, per bot. */
  private readonly told = new Map<string, string>();

  constructor(private readonly host: BookHost, private readonly now: () => number = Date.now) {}

  /** The bot's own id, whatever it was called. */
  async canonical(botId: string): Promise<string> {
    const known = this.ids.get(botId);
    if (known) return known;
    const library = await this.libraryOf(botId, true);
    const id = library?.botId ?? botId;
    this.ids.set(botId, id);
    this.ids.set(id, id);
    return id;
  }

  private async libraryOf(botId: string, fresh = false): Promise<CardLibrary | null> {
    const cached = this.libraries.get(botId);
    if (!fresh && cached && this.now() - cached.at < 30_000) return cached.library;
    const library = await this.host.cards.library(botId);
    this.libraries.set(botId, { at: this.now(), library });
    return library;
  }

  /** The component library changed (or something else the library answers). */
  forgetLibraries(): void {
    this.libraries.clear();
  }

  /** A bot's pins: what was stored, else what the core kept in pins.json before this plugin did (read once, the file stays). */
  private async pinsOf(botId: string): Promise<PinRecord[]> {
    const id = await this.canonical(botId);
    const loaded = this.pins.get(id);
    if (loaded) return loaded;
    let raw = this.host.load(id);
    let imported = false;
    if (raw === null) {
      raw = (await this.host.cards.legacyPins(id)) ?? [];
      imported = true;
    }
    const list = raw.map(readPin).filter((pin): pin is PinRecord => pin !== null);
    this.pins.set(id, list);
    if (imported) this.host.save(id, list);
    return list;
  }

  private save(botId: string, pins: PinRecord[], readOnly: boolean): void {
    if (!readOnly) this.host.save(botId, pins);
  }

  /**
   * A pin keeps the Command its component had when it was pinned; when the component's Command line changes (an update,
   * a fix), a pin that follows the component takes the new one, so its card and ↻ stop running the old line. A pin made from a
   * tag with its own command="…" keeps that. Pins from before `followsComponent` existed follow unless a shown card of that
   * component carried exactly their command.
   */
  private async syncCommands(botId: string, pins: PinRecord[], library: CardLibrary): Promise<void> {
    if (library.readOnly) return;
    let changed = false;
    let shown: ShownCard[] | null = null;
    for (const pin of pins) {
      if (!pin.command || pin.followsComponent === false) continue;
      const current = library.entries[pin.name]?.command ?? null;
      if (!current || current === pin.command) continue;
      if (pin.followsComponent !== true) {
        shown ??= await this.host.cards.shown(botId);
        if (shown.some((card) => card.name === pin.name && card.command === pin.command)) continue;
      }
      pin.command = current;
      pin.followsComponent = true;
      changed = true;
    }
    if (changed) this.save(botId, pins, false);
  }

  /** The picker's list: components it drew (newest first), then its own others with a Command. */
  private choices(library: CardLibrary, pins: PinRecord[], shown: ShownCard[]): PinChoiceView[] {
    const available = new Set(library.names);
    const uses = new Map<string, number>();
    const commands = new Map<string, string>();
    const order: string[] = [];
    for (const card of shown) {
      if (!available.has(card.name) || card.name === "choices") continue;
      if (!uses.has(card.name)) {
        order.push(card.name);
        if (card.shownCommand) commands.set(card.name, card.shownCommand);
      }
      uses.set(card.name, (uses.get(card.name) ?? 0) + 1);
    }
    const pinned = new Set(pins.map((pin) => pin.name));
    const used = order.map((name) => ({ name, command: commands.get(name) ?? null, uses: uses.get(name) ?? 0, pinned: pinned.has(name) }));
    const others = library.offered.filter((name) => available.has(name) && !uses.has(name)).flatMap((name) => {
      const command = library.entries[name]?.command ?? null;
      return command ? [{ name, command, uses: 0, pinned: pinned.has(name) }] : [];
    });
    return [...used, ...others].slice(0, 200);
  }

  /** The pins as the page draws them, those floating, and what the picker offers. */
  async view(botId: string): Promise<BoardData> {
    const id = await this.canonical(botId);
    const library = await this.libraryOf(id);
    if (!library) return { pins: [], floating: [], pinChoices: [] };
    const pins = await this.pinsOf(id);
    await this.syncCommands(id, pins, library);
    const floating = pins.filter((pin) => pin.float).length;
    const states = pins.length ? await this.host.cards.states(id, pins.map((pin) => ({ card: cardOf(pin), command: pin.command ?? null, name: pin.name, data: pin.data }))) : [];
    const views = pins.map((pin, index) => pinView(pin, states[index]!, floating));
    return { pins: views, floating: views.filter((view) => view.float).slice(0, 10), pinChoices: this.choices(library, pins, await this.host.cards.shown(id)) };
  }

  /** Tells the chat page what to draw for the bot now (only when it differs from what it was told), and the bot what its pins kept. */
  async publish(botId: string): Promise<BoardData> {
    const id = await this.canonical(botId);
    const data = await this.view(id);
    const text = JSON.stringify(data);
    if (this.told.get(id) !== text) {
      this.told.set(id, text);
      await this.host.publish(id, data);
    }
    const notes = (this.pins.get(id) ?? []).flatMap((pin) => (typeof pin.savedAt === "number" ? [{ date: pin.savedAt, line: `- "${pin.name}" pinned to you (pin ${pin.id}): ${quote(pin.data)}` }] : []));
    await this.host.cards.setNotes(id, notes).catch(() => {});
    return data;
  }

  /** The bots whose pages were told something: those a change in a card or the library may change. */
  published(): string[] {
    return [...this.told.keys()];
  }

  /** Pins a line's component (with what it shows now) or one from the picker (`pin(messageID:)`, `pin(named:)`). */
  async add(botId: string, id: string, from: { messageId?: string; index?: number; name?: string }, refresh: PinRecord["refresh"], minutes: number, seconds?: number): Promise<{ pinned: boolean }> {
    const bot = await this.canonical(botId);
    const library = await this.libraryOf(bot, true);
    if (!library || library.readOnly) return { pinned: false };
    const pins = await this.pinsOf(bot);
    let { messageId, index } = from;
    const shown = await this.host.cards.shown(bot);
    if (!messageId && from.name) {
      // The newest line that shows it.
      const found = shown.find((card) => card.name === from.name);
      if (found) { messageId = found.messageId; index = found.index; }
    }
    const make = (name: string, command: string | null, data: string, ranAt?: number): PinRecord => {
      const sizes = library.entries[name]?.sizes ?? [];
      const pin: PinRecord = {
        id: id.toUpperCase(), name, data, refresh: command ? refresh : "manual", minutes: clampMinutes(minutes), size: sizes.includes("2x2") ? "2x2" : sizes[0] ?? "2x2", makingLive: false,
      };
      if (command) pin.command = command;
      if (seconds !== undefined) pin.seconds = clampSeconds(seconds);
      if (ranAt !== undefined) pin.ranAt = ranAt;
      return pin;
    };
    let pin: PinRecord;
    if (messageId !== undefined && index !== undefined) {
      const card = shown.find((candidate) => candidate.messageId === messageId && candidate.index === index);
      if (!card || !library.names.includes(card.name)) return { pinned: false };
      const command = card.shownCommand;
      let data = card.data;
      let ranAt: number | undefined;
      if (command) {
        const [state] = await this.host.cards.states(bot, [{ card: `${card.messageId}/${card.index}`, command, name: card.name }]);
        if (state?.run && state.run.data !== null) { data = state.run.data; ranAt = state.run.ranAt !== null ? toSwiftDate(state.run.ranAt) : undefined; }
      } else if (data === "null") return { pinned: false };
      pin = make(card.name, command, data, ranAt);
      if (command) pin.followsComponent = card.command === null;
      // Provenance from the stored reply, never from a component action payload.
      pin.linkAuthor = card.author ?? bot;
    } else if (from.name && library.names.includes(from.name)) {
      const command = library.entries[from.name]?.command ?? null;
      if (!command) return { pinned: false };
      pin = make(from.name, command, "null");
      pin.followsComponent = true;
      pin.linkAuthor = bot;
    } else {
      return { pinned: false };
    }
    if (pins.some((candidate) => candidate.id === pin.id || (candidate.name === pin.name && candidate.command === pin.command))) return { pinned: false };
    pins.push(pin);
    this.save(bot, pins, false);
    await this.publish(bot);
    return { pinned: true };
  }

  /** Every other change to a pin (`unpin`, `movePin`, `resizePin`, `setPinPanelHeight`, `setPinStatus`, `savePinData`, `setPinRefresh`, `floatPin`, `setPinFloat`). */
  async change(botId: string, id: string, change: PinChange): Promise<{ changed: boolean }> {
    const bot = await this.canonical(botId);
    const library = await this.libraryOf(bot);
    if (!library || library.readOnly) return { changed: false };
    const pins = await this.pinsOf(bot);
    const at = pins.findIndex((pin) => same(pin.id, id));
    if (at < 0) return { changed: false };
    const pin = pins[at]!;
    switch (change.kind) {
      case "remove": pins.splice(at, 1); break;
      case "move":
        pins.splice(at, 1);
        pins.splice(Math.min(Math.max(change.to, 0), pins.length), 0, pin);
        break;
      case "resize": {
        const size = spelledSize(change.size);
        if (!size) return { changed: false };
        pin.size = size;
        break;
      }
      case "height": {
        const height = clampPanelHeight(change.height);
        if (height === undefined) delete pin.panelHeight; else pin.panelHeight = height;
        break;
      }
      case "status":
        if (change.text === null) delete pin.status;
        else pin.status = { text: short(change.text), tone: spelledTone(change.tone) };
        break;
      case "save":
        // Not a pin with a command: its data is what the command prints.
        if (!keepable(change.data) || pin.command) return { changed: false };
        pin.data = change.data;
        pin.savedAt = toSwiftDate(this.now());
        break;
      case "refresh":
        if (!pin.command) return { changed: false };
        pin.refresh = change.refresh;
        if (change.minutes !== undefined) {
          pin.minutes = clampMinutes(change.minutes);
          if (change.seconds !== undefined) pin.seconds = clampSeconds(change.seconds); else delete pin.seconds;
        } else if (change.seconds !== undefined) pin.seconds = clampSeconds(change.seconds);
        break;
      case "float":
        if (change.floating && !pin.float && pins.filter((candidate) => candidate.float).length >= MAX_FLOATING) return { changed: false };
        if (change.floating) pin.float ??= { corner: "topRight", collapsed: false };
        else delete pin.float;
        break;
      case "floatAt": {
        if (!pin.float) return { changed: false };
        const clamp = (value: number | undefined, low: number, high: number) => (value === undefined ? undefined : Math.min(Math.max(Math.round(value), low), high));
        const width = clamp(change.width, 200, 640) ?? pin.float.width;
        const height = clamp(change.height, 100, 480) ?? pin.float.height;
        pin.float = { corner: change.corner ?? pin.float.corner, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), collapsed: change.collapsed ?? pin.float.collapsed };
        break;
      }
    }
    this.save(bot, pins, false);
    await this.publish(bot);
    return { changed: true };
  }

  /** Board cards laid out where the page put them, with new sizes (`Pins.arrange`). */
  async arrange(botId: string, places: { id: string; col: number; row: number; size?: string }[]): Promise<{ changed: boolean }> {
    const bot = await this.canonical(botId);
    const pins = await this.pinsOf(bot);
    let changed = false;
    for (const entry of places) {
      const pin = pins.find((candidate) => same(candidate.id, entry.id));
      if (!pin) continue;
      pin.place = { col: Math.max(0, entry.col), row: Math.max(0, entry.row) };
      const size = entry.size ? spelledSize(entry.size) : null;
      if (size) pin.size = size;
      changed = true;
    }
    if (changed) { this.save(bot, pins, false); await this.publish(bot); }
    return { changed };
  }

  /** A pinned card's command: run or ↻; only what the user allowed runs, else it answers what the ApprovalSheet asks about. */
  async command(botId: string, id: string, shown: { command?: string; folder?: string; force?: boolean }): Promise<{ accepted: boolean; needsApproval?: Ask }> {
    const bot = await this.canonical(botId);
    const library = await this.libraryOf(bot);
    const pins = await this.pinsOf(bot);
    if (library) await this.syncCommands(bot, pins, library);
    const pin = pins.find((candidate) => same(candidate.id, id));
    if (!library || !pin?.command) return { accepted: false };
    if (shown.command !== undefined && shown.command !== pin.command) return { accepted: false };
    if (shown.folder !== undefined && resolvePath(shown.folder) !== resolvePath(library.folder)) return { accepted: false };
    const needsApproval = await this.host.cards.ask(bot, cardOf(pin), pin.command, pin.name);
    if (needsApproval) return { accepted: false, needsApproval };
    await this.host.cards.run(bot, cardOf(pin), pin.command, !!shown.force);
    await this.publish(bot);
    return { accepted: true };
  }

  /** Pins just shown (`ids` null: all): those refreshed "when shown" run again unless they ran in the last 30 s. */
  shown(botId: string, ids: string[] | null, now = this.now()): Promise<number> {
    return this.runPins(botId, (pin, last) => pin.refresh === "shown" && (!ids || ids.some((id) => same(id, pin.id))) && (last === null || now - last >= SHOWN_COOLDOWN_MS));
  }

  /** Pins refreshed every so often that the user can see now and whose time has come. */
  refreshDue(botId: string, visible: string[], now = this.now()): Promise<number> {
    const seen = new Set(visible.map((id) => id.toUpperCase()));
    return this.runPins(botId, (pin, last) => seen.has(pin.id.toUpperCase()) && !(pin.float && pin.refresh === "interval" && pin.seconds !== undefined) && isDue(pin, now, last));
  }

  private async runPins(botId: string, due: (pin: PinRecord, lastRan: number | null) => boolean): Promise<number> {
    const bot = await this.canonical(botId);
    const library = await this.libraryOf(bot);
    if (!library) return 0;
    const pins = await this.pinsOf(bot);
    await this.syncCommands(bot, pins, library);
    const withCommand = pins.filter((pin) => pin.command);
    if (!withCommand.length) return 0;
    const states = await this.host.cards.states(bot, withCommand.map((pin) => ({ card: cardOf(pin), command: pin.command!, name: pin.name })));
    let count = 0;
    for (const [index, pin] of withCommand.entries()) {
      const last = states[index]!.lastRan ?? (pin.ranAt !== undefined ? SWIFT_EPOCH + pin.ranAt * 1000 : null);
      if (!due(pin, last)) continue;
      if (await this.host.cards.run(bot, cardOf(pin), pin.command!, true)) count++;
    }
    return count;
  }

  /** A card's run started or ended: a finished run's output is kept on its pin (so it shows after a restart too), and the page is told. */
  async cardChanged(card: string): Promise<void> {
    // Every card's run is told (the component studio's too): only a pin's (`pin/<id>`) is the board's.
    if (!card.startsWith("pin/")) return;
    const id = card.slice(4);
    for (const [bot, pins] of this.pins) {
      const pin = pins.find((candidate) => candidate.id === id);
      if (!pin) continue;
      if (pin.command) {
        const [state] = await this.host.cards.states(bot, [{ card, command: pin.command, name: pin.name }]);
        const run = state?.run;
        if (run && run.status === "done" && run.data !== null && run.data !== pin.data) {
          pin.data = run.data;
          if (run.ranAt !== null) pin.ranAt = toSwiftDate(run.ranAt);
          this.save(bot, pins, false);
        }
      }
      await this.publish(bot);
      return;
    }
  }

  /**
   * Whose a pin is (by its id in that bot's, or in any bot's, else by its component's name in the bot's): what its links belong to,
   * how it refreshes and when its data is from. A pin from before authors were kept belongs to its bot.
   */
  async owner(botId: string, id: string | undefined, name: string | null, strict: boolean, every: string[]): Promise<{ botId: string; linkAuthor: string; words: string; when: number | null } | null> {
    const bot = await this.canonical(botId);
    const found = async (candidate: string, byName: boolean) => {
      const pins = await this.pinsOf(candidate);
      const pin = (id ? pins.find((p) => p.id === id) : undefined) ?? (byName && name !== null ? pins.find((p) => p.name === name) : undefined);
      if (!pin) return null;
      const owner = await this.canonical(candidate);
      if (typeof pin.linkAuthor !== "string") { pin.linkAuthor = owner; this.save(owner, pins, false); }
      return { botId: owner, linkAuthor: String(pin.linkAuthor), words: reportWords(pin), when: pin.ranAt ?? pin.savedAt ?? null };
    };
    // The bot that has the pin by that id (a floating card may be another bot's), else the asking bot's own.
    if (id && !strict) for (const candidate of every) if (candidate !== bot) { const hit = await found(candidate, false); if (hit) return hit; }
    const own = await found(bot, !strict);
    if (own) return own;
    return null;
  }
}
