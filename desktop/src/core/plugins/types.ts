// Plugin types of the core (moved out of index.ts, M7-S12): what the core lends the plugins (`PluginWorld`), the options of
// `Plugins`, and the small shapes they use. index.ts re-exports every name.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { type ApprovalAskView, type PluginsView, type PluginView, type ResultOf } from "../../contract";
import { type StreamId } from "../../protocol";
import { type Overrides } from "../../contract/shortcuts";
import { type HostCommand, type HostTiming } from "./host-client";
import { type JSONValue } from "./manifest";
import { type Sealer } from "./secrets";
import { type WorkspaceSource } from "../workspace";
import { type AppWorld } from "./app-seam";
import { type StudioWorld } from "./studio-seam";
import type { OrchestrationWorld } from "../orchestration/plugin-workers";
import { type PluginBotExtras } from "./request-params";

export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean }

/** A question of the app's in the main bot's chat (`ui.quickPick`, `ui.input`). */
export interface AppQuestion { text: string; choices: { label: string; detail?: string }[]; typed: boolean }
/** Its answer: a pick, or the user's own words (`typed` only). Ignoring it (no callbacks, by design) answers nothing. */
export type AppAnswer = { index: number } | { text: string };
export interface PluginStatusItem { id: string; text: string; icon: string | null; tooltip: string | null; command: string | null }
/** A chat as a plugin may read it (`chat.messages`): its newest lines as kept, its name and unread count. `tasks` is always empty (task cards were removed in 2.5). */
export interface PluginChat { botId: string; name: string; unread: number; messages: unknown[]; tasks: never[] }
/** What a plugin's web part draws among a chat's messages (`chat.decorate`, chat extension v2). */
export interface MessageDecoration { plugin: string; key: string; fold?: string[]; after?: string; under?: string; data?: JSONValue }
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
/** A component as a note's insert menu lists it (`notes.components`). */
export interface NoteComponent {
  name: string;
  /** A short name from about.md's first line; null: none. */
  title: string | null;
  /** about.md's first line. */
  summary: string;
  /** In the bot's own list (else elsewhere in the library). */
  offered: boolean;
  /** Its about.md Command: an empty `<show name="…"></show>` runs it. */
  command: string | null;
  /** Its about.md Refresh in seconds. */
  every: number | null;
  sizes: string[];
  icon: string | null;
  /** The newest JSON the bot's chat drew it with, for a preview; null: none. */
  chatData: string | null;
}
export interface NoteComponents { folder: string; readOnly: boolean; components: NoteComponent[] }
/** A note card as it draws now (`notes.cards`). */
export interface NoteCardState {
  key: string;
  name: string;
  /** Whether the library has that component. */
  exists: boolean;
  /** The command it runs: its own command="…", or its component's Command when it has no JSON; null: it shows its JSON. */
  command: string | null;
  /** The folder the command runs in (what the ApprovalSheet shows). */
  folder: string;
  /** Seconds between reruns (its refresh="…", else about.md's Refresh); null: by hand. */
  every: number | null;
  /** "static": no command, `data` is its JSON; "approve": the user has not allowed the command in that folder yet. */
  status: "static" | "approve" | "idle" | "running" | "done" | "failed";
  /** JSON to draw: the last run's output, else the card's own JSON ("null"). */
  data: string;
  error: string | null;
  ranAt: number | null;
  /** Card-page URLs of the local pictures `data` names (what `ccb.card` puts into its page). */
  images: Record<string, string>;
  /** The newest JSON the chat drew this component with (to show before the first run); null: none. */
  chatData: string | null;
}

/** A reference to a content item as plugins get it (`content.read`): owner, hash and the entry that holds it. */
export interface LineContentRef { owner: string; id: string; entry: { stream: StreamId; seq: number } }

