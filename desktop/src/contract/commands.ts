// Commands: the request schemas (`Command`, `CommandType`) and the views the plugin and machine commands carry (moved out of index.ts, M7-S02c).
import { z } from "zod";
import { ContractId, CARD_SAVE_LIMIT, FILE_DATA_LIMIT } from "./editor-card";
import { BotId, Engine, AnswerTarget, MESSAGE_TEXT_LIMIT, UploadedFile } from "./views";
import { MachineView, SettingsChange, PluginName, Effort, ModelId } from "./views-settings";

const id = ContractId;
const AgentMoveTo = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), botId: BotId }),
  z.strictObject({ kind: z.literal("newSubBot"), name: z.string().min(1).max(400), note: z.string().max(4_000).optional() }),
  z.strictObject({ kind: z.literal("back") }),
]);

// ---------------------------------------------------------------------------------------------
// Commands. `target` says who answers it: main answers some itself, the rest go to the core.

const botId = BotId;
const PluginCommandId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
/** The app's fixed places a plugin may add a command to (`contributes.menus`). */
const PluginMenu = z.enum(["message/context", "bot/context", "composer/plus", "commandPalette", "message/preview", "browser/tab", "chat/link"]);
/** A `browser/tab` menu entry's tabs, or a `chat/link` one's links (browser-tab-menu.ts `TabWhen`). */
const TabWhenView = z.strictObject({ scheme: z.string().max(100).optional(), ext: z.array(z.string().max(20)).max(20).optional(), host: z.string().max(100).optional() });
/** Who asks a plugin: one of its sandboxed frames (panel, tile, card) or the chat page (its web part). */
const PluginCaller = z.enum(["frame", "chat"]);
/** A bot as plugins name it ("main", or its id: `bots.list`). */
const PluginBotId = z.union([z.literal("main"), BotId]);
const SettingKey = z.string().min(1).max(200);
const SettingValue = z.union([z.boolean(), z.number(), z.string().max(10_000), z.null()]);

/** One plugin as the Plugins panel shows it. Secrets show only whether they are set. */
export const PluginView = z.strictObject({
  name: PluginName,
  title: z.string().max(200),
  version: z.string().max(100),
  description: z.string().max(2_000).nullable(),
  enabled: z.boolean(),
  failure: z.string().max(2_000).nullable(),
  installedFrom: z.string().max(2_000).nullable(),
  /** Shipped with Botling (step M11): read-only, can only be turned off. */
  builtIn: z.boolean().optional(),
  /** What this machine grants this plugin at its running hash (Botling 3 only; 2.x leaves it unset). */
  grant: z.enum(["none", "read", "request", "write"]).optional(),
  /**
   * What this plugin asks at its running hash on this machine (Botling 3 only): the window's Settings › Plugins offers the
   * tiers up to `tier` and sends one `plugin.grant` at exactly this hash and these asks. Lazy: the schemas are defined below.
   */
  asks: z.strictObject({
    codeHash: z.lazy(() => PluginCodeHash),
    tier: z.enum(["read", "request", "write"]),
    reads: z.array(z.string().min(1).max(200)).max(50),
    requests: z.array(z.lazy(() => CommandTypeEnum)).max(100),
  }).optional(),
  /** A library plugin running in place of the built-in one of the same name (its version is the same or newer): the built-in's version. */
  replacesBuiltIn: z.string().max(100).optional(),
  /** A built-in plugin running while the library holds an older copy (or one whose version is not a semver), which is ignored: that copy's version. */
  ignoredLibraryVersion: z.string().max(100).optional(),
  /** Entries of its `contributes` this Botling skips, with why (a slot or value it does not know): the rest of it loads. */
  skipped: z.array(z.string().max(2_000)).max(50).optional(),
  /** Installed from outside (the catalog, <install>): the Plugins page offers Remove (its data folder stays). */
  removable: z.boolean().optional(),
  /** The version an install or update replaced, kept for Revert. */
  revertTo: z.string().max(100).optional(),
  permissions: z.array(z.string().max(40)).max(20),
  parts: z.array(z.enum(["web", "host", "claude", "components"])).max(4),
  settings: z.array(z.strictObject({
    key: SettingKey, type: z.string().max(20), title: z.string().max(400), options: z.array(z.string().max(200)).max(50),
    value: SettingValue, secret: z.boolean(), set: z.boolean(),
    /** Set on the Settings page instead (a built-in plugin's), not listed with the plugin. */
    hidden: z.boolean().optional(),
    /** What it is while you have not set it. */
    default: SettingValue.optional(),
  })).max(100),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), registered: z.boolean() })).max(100),
  panels: z.array(z.strictObject({ id: z.string().max(100), title: z.string().max(200) })).max(20),
  /** What its program part shows in the status area (`ui.setStatus`); `command`: one of its own, run on a click. */
  status: z.array(z.strictObject({
    id: z.string().max(100), text: z.string().max(200), icon: z.string().max(100).nullable(), tooltip: z.string().max(1_000).nullable(), command: z.string().max(200).nullable(),
  })).max(20).optional(),
});
export type PluginView = z.infer<typeof PluginView>;
export const MachinesView = z.strictObject({
  /** False: workers on other machines are not available in this app (a test or probe run). */
  enabled: z.boolean(),
  relay: z.strictObject({ url: z.string().max(300).nullable(), state: z.enum(["off", "connecting", "online", "offline"]) }),
  machines: z.array(MachineView).max(100),
});
export type MachinesView = z.infer<typeof MachinesView>;
export const MachinePairView = z.strictObject({ command: z.string().max(4_000), expiresAt: z.number() });
export type MachinePairView = z.infer<typeof MachinePairView>;

