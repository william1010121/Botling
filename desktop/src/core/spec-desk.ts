// "Make into component" and a bot's <suggest-component> (1.x's Workspace+Specs.swift): a reply becomes a
// component. Pressed, the reply goes to Maintainer, which infers the spec and builds the first version
// right away (or reuses a library component), asking nothing; the chip under the reply says Building…,
// then the component itself shows there, on the bot's list, filled by the bot that wrote the reply. Its
// "Edit spec" opens the spec in the right panel, where the user and Maintainer change it; once built,
// what the user types there is a change built as its next version. A command (Test run, the component's
// Command) runs only once the user allows it, as for any component card; nothing runs by itself.
import type { Bot, GuestAnswer } from "./bot";
import type { Clock } from "./briefing";
import type { ComponentCommands } from "./components/commands";
import { BUILT_INS, type ComponentLibrary } from "./components/library";
import type { ComponentInfoView, DisplayView, SpecChipView, SpecStateView } from "../contract";
import type { MaintainerDesk } from "./maintainer";
import { preview as previewOf } from "./bot";
import { pageOfCard } from "./page-preview";
import {
  answerOpenQuestions, answerQuestion, buildRequest, changeRequest, clip, draftRequest, draftSpec, editSpecValue, filledData, fillRequest, firstBuildRequest,
  isFilling, lastCommand, nextVersion, outputMatches, preferredSample, replyPages, sayRequest, shortTime, slug, specCard, updateSpec, type ComponentSpec,
  type SpecChange, LINE_BREAKS,
} from "./specs";
import { safeName } from "./components/library";
import { toSwiftDate, type ChatRecord } from "./store/records";
import type { Display } from "./reply";

/** How long a fill waits for the bot to be free, and then for its answer (`fillWait`, `fillAnswerTime`). */
export const FILL_TIMING = { wait: 3 * 60 * 60 * 1000, answer: 10 * 60 * 1000 };

export interface SpecDeskDeps {
  /** Every chat a spec can be in (`chatsWithPins`): the main bot's, projects' and bots', groups'. */
  chats: () => Bot[];
  library: ComponentLibrary;
  commands: ComponentCommands;
  maintainer: MaintainerDesk;
  maintainerBot: () => Bot | null;
  /** A bot by id (the one that said a line in a chat not its own). */
  member: (id: string) => Bot | null;
  /** The bots a component can go to (`botsWithComponents`, Maintainer left out). */
  bots: () => Bot[];
  /** The panel's spec changed, opened or closed. */
  emit: (spec: SpecStateView | null) => void;
  /** The library's working state changed. */
  componentsChanged: () => void;
  clock: () => Clock;
  log: (line: string) => void;
  timing?: typeof FILL_TIMING;
}

const ms = (swift: number | undefined) => (typeof swift === "number" ? Math.round((swift + 978_307_200) * 1000) : null);
const timeOfDay = (epochMs: number | null) => (epochMs === null ? null : new Date(epochMs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));

export class SpecDesk {
  /** The spec the right panel shows (`openSpecID`), and whether it is wide. */
  openId: string | null = null;
  wide = false;
  /** Specs being built, by the component name they wait for (`specBuilds`). */
  private builds = new Map<string, { chat: string; spec: string; version: number | null; before?: string[] }>();

  constructor(private readonly deps: SpecDeskDeps) {}

  private get library() { return this.deps.library; }
  private name(bot: Bot) { return bot.profile.name; }

  /** The spec `id`, and the chat whose reply it is made from (`specLocation`). */
  locate(id: string): { chat: Bot; spec: ComponentSpec } | null {
    for (const chat of this.deps.chats()) {
      const spec = chat.specs.find((candidate) => candidate.id === id);
      if (spec) return { chat, spec };
    }
    return null;
  }

  private store(spec: ComponentSpec, chat: Bot) {
    chat.editSpecs((specs) => { const at = specs.findIndex((candidate) => candidate.id === spec.id); if (at >= 0) specs[at] = spec; });
  }

