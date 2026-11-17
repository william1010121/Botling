// The output half of `SpecDesk` (M7-S98): the card run, the landing of a build, the fill by the bot that wrote the reply, and what the
// page draws (the chips). `SpecDesk` (desk.ts) keeps the steps and the specs' mirror; it hands this class the few things it borrows
// through `DeskHost`, and keeps one-line delegates for what the plugin and the tests call.
import type { ApprovalAskView, DisplayView, SpecChipView } from "../../../src/contract";
import type { Clock } from "../../../src/core/briefing";
import { toSwiftDate, type ChatRecord } from "../../../src/core/store/records";
import { filledData, fillRequest, isFilling, outputMatches, preferredSample, replyPages, shortTime, specCard, type ComponentSpec } from "./specs";
import type { GuestAnswer, LibraryView, Studio, StudioChat, StudioLine } from "./studio";

/** How long a fill waits for the bot to be free, and then for its answer (`fillWait`, `fillAnswerTime`). */
export const FILL_TIMING = { wait: 3 * 60 * 60 * 1000, answer: 10 * 60 * 1000 };

/** A reply's chips, as the decoration under it carries them (`SpecChipView`s of the specs made from that reply). */
export interface ChipDecoration { key: string; under: string; data: { specs: SpecChipView[] } }

export interface DeskDeps {
  studio: Studio;
  /** Draws a chat's chips (`chat.decorate`). */
  decorate(chat: string, decorations: ChipDecoration[]): Promise<void>;
  clock: () => Clock;
  log: (line: string) => void;
  timing?: typeof FILL_TIMING;
}

/** What a press or a chip action answers (`spec.act`): whether it was taken, and what the app's ApprovalSheet must ask first. */
export interface ActResult { accepted: boolean; needsApproval?: ApprovalAskView }