/** A plugin's web part for the chat page (1.x's `WebPluginSpec`). */
export const WebPluginSpecView = z.strictObject({
  name: z.string().max(214), version: z.string().max(100), source: z.string().max(5_000_000),
  /** Its stylesheets, served by the chat origin (botling-chat://chat/plugin-files/<name>/<path>). */
  styles: z.array(z.string().max(2_000)).max(20),
  settings: z.record(z.string().max(200), z.unknown()),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), key: z.string().max(40).optional() })).max(100),
  /** Ships with Botling: its web part may use the chat page's own parts (`ccb.page`, the message bars). */
  builtIn: z.boolean().optional(),
});
export type WebPluginSpecView = z.infer<typeof WebPluginSpecView>;
/** One plugin of the public catalog (botling-plugins' index.json) as the Plugins page's Explore and Updates show it. */
export const PluginStoreEntryView = z.strictObject({
  name: PluginName, title: z.string().max(200), description: z.string().max(2_000), version: z.string().max(100), license: z.string().max(100).nullable(),
  permissions: z.array(z.string().max(40)).max(20), parts: z.array(z.string().max(40)).max(8), minAppVersion: z.string().max(100).nullable(),
  size: z.number(), files: z.number(), commit: z.string().max(40),
  /** Its folder at that commit on GitHub; null until released. */
  page: z.string().max(2_000).nullable(),
  /**
   * available: not installed; installed: this version or newer is; update: an older one is installed (or built in); builtIn: Botling ships
   * this version or newer; devCopy: the plugin library has its own copy (never replaced); tooOld: this Botling is too old for it;
   * unreleased: no commit recorded yet.
   */
  state: z.enum(["available", "installed", "update", "builtIn", "devCopy", "tooOld", "unreleased"]),
  installedVersion: z.string().max(100).nullable(),
  /** An install from the page: being downloaded and checked, waiting on the install card, or how it ended. */
  status: z.strictObject({ kind: z.enum(["checking", "asking", "installed", "declined", "failed"]), message: z.string().max(2_000).nullable() }).nullable(),
});
export type PluginStoreEntryView = z.infer<typeof PluginStoreEntryView>;
export const PluginStoreView = z.strictObject({
  url: z.string().max(2_000),
  /** The official catalog (not settings.json `pluginIndexURL`). */
  official: z.boolean(),
  /** When the entries were fetched (ms since 1970); null: never. */
  fetchedAt: z.number().nullable(),
  /** The last fetch failed: the entries are the copy from `fetchedAt`. */
  fromCache: z.boolean(),
  error: z.string().max(2_000).nullable(),
  /** The last fetch did not reach the server at all. */
  offline: z.boolean(),
  loading: z.boolean(),
  appVersion: z.string().max(100).nullable(),
  entries: z.array(PluginStoreEntryView).max(500),
  /** How many installed plugins have a newer version in the catalog. */
  updates: z.number().int(),
});
export type PluginStoreView = z.infer<typeof PluginStoreView>;
export const PluginsView = z.strictObject({
  plugins: z.array(PluginView).max(200),
  /** Folders that look like plugins but failed the check, with why. */
  broken: z.array(z.strictObject({ folder: z.string().max(214), problems: z.array(z.string().max(2_000)).max(50) })).max(200),
  host: z.strictObject({ running: z.boolean(), problem: z.string().max(2_000).nullable() }),
  /** Why secrets cannot be kept here (no safe storage), or null. */
  secretsProblem: z.string().max(2_000).nullable(),
  /** Plugin commands on keys (default key, shortcuts.ts spelling), in the / menu and in the app's menus, from plugins that are on. */
  keybindings: z.array(z.strictObject({ command: PluginCommandId, key: z.string().max(40), plugin: PluginName, title: z.string().max(200) })).max(500).optional(),
  /** Without `command` the name goes into the message as words, for the bot (botling.design's /design). */
  slash: z.array(z.strictObject({ name: z.string().max(40), about: z.string().max(400), command: PluginCommandId.optional(), plugin: PluginName })).max(200).optional(),
  menus: z.array(z.strictObject({ menu: PluginMenu, command: PluginCommandId, plugin: PluginName, title: z.string().max(200), icon: z.string().max(40).optional(), quick: z.boolean().optional(), alt: z.string().max(200).optional(), hint: z.string().max(400).optional(), locales: z.record(z.string().max(20), z.strictObject({ title: z.string().max(400).optional(), alt: z.string().max(400).optional(), hint: z.string().max(400).optional() })).optional(), when: TabWhenView.optional() })).max(200).optional(),
  /** Plugin views that are tabs beside Chat / Storage (`where: "mainTab"`), for the main bot, project bots or any (plan W2). */
  // forRole "marked": only the bots in `bots` (the plugin's `ui.showTab`); chat "float": the bot's chat floats over the tab (as the Note tab's).
  mainTabs: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), icon: z.string().max(40).optional(), forRole: z.enum(["main", "project", "bots", "any", "marked"]),
    chat: z.literal("float").optional(), bots: z.array(z.string().max(100)).max(500).optional() })).max(50).optional(),
  /** Plugin views that are pages of Settings (`where: "settings.section"`): `after` names the core page it follows, `link` the sidebar popover's link that opens it. */
  settingsSections: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), terms: z.string().max(1_000), after: z.string().max(40).optional(), link: z.string().max(100).optional() })).max(20).optional(),
  /** Plugin views that are blocks in a bot's right panel overview, under its tasks (`where: "rightPanel.section"`), for the bots its `forRole` names. */
  rightPanelSections: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), forRole: z.enum(["main", "project", "bots", "any"]) })).max(20).optional(),
  /** Panels under the chat (`bottomPanel` views): one frame per bot, a toggle in the chat header; `toggle`: the plugin's command the page runs itself to show or hide it. */
  bottomPanels: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), toggle: PluginCommandId.optional() })).max(5).optional(),
  /** Plugin views that are buttons in the chat header, each opening a popover with its frame for the bot on screen (`where: "chatHeader"`). */
  chatHeaderViews: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(5).optional(),
  /**
   * Plugin views at the right end of the row above the input box (`where: "composerBar"`), for the bots its `forRole` names: a one-line frame
   * `width` px wide whose click opens a card above it with the frame again (`ccb.context.surface` "compact" / "expanded"). The page shows the first one.
   */
  composerBarViews: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), width: z.number().int().min(80).max(480), forRole: z.enum(["main", "project", "bots", "any"]) })).max(5).optional(),
  /** Pages that take the whole right panel's place for a bot while a plugin's program part has one open (`rightPanel.takeover` views, `ui.takeover`). */
  takeovers: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(5).optional(),
  /** The takeover open now (null: none): which view, for which bot, and whether it is wide. */
  takeover: z.strictObject({ plugin: PluginName, view: z.string().max(100), botId: z.string().max(100), wide: z.boolean() }).nullable().optional(),
  /** Plugin views that are blocks in the sidebar gear's popover (`where: "quickSettings"`). */
  quickSettings: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(10).optional(),
});
export type PluginsView = z.infer<typeof PluginsView>;

