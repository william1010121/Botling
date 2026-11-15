// The output half of `SpecDesk` (M7-S98): the test run and the card run, Build it, the fill by the bot that wrote the reply, and what the
// page draws (the chips and the panel's `SpecState`). `SpecDesk` (desk.ts) keeps the steps, the specs' mirror and the panel; it hands this
// class the few things it borrows through `DeskHost`, and keeps one-line delegates for what the plugin and the tests call.
import type { ApprovalAskView, ComponentInfoView, DisplayView, SpecChipView } from "../../../src/contract";
import type { Clock } from "../../../src/core/briefing";
import { toSwiftDate, type ChatRecord } from "../../../src/core/store/records";
import {
  answerOpenQuestions, buildRequest, filledData, fillRequest, isFilling, nextVersion, outputMatches, preferredSample, replyPages, shortTime, specCard,
  type ComponentSpec, type SpecChange,
} from "./specs";
import type { GuestAnswer, LibraryView, Studio, StudioChat, StudioLine } from "./studio";
import type { SpecState } from "./types";

/** How long a fill waits for the bot to be free, and then for its answer (`fillWait`, `fillAnswerTime`). */
export const FILL_TIMING = { wait: 3 * 60 * 60 * 1000, answer: 10 * 60 * 1000 };

/** A reply's chips, as the decoration under it carries them (`SpecChipView`s of the specs made from that reply). */
export interface ChipDecoration { key: string; under: string; data: { specs: SpecChipView[] } }

export interface DeskDeps {
  studio: Studio;
  /** Draws a chat's chips (`chat.decorate`). */
  decorate(chat: string, decorations: ChipDecoration[]): Promise<void>;
  /** Opens (chat: its id) or closes (null) the spec panel in the right panel's place. */
  takeover(chat: string | null, wide: boolean): Promise<void>;
  /** The open spec for the panel's frame (null: closed). */
  emit(chat: string, state: SpecState | null): void;
  clock: () => Clock;
  log: (line: string) => void;
  timing?: typeof FILL_TIMING;
}

/** What a press or a panel action answers (`spec.act`): whether it was taken, and what the app's ApprovalSheet must ask first. */
export interface ActResult { accepted: boolean; needsApproval?: ApprovalAskView }

const ms = (swift: number | undefined) => (typeof swift === "number" ? Math.round((swift + 978_307_200) * 1000) : null);
const timeOfDay = (epochMs: number | null) => (epochMs === null ? null : new Date(epochMs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
const resolveFolder = (folder: string) => folder.replace(/\/+$/, "");

/** The command a built spec's component takes its data from (`specCommand`): a reused component's own first. */
export function specCommand(spec: ComponentSpec, name: string, library: LibraryView): string | null {
  return spec.reuse ? library.command(name) ?? spec.command ?? null : spec.command ?? null;
}

/** A line of the side conversation, its Markdown pictures of local files apart (`SpecPayload.LineView`). */
export function lineView(line: { kind: "user" | "maintainer" | "event"; text: string }): SpecState["conversation"][number] {
  if (!line.text.includes("![")) return { kind: line.kind, text: line.text.slice(0, 40_000) };
  const pattern = /!\[[^\]\n]*\]\(<?((?:file:\/\/)?\/[^)\s>]+\.(?:png|jpe?g|gif|webp))>?\)/gi;
  const images: string[] = [];
  for (const match of line.text.matchAll(pattern)) {
    const path = match[1]!;
    const url = path.startsWith("file://") ? path : `file://${encodeURI(path)}`;
    if (!images.includes(url)) images.push(url);
  }
  const words = line.text.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
  return { kind: line.kind, text: words.slice(0, 40_000), ...(images.length ? { images: images.slice(0, 20) } : {}) };
}

