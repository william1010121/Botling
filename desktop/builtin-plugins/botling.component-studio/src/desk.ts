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
import type { ApprovalAskView, ComponentInfoView, DisplayView, SpecChipView } from "../../../src/contract";
import type { Clock } from "../../../src/core/briefing";
import { safeName } from "../../../src/core/components/library";
import { pageOfCard } from "../../../src/core/page-preview";
import { toSwiftDate, type ChatRecord } from "../../../src/core/store/records";
import {
  answerOpenQuestions, answerQuestion, buildRequest, changeRequest, clip, draftRequest, draftSpec, editSpecValue, filledData, fillRequest, firstBuildRequest,
  isFilling, lastCommand, LINE_BREAKS, nextVersion, outputMatches, preferredSample, readSpec, replyPages, sameSpec, sayRequest, shortTime, specCard, updateSpec,
  type ComponentSpec, type SpecChange,
} from "./specs";
import { judgeSuggestion } from "./suggestion-rules";
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
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

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

  constructor(private readonly deps: DeskDeps) {}

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
  private async finish(id: string, name: string, chat: string) {
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
  private async flush() {
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
      status: null, error: null, ranAt: null, images: null, pinned: null, every: null,
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
