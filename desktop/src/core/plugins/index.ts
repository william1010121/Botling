// Plugins in the core (Workspace.swift's plugin host part, `startPluginHost`, `connectPlugins`): the
// library (registry.ts), sealed secrets (secrets.ts) and the plugin host process (host-client.ts),
// and what the host may ask of the core. The host is untrusted: it is told only what a plugin needs
// (bots' names and roles, its own settings and secrets) and may ask only for the few things below,
// each checked here (a plugin it names must be loaded; creating bots, stopping them and talking to
// them as the user need the "bots" permission — a consistency check, not a sandbox: the host is one
// process). Everything else is refused. A plugin's message to a bot shows as sent by it unless it
// asked to send as the user (plugin-platform.md §5, N1). Any plugin may read the workspace (`workspace.*`,
// what the whiteboard shows: bots, memory, tasks, results, what waits on you); none may answer for you.
// Reading a chat (`chat.messages`) needs the "messages" permission; what a plugin draws among a chat's
// messages (`chat.decorate`, chat extension v2) is kept here per chat until it unloads, and its web part draws it.
//
// Web parts: since Phase 4a the chat page has an origin of its own (botling-chat://chat, no bridge,
// nothing shared with the app page but postMessage), so plugins' web parts run in it again as in 1.x:
// composer, markdown and component hooks, commands and `host.call`; their stylesheets are served by the
// chat origin (only files the manifest names, and fonts beside them). A plugin's panels still run its
// web part in a sandboxed frame (botling-card://page/…, opaque origin, no network). Since step M11 ccb-latex
// is a built-in plugin (registry.ts `builtIns`) and reaches the chat page by the same path.
import { join } from "node:path";
import { z } from "zod";
import { ContractError, type ApprovalAskView, type PluginsView, type ResultOf, type WebPluginSpecView } from "../../contract";
import { ContractId } from "../../contract/editor-card";
import { bindingsFor, findConflict, legacyKey, pluginBindings, type Overrides } from "../../contract/shortcuts";
import { setPluginTags, type PluginTag } from "../reply";
import { commandSurfaces } from "./commands";
import { viewSurfaces } from "./views";
import { CORE_PROMPT_SECTIONS } from "../prompts";
import { HANDED_TAGS, ofKind, type Contribution } from "./contributions";
import { PluginHostClient, type HostCommand, type HostTiming, DEFAULT_TIMING } from "./host-client";
import { title, type JSONValue } from "./manifest";
import { PluginRegistry, type InstalledPlugin } from "./registry";
import { SealedSecretStore, type Sealer } from "./secrets";
import { WORKSPACE_EVENT, type WorkspaceChange, type WorkspaceSource } from "../workspace";
import { PendingTags } from "./pending-tags";
import { SessionFolders, cleanFolder, type SessionFolder } from "./session-folders";
import { AppBriefingParams, AppCardParams, AppInstallParams, AppTellParams, BriefingBook, installCommandOK, type AppWorld } from "./app-seam";

export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean }

/** A question of the app's in the main bot's chat (`ui.quickPick`, `ui.input`). */
export interface AppQuestion { text: string; choices: { label: string; detail?: string }[]; typed: boolean }
/** Its answer: a pick, or the user's own words (`typed` only). Ignoring it (no callbacks, by design) answers nothing. */
export type AppAnswer = { index: number } | { text: string };
export interface PluginStatusItem { id: string; text: string; icon: string | null; tooltip: string | null; command: string | null }
/** A chat as a plugin may read it (`chat.messages`): its newest lines as kept, its task cards, its name and unread count. */
export interface PluginChat { botId: string; name: string; unread: number; messages: unknown[]; tasks: { id: string; name: string; state: string; messageIDs: string[] }[] }
/** What a plugin's web part draws among a chat's messages (`chat.decorate`, chat extension v2). */
export interface MessageDecoration { plugin: string; key: string; fold?: string[]; after?: string; tasks?: string[]; data?: JSONValue }
/** How Botling starts an engine's CLI here (`engines.cli`), for a plugin's one-shot model call. */
export interface EngineCli { file: string; args: string[]; env: Record<string, string> }

/** A bot as a plugin that places sessions sees it: where its project is, where its chat files are, and where development work for it goes. */
export interface SessionBot {
  id: string; name: string; role: "manager" | "bot"; parent: string | null;
  /** Its working folder (absolute) and its memory.md, relative to it. */
  folder: string; memoryPath: string;
  /** Where its chat files are (a plugin keeps its per-bot files beside them). */
  storeDir: string;
  /** Why it cannot run (its folder is gone), or null. */
  problem: string | null;
  /** Botling's own source's project: where development work goes (the work drive), else null. */
  workRoot: string | null;
}