/** What `SpecDesk` lends to `SpecDeskOutput` (its mirror, its builds and its panel state, and the steps it runs them in). */
export interface DeskHost {
  readonly deps: DeskDeps;
  readonly mirror: Map<string, ComponentSpec[]>;
  readonly builds: Map<string, { chat: string; spec: string; version: number | null; before?: string[] }>;
  readonly dirty: Set<string>;
  readonly decorated: Set<string>;
  openId: string | null;
  openChat: string | null;
  wide: boolean;
  run<T>(step: () => Promise<T>): Promise<T>;
  act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>): Promise<ActResult>;
  chatInfo(id: string): Promise<StudioChat>;
  library(withInfo?: string[]): Promise<LibraryView>;
  specsOf(chat: string): ComponentSpec[];
  locate(id: string): { chat: string; spec: ComponentSpec } | null;
  spec(chat: string, id: string): ComponentSpec | null;
  editChat(chat: string, change: (specs: ComponentSpec[]) => void): Promise<boolean>;
  store(spec: ComponentSpec, chat: string): Promise<boolean>;
  edit(chat: string, id: string, change: (spec: ComponentSpec) => void): Promise<boolean>;
  line(chat: string, id: string | undefined): Promise<StudioLine | null>;
  writerOf(record: ChatRecord | Record<string, unknown>, chat: string): Promise<StudioChat>;
  doneWorking(name: string): Promise<void>;
  maintainerBusy(): Promise<boolean>;
  beginBuild(spec: ComponentSpec, change: SpecChange | null, event: string, chat: string): Promise<void>;
  sendChange(id: string, said: string[], request: string | null, chat: string): Promise<void>;
  close(): Promise<void>;
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
  private get openId() { return this.host.openId; }
  private set openId(value: string | null) { this.host.openId = value; }
  private get openChat() { return this.host.openChat; }
  private set openChat(value: string | null) { this.host.openChat = value; }
  private get wide() { return this.host.wide; }
  private set wide(value: boolean) { this.host.wide = value; }
  private run<T>(step: () => Promise<T>) { return this.host.run(step); }
  private act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>) { return this.host.act(id, step); }
  private chatInfo(id: string) { return this.host.chatInfo(id); }
  private library(withInfo?: string[]) { return this.host.library(withInfo); }
  private specsOf(chat: string) { return this.host.specsOf(chat); }
  private locate(id: string) { return this.host.locate(id); }
  private spec(chat: string, id: string) { return this.host.spec(chat, id); }
  private editChat(chat: string, change: (specs: ComponentSpec[]) => void) { return this.host.editChat(chat, change); }
  private store(spec: ComponentSpec, chat: string) { return this.host.store(spec, chat); }
  private edit(chat: string, id: string, change: (spec: ComponentSpec) => void) { return this.host.edit(chat, id, change); }
  private line(chat: string, id: string | undefined) { return this.host.line(chat, id); }
  private writerOf(record: ChatRecord | Record<string, unknown>, chat: string) { return this.host.writerOf(record, chat); }
  private doneWorking(name: string) { return this.host.doneWorking(name); }
  private maintainerBusy() { return this.host.maintainerBusy(); }
  private beginBuild(spec: ComponentSpec, change: SpecChange | null, event: string, chat: string) { return this.host.beginBuild(spec, change, event, chat); }
  private sendChange(id: string, said: string[], request: string | null, chat: string) { return this.host.sendChange(id, said, request, chat); }
  private close() { return this.host.close(); }

  // ------------------------------------------------------------------------------------------
  // Test run

  /**
   * Runs the spec's command once to see what it prints (`testRunSpec`), only once the user allowed it; until then it
   * answers what the app page's ApprovalSheet asks about (the panel never allows anything itself). Not accepted: no such run.
   */
  testRun(id: string, shown: string | null, shownFolder: string | null): Promise<ActResult> {
    return this.act(id, (chat, spec) => this.testRunOf(spec, chat, shown, shownFolder));
  }

  private async testRunOf(spec: ComponentSpec, chat: string, shown: string | null, shownFolder: string | null): Promise<ActResult> {
    const command = spec.command;
    if (command === undefined) return { accepted: false };
    const folder = spec.folder;
    if (shown !== null && shown !== command) return { accepted: false };
    if (shownFolder !== null && resolveFolder(shownFolder) !== resolveFolder(folder)) return { accepted: false };
    const id = spec.id;
    await this.edit(chat, id, (edited) => { if (edited.testRun?.command !== command) edited.testRun = { command, folder }; });
    if (!(await this.studio.commands.isApproved(command, folder))) { this.dirty.add(chat); return { accepted: false, needsApproval: { command, folder, detail: null, card: spec.name } }; }
    const run = this.studio.commands.run(specCard(spec), command, folder, true);
    this.dirty.add(chat);
    // The run goes on after this step: it is kept on the spec when it ends.
    void run.then(() => this.run(() => this.keepTestRun(id, command, chat)), () => {});
    return { accepted: true };
  }

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

  /** A spec card's run started or ended: its chip and its panel are drawn again. */
  cardChanged(card: string): Promise<void> {
    const id = card.startsWith("spec/") ? card.slice(5) : null;
    if (!id) return Promise.resolve();
    return this.run(async () => {
      const found = this.locate(id);
      if (found) this.dirty.add(found.chat);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Build it

  /** Build it (`buildSpec`): open questions take their suggested answers; a component that exists goes straight onto the bots' lists. */
  build(id: string): Promise<ActResult> {
    return this.act(id, async (chat) => {
      const spec = this.spec(chat, id);
      if (!spec || spec.status === "building") return;
      answerOpenQuestions(spec);
      const library = await this.library();
      const existing = spec.existing ?? (spec.reuse && spec.similar !== undefined && library.names.includes(spec.similar) ? spec.similar : undefined);
      if (existing) {
        await this.store(spec, chat);
        await this.finish(id, existing, chat);
        return;
      }
      const request = buildRequest(spec);
      if (spec.built !== undefined) {
        // Rebuild: tracked as the next version, like a change typed in the panel.
        const version = nextVersion(spec);
        await this.beginBuild(spec, { state: "working", version, said: [], startedAt: toSwiftDate(), waitTurn: await this.maintainerBusy() }, `Sent to Maintainer to build a new version (v${version})`, chat);
      } else {
        await this.beginBuild(spec, null, "Sent to Maintainer to build", chat);
      }
      await this.studio.handTo(request);
    });
  }

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
    let queued: string[] = [];
    await this.edit(chat, id, (edited) => {
      edited.status = "done";
      edited.name = name;
      edited.built = name;
      edited.bots = [...had, ...added];
      const events: string[] = [];
      if (edited.change && edited.change.state !== "updated") {
        // The change's version landed (also after its turn was said to have failed).
        edited.change.state = "updated";
        delete edited.change.error;
        edited.change.endedAt = toSwiftDate();
        edited.version = edited.change.version;
        events.push(`Updated to v${edited.change.version}`);
      } else if (edited.version === undefined) {
        edited.version = 1;
      }
      queued = edited.queued ?? [];
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
    // What the user typed meanwhile goes now, as the next version.
    if (queued.length) await this.sendChange(id, queued, null, chat);
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

  /** Cancel: the chip goes away (a build already handed over is Maintainer's to finish; `cancelSpec`). */
  cancel(id: string): Promise<ActResult> {
    return this.act(id, async (chat) => {
      await this.editChat(chat, (specs) => { const at = specs.findIndex((spec) => spec.id === id); if (at >= 0) specs.splice(at, 1); });
      for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
      if (this.openId === id) await this.close();
    });
  }

  // ------------------------------------------------------------------------------------------
  // What the page draws

  /** What changed in a step is drawn: the chips of each chat, and the panel when it shows one of them. */
  async flush() {
    if (this.openId && !this.locate(this.openId)) {
      // The open spec is gone (cancelled, or its chat): the panel folds.
      const chat = this.openChat;
      this.openId = null;
      this.openChat = null;
      this.wide = false;
      await this.deps.takeover(null, false);
      if (chat) this.deps.emit(chat, null);
    }
    if (!this.dirty.size) return;
    const chats = [...this.dirty];
    this.dirty.clear();
    for (const chat of chats) await this.drawChips(chat);
    if (this.openId && this.openChat && chats.includes(this.openChat)) await this.publish();
  }

  /** Pushes the open spec to the panel's frame. */
  async publish() {
    if (!this.openId || !this.openChat) return;
    const state = await this.payload(this.openId);
    if (state) this.deps.emit(this.openChat, state);
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
    const chip: SpecChipView = { id: spec.id, name: spec.name.slice(0, 200), status: spec.status, suggested: spec.suggestedBy !== undefined && spec.status === "draft" && spec.built === undefined, open: spec.id === this.openId, component: null, display: null, filling: null };
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

  /** The open spec as the right panel draws it (`specPayload`). */
  async payload(id: string): Promise<SpecState | null> {
    const found = this.locate(id);
    if (!found) return null;
    const { chat, spec } = found;
    const library = await this.library();
    const has = (name: string | undefined): name is string => library.has(name);
    const preview = has(spec.built) ? spec.built : spec.status === "done" && has(spec.name) ? spec.name : has(spec.existing) ? spec.existing
      : spec.reuse && has(spec.similar) ? spec.similar : has(spec.shownAs) ? spec.shownAs : null;
    const components: Record<string, ComponentInfoView> = {};
    if (preview) {
      const info = (await this.library([preview])).info(preview);
      if (info) components[preview] = { template: info.template.slice(0, 1_000_000), version: info.version, updated: info.updated, working: info.working, hasPrevious: false, sizes: info.sizes.slice(0, 16), icon: info.icon, title: info.title?.slice(0, 200) ?? null };
    }
    const chosen = new Set(spec.bots.map((name) => name.toLowerCase()));
    const every = await this.studio.componentBots();
    const bots = [...every, ...spec.bots.filter((name) => !every.some((other) => other.toLowerCase() === name.toLowerCase()))].map((name) => ({ name: name.slice(0, 200), on: chosen.has(name.toLowerCase()) }));
    let testRun: SpecState["testRun"] = null;
    const command = spec.command;
    if (command !== undefined && (spec.testRun?.command === command || (await this.studio.commands.lastRan(specCard(spec))) !== null)) {
      const state = await this.studio.commands.state(specCard(spec), command, null, spec.folder);
      let status = state.status;
      // Kept from before (a restart): shown as done until run again.
      if (status === "idle" && (spec.testRun?.output !== undefined || spec.testRun?.error !== undefined)) status = spec.testRun?.output !== undefined ? "done" : "failed";
      const output = state.data ?? spec.testRun?.output ?? null;
      testRun = { status, command, folder: spec.folder, output, error: state.error ?? spec.testRun?.error ?? null, ranAt: timeOfDay(state.ranAt ?? ms(spec.testRun?.ranAt)), matches: output === null ? null : outputMatches(output, spec.fields) };
    }
    let steps: SpecState["steps"] = null;
    const filled = () => (spec.filledBy ? [spec.fillError !== undefined ? { label: `${spec.filledBy} did not fill it`, state: "todo" as const } : { label: `Filled by ${spec.filledBy}`, state: isFilling(spec) ? "doing" as const : "done" as const }] : []);
    if (spec.change && spec.built !== undefined) {
      const change = spec.change;
      const v = `v${change.version}`;
      const made = change.state === "working" ? "doing" : change.state === "updated" ? "done" : change.state === "asking" ? "todo" : "failed";
      steps = [
        { label: "Sent to Maintainer", state: "done" },
        { label: change.state === "asking" ? "Maintainer asks one question" : `Maintainer makes ${v}`, state: change.state === "asking" ? "doing" : made },
        { label: `${v} in the library`, state: change.state === "updated" ? "done" : change.state === "failed" ? "failed" : "todo" },
        ...(change.state === "updated" ? filled() : []),
      ];
    } else if (spec.status !== "draft" && spec.existing === undefined && !spec.reuse) {
      const built = spec.status === "done";
      steps = [
        { label: "Sent to Maintainer", state: "done" },
        { label: "Built into the library", state: built ? "done" : "doing" },
        { label: spec.bots.length ? `Add to ${spec.bots.join(", ")}` : "Add to its bots", state: built ? "done" : "todo" },
        ...(built ? filled() : []),
      ];
    }
    const lineFound = await this.line(chat, spec.messageID);
    const reply = lineFound?.record as unknown as ChatRecord | undefined;
    const chatName = (await this.chatInfo(chat)).name;
    const writer = reply ? (await this.writerOf(reply, chat)).name : chatName;
    const at = reply ? ` at ${shortTime(reply.date, this.deps.clock())}` : "";
    const from = spec.suggestedBy !== undefined ? `suggested by ${spec.suggestedBy}` : spec.page !== undefined ? `from ${writer}'s result page${at}` : `from ${writer}'s reply${at}`;
    // What the bot drew under the reply is "This reply" in the preview.
    const samples = spec.filled !== undefined ? [{ label: "This reply", kind: "reply" as const, data: spec.filled }, ...spec.samples.filter((entry) => entry.kind !== "reply")] : spec.samples;
    const similarAbout = spec.similar !== undefined && library.names.includes(spec.similar) ? (library.summaries([spec.similar]).split(":").slice(1).join(":").trim() || null) : null;
    return {
      id: spec.id, name: spec.name.slice(0, 200), about: spec.about.slice(0, 20_000), status: spec.status, draft: spec.draft, chat: chatName.slice(0, 400), from: from.slice(0, 400),
      suggestedBy: spec.suggestedBy ?? null, existing: spec.existing ?? null,
      fields: spec.fields.slice(0, 200).map((field) => ({ name: field.name.slice(0, 400), type: field.type.slice(0, 400), by: field.by })),
      command: spec.command ?? null, folder: spec.folder.slice(0, 4_000), refresh: spec.refresh, minutes: spec.minutes, bots: bots.slice(0, 500),
      similar: spec.similar ?? null, similarAbout: similarAbout?.slice(0, 4_000) ?? null, reuse: spec.reuse,
      samples: samples.slice(0, 50).map((entry) => ({ label: entry.kind ? ({ testRun: "Test run", reply: "This reply", page: "This page" } as const)[entry.kind] : entry.label.slice(0, 400), kind: entry.kind, data: entry.data.slice(0, 1_100_000) })),
      preferredSample: preferredSample(samples, spec.status === "done" && spec.command !== undefined),
      questions: spec.questions.slice(0, 20).map((question) => ({ id: question.id.slice(0, 200), text: question.text.slice(0, 4_000), options: question.options.slice(0, 20).map((option) => ({ label: option.label.slice(0, 400) })), suggested: question.suggested ?? null })),
      conversation: spec.conversation.slice(-500).map((line) => lineView(line)),
      origins: spec.origins, preview, components: components as SpecState["components"], testRun, steps,
      version: spec.built === undefined ? null : spec.version ?? 1,
      change: spec.change ? { state: spec.change.state, version: spec.change.version, startedAt: ms(spec.change.startedAt)!, endedAt: ms(spec.change.endedAt), error: spec.change.error ?? null, request: spec.change.request ?? null } : null,
      queued: (spec.queued ?? []).slice(0, 50), wide: this.wide,
    };
  }

  /** The spec the panel shows, as its page asks for it when it opens (null: none is open). */
  state(): Promise<{ chat: string; state: SpecState } | null> {
    return this.run(async () => {
      const state = this.openId && this.openChat ? await this.payload(this.openId) : null;
      return state && this.openChat ? { chat: this.openChat, state } : null;
    });
  }
}
