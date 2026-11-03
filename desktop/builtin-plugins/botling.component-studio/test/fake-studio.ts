// A studio seam in memory: chats with lines, a library, specs.json lists, Maintainer's inbox, bots' component lists and the command
// runner, the way the core answers them (core/studio-world.ts), so the desk's tests need no core and no plugin host.
import { toSwiftDate } from "../../../src/core/store/records";
import { LibraryView, type GuestAnswer, type Studio, type StudioChat, type StudioCommandState, type StudioLibrary, type StudioLine } from "../src/studio";
import { SpecDesk, type ChipDecoration, type DeskDeps } from "../src/desk";
import type { SpecState } from "../src/types";

export const MAIN = "main";
export const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";

export interface FakeLine { id: string; role: string; text: string; date: number; [field: string]: unknown }
interface FakeChat { name: string; folder: string; components: string[] | null; lines: FakeLine[]; working: boolean }
export interface FakeComponent { about: string; version: number; template?: string }

let counter = 0;
export const line = (role: string, text: string, more: Record<string, unknown> = {}): FakeLine => ({ id: `L${++counter}`, role, text, date: toSwiftDate(), ...more });

export class FakeStudio implements Studio {
  chatsById = new Map<string, FakeChat>();
  stored: Record<string, unknown[]> = {};
  writes = 0;
  components = new Map<string, FakeComponent>();
  handed: string[] = [];
  notes: [string, string][] = [];
  notices: [string, string][] = [];
  working_: [string, string | null][] = [];
  approved = new Set<string>();
  runs: { card: string; command: string; folder: string; force: boolean }[] = [];
  outputs = new Map<string, string>();
  states = new Map<string, StudioCommandState>();
  asks: { bot: string; text: string }[] = [];
  answer: GuestAnswer | (() => Promise<GuestAnswer>) = { kind: "reply", text: "" } as GuestAnswer;
  maintainerWorking = false;
  previewsOf = new Map<string, string[]>();

  constructor() {
    this.chatsById.set(MAIN, { name: "Main bot", folder: "/p/main", components: [], lines: [], working: false });
    this.chatsById.set(MAINTAINER, { name: "Maintainer", folder: "/p/maintainer", components: null, lines: [], working: false });
    this.chatsById.set("B1", { name: "Site", folder: "/p/site", components: [], lines: [], working: false });
  }

  add(chat: string, record: FakeLine) { this.chatsById.get(chat)!.lines.push(record); return record; }
  component(name: string, about: string) { const was = this.components.get(name); this.components.set(name, { about, version: (was?.version ?? 0) + 1 }); }
  private info(id: string): StudioChat {
    const chat = this.chatsById.get(id)!;
    return { id, name: chat.name, folder: chat.folder, working: chat.working, components: chat.components ? [...chat.components] : null, own: (chat.components ?? []).filter((name) => this.components.has(name)) };
  }