/** What the core lends the plugins. */
export interface PluginWorld {
  bots(): BotInfo[];
  /** A message to a bot (`bots.send`, `bots.wake`): shown as sent `via` that plugin (its title), or as the user's own (null). Throws why not. */
  send(botId: string, text: string, via: string | null): { messageId: string };
  /** Stops every turn a bot has under way, as its stop button does (null: no such bot). */
  interrupt(botId: string): Promise<boolean | null>;
  /** A line in the main bot's chat; with `actions`, buttons under it. */
  notice(text: string, actions?: { label: string; run: () => void }[]): void;
  /** Asks the user in the main bot's chat. */
  ask(question: AppQuestion): Promise<AppAnswer>;
  /** Opens a plugin's panel on the app page. */
  openPanel(plugin: string, panel: string, title: string): void;
  /** A plugin's push to its frames (`ui.emit`), on its way to the app page; never part of a snapshot, and no other client hears it. */
  frameEvent?(plugin: string, name: string, botId: string | undefined, data: unknown): void;
  /** A bot's working folder as the core keeps it, the main bot's too (null: no such bot). */
  botFolder?(botId: string): string | null;
  /** Botling's own settings plugins may read (`settings.app`). */
  appSettings(): Record<string, JSONValue>;
  /** The keys the user chose (settings.json `shortcutBindings`: Botling's shortcuts and plugin commands). */
  shortcutOverrides(): Overrides;
  /** A bot's folder and whether `command` may run there (approved-commands.json); null: no such bot. */
  commandApproval(botId: string, command: string): { folder: string; approved: boolean } | null;
  /** The user allowed `command` in the bot's folder (only ever from the app page's ApprovalSheet); false: no such bot. */
  approveCommand(botId: string, command: string): boolean;
  /**
   * A plugin's run `key` of `command` in the bot's folder (`approvals.state`, `approvals.run`), by the core's own command runner (a time limit,
   * an output cap, the process ledger); `run: false` only reads it. Runs only what the user allowed. null: no such bot.
   */
  commandRun(botId: string, key: string, command: string, run: false | { minIntervalMs: number }):
    { folder: string; approved: boolean; status: "approve" | "idle" | "running" | "done" | "failed"; data: string | null; error: string | null; ranAt: number | null; started: boolean } | null;
  /** The bot's component library, read only (`workspace.component`); null: no such bot. */
  component(botId: string, name: string, data: string | undefined, command: string | undefined): { exists: boolean; command: string | null } | null;
  /** The card-page URLs of the pictures a component's data names for that bot (what a tile needs); null: no such bot. */
  imageUrls(botId: string, data: string): Record<string, string> | null;
  /** `bots.create` for a plugin (`makeBot` with its name): the bot's info and whether it is new; throws why not. */
  createBot(plugin: string, title: string, name: string, job: string, avatar: string | undefined): BotInfo & { created: boolean };
  /** A chat's newest `limit` lines (`chat.messages`; null: no such bot). Absent: a world without chats (tests, spec adapters). */
  chat?(botId: string, limit: number): PluginChat | null;
  /** The bot a plugin names ("main" too) as the core knows it (null: none). */
  botId?(botId: string): string | null;
  /** A chat's message decorations changed. */
  decorated?(botId: string): void;
  /** What the `usage.view` command answers (a fresh quota read first), for `usage.view`; absent: a world without usage (tests, spec adapters). */
  usageView?(): Promise<unknown>;
  /** An engine's CLI as Botling starts it (null: not here). */
  engineCli?(engine: "claude" | "codex"): EngineCli | null;
  /** A bot's session folder changed (a plugin's `sessions.folder`, or the plugin went): an awake one starts again before its next message. */
  sessionMoved?(botId: string, reason: { told: string; shown: string }): void;
  /** The bots whose sessions a plugin may place (every one but the main bot and Maintainer), for `sessions.bots`. Absent: none. */
  sessionBots?(): SessionBot[];
  /** The app around the core for botling.dev (`app.*`, built-in plugins only). Absent: a world without an app (tests, spec adapters). */
  app?: AppWorld;
  /** A routines.cron line (`routines.add`); false: no such bot, or not a valid schedule. */
  addRoutine(botId: string, cron: string, task: string): "added" | "no-bot" | "bad-schedule";
  /** A bot's routines as the app lists them (`routines.list`; null: no such bot). Absent: a world without routines (tests, spec adapters). */
  routinesList?(botId: string): ResultOf<"routines.list"> | null;
  /** Pauses, resumes or cancels one of a bot's routines (`routines.change`); throws why not. Returns the list after. */
  routinesChange?(botId: string, operation: "pause" | "resume" | "cancel", id: string): ResultOf<"routines.change"> | null;
  /** The library changed: the app shows it. */
  changed(view: PluginsView): void;
  /** A plugin broke: Maintainer is asked to fix it. */
  broken(plugin: string, problem: string): void;
  log(line: string): void;
  /** What plugins may read of the workspace (`workspace.*`, read only but for setting aside what waits on you). */
  workspace: WorkspaceSource;
  /**
   * Some plugin listens for workspace changes (true) or none does any more. Said as soon as the host says so,
   * before anything the host sends after it is answered: what is there then is what a listener may have read.
   */
  workspaceWatch(on: boolean): void;
}

export interface PluginsOptions {
  dataDir: string;
  world: PluginWorld;
  /** How to run Node for the plugin host (null: program parts cannot run). */
  node: HostCommand | null;
  /** The bundled plugin host (out/host/host.mjs). */
  hostScript: string;
  /** The plugins shipped with the app (out/builtin-plugins, or the app's Resources/builtin-plugins). */
  builtIns?: string | null;
  sealer: Sealer | null;
  timing?: HostTiming;
  /** The plugin host's pid, for the process ledger. */
  onPid?: (pid: number, alive: boolean) => void;
}

const str = (max: number) => z.string().max(max);
const NotifyParams = z.object({ plugin: str(214), text: str(20_000) });
const NotifyMore = z.object({
  level: z.enum(["info", "warn", "error"]).optional(),
  actions: z.array(z.object({ title: str(200).min(1), command: str(200).min(1) })).max(5).optional(),
});
const SendParams = z.object({ plugin: str(214), bot: str(64), text: z.string().min(1).max(100_000), as: z.enum(["plugin", "user"]).default("plugin") });
const BotParams = z.object({ plugin: str(214), bot: str(64) });
const WakeParams = BotParams.extend({ prompt: z.string().min(1).max(100_000).optional() });
const PickParams = z.object({
  plugin: str(214), title: str(400).optional(),
  items: z.array(z.object({ id: str(200).min(1), label: str(400).min(1), detail: str(1_000).optional() })).min(1).max(20),
});
const InputParams = z.object({ plugin: str(214), title: str(400).min(1), placeholder: str(400).optional(), secret: z.boolean().optional() });
const EmitParams = z.object({ plugin: str(214), name: str(100).min(1), botId: str(128).optional(), data: z.unknown() });
/** The most a push to a plugin's frames (`ui.emit`) may carry (JSON text). */
const EMIT_MAX = 1_000_000;
const ViewParams = z.object({ plugin: str(214), id: str(100).min(1), args: z.unknown().optional() });
const SettingParams = z.object({ plugin: str(214), key: str(200), value: z.union([z.boolean(), z.number(), z.string().max(100_000), z.null()]) });
const SecretKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const SecretGetParams = z.object({ plugin: str(214), key: SecretKey });
const SecretSetParams = SecretGetParams.extend({ value: z.string().max(20_000).nullable() });
const KeyParams = z.object({ plugin: str(214), command: str(200), key: str(40).nullable() });
const StatusParams = z.object({
  plugin: str(214), id: str(100).min(1),
  item: z.object({ text: str(200), icon: str(100).optional(), tooltip: str(1_000).optional(), command: str(200).optional() }).nullable(),
});
const EVENT_NAMES = ["messagePosted", "turnStarted", "turnFinished", "workerDone", "chatRead", "developerChanged", "botRemoved"] as const;
export type PluginEventName = (typeof EVENT_NAMES)[number];
const ApprovalParams = z.object({ plugin: str(214), bot: str(64), command: z.string().min(1).max(20_000) });
const RunKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const StateParams = ApprovalParams.extend({ key: RunKey });
const RunParams = StateParams.extend({ minIntervalMs: z.number().int().min(0).max(3_600_000).optional() });
const ComponentParams = BotParams.extend({ name: str(200).min(1), data: z.string().max(300_000).optional(), command: z.string().max(20_000).optional() });
const RoutineParams = z.object({ plugin: str(214), bot: str(64), cron: str(200), task: str(2_000) });
const CreateParams = z.object({ plugin: str(214) }).passthrough();
const PluginOnly = z.object({ plugin: str(214) });
const RoutinesListParams = z.object({ plugin: str(214), bot: str(64) });
const RoutinesChangeParams = RoutinesListParams.extend({ operation: z.enum(["pause", "resume", "cancel"]), id: str(2_200).min(1) });
const Limit = (most: number, fallback: number) => z.number().int().optional().transform((value) => Math.min(most, Math.max(1, value ?? fallback)));
const TasksParams = BotParams.extend({ limit: Limit(100, 100) });
const HistoryParams = BotParams.extend({ days: Limit(14, 14) });
const ResultsParams = BotParams.extend({ limit: Limit(100, 12) });
const IgnoreParams = BotParams.extend({ text: z.string().min(1).max(400) });
const FaceParams = BotParams.extend({ look: z.enum(["original", "cute"]) });
const ChatParams = BotParams.extend({ limit: z.number().int().min(1).max(2_000).default(500) });
const DecorateParams = BotParams.extend({
  decorations: z.array(z.object({
    key: str(300).min(1),
    fold: z.array(ContractId).max(2_000).optional(),
    after: ContractId.optional(),
    tasks: z.array(ContractId).max(100).optional(),
    data: z.unknown().optional(),
  })).max(200),
});
const FolderParams = BotParams.extend({
  folder: z.unknown().nullable(),
  reason: z.object({ told: str(2_000), shown: str(400) }).optional(),
});
const FoldersParams = z.object({ plugin: str(214), folders: z.record(str(64), z.unknown()) });
const EngineParams = z.object({ plugin: str(214), engine: z.enum(["claude", "codex"]) });
/** How much one plugin may draw in one chat (`chat.decorate`), as JSON. */
const DECORATION_BYTES = 1_000_000;