export interface PluginWorld {
  bots(): BotInfo[];
  /**
   * A message to a bot (`bots.send`, `bots.wake`): shown as sent `via` that plugin (its title), or as the user's own (null). Throws why not.
   * `from`: the plugin, when it is not shipped with Botling (M7-O05: it stays with the message, and the turn that answers it is checked as that plugin's).
   */
  send(botId: string, text: string, via: string | null, from?: string): { messageId: string };
  /** Stops every turn a bot has under way, as its stop button does (null: no such bot). */
  interrupt(botId: string): Promise<boolean | null>;
  /** A line in the main bot's chat; with `actions`, buttons under it. */
  notice(text: string, actions?: { label: string; run: () => void }[]): void;
  /** Asks the user in the main bot's chat. */
  ask(question: AppQuestion): Promise<AppAnswer>;
  /** Opens a plugin's panel on the app page. */
  openPanel(plugin: string, panel: string, title: string): void;
  /** A plugin's `ui.showTab(…, { open: true })`: the main window shows that bot (the core's id) with that `mainTab` view. Absent: no window. */
  openTab?(plugin: string, view: string, botId: string): void;
  /** A plugin's push to its frames (`ui.emit`), on its way to the app page; never part of a snapshot, and no other client hears it. */
  frameEvent?(plugin: string, name: string, botId: string | undefined, data: unknown): void;
  /** A bot's working folder as the core keeps it, the main bot's too (null: no such bot). */
  botFolder?(botId: string): string | null;
  /** Where a bot's note is (bot-note.ts `notePath`, the Note tab's file; null: no such bot). The only file `notes.*` touches. */
  botNote?(botId: string): string | null;
  /** The URL a plugin's frame loads a picture from (`botling-card://image/<token>`, components' ImageRegistry); only for a note's own pictures. */
  imageUrl?(path: string, type: string): string;
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
  /** What the ApprovalSheet asks about a pin's card (`approvalAsk` with a `component`): its command and the component's Detail command; null: allowed already (or no such bot). */
  cardAsk?(botId: string, card: string, command: string, component: string): ApprovalAskView | null;
  /** "Allow" for a pin's card: its command and Detail command as the sheet showed them. */
  cardApprove?(botId: string, command: string, component: string, folder: string, detail: string | null): boolean;
  /** What built-in plugins that keep cards of their own ask of a chat's components and their commands (`cards.*`); null: no such bot (or no component context). */
  cards?: {
    library(botId: string): { botId: string; names: string[]; offered: string[]; pinOnly: string[]; entries: Record<string, { command: string | null; detail: string | null; every: number | null; sizes: string[] }>; readOnly: boolean; folder: string } | null;
    shown(botId: string): { messageId: string; index: number; name: string; command: string | null; shownCommand: string | null; data: string; author: string | null }[] | null;
    states(botId: string, cards: { card: string; command: string | null; name: string; data?: string }[]): unknown[] | null;
    run(botId: string, card: string, command: string, force: boolean): boolean | null;
    ask(botId: string, card: string, command: string, component: string): ApprovalAskView | null;
    setNotes(botId: string, notes: { date: number; line: string }[]): boolean;
    legacyPins(botId: string): unknown[] | null;
  };
  /** The cards in a bot's note (`notes.components`, `notes.cards`, `notes.runCard`: bot.ts `noteComponents` …); null: no such bot. */
  noteCards?: {
    components(botId: string): NoteComponents | null;
    states(botId: string, cards: { key: string; name: string; command: string | null; data: string; refresh: number | null }[]): NoteCardState[] | null;
    run(botId: string, key: string, command: string, force: boolean): { folder: string; approved: boolean; started: boolean } | null;
  };
  /** What a plugin keeps for a chat's page changed (`chat.setData`). */
  dataChanged?(botId: string, plugin: string, data: unknown): void;
  /** The bot's component library, read only (`workspace.component`); null: no such bot. */
  component(botId: string, name: string, data: string | undefined, command: string | undefined): { exists: boolean; command: string | null } | null;
  /** The card-page URLs of the pictures a component's data names for that bot (what a tile needs); null: no such bot. */
  imageUrls(botId: string, data: string): Record<string, string> | null;
  /**
   * `bots.create` for a plugin (`makeBot` with its name): the bot's info and whether it is new; throws why not. `more`: a sub bot's
   * project bot (`parent`), instructions of any length kept in a file the bot reads, and its delegation ("onRequest": it does the
   * work itself, starting subagents or workers only when the user asks).
   */
  createBot(plugin: string, title: string, name: string, job: string, avatar: string | undefined, more?: PluginBotExtras): BotInfo & { created: boolean };
  /** Botling 3 content read/fetch (`content.read`, `content.fetch`). Absent in 2.x. */
  content?: {
    read(ref: { owner: string; id: string; entry: { stream: StreamId; seq: number } }, offset: number, length: number): Promise<Uint8Array>;
    fetch?(storageDir: string, ref: { owner: string; id: string; entry: { stream: StreamId; seq: number } }): Promise<string>;
  };
  /**
   * Botling 3 only (M5-09): the content reference of the file a chat line's link names (the line's `content_names` row, its hash
   * ready), or null when the line holds none for that link. `link` is the address `linkCommand` matched (a file: URL). Absent in 2.x.
   */
  lineContent?(botId: string, messageId: string, link: string): LineContentRef | null;
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
  /** What the component studio asks of the core (`studio.*`, built-in plugins only). Absent: a world without one (tests, spec adapters). */
  studio?: StudioWorld;
  /** The worker primitives (`workers.*`, M7-O03a): the user's grant, the bots' Claude workers, the quota. Absent: no plugin starts workers here (tests, 2.x). */
  orchestration?: OrchestrationWorld;
  /** A routines.cron line (`routines.add`); false: no such bot, or not a valid schedule. */
  addRoutine(botId: string, cron: string, task: string): "added" | "no-bot" | "bad-schedule";
  /** A bot's routines as the app lists them (`routines.list`; null: no such bot). Absent: a world without routines (tests, spec adapters). */
  routinesList?(botId: string): ResultOf<"routines.list"> | null;
  /** Pauses, resumes or cancels one of a bot's routines (`routines.change`); throws why not. Returns the list after. */
  routinesChange?(botId: string, operation: "pause" | "resume" | "cancel", id: string): ResultOf<"routines.change"> | null;
  /** The library changed: the app shows it. */
  changed(view: PluginsView): void;
  /** A non-built-in plugin was written or changed on disk outside store installs/removals. */
  pluginWritten?(name: string): void;
  /** A plugin broke: Maintainer is asked to fix it. */
  broken(plugin: string, problem: string): void;
  /** A plugin update took effect; `allowed` is what the grant rows say (Maintainer is told, the main bot gets its own notice). */
  updated?(title: string, version: string, allowed: boolean): void;
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
  /** Botling 3 binds each sealed secret blob to plugin/key (M6-06 F3); 2.x leaves it unset. */
  boundSecrets?: boolean;
  timing?: HostTiming;
  /** The plugin host's pid, for the process ledger. */
  onPid?: (pid: number, alive: boolean) => void;
  /** Botling 3 (M5-18a): whether a plugin's program part may start at its current code hash (absent: always allowed). */
  mayRunServerPart?: (name: string, codeHash: string) => boolean;
  /** Botling 3 (M5-18b): run each non-built-in plugin's program part in its own host process (2.x: shared host). */
  separateHosts?: boolean;
  /** Botling 3's server only (2.x leaves it unset): the grant tier at this plugin's running hash, or null to omit. */
  pluginGrant?: (name: string) => "none" | "read" | "request" | "write" | null;
  /** Botling 3's server only: what this plugin asks at its running hash (`PluginView.asks`), or null to omit. */
  pluginAsks?: (name: string) => PluginView["asks"] | null;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** Whether `path` is a regular file on this machine now (a missing file, a folder, an unreadable one: no). */
function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

interface SnapshotFile { rel: string; data: Buffer; mode: number }

export { sha, isRegularFile };
export type { SnapshotFile };
