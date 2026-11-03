// The studio seam as the desk uses it: typed calls over `api.studio.request` (the core checks each one: plugins/studio-seam.ts), and the
// library as a snapshot with the methods the desk's logic reads (`names`, `versionOf`, `command`…). The desk talks to `Studio`, so its
// tests use a fake one and need no core.
import type { GuestAnswer } from "../../../src/core/bot";
import type { StudioChat, StudioCommandState, StudioLibrary, StudioLibraryEntry, StudioLine } from "../../../src/core/plugins/studio-seam";

export type { GuestAnswer, StudioChat, StudioCommandState, StudioLibrary, StudioLibraryEntry, StudioLine };

/** The library the way a request reads it: a snapshot taken when it was asked for. */
export class LibraryView {
  constructor(readonly snapshot: StudioLibrary) {}
  get names(): string[] { return this.snapshot.names; }
  has(name: string | undefined | null): name is string { return !!name && this.snapshot.names.includes(name); }
  versionOf(name: string): number { return this.snapshot.entries[name]?.version ?? 0; }
  command(name: string): string | null { return this.snapshot.entries[name]?.command ?? null; }
  detailCommand(name: string): string | null { return this.snapshot.entries[name]?.detailCommand ?? null; }
  info(name: string): StudioLibraryEntry["info"] { return this.snapshot.entries[name]?.info ?? null; }
  /** The first line of each one's about.md (`summaries(of:)`). */
  summaries(of: string[]): string {
    return this.names.filter((name) => of.includes(name)).map((name) => `- ${name}: ${this.snapshot.entries[name]?.summary ?? ""}`).join("\n");
  }
  /** Each one's whole about.md (`catalog(of:)`). */
  catalog(of: string[]): string {
    return this.names.filter((name) => of.includes(name)).map((name) => this.snapshot.entries[name]?.catalog ?? "").join("\n");
  }
}

export interface Studio {
  chats(): Promise<StudioChat[]>;
  chat(id: string): Promise<StudioChat | null>;
  componentBots(): Promise<string[]>;
  maintainer(): Promise<{ id: string; working: boolean } | null>;
  line(bot: string, query: { id: string } | { last: "bot" }): Promise<StudioLine | null>;
  /** Every chat's raw specs. */
  specs(): Promise<Record<string, unknown[]>>;
  writeSpecs(bot: string, specs: unknown[]): Promise<boolean>;
  library(withInfo?: string[]): Promise<LibraryView>;
  working(name: string, change: string | null): Promise<void>;
  handTo(text: string): Promise<void>;
  holder(name: string): Promise<StudioChat | null>;
  give(name: string, bot: string): Promise<boolean>;
  unlist(name: string, bot: string): Promise<boolean>;
  note(bot: string, text: string): Promise<void>;
  notice(bot: string, text: string): Promise<void>;
  ask(bot: string, text: string, waitMs: number, answerMs: number): Promise<GuestAnswer>;
  commands: {
    isApproved(command: string, folder: string): Promise<boolean>;
    isDetailApproved(detail: string | null, folder: string): Promise<boolean>;
    run(card: string, command: string, folder: string, force: boolean): Promise<void>;
    state(card: string, command: string, detail: string | null, folder: string): Promise<StudioCommandState>;
    runOf(card: string, command: string, folder: string): Promise<StudioCommandState | null>;
    lastRan(card: string): Promise<number | null>;
  };
}

/** `Studio` over the plugin API's `studio.request`. */
export function studioOver(request: (method: string, params?: unknown) => Promise<unknown>): Studio {
  const ask = <T>(method: string, params: Record<string, unknown> = {}) => request(method, params) as Promise<T>;
  return {
    chats: () => ask("chats"),
    chat: (id) => ask("chat", { bot: id }),
    componentBots: () => ask("componentBots"),
    maintainer: () => ask("maintainer"),
    line: (bot, query) => ask("line", { bot, ...query }),
    specs: () => ask("specs"),
    writeSpecs: async (bot, specs) => (await ask<{ changed: boolean }>("writeSpecs", { bot, specs })).changed,
    library: async (withInfo = []) => new LibraryView(await ask<StudioLibrary>("library", { withInfo })),
    working: async (name, change) => { await ask("working", { name, change }); },
    handTo: async (text) => { await ask("handTo", { text }); },
    holder: (name) => ask("holder", { name }),
    give: (name, bot) => ask("give", { name, bot }),
    unlist: (name, bot) => ask("unlist", { name, bot }),
    note: async (bot, text) => { await ask("note", { bot, text }); },
    notice: async (bot, text) => { await ask("notice", { bot, text }); },
    ask: (bot, text, waitMs, answerMs) => ask("ask", { bot, text, waitMs, answerMs }),
    commands: {
      isApproved: (command, folder) => ask("isApproved", { command, folder }),
      isDetailApproved: (detail, folder) => ask("isDetailApproved", { detail, folder }),
      run: async (card, command, folder, force) => { await ask("run", { card, command, folder, force }); },
      state: (card, command, detail, folder) => ask("commandState", { card, command, detail, folder }),
      runOf: (card, command, folder) => ask("runOf", { card, command, folder }),
      lastRan: (card) => ask("lastRan", { card }),
    },
  };
}