export class Plugins {
  readonly registry: PluginRegistry;
  readonly host: PluginHostClient;
  readonly secrets: SealedSecretStore;
  private readonly dataRoot: string;
  private started = false;
  /** Reply tags whose plugin was not loaded yet, kept until it is (pending-tags.ts). */
  private readonly held: PendingTags;
  /** The folders built-in plugins assigned to bots' sessions (`sessions.folder`), kept on disk (session-folders.ts). */
  private readonly folders: SessionFolders;
  /** The developer briefing botling.dev pushed (app-seam.ts), kept on disk. */
  private readonly briefings: BriefingBook;
  /** What each bot's session was last told about its folder (a signature of folder, extra folders and note; absent: its own). */
  private readonly foldersTold = new Map<string, string>();
  /** What each plugin shows in the status area (`ui.setStatus`), until it unloads. */
  private readonly status = new Map<string, Map<string, PluginStatusItem>>();
  /** Some plugin listens for workspace changes, as the host last said (`workspace.onChange`). */
  watchingWorkspace = false;
  /** What each plugin draws in each chat (`chat.decorate`), by the core's bot id, until it unloads. */
  private readonly decorated = new Map<string, Map<string, MessageDecoration[]>>();

  constructor(private readonly options: PluginsOptions) {
    const { dataDir, world } = options;
    this.secrets = new SealedSecretStore(join(dataDir, "plugin-secrets.json"), options.sealer);
    this.registry = new PluginRegistry(join(dataDir, "plugins"), join(dataDir, "plugins.json"), this.secrets, options.builtIns ?? null);
    this.dataRoot = join(dataDir, "plugin-data");
    this.held = new PendingTags(join(dataDir, "plugin-pending-tags.json"));
    this.folders = new SessionFolders(join(dataDir, "plugin-session-folders.json"));
    this.briefings = new BriefingBook(join(dataDir, "plugin-dev-briefing.json"));
    for (const botId of this.folders.plugins().flatMap((name) => this.folders.bots(name))) { const now = this.folderSignature(botId); if (now) this.foldersTold.set(botId, now); }
    this.host = new PluginHostClient(options.hostScript, options.node, this.dataRoot, (line) => world.log(line), options.timing ?? DEFAULT_TIMING, options.onPid);
    this.registry.onNotice = (text) => world.notice(text);
    this.registry.onBroken = (plugin, problem) => world.broken(plugin, problem);
    this.registry.onUpdated = (plugin, from) => world.notice(`Plugin "${title(plugin.manifest)}" updated: ${from} → ${plugin.manifest.version}`);
    this.registry.onChanged = () => this.sync();
    this.host.onPluginFailure = (plugin, message, fatal) => {
      // The host may have died: nobody listens until it says so again.
      this.followWorkspace();
      if (!plugin) return;
      this.status.delete(plugin);
      this.dropDecorations(plugin);
      this.registry.recordHostFailure(plugin, message, fatal);
    };
    this.host.onRegistered = () => {
      this.followWorkspace();
      this.announce();
      this.replayHeld();
    };
    this.host.onNotification = (method, params) => this.notified(method, params);
    this.host.onRequest = (method, params) => this.requested(method, params);
    setPluginTags([...this.replyTagOwners().keys()]);
  }

  /** Opens the sealed secrets, then starts the host for the plugins that are on. */
  async start() {
    await this.secrets.load();
    this.started = true;
    this.sync();
  }

  /** The library is looked at again (the core's 1.5 s clock). */
  scan() {
    this.registry.rescan();
  }

  private sync() {
    // Bots' replies lose the tags plugins declare from the start (the host may not run yet: they are dropped then).
    setPluginTags([...this.replyTagOwners().keys()]);
    if (!this.started) return;
    const app = this.options.world.appSettings();
    this.host.update(this.registry.hostSpecs(this.dataRoot).map((spec) => ({ ...spec, app })));
    for (const name of [...this.status.keys()]) if (!this.loaded(name)) this.status.delete(name);
    this.dropDecorations();
    this.foldersChanged();
    this.announce();
  }

  // ------------------------------------------------------------------------------------------
  // The folder a bot's session starts in (`sessions.folder`, plugin-extraction.md §3.2 #2)

  /** The plugins that may decide a session's folder now: shipped with the app, on, and with the "sessions" permission. */
  private folderProviders(): string[] {
    return this.folders.plugins().filter((name) => {
      const plugin = this.registry.plugin(name);
      return !!plugin && plugin.enabled && plugin.builtIn && !!plugin.manifest.ccb?.permissions?.includes("sessions");
    });
  }

  /**
   * Where this bot's session starts, from what a plugin assigned (the first provider by name that has something for it):
   * answered from memory, never by asking the host, so a turn does not wait on it. null: the bot's own folder.
   */
  sessionFolder(botId: string): (SessionFolder & { plugin: string }) | null {
    for (const name of this.folderProviders()) {
      const folder = this.folders.get(name, botId);
      if (folder) return { ...folder, plugin: name };
    }
    return null;
  }

  private folderSignature(botId: string): string | null {
    const folder = this.sessionFolder(botId);
    return folder ? JSON.stringify([folder.cwd, folder.addDirs, folder.note]) : null;
  }

  /** A bot's folder may have changed (a push, or a plugin turned off): an awake bot starts again before its next message, once. */
  private foldersChanged(botIds?: string[], reason?: { told: string; shown: string }) {
    const ids = botIds ?? [...new Set([...this.foldersTold.keys(), ...this.folders.plugins().flatMap((name) => this.folders.bots(name))])];
    for (const botId of ids) {
      const now = this.folderSignature(botId);
      if ((this.foldersTold.get(botId) ?? null) === now) continue;
      if (now === null) this.foldersTold.delete(botId); else this.foldersTold.set(botId, now);
      this.options.world.sessionMoved?.(botId, reason ?? (now === null
        ? { told: "your working folder is the project folder again", shown: "Back in the project folder." }
        : { told: "your working folder changed; see the note at your wake", shown: "Working folder changed." }));
    }
  }

