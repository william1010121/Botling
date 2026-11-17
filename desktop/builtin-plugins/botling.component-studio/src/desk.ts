// A bot's <suggest-component> (1.x's Workspace+Specs.swift; the core's spec-desk.ts before this plugin): a chip under its reply. Pressed, the reply
// goes to Maintainer, which infers the spec and builds the first version right away (or a library component that already does it goes
// straight on the bot's list), asking nothing; the chip under the reply says Building…, then the component itself shows there, on the bot's
// list, filled by the bot that wrote the reply. A command (the component's Command) runs only once the user allows it, as for any component
// card; nothing runs by itself.
//
// The specs stay where the core keeps them (specs.json beside each chat, 1.x's format): this desk reads them all when it starts, keeps its
// own copy (it is the only writer) and writes a chat's whole list back through the studio seam after each change. Everything it does is one
// step at a time (`run`), as the core's was synchronous: a tag, an event or a press never sees a spec half changed.
import { safeName } from "../../../src/core/components/library";
import { toSwiftDate, type ChatRecord } from "../../../src/core/store/records";
import { answerOpenQuestions, draftSpec, firstBuildRequest, lastCommand, readSpec, replyPages, sameSpec, updateSpec, type ComponentSpec } from "./specs";
import { judgeSuggestion } from "./suggestion-rules";
import type { LibraryView, StudioChat, StudioLine } from "./studio";
import { SpecDeskOutput, type ActResult, type DeskDeps } from "./desk-output";

// The output half of the desk (the card run, the landing of a build, the fill, what the page draws) is in desk-output.ts; these stay exported from here.
export { FILL_TIMING, specCommand } from "./desk-output";
export type { ActResult, ChipDecoration, DeskDeps } from "./desk-output";

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export class SpecDesk {
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
    this.output = new SpecDeskOutput({
      deps, mirror: this.mirror, builds: this.builds, dirty: this.dirty, decorated: this.decorated,
      run: (step) => this.run(step), act: (id, step) => this.act(id, step), library: (withInfo) => this.library(withInfo),
      specsOf: (chat) => this.specsOf(chat), locate: (id) => this.locate(id), edit: (chat, id, change) => this.edit(chat, id, change),
      line: (chat, id) => this.line(chat, id), writerOf: (record, chat) => this.writerOf(record, chat), doneWorking: (name) => this.doneWorking(name),
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

  /** A spec's chip pressed (`pressSpec`): a suggestion is built; one the library already has goes on the bots' lists. */
  press(id: string): Promise<ActResult> {
    return this.act(id, async (chat, spec) => {
      if (SpecDesk.unstarted(spec)) await this.start(id, chat);
      else if (spec.status === "draft" && spec.existing !== undefined) await this.finish(id, spec.existing, chat);
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
  // One step on a spec

  /** One step on a spec found by its id: not accepted when there is no such spec. */
  private act(id: string, step: (chat: string, spec: ComponentSpec) => Promise<void | ActResult>): Promise<ActResult> {
    return this.run(async () => {
      const found = this.locate(id.toUpperCase());
      if (!found) return { accepted: false };
      const result = await step(found.chat, found.spec);
      return result ?? { accepted: true };
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
        // Nothing asks the user while it builds: Maintainer's open questions take their suggested answers.
        if (spec.status === "building") answerOpenQuestions(spec);
        if (words && spec.conversation.at(-1)?.text !== words) spec.conversation.push({ kind: "maintainer", text: words });
      });
      const spec = this.specsOf(chat).find((candidate) => candidate.id === id);
      if (before.status !== "building" || !spec) return;
      const library = await this.library();
      if (spec.reuse && spec.similar !== undefined && library.names.includes(spec.similar)) {
        for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
        await this.finish(id, spec.similar, chat);
      } else if (spec.name !== before.name && this.builds.has(before.name)) {
        // Built under another name: that one is waited for.
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

  runComponent(id: string, shown: { command: string; folder: string; detail?: string; force?: boolean }): Promise<ActResult> { return this.output.runComponent(id, shown); }
  cardChanged(card: string): Promise<void> { return this.output.cardChanged(card); }
  finishBuilds(): Promise<void> { return this.output.finishBuilds(); }
  private finish(id: string, name: string, chat: string) { return this.output.finish(id, name, chat); }
  private flush() { return this.output.flush(); }
}