const PluginCodeHash = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_.-]+$/);
const BASE_COMMANDS = [
  z.strictObject({ type: z.literal("project.files"), botId, query: z.string().max(200) }),
  z.strictObject({ type: z.literal("project.preview"), botId, path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("boot.commit") }),
  /** Every bot, and (with `botId`) that bot's chat. Main bot when `botId` is left out. */
  z.strictObject({ type: z.literal("chat.snapshot"), botId: botId.optional() }),
  /**
   * A page of older lines (the snapshot holds only the newest, `ChatSnapshot.history`): those before the line `before`,
   * about `bytes` of them (default 1 MiB). With `until`, the page reaches back far enough to hold that line.
   */
  z.strictObject({ type: z.literal("chat.history"), botId, before: id, bytes: z.number().int().min(1024).max(8 * 1024 * 1024).optional(), until: id.optional() }),
  /** Read only the output of a stored background task (never a renderer-supplied path). */
  z.strictObject({ type: z.literal("task.output"), botId, messageId: id, taskId: z.string().min(1).max(200) }),
  /** A message; while a reply is being written it joins or follows that turn (as 1.x steers). `replyTo`: a line it answers. */
  /**
   * Your words and the files waiting in the input box (either may be empty, not both). `files`: Botling 3 only (M2 step
   * 12, protocol v1 §9A.9): files a phone or browser page uploaded to the server by their hash (`content.put`); the
   * server holds the command until their bytes are in. The 2.x core refuses a `chat.send` that carries them.
   */
  z.strictObject({ type: z.literal("chat.send"), botId, text: z.string().max(MESSAGE_TEXT_LIMIT), replyTo: id.optional(), to: AnswerTarget.optional(), files: z.array(UploadedFile).min(1).max(50).optional() }),
  /** Main only: the + button's file picker (main's dialog); what you pick waits in the input box. */
  z.strictObject({ type: z.literal("files.pick"), botId }),
  /** Main only (from its dialog): files to wait in the input box. Never from a page: a page names no paths. */
  z.strictObject({ type: z.literal("files.add"), botId, paths: z.array(z.string().min(1).max(4_096)).min(1).max(50) }),
  /** A pasted or dropped file, read by the page (`addFileData`). */
  z.strictObject({ type: z.literal("files.data"), botId, name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) }),
  z.strictObject({ type: z.literal("files.remove"), botId, id }),
  /** Main only: a file the chat shows (an attachment of one of the bot's lines, or one waiting: `pending:<id>`). */
  z.strictObject({ type: z.literal("attachment.file"), botId, ref: z.string().min(1).max(5_000), line: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional() }),
  /** One head or two (Claude, Codex). Leaving out the head it runs on runs it on the other, through a handoff (Phase 5c). */
  z.strictObject({ type: z.literal("heads.set"), botId, engines: z.array(Engine).min(1).max(3) }),
  /** Who new messages go to (the composer's Both / Claude / Codex). */
  z.strictObject({ type: z.literal("heads.answerWith"), botId, to: AnswerTarget }),
  /** Stops one hand-off's chain. */
  z.strictObject({ type: z.literal("handoff.stop"), botId, handoffId: id }),
  /** "Stop now" on the rounds line: no more hand-offs for the latest message. */
  z.strictObject({ type: z.literal("rounds.stop"), botId }),
  /** Picks a button on a question (a tool approval): the core decides what it means from its action. `text`: notes with the pick. */
  z.strictObject({ type: z.literal("chat.choose"), botId, messageId: id, index: z.number().int().nonnegative().max(19), text: z.string().max(MESSAGE_TEXT_LIMIT).optional() }),
  /** Answers a bot's question in the user's own words instead of a button. */
  /** `images`: pictures a component sent with its answer (`{text, images}`), as `{name, base64}`; they go along as attachments. */
  /** `picks`: a question group's answers, one per question in order; the app writes the bot's message from them (`text` is then ignored). */
  z.strictObject({ type: z.literal("chat.answer"), botId, messageId: id, text: z.string().max(MESSAGE_TEXT_LIMIT), images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10).optional(),
    picks: z.array(z.strictObject({ options: z.array(z.number().int().nonnegative().max(5)).max(6), other: z.string().max(1_000).optional(), skipped: z.boolean().optional(),
      notes: z.record(z.string().regex(/^[0-5]$/), z.string().max(1_000)).optional() })).min(1).max(5).optional() }),
  /** Explicitly dismiss a question as a notification; never dispatches an answer. */
  z.strictObject({ type: z.literal("chat.ignoreQuestion"), botId, messageId: id }),
  /** The user's own reaction on a line (one of 👍 ❤️ 😂 🎉 🤔 👀). */
  z.strictObject({ type: z.literal("chat.react"), botId, messageId: id, emoji: z.string().min(1).max(16), present: z.boolean() }),
  /** A subagent's own conversation (the Agent call's id). */
  z.strictObject({ type: z.literal("subagent.view"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** Settles a subagent's row out of the left column into the right panel's "Settled" (false: back). It keeps working. */
  z.strictObject({ type: z.literal("subagent.settle"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), settled: z.boolean() }),
  /** "Move to…" (agentMoves): the bots an agent shown in `botId`'s rows can go to. */
  z.strictObject({ type: z.literal("agent.targets"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** Moves an agent's ownership (it keeps running where it is), or hands a Claude subagent's work to a new sub bot. */
  z.strictObject({ type: z.literal("agent.move"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), to: AgentMoveTo, notifyAgent: z.boolean().optional() }),
  /** The owner's follow-up for an agent shown in its rows (an app-managed worker of any engine): joined into its run, its next run, or sent after its run. */
  z.strictObject({ type: z.literal("agent.message"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), text: z.string().min(1).max(64_000) }),
  /** The owner stops one agent shown in its rows (no report is made). */
  z.strictObject({ type: z.literal("agent.stop"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** "New sub bot with these…": several agents shown in `botId`'s rows move to one new sub bot together (all or none). */
  z.strictObject({ type: z.literal("agent.group"), botId, subagentIds: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)).min(1).max(20), name: z.string().min(1).max(400), note: z.string().max(4_000).optional() }),
  /** Closes a sub bot: the agents it owns go back to their host (or are stopped when that is gone), then it is removed. */
  z.strictObject({ type: z.literal("subbot.close"), botId }),
  /** "New bot": a bot of its own with a name and a job; it sets up its own routines (`createBot`, setUp). */
  z.strictObject({ type: z.literal("bots.create"), name: z.string().min(1).max(400), job: z.string().min(1).max(4_000) }),
  /** Removes a bot of its own or a project from the left column and stops it. Its folders stay on disk. */
  z.strictObject({ type: z.literal("bots.remove"), botId }),
  /** The links handed over in a bot's chat, newest first (the right panel's Results). */
  z.strictObject({ type: z.literal("results.list"), botId }),
  /** Main only: opens one of a bot's results (a web link in the browser, a local page with its app). */
  /** Main only: the folder a worker runs in (its host bot's session folder), for the relative paths in its "Files changed". */
  z.strictObject({ type: z.literal("worker.cwd"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  z.strictObject({ type: z.literal("worker.file"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("result.open"), botId, url: z.string().min(1).max(4_000) }),
  /** The Storage tab (檔案庫): the bot's own files (its artifacts folder) and the files dragged in (references only). */
  z.strictObject({ type: z.literal("storage.list"), botId }),
  /**
   * Remembers files for a bot's Storage, by path (dropped from Finder) or by a link the chat handed over (a file: URL or
   * a chat attachment). Main checks each is a file and passes the paths on; nothing is copied.
   */
  z.strictObject({ type: z.literal("storage.add"), botId, paths: z.array(z.string().min(1).max(4_096)).max(50).default([]), urls: z.array(z.string().min(1).max(4_096)).max(50).default([]) }),
  /** Main only: its file picker, then `storage.add`. */
  z.strictObject({ type: z.literal("storage.pick"), botId }),
  /** Forgets a dragged-in file (`r:…`); the original is never touched. A bot's own file is not removed here. */
  z.strictObject({ type: z.literal("storage.remove"), botId, id: z.string().min(1).max(4_200) }),
  /** Main only: opens one of the list's files (a page or Markdown in the app's report preview, anything else with its app; `reveal`: in Finder). */
  z.strictObject({ type: z.literal("storage.open"), botId, id: z.string().min(1).max(4_200), reveal: z.boolean().optional() }),
  /** Main only: a row's drag began; main starts an OS file drag of that file, so a web page in the Browser pane gets it as an upload. */
  z.strictObject({ type: z.literal("storage.drag"), botId, id: z.string().min(1).max(4_200) }),
  /** A local file a line of this chat links or shows, dragged out of the chat: main starts an OS file drag of it. */
  z.strictObject({ type: z.literal("link.drag"), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("link.open"), /** Open a web page in the default browser, not the app's browser pane (⌘-click, the lightbox's button). */ external: z.boolean().optional(), cardImage: z.string().regex(/^[0-9a-f]{40}$/).optional(), preview: z.boolean().optional(), reveal: z.boolean().optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), source: z.enum(["user", "component"]).default("component"), botId, url: z.string().min(1).max(4_000) }),
  /** Core-only membership lookup: no chat payload or component rendering. */
  z.strictObject({ type: z.literal("link.authorize"), cardImage: z.string().regex(/^[0-9a-f]{40}$/).optional(), source:z.enum(["user","component"]).optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("chat.read"), botId }),
  /**
   * Main window only: the chat on screen now (null: none) and which of its views — its chat, the Storage tab, a plugin's
   * main tab (`tab`: "<plugin>/<view id>") or a subagent's run. Plugins read it with `workspace.current`.
   */
  z.strictObject({ type: z.literal("chat.shown"), botId: botId.nullable(), view: z.enum(["chat", "storage", "tab", "subagent"]), tab: z.string().min(1).max(400).nullable() }),
  z.strictObject({ type: z.literal("turn.stop"), botId, turnId: id }),
  /** Resolves when the turn ends. Cancelling the request stops the wait, never the turn. */
  z.strictObject({ type: z.literal("turn.await"), botId, turnId: id }),
  /** The bot's routines (routines.cron and scheduled-routines.json), and why they cannot be read, if so. */
  z.strictObject({ type: z.literal("routines.list"), botId }),
  /** Creates (once with `at`, recurring with `cron` in `timezone`), pauses, resumes or cancels one (`app_routines`' operations). */
  z.strictObject({
    type: z.literal("routines.change"), botId, operation: z.enum(["create", "pause", "resume", "cancel"]),
    id: z.string().min(1).max(2_200).optional(), kind: z.enum(["once", "recurring", "watch"]).optional(), task: z.string().min(1).max(2_000).optional(),
    at: z.string().max(64).optional(), cron: z.string().max(200).optional(), timezone: z.string().max(100).optional(), requestId: id.optional(),
    /** kind "watch": the shell command the app runs on the schedule (the bot is woken only when it fails). */
    command: z.string().min(1).max(2_000).optional(),
  }),
  /**
   * A component card's command: run (with the command and folder it showed), again (↻), or by its own timer (`live`).
   * It never allows anything: one not allowed yet answers `needsApproval`, and only the app page's ApprovalSheet sends `component.approve`.
   */
  z.strictObject({
    type: z.literal("component.command"), botId, messageId: id, index: z.number().int().nonnegative().max(19),
    command: z.string().max(20_000), folder: z.string().max(4_000), detail: z.string().max(20_000).optional(),
    force: z.boolean().optional(), live: z.boolean().optional(),
  }),
  /** "Allow and run" on the app page's ApprovalSheet (never from the chat page): the command, folder and Detail command the sheet showed. */
  z.strictObject({
    type: z.literal("component.approve"), botId, messageId: id, index: z.number().int().nonnegative().max(19),
    command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), detail: z.string().max(20_000).optional(),
  }),
  /** A component's `ccb.runDetail(values)`: its about.md's Detail command, only once allowed in `folder`. `card`+`command`: `{save: true}`. */
  z.strictObject({
    type: z.literal("component.detail"), botId, name: z.string().min(1).max(200), folder: z.string().max(4_000),
    values: z.record(z.string().max(64), z.union([z.string().max(1_000), z.number()])), card: z.string().max(200).optional(), command: z.string().max(20_000).optional(),
  }),
  /** A component's `ccb.save(data)` in a chat line: kept in that line. */
  z.strictObject({ type: z.literal("component.save"), botId, messageId: id, index: z.number().int().nonnegative().max(19), data: z.string().max(CARD_SAVE_LIMIT) }),
  /**
   * A component card's ⋯ menu (Phase 5a): "Report a problem…" (`problem`, 1.x's `reportComponentProblem`) or
   * a change asked of Maintainer, with pictures pasted on the box. Main takes the screenshot of `rect` (in
   * the app page's coordinates) and adds it as `screenshot` (base64 PNG) before the core gets it.
   */
  z.strictObject({ type: z.literal("component.report"), botId, name: z.string().min(1).max(200), text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    problem: z.boolean(), pinId: id.optional(), screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** The models the local Codex offers (`model/list`, 1.x's `CodexModels`), for the Codex model menu. */
  z.strictObject({ type: z.literal("codex.models") }),
  z.strictObject({ type: z.literal("engine.models"), botId, engine: z.enum(["claude", "codex", "agy"]) }),
  /**
   * "Not right" on a reply, in developer mode (1.x's `reportFeedback`): your words and pictures go to the
   * developer project with the chat around it. Main adds the chat frame as you saw it (`rect`, app page coordinates).
   */
  z.strictObject({ type: z.literal("chat.feedback"), botId, messageId: id, text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** Puts back a component's version from before its last change (git; 1.x's `revert`). */
  z.strictObject({ type: z.literal("component.revert"), name: z.string().min(1).max(200) }),
  /** Main only: a component page for a sandboxed frame, served from botling-card://page/<token>. `panel`: a plugin panel (its web part loads as a module). */
  z.strictObject({ type: z.literal("card.page"), html: z.string().max(4_000_000), panel: z.boolean().optional() }),
  /** The plugin library: every plugin, what is broken, and the plugin host. */
  z.strictObject({ type: z.literal("plugins.list") }),
  /** Turns a plugin on or off (on again gives a broken one another try). */
  z.strictObject({ type: z.literal("plugins.enable"), name: PluginName, enabled: z.boolean() }),
  /** The public catalog's view (Explore, Updates); `refresh`: fetch index.json again first. */
  z.strictObject({ type: z.literal("plugins.store"), refresh: z.boolean().optional() }),
  /** Install or update one catalog plugin: downloaded, checked, then asked on the install card in the main bot's chat. */
  z.strictObject({ type: z.literal("plugins.storeInstall"), name: PluginName }),
  /** The page showed how an install ended: its note goes. */
  z.strictObject({ type: z.literal("plugins.storeDismiss"), name: PluginName }),
  /** Puts back the version an install or update replaced. */
  z.strictObject({ type: z.literal("plugins.revert"), name: PluginName }),
  /** Deletes a plugin installed from outside (its data folder stays). */
  z.strictObject({ type: z.literal("plugins.remove"), name: PluginName }),
  /** A plugin's setting (not a secret). */
  z.strictObject({ type: z.literal("plugins.setting"), name: PluginName, key: SettingKey, value: SettingValue }),
  /** A plugin's secret setting: sealed in the core, never sent back (null or "": taken out). */
  z.strictObject({ type: z.literal("plugins.secret"), name: PluginName, key: SettingKey, value: z.string().max(10_000).nullable() }),
  /**
   * Runs a command a plugin's program part registered. `from` says who asks when it is not the app page
   * itself: a plugin's frame (only its own plugin's commands; `name` is the plugin the page bound the frame
   * to) or the chat page (only commands of plugins whose web part runs there).
   */
  z.strictObject({ type: z.literal("plugins.command"), id: PluginCommandId, from: PluginCaller.optional(), name: PluginName.optional(), args: z.array(z.string().max(200)).max(4).optional() }),
  /**
   * A plugin's button beside a link in a chat message (menu "chat/link"): its command, run with that bot, message and link. The core
   * runs it only when the link is in that message and the entry's `when` matches it.
   */
  z.strictObject({ type: z.literal("plugins.linkCommand"), id: PluginCommandId, botId: BotId, messageId: z.string().min(1).max(200), url: z.string().min(1).max(8_000) }),
  /** A plugin's button in the browser pane's toolbar (menu "browser/tab"): its command, run with that bot's tab on screen. */
  z.strictObject({ type: z.literal("plugins.tabCommand"), id: PluginCommandId, botId: BotId, tabId: z.string().min(1).max(200), url: z.string().min(1).max(8_000) }),
  /** A plugin panel's web part (module text) and its settings, for its sandboxed frame. */
  z.strictObject({ type: z.literal("plugins.panel"), name: PluginName, panel: z.string().min(1).max(100) }),
  /**
   * A frame's or the chat page's `ccb.call(method, params)` to its own plugin's program part: only a
   * method that plugin exposed (`ui.expose`). For a frame the plugin is the one the page bound it to.
   */
  z.strictObject({ type: z.literal("plugins.call"), name: PluginName, method: z.string().min(1).max(200), params: z.unknown(), from: PluginCaller }),
  /**
   * Botling 3 only (N2): the result the owner kept for a slot of this front end whose result did not fit its
   * `cmd.applied` entry (the outcome carried a `resultKept` marker). A read, sent as a req on the local socket by the
   * window's main process, never by the renderer; the server answers it itself (session-core), the core never sees it.
   */
  z.strictObject({
    type: z.literal("slot.result"),
    slot: z.strictObject({ origin: z.string().min(1).max(200), originEpoch: z.string().regex(/^[0-9a-f]{32}$/), target: z.string().min(1).max(300), n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  }),
  /**
   * A plugin frame's `ccb.requestApproval` (plugin-extraction.md W4), from the app page that bound the frame to `name`:
   * what its ApprovalSheet shows for a bot's command in that bot's folder (null: allowed already). It allows nothing.
   */
  z.strictObject({ type: z.literal("plugins.approvalAsk"), name: PluginName, botId: PluginBotId, command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), card: z.string().min(1).max(200).optional(), component: z.string().min(1).max(200).optional(), detail: z.string().min(1).max(20_000).optional(), from: PluginCaller.optional() }),
  /** "Allow and run" on the app page's ApprovalSheet for a plugin frame's ask: the command and folder the sheet showed. No frame can send it. */
  z.strictObject({ type: z.literal("plugins.approve"), name: PluginName, botId: PluginBotId, command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), component: z.string().min(1).max(200).optional(), detail: z.string().max(20_000).nullable().optional() }),
  /**
   * A plugin frame's `ccb.snapshot` (the Note tab's "freeze to image"): `rect` is in the app page's coordinates, already kept
   * inside that frame by the page. Main takes the picture and adds it as `picture` before the core gets it; the core keeps it
   * in the bot's note-assets folder (the plugin needs "files").
   */
  z.strictObject({ type: z.literal("plugins.noteSnapshot"), name: PluginName, botId: PluginBotId,
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }),
    picture: z.strictObject({ base64: z.string().min(1).max(FILE_DATA_LIMIT), name: z.string().min(1).max(40) }).optional() }),
  /**
   * A plugin frame's `ccb.openLink` (the Note tab's links): main asks the core what `href` names (`plugins.linkTarget`) and opens it
   * as a chat link: a web link in the default browser, a Markdown file in the app's report preview (`previewURL`, shown by the page),
   * any other file with its app (a page, picture, video, document) or in Finder. No prompt; never run.
   */
  z.strictObject({ type: z.literal("plugins.openLink"), name: PluginName, botId: PluginBotId, href: z.string().min(1).max(4_000) }),
  /** What `href` of a bot's note names for a plugin (core only, plugin-link.ts): asked by main for `plugins.openLink`. No page may send it. */
  z.strictObject({ type: z.literal("plugins.linkTarget"), name: PluginName, botId: PluginBotId, href: z.string().min(1).max(4_000) }),
  /** The pictures a plugin frame's tile data names, as card-page URLs: the app page puts them into the tile's page (`ccb.tile`). */
  z.strictObject({ type: z.literal("plugins.tileImages"), name: PluginName, botId: PluginBotId, data: z.string().max(300_000) }),
  /** The app's settings (settings.json), with every default filled in. */
  z.strictObject({ type: z.literal("settings.get") }),
  z.strictObject({ type: z.literal("agy.runtime.check") }),
  z.strictObject({ type: z.literal("agy.runtime.install") }),
  z.strictObject({ type: z.literal("settings.set"), change: SettingsChange }),
  /** Main: look at GitHub Releases (`manual`: now, even when the check is off or was done lately). */
  z.strictObject({ type: z.literal("updates.check"), manual: z.boolean() }),
  /** What the bots used today and before, and the subscriptions' limits (Settings → Usage).
   * localOnly skips quota refresh and includes normalized per-name token buckets for Token Flow. */
  z.strictObject({ type: z.literal("usage.view"), localOnly: z.boolean().optional() }),
  z.strictObject({ type: z.literal("doctor.view") }),
  z.strictObject({ type: z.literal("doctor.copy"), tool: z.enum(["claude", "codex"]) }),
  z.strictObject({ type: z.literal("doctor.run"), includeLatest: z.boolean() }),
  /** Main: open the newer release's page in the browser (only a release page of the app's own repository). */
  z.strictObject({ type: z.literal("updates.open") }),
  z.strictObject({ type: z.literal("updates.stage") }),
  z.strictObject({ type: z.literal("updates.restart") }),
  /** Main: reload this window's native chat page in place (new chat assets/preload; state comes back from the core). */
  z.strictObject({ type: z.literal("chat.reloadPage") }),
  /** A bot's own choices (bot.json). */
  z.strictObject({ type: z.literal("bot.settings"), botId }),
  /** The phone connection: its routes and paired phones; a one-time pairing link for the bots named; ending one phone's session. */
  z.strictObject({ type: z.literal("mobile.view") }),
  /** `botIds` omitted: the phone may use every bot, including bots added later. */
  z.strictObject({ type: z.literal("mobile.pair"), botIds: z.array(botId).min(1).max(50).optional(), route: z.number().int().min(0).max(5).optional(), relay: z.boolean().optional() }),
  z.strictObject({ type: z.literal("mobile.revoke"), deviceId: z.string().max(64) }),
  /** Turns the phone relay on (its wss:// address) or off (null). */
  z.strictObject({ type: z.literal("mobile.relay"), url: z.string().max(300).nullable() }),
  /** Botling 3 only: the first pairing's cluster (no code: make it at once and return its recovery code, shown once; a code: the older type-back, now only told the cluster exists). */
  z.strictObject({ type: z.literal("mobile.cluster"), code: z.string().max(64).optional() }),
  /** Botling 3 only: the person compared the phone's 6-digit code with the window's (accept adds the phone). An accept
   * names the code it was shown: a different phone that took the offer since (a new code) is not added. */
  z.strictObject({ type: z.literal("mobile.confirm"), offer: z.string().min(1).max(64), accept: z.boolean(), code: z.string().regex(/^[0-9]{6}$/).optional() }),
  /** Settings › Machines: the list; ~/.ssh/config's hosts; add an ssh host (its key is read, to approve next); a relay
   * install line (a one-time secret); approve (ssh: its key; relay: the code it shows); decline; revoke; remove; check. */
  z.strictObject({ type: z.literal("machines.view") }),
  z.strictObject({ type: z.literal("machines.hosts") }),
  z.strictObject({ type: z.literal("machines.add"), host: z.string().min(1).max(255), name: z.string().max(64).optional() }),
  z.strictObject({ type: z.literal("machines.pair") }),
  z.strictObject({ type: z.literal("machines.approve"), id: z.string().min(1).max(64), code: z.string().max(40).optional() }),
  z.strictObject({ type: z.literal("machines.decline"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.revoke"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.remove"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.check"), id: z.string().min(1).max(64) }),
  /** "Restart bot": each head starts again in the same session before the bot's next message, told the app's current instructions (asleep: the next wake). */
  z.strictObject({ type: z.literal("bot.restart"), botId }),
  /** Changes a bot's model, effort, subagents' model or Codex model (null: the default); a running head keeps its own until it next wakes. */
  z.strictObject({
    type: z.literal("bot.configure"), botId, model: ModelId.nullable().optional(), effort: Effort.nullable().optional(),
    subagentModel: ModelId.nullable().optional(), subagentEffort: Effort.nullable().optional(), codexModel: ModelId.nullable().optional(), agyModel: ModelId.nullable().optional(),
    /** Its Antigravity workers' model and effort (null: the same as its Antigravity head). */
    agyWorkerModel: ModelId.nullable().optional(), agyWorkerEffort: Effort.nullable().optional(),
    /** Where its Claude workers run when app_handoff names no machine (a machine's name; null: here). */
    workerMachine: z.string().max(64).nullable().optional(),
    /** Its Codex workers' model, effort and Fast mode (null: ~/.codex/config.toml's); used from a Codex head's next wake. */
    codexWorkers: z.strictObject({ model: ModelId.nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }).nullable().optional(),
    /** The bot's own primary engine (null: follow the app's default). */
    primary: Engine.nullable().optional(),
    /** An engine's own effort (null: back to the old single effort, else the engine's default); only the keys given change. */
    efforts: z.strictObject({ claude: Effort.nullable().optional(), codex: Effort.nullable().optional(), agy: Effort.nullable().optional() }).optional(),
  }),
  /** Settings → Engines and models → "Apply to all bots": every bot's engines, models, effort and primary become the app's defaults. Needs `confirmed: true`, as the UI asks first. */
  z.strictObject({ type: z.literal("engineDefaults.applyAll"), confirmed: z.literal(true) }),
  /** Main only: "Add project…" (main's folder picker), then `projects.add`; the new bot is selected. */
  z.strictObject({ type: z.literal("projects.pick") }),
  /** Main only (from its picker): a folder becomes a project with a manager (one that is already a project: that one). */
  z.strictObject({ type: z.literal("projects.add"), folder: z.string().min(1).max(4_096) }),
  /** What waits on you across the bots (the main bot's right panel). */
  z.strictObject({ type: z.literal("waiting.list") }),
  /** Takes one off that list without answering it. */
  z.strictObject({ type: z.literal("waiting.ignore"), botId, text: z.string().min(1).max(400) }),
  /** Every enabled plugin's web part, for the chat page. */
  z.strictObject({ type: z.literal("plugins.web") }),
  /** The chat page loaded a plugin's web part (kept as the one to fall back to). */
  z.strictObject({ type: z.literal("plugins.loaded"), name: PluginName }),
  /** A plugin's web part threw in the chat page: off until its files change (1.x's `markFailed`). */
  z.strictObject({ type: z.literal("plugins.failed"), name: PluginName, message: z.string().max(4_000) }),
  /** A web part's `ccb.notify(text)`: a line in the main bot's chat. */
  z.strictObject({ type: z.literal("plugins.notice"), name: PluginName, text: z.string().min(1).max(4_000) }),
  /** Main only: one of a plugin's web files (a stylesheet it declares, or a font or picture beside one). */
  z.strictObject({ type: z.literal("plugins.file"), name: PluginName, path: z.string().min(1).max(1_000) }),
  /** Main only: the picture a component's data named, by its token. */
  z.strictObject({ type: z.literal("card.image"), token: z.string().regex(/^[0-9a-f]{40}$/) }),
] as const;
type BaseCommandType = (typeof BASE_COMMANDS)[number]["shape"]["type"]["value"];
const BASE_COMMAND_TYPES = BASE_COMMANDS.map((schema) => schema.shape.type.value) as [BaseCommandType, ...BaseCommandType[]];
/** Every contract command name; used to bound `plugin.grant.requests` (§11.7). */
export const CommandTypeEnum = z.enum([...BASE_COMMAND_TYPES, "plugin.grant"]);

/** A call-in's transcript slice is at most 64 KiB of UTF-8 (the host cuts the oldest lines first, M5-02c). */
const CALLIN_TRANSCRIPT_BYTES = 64 * 1024;
const CALLIN_REPLY_BYTES = 200 * 1024;
/** UTF-8 bytes of `text` as it travels in a frame (JSON-escaped, quotes not counted), so a valid call-in always fits FRAME_LIMIT. */
const wireBytes = (text: string): number => new TextEncoder().encode(JSON.stringify(text)).length - 2;
/**
 * Cross-server call-ins (Q-C1, D51, protocol v1 §15): slots whose origin is a server, never a device or the window
 * (`COMMAND_SCOPES` scope `server`). They sit outside `BASE_COMMANDS` so `plugin.grant.requests` cannot name them: a plugin is
 * never given a server-only command. No `picks` in 3.0 (the guest's cards stay in the guest's chat).
 */
const CALLIN_COMMANDS = [
  /** Host server A asks the guest's owner B to run `botId`'s turn: the host chat's transcript slice and what was asked. */
  z.strictObject({
    type: z.literal("callin.ask"),
    botId,
    callId: id,
    host: z.strictObject({ server: z.string().min(1).max(200), botId, name: z.string().min(1).max(200) }),
    transcript: z.string().max(CALLIN_TRANSCRIPT_BYTES).refine((text) => wireBytes(text) <= CALLIN_TRANSCRIPT_BYTES, "transcript is over 64 KiB"),
    asked: z.string().max(4_000),
    by: z.enum(["user", "bot"]),
    depth: z.number().int().min(1).max(2),
  }),
  /** The guest's owner B answers the host bot `botId` on server A: the reply, or why there is none (applied once by the slot). */
  z.strictObject({
    type: z.literal("callin.reply"),
    botId,
    callId: id,
    guest: z.strictObject({ botId, name: z.string().min(1).max(200) }),
    outcome: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("reply"), text: z.string().max(CALLIN_REPLY_BYTES).refine((text) => wireBytes(text) <= CALLIN_REPLY_BYTES, "reply text is over 200 KiB"), engine: Engine }),
      z.strictObject({ kind: z.literal("failed"), why: z.string().max(1_000) }),
      z.strictObject({ kind: z.literal("busy") }),
    ]),
  }),
  /** The host gave up (D51): B skips the call-in if it has not started, and stops the guest turn if it has. */
  z.strictObject({ type: z.literal("callin.cancel"), botId, callId: id }),
] as const;

export const Command = z.discriminatedUnion("type", [
  ...BASE_COMMANDS,
  /** Raises, lowers, or revokes (`tier: "none"`) one plugin grant at one code hash on the target server (D54, §11.7). */
  z.strictObject({
    type: z.literal("plugin.grant"),
    plugin: PluginName,
    codeHash: PluginCodeHash,
    tier: z.enum(["none", "read", "request", "write"]),
    reads: z.array(z.string().min(1).max(200)).max(50),
    requests: z.array(CommandTypeEnum).max(100),
  }),
  ...CALLIN_COMMANDS,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