  /** Message decorations of plugins no longer running (or whose web part no longer runs) go. */
  private dropDecorations(failed?: string) {
    for (const [botId, byPlugin] of this.decorated) {
      let changed = false;
      for (const name of [...byPlugin.keys()]) if (name === failed || !this.drawing(name)) { byPlugin.delete(name); changed = true; }
      if (!byPlugin.size) this.decorated.delete(botId);
      if (changed) this.options.world.decorated?.(botId);
    }
  }

  /** A plugin whose program part runs and whose web part draws in the chat page. */
  private drawing(name: string) {
    const plugin = this.loaded(name);
    return !!plugin?.manifest.ccb?.web;
  }

  /** Every plugin's message decorations in a chat, for the chat page (ChatSnapshot.decorations). */
  decorations(botId: string): MessageDecoration[] {
    return [...(this.decorated.get(botId)?.values() ?? [])].flat();
  }

  /** Botling's settings changed: plugins reading them (`settings.app`) are told. */
  appSettingsChanged() {
    this.sync();
  }

  /** Something plugins may listen for happened (`events.on`); only sent when one listens. */
  event(name: PluginEventName, data: unknown) {
    this.host.event(name, data);
  }

  private announce() {
    this.options.world.changed(this.view());
  }

  /** Whether some plugin listens for workspace changes now; the world is told when that changes. */
  private followWorkspace() {
    const on = this.host.running && this.host.events.has(WORKSPACE_EVENT);
    if (on === this.watchingWorkspace) return;
    this.watchingWorkspace = on;
    this.options.world.workspaceWatch(on);
  }

  /** The workspace changed: plugins listening hear it (`workspace.onChange`); nothing is sent while none does. */
  workspaceChanged(change: WorkspaceChange) {
    this.host.event(WORKSPACE_EVENT, change);
  }

  async shutdown() {
    await this.host.shutdown();
  }

  // ------------------------------------------------------------------------------------------
  // What the app shows and changes

  view(): PluginsView {
    const registered = new Set(this.host.commands);
    return {
      plugins: this.registry.plugins.slice(0, 200).map((plugin) => {
        const ccb = plugin.manifest.ccb;
        const parts = (["web", "host", "claude"] as const).filter((part) => ccb?.[part]);
        return {
          name: plugin.manifest.name,
          title: title(plugin.manifest).slice(0, 200),
          version: plugin.manifest.version.slice(0, 100),
          description: plugin.manifest.description?.slice(0, 2_000) ?? null,
          enabled: plugin.enabled,
          failure: plugin.failure?.slice(0, 2_000) ?? null,
          installedFrom: plugin.installedFrom?.slice(0, 2_000) ?? null,
          ...(plugin.builtIn ? { builtIn: true } : {}),
          permissions: (ccb?.permissions ?? []).slice(0, 20).map((permission) => permission.slice(0, 40)),
          parts: [...parts, ...(ccb?.contributes?.components ? ["components" as const] : [])],
          settings: this.registry.settingsView(plugin).slice(0, 100).map((setting) => ({
            ...setting, title: setting.title.slice(0, 400), type: setting.type.slice(0, 20), options: setting.options.slice(0, 50).map((option) => option.slice(0, 200)),
            value: typeof setting.value === "string" ? setting.value.slice(0, 10_000) : typeof setting.value === "object" ? null : setting.value,
          })),
          commands: (ccb?.contributes?.commands ?? []).slice(0, 100).map((command) => ({ id: command.id.slice(0, 200), title: command.title.slice(0, 200), registered: registered.has(command.id) })),
          panels: plugin.enabled && !plugin.failure && ccb?.web ? (ccb.contributes?.panels ?? []).slice(0, 20).map((panel) => ({ id: panel.id.slice(0, 100), title: panel.title.slice(0, 200) })) : [],
          ...(this.status.get(plugin.manifest.name)?.size ? { status: [...this.status.get(plugin.manifest.name)!.values()].slice(0, 20) } : {}),
        };
      }),
      broken: Object.entries(this.registry.problems).slice(0, 200).map(([folder, problems]) => ({ folder: folder.slice(0, 214), problems: problems.slice(0, 50).map((problem) => problem.slice(0, 2_000)) })),
      host: { running: this.host.running, problem: this.host.problem?.slice(0, 2_000) ?? null },
      secretsProblem: this.secrets.problem?.slice(0, 2_000) ?? null,
      ...commandSurfaces(this.contributions()),
      ...viewSurfaces(this.contributions(), (name) => !!this.registry.webPart(name)),
    };
  }

  /**
   * What enabled plugins contribute, with the keys their program parts set for their own commands
   * (`keybindings.set`) in place of their manifests'; the user's keys still win (shortcuts.ts `pluginBindings`).
   */
  private contributions(): Contribution[] {
    return this.registry.effectiveContributions();
  }

  private known(name: string) {
    const plugin = this.registry.plugin(name);
    if (!plugin) throw new ContractError("not_found", `No plugin "${name}".`);
    return plugin;
  }

  setEnabled(name: string, enabled: boolean) {
    this.known(name);
    this.registry.setEnabled(name, enabled);
    return this.view();
  }

  setSetting(name: string, key: string, value: boolean | number | string | null) {
    const setting = this.known(name).manifest.ccb?.contributes?.settings?.[key];
    if (!setting) throw new ContractError("not_found", `Plugin "${name}" has no setting "${key}".`);
    if (setting.secret) throw new ContractError("bad_request", "A secret is set with plugins.secret.");
    const fits = value === null
      || (setting.type === "boolean" && typeof value === "boolean")
      || (setting.type === "number" && typeof value === "number" && Number.isFinite(value))
      || (setting.type === "string" && typeof value === "string")
      || (setting.type === "enum" && typeof value === "string" && (setting.options ?? []).includes(value));
    if (!fits) throw new ContractError("bad_request", `That is not a ${setting.type} for "${key}".`);
    this.registry.set(name, key, value);
    return this.view();
  }

  async setSecret(name: string, key: string, value: string | null) {
    const setting = this.known(name).manifest.ccb?.contributes?.settings?.[key];
    if (!setting?.secret) throw new ContractError("not_found", `Plugin "${name}" has no secret "${key}".`);
    try {
      await this.registry.setSecret(name, key, value ? value : null);
    } catch (error) {
      throw new ContractError("conflict", (error as Error).message);
    }
    return this.view();
  }

  /**
   * A command a program part registered (`Workspace.runCommand`); a failure is said in the main bot's
   * chat too. A frame runs only its own plugin's commands; the chat page only those of plugins whose web
   * part runs there (the page is one realm, so a web part could name any of those). The app page's own
   * buttons, keys, / menu and menus (no `from`) run any; `args` are what a menu passes (its bot, its message).
   */
  async command(id: string, from?: "frame" | "chat", name?: string, args: string[] = []): Promise<unknown> {
    if (from === "frame" && !(name && id.startsWith(`${name}.`))) throw new ContractError("forbidden", `A frame of "${name ?? "?"}" may not run "${id}".`);
    if (from === "chat" && !this.registry.plugins.some((plugin) => plugin.enabled && !plugin.failure && plugin.manifest.ccb?.web && id.startsWith(`${plugin.manifest.name}.`))) {
      throw new ContractError("forbidden", `The chat page may not run "${id}" (no web part of its plugin runs there).`);
    }
    if (!this.host.commands.includes(id)) throw new ContractError("not_found", `No command "${id}".`);
    try {
      return await this.host.command(id, args);
    } catch (error) {
      this.options.world.notice(`Command "${id}" failed: ${(error as Error).message}`);
      throw new ContractError("conflict", (error as Error).message);
    }
  }

