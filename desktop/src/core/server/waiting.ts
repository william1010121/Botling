// M7-S65: `CoreWaiting` cut out of `Core` (core/server.ts). What waits on you (`waiting`, `refreshWaiting`, `ignoreWaiting`) and the workspace
// for plugins (`api.workspace`: `workspaceSource`, the digest and the watch that notices a change). Same bridge convention as `CoreWatch`
// (core/server/watch.ts, in its header): a block of one-line forwarders to `host` first, then the members as they were in `Core`, byte for
// byte (a member that `Core` or another collaborator calls lost its `private`).
import type { Core } from "../server";
import { Bot } from "../bot";
import { type BotProfile, Layout } from "../store/workspace";
import { type BotSummary, type CurrentChat, type MemorySections, type ResultLink, type WorkspaceDigest, type WorkspaceSource, WorkspaceWatch, currentChat } from "../workspace";
import { type WaitingView } from "../../contract";
import { agyWorkerList } from "../agy-usage-db";
import { basename, join } from "node:path";
import { botFace } from "../faces";
import { firstLine } from "../projects";
import { fromSwiftDate, isOpenQuestion } from "../store/records";
import { readSettings, readSettingsList, settingsView, writeSettings } from "../settings";
import { savedQuestions } from "../questions";
import { status, statusText } from "../../contract/bot-status";

export class CoreWaiting {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private get agents() { return this.host.agents; }
  private get bots() { return this.host.bots; }
  private checkBot(...a: Parameters<Core["checkBot"]>) { return this.host.checkBot(...a); }
  private get epoch() { return this.host.epoch; }
  private event(...a: Parameters<Core["event"]>) { return this.host.event(...a); }
  private ignoreQuestion(...a: Parameters<Core["ignoreQuestion"]>) { return this.host.ignoreQuestion(...a); }
  private ignoreWaitingOn(...a: Parameters<Core["ignoreWaitingOn"]>) { return this.host.ignoreWaitingOn(...a); }
  private isMainBotId(...a: Parameters<Core["isMainBotId"]>) { return this.host.isMainBotId(...a); }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get mainBotId() { return this.host.mainBotId; }
  private get memoryFiles() { return this.host.memoryFiles; }
  private memoryTargets(...a: Parameters<Core["memoryTargets"]>) { return this.host.memoryTargets(...a); }
  private get memoryWatch() { return this.host.memoryWatch; }
  private get options() { return this.host.options; }
  private peerBotFor(...a: Parameters<Core["peerBotFor"]>) { return this.host.peerBotFor(...a); }
  private pluginBot(...a: Parameters<Core["pluginBot"]>) { return this.host.pluginBot(...a); }
  private get plugins() { return this.host.plugins; }
  private get profiles() { return this.host.profiles; }
  private get removed() { return this.host.removed; }
  private get runMainBot() { return this.host.runMainBot; }
  private get serverAsks() { return this.host.serverAsks; }
  private get shownChat() { return this.host.shownChat; }

  /** Plugins' workspace changes (`workspace.onChange`): the watch while some plugin listens, its next check, and its clock. */
  private workspaceWatch: WorkspaceWatch | null = null;
  private workspaceTimer: NodeJS.Timeout | null = null;
  private workspaceClock: NodeJS.Timeout | null = null;
  /** What waits on you as the windows were last told, and the timers that look again. */
  lastWaiting = "";
  waitingTimer: NodeJS.Timeout | null = null;

