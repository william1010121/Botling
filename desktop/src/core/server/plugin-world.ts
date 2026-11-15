// M7-S68: `CorePluginWorld` cut out of `Core` (core/server.ts). The argument of `new Plugins(...)` that was 157 lines of the constructor: the
// plugin host's paths, and the `world` the plugins see (the bots, the chat, the cards, the routines, the app, the studio seam), every callback
// reading the core when it is asked. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line
// forwarders to `host` first, then the argument as it was in the constructor, its callbacks unchanged (`this` is this collaborator, whose
// bridge forwards each name to `Core`). Not named `options()`: the bridge already has `options` (the `CoreOptions`).
import type { Core } from "../server";
import { PROTOCOL_VERSION } from "../../contract";
import { notePath } from "../bot-note";
import { devWorkRoot, installAndQuit } from "../self-update";
import { readSettings, settingsView } from "../settings";
import { Layout } from "../store/workspace";
import { usageView } from "../usage";
import type { Plugins } from "../plugins";

export class CorePluginWorld {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private activePluginWriter(...a: Parameters<Core["activePluginWriter"]>) { return this.host.activePluginWriter(...a); }
  private botInfo(...a: Parameters<Core["botInfo"]>) { return this.host.botInfo(...a); }
  private get bots() { return this.host.bots; }
  private cancelRestart(...a: Parameters<Core["cancelRestart"]>) { return this.host.cancelRestart(...a); }
  private get components() { return this.host.components; }
  private componentsTick(...a: Parameters<Core["componentsTick"]>) { return this.host.componentsTick(...a); }
  private createPluginBot(...a: Parameters<Core["createPluginBot"]>) { return this.host.createPluginBot(...a); }
  private developerProject(...a: Parameters<Core["developerProject"]>) { return this.host.developerProject(...a); }
  private get epoch() { return this.host.epoch; }
  private event(...a: Parameters<Core["event"]>) { return this.host.event(...a); }
  private followClaudeParts(...a: Parameters<Core["followClaudeParts"]>) { return this.host.followClaudeParts(...a); }
  private isSubBot(...a: Parameters<Core["isSubBot"]>) { return this.host.isSubBot(...a); }
  private get lastPlugins() { return this.host.lastPlugins; }
  private set lastPlugins(value: Core["lastPlugins"]) { this.host.lastPlugins = value; }
  private get ledger() { return this.host.ledger; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get maintainer() { return this.host.maintainer; }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get order() { return this.host.order; }
  private outId(...a: Parameters<Core["outId"]>) { return this.host.outId(...a); }
  private pluginBot(...a: Parameters<Core["pluginBot"]>) { return this.host.pluginBot(...a); }
  private get plugins() { return this.host.plugins; }
  private prepareRestart(...a: Parameters<Core["prepareRestart"]>) { return this.host.prepareRestart(...a); }
  private get profiles() { return this.host.profiles; }
  private get removed() { return this.host.removed; }
  private get seq() { return this.host.seq; }
  private set seq(value: Core["seq"]) { this.host.seq = value; }
  private studioNow(...a: Parameters<Core["studioNow"]>) { return this.host.studioNow(...a); }
  private get usage() { return this.host.usage; }
  private watchWorkspace(...a: Parameters<Core["watchWorkspace"]>) { return this.host.watchWorkspace(...a); }
  private workspaceSource(...a: Parameters<Core["workspaceSource"]>) { return this.host.workspaceSource(...a); }

  /** What `new Plugins(...)` is given: read at the one point of the constructor where `Core` made it before this card. */
  pluginOptions(): ConstructorParameters<typeof Plugins>[0] {
    const options = this.options;
    // The plugins (their host starts later, in start()); the world they see is read when they ask.
    const host = options.plugins ?? null;
    const self = this;
    return {
      dataDir: options.dataDir,
      node: host?.node ?? null,
      hostScript: host?.hostScript ?? "",
      builtIns: host?.builtIns ?? null,
      sealer: host?.sealer ?? null,
      boundSecrets: host?.boundSecrets,
      timing: host?.timing,
      onPid: (pid, alive) => (alive ? this.ledger.record(pid) : this.ledger.forget(pid)),
      ...(options.mayRunServerPart ? { mayRunServerPart: options.mayRunServerPart } : {}),
      ...(options.separateHosts !== undefined ? { separateHosts: options.separateHosts } : {}),
      ...(options.pluginGrant ? { pluginGrant: options.pluginGrant } : {}),
      ...(options.pluginAsks ? { pluginAsks: options.pluginAsks } : {}),
      world: {
        bots: () => this.order.filter((id) => !this.isSubBot(id)).map((id) => this.botInfo(this.bots.get(id)!)),
        send: (botId, text, via) => {
          const bot = this.pluginBot(botId);
          if (!bot) throw new Error("No such bot.");
          return { messageId: bot.send(text, via ? { via } : {}).messageId };
        },
        interrupt: async (botId) => {
          const bot = this.pluginBot(botId);
          if (!bot) return null;
          // Every turn under way, as the stop button sends them (with two heads, both may work).
          const stopped = await Promise.all(bot.snapshot().runs.map((run) => bot.stop(run.turnId)));
          return stopped.some((outcome) => outcome.stopped);
        },
        notice: (text, actions) => {
          this.mainBot()?.appNotice(text, actions?.map((action) => ({ label: action.label })), actions ? (index) => actions[index]?.run() : undefined);
        },
        ask: (question) => new Promise((resolve) => {
          const main = this.mainBot();
          if (!main) { resolve({ index: Math.max(0, question.choices.length - 1) }); return; }
          // The last choice is Cancel: null, as the plugin sees it (Plugins' ui.quickPick / ui.input).
          const id: string = main.appNotice(question.text, question.choices, (index) => resolve({ index }), question.typed ? {
            onAnswer: (words) => {
              if (!words) return false;
              main.settleAppQuestion(id, { answer: words });
              resolve({ text: words });
              return true;
            },
          } : {});
        }),
        openPanel: (plugin, panel, title) => this.event({ type: "plugins.open", plugin, panel, title }),
        openTab: (plugin, view, botId) => this.event({ type: "plugins.openTab", plugin, view, botId }),
        // Straight to the app page, not through `event()`: no plugin, workspace or phone listener has anything to do with it.
        frameEvent: (plugin, name, botId, data) => this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event: { type: "plugins.emit", plugin, name, ...(botId ? { forBot: botId === "main" ? (this.mainBot()?.id ?? botId) : botId } : {}), data } }),
        botFolder: (botId) => this.pluginBot(botId)?.profile.folder ?? null,
        botNote: (botId) => {
          const bot = this.pluginBot(botId);
          return bot ? notePath(bot.profile) : null;
        },
        imageUrl: (path, type) => this.components.images.register(path, type),
        appSettings: () => {
          const settings = settingsView(readSettings(Layout.settings(this.options.dataDir)));
          return { language: settings.effectiveLanguage, botLook: settings.botLook, workerLimit: settings.claudeWorkerLimit };
        },
        shortcutOverrides: () => settingsView(readSettings(Layout.settings(this.options.dataDir))).shortcuts,
        createBot: (plugin, title, name, job, avatar, more) => this.createPluginBot(plugin, title, { name, job, ...(avatar ? { avatar } : {}), ...more }),
        commandApproval: (botId, command) => this.pluginBot(botId)?.commandApproval(command) ?? null,
        commandRun: (botId, key, command, run) => this.pluginBot(botId)?.pluginCommand(key, command, run) ?? null,
        component: (botId, name, data, command) => this.pluginBot(botId)?.libraryEntry(name, data, command) ?? null,
        imageUrls: (botId, data) => this.pluginBot(botId)?.imageUrls(data) ?? null,
        cardAsk: (botId, card, command, component) => this.pluginBot(botId)?.cardAskFor(card, command, component) ?? null,
        cardApprove: (botId, command, component, folder, detail) => this.pluginBot(botId)?.cardApproveFor(command, component, folder, detail) ?? false,
        noteCards: {
          components: (botId) => this.pluginBot(botId)?.noteComponents() ?? null,
          states: (botId, cards) => this.pluginBot(botId)?.noteCardStates(cards) ?? null,
          run: (botId, key, command, force) => this.pluginBot(botId)?.noteCardRun(key, command, force) ?? null,
        },
        cards: {
          library: (botId) => this.pluginBot(botId)?.cardLibrary() ?? null,
          shown: (botId) => this.pluginBot(botId)?.cardsShown() ?? null,
          states: (botId, cards) => this.pluginBot(botId)?.cardStates(cards) ?? null,
          run: (botId, card, command, force) => this.pluginBot(botId)?.cardRun(card, command, force) ?? null,
          ask: (botId, card, command, component) => this.pluginBot(botId)?.cardAskFor(card, command, component) ?? null,
          setNotes: (botId, notes) => { const bot = this.pluginBot(botId); if (!bot) return false; bot.setCardNotes(notes); return true; },
          legacyPins: (botId) => this.pluginBot(botId)?.legacyPins() ?? null,
        },
        dataChanged: (botId, plugin, data) => { if (this.bots.has(botId)) this.event({ type: "chat.pluginData", botId, plugin, data }); },
        approveCommand: (botId, command) => this.pluginBot(botId)?.approveCommand(command) ?? false,
        chat: (botId, limit) => {
          const bot = this.pluginBot(botId);
          if (!bot) return null;
          const chat = bot.pluginChat(limit);
          return { ...chat, botId: this.outId(chat.botId) };
        },
        botId: (botId) => this.pluginBot(botId)?.id ?? null,
        decorated: (botId) => { if (this.bots.has(botId)) this.event({ type: "chat.decorations", botId, decorations: this.plugins.decorations(botId) }); },
        engineCli: (engine) => options.engineCli?.(engine) ?? null,
        addRoutine: (botId, cron, task) => {
          const bot = botId === "main" ? this.mainBot() : this.bots.get(botId);
          if (!bot) return "no-bot";
          return bot.addRoutine(cron, task) ? "added" : "bad-schedule";
        },
        routinesList: (botId) => this.pluginBot(botId)?.routinesView() ?? null,
        routinesChange: (botId, operation, id) => {
          const bot = this.pluginBot(botId);
          // Not `ContractError`'s wording to a plugin: the store's own message, as the app's panel showed it.
          return bot ? bot.changeRoutine({ operation, id }) : null;
        },
        changed: (view) => {
          this.followClaudeParts();
          // A built-in plugin turned on or off brings or takes away its cards (botling.cards).
          if (this.components.library.rescan()) for (const bot of this.bots.values()) bot.componentsChanged();
          this.componentsTick();
          const text = JSON.stringify(view);
          if (text === this.lastPlugins) return;
          this.lastPlugins = text;
          this.event({ type: "plugins.updated", plugins: view });
        },
        pluginWritten: (name) => { const botId = this.activePluginWriter(); if (botId) options.pluginWritten?.(name, botId); },
        broken: (plugin, problem) => this.maintainer.broken(plugin, problem),
        log: (line) => this.log(line),
        app: {
          state: () => ({
            pid: options.app?.pid ?? null, dataDir: options.dataDir, appDataDir: options.app?.dataDir ?? null, bundle: options.app?.bundle ?? null,
            server: options.app?.server ?? null,
            developerMode: settingsView(readSettings(Layout.settings(options.dataDir))).developerMode,
            developer: (() => { const bot = this.developerProject(); return bot ? { id: bot.id, name: bot.profile.name, folder: bot.profile.folder } : null; })(),
          }),
          // Running work resumes on the new build (restart-continuation.ts); a failed checkpoint stops the install.
          installAndRestart: (command, log) => installAndQuit(command, log, {
            prepareRestart: () => this.prepareRestart(), cancelRestart: () => this.cancelRestart(), app: options.app, log: (line) => this.log(line),
          }),
          captureWindow: async () => {
            if (!options.app) return null;
            try { const answer = await options.app.request("screenshot"); return answer.ok && answer.file ? answer.file : null; } catch { return null; }
          },
          card: (text, choices, source) => new Promise((resolve) => {
            const main = this.mainBot();
            if (!main) { resolve(null); return; }
            main.appNotice(text, choices, choices ? (index) => resolve(index) : undefined, source ? { sourceID: source } : {});
            if (!choices) resolve(null);
          }),
          tell: (botId, kind, text, files) => {
            const bot = this.pluginBot(botId);
            if (!bot) return false;
            if (kind === "note") bot.queueNote(text); else bot.relay(text, files.length ? { files } : {});
            return true;
          },
        },
        // The component studio's seam (plugins/studio-seam.ts); built when first asked, once Maintainer and the library exist.
        get studio() { return self.studioNow(); },
        sessionMoved: (botId, reason) => this.bots.get(botId)?.folderMoved(reason),
        sessionBots: () => this.profiles.filter((profile) => profile.role !== "main" && profile.id !== this.maintainerId && !this.removed.has(profile.id)).map((profile) => ({
          id: profile.id, name: profile.name, role: profile.role as "manager" | "bot", parent: profile.parent ?? null, folder: profile.folder,
          memoryPath: profile.memoryPath, storeDir: profile.storeDir, problem: profile.problem,
          workRoot: this.developerProject()?.id === profile.id ? devWorkRoot() : null,
        })),
        usageView: async () => { await this.usage.refresh(); return usageView(this.usage.view()); },
        workspace: this.workspaceSource(),
        workspaceWatch: (on) => this.watchWorkspace(on),
        ...(options.content ? { content: options.content } : {}),
        ...(options.lineContent ? { lineContent: options.lineContent } : {}),
      },
    };
  }
}