  /** Every web part for the chat page; each style becomes a URL the chat origin serves. */
  webSpecs(): WebPluginSpecView[] {
    return this.registry.webSpecs().slice(0, 100).map((spec) => ({
      name: spec.name, version: spec.version.slice(0, 100), source: spec.source.slice(0, 5_000_000),
      styles: spec.styles.slice(0, 20).map((style) => `botling-chat://chat/plugin-files/${spec.name}/${style.split("/").map(encodeURIComponent).join("/")}`),
      settings: spec.settings,
      commands: spec.commands.slice(0, 100).map((command) => ({ id: command.id.slice(0, 200), title: command.title.slice(0, 200), ...(command.key ? { key: command.key.slice(0, 40) } : {}) })),
    }));
  }

  /** The chat page loaded a web part. */
  webLoaded(name: string) {
    this.known(name);
    this.registry.markLoaded(name);
  }

  /** A web part threw in the chat page: off until its files change (its last good version runs meanwhile). */
  webFailed(name: string, message: string) {
    this.known(name);
    this.registry.markFailed(name, message.slice(0, 2_000) || "Its web part failed.");
    this.dropDecorations(name);
  }

  /** A web part's `ccb.notify`. */
  webNotice(name: string, text: string) {
    const plugin = this.known(name);
    this.options.world.notice(`${title(plugin.manifest)}: ${text.slice(0, 4_000)}`);
  }

  webFile(name: string, path: string) {
    const file = this.registry.webFile(name, path);
    if (!file) throw new ContractError("not_found", "No such file.");
    return file;
  }

  /** A panel's (or another view's: a main-area tab) web part and settings, for its sandboxed frame. */
  panel(name: string, id: string) {
    const entry = this.registry.panels().find((candidate) => candidate.plugin.manifest.name === name && candidate.panel.id === id)
      ?? ofKind(this.registry.contributions(), "view").find((view) => view.plugin === name && view.id === id);
    const part = entry ? this.registry.webPart(name) : null;
    if (!entry || !part) throw new ContractError("not_found", `No panel "${id}" of plugin "${name}".`);
    const settings: Record<string, boolean | number | string | null> = {};
    for (const [key, value] of Object.entries(part.settings)) settings[key] = value === null || typeof value !== "object" ? value : null;
    return { title: ("panel" in entry ? entry.panel.title : entry.title).slice(0, 200), source: part.source, settings };
  }

  /**
   * A frame's or the chat page's `ccb.call` to its own plugin's program part (G3): only a method the
   * program part exposed (`ui.expose`, or `web.handle`), never a website tool or anything else in the
   * host. A frame's plugin is the one the page bound it to; the chat page's is only what its web part
   * claims (one realm), so the plugin must at least have a web part there.
   */
  async call(name: string, method: string, params: unknown, from: "frame" | "chat"): Promise<unknown> {
    const plugin = this.known(name);
    if (!plugin.enabled || plugin.failure || !plugin.manifest.ccb?.web) throw new ContractError("conflict", `Plugin "${name}" is not on.`);
    try {
      return await this.host.webCall(name, method, params, from);
    } catch (error) {
      throw new ContractError("conflict", (error as Error).message);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Hooks on messages

  /** Your message through the plugins' beforeSend hooks: changed, or stopped by one. */
  async beforeSend(bot: BotInfo, text: string): Promise<{ send: string } | { stoppedBy: string }> {
    if (!text.trim()) return { send: text };
    return this.host.beforeSend(bot, text);
  }

  /** A reply through the plugins' afterReply hooks (null: none listen, it shows as it is). */
  afterReplyFilter(bot: () => BotInfo): ((text: string) => Promise<string>) | null {
    if (this.host.afterReplyHooks <= 0 || !this.host.running) return null;
    return (text) => this.host.afterReply(bot(), text);
  }

  replied(bot: BotInfo, text: string) {
    this.host.replied(bot, text);
  }

  // ------------------------------------------------------------------------------------------
  // Reply tags and prompt sections (plugin-extraction.md W3)

  /**
   * Whether a plugin ships with the app. Only one may take over what the core gives today (a handed tag such as
   * <whiteboard>, a core prompt section's id): a library plugin of the same name replaces a built-in one, so the
   * name alone proves nothing.
   */
  private shipped(name: string) {
    return this.registry.plugin(name)?.builtIn === true;
  }

  /** Each tag enabled plugins declare (`replyTags`), with the plugin it goes to: the first by name when two declare it. */
  replyTagOwners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const entry of ofKind(this.registry.contributions(), "replyTag")) {
      if (HANDED_TAGS[entry.tag] !== undefined && !this.shipped(entry.plugin)) continue;
      if (!owners.has(entry.tag)) owners.set(entry.tag, entry.plugin);
    }
    return owners;
  }

  /**
   * A bot's reply had tags plugins declared: each goes to its plugin's program part (`replyTags.on`). A tag has left the
   * reply's text by now, so one whose plugin is not running yet (the host is starting, or restarting after a crash) is
   * kept on disk and handed over when the plugin loads, the last one for each tag and bot.
   */
  replyTags(bot: BotInfo, tags: PluginTag[]) {
    const owners = this.replyTagOwners();
    for (const tag of tags) {
      const plugin = owners.get(tag.tag);
      if (!plugin || !this.loaded(plugin)) continue;
      if (this.host.runs(plugin) && !this.held.has(plugin)) this.host.replyTag(plugin, bot, tag);
      else this.held.hold(plugin, bot, tag);
    }
    // The host may run it already (only the order mattered above).
    this.replayHeld();
  }

  /** Tags held for plugins the host runs now are handed over, in the order they came. */
  private replayHeld() {
    for (const plugin of new Set(this.replyTagOwners().values())) {
      if (!this.held.has(plugin) || !this.loaded(plugin) || !this.host.runs(plugin)) continue;
      for (const entry of this.held.take(plugin)) {
        if (this.replyTagOwners().get(entry.tag) === plugin) this.host.replyTag(plugin, entry.bot, { tag: entry.tag, attributes: entry.attributes, body: entry.body });
      }
    }
  }

  /** What enabled plugins add to bots' instructions (`promptSections`), in the plugins' order; a core section's id only from a built-in plugin. */
  promptSections() {
    return ofKind(this.registry.contributions(), "promptSection")
      .filter((entry) => !CORE_PROMPT_SECTIONS.some((section) => section.id === entry.id) || this.shipped(entry.plugin));
  }

  // ------------------------------------------------------------------------------------------
  // The app seam (app-seam.ts, plugin-extraction.md §3.2 #6): built-in plugins only

