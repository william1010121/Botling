// The request switch of the plugin host (M7-S75): what the plugin host process may ask of the core, one `case` per
// method, each checked first (the plugin it names must be loaded and may act for the host that asked; a capability
// needs the permission in the plugin's package.json). Moved out of `Plugins` in index.ts unchanged; `Plugins` keeps a
// one-line `requested` that calls `requested` here with itself as `this`.
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findConflict, legacyKey } from "../../contract/shortcuts";
import { commandSurfaces } from "./commands";
import { ofKind, type Contribution } from "./contributions";
import { title, type JSONValue } from "./manifest";
import { mustOwnNote } from "./plugin-owns";
import type { InstalledPlugin, PluginRegistry } from "./registry";
import type { SealedSecretStore } from "./secrets";
import { cleanFolder, type SessionFolder, type SessionFolders } from "./session-folders";
import { AppBriefingParams, AppCardParams, AppInstallParams, AppTellParams, installCommandOK, type AppWorld, type BriefingBook } from "./app-seam";
import { isStudioMethod, StudioParams, studioAnswer } from "./studio-seam";
import { agyUsageInProfiles, agyWorkerUsage } from "../agy-usage-db";
import { refreshAntigravityQuota } from "../antigravity-quota";
import { readNote, type NoteWatcher } from "../bot-note";
import { cellRuns, classifyLines, noteBranches, noteCards, noteRoutes, noteView, parseBranches } from "../note-format";
import { noteService } from "../note-tools";
import { importAssetBytes, importAssetFile, linkedFile, linkedPictures, localizeImages } from "../note-assets";
import type { MarkedTabs } from "./marked-tabs";
import type { MessageDecoration, PluginsOptions } from "./types";
import { str } from "./snapshot";
import type { PluginWorkers } from "../orchestration/plugin-workers";
import { SendParams, BotParams, NoteWriteParams, NoteAssetParams, NoteRefsParams, NoteLocalizeParams, NoteParseParams, NoteOutlineParams, NoteModeParams, NoteCardsParams, NoteRunParams, WakeParams, PickParams, InputParams, ViewParams, TakeoverParams, ShowTabParams, SettingParams, SecretGetParams, SecretSetParams, KeyParams, ApprovalParams, RunParams, ComponentParams, RoutineParams, CreateParams, PluginOnly, AgyUsageParams, AgyWorkerParams, RoutinesListParams, RoutinesChangeParams, CardsStates, CardsRun, CardsAsk, CardsNotes, ChatDataParams, CHAT_DATA_BYTES, TasksParams, HistoryParams, ResultsParams, IgnoreParams, FaceParams, ChatParams, DecorateParams, FolderParams, FoldersParams, EngineParams, ContentReadParams, ContentFetchParams, WorkerStartParams, WorkerSendParams, WorkerCancelParams, DECORATION_BYTES, BOT_INSTRUCTIONS_LIMIT, type PluginBotExtras } from "./request-params";

/** What `requested` uses of `Plugins` through `this` (the class implements it; its members are not `private` for that). */
export interface RequestHost {
  readonly options: PluginsOptions;
  readonly registry: PluginRegistry;
  readonly secrets: SealedSecretStore;
  readonly dataRoot: string;
  readonly folders: SessionFolders;
  readonly briefings: BriefingBook;
  readonly notes: NoteWatcher;
  readonly markedTabs: MarkedTabs;
  readonly decorated: Map<string, Map<string, MessageDecoration[]>>;
  readonly chatDatas: Map<string, Map<string, JSONValue>>;
  takeover: { plugin: string; view: string; botId: string; wide: boolean } | null;
  announce(): void;
  /** The fingerprint of the code a plugin's host runs now (undefined: not running). */
  codeOf(plugin: string): string | undefined;
  appPlugin(plugin: InstalledPlugin): AppWorld;
  asked<T extends z.ZodTypeAny>(schema: T, params: unknown, owner?: string): { plugin: InstalledPlugin; data: z.infer<T> };
  cardsAllowed(plugin: InstalledPlugin): void;
  contributions(): Contribution[];
  foldersChanged(botIds?: string[], reason?: { told: string; shown: string }): void;
  keybindings(): { command: string; key: string; source: "default" | "user" | "plugin" }[];
  loaded(name: unknown): InstalledPlugin | null;
  needs(plugin: InstalledPlugin, capability: string, what: string): void;
  noteAssetUrl(noteFile: string, ref: string): string | null;
  noteFile(botId: string): string;
  setSetting(name: string, key: string, value: boolean | number | string | null): void;
  shipped(name: string): boolean;
  /** The worker primitives' book (M7-O03a); throws when this world has no workers. */
  workers(): PluginWorkers;
  /** F6 (M7-O04): a plugin that is not shipped sent this bot a message. */
  heard(botId: string, plugin: string): void;
}

