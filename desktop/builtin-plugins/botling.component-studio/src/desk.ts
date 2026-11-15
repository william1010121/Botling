// "Make into component" and a bot's <suggest-component> (1.x's Workspace+Specs.swift; the core's spec-desk.ts before this plugin): a reply
// becomes a component. Pressed, the reply goes to Maintainer, which infers the spec and builds the first version right away (or reuses a
// library component), asking nothing; the chip under the reply says Building…, then the component itself shows there, on the bot's list,
// filled by the bot that wrote the reply. Its "Edit spec" opens the spec in the right panel, where the user and Maintainer change it; once
// built, what the user types there is a change built as its next version. A command (Test run, the component's Command) runs only once the
// user allows it, as for any component card; nothing runs by itself.
//
// The specs stay where the core keeps them (specs.json beside each chat, 1.x's format): this desk reads them all when it starts, keeps its
// own copy (it is the only writer) and writes a chat's whole list back through the studio seam after each change. Everything it does is one
// step at a time (`run`), as the core's was synchronous: a tag, an event or a press never sees a spec half changed.
import { safeName } from "../../../src/core/components/library";
import { pageOfCard } from "../../../src/core/page-preview";
import { toSwiftDate, type ChatRecord } from "../../../src/core/store/records";
import {
  answerOpenQuestions, answerQuestion, changeRequest, clip, draftRequest, draftSpec, editSpecValue, firstBuildRequest, lastCommand, LINE_BREAKS, nextVersion,
  readSpec, replyPages, sameSpec, sayRequest, updateSpec, type ComponentSpec, type SpecChange,
} from "./specs";
import { judgeSuggestion } from "./suggestion-rules";
import type { LibraryView, StudioChat, StudioLine } from "./studio";
import { SpecDeskOutput, type ActResult, type DeskDeps } from "./desk-output";