  /** A plugin shipped with the app, running, with the "app" permission. */
  private appPlugin(plugin: InstalledPlugin): AppWorld {
    this.needs(plugin, "app", "Asking the app");
    if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may ask the app.");
    const app = this.options.world.app;
    if (!app) throw new Error("There is no app around the core here.");
    return app;
  }

  /**
   * What the developer project's manager hears at each wake on top of its usual instructions (`worktree`: its session is in an
   * app worktree): the text the on, shipped plugin with the "app" permission pushed for exactly that bot, else "".
   */
  devBriefing(botId: string, worktree: boolean): string {
    for (const name of this.briefingPlugins()) {
      const kept = this.briefings.get(name);
      if (kept?.bot === botId) return worktree ? kept.worktree : kept.plain;
    }
    return "";
  }

  private briefingPlugins(): string[] {
    return this.registry.plugins.filter((plugin) => plugin.enabled && !plugin.failure && plugin.builtIn && !!plugin.manifest.ccb?.permissions?.includes("app")).map((plugin) => plugin.manifest.name).sort();
  }

  // ------------------------------------------------------------------------------------------
  // Approvals a plugin's frame asks for (plugin-extraction.md W4, `ccb.requestApproval`)

  /** A plugin on now (enabled, not failed) that may ask: it has a frame of its own (a web part). */
  private asking(name: string) {
    const plugin = this.known(name);
    if (!plugin.enabled || plugin.failure) throw new ContractError("conflict", `Plugin "${name}" is not on.`);
    return plugin;
  }

  /** The bot's command as the core has it: refused unless `folder` is that bot's own folder. */
  private approvalState(botId: string, command: string, folder: string) {
    const state = this.options.world.commandApproval(botId, command);
    if (!state) throw new ContractError("not_found", "No such bot.");
    if (state.folder !== folder) throw new ContractError("bad_request", `A plugin's command runs in its bot's folder (${state.folder}), not ${folder}.`);
    return state;
  }

  /**
   * A frame's `ccb.requestApproval`, from the app page (which bound the frame to `name`): what the app page's
   * ApprovalSheet shows (null: allowed already, nothing to ask). Asking allows nothing.
   */
  approvalAsk(name: string, botId: string, command: string, folder: string, card?: string): { needsApproval: ApprovalAskView | null } {
    const plugin = this.asking(name);
    const state = this.approvalState(botId, command, folder);
    if (state.approved) return { needsApproval: null };
    const who = title(plugin.manifest).slice(0, 100);
    return { needsApproval: { command, folder: state.folder, detail: null, card: card ? `${who}: ${card.slice(0, 100)}` : who } };
  }

  /** The pictures a frame's tile data names, as card-page URLs (`ccb.tile`: the app page puts them into the tile's page). */
  tileImages(name: string, botId: string, data: string): { images: Record<string, string> } {
    this.asking(name);
    const images = this.options.world.imageUrls(botId, data);
    if (!images) throw new ContractError("not_found", "No such bot.");
    return { images };
  }

  /** "Allow and run" on the ApprovalSheet for a plugin's ask: the command as the sheet showed it, in that bot's folder. */
  approve(name: string, botId: string, command: string, folder: string): { accepted: boolean } {
    this.asking(name);
    this.approvalState(botId, command, folder);
    return { accepted: this.options.world.approveCommand(botId, command) };
  }

  /** The plugin whose name a host message gives, if it is loaded (the host names it; it is all one process). */
  private loaded(name: unknown) {
    if (typeof name !== "string") return null;
    const plugin = this.registry.plugin(name);
    return plugin && plugin.enabled && !plugin.failure && plugin.manifest.ccb?.host ? plugin : null;
  }

  /** A request's params and the loaded plugin it names; throws when either is wrong. */
  private asked<T extends z.ZodTypeAny>(schema: T, params: unknown): { plugin: InstalledPlugin; data: z.infer<T> } {
    const parsed = schema.safeParse(params);
    if (!parsed.success) throw new Error(`Not a request a plugin can make: ${parsed.error.issues[0]?.message ?? "bad params"}.`);
    const plugin = this.loaded((parsed.data as { plugin?: unknown }).plugin);
    if (!plugin) throw new Error("That plugin is not running.");
    return { plugin, data: parsed.data };
  }

  /** The consistency check of plugin-platform.md §5: what acts as the user needs the capability declared. */
  private needs(plugin: InstalledPlugin, capability: string, what: string) {
    if (!plugin.manifest.ccb?.permissions?.includes(capability)) throw new Error(`${what} needs the "${capability}" permission in package.json.`);
  }

  /** Every key in effect: Botling's shortcuts, then plugins' commands' (those not left without one). */
  keybindings(): { command: string; key: string; source: "default" | "user" | "plugin" }[] {
    const overrides = this.options.world.shortcutOverrides();
    const user = (id: string) => Object.hasOwn(overrides, id);
    return [
      ...Object.entries(bindingsFor(overrides)).map(([command, key]) => ({ command, key, source: user(command) ? "user" as const : "default" as const })),
      ...pluginBindings(commandSurfaces(this.contributions()).keybindings, overrides)
        .flatMap((binding) => (binding.combo ? [{ command: binding.command, key: binding.combo, source: user(binding.command) ? "user" as const : "plugin" as const }] : [])),
    ];
  }