  private edit(chat: Bot, id: string, change: (spec: ComponentSpec) => void) {
    chat.editSpecs((specs) => { const spec = specs.find((candidate) => candidate.id === id); if (spec) change(spec); });
  }

  private spec(chat: Bot, id: string): ComponentSpec | null {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    return spec ? structuredClone(spec) : null;
  }

  /** The folder a message's component commands run in (`commandFolder(for:in:)`). */
  private commandFolder(record: ChatRecord, chat: Bot): string {
    const writer = typeof record.sourceID === "string" ? this.deps.member(record.sourceID) : null;
    return (writer ?? chat).profile.folder;
  }

  private writerOf(record: ChatRecord, chat: Bot): Bot {
    return (typeof record.sourceID === "string" ? this.deps.member(record.sourceID) : null) ?? chat;
  }

  private markWorking(name: string, change: string) { this.library.markWorking(name, change); this.deps.componentsChanged(); }
  private doneWorking(name: string) { this.library.doneWorking(name); this.deps.componentsChanged(); }

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
  make(chat: Bot, messageId: string, purpose: string | null, preview: number | null = null): ComponentSpec | null {
    const record = chat.lines().find((line) => line.id === messageId);
    if (!record || (record.role !== "bot" && record.role !== "notice")) return null;
    let page: string | undefined;
    if (preview !== null) {
      const card = chat.previews(record)?.[preview];
      const path = card ? pageOfCard(card) : null;
      if (!path) return null;
      page = path;
    }
    const found = chat.specs.find((spec) => spec.messageID === messageId && spec.page === page);
    if (found) {
      if (found.existing !== undefined) this.open(found.id, chat);
      else if (SpecDesk.unstarted(found)) this.start(found.id, chat);
      return chat.specs.find((spec) => spec.id === found.id) ?? null;
    }
    const writer = this.writerOf(record, chat);
    const spec = draftSpec(record, this.name(writer), this.commandFolder(record, chat), this.library, toSwiftDate(), page ?? null);
    const words = purpose?.trim();
    if (words) spec.purpose = words;
    chat.editSpecs((specs) => { specs.push(spec); });
    if (spec.existing !== undefined) this.open(spec.id, chat);
    else this.start(spec.id, chat);
    return chat.specs.find((candidate) => candidate.id === spec.id) ?? null;
  }

  /** The first version (`startSpec`): Maintainer infers the spec from the reply and builds it now, asking nothing. */
  private start(id: string, chat: Bot) {
    const spec = this.spec(chat, id);
    if (!spec || !SpecDesk.unstarted(spec)) return;
    const writer = spec.bots[0] ?? this.name(chat);
    spec.status = "building";
    spec.asked = true;
    spec.conversation.push({ kind: "event", text: "Sent to Maintainer to build the first version" });
    this.store(spec, chat);
    const had = this.library.names.includes(spec.name);
    this.builds.set(spec.name, { chat: chat.id, spec: id, version: had ? this.library.versionOf(spec.name) : null, before: [...this.library.names] });
    this.markWorking(spec.name, "built from a reply");
    this.sendFirstBuild(id, chat, writer);
  }