const ms = (swift: number | undefined) => (typeof swift === "number" ? Math.round((swift + 978_307_200) * 1000) : null);
const timeOfDay = (epochMs: number | null) => (epochMs === null ? null : new Date(epochMs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
const resolveFolder = (folder: string) => folder.replace(/\/+$/, "");

/** The command a built spec's component takes its data from (`specCommand`): a reused component's own first. */
export function specCommand(spec: ComponentSpec, name: string, library: LibraryView): string | null {
  return spec.reuse ? library.command(name) ?? spec.command ?? null : spec.command ?? null;
}

/** What `SpecDesk` lends to `SpecDeskOutput` (its mirror and its builds, and the steps it runs them in). */
export interface DeskHost {
  readonly deps: DeskDeps;
  readonly mirror: Map<string, ComponentSpec[]>;
  readonly builds: Map<string, { chat: string; spec: string; version: number | null; before?: string[] }>;
  readonly dirty: Set<string>;
  readonly decorated: Set<string>;
  run<T>(step: () => Promise<T>): Promise<T>;
  act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>): Promise<ActResult>;
  library(withInfo?: string[]): Promise<LibraryView>;
  specsOf(chat: string): ComponentSpec[];
  locate(id: string): { chat: string; spec: ComponentSpec } | null;
  edit(chat: string, id: string, change: (spec: ComponentSpec) => void): Promise<boolean>;
  line(chat: string, id: string | undefined): Promise<StudioLine | null>;
  writerOf(record: ChatRecord | Record<string, unknown>, chat: string): Promise<StudioChat>;
  doneWorking(name: string): Promise<void>;
}

export class SpecDeskOutput {
  constructor(private readonly host: DeskHost) {}

  // The bridge block: what the moved code borrows from `SpecDesk`.
  private get deps() { return this.host.deps; }
  private get studio() { return this.host.deps.studio; }
  private get mirror() { return this.host.mirror; }
  private get builds() { return this.host.builds; }
  private get dirty() { return this.host.dirty; }
  private get decorated() { return this.host.decorated; }
  private run<T>(step: () => Promise<T>) { return this.host.run(step); }
  private act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>) { return this.host.act(id, step); }
  private library(withInfo?: string[]) { return this.host.library(withInfo); }
  private specsOf(chat: string) { return this.host.specsOf(chat); }
  private locate(id: string) { return this.host.locate(id); }
  private edit(chat: string, id: string, change: (spec: ComponentSpec) => void) { return this.host.edit(chat, id, change); }
  private line(chat: string, id: string | undefined) { return this.host.line(chat, id); }
  private writerOf(record: ChatRecord | Record<string, unknown>, chat: string) { return this.host.writerOf(record, chat); }
  private doneWorking(name: string) { return this.host.doneWorking(name); }

  // ------------------------------------------------------------------------------------------
  // The card's run

  /** The built component's card under the reply: run, ↻, its first draw (`runSpecComponent`); not allowed yet, what the ApprovalSheet asks about. */
  runComponent(id: string, shown: { command: string; folder: string; detail?: string; force?: boolean }): Promise<ActResult> {
    return this.act(id, async (chat, spec) => {
      const name = spec.built;
      if (!name) return { accepted: false };
      const library = await this.library();
      const command = specCommand(spec, name, library);
      if (!command) return { accepted: false };
      const folder = spec.folder;
      if (shown.command !== command || resolveFolder(shown.folder) !== resolveFolder(folder)) return { accepted: false };
      const detail = library.detailCommand(name);
      if (!(await this.studio.commands.isApproved(command, folder)) || !(await this.studio.commands.isDetailApproved(detail, folder))) {
        return { accepted: false, needsApproval: { command, folder, detail, card: name } };
      }
      const run = this.studio.commands.run(specCard(spec), command, folder, !!shown.force);
      void run.then(() => this.run(() => this.keepTestRun(id, command, chat)), () => {});
      return { accepted: true };
    });
  }

  /** A finished test run, kept on the spec: its output, whether it fits the fields, a sample (`keepTestRun`). */
  private async keepTestRun(id: string, command: string, chat: string) {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    if (!spec) return;
    const state = await this.studio.commands.runOf(specCard(spec), command, spec.folder);
    if (!state || (state.status !== "done" && state.status !== "failed")) return;
    const library = await this.library();
    await this.edit(chat, id, (edited) => {
      if (edited.command !== command && (edited.built === undefined || specCommand(edited, edited.built, library) !== command)) return;
      const run: ComponentSpec["testRun"] = { command, folder: edited.folder };
      if (state.data !== null) run.output = state.data;
      if (state.error !== null) run.error = state.error;
      if (state.ranAt !== null) run.ranAt = toSwiftDate(state.ranAt);
      if (state.data !== null) run.matches = outputMatches(state.data, edited.fields);
      edited.testRun = run;
      if (state.data !== null) {
        const at = edited.samples.findIndex((entry) => entry.kind === "testRun");
        if (at >= 0) edited.samples[at]!.data = state.data;
        else edited.samples.push({ label: "Test run", kind: "testRun", data: state.data });
      }
    });
  }

  /** A spec card's run started or ended: its chip is drawn again. */
  cardChanged(card: string): Promise<void> {
    const id = card.startsWith("spec/") ? card.slice(5) : null;
    if (!id) return Promise.resolve();
    return this.run(async () => {
      const found = this.locate(id);
      if (found) this.dirty.add(found.chat);
    });
  }

  // ------------------------------------------------------------------------------------------
  // A build lands

  /** Specs being built whose component is now in the library (new, or its template changed since Build): added to their bots (`finishSpecBuilds`). */
  finishBuilds(): Promise<void> {
    return this.run(async () => {
      if (!this.builds.size) return;
      const library = await this.library();
      for (const [name, build] of [...this.builds]) {
        if (!library.names.includes(name)) continue;
        if (build.version !== null && library.versionOf(name) === build.version) continue;
        this.builds.delete(name);
        if (this.mirror.has(build.chat)) await this.finish(build.spec, name, build.chat);
      }
    });
  }

  /** The component is in the library: on each chosen bot's list, the spec done, the chat told (`finish`). */
  async finish(id: string, name: string, chat: string) {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    if (!spec) return;
    await this.doneWorking(name);
    await this.doneWorking(spec.name);
    const added: string[] = [];
    const had: string[] = [];
    const full: string[] = [];
    for (const botName of spec.bots) {
      const holder = await this.studio.holder(botName);
      if (!holder) continue;
      if (holder.own.includes(name)) had.push(holder.name);
      else if (await this.studio.give(name, holder.id)) {
        added.push(holder.name);
        await this.studio.note(holder.id, `(App: The user added the component "${name}" to your list.)`);
      } else if (holder.components !== null) full.push(holder.name);
    }
    await this.edit(chat, id, (edited) => {
      edited.status = "done";
      edited.name = name;
      edited.built = name;
      edited.bots = [...had, ...added];
      const events: string[] = [];
      if (edited.version === undefined) edited.version = 1;
      if (added.length) events.push(`${name} added to ${added.join(", ")}`);
      if (had.length) events.push(`${name} already on ${had.join(", ")}'s list`);
      if (!events.length) events.push(`${name} is in the library`);
      edited.conversation.push(...events.map((text) => ({ kind: "event" as const, text })));
    });
    if (added.length || full.length || !had.length) {
      let text = added.length ? `${name} added to ${added.join(", ")}.` : had.length ? "" : `${name} is in the library, but on no bot's list yet.`;
      if (full.length) {
        const why = full.length === 1
          ? `Not added to ${full.join(", ")}: its list is full (20 components); take one off first.`
          : `Not added to ${full.join(", ")}: their lists are full (20 components); take one off first.`;
        text += (text ? " " : "") + why;
      }
      await this.studio.notice(chat, text);
    }
    await this.askToFill(id, name, chat);
  }

  // ------------------------------------------------------------------------------------------
  // Filled by the bot that wrote the reply

  /** Built without a command: the bot that wrote the reply draws it for that reply, in a quiet turn (`askToFill`). */
  private async askToFill(id: string, name: string, chat: string) {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    const library = await this.library([name]);
    if (!spec || spec.existing !== undefined || specCommand(spec, name, library) !== null) return;
    const found = await this.line(chat, spec.messageID);
    const reply = found?.record as unknown as ChatRecord | undefined;
    if (!found || !reply) return;
    const writer = await this.writerOf(reply, chat);
    const pages = replyPages(reply, spec.page ?? null).map((page) => page.path);
    const request = fillRequest(spec, name, { text: reply.text, when: shortTime(reply.date, this.deps.clock()), preview: found.preview }, pages, library.catalog([name]));
    await this.edit(chat, id, (edited) => {
      edited.filledBy = writer.name;
      // A new version's data may differ: the old fill waits for the new one.
      delete edited.filled;
      delete edited.fillError;
      edited.conversation.push({ kind: "event", text: `Asked ${writer.name} to fill it from its reply` });
    });
    const timing = this.deps.timing ?? FILL_TIMING;
    const taken = (answer: GuestAnswer) => this.run(() => this.takeFill(answer, id, name, chat, writer.name));
    void this.studio.ask(writer.id, request, timing.wait, timing.answer).then(taken, (error) => taken({ kind: "failed", why: (error as Error).message } as GuestAnswer));
  }

  /** The bot's answer to the fill request: its `<show>` data goes under the reply (`takeFill`). */
  private async takeFill(answer: GuestAnswer, id: string, name: string, chat: string, writer: string) {
    const result = answer.kind === "reply" ? filledData(answer.text, name) : answer.kind === "busy" ? { problem: "it stayed busy" } : { problem: answer.why };
    await this.edit(chat, id, (spec) => {
      if (spec.filledBy !== writer || spec.built !== name) return;
      if ("data" in result) {
        spec.filled = result.data;
        delete spec.fillError;
        spec.conversation.push({ kind: "event", text: `Filled by ${writer}` });
      } else {
        spec.fillError = result.problem;
        spec.conversation.push({ kind: "event", text: `${writer} did not fill it: ${result.problem}` });
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // What the page draws

  /** What changed in a step is drawn: the chips of each chat. */
  async flush() {
    if (!this.dirty.size) return;
    const chats = [...this.dirty];
    this.dirty.clear();
    for (const chat of chats) await this.drawChips(chat);
  }

  /** A chat's chips: one decoration under each reply that has specs (`specChips`). */
  private async drawChips(chat: string) {
    const specs = this.specsOf(chat);
    if (!specs.length) {
      if (this.decorated.delete(chat)) await this.deps.decorate(chat, []);
      return;
    }
    const library = await this.library();
    const by = new Map<string, SpecChipView[]>();
    for (const spec of specs) {
      if (!spec.messageID) continue;
      const list = by.get(spec.messageID) ?? [];
      list.push(await this.chip(spec, library));
      by.set(spec.messageID, list);
    }
    this.decorated.add(chat);
    await this.deps.decorate(chat, [...by].map(([messageID, chips]) => ({ key: `specs/${messageID}`, under: messageID, data: { specs: chips.slice(0, 20) } })));
  }

  /** One spec's chip, and its component when it is built (`specChips`). */
  private async chip(spec: ComponentSpec, library: LibraryView): Promise<SpecChipView> {
    const chip: SpecChipView = { id: spec.id, name: spec.name.slice(0, 200), status: spec.status, suggested: spec.suggestedBy !== undefined && spec.status === "draft" && spec.built === undefined, component: null, display: null, filling: null };
    const shown = spec.undone === true ? null : await this.display(spec, library);
    if (spec.undone === true) chip.undo = "restore";
    else if (spec.status === "done" && spec.built !== undefined) chip.undo = "undo";
    if (shown) { chip.component = shown.name; chip.display = shown; }
    else if (isFilling(spec) && spec.built && library.names.includes(spec.built)) { chip.component = spec.built; chip.filling = spec.filledBy ?? null; }
    return chip;
  }

  /** A built spec's component as drawn under its reply (`specDisplay`). */
  private async display(spec: ComponentSpec, library: LibraryView): Promise<DisplayView | null> {
    const name = spec.built;
    if (!name || !library.names.includes(name)) return null;
    const command = specCommand(spec, name, library);
    if (command === null && isFilling(spec)) return null;
    const kept = spec.testRun?.command === command ? spec.testRun?.output : undefined;
    const index = preferredSample(spec.samples, command !== null);
    const chosen = index === null ? undefined : spec.samples[index];
    const view: DisplayView = {
      name, data: (command === null ? spec.filled ?? chosen?.data : kept ?? chosen?.data) ?? "null", at: null, command: null, folder: null, detail: null, card: null,
      status: null, error: null, ranAt: null, images: null, every: null,
    };
    if (command === null) {
      if (view.data === "null") view.status = "empty";
      return view;
    }
    const detail = library.detailCommand(name);
    view.command = command;
    view.folder = spec.folder;
    view.detail = detail;
    view.card = detail ? specCard(spec) : null;
    const state = await this.studio.commands.state(specCard(spec), command, detail, spec.folder);
    let status = state.status;
    // Kept from before (a restart): shown until ↻, unless it refreshes when shown.
    if (status === "idle" && kept !== undefined && spec.refresh !== "shown") status = "done";
    view.status = status;
    view.error = state.error;
    view.ranAt = timeOfDay(state.ranAt ?? ms(spec.testRun?.ranAt));
    if (state.data !== null) view.data = state.data;
    return view;
  }
}