  async chats() { return [...this.chatsById.keys()].filter((id) => id !== MAINTAINER).map((id) => this.info(id)); }
  async chat(id: string) { return this.chatsById.has(id) ? this.info(id) : null; }
  async componentBots() { return [...this.chatsById].filter(([id]) => id !== MAINTAINER).map(([, chat]) => chat.name); }
  async maintainer() { return { id: MAINTAINER, working: this.maintainerWorking }; }
  async line(bot: string, query: { id: string } | { last: "bot" }): Promise<StudioLine | null> {
    const lines = this.chatsById.get(bot)?.lines ?? [];
    const record = "id" in query ? lines.find((entry) => entry.id === query.id) : lines.findLast((entry) => entry.role === "bot");
    if (!record) return null;
    const at = lines.indexOf(record);
    const first = record.text.split("\n")[0] ?? "";
    return {
      record: structuredClone(record), asked: lines.slice(0, at).findLast((entry) => entry.role === "user")?.text ?? null, previews: this.previewsOf.get(record.id) ?? null,
      preview: first, turn: lines.slice(lines.findLastIndex((entry) => entry.role === "user") + 1).map((entry) => entry.id),
    };
  }
  async specs() { return structuredClone(this.stored); }
  async writeSpecs(bot: string, specs: unknown[]) { this.writes += 1; this.stored[bot] = structuredClone(specs); if (!specs.length) delete this.stored[bot]; return true; }
  async library(withInfo: string[] = []) {
    const names = [...this.components.keys()];
    const entries: StudioLibrary["entries"] = {};
    for (const name of names) {
      const c = this.components.get(name)!;
      const lines = c.about.trim().split("\n");
      const find = (label: string) => lines.map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(label))?.slice(label.length).trim() || null;
      entries[name] = {
        version: c.version, command: find("command:"), detailCommand: find("detail command:"), summary: lines[0] ?? "",
        catalog: `- ${name}: ${lines[0] ?? ""}${lines.length > 1 ? "\n" + lines.slice(1).map((l) => `  ${l}`).join("\n") : ""}`,
        ...(withInfo.includes(name) ? { info: { template: c.template ?? `<div>${name}</div>`, version: c.version, updated: false, working: false, hasPrevious: false, sizes: [], icon: null, title: null } } : {}),
      };
    }
    return new LibraryView({ names, entries });
  }
  async working(name: string, change: string | null) { this.working_.push([name, change]); }
  async handTo(text: string) { this.handed.push(text); }
  async holder(name: string) {
    const wanted = name.trim().toLowerCase();
    const id = wanted === "main bot" ? MAIN : [...this.chatsById].find(([bot, chat]) => bot !== MAINTAINER && chat.name.toLowerCase() === wanted)?.[0];
    return id ? this.info(id) : null;
  }
  async give(name: string, bot: string) {
    const chat = this.chatsById.get(bot)!;
    if (!chat.components || !this.components.has(name)) return false;
    if (chat.components.includes(name)) return true;
    if (chat.components.length >= 20) return false;
    chat.components.push(name);
    return true;
  }
  async unlist(name: string, bot: string) {
    const chat = this.chatsById.get(bot)!;
    if (!chat.components?.includes(name)) return false;
    chat.components = chat.components.filter((other) => other !== name);
    return true;
  }
  async note(bot: string, text: string) { this.notes.push([bot, text]); }
  async notice(bot: string, text: string) { this.notices.push([bot, text]); }
  async ask(bot: string, text: string) { this.asks.push({ bot, text }); return typeof this.answer === "function" ? this.answer() : this.answer; }
  commands = {
    isApproved: async (command: string, folder: string) => this.approved.has(`${folder}\n${command}`),
    isDetailApproved: async (detail: string | null, folder: string) => detail === null || this.approved.has(`${folder}\nDetail command: ${detail}`),
    run: async (card: string, command: string, folder: string, force: boolean) => {
      this.runs.push({ card, command, folder, force });
      const data = this.outputs.get(command) ?? "{}";
      this.states.set(`${card}\n${command}\n${folder}`, { status: "done", data, error: null, ranAt: Date.now() });
    },
    state: async (card: string, command: string, detail: string | null, folder: string): Promise<StudioCommandState> => {
      if (!this.approved.has(`${folder}\n${command}`) || (detail !== null && !this.approved.has(`${folder}\nDetail command: ${detail}`))) return { status: "approve", data: null, error: null, ranAt: null };
      return this.states.get(`${card}\n${command}\n${folder}`) ?? { status: "idle", data: null, error: null, ranAt: null };
    },
    runOf: async (card: string, command: string, folder: string) => this.states.get(`${card}\n${command}\n${folder}`) ?? null,
    lastRan: async (card: string) => { const run = [...this.states].filter(([key]) => key.startsWith(`${card}\n`)).map(([, state]) => state.ranAt).filter((at): at is number => at !== null); return run.length ? Math.max(...run) : null; },
  };
}

/** A desk over a fake studio, with what it drew and opened kept for the test to look at. */
export function deskOver(studio = new FakeStudio(), more: Partial<DeskDeps> = {}) {
  const drawn = new Map<string, ChipDecoration[]>();
  const takeovers: { chat: string | null; wide: boolean }[] = [];
  const states: { chat: string; state: SpecState | null }[] = [];
  const desk = new SpecDesk({
    studio,
    decorate: async (chat, decorations) => { if (decorations.length) drawn.set(chat, decorations); else drawn.delete(chat); },
    takeover: async (chat, wide) => { takeovers.push({ chat, wide }); },
    emit: (chat, state) => { states.push({ chat, state }); },
    clock: () => ({ timeZone: "UTC", locale: "en-US", hour12: false }),
    log: () => {},
    timing: { wait: 1000, answer: 1000 },
    ...more,
  });
  const chips = (chat = MAIN, message?: string) => (drawn.get(chat) ?? []).filter((entry) => !message || entry.under === message).flatMap((entry) => entry.data.specs);
  return { studio, desk, drawn, takeovers, states, chips };
}
