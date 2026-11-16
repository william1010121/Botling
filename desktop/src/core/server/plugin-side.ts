// M7-S66: `CorePluginSide` cut out of `Core` (core/server.ts). The plugins' side of the core: how plugins see a bot, the events plugins hear, who writes into the plugin folder, a reply's fan-out, and the calls Botling 3's server makes on the core. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line
// forwarders to `host` first, then the members as they were in `Core`, byte for byte (a member that `Core` or another collaborator calls lost its `private`).
import type { Core } from "../server";
import { join, sep } from "node:path";
import { studioWorld } from "../studio-world";
import type { StudioWorld } from "../plugins/studio-seam";
import { ContractError, type BotView, type Event, type ResultOf } from "../../contract";
import { Bot, type GuestAnswer, type PresetTurnIds, type Status as TurnStatus } from "../bot";
import { newId, toSwiftDate, type ChatRecord } from "../store/records";
import { status } from "../../contract/bot-status";
import type { BotInfo } from "../plugins";

export class CorePluginSide {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private get bots() { return this.host.bots; }
  private checkBot(...a: Parameters<Core["checkBot"]>) { return this.host.checkBot(...a); }
  private get components() { return this.host.components; }
  private componentsTick(...a: Parameters<Core["componentsTick"]>) { return this.host.componentsTick(...a); }
  private get conversations() { return this.host.conversations; }
  private deliverInboxes(...a: Parameters<Core["deliverInboxes"]>) { return this.host.deliverInboxes(...a); }
  private isSubBot(...a: Parameters<Core["isSubBot"]>) { return this.host.isSubBot(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get mainBotId() { return this.host.mainBotId; }
  private get maintainer() { return this.host.maintainer; }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get order() { return this.host.order; }
  private outId(...a: Parameters<Core["outId"]>) { return this.host.outId(...a); }
  private get pending() { return this.host.pending; }
  private get plugins() { return this.host.plugins; }
  private get profiles() { return this.host.profiles; }
  private get removed() { return this.host.removed; }
  private get runMainBot() { return this.host.runMainBot; }
  private send(...a: Parameters<Core["send"]>) { return this.host.send(...a); }
  private subBotReplied(...a: Parameters<Core["subBotReplied"]>) { return this.host.subBotReplied(...a); }

  private settlingMaintainer = false;

  /** How plugins see a bot (`Workspace.info(for:)`): "main", or its id. */
  /** The bot a plugin names ("main": the main bot), unless it was taken out of the column. */
  private studioCache: StudioWorld | null = null;
  studioNow(): StudioWorld {
    return (this.studioCache ??= studioWorld({
      // Every chat a spec can be in (`chatsWithPins`).
      chats: () => [...this.order.flatMap((id) => (this.removed.has(id) ? [] : [this.bots.get(id)!]))],
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      library: this.components.library,
      commands: this.components.commands,
      maintainer: this.maintainer,
      maintainerBot: () => this.bots.get(this.maintainerId) ?? null,
      componentBots: () => this.order.filter((id) => id !== this.maintainerId && !this.removed.has(id) && !this.isSubBot(id)).map((id) => this.bots.get(id)!),
      componentsChanged: () => this.componentsTick(),
      // Not "main" on a server that runs no main bot: its `Main (old)` keeps its own id, as in `bots.list`.
      mainId: this.runMainBot ? this.mainBotId : "",
    }));
  }

  pluginBot(botId: string): Bot | null {
    const id = botId === "main" ? (this.mainBot()?.id ?? "") : botId;
    return !id || this.removed.has(id) ? null : this.bots.get(id) ?? null;
  }

  /** The workers seen at work, so each one's end is told once (`workerDone`). */
  private readonly workersAtWork = new Set<string>();

  /** What plugins listening with `events.on` hear of a core event. */
  pluginEvent(event: Event) {
    if (!("botId" in event)) return;
    const botId = this.outId(event.botId);
    if (event.type === "message.added" && event.message.role === "user") {
      this.plugins.event("messagePosted", { botId, role: "user", text: event.message.text, id: event.message.id });
    } else if (event.type === "turn.started") {
      this.plugins.event("turnStarted", { botId, turnId: event.turnId });
    } else if (event.type === "turn.finished") {
      if (event.status === "done" && event.text) this.plugins.event("messagePosted", { botId, role: "bot", text: event.text, id: event.messageId });
      this.plugins.event("turnFinished", { botId, ok: event.status === "done", reply: event.text });
    } else if (event.type === "subagent.updated") {
      // Keyed by the worker and its run: the copy for an agent's owner, and views sent again, are not new ends.
      const key = `${event.subagent.id}/${event.subagent.execution?.run ?? 0}`;
      if (event.subagent.status === "running") {
        if (this.workersAtWork.size < 2_000) this.workersAtWork.add(key);
      } else if (this.workersAtWork.delete(key)) {
        this.plugins.event("workerDone", { botId, workerId: event.subagent.id, status: event.subagent.status, report: event.subagent.result ?? "" });
      }
    }
  }

  activePluginWriter(): string | null {
    if (this.settlingMaintainer) return this.maintainerId;
    const maintainer = this.bots.get(this.maintainerId);
    if (maintainer && (maintainer.view().working || maintainer.views.subagentsAtWork)) return this.maintainerId;
    const pluginsRoot = join(this.options.dataDir, "plugins");
    for (const bot of this.bots.values()) {
      if (bot.profile.role === "main") continue;
      const folder = bot.profile.folder;
      if (folder !== pluginsRoot && !pluginsRoot.startsWith(folder + sep) && !folder.startsWith(pluginsRoot + sep)) continue;
      if (bot.view().working || bot.views.subagentsAtWork) return bot.id;
    }
    return null;
  }

  botInfo(bot: Bot): BotInfo {
    return { id: this.outId(bot.id), name: bot.profile.name, role: bot.profile.role, awake: bot.awake };
  }

  /** A reply showed: plugins listening hear it; Maintainer's settles the component changes bots asked for. */
  replied(bot: Bot, record: ChatRecord) {
    if (record.text) this.plugins.replied(this.botInfo(bot), record.text);
    if (bot.profile.parent) this.subBotReplied(bot);
    // A line of its reply that starts with @ and another bot's name calls that bot in (`receiveBotMention`).
    this.conversations.receiveBotMention(record, bot);
    // What the main bot wrote into an inbox goes to that bot now (1.x: after every main-bot reply).
    if (bot.profile.role === "main") this.deliverInboxes();
    if (bot.id === this.maintainerId) {
      this.settlingMaintainer = true;
      try { this.maintainer.settle(record); } finally { this.settlingMaintainer = false; }
      this.plugins.event("libraryChanged", {});
      // After the reply's own tags are acted on: a change from a spec panel that did not land is said there.
      setImmediate(() => setImmediate(() => { this.plugins.event("maintainerReplied", { role: record.role, text: record.text.slice(0, 2_000), running: bot.views.subagentsAtWork }); this.componentsTick(); }));
      this.componentsTick();
    }
  }

  /**
   * Botling 3's server: `chat.send` whose intent the server already committed, with the ids it recorded (the user's
   * line, the turn, the reply's line). Everything else is 2.x's `chat.send`.
   */
  serverSend(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy" }, ids: PresetTurnIds, uploads: Array<{ path: string; name: string }> = []): Promise<ResultOf<"chat.send">> {
    return this.send(botId, text, { ...options, ids }, uploads);
  }

  /**
   * Botling 3's server: the user's line of a `chat.send` it is committing (or committed before a crash), in the bot's
   * chat now (`Bot.presetUserLine`); its turn's `serverSend` later finds it by id. `time`: the line's ISO time in the log.
   */
  serverUserLine(botId: string, line: { id: string; text: string; time: string; replyTo?: string; to?: "both" | "claude" | "codex" | "agy" }): boolean {
    const ms = Date.parse(line.time);
    return this.bot(botId).group.presetUserLine({
      id: line.id, text: line.text, date: toSwiftDate(Number.isFinite(ms) ? ms : Date.now()),
      ...(line.replyTo ? { replyTo: line.replyTo } : {}), ...(line.to ? { to: line.to } : {}),
    });
  }

  /** Botling 3's server: a turn it recorded before a restart (a routine's run, an answer's message), started now. */
  serverTurn(botId: string, spec: Parameters<Bot["group"]["startPresetTurn"]>[0]): { turnId: string; done: Promise<TurnStatus> } {
    return this.bot(botId).group.startPresetTurn(spec);
  }

  /**
   * Botling 3's server (M5-02b): the guest's turn of a call-in from a bot on another server, run in the guest's own
   * session (`Bot.groupTurn`, as a 2.x call-in is) and kept in the guest's own chat afterwards (`Bot.keepCallIn`), as
   * 2.x does. `prompt` and `note` are built and cleaned by the caller (they carry peer text). `signal` ends the wait and
   * the turn (the host gave up, D51); the answer is then `failed` with why "cancelled".
   */
  async serverCallIn(guestId: string, prompt: string, call: {
    host: { botId: string; name: string }; asked: string; by: "user" | "bot"; note: string;
    busyWaitMs: number; answerMs: number; onBegin: () => void; signal?: AbortSignal;
  }): Promise<GuestAnswer> {
    const bot = this.bots.get(guestId);
    if (!bot) return { kind: "failed", why: "It is not running." };
    const askedAt = toSwiftDate();
    const answer = await bot.groupTurn(prompt, call.busyWaitMs, call.answerMs, {
      callIn: call.host.botId, asked: call.asked, ...(call.by === "user" ? { by: "user" as const } : {}), onBegin: call.onBegin, ...(call.signal ? { signal: call.signal } : {}),
    });
    if (answer.kind === "reply") {
      const line: ChatRecord = { id: newId(), role: "bot", text: answer.text, date: toSwiftDate(), steps: answer.steps, engine: answer.engine };
      bot.guests.keepCallIn(call.note, askedAt, line);
    }
    return answer;
  }

  /** Botling 3's server: whether `botId` is one of the core's bots. */
  hasBot(botId: string): boolean {
    return this.profiles.some((profile) => profile.id === botId);
  }

  /** Botling 3's server: a bot's current view (its summary row in the server's srv: table), or null. */
  botView(bot: Bot): BotView {
    const view = bot.view();
    return bot.id === this.maintainerId ? { ...view, maintainer: true } : view;
  }

  serverBotView(botId: string): BotView | null {
    const bot = this.bots.get(botId);
    return bot ? this.botView(bot) : null;
  }

  /** Botling 3's server: the bots the core has now. */
  botIds(): string[] {
    return this.profiles.map((profile) => profile.id);
  }

  /** Botling 3's server (M6-06): re-opens plugin secrets once a window attaches and syncs the host. */
  reloadPluginSecrets(): Promise<void> {
    return this.plugins.reloadSecrets();
  }

  /** Botling 3's server: files waiting in a bot's input box (they go with the next message, even an empty one). */
  pendingFiles(botId: string): number {
    return this.pending.list(botId).length;
  }

  /** Botling 3's server: throws what `bots.remove` would refuse with (`removeBot`), before its intent is stored. */
  checkRemoveBot(id: string): void {
    this.checkBot(id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ContractError("not_found", "No such bot.");
    if (profile.role === "main" || id === this.mainBotId || id === this.maintainerId) throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
  }
}