  waiting(): WaitingView {
    // When a question was asked (its line's time), for the whiteboard's "2h ago".
    const asked = (chat: Bot | null | undefined, id: string): { at?: string } => {
      const date = chat?.line(id)?.date;
      return typeof date === "number" && Number.isFinite(date) ? { at: new Date(fromSwiftDate(date)).toISOString() } : {};
    };
    const ignored = new Set(readSettingsList(readSettings(Layout.settings(this.options.dataDir)).ignoredWaiting));
    const out: WaitingView["items"] = [];
    const doing: WaitingView["doing"] = {};
    // Use the recorded choices, not a possibly unrelated opening sentence. This is only a
    // preview: the original question, recommendations and permission actions stay in chat.
    const addQuestion = (botId: string, chat: Bot | null | undefined, question: { id: string; text: string }) => {
      const legacyText = firstLine(question.text).slice(0, 400);
      // A question is set aside only by its own id (`chat.ignoreQuestion`, the line's `ignoredAt`, which `openQuestion()`
      // already skips), never by a text key: a plain item's `<botId>-<text>` key must not hide a later question whose
      // preview is that text (fu-waiting-plain-ignore).
      const line = chat?.line(question.id);
      const choices = line?.choices;
      const group = savedQuestions(line?.questions);
      // A question group: its questions, numbered (each one's options stay in the chat).
      const labels = group ? group.map((item, index) => `${index + 1}. ${(item.question || item.options.map((option) => option.label).join(" / ")).replace(/\s+/g, " ").trim()}`) : Array.isArray(choices) ? choices.flatMap((choice, index) =>
        typeof choice?.label === "string" && choice.label.trim() ? [`${index + 1}. ${choice.label.trim().replace(/\s+/g, " ")}`] : []) : [];
      // Keep a directly stated question for context (e.g. Yes / No); never infer one from prose.
      const questionLead = /[?？][*_`]*$/.test(legacyText.trim()) ? `${legacyText} — ` : "";
      const preview = labels.length ? questionLead + labels.join(" / ") : legacyText;
      const text = preview.length > 400 ? `${preview.slice(0, 399)}…` : preview;
      out.push({ botId, text, messageId: question.id, ...asked(chat, question.id) });
    };
    for (const profile of this.profiles) {
      if (profile.role === "main" || profile.parent) continue;
      // A manager's Now card: the first thing under "In progress" in its memory.md.
      if (profile.role === "manager" && !profile.problem) {
        const first = this.memoryFiles.items(join(profile.folder, profile.memoryPath), "inProgress")[0];
        if (first) doing[profile.id] = first.slice(0, 400);
      }
      const question = this.bots.get(profile.id)?.guests.openQuestion();
      if (question) addQuestion(profile.id, this.bots.get(profile.id), question);
      else for (const item of this.memoryFiles.items(join(profile.folder, profile.memoryPath), "waitingOnYou")) out.push({ botId: profile.id, text: item.slice(0, 400), messageId: null });
    }
    for (const question of this.mainBot()?.subagentRowBook.openQuestions() ?? []) addQuestion(this.mainBotId, this.mainBot(), question);
    // M5-06c: the server's own open questions (a fetch waiting for its card). The Maintainer is a manager and its
    // `openQuestion()` sees only `role: "bot"` lines, so these app questions would be missing from the summary.
    for (const [id, pending] of this.serverAsks) {
      const chat = this.bots.get(pending.botId);
      const line = chat?.line(id);
      if (line && isOpenQuestion(line)) addQuestion(pending.botId, chat, { id, text: line.text });
    }
    const acked = [...ignored].filter((key) => key.includes("-task:")).slice(-200);
    // Text keys (`ignoredWaiting`, 1.x's `<botId>-<text>`) set aside plain items only (`messageId` null).
    return { items: out.filter((item) => item.messageId !== null || !ignored.has(`${item.botId}-${item.text}`)).slice(0, 200), doing, ...(acked.length ? { acked } : {}) };
  }

  /** A bot's memory.md sections (empty when its folder has a problem); read and parsed once per change of the file (MemoryFiles). */
  private memorySections(profile: BotProfile): MemorySections {
    const file = join(profile.folder, profile.memoryPath);
    const items = (section: keyof MemorySections) => (profile.problem ? [] : this.memoryFiles.items(file, section).slice(0, 20).map((item) => item.slice(0, 400)));
    return { currentStatus: items("currentStatus"), inProgress: items("inProgress"), decided: items("decided"), waitingOnYou: items("waitingOnYou") };
  }

  /** The links handed over in a bot's chat, newest first. */
  private resultLinks(bot: Bot, limit: number): ResultLink[] {
    return bot.results().slice(0, limit).map((result) => ({ label: result.label.slice(0, 400), url: result.url.slice(0, 4_000) }));
  }

  // ------------------------------------------------------------------------------------------
  // The workspace for plugins (`api.workspace`, plugin-extraction.md §4.3): what the whiteboard reads,
  // one method each, read only. The main bot is "main" to plugins, as in `bots.list`.

  outId(id: string) {
    return this.isMainBotId(id) ? "main" : id;
  }

  /** The bot a plugin names, with its profile; throws when there is none. */
  private workspaceBot(botId: string): { bot: Bot; profile: BotProfile } {
    const bot = this.pluginBot(botId);
    const profile = bot ? this.profiles.find((candidate) => candidate.id === bot.id) : undefined;
    if (!bot || !profile) throw new Error("No such bot.");
    return { bot, profile };
  }

  /** Every bot (sub bots too), in the left column's order. */
  private workspaceBots(): { bot: Bot; profile: BotProfile }[] {
    return this.profiles.flatMap((profile) => {
      const bot = this.removed.has(profile.id) ? undefined : this.bots.get(profile.id);
      return bot ? [{ bot, profile }] : [];
    });
  }

  private botSummary(bot: Bot, profile: BotProfile, pinned: Set<string>): BotSummary {
    const view = bot.view();
    return {
      id: this.outId(bot.id), name: profile.name.slice(0, 200), role: profile.role, parent: profile.parent ? this.outId(profile.parent) : null,
      folder: basename(profile.folder.replace(/[\\/]+$/, "")).slice(0, 400), engine: view.heads[0] ?? "claude", busy: view.working, asleep: view.phase === "asleep",
      avatar: profile.avatar.slice(0, 40), pinned: pinned.has(bot.id),
      lastActivity: view.lastActivity ?? null, job: view.job?.slice(0, 400) ?? null, subagents: view.subagents, guest: !!view.guest, approvals: view.approvals,
      status: { key: status(view), text: statusText(view) },
      lastReply: profile.role === "main" ? bot.lines().findLast((line) => line.role === "bot" && line.text.trim())?.text.slice(0, 400) ?? null : null,
    };
  }

  /** What waits on you with plugins' bot ids. */
  private workspaceWaiting(): WaitingView {
    const view = this.waiting();
    const main = `${this.mainBotId}-`;
    return {
      items: view.items.map((item) => ({ ...item, botId: this.outId(item.botId) })),
      doing: Object.fromEntries(Object.entries(view.doing).map(([id, text]) => [this.outId(id), text])),
      ...(view.acked ? { acked: view.acked.map((key) => (this.runMainBot && key.startsWith(main) ? `main-${key.slice(main.length)}` : key)) } : {}),
    };
  }

  workspaceSource(): WorkspaceSource {
    return {
      bots: () => {
        const pinned = new Set(settingsView(readSettings(Layout.settings(this.options.dataDir))).pinnedBots);
        return this.workspaceBots().map(({ bot, profile }) => this.botSummary(bot, profile, pinned));
      },
      memory: (botId) => this.memorySections(this.workspaceBot(botId).profile),
      // Task cards were removed in 2.5: both stay for plugins that still ask, and answer nothing.
      tasks: (botId) => { this.workspaceBot(botId); return []; },
      taskHistory: (botId) => { this.workspaceBot(botId); return []; },
      results: (botId, limit) => this.resultLinks(this.workspaceBot(botId).bot, limit),
      waiting: () => this.workspaceWaiting(),
      ignoreWaiting: (botId, text) => {
        // A bot of this machine first ("main" is the local main bot whatever a peer's rows say: `peerBotFor`), then a peer's (M5-04d).
        const peer = this.peerBotFor(botId);
        if (peer) this.ignoreWaitingOn(peer, text);
        else this.ignoreWaiting(this.workspaceBot(botId).bot.id, text);
      },
      pendingApprovals: (botId) => this.workspaceBot(botId).bot.questions.pendingApprovals(),
      face: (botId, look) => {
        const { bot } = this.workspaceBot(botId);
        const view = bot.view();
        const waiting = view.approvals > 0 || this.waiting().items.some((item) => item.botId === bot.id);
        return botFace(view, look, { asleep: view.phase === "asleep", working: view.working, waiting });
      },
      current: () => this.currentChat(),
      agyWorkers: (sessionId) => agyWorkerList(this.agents.all, sessionId, this.options.dataDir),
    };
  }

  /** The chat the user has open in the main window, for plugins (`workspace.current`); null: none, or gone. */
  private currentChat(): CurrentChat | null {
    const shown = this.shownChat;
    const bot = shown && !this.removed.has(shown.botId) ? this.bots.get(shown.botId) : undefined;
    if (!shown || !bot) return null;
    return currentChat(shown, this.outId(bot.id), bot.view().heads[0] ?? "claude", bot.workers.headSessions());
  }

  /** What each workspace method would answer, by bot and kind: what a change is noticed by. */
  private workspaceDigest(): WorkspaceDigest {
    const pinned = new Set(settingsView(readSettings(Layout.settings(this.options.dataDir))).pinnedBots);
    const waiting = this.workspaceWaiting();
    const out: WorkspaceDigest = {};
    for (const { bot, profile } of this.workspaceBots()) {
      const id = this.outId(bot.id);
      out[id] = {
        bots: JSON.stringify(this.botSummary(bot, profile, pinned)),
        memory: JSON.stringify(this.memorySections(profile)),
        waiting: JSON.stringify([waiting.items.filter((item) => item.botId === id), waiting.doing[id] ?? null, bot.questions.pendingApprovals()]),
        results: JSON.stringify(this.resultLinks(bot, 100)),
      };
    }
    // Only the bot shown has a "current": a switch names the one left and the one opened.
    const current = this.currentChat();
    if (current && out[current.botId]) out[current.botId].current = JSON.stringify(current);
    return out;
  }

  /**
   * Some plugin listens for workspace changes, or none does any more (Plugins, as soon as the host says so).
   * Listening: what is there now is the start; a change is looked for soon after any event, and every 5 s.
   */
  watchWorkspace(on: boolean) {
    if (!on) {
      this.workspaceWatch?.stop();
      if (this.workspaceTimer) { clearTimeout(this.workspaceTimer); this.workspaceTimer = null; }
      if (this.workspaceClock) { clearInterval(this.workspaceClock); this.workspaceClock = null; }
      return;
    }
    this.workspaceWatch ??= new WorkspaceWatch(this.epoch);
    try { this.workspaceWatch.start(this.workspaceDigest()); } catch (error) { this.log(`workspace: ${(error as Error).message}`); return; }
    if (!this.workspaceClock) {
      this.workspaceClock = setInterval(() => this.checkWorkspace(), 5_000);
      this.workspaceClock.unref?.();
    }
  }

  /** Looks for a workspace change within a second (once, however many events come meanwhile). */
  checkWorkspaceSoon() {
    if (!this.workspaceWatch?.watching || this.workspaceTimer) return;
    this.workspaceTimer = setTimeout(() => { this.workspaceTimer = null; this.checkWorkspace(); }, 1_000);
    this.workspaceTimer.unref?.();
  }

  private checkWorkspace() {
    if (!this.workspaceWatch?.watching) return;
    let change;
    try { change = this.workspaceWatch.check(this.workspaceDigest()); } catch (error) { this.log(`workspace: ${(error as Error).message}`); return; }
    if (change) this.plugins.workspaceChanged(change);
  }

  /** Tells the windows when what waits on you changed (1.x's `refreshWaiting`, after anything that may change it). */
  refreshWaiting() {
    // A memory file changed, maybe: plugins watching the workspace look again.
    this.checkWorkspaceSoon();
    // Bots added or removed since: their memory files watched (or no longer).
    if (this.memoryWatch) { this.memoryWatch.sync(); this.memoryFiles.keepOnly(this.memoryTargets().map((target) => target.path)); }
    let view: WaitingView;
    try { view = this.waiting(); } catch (error) { this.log(`waiting: ${(error as Error).message}`); return; }
    const text = JSON.stringify(view);
    if (text === this.lastWaiting) return;
    this.lastWaiting = text;
    this.event({ type: "waiting.updated", waiting: view });
  }

  /** A refresh soon after a chat changed (several changes in a row make one). */
  waitingSoon() {
    if (this.waitingTimer) return;
    this.waitingTimer = setTimeout(() => { this.waitingTimer = null; this.refreshWaiting(); }, 150);
    this.waitingTimer.unref?.();
  }

  /** Takes one off the list without answering it (settings' `ignoredWaiting`, 1.x's ids). */
  ignoreWaiting(botId: string, text: string): WaitingView {
    this.checkBot(botId);
    // A command reached this server because it owns the target (the front end sends a peer bot's command to its owner,
    // and the slot engine refuses a target that is not `bot:<botId>`), so it is never sent on to another machine (§11.2
    // step 5: no second hop). The legacy handler runs before that target check, so forwarding here would let a peer send
    // a command to a third machine as this server. A peer's item is set aside from the workspace source (M5-04d).
    // A text that is on the list only as an open question (a client that names it by its text, such as the whiteboard) is
    // set aside by the question's id, as "Ignore" on the card does: a text key would hide a later question with that preview.
    const items = this.waiting().items.filter((item) => item.botId === botId && item.text === text);
    if (items.length && items.every((item) => item.messageId !== null)) {
      for (const item of items) if (item.messageId) this.ignoreQuestion(botId, item.messageId);
      this.refreshWaiting();
      return this.waiting();
    }
    const file = Layout.settings(this.options.dataDir);
    const raw = readSettings(file);
    const ignored = readSettingsList(raw.ignoredWaiting);
    const key = `${botId}-${text}`;
    // Only the last 200: old ones are long answered or gone (1.x).
    if (!ignored.includes(key)) writeSettings(file, { ...raw, ignoredWaiting: [...ignored, key].slice(-200) });
    this.refreshWaiting();
    return this.waiting();
  }

  /**
   * peer-answer-guard: whether a peer server's `waiting.ignore{botId, text}` may go ahead here. Yes for a plain waiting
   * item (no card: `messageId` null) on the list now, never for a question or approval card or a text that is not on
   * the list. Also yes for a key that is already ignored: the owner checks the scope before the handler runs and again
   * when it stores the outcome, and by then the handler has set the item aside; a repeat of an ignore is a no-op.
   */
  peerMayIgnoreWaiting(botId: string, text: string): boolean {
    const items = this.waiting().items.filter((item) => item.botId === botId && item.text === text);
    if (items.some((item) => item.messageId === null)) return true;
    // A repeat is a no-op only while no open question has that text: a text key is never for a card (and `ignoreWaiting`
    // would set that card aside by its id).
    return !items.length && readSettingsList(readSettings(Layout.settings(this.options.dataDir)).ignoredWaiting).includes(`${botId}-${text}`);
  }
}