/**
 * `workers.start`, `workers.send`, `workers.cancel` (M7-O03a). Every check is in PluginWorkers (plugin-workers.ts) and runs before a
 * worker exists; nothing here starts anything. Not a `case` of `requested` (as the studio's methods are not): one place, its own rows.
 */
function workersRequest(host: RequestHost, method: string, params: unknown): Promise<unknown> {
  if (method === "workers.start") {
    const { plugin, data } = host.asked(WorkerStartParams, params);
    const { plugin: _name, ...rest } = data;
    return host.workers().start(plugin.manifest.name, rest);
  }
  if (method === "workers.send") {
    const { plugin, data } = host.asked(WorkerSendParams, params);
    return host.workers().send(plugin.manifest.name, data.taskId, data.message);
  }
  const { plugin, data } = host.asked(WorkerCancelParams, params);
  return host.workers().cancel(plugin.manifest.name, data.taskId);
}

export async function requested(this: RequestHost, method: string, params: unknown, owner?: string): Promise<unknown> {
  // M7-O04: a request names the code it was made by (`code`, the plugin's fingerprint). Older code a host still runs after a
  // swap is refused here, before any method sees it; the method's own params never carry the field.
  // A request for a plugin whose code is known must name it: one that does not is refused (fail closed, review).
  const named = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : null;
  const now = typeof named?.plugin === "string" ? this.codeOf(named.plugin) : undefined;
  if (named && Object.hasOwn(named, "code")) {
    const { code, ...rest } = named;
    if (now !== undefined && code !== now) throw new Error("This request came from older code of the plugin, which has been replaced. It was refused.");
    params = rest;
  } else if (now !== undefined) throw new Error("This request does not name the code of the plugin it came from. It was refused.");
  if (owner !== undefined) {
    const claimed = params && typeof params === "object" ? (params as { plugin?: unknown }).plugin : undefined;
    if (claimed !== undefined && claimed !== owner) throw new Error(`This host may only act for "${owner}".`);
  }
  const { world } = this.options;
  switch (method) {
    case "bots.list":
      return world.bots();
    case "bots.send": {
      const { plugin, data } = this.asked(SendParams, params);
      if (data.as === "user") this.needs(plugin, "bots", "Sending as the user");
      this.heard(data.bot, plugin.manifest.name);
      return world.send(data.bot, data.text, data.as === "user" ? null : title(plugin.manifest));
    }
    case "bots.wake": {
      const { plugin, data } = this.asked(WakeParams, params);
      // A bot wakes when it gets a message; a wake without one waits for the core to have that.
      if (data.prompt === undefined) throw new Error("bots.wake needs a prompt for now (a bot wakes when it gets a message).");
      this.heard(data.bot, plugin.manifest.name);
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
    case "notes.read": {
      const { plugin, data } = this.asked(BotParams, params);
      this.needs(plugin, "files", "Reading a bot's note");
      const file = this.noteFile(data.bot);
      // Through note.db (note-tools.ts): the plain note, without the ids note.md carries.
      const note = noteService().read(file, data.bot);
      this.notes.watch(data.bot, file, note.mtime);
      return note;
    }
    case "notes.write": {
      const { plugin, data } = this.asked(NoteWriteParams, params);
      this.needs(plugin, "files", "Changing a bot's note");
      mustOwnNote(plugin, "Changing a bot's note");
      const file = this.noteFile(data.bot);
      const result = noteService().write(file, data.text, data.base, data.bot);
      this.notes.watch(data.bot, file, result.mtime);
      return result;
    }
    case "notes.importAsset": {
      const { plugin, data } = this.asked(NoteAssetParams, params);
      this.needs(plugin, "files", "Adding a picture to a bot's note");
      mustOwnNote(plugin, "Adding a picture to a bot's note");
      const file = this.noteFile(data.bot);
      let ref: string;
      if ("path" in data) {
        // Only a picture the note itself links: never a general file read.
        const wanted = linkedFile(data.path);
        if (!wanted || !linkedPictures(readNote(file).text).includes(wanted)) throw new Error("Only a picture the note links can be copied into it.");
        ref = importAssetFile(file, wanted);
      } else {
        ref = importAssetBytes(file, Buffer.from(data.data, "base64"), data.name);
      }
      return { ref, url: this.noteAssetUrl(file, ref) };
    }
    case "notes.assetUrls": {
      const { plugin, data } = this.asked(NoteRefsParams, params);
      this.needs(plugin, "files", "Showing a bot's note's pictures");
      const file = this.noteFile(data.bot);
      return Object.fromEntries(data.refs.map((ref) => [ref, this.noteAssetUrl(file, ref)]));
    }
    case "notes.localizeImages": {
      const { plugin, data } = this.asked(NoteLocalizeParams, params);
      this.needs(plugin, "files", "Changing a bot's note");
      mustOwnNote(plugin, "Changing a bot's note");
      const file = this.noteFile(data.bot);
      const note = noteService().read(file, data.bot);
      if (data.base !== undefined && note.mtime !== data.base) {
        this.notes.watch(data.bot, file, note.mtime);
        return { saved: false, text: note.text, mtime: note.mtime, copied: [], missing: [], failed: [] };
      }
      const done = localizeImages(file, note.text);
      const result = done.copied.length ? noteService().write(file, done.text, note.mtime, data.bot) : { saved: true as const, mtime: note.mtime };
      this.notes.watch(data.bot, file, result.mtime);
      if (!result.saved) return { ...result, copied: [], missing: [], failed: [] };
      return { saved: true, text: done.text, mtime: result.mtime, copied: done.copied, missing: done.missing, failed: done.failed };
    }
    case "notes.parse": {
      // The note's branches and cards as the core reads them (note-format.ts), so the Note tab and the bots agree. Nothing is read or written.
      const { plugin, data } = this.asked(NoteParseParams, params);
      this.needs(plugin, "files", "Reading a bot's note");
      const branches = noteBranches(data.text);
      const cards = noteCards(data.text);
      // The Note tab's own cutting rules (note-cells.ts), so the editor can drop its copy: its cells and branches as it reads them.
      const lines = data.text.split("\n");
      const info = classifyLines(lines);
      const meta = parseBranches(lines, info);
      return {
        forks: branches.forks, cards: cards.cards, routes: noteRoutes(data.text),
        problems: [...branches.problems, ...cards.problems].sort((a, b) => a.line - b.line),
        ...(data.picks ? { view: noteView(data.text, data.picks) } : {}),
        cells: cellRuns(lines, info, meta).runs,
        branches: meta.forks.map((fork) => ({
          key: fork.key, name: fork.name, start: fork.start, endLine: fork.endLine, depth: fork.depth,
          parent: fork.parentPath.length ? { fork: fork.parentPath[fork.parentPath.length - 1]!.fork.key, route: fork.parentPath[fork.parentPath.length - 1]!.route.name } : null,
          routes: fork.routes.map(({ name, marker, start, end, implicit }) => ({ name, marker, start, end, implicit })),
        })),
        ...(data.lines ? { lines: info.map((at) => ("start" in at ? { kind: at.kind, start: at.start, end: at.end } : { kind: at.kind })) } : {}),
      };
    }
    case "notes.outline": {
      // The ids note.db gives the note's cells and forks, with their lines in the text the Note tab has (the 問 quote names a cell by id).
      const { plugin, data } = this.asked(NoteOutlineParams, params);
      this.needs(plugin, "files", "Reading a bot's note");
      return noteService().note(this.noteFile(data.bot), data.bot).outlineLines(data.text);
    }
    case "notes.mode": {
      // A note in note.db ("db") or a plain file ("file"); switching to file writes note.md without ids.
      const { plugin, data } = this.asked(NoteModeParams, params);
      this.needs(plugin, "files", data.mode ? "Changing a bot's note" : "Reading a bot's note");
      if (data.mode) mustOwnNote(plugin, "Changing a bot's note");
      const file = this.noteFile(data.bot);
      const answer = noteService().mode(file, data.mode, data.bot);
      if (data.mode) { try { this.notes.watch(data.bot, file, statSync(file).mtimeMs); } catch { /* gone */ } }
      return answer;
    }
    case "notes.components": {
      const { plugin, data } = this.asked(BotParams, params);
      this.needs(plugin, "files", "Listing a bot's components for its note");
      const answer = world.noteCards?.components(data.bot);
      if (!answer) throw new Error("No such bot.");
      return answer;
    }
    case "notes.cards": {
      const { plugin, data } = this.asked(NoteCardsParams, params);
      this.needs(plugin, "files", "Reading a bot's note");
      const text = data.text ?? noteService().read(this.noteFile(data.bot), data.bot).text;
      const cards = noteCards(text).cards;
      const states = world.noteCards?.states(data.bot, cards.map(({ key, name, command, data: json, refresh }) => ({ key, name, command, data: json, refresh })));
      if (!states) throw new Error("No such bot.");
      return states;
    }
    case "notes.runCard": {
      // Runs only a command the user allowed for this bot's folder; the frame asks with ccb.requestApproval({ botId, command, folder, card }).
      const { plugin, data } = this.asked(NoteRunParams, params);
      this.needs(plugin, "files", "Running a card in a bot's note");
      const text = data.text ?? noteService().read(this.noteFile(data.bot), data.bot).text;
      const card = noteCards(text).cards.find((candidate) => candidate.key === data.key);
      if (!card) throw new Error("No such card in the note.");
      const [state] = world.noteCards?.states(data.bot, [{ key: card.key, name: card.name, command: card.command, data: card.data, refresh: card.refresh }]) ?? [];
      if (!state) throw new Error("No such bot.");
      if (!state.command) return { started: false, needsApproval: null };
      const run = world.noteCards!.run(data.bot, card.key, state.command, data.force === true);
      if (!run) throw new Error("No such bot.");
      return { started: run.started, needsApproval: run.approved ? null : { command: state.command, folder: run.folder, card: card.name } };
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
    case "ui.showTab": {
      const { plugin, data } = this.asked(ShowTabParams, params);
      const name = plugin.manifest.name;
      const tab = plugin.manifest.ccb?.web ? ofKind(this.contributions(), "view").find((entry) => entry.plugin === name && entry.id === data.view && entry.where === "mainTab") : undefined;
      if (!tab) throw new Error(`Plugin "${name}" has no mainTab view "${data.view}".`);
      if (tab.forRole !== "marked") throw new Error(`The view "${data.view}" is not forRole "marked": it shows for its role's bots already.`);
      const botId = world.botId?.(data.bot) ?? null;
      if (!botId) throw new Error("No such bot.");
      if (this.markedTabs.set(name, data.view, botId, data.on)) this.announce();
      if (data.on && data.open) world.openTab?.(name, data.view, botId);
      return null;
    }
    case "ui.takeover": {
      const { plugin, data } = this.asked(TakeoverParams, params);
      const name = plugin.manifest.name;
      const before = JSON.stringify(this.takeover);
      if (data.view === null) {
        if (this.takeover?.plugin === name) this.takeover = null;
      } else {
        const declared = plugin.manifest.ccb?.web && ofKind(this.contributions(), "view").some((entry) => entry.plugin === name && entry.id === data.view && entry.where === "rightPanel.takeover");
        if (!declared) throw new Error(`Plugin "${name}" has no takeover view "${data.view}".`);
        const botId = data.bot === undefined ? null : world.botId?.(data.bot) ?? null;
        if (!botId) throw new Error("No such bot.");
        this.takeover = { plugin: name, view: data.view, botId, wide: data.wide === true };
      }
      if (JSON.stringify(this.takeover) !== before) this.announce();
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
      const plugin = parsed.success && (owner === undefined || parsed.data.plugin === owner) ? this.loaded(parsed.data.plugin) : null;
      if (!plugin?.manifest.ccb?.permissions?.includes("bots")) throw new Error("Creating bots needs the \"bots\" permission in package.json.");
      const raw = parsed.data as Record<string, unknown>;
      const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).slice(0, 4_000) : "");
      const more: PluginBotExtras = {};
      if (typeof raw.parent === "string" && raw.parent) more.parent = raw.parent.slice(0, 200);
      if (typeof raw.instructions === "string") {
        if (raw.instructions.length > BOT_INSTRUCTIONS_LIMIT) throw new Error(`A bot's instructions are at most ${BOT_INSTRUCTIONS_LIMIT} characters.`);
        more.instructions = raw.instructions;
      }
      if (raw.delegation !== undefined && raw.delegation !== null) {
        if (raw.delegation !== "default" && raw.delegation !== "onRequest") throw new Error('delegation is "default" or "onRequest".');
        more.delegation = raw.delegation;
      }
      return world.createBot(plugin.manifest.name, plugin.manifest.displayName ?? plugin.manifest.name, text("name"), text("job"), text("avatar") || undefined, more);
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
      // F6 (M7-O04, decided): a routine runs later as the bot's own prompt, with no card and no quota, so only a plugin shipped with Botling adds one.
      if (!this.shipped(parsed.data.plugin)) throw new Error("Only a plugin shipped with Botling may add a routine: a routine starts work later, with no card to ask you first.");
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
      if (!installCommandOK(data.command, state.dataDir, !!state.server)) throw new Error("That is not the install script of this Botling.");
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
    case "workspace.current":
      this.asked(PluginOnly, params);
      return world.workspace.current?.() ?? null;
    case "workspace.agyUsage":
      // agy's own record of an Antigravity conversation (its calls, retries and models); null: none here.
      return agyUsageInProfiles(this.options.dataDir, this.asked(AgyUsageParams, params).data.sessionId);
    case "workspace.agyWorkers":
      // The agy workers an agy head session started (the registry's), each with the conversation its usage is in.
      return world.workspace.agyWorkers?.(this.asked(AgyUsageParams, params).data.sessionId) ?? [];
    case "workspace.agyWorkerUsage":
      // A worker's usage by its folder (registry nativeId): found even when the registry never learned its session id.
      return agyWorkerUsage(this.options.dataDir, this.asked(AgyWorkerParams, params).data.workerId);
    case "workspace.agyQuota":
      this.asked(PluginOnly, params);
      return refreshAntigravityQuota(this.options.dataDir);
    case "workspace.face": {
      const { data } = this.asked(FaceParams, params);
      return world.workspace.face(data.bot, data.look);
    }
    case "content.read": {
      const { data } = this.asked(ContentReadParams, params);
      if (!world.content) throw new Error("Reading content needs Botling 3.");
      const bytes = await world.content.read(data.ref, data.offset, data.length);
      return { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") };
    }
    case "content.fetch": {
      const { plugin, data } = this.asked(ContentFetchParams, params);
      if (!world.content?.fetch) throw new Error("Fetching content needs Botling 3.");
      const path = await world.content.fetch(join(this.dataRoot, plugin.manifest.name), data.ref);
      return { path };
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
        ...(entry.fold?.length ? { fold: entry.fold } : entry.after ? { after: entry.after } : entry.under ? { under: entry.under } : {}),
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
    case "chat.setData": {
      // What a built-in plugin's web part draws a chat from (botling.board's pins), kept here and sent with the chat to every page.
      const { plugin, data } = this.asked(ChatDataParams, params);
      const name = plugin.manifest.name;
      this.cardsAllowed(plugin);
      const botId = world.botId?.(data.bot) ?? null;
      if (!botId) throw new Error("No such bot.");
      const value = (data.data ?? null) as JSONValue;
      const text = JSON.stringify(value);
      if (text.length > CHAT_DATA_BYTES) throw new Error("Too much for one chat's page (1 MB at most).");
      const byPlugin = this.chatDatas.get(botId) ?? new Map<string, JSONValue>();
      const before = byPlugin.has(name) ? JSON.stringify(byPlugin.get(name)) : undefined;
      if (value === null) byPlugin.delete(name); else byPlugin.set(name, value);
      if (byPlugin.size) this.chatDatas.set(botId, byPlugin); else this.chatDatas.delete(botId);
      if (text !== before && !(value === null && before === undefined)) world.dataChanged?.(botId, name, value);
      return null;
    }
    case "cards.library":
    case "cards.shown": {
      const { plugin, data } = this.asked(BotParams, params);
      this.cardsAllowed(plugin);
      const answer = method === "cards.library" ? world.cards?.library(data.bot) : world.cards?.shown(data.bot);
      if (answer === undefined) throw new Error("Cards are not available here.");
      return answer;
    }
    case "cards.states": {
      const { plugin, data } = this.asked(CardsStates, params);
      this.cardsAllowed(plugin);
      return world.cards?.states(data.bot, data.cards) ?? null;
    }
    case "cards.run": {
      const { plugin, data } = this.asked(CardsRun, params);
      this.cardsAllowed(plugin);
      return world.cards?.run(data.bot, data.card, data.command, data.force) ?? false;
    }
    case "cards.ask": {
      const { plugin, data } = this.asked(CardsAsk, params);
      this.cardsAllowed(plugin);
      return world.cards?.ask(data.bot, data.card, data.command, data.name) ?? null;
    }
    case "cards.setNotes": {
      const { plugin, data } = this.asked(CardsNotes, params);
      this.cardsAllowed(plugin);
      if (!world.cards?.setNotes(data.bot, data.notes)) throw new Error("No such bot.");
      return null;
    }
    case "cards.legacyPins": {
      const { plugin, data } = this.asked(BotParams, params);
      this.cardsAllowed(plugin);
      return world.cards?.legacyPins(data.bot) ?? null;
    }
    case "engines.cli": {
      const { data } = this.asked(EngineParams, params);
      return world.engineCli?.(data.engine) ?? null;
    }
    default: {
      if (method === "workers.start" || method === "workers.send" || method === "workers.cancel") return workersRequest(this, method, params);
      if (isStudioMethod(method)) {
        // The component studio's asks of the core: a plugin shipped with Botling, with the "studio" permission.
        const { plugin, data } = this.asked(StudioParams[method], params);
        this.needs(plugin, "studio", "Asking the component studio's seam");
        if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may use the studio seam.");
        if (!world.studio) throw new Error("There is no component studio here.");
        return studioAnswer(world.studio, method, data);
      }
      throw new Error(`Unknown method "${method.slice(0, 80)}".`);
    }
  }
}