  private sendFirstBuild(id: string, chat: Bot, writer: string) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec) return;
    const record = chat.lines().find((line) => line.id === spec.messageID);
    const asked = record ? this.askedBefore(record, chat) : null;
    this.deps.maintainer.handTo(firstBuildRequest(spec, {
      reply: record?.text ?? "", pages: record ? replyPages(record, spec.page ?? null) : [], ran: record ? lastCommand(record) : null, asked, bot: writer,
    }));
  }

  /** The user's own message that led to a reply (`askedMessage(before:in:)`). */
  private askedBefore(record: ChatRecord, chat: Bot): string | null {
    const lines = chat.lines();
    const at = lines.findIndex((line) => line.id === record.id);
    if (at < 0) return null;
    return lines.slice(0, at).findLast((line) => line.role === "user" && line.text.trim())?.text ?? null;
  }

  /** A spec's chip pressed (`pressSpec`): a suggestion is built; otherwise it opens, or folds back. */
  press(id: string, chat: Bot) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec) return;
    if (SpecDesk.unstarted(spec)) this.start(id, chat);
    else if (this.openId === id) this.close();
    else this.open(id, chat);
  }

  /** A bot's `<suggest-component>` (`suggestComponent`): a chip under its reply, nothing more. One per reply. */
  suggest(name: string, draft: string, bot: Bot) {
    const record = bot.lines().findLast((line) => line.role === "bot");
    if (!record || bot.specs.some((spec) => spec.messageID === record.id)) return;
    const spec = draftSpec(record, this.name(bot), bot.profile.folder, this.library, toSwiftDate());
    const named = safeName(name);
    if (spec.existing === undefined && named) {
      spec.name = named;
      if (spec.similar === named) delete spec.similar;
    }
    spec.about = draft.trim();
    // Its words are what the component is for.
    if (spec.about) spec.purpose = spec.about;
    spec.suggestedBy = this.name(bot);
    bot.editSpecs((specs) => { specs.push(spec); });
  }

  // ------------------------------------------------------------------------------------------
  // The panel

  /** The spec opens in the right panel (`openSpec`); the first time, Maintainer is asked to draft it. */
  open(id: string, chat: Bot) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec) return;
    const previous = this.openId;
    this.openId = id;
    const ask = !spec.asked && spec.existing === undefined && spec.status === "draft";
    this.edit(chat, id, (edited) => { edited.opened = true; if (ask) edited.asked = true; });
    if (previous && previous !== id) this.refreshChips(previous);
    this.refreshChips(id);
    this.publish();
    if (!ask) return;
    const record = chat.lines().find((line) => line.id === spec.messageID);
    this.deps.maintainer.handTo(draftRequest(chat.specs.find((candidate) => candidate.id === id)!, record?.text ?? "", record ? replyPages(record, spec.page ?? null) : [], record ? lastCommand(record) : null, spec.bots[0] ?? this.name(chat)));
  }

  /** Collapses the panel back to the chip (`closeSpec`). */
  close() {
    const was = this.openId;
    this.openId = null;
    this.wide = false;
    if (was) this.refreshChips(was);
    this.publish();
  }

  setWide(wide: boolean) {
    this.wide = wide;
    this.publish();
  }

  /** The chips under the spec's reply say whether it is open. */
  private refreshChips(id: string) {
    const found = this.locate(id);
    if (found?.spec.messageID) found.chat.refreshLine(found.spec.messageID);
  }

  /** The user changed a value in the panel (`editSpec`); not while it builds. */
  editValue(id: string, key: string, value: string, chat: Bot) {
    this.edit(chat, id, (spec) => { if (spec.status !== "building") editSpecValue(key, value, spec); });
  }

  /** The user picked an answer to one of Maintainer's questions (`answerSpec`). */
  answer(id: string, question: string, option: number, chat: Bot) {
    this.edit(chat, id, (spec) => { if (spec.status !== "building") answerQuestion(question, option, spec); });
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec || spec.built === undefined || spec.change?.state !== "asking" || spec.questions.length) return;
    this.sendChange(id, spec.change.said, null, chat);
  }

  /** "Ask for changes…" / "Anything to add?" (`saySpec`). */
  say(id: string, raw: string, request: string | null, chat: Bot) {
    const text = raw.trim();
    const spec = this.spec(chat, id);
    if (!spec || (!text && !spec.pendingEdits.length)) return;
    if (spec.status === "building") {
      if (!text) return;
      spec.conversation.push({ kind: "user", text });
      spec.queued = [...(spec.queued ?? []), text];
      const making = spec.change ? `v${spec.change.version}` : "the first version";
      spec.conversation.push({ kind: "event", text: `Queued: goes to Maintainer with the next change, once ${making} is in` });
      this.store(spec, chat);
      return;
    }
    if (spec.built !== undefined && spec.existing === undefined) {
      if (text) spec.conversation.push({ kind: "user", text });
      this.store(spec, chat);
      this.sendChange(id, text ? [text] : [], request, chat);
      return;
    }
    if (text) spec.conversation.push({ kind: "user", text });
    const said = sayRequest(spec, text);
    spec.pendingEdits = [];
    spec.asked = true;
    this.store(spec, chat);
    this.deps.maintainer.handTo(said);
  }

  /** A built component's change goes to Maintainer now, as its next version (`sendChange`). */
  private sendChange(id: string, said: string[], request: string | null, chat: Bot) {
    const spec = this.spec(chat, id);
    if (!spec || spec.built === undefined) return;
    const version = nextVersion(spec);
    const text = changeRequest(spec, said, version);
    const change: SpecChange = { state: "working", version, said, startedAt: toSwiftDate(), waitTurn: this.maintainerBusy(), ...(request ? { request } : {}) };
    this.beginBuild(spec, change, `Sent to Maintainer: building v${version} with this change`, chat);
    this.deps.maintainer.handTo(text);
  }

  private maintainerBusy(): boolean {
    const maintainer = this.deps.maintainerBot();
    return !!maintainer && maintainer.view().working;
  }

  /** The spec goes to building, and the app waits for its component to land (`beginBuild`). */
  private beginBuild(spec: ComponentSpec, change: SpecChange | null, event: string, chat: Bot) {
    spec.status = "building";
    spec.asked = true;
    if (change) spec.change = change;
    spec.questions = [];
    spec.pendingEdits = [];
    delete spec.queued;
    spec.conversation.push({ kind: "event", text: event });
    this.store(spec, chat);
    const had = this.library.names.includes(spec.name);
    this.builds.set(spec.name, { chat: chat.id, spec: spec.id, version: had ? this.library.versionOf(spec.name) : null, before: [...this.library.names] });
    this.markWorking(spec.name, change ? "changed from its spec panel" : "built from a component spec");
  }

  /** Maintainer's turn ended: a change that has not landed did not happen (`settleSpecChanges`). */
  settleChanges(record: ChatRecord, running: boolean) {
    for (const chat of this.deps.chats()) {
      if (!chat.specs.some((spec) => spec.change?.state === "working" && spec.status === "building")) continue;
      const stopped: string[] = [];
      chat.editSpecs((specs) => {
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
      for (const name of stopped) this.doneWorking(name);
    }
  }

  /** Maintainer's `<component-spec id>` (`applySpecUpdate`): its values go into the spec, its words into the side conversation. */
  applyUpdate(rawId: string, json: string, said: string) {
    const id = rawId.trim().toUpperCase();
    const found = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(id) ? this.locate(id) : null;
    if (!found) {
      this.deps.maintainerBot()?.queueNote(`(App: No component spec has the id ${rawId}; nothing changed.)`);
      return;
    }
    const { chat, spec: before } = found;
    const words = said.trim();
    this.edit(chat, id, (spec) => {
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
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (before.status !== "building" || !spec) return;
    if (spec.change?.state === "asking" && before.change?.state === "working") {
      for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
      this.doneWorking(spec.name);
      return;
    }
    if (spec.reuse && spec.similar !== undefined && this.library.names.includes(spec.similar)) {
      for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
      this.finish(id, spec.similar, chat);
    } else if (spec.name !== before.name && this.builds.has(before.name)) {
      // Built under another name: that one is waited for (a new one, or a change to it).
      const build = this.builds.get(before.name)!;
      this.builds.delete(before.name);
      this.doneWorking(before.name);
      // 2.0: a component that landed under that name since the build began (the editor's work comes before
      // Maintainer's answer) is the one built; 1.x would wait for its template to change again.
      if (this.library.names.includes(spec.name) && build.before && !build.before.includes(spec.name)) {
        this.finish(id, spec.name, chat);
        return;
      }
      this.builds.set(spec.name, { chat: build.chat, spec: build.spec, version: this.library.names.includes(spec.name) ? this.library.versionOf(spec.name) : null, before: build.before });
      this.markWorking(spec.name, "built from a reply");
    }
  }

  // ------------------------------------------------------------------------------------------
  // Test run

  /** Runs the spec's command once to see what it prints (`testRunSpec`), only once the user allowed it. */
  async testRun(id: string, chat: Bot, shown: string | null, shownFolder: string | null, approve: boolean) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    const command = spec?.command;
    if (!spec || command === undefined) return;
    const folder = spec.folder;
    if (approve && (shown === null || shownFolder === null)) return;
    if (shown !== null && shown !== command) return;
    if (shownFolder !== null && resolveFolder(shownFolder) !== resolveFolder(folder)) return;
    if (approve) this.deps.commands.approve(command, folder);
    this.edit(chat, id, (edited) => { if (edited.testRun?.command !== command) edited.testRun = { command, folder }; });
    if (!this.deps.commands.isApproved(command, folder)) { this.publish(); return; }
    const run = this.deps.commands.run(specCard(spec), command, folder, true);
    this.publish();
    await run;
    this.keepTestRun(id, command, chat);
  }

  /** The built component's card under the reply: Allow and run, ↻, its first draw (`runSpecComponent`). */
  async runComponent(id: string, chat: Bot, shown: { command: string; folder: string; detail?: string; approve?: boolean; force?: boolean }) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    const name = spec?.built;
    if (!spec || !name) return;
    const command = specCommand(spec, name, this.library);
    if (!command) return;
    const folder = spec.folder;
    if (shown.command !== command || resolveFolder(shown.folder) !== resolveFolder(folder)) return;
    if (shown.approve) {
      const detail = this.library.detailCommand(name);
      if (detail !== (shown.detail ?? null)) return;
      this.deps.commands.approve(command, folder);
      if (detail) this.deps.commands.approve(`Detail command: ${detail}`, folder);
    }
    if (!this.deps.commands.isApproved(command, folder)) return;
    await this.deps.commands.run(specCard(spec), command, folder, !!shown.force);
    this.keepTestRun(id, command, chat);
  }

  /** A finished test run, kept on the spec: its output, whether it fits the fields, a sample (`keepTestRun`). */
  private keepTestRun(id: string, command: string, chat: Bot) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec) return;
    const state = this.deps.commands.runOf(specCard(spec), command, spec.folder);
    if (!state || (state.status !== "done" && state.status !== "failed")) return;
    this.edit(chat, id, (edited) => {
      if (edited.command !== command && (edited.built === undefined || specCommand(edited, edited.built, this.library) !== command)) return;
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
  cardChanged(card: string) {
    const id = card.startsWith("spec/") ? card.slice(5) : null;
    const found = id ? this.locate(id) : null;
    if (!found) return;
    if (found.spec.messageID) found.chat.refreshLine(found.spec.messageID);
    if (this.openId === id) this.publish();
  }

  // ------------------------------------------------------------------------------------------
  // Build it

  /** Build it (`buildSpec`): open questions take their suggested answers; a component that exists goes straight onto the bots' lists. */
  build(id: string, chat: Bot) {
    const spec = this.spec(chat, id);
    if (!spec || spec.status === "building") return;
    answerOpenQuestions(spec);
    const existing = spec.existing ?? (spec.reuse && spec.similar !== undefined && this.library.names.includes(spec.similar) ? spec.similar : undefined);
    if (existing) {
      this.store(spec, chat);
      this.finish(id, existing, chat);
      return;
    }
    const request = buildRequest(spec);
    if (spec.built !== undefined) {
      // Rebuild: tracked as the next version, like a change typed in the panel.
      const version = nextVersion(spec);
      this.beginBuild(spec, { state: "working", version, said: [], startedAt: toSwiftDate(), waitTurn: this.maintainerBusy() }, `Sent to Maintainer to build a new version (v${version})`, chat);
    } else {
      this.beginBuild(spec, null, "Sent to Maintainer to build", chat);
    }
    this.deps.maintainer.handTo(request);
  }

  /** Specs being built whose component is now in the library (new, or its template changed since Build): added to their bots (`finishSpecBuilds`). */
  finishBuilds() {
    for (const [name, build] of [...this.builds]) {
      if (!this.library.names.includes(name)) continue;
      if (build.version !== null && this.library.versionOf(name) === build.version) continue;
      this.builds.delete(name);
      const chat = this.deps.chats().find((candidate) => candidate.id === build.chat);
      if (chat) this.finish(build.spec, name, chat);
    }
  }

  /** The component is in the library: on each chosen bot's list, the spec done, the chat told (`finish`). */
  private finish(id: string, name: string, chat: Bot) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec) return;
    this.doneWorking(name);
    this.doneWorking(spec.name);
    const added: string[] = [];
    const had: string[] = [];
    const full: string[] = [];
    for (const botName of spec.bots) {
      const holder = this.deps.maintainer.holder(botName);
      if (!holder) continue;
      if (holder.ownComponentNames.includes(name)) had.push(this.name(holder));
      else if (this.deps.maintainer.giveComponent(name, holder)) {
        added.push(this.name(holder));
        holder.queueNote(`(App: The user added the component "${name}" to your list.)`);
      } else if (holder.components !== null) full.push(this.name(holder));
    }
    let queued: string[] = [];
    this.edit(chat, id, (edited) => {
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
      chat.appNotice(text);
    }
    this.askToFill(id, name, chat);
    // What the user typed meanwhile goes now, as the next version.
    if (queued.length) this.sendChange(id, queued, null, chat);
  }

  // ------------------------------------------------------------------------------------------
  // Filled by the bot that wrote the reply

  /** Built without a command: the bot that wrote the reply draws it for that reply, in a quiet turn (`askToFill`). */
  private askToFill(id: string, name: string, chat: Bot) {
    const spec = chat.specs.find((candidate) => candidate.id === id);
    if (!spec || spec.existing !== undefined || specCommand(spec, name, this.library) !== null) return;
    const reply = chat.lines().find((line) => line.id === spec.messageID);
    if (!reply) return;
    const writer = this.writerOf(reply, chat);
    const pages = replyPages(reply, spec.page ?? null).map((page) => page.path);
    const request = fillRequest(spec, name, { text: reply.text, when: shortTime(reply.date, this.deps.clock()), preview: previewOf(reply) }, pages, this.library.catalog([name]));
    const writerName = this.name(writer);
    this.edit(chat, id, (edited) => {
      edited.filledBy = writerName;
      // A new version's data may differ: the old fill waits for the new one.
      delete edited.filled;
      delete edited.fillError;
      edited.conversation.push({ kind: "event", text: `Asked ${writerName} to fill it from its reply` });
    });
    const timing = this.deps.timing ?? FILL_TIMING;
    void writer.groupTurn(request, timing.wait, timing.answer).then((answer) => this.takeFill(answer, id, name, chat, writerName), (error) => this.takeFill({ kind: "failed", why: (error as Error).message }, id, name, chat, writerName));
  }

  /** The bot's answer to the fill request: its `<show>` data goes under the reply (`takeFill`). */
  private takeFill(answer: GuestAnswer, id: string, name: string, chat: Bot, writer: string) {
    const result = answer.kind === "reply" ? filledData(answer.text, name) : answer.kind === "busy" ? { problem: "it stayed busy" } : { problem: answer.why };
    this.edit(chat, id, (spec) => {
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
  cancel(id: string, chat: Bot) {
    chat.editSpecs((specs) => { const at = specs.findIndex((spec) => spec.id === id); if (at >= 0) specs.splice(at, 1); });
    for (const [name, build] of [...this.builds]) if (build.spec === id) this.builds.delete(name);
    if (this.openId === id) this.close();
  }

  // ------------------------------------------------------------------------------------------
  // What the page draws

  /** A chat's specs changed: the panel follows when it shows one of them. */
  specsChanged(chat: Bot) {
    if (this.openId && chat.specs.some((spec) => spec.id === this.openId)) this.publish();
    else if (this.openId && !this.locate(this.openId)) { this.openId = null; this.wide = false; this.deps.emit(null); }
  }

  publish() {
    this.deps.emit(this.openId ? this.payload(this.openId) : null);
  }

  /** The chips of the specs made from `record`, each built one with its component (`specChips`); and the component the reply already is. */
  lineExtras(chat: Bot, record: ChatRecord): { specs?: SpecChipView[]; component?: string } {
    const out: { specs?: SpecChipView[]; component?: string } = {};
    const chips = chat.specs.filter((spec) => spec.messageID === record.id).map((spec): SpecChipView => {
      const chip: SpecChipView = { id: spec.id, name: spec.name.slice(0, 200), status: spec.status, suggested: spec.suggestedBy !== undefined && spec.status === "draft" && spec.built === undefined, open: spec.id === this.openId, component: null, display: null, filling: null };
      const shown = this.display(spec);
      if (shown) { chip.component = shown.name; chip.display = shown; }
      else if (isFilling(spec) && spec.built && this.library.names.includes(spec.built)) { chip.component = spec.built; chip.filling = spec.filledBy ?? null; }
      return chip;
    });
    if (chips.length) out.specs = chips.slice(0, 20);
    if (record.role === "bot") {
      const own = ((record.displays ?? []) as Display[]).find((display) => !BUILT_INS.includes(display.name) && this.library.names.includes(display.name));
      if (own) out.component = own.name;
    }
    return out;
  }

  /** A built spec's component as drawn under its reply (`specDisplay`). */
  private display(spec: ComponentSpec): DisplayView | null {
    const name = spec.built;
    if (!name || !this.library.names.includes(name)) return null;
    const command = specCommand(spec, name, this.library);
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
    const detail = this.library.detailCommand(name);
    view.command = command;
    view.folder = spec.folder;
    view.detail = detail;
    view.card = detail ? specCard(spec) : null;
    const state = this.deps.commands.state(specCard(spec), command, detail, spec.folder);
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
  payload(id: string): SpecStateView | null {
    const found = this.locate(id);
    if (!found) return null;
    const { chat, spec } = found;
    const library = this.library;
    const has = (name: string | undefined): name is string => !!name && library.names.includes(name);
    const preview = has(spec.built) ? spec.built : spec.status === "done" && has(spec.name) ? spec.name : has(spec.existing) ? spec.existing
      : spec.reuse && has(spec.similar) ? spec.similar : has(spec.shownAs) ? spec.shownAs : null;
    const components: Record<string, ComponentInfoView> = {};
    if (preview) {
      const info = library.info(preview);
      if (info) components[preview] = { template: info.template.slice(0, 1_000_000), version: info.version, updated: info.updated, working: info.working, hasPrevious: false, sizes: info.sizes.slice(0, 16), icon: info.icon, title: info.title?.slice(0, 200) ?? null };
    }
    const chosen = new Set(spec.bots.map((name) => name.toLowerCase()));
    const every = this.deps.bots().map((bot) => this.name(bot));
    const bots = [...every, ...spec.bots.filter((name) => !every.some((other) => other.toLowerCase() === name.toLowerCase()))].map((name) => ({ name: name.slice(0, 200), on: chosen.has(name.toLowerCase()) }));
    let testRun: SpecStateView["testRun"] = null;
    const command = spec.command;
    if (command !== undefined && (spec.testRun?.command === command || this.deps.commands.lastRan(specCard(spec)) !== null)) {
      const state = this.deps.commands.state(specCard(spec), command, null, spec.folder);
      let status = state.status;
      // Kept from before (a restart): shown as done until run again.
      if (status === "idle" && (spec.testRun?.output !== undefined || spec.testRun?.error !== undefined)) status = spec.testRun?.output !== undefined ? "done" : "failed";
      const output = state.data ?? spec.testRun?.output ?? null;
      testRun = { status, command, folder: spec.folder, output, error: state.error ?? spec.testRun?.error ?? null, ranAt: timeOfDay(state.ranAt ?? ms(spec.testRun?.ranAt)), matches: output === null ? null : outputMatches(output, spec.fields) };
    }
    let steps: SpecStateView["steps"] = null;
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
    const reply = chat.lines().find((line) => line.id === spec.messageID);
    const writer = reply ? this.name(this.writerOf(reply, chat)) : this.name(chat);
    const at = reply ? ` at ${shortTime(reply.date, this.deps.clock())}` : "";
    const from = spec.suggestedBy !== undefined ? `suggested by ${spec.suggestedBy}` : spec.page !== undefined ? `from ${writer}'s result page${at}` : `from ${writer}'s reply${at}`;
    // What the bot drew under the reply is "This reply" in the preview.
    const samples = spec.filled !== undefined ? [{ label: "This reply", kind: "reply" as const, data: spec.filled }, ...spec.samples.filter((entry) => entry.kind !== "reply")] : spec.samples;
    const similarAbout = spec.similar !== undefined && library.names.includes(spec.similar) ? (library.summaries([spec.similar]).split(":").slice(1).join(":").trim() || null) : null;
    return {
      id: spec.id, name: spec.name.slice(0, 200), about: spec.about.slice(0, 20_000), status: spec.status, draft: spec.draft, chat: this.name(chat).slice(0, 400), from: from.slice(0, 400),
      suggestedBy: spec.suggestedBy ?? null, existing: spec.existing ?? null,
      fields: spec.fields.slice(0, 200).map((field) => ({ name: field.name.slice(0, 400), type: field.type.slice(0, 400), by: field.by })),
      command: spec.command ?? null, folder: spec.folder.slice(0, 4_000), refresh: spec.refresh, minutes: spec.minutes, bots: bots.slice(0, 500),
      similar: spec.similar ?? null, similarAbout: similarAbout?.slice(0, 4_000) ?? null, reuse: spec.reuse,
      samples: samples.slice(0, 50).map((entry) => ({ label: entry.kind ? ({ testRun: "Test run", reply: "This reply", page: "This page" } as const)[entry.kind] : entry.label.slice(0, 400), kind: entry.kind, data: entry.data.slice(0, 1_100_000) })),
      preferredSample: preferredSample(samples, spec.status === "done" && spec.command !== undefined),
      questions: spec.questions.slice(0, 20).map((question) => ({ id: question.id.slice(0, 200), text: question.text.slice(0, 4_000), options: question.options.slice(0, 20).map((option) => ({ label: option.label.slice(0, 400) })), suggested: question.suggested ?? null })),
      conversation: spec.conversation.slice(-500).map((line) => lineView(line)),
      origins: spec.origins, preview, components, testRun, steps,
      version: spec.built === undefined ? null : spec.version ?? 1,
      change: spec.change ? { state: spec.change.state, version: spec.change.version, startedAt: ms(spec.change.startedAt)!, endedAt: ms(spec.change.endedAt), error: spec.change.error ?? null, request: spec.change.request ?? null } : null,
      queued: (spec.queued ?? []).slice(0, 50), wide: this.wide,
    };
  }
}

/** The command a built spec's component takes its data from (`specCommand`): a reused component's own first. */
export function specCommand(spec: ComponentSpec, name: string, library: ComponentLibrary): string | null {
  return spec.reuse ? library.command(name) ?? spec.command ?? null : spec.command ?? null;
}

const resolveFolder = (folder: string) => folder.replace(/\/+$/, "");

/** A line of the side conversation, its Markdown pictures of local files apart (`SpecPayload.LineView`). */
export function lineView(line: { kind: "user" | "maintainer" | "event"; text: string }): SpecStateView["conversation"][number] {
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

export { slug };