  private notified(method: string, params: unknown) {
    const { world } = this.options;
    switch (method) {
      case "notify": {
        const parsed = NotifyParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!parsed.success || !plugin) return;
        const more = NotifyMore.safeParse(params);
        const level = more.success && more.data.level && more.data.level !== "info" ? ` (${more.data.level === "warn" ? "warning" : "error"})` : "";
        // An action runs one of the plugin's own commands, as a frame of its would.
        const name = plugin.manifest.name;
        const actions = (more.success ? more.data.actions ?? [] : []).filter((action) => action.command.startsWith(`${name}.`))
          .map((action) => ({ label: action.title, run: () => { void this.command(action.command, "frame", name).catch(() => {}); } }));
        world.notice(`${title(plugin.manifest)}${level}: ${parsed.data.text.slice(0, 4_000)}`, actions.length ? actions : undefined);
        return;
      }
      case "ui.emit": {
        const parsed = EmitParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!parsed.success || !plugin) return;
        const { name, botId, data } = parsed.data;
        // Plain JSON that fits: a frame hears no more than it could be called with.
        let text: string | undefined;
        try { text = JSON.stringify(data ?? null); } catch { return; }
        if (text === undefined || text.length > EMIT_MAX) return;
        world.frameEvent?.(plugin.manifest.name, name, botId, data ?? null);
        return;
      }
      case "ui.setStatus": {
        const parsed = StatusParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!parsed.success || !plugin) return;
        const { id, item } = parsed.data;
        const items = this.status.get(plugin.manifest.name) ?? new Map<string, PluginStatusItem>();
        if (item) {
          if (!items.has(id) && items.size >= 20) return;
          items.set(id, { id, text: item.text, icon: item.icon ?? null, tooltip: item.tooltip ?? null, command: item.command?.startsWith(`${plugin.manifest.name}.`) ? item.command : null });
        } else {
          items.delete(id);
        }
        if (items.size) this.status.set(plugin.manifest.name, items);
        else this.status.delete(plugin.manifest.name);
        this.announce();
        return;
      }
      default:
        world.log(`plugin host: unknown notification ${method.slice(0, 80)}`);
    }
  }

  private async requested(method: string, params: unknown): Promise<unknown> {
    const { world } = this.options;
    switch (method) {
      case "bots.list":
        return world.bots();
      case "bots.send": {
        const { plugin, data } = this.asked(SendParams, params);
        if (data.as === "user") this.needs(plugin, "bots", "Sending as the user");
        return world.send(data.bot, data.text, data.as === "user" ? null : title(plugin.manifest));
      }
      case "bots.wake": {
        const { plugin, data } = this.asked(WakeParams, params);
        // A bot wakes when it gets a message; a wake without one waits for the core to have that.
        if (data.prompt === undefined) throw new Error("bots.wake needs a prompt for now (a bot wakes when it gets a message).");
        world.send(data.bot, data.prompt, title(plugin.manifest));
        return null;
      }
      case "bots.interrupt": {
        const { plugin, data } = this.asked(BotParams, params);
        this.needs(plugin, "bots", "Stopping bots");
        const stopped = await world.interrupt(data.bot);
        if (stopped === null) throw new Error("No such bot.");
        return { stopped };
      }
      case "bots.folder": {
        const { plugin, data } = this.asked(BotParams, params);
        this.needs(plugin, "exec", "Reading a bot's folder");
        return world.botFolder?.(data.bot) ?? null;
      }
      case "ui.quickPick": {
        const { plugin, data } = this.asked(PickParams, params);
        const answer = await world.ask({ text: `${title(plugin.manifest)}: ${data.title ?? "Pick one."}`, choices: [...data.items.map((item) => ({ label: item.label, ...(item.detail ? { detail: item.detail } : {}) })), { label: "Cancel" }], typed: false });
        return answer && "index" in answer ? data.items[answer.index]?.id ?? null : null;
      }
      case "ui.input": {
        const { plugin, data } = this.asked(InputParams, params);
        // Words typed in the chat stay in its history: no place for a secret.
        if (data.secret) throw new Error("A secret cannot be asked for in the chat yet; declare a secret setting instead.");
        const answer = await world.ask({ text: `${title(plugin.manifest)}: ${data.title}${data.placeholder ? ` (${data.placeholder})` : ""}`, choices: [{ label: "Cancel" }], typed: true });
        return answer && "text" in answer ? answer.text : null;
      }
      case "ui.openView": {
        const { plugin, data } = this.asked(ViewParams, params);
        const name = plugin.manifest.name;
        const panel = plugin.manifest.ccb?.web ? plugin.manifest.ccb.contributes?.panels?.find((candidate) => candidate.id === data.id) : undefined;
        if (!panel) throw new Error(`Plugin "${name}" has no view "${data.id}".`);
        world.openPanel(name, panel.id, panel.title.slice(0, 200));
        return null;
      }
      case "settings.update": {
        const { plugin, data } = this.asked(SettingParams, params);
        const setting = plugin.manifest.ccb?.contributes?.settings?.[data.key];
        if (setting?.secret) throw new Error("A secret setting is set with secrets.set.");
        try {
          this.setSetting(plugin.manifest.name, data.key, data.value);
        } catch (error) {
          throw new Error((error as Error).message);
        }
        return null;
      }
      case "secrets.get": {
        const { plugin, data } = this.asked(SecretGetParams, params);
        return this.secrets.get(plugin.manifest.name, data.key);
      }
      case "secrets.set": {
        const { plugin, data } = this.asked(SecretSetParams, params);
        await this.registry.setSecret(plugin.manifest.name, data.key, data.value || null);
        return null;
      }
      case "keybindings.list":
        this.asked(z.object({ plugin: str(214) }), params);
        return this.keybindings();
      case "keybindings.set": {
        const { plugin, data } = this.asked(KeyParams, params);
        const name = plugin.manifest.name;
        if (!plugin.manifest.ccb?.contributes?.commands?.some((command) => command.id === data.command) || !data.command.startsWith(`${name}.`)) {
          throw new Error(`"${data.command}" is not a command of "${name}" (a plugin binds keys to the commands its package.json lists).`);
        }
        if (data.key === null) {
          this.registry.setCommandKey(name, data.command, null);
          return { ok: true };
        }
        const key = legacyKey(data.key);
        if (!key) throw new Error(`"${data.key}" is not a key (like "Mod+Shift+L": Mod, Ctrl, Cmd or Alt, and one key).`);
        const conflict = findConflict(data.command, key, this.options.world.shortcutOverrides(), commandSurfaces(this.contributions()).keybindings);
        if (conflict) return { ok: false, conflict: conflict.id };
        this.registry.setCommandKey(name, data.command, key);
        return { ok: true };
      }
      case "bots.create": {
        const parsed = CreateParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!plugin?.manifest.ccb?.permissions?.includes("bots")) throw new Error("Creating bots needs the \"bots\" permission in package.json.");
        const raw = parsed.data as Record<string, unknown>;
        const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).slice(0, 4_000) : "");
        return world.createBot(plugin.manifest.name, plugin.manifest.displayName ?? plugin.manifest.name, text("name"), text("job"), text("avatar") || undefined);
      }
      case "approvals.check": {
        // Whether the user allowed a command in a bot's folder (its frame asks with ccb.requestApproval).
        const { data } = this.asked(ApprovalParams, params);
        const state = world.commandApproval(data.bot, data.command);
        if (!state) throw new Error("No such bot.");
        return state;
      }
      case "approvals.state":
      case "approvals.run": {
        // A run of a command the user allowed (the plugin's frame asked for that on the app page); the core runs it. Never an unallowed one.
        const { plugin, data } = this.asked(RunParams, params);
        // A run is the plugin's own: its key is kept under the plugin's name.
        const run = world.commandRun(data.bot, `${plugin.manifest.name}/${data.key}`, data.command, method === "approvals.run" ? { minIntervalMs: data.minIntervalMs ?? 0 } : false);
        if (!run) throw new Error("No such bot.");
        const { started, ...state } = run;
        return method === "approvals.run" ? { ...state, started } : state;
      }
      case "workspace.component": {
        const { data } = this.asked(ComponentParams, params);
        const entry = world.component(data.bot, data.name, data.data, data.command);
        if (!entry) throw new Error("No such bot.");
        return entry;
      }
      case "routines.add": {
        const parsed = RoutineParams.safeParse(params);
        if (!parsed.success || !this.loaded(parsed.data.plugin)) throw new Error("No such bot.");
        const outcome = world.addRoutine(parsed.data.bot, parsed.data.cron, parsed.data.task);
        if (outcome === "no-bot") throw new Error("No such bot.");
        if (outcome === "bad-schedule") throw new Error("Invalid schedule (it must be the 5 crontab fields).");
        return null;
      }
      case "routines.list":
      case "routines.change": {
        // A built-in plugin shows a bot's routines and pauses, resumes or cancels them, as the app's own Routines panel did. It never creates one.
        const { plugin, data } = method === "routines.list" ? this.asked(RoutinesListParams, params) : this.asked(RoutinesChangeParams, params);
        this.needs(plugin, "routines", "Reading or changing routines");
        if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may read or change routines.");
        if (!world.routinesList || !world.routinesChange) throw new Error("Routines are not available here.");
        const done = method === "routines.list" ? world.routinesList(data.bot) : world.routinesChange(data.bot, (data as z.infer<typeof RoutinesChangeParams>).operation, (data as z.infer<typeof RoutinesChangeParams>).id);
        if (!done) throw new Error("No such bot.");
        return done;
      }
      case "usage.view": {
        // Read only, for any plugin: what Settings → Usage and the quota rings show, as the `usage.view` command gives it.
        this.asked(PluginOnly, params);
        if (!world.usageView) throw new Error("Usage is not available here.");
        return world.usageView();
      }
      case "sessions.folder": {
        // A built-in plugin says where a bot's session starts (null: its own folder again); bots restart for it.
        const { plugin, data } = this.asked(FolderParams, params);
        this.needs(plugin, "sessions", "Deciding a session's folder");
        if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may decide a session's folder.");
        const folder = data.folder === null ? null : cleanFolder(data.folder);
        if (data.folder !== null && !folder) throw new Error("A folder needs an absolute `cwd`.");
        if (!world.botId?.(data.bot)) throw new Error("No such bot.");
        const botId = world.botId(data.bot)!;
        if (this.folders.set(plugin.manifest.name, botId, folder)) this.foldersChanged([botId], data.reason);
        return null;
      }
      case "sessions.folders": {
        // The plugin's whole picture, when it loads: what it no longer holds goes back to the bot's own folder.
        const { plugin, data } = this.asked(FoldersParams, params);
        this.needs(plugin, "sessions", "Deciding a session's folder");
        if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may decide a session's folder.");
        const next: Record<string, SessionFolder> = {};
        for (const [bot, raw] of Object.entries(data.folders)) {
          const id = world.botId?.(bot), folder = cleanFolder(raw);
          if (id && folder) next[id] = folder;
        }
        const changed = this.folders.replace(plugin.manifest.name, next);
        if (changed.length) this.foldersChanged(changed);
        return null;
      }
      case "sessions.bots": {
        const { plugin } = this.asked(PluginOnly, params);
        this.needs(plugin, "sessions", "Reading the bots' folders");
        return world.sessionBots?.() ?? [];
      }
      case "app.state": {
        const { plugin } = this.asked(PluginOnly, params);
        return this.appPlugin(plugin).state();
      }
      case "app.captureWindow": {
        const { plugin } = this.asked(PluginOnly, params);
        return this.appPlugin(plugin).captureWindow();
      }
      case "app.installAndRestart": {
        const { plugin, data } = this.asked(AppInstallParams, params);
        const app = this.appPlugin(plugin);
        const state = app.state();
        if (!installCommandOK(data.command, state.dataDir)) throw new Error("That is not the install script of this Botling.");
        app.installAndRestart(data.command, data.log);
        return null;
      }
      case "app.card": {
        const { plugin, data } = this.asked(AppCardParams, params);
        const index = await this.appPlugin(plugin).card(data.text, data.choices, data.source);
        return index === null ? null : { index };
      }
      case "app.tell": {
        const { plugin, data } = this.asked(AppTellParams, params);
        if (!this.appPlugin(plugin).tell(data.bot, data.kind, data.text, data.files ?? [])) throw new Error("No such bot.");
        return null;
      }
      case "app.briefing": {
        const { plugin, data } = this.asked(AppBriefingParams, params);
        this.appPlugin(plugin);
        this.briefings.set(plugin.manifest.name, data.briefing);
        return null;
      }
      case "workspace.bots":
        this.asked(PluginOnly, params);
        return world.workspace.bots();
      case "workspace.memory":
        return world.workspace.memory(this.asked(BotParams, params).data.bot);
      case "workspace.tasks": {
        const { data } = this.asked(TasksParams, params);
        return world.workspace.tasks(data.bot, data.limit);
      }
      case "workspace.taskHistory": {
        const { data } = this.asked(HistoryParams, params);
        return world.workspace.taskHistory(data.bot, data.days);
      }
      case "workspace.results": {
        const { data } = this.asked(ResultsParams, params);
        return world.workspace.results(data.bot, data.limit);
      }
      case "workspace.waiting":
        this.asked(PluginOnly, params);
        return world.workspace.waiting();
      case "workspace.ignoreWaiting": {
        // "I know", as the app's own button: not an answer, and nothing a bot is told.
        const { data } = this.asked(IgnoreParams, params);
        world.workspace.ignoreWaiting(data.bot, data.text);
        return null;
      }
      case "workspace.pendingApprovals":
        return world.workspace.pendingApprovals(this.asked(BotParams, params).data.bot);
      case "workspace.face": {
        const { data } = this.asked(FaceParams, params);
        return world.workspace.face(data.bot, data.look);
      }
      case "chat.messages": {
        const { plugin, data } = this.asked(ChatParams, params);
        this.needs(plugin, "messages", "Reading a chat");
        const chat = world.chat?.(data.bot, data.limit) ?? null;
        if (!chat) throw new Error("No such bot.");
        return chat;
      }
      case "chat.decorate": {
        const { plugin, data } = this.asked(DecorateParams, params);
        const name = plugin.manifest.name;
        if (!plugin.manifest.ccb?.web) throw new Error("Message decorations are drawn by the plugin's web part: it needs one (ccb.web).");
        const botId = world.botId?.(data.bot) ?? null;
        if (!botId) throw new Error("No such bot.");
        const list: MessageDecoration[] = data.decorations.map((entry) => ({
          plugin: name, key: entry.key,
          ...(entry.fold?.length ? { fold: entry.fold } : entry.after ? { after: entry.after } : {}),
          ...(entry.tasks?.length ? { tasks: entry.tasks } : {}),
          ...(entry.data === undefined ? {} : { data: entry.data as JSONValue }),
        }));
        if (new Set(list.map((entry) => entry.key)).size !== list.length) throw new Error("Each decoration needs a key of its own.");
        if (JSON.stringify(list).length > DECORATION_BYTES) throw new Error("Too much to draw in one chat (1 MB at most).");
        const byPlugin = this.decorated.get(botId) ?? new Map<string, MessageDecoration[]>();
        const before = JSON.stringify(byPlugin.get(name) ?? []);
        if (list.length) byPlugin.set(name, list); else byPlugin.delete(name);
        if (byPlugin.size) this.decorated.set(botId, byPlugin); else this.decorated.delete(botId);
        if (JSON.stringify(list) !== before) world.decorated?.(botId);
        return null;
      }
      case "engines.cli": {
        const { data } = this.asked(EngineParams, params);
        return world.engineCli?.(data.engine) ?? null;
      }
      default:
        throw new Error(`Unknown method "${method.slice(0, 80)}".`);
    }
  }
}