// The output half of the desk (the test run, Build it, the fill, what the page draws) is in desk-output.ts; these stay exported from here.
export { FILL_TIMING, lineView, specCommand } from "./desk-output";
export type { ActResult, ChipDecoration, DeskDeps } from "./desk-output";

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export class SpecDesk {
  /** The spec the right panel shows (`openSpecID`), the chat it is in, and whether it is wide. */
  openId: string | null = null;
  private openChat: string | null = null;
  wide = false;
  /** Every chat's specs (specs.json), as read when the desk started and as it wrote them since. */
  private readonly mirror = new Map<string, ComponentSpec[]>();
  /** Specs being built, by the component name they wait for (`specBuilds`). */
  private readonly builds = new Map<string, { chat: string; spec: string; version: number | null; before?: string[] }>();
  /** The chats whose specs (or chips) changed in the step under way: drawn again when it ends. */
  private readonly dirty = new Set<string>();
  /** Chats that have chips drawn now (a chat that loses its last one is cleared). */
  private readonly decorated = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  /** What the step under way has asked the core for (cleared when it ends). */
  private chatCache = new Map<string, StudioChat | null>();
  private libraryCache: LibraryView | null = null;

  private readonly output: SpecDeskOutput;

  constructor(private readonly deps: DeskDeps) {
    const desk = this;
    this.output = new SpecDeskOutput({
      deps, mirror: this.mirror, builds: this.builds, dirty: this.dirty, decorated: this.decorated,
      get openId() { return desk.openId; }, set openId(value) { desk.openId = value; },
      get openChat() { return desk.openChat; }, set openChat(value) { desk.openChat = value; },
      get wide() { return desk.wide; }, set wide(value) { desk.wide = value; },
      run: (step) => this.run(step), act: (id, step) => this.act(id, step), chatInfo: (id) => this.chatInfo(id), library: (withInfo) => this.library(withInfo),
      specsOf: (chat) => this.specsOf(chat), locate: (id) => this.locate(id), spec: (chat, id) => this.spec(chat, id),
      editChat: (chat, change) => this.editChat(chat, change), store: (spec, chat) => this.store(spec, chat), edit: (chat, id, change) => this.edit(chat, id, change),
      line: (chat, id) => this.line(chat, id), writerOf: (record, chat) => this.writerOf(record, chat), doneWorking: (name) => this.doneWorking(name),
      maintainerBusy: () => this.maintainerBusy(), beginBuild: (spec, change, event, chat) => this.beginBuild(spec, change, event, chat),
      sendChange: (id, said, request, chat) => this.sendChange(id, said, request, chat), close: () => this.close(),
    });
  }

  private get studio() { return this.deps.studio; }

  // ------------------------------------------------------------------------------------------
  // One step at a time

  /** Runs `step` after the ones before it, and draws what it changed. */
  run<T>(step: () => Promise<T>): Promise<T> {
    const done = this.tail.then(async () => {
      this.chatCache.clear();
      this.libraryCache = null;
      try {
        return await step();
      } finally {
        try { await this.flush(); } catch (error) { this.deps.log(`draw: ${(error as Error).message}`); }
      }
    });
    this.tail = done.catch(() => {});
    return done;
  }

  /** Reads every chat's specs (when the desk starts). */
  async load() {
    await this.run(async () => {
      this.mirror.clear();
      for (const [chat, raw] of Object.entries(await this.studio.specs())) {
        const specs = raw.flatMap((entry) => readSpec(entry) ?? []);
        if (specs.length) this.mirror.set(chat, specs);
      }
      for (const chat of this.mirror.keys()) this.dirty.add(chat);
    });
  }

  private async chatInfo(id: string): Promise<StudioChat> {
    if (!this.chatCache.has(id)) this.chatCache.set(id, await this.studio.chat(id));
    const chat = this.chatCache.get(id);
    if (!chat) throw new Error(`No chat ${id}.`);
    return chat;
  }

  private async library(withInfo: string[] = []): Promise<LibraryView> {
    if (withInfo.length) return this.studio.library(withInfo);
    return (this.libraryCache ??= await this.studio.library());
  }

  private specsOf(chat: string): ComponentSpec[] { return this.mirror.get(chat) ?? []; }

  /** The spec `id`, and the chat whose reply it is made from (`specLocation`). */
  locate(id: string): { chat: string; spec: ComponentSpec } | null {
    for (const [chat, specs] of this.mirror) {
      const spec = specs.find((candidate) => candidate.id === id);
      if (spec) return { chat, spec };
    }
    return null;
  }

  private spec(chat: string, id: string): ComponentSpec | null {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    return spec ? structuredClone(spec) : null;
  }

  /** Changes a chat's specs and keeps them, if anything changed (`editSpecs`); the chips and the panel are drawn again at the step's end. */
  private async editChat(chat: string, change: (specs: ComponentSpec[]) => void): Promise<boolean> {
    const before = this.specsOf(chat);
    const edited = structuredClone(before);
    change(edited);
    if (sameSpec(edited, before)) return false;
    if (edited.length) this.mirror.set(chat, edited); else this.mirror.delete(chat);
    this.dirty.add(chat);
    await this.studio.writeSpecs(chat, edited);
    return true;
  }

  private store(spec: ComponentSpec, chat: string) {
    return this.editChat(chat, (specs) => { const at = specs.findIndex((candidate) => candidate.id === spec.id); if (at >= 0) specs[at] = spec; });
  }

  private edit(chat: string, id: string, change: (spec: ComponentSpec) => void) {
    return this.editChat(chat, (specs) => { const spec = specs.find((candidate) => candidate.id === id); if (spec) change(spec); });
  }

  /** The line a spec is made from, with what is around it (null: the line is gone). */
  private line(chat: string, id: string | undefined): Promise<StudioLine | null> {
    return id ? this.studio.line(chat, { id }) : Promise.resolve(null);
  }

  /** The bot that wrote a reply (`writerOf`): the one its `sourceID` names (a group chat's member), else the chat's own. */
  private async writerOf(record: ChatRecord | Record<string, unknown>, chat: string): Promise<StudioChat> {
    const source = (record as { sourceID?: unknown }).sourceID;
    if (typeof source === "string") {
      try { return await this.chatInfo(source); } catch { /* a bot that is gone: the chat's own */ }
    }
    return this.chatInfo(chat);
  }

  private async markWorking(name: string, change: string) { await this.studio.working(name, change); }
  private async doneWorking(name: string) { await this.studio.working(name, null); }

  // ------------------------------------------------------------------------------------------
  // Making one

  /** A spec nothing has been asked or built for yet (`isUnstarted`). */
  private static unstarted(spec: ComponentSpec) {
    return spec.status === "draft" && !spec.asked && spec.existing === undefined && spec.built === undefined;
  }

  /**
   * The reply's "Make into component", or a result page's preview card's (`preview`: which card) (`makeComponent`):
   * the chip, and Maintainer builds the first version now.
   */
  make(chat: string, messageId: string, purpose: string | null, preview: number | null = null): Promise<ComponentSpec | null> {
    return this.run(async () => {
      const found = await this.line(chat, messageId);
      const record = found?.record as unknown as ChatRecord | undefined;
      if (!found || !record || (record.role !== "bot" && record.role !== "notice")) return null;
      let page: string | undefined;
      if (preview !== null) {
        const card = found.previews?.[preview];
        const path = card ? pageOfCard(card) : null;
        if (!path) return null;
        page = path;
      }
      const existing = this.specsOf(chat).find((spec) => spec.messageID === messageId && spec.page === page);
      if (existing) {
        if (existing.existing !== undefined) await this.open(existing.id, chat);
        else if (SpecDesk.unstarted(existing)) await this.start(existing.id, chat);
        return this.specsOf(chat).find((spec) => spec.id === existing.id) ?? null;
      }
      const writer = await this.writerOf(record, chat);
      const spec = draftSpec(record, writer.name, writer.folder, await this.library(), toSwiftDate(), page ?? null);
      const words = purpose?.trim();
      if (words) spec.purpose = words;
      await this.editChat(chat, (specs) => { specs.push(spec); });
      if (spec.existing !== undefined) await this.open(spec.id, chat);
      else await this.start(spec.id, chat);
      return this.specsOf(chat).find((candidate) => candidate.id === spec.id) ?? null;
    });
  }

  /** The first version (`startSpec`): Maintainer infers the spec from the reply and builds it now, asking nothing. */
  private async start(id: string, chat: string) {
    const spec = this.spec(chat, id);
    if (!spec || !SpecDesk.unstarted(spec)) return;
    const writer = spec.bots[0] ?? (await this.chatInfo(chat)).name;
    spec.status = "building";
    spec.asked = true;
    spec.conversation.push({ kind: "event", text: "Sent to Maintainer to build the first version" });
    await this.store(spec, chat);
    const library = await this.library();
    const had = library.names.includes(spec.name);
    this.builds.set(spec.name, { chat, spec: id, version: had ? library.versionOf(spec.name) : null, before: [...library.names] });
    await this.markWorking(spec.name, "built from a reply");
    await this.sendFirstBuild(id, chat, writer);
  }

  private async sendFirstBuild(id: string, chat: string, writer: string) {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    if (!spec) return;
    const found = await this.line(chat, spec.messageID);
    const record = found?.record as unknown as ChatRecord | undefined;
    await this.studio.handTo(firstBuildRequest(spec, {
      reply: record?.text ?? "", pages: record ? replyPages(record, spec.page ?? null) : [], ran: record ? lastCommand(record) : null, asked: found?.asked ?? null, bot: writer,
    }));
  }

  /** A spec's chip pressed (`pressSpec`): a suggestion is built; otherwise it opens, or folds back. */
  press(id: string): Promise<ActResult> {
    return this.act(id, async (chat, spec) => {
      if (SpecDesk.unstarted(spec)) await this.start(id, chat);
      else if (this.openId === id) await this.close();
      else await this.open(id, chat);
    });
  }

  /**
   * A bot's `<suggest-component>` (`suggestComponent`): a chip under its reply, nothing more. One per reply, and (ADR-006 M4,
   * suggestion-rules.ts) none for one-shot output, at most one per turn, a library component that already does it offered
   * instead of a new build, and never again what the user took back.
   */
  suggest(name: string, draft: string, botId: string): Promise<void> {
    return this.run(async () => {
      const found = await this.studio.line(botId, { last: "bot" });
      const record = found?.record as unknown as ChatRecord | undefined;
      if (!found || !record) return;
      const chat = await this.chatInfo(botId);
      const specs = this.specsOf(botId);
      if (specs.some((spec) => spec.messageID === record.id)) return;
      const turn = new Set(found.turn);
      const named = safeName(name);
      const library = await this.library();
      const verdict = judgeSuggestion({
        name: named, draft, libraryNames: library.names, botNames: chat.components,
        suggestionsThisTurn: specs.filter((spec) => spec.suggestedBy !== undefined && spec.messageID !== undefined && turn.has(spec.messageID)).length,
        undoneNames: specs.filter((spec) => spec.undone === true).map((spec) => spec.name),
      });
      if (!verdict.allow) {
        this.deps.log(`suggest-component "${name}" dropped: ${verdict.reason}`);
        return;
      }
      const spec = draftSpec(record, chat.name, chat.folder, library, toSwiftDate());
      if (verdict.existing !== undefined) {
        // The library has it: the chip offers to put it on the bot's list; Maintainer builds nothing.
        spec.existing = verdict.existing;
        spec.name = verdict.existing;
      } else if (spec.existing === undefined && named) {
        spec.name = named;
        if (spec.similar === named) delete spec.similar;
      }
      spec.about = draft.trim();
      // Its words are what the component is for.
      if (spec.about) spec.purpose = spec.about;
      spec.suggestedBy = chat.name;
      await this.editChat(botId, (list) => { list.push(spec); });
    });
  }

  // ------------------------------------------------------------------------------------------
  // Undo / Restore (ADR-006 M4)

  /**
   * Undo for a component made (or added) from a chip: it comes off the bots' lists it was put on. Nothing is deleted: the
   * library copy and its git tags stay (deleting from the library is Maintainer's, and only when the user asks), so Restore
   * needs no rebuild. A change made later is undone by the component's own Revert (git, `library.revert`).
   */
  undo(id: string): Promise<ActResult> {
    return this.act(id, async (chat) => {
      const spec = this.spec(chat, id);
      if (!spec || spec.status !== "done" || spec.built === undefined || spec.undone === true) return;
      const name = spec.built;
      const removed: string[] = [];
      for (const botName of spec.bots) {
        const holder = await this.studio.holder(botName);
        if (holder && await this.studio.unlist(name, holder.id)) {
          removed.push(holder.name);
          await this.studio.note(holder.id, `(App: The user took the component "${name}" off your list.)`);
        }
      }
      await this.edit(chat, id, (edited) => {
        edited.undone = true;
        edited.undoneBots = removed;
        edited.conversation.push({ kind: "event", text: removed.length ? `Undone: ${name} taken off ${removed.join(", ")}'s list (kept in the library; Restore puts it back)` : `Undone: ${name} was on no list (kept in the library)` });
      });
      await this.studio.notice(chat, `${name} taken off ${removed.length ? removed.join(", ") + "'s list" : "the list"}. Restore puts it back.`);
      if (this.openId === id) await this.close();
    });
  }

  /** Restore: the component goes back on the lists Undo took it from, from the copy the library kept. */
  restore(id: string): Promise<ActResult> {
    return this.act(id, async (chat) => {
      const spec = this.spec(chat, id);
      if (!spec || spec.undone !== true || spec.built === undefined) return;
      const name = spec.built;
      if (!(await this.library()).names.includes(name)) {
        await this.studio.notice(chat, `Couldn't restore ${name}: it is no longer in the library.`);
        return;
      }
      const wanted = Array.isArray(spec.undoneBots) ? (spec.undoneBots as string[]) : [];
      const back: string[] = [];
      const full: string[] = [];
      for (const botName of wanted) {
        const holder = await this.studio.holder(botName);
        if (!holder) continue;
        if (await this.studio.give(name, holder.id)) {
          back.push(holder.name);
          await this.studio.note(holder.id, `(App: The user added the component "${name}" back to your list.)`);
        } else if (holder.components !== null) full.push(holder.name);
      }
      await this.edit(chat, id, (edited) => {
        if (!full.length) { delete edited.undone; delete edited.undoneBots; }
        edited.bots = back.length ? back : edited.bots;
        edited.conversation.push({ kind: "event", text: `Restored: ${name} back on ${back.join(", ") || "no list"}${full.length ? `; not on ${full.join(", ")} (list full)` : ""}` });
      });
      await this.studio.notice(chat, `${name} restored to ${back.join(", ") || "the library"}.${full.length ? ` Not added to ${full.join(", ")}: its list is full (20 components); take one off first.` : ""}`);
    });
  }

  // ------------------------------------------------------------------------------------------
  // The panel

  /** One step on a spec found by its id: not accepted when there is no such spec. */
  private act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>): Promise<ActResult> {
    return this.run(async () => {
      const found = this.locate(id.toUpperCase());
      if (!found) return { accepted: false };
      const result = await step(found.chat, found.spec);
      return result ?? { accepted: true };
    });
  }

  /** The spec opens in the right panel (`openSpec`); the first time, Maintainer is asked to draft it. */
  private async open(id: string, chat: string) {
    const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
    if (!spec) return;
    const previous = this.openId;
    this.openId = id;
    this.openChat = chat;
    const ask = !spec.asked && spec.existing === undefined && spec.status === "draft";
    await this.edit(chat, id, (edited) => { edited.opened = true; if (ask) edited.asked = true; });
    if (previous && previous !== id) this.markChips(previous);
    this.dirty.add(chat);
    await this.deps.takeover(chat, this.wide);
    if (!ask) return;
    const found = await this.line(chat, spec.messageID);
    const record = found?.record as unknown as ChatRecord | undefined;
    await this.studio.handTo(draftRequest(this.specsOf(chat).find((candidate) => candidate.id === id)!, record?.text ?? "", record ? replyPages(record, spec.page ?? null) : [], record ? lastCommand(record) : null, spec.bots[0] ?? (await this.chatInfo(chat)).name));
  }

  /** Opens the spec in the panel (the chip's "Edit spec"). */
  openSpec(id: string): Promise<ActResult> {
    return this.act(id, (chat) => this.open(id, chat));
  }

  /** Collapses the panel back to the chip (`closeSpec`). */
  close(): Promise<void> {
    const was = this.openId;
    const chat = this.openChat;
    this.openId = null;
    this.openChat = null;
    this.wide = false;
    if (was) this.markChips(was);
    return this.deps.takeover(null, false).then(() => { if (chat) this.deps.emit(chat, null); });
  }

  /** The panel's own close button. */
  closePanel(): Promise<void> { return this.run(() => this.close()); }

  setWide(wide: boolean): Promise<void> {
    return this.run(async () => {
      this.wide = wide;
      if (this.openChat) { await this.deps.takeover(this.openChat, wide); if (this.openId) this.dirty.add(this.openChat); }
    });
  }

  /** The chips under the spec's reply say whether it is open. */
  private markChips(id: string) {
    const found = this.locate(id);
    if (found) this.dirty.add(found.chat);
  }

  /** The user changed a value in the panel (`editSpec`); not while it builds. */
  editValue(id: string, key: string, value: string): Promise<ActResult> {
    return this.act(id, async (chat) => { await this.edit(chat, id, (spec) => { if (spec.status !== "building") editSpecValue(key, value, spec); }); });
  }

  /** The user picked an answer to one of Maintainer's questions (`answerSpec`). */
  answer(id: string, question: string, option: number): Promise<ActResult> {
    return this.act(id, async (chat) => {
      await this.edit(chat, id, (spec) => { if (spec.status !== "building") answerQuestion(question, option, spec); });
      const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
      if (!spec || spec.built === undefined || spec.change?.state !== "asking" || spec.questions.length) return;
      await this.sendChange(id, spec.change.said, null, chat);
    });
  }

  /** "Ask for changes…" / "Anything to add?" (`saySpec`). */
  say(id: string, raw: string, request: string | null): Promise<ActResult> {
    return this.act(id, async (chat) => {
      const text = raw.trim();
      const spec = this.spec(chat, id);
      if (!spec || (!text && !spec.pendingEdits.length)) return;
      if (spec.status === "building") {
        if (!text) return;
        spec.conversation.push({ kind: "user", text });
        spec.queued = [...(spec.queued ?? []), text];
        const making = spec.change ? `v${spec.change.version}` : "the first version";
        spec.conversation.push({ kind: "event", text: `Queued: goes to Maintainer with the next change, once ${making} is in` });
        await this.store(spec, chat);
        return;
      }
      if (spec.built !== undefined && spec.existing === undefined) {
        if (text) spec.conversation.push({ kind: "user", text });
        await this.store(spec, chat);
        await this.sendChange(id, text ? [text] : [], request, chat);
        return;
      }
      if (text) spec.conversation.push({ kind: "user", text });
      const said = sayRequest(spec, text);
      spec.pendingEdits = [];
      spec.asked = true;
      await this.store(spec, chat);
      await this.studio.handTo(said);
    });
  }

  /** A built component's change goes to Maintainer now, as its next version (`sendChange`). */
  private async sendChange(id: string, said: string[], request: string | null, chat: string) {
    const spec = this.spec(chat, id);
    if (!spec || spec.built === undefined) return;
    const version = nextVersion(spec);
    const text = changeRequest(spec, said, version);
    const change: SpecChange = { state: "working", version, said, startedAt: toSwiftDate(), waitTurn: await this.maintainerBusy(), ...(request ? { request } : {}) };
    await this.beginBuild(spec, change, `Sent to Maintainer: building v${version} with this change`, chat);
    await this.studio.handTo(text);
  }

  private async maintainerBusy(): Promise<boolean> {
    return !!(await this.studio.maintainer())?.working;
  }

  /** The spec goes to building, and the app waits for its component to land (`beginBuild`). */
  private async beginBuild(spec: ComponentSpec, change: SpecChange | null, event: string, chat: string) {
    spec.status = "building";
    spec.asked = true;
    if (change) spec.change = change;
    spec.questions = [];
    spec.pendingEdits = [];
    delete spec.queued;
    spec.conversation.push({ kind: "event", text: event });
    await this.store(spec, chat);
    const library = await this.library();
    const had = library.names.includes(spec.name);
    this.builds.set(spec.name, { chat, spec: spec.id, version: had ? library.versionOf(spec.name) : null, before: [...library.names] });
    await this.markWorking(spec.name, change ? "changed from its spec panel" : "built from a component spec");
  }

  /** Maintainer's turn ended: a change that has not landed did not happen (`settleSpecChanges`). */
  settleChanges(record: { role: string; text: string }, running: boolean): Promise<void> {
    return this.run(async () => {
      for (const chat of [...this.mirror.keys()]) {
        if (!this.specsOf(chat).some((spec) => spec.change?.state === "working" && spec.status === "building")) continue;
        const stopped: string[] = [];
        await this.editChat(chat, (specs) => {
          for (const spec of specs) {
            if (spec.change?.state !== "working" || spec.status !== "building") continue;
            if (spec.change.waitTurn && record.role !== "error") { spec.change.waitTurn = false; continue; }
            if (running && record.role !== "error") continue;
            const words = (record.text.split(LINE_BREAKS).find((line) => line.length > 0) ?? "").trim();
            const why = record.role === "error"
              ? `Maintainer hit an error: ${clip(words || "no details", 200)}`
              : "Maintainer's turn ended without a new version" + (words ? `: ${clip(words, 200)}` : ".");
            spec.change.state = "failed";
            spec.change.error = why;
            spec.change.endedAt = toSwiftDate();
            spec.status = "done";
            spec.conversation.push({ kind: "event", text: `v${spec.change.version} not made: ${why}` });
            stopped.push(spec.name);
          }
        });
        for (const name of stopped) await this.doneWorking(name);
      }
    });
  }

  /** Maintainer's `<component-spec id>` (`applySpecUpdate`): its values go into the spec, its words into the side conversation. */
  componentSpec(botId: string, rawId: string, json: string): Promise<void> {
    return this.run(async () => {
      // Only Maintainer's: its last line is what it said with the update.
      const maintainer = await this.studio.maintainer();
      if (!maintainer || maintainer.id !== botId) return;
      const said = ((await this.studio.line(maintainer.id, { last: "bot" }))?.record.text as string | undefined) ?? "";
      const id = rawId.trim().toUpperCase();
      const found = UUID.test(id) ? this.locate(id) : null;
      if (!found) {
        await this.studio.note(maintainer.id, `(App: No component spec has the id ${rawId}; nothing changed.)`);
        return;
      }
      const { chat, spec: before } = found;
      const words = said.trim();
      await this.edit(chat, id, (spec) => {
        updateSpec(spec, json);
        if (spec.status === "building" && spec.change?.state === "working" && spec.built !== undefined && spec.questions[0]) {
          // A change Maintainer finds ambiguous: its one question waits for the user.
          spec.questions = [spec.questions[0]];
          spec.change.state = "asking";
          spec.status = "done";
        } else if (spec.status === "building") {
          answerOpenQuestions(spec);
        }
        if (words && spec.conversation.at(-1)?.text !== words) spec.conversation.push({ kind: "maintainer", text: words });
      });
      const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
      if (before.status !== "building" || !spec) return;
      const library = await this.library();
      if (spec.change?.state === "asking" && before.change?.state === "working") {
        for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
        await this.doneWorking(spec.name);
        return;
      }
      if (spec.reuse && spec.similar !== undefined && library.names.includes(spec.similar)) {
        for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
        await this.finish(id, spec.similar, chat);
      } else if (spec.name !== before.name && this.builds.has(before.name)) {
        // Built under another name: that one is waited for (a new one, or a change to it).
        const build = this.builds.get(before.name)!;
        this.builds.delete(before.name);
        await this.doneWorking(before.name);
        // 2.0: a component that landed under that name since the build began (the editor's work comes before
        // Maintainer's answer) is the one built; 1.x would wait for its template to change again.
        if (library.names.includes(spec.name) && build.before && !build.before.includes(spec.name)) {
          await this.finish(id, spec.name, chat);
          return;
        }
        this.builds.set(spec.name, { chat: build.chat, spec: build.spec, version: library.names.includes(spec.name) ? library.versionOf(spec.name) : null, before: build.before });
        await this.markWorking(spec.name, "built from a reply");
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // The output half (desk-output.ts)

  testRun(id: string, shown: string | null, shownFolder: string | null): Promise<ActResult> { return this.output.testRun(id, shown, shownFolder); }
  runComponent(id: string, shown: { command: string; folder: string; detail?: string; force?: boolean }): Promise<ActResult> { return this.output.runComponent(id, shown); }
  cardChanged(card: string): Promise<void> { return this.output.cardChanged(card); }
  build(id: string): Promise<ActResult> { return this.output.build(id); }
  finishBuilds(): Promise<void> { return this.output.finishBuilds(); }
  private finish(id: string, name: string, chat: string) { return this.output.finish(id, name, chat); }
  cancel(id: string): Promise<ActResult> { return this.output.cancel(id); }
  private flush() { return this.output.flush(); }
  publish() { return this.output.publish(); }
  payload(id: string) { return this.output.payload(id); }
  state() { return this.output.state(); }
}
