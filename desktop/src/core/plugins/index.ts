// Plugins in the core (Workspace.swift's plugin host part, `startPluginHost`, `connectPlugins`): the
// library (registry.ts), sealed secrets (secrets.ts) and the plugin host process (host-client.ts),
// and what the host may ask of the core. The host is untrusted: it is told only what a plugin needs
// (bots' names and roles, its own settings and secrets) and may ask only for the few things below,
// each checked here (a plugin it names must be loaded; creating bots, stopping them and talking to
// them as the user need the "bots" permission — a consistency check, not a sandbox: the host is one
// process). Everything else is refused. A plugin's message to a bot shows as sent by it unless it
// asked to send as the user (plugin-platform.md §5, N1). Any plugin may read the workspace (`workspace.*`,
// what the whiteboard shows: bots, memory, results, what waits on you); none may answer for you.
// Reading a chat (`chat.messages`) needs the "messages" permission; what a plugin draws among a chat's
// messages (`chat.decorate`, chat extension v2) is kept here per chat until it unloads, and its web part draws it.
//
// Web parts: since Phase 4a the chat page has an origin of its own (botling-chat://chat, no bridge,
// nothing shared with the app page but postMessage), so plugins' web parts run in it again as in 1.x:
// composer, markdown and component hooks, commands and `host.call`; their stylesheets are served by the
// chat origin (only files the manifest names, and fonts beside them). A plugin's panels still run its
// web part in a sandboxed frame (botling-card://page/…, opaque origin, no network). Since step M11 ccb-latex
// is a built-in plugin (registry.ts `builtIns`) and reaches the chat page by the same path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { PhaseMarks, PhaseTally } from "../phase-marks";
import { ContractError, type ApprovalAskView, type PluginsView, type WebPluginSpecView } from "../../contract";
import { setPluginTags, type PluginTag } from "../reply";
import { commandSurfaces } from "./commands";
import { tileView, viewSurfaces } from "./views";
import { MarkedTabs } from "./marked-tabs";
import { chatLinkAddress, tabMatches } from "../../browser-tab-menu";
import { fileURLToPath } from "node:url";
import { ofKind, type Contribution } from "./contributions";
import { PluginHostClient, DEFAULT_TIMING } from "./host-client";
import { folderHash } from "./catalog";
import { presentNameWarning, title, type JSONValue } from "./manifest";
import { PluginRegistry, type HostSpec, type InstalledPlugin } from "./registry";
import { SealedSecretStore } from "./secrets";
import { WORKSPACE_EVENT, type WorkspaceChange } from "../workspace";
import { PendingTags } from "./pending-tags";
import { SessionFolders, type SessionFolder } from "./session-folders";
import { BriefingBook, type AppWorld } from "./app-seam";
import type { StudioWorld } from "./studio-seam";
import { NoteWatcher } from "../bot-note";
import type { PluginLinkTarget } from "../plugin-link";

import * as hostEvents from "./host-events";
import { requested } from "./requests";
import { PluginWorkers } from "../orchestration/plugin-workers";
import { writeFileAtomic } from "../durable/atomic";
import { isRegularFile, type BotInfo, type LineContentRef, type MessageDecoration, type PluginStatusItem, type PluginsOptions, type SnapshotFile } from "./types";
import { materializeSnapshot, pruneSnapshots, readPluginSnapshot, SERVER_PART_HELD_NOTICE } from "./snapshot";
import type { PluginEventName } from "./request-params";
import type { StartedBy } from "../worker-core/started-by";

// Moved out in M7-S12; every name still comes from here.
export type { BotInfo, AppQuestion, AppAnswer, PluginStatusItem, PluginChat, MessageDecoration, EngineCli, SessionBot, NoteComponent, NoteComponents, NoteCardState, LineContentRef, PluginWorld, PluginsOptions } from "./types";
export { SERVER_PART_HELD_NOTICE } from "./snapshot";
export { BOT_INSTRUCTIONS_LIMIT, type PluginBotExtras, type PluginEventName } from "./request-params";

export class Plugins {
  readonly registry: PluginRegistry;
  readonly host: PluginHostClient;
  private readonly hosts = new Map<string, PluginHostClient>();
  private readonly hostMeta = new Map<string, { main: string; dir: string; fingerprint: string }>();
  /** The fingerprint of each plugin's code in the shared host, as last given to it (`codeOf`). */
  private sharedCode = new Map<string, string>();
  private readonly retiring = new Set<Promise<void>>();
  readonly secrets: SealedSecretStore;
  readonly dataRoot: string;
  private readonly snapshotRoot: string;
  private started = false;
  /** Enabled plugins whose program part is held back by mayRunServerPart. */
  heldBack = new Set<string>();
  /** Reply tags whose plugin was not loaded yet, kept until it is (pending-tags.ts). */
  readonly held: PendingTags;
  /** The folders built-in plugins assigned to bots' sessions (`sessions.folder`), kept on disk (session-folders.ts). */
  readonly folders: SessionFolders;
  /** The worker primitives' book (M7-O03a), made when first needed. */
  private workerBook: PluginWorkers | null = null;
  /** The developer briefing botling.dev pushed (app-seam.ts), kept on disk. */
  readonly briefings: BriefingBook;
  /** The notes plugins read or saved (`notes.*`), watched for changes on disk (`noteChanged`). */
  readonly notes = new NoteWatcher((botId, mtime) => this.event("noteChanged", { botId, mtime }));
  /** What each bot's session was last told about its folder (a signature of folder, extra folders and note; absent: its own). */
  private readonly foldersTold = new Map<string, string>();
  /** What each plugin shows in the status area (`ui.setStatus`), until it unloads. */
  readonly status = new Map<string, Map<string, PluginStatusItem>>();
  /** Some plugin listens for workspace changes, as the host last said (`workspace.onChange`). */
  watchingWorkspace = false;
  /** What each plugin draws in each chat (`chat.decorate`), by the core's bot id, until it unloads. */
  readonly decorated = new Map<string, Map<string, MessageDecoration[]>>();
  /** What each plugin keeps for each chat's page (`chat.setData`), by the core's bot id, until it unloads. */
  readonly chatDatas = new Map<string, Map<string, JSONValue>>();
  /** The `rightPanel.takeover` view open now (`ui.takeover`), by the core's bot id; at most one, gone when its plugin is. */
  takeover: { plugin: string; view: string; botId: string; wide: boolean } | null = null;
  /** The bots each plugin's `forRole: "marked"` tab shows for (`ui.showTab`), kept on disk. */
  readonly markedTabs: MarkedTabs;

  constructor(readonly options: PluginsOptions) {
    const { dataDir, world } = options;
    this.markedTabs = new MarkedTabs(dataDir);
    this.secrets = new SealedSecretStore(join(dataDir, "plugin-secrets.json"), options.sealer, options.boundSecrets ? { bound: true } : undefined);
    this.registry = new PluginRegistry(join(dataDir, "plugins"), join(dataDir, "plugins.json"), this.secrets, options.builtIns ?? null, options.builtIns ? join(dataDir, "builtin-overrides") : null);
    this.dataRoot = join(dataDir, "plugin-data");
    this.snapshotRoot = join(dataDir, "plugin-snapshots");
    this.held = new PendingTags(join(dataDir, "plugin-pending-tags.json"));
    this.folders = new SessionFolders(join(dataDir, "plugin-session-folders.json"));
    this.briefings = new BriefingBook(join(dataDir, "plugin-dev-briefing.json"));
    for (const botId of this.folders.plugins().flatMap((name) => this.folders.bots(name))) { const now = this.folderSignature(botId); if (now) this.foldersTold.set(botId, now); }
    this.host = this.createHostClient();
    this.registry.onNotice = (text) => world.notice(text);
    this.registry.onBroken = (plugin, problem) => world.broken(plugin, problem);
    this.registry.onNameWarning = (_plugin, warning) => world.log(warning); this.registry.onPushedNote = (text) => world.log(text);
    this.registry.onSkipped = (plugin, skipped) => world.log(`plugin ${plugin}: skipped ${skipped.length} contribution(s) this Botling does not know or cannot read (the rest loads): ${skipped.join("; ")}`);
    // The registry's first scan ran before this was set: say what it skipped too.
    for (const plugin of this.registry.plugins) if (plugin.skipped?.length) this.registry.onSkipped(plugin.manifest.name, plugin.skipped);
    for (const plugin of this.registry.plugins) { const warning = plugin.builtIn ? null : presentNameWarning(plugin.manifest.name); if (warning) this.registry.onNameWarning(plugin.manifest.name, warning); }
    this.registry.onUpdated = (plugin, from) => {
      world.notice(`Plugin "${title(plugin.manifest)}" updated: ${from} → ${plugin.manifest.version}`);
      // Maintainer is told too, with the real grant (a plugin's approval belongs to the plugin, so it carries over a new version).
      // A core with no grant rows (`pluginGrant` unset) and a plain built-in (always allowed, not Maintainer's concern) say nothing.
      const grant = this.options.pluginGrant?.(plugin.manifest.name) ?? null;
      if (grant !== null && (!plugin.builtIn || plugin.replacesBuiltIn)) {
        // A failed hand-over must not end the scan: the registry would not take the new version and say it again on every scan.
        try { world.updated?.(title(plugin.manifest), plugin.manifest.version, grant !== "none"); } catch (error) { world.log(`Maintainer was not told of ${plugin.manifest.name}'s update: ${(error as Error).message}`); }
      }
    };
    this.registry.onPluginWritten = (name) => world.pluginWritten?.(name);
    this.registry.onChanged = () => this.sync();
    setPluginTags([...this.replyTagOwners().keys()]);
  }

  /** Opens the sealed secrets, then starts the host for the plugins that are on. */
  async start() {
    const marks = new PhaseMarks(this.options.phaseLog, "plugins.start", undefined, 100);
    await this.secrets.load();
    marks.lap("sealed secrets load");
    this.started = true;
    this.sync();
    marks.lap("sync (snapshots, host start)");
  }

  /**
   * Botling 3 (M5-14d, M5-18a): a `plugin:` row changed (a grant, or the running hash). Which program parts may run is
   * decided again, and the list is announced once (the world drops one that reads the same).
   */
  rowsChanged() {
    if (this.started) this.sync();
    else this.announce();
  }

  /** D74 (M6-06): re-opens sealed secrets once a window sealer attaches, then reloads the host with them. */
  async reloadSecrets() {
    this.secrets.problem = null;
    await this.secrets.load();
    this.sync();
  }

  /** A plugin's title as the user reads it (its name when it is not installed). */
  titleOf(name: string): string {
    const plugin = this.registry.plugins.find((candidate) => candidate.manifest.name === name);
    return plugin ? title(plugin.manifest) : name;
  }

  /** The library is looked at again (the core's 1.5 s clock). */
  scan() {
    this.registry.rescan();
  }

  private createHostClient(owner?: string): PluginHostClient {
    const { options } = this;
    const client = new PluginHostClient(
      options.hostScript,
      options.node,
      this.dataRoot,
      (line) => options.world.log(line),
      options.timing ?? DEFAULT_TIMING,
      options.onPid,
      owner,
    );
    client.onPluginFailure = (plugin, message, fatal) => {
      // The host may have died: nobody listens until it says so again.
      this.followWorkspace();
      // M5-18c + R4: a separate host always belongs to its owner, even when it dies or errors with nothing in flight.
      const target = owner ?? plugin;
      if (!target) return;
      this.status.delete(target);
      if (this.takeover?.plugin === target) this.takeover = null;
      this.dropDecorations(target);
      this.registry.recordHostFailure(target, message, fatal);
    };
    client.onRegistered = () => {
      this.followWorkspace();
      this.announce();
      this.replayHeld();
      this.workersPickUp();
    };
    client.onNotification = (method, params) => this.notified(method, params, owner);
    client.onRequest = (method, params) => this.requested(method, params, owner);
    // M5-18a: a restart after a crash runs only what may run now (a file the fingerprint does not cover may have changed).
    if (options.mayRunServerPart) client.beforeRestart = () => this.sync();
    return client;
  }

  hostFor(name: string): PluginHostClient {
    return this.hosts.get(name) ?? this.host;
  }

  orderedHosts(): PluginHostClient[] {
    const names = [...this.hosts.keys()].sort();
    return [this.host, ...names.map((name) => this.hosts.get(name)!)];
  }

  private commandHost(id: string): PluginHostClient | null {
    // The longest plugin name the id starts with owns it, built-ins included (M5-18b review: a plugin named "botling"
    // must not take "botling.terminal.…" from the built-in in the shared host).
    let owner = "";
    for (const plugin of this.registry.plugins) {
      const name = plugin.manifest.name;
      if (name.length > owner.length && id.startsWith(`${name}.`)) owner = name;
    }
    const client = owner && this.options.separateHosts && !this.registry.plugin(owner)?.builtIn ? this.hosts.get(owner) : this.host;
    return client?.running && client.commands.includes(id) ? client : null;
  }

  private retireHost(client: PluginHostClient) {
    const pending = client.shutdown().catch(() => {});
    this.retiring.add(pending);
    void pending.finally(() => { this.retiring.delete(pending); });
  }

  private mayRunHash(name: string, codeHash: string): boolean {
    if (!this.options.mayRunServerPart) return true;
    try {
      return this.options.mayRunServerPart(name, codeHash);
    } catch {
      return false;
    }
  }

  private serverPartAllowed(plugin: InstalledPlugin): boolean {
    if (!this.options.mayRunServerPart) return true;
    try {
      return this.options.mayRunServerPart(plugin.manifest.name, folderHash(plugin.folder));
    } catch {
      return false;
    }
  }

  private sync() {
    // Bots' replies lose the tags plugins declare from the start (the host may not run yet: they are dropped then).
    setPluginTags([...this.replyTagOwners().keys()]);
    if (!this.started) return;
    // Startup timing: what a sync spends where, written only when it took 100 ms or more.
    const marks = new PhaseMarks(this.options.phaseLog, "plugins sync", undefined, 100);
    const tally = new PhaseTally();
    const app = this.options.world.appSettings();
    const nextHeldBack = new Set<string>();
    const sharedSpecs: HostSpec[] = [];
    const separateSpecs = new Map<string, HostSpec>();
    const activeSnapshots = new Set<string>();
    /** Plugins whose snapshot folder had changed in place: what their host imported from it may not be what was hashed. */
    const repaired = new Set<string>();
    for (const spec of this.registry.hostSpecs(this.dataRoot)) {
      const plugin = this.registry.plugin(spec.name);
      const isSeparate = !!this.options.separateHosts && !!plugin && !plugin.builtIn;
      if (isSeparate) {
        let snapshot: { codeHash: string; files: SnapshotFile[] };
        const readBegan = performance.now();
        try {
          snapshot = readPluginSnapshot(plugin.folder);
          tally.add("read plugin folder (every file, sync)", `${spec.name} (${snapshot.files.length} files, ${snapshot.files.reduce((sum, file) => sum + file.data.length, 0)} bytes)`, performance.now() - readBegan);
        } catch {
          nextHeldBack.add(spec.name);
          continue;
        }
        if (!this.mayRunHash(plugin.manifest.name, snapshot.codeHash)) {
          nextHeldBack.add(spec.name);
          continue;
        }
        let snapDir: string;
        const materializeBegan = performance.now();
        try {
          const made = materializeSnapshot(this.snapshotRoot, snapshot.codeHash, snapshot.files);
          tally.add("snapshot copy check or write (reads the copy again)", spec.name, performance.now() - materializeBegan);
          snapDir = made.dir;
          if (made.repaired) repaired.add(spec.name);
        } catch {
          nextHeldBack.add(spec.name);
          continue;
        }
        activeSnapshots.add(snapshot.codeHash);
        const snapMain = join(snapDir, relative(plugin.folder, spec.main));
        separateSpecs.set(spec.name, { ...spec, dir: snapDir, main: snapMain, app });
      } else {
        if (plugin && !this.serverPartAllowed(plugin)) {
          nextHeldBack.add(spec.name);
          continue;
        }
        sharedSpecs.push({ ...spec, app });
      }
    }
    this.heldBack = nextHeldBack;
    marks.lap("host specs and snapshots");
    tally.report(this.options.phaseLog, "plugins sync");
    // M7-O03b: a plugin that is gone, held back or another version gives its workers back to core now, before the host
    // below starts the new one (a worker has one owner, the bot; the plugin's route to it ends here).
    this.workersReconcile();
    this.sharedCode = new Map(sharedSpecs.map((spec) => [spec.name, spec.fingerprint]));
    // M5-18a: a plugin the shared host still runs lost its grant (or its granted code): a fresh host, not an unload (§18.3).
    if ([...nextHeldBack].some((name) => this.host.runs(name))) this.host.replace(sharedSpecs);
    else this.host.update(sharedSpecs);
    for (const [name, client] of [...this.hosts.entries()]) {
      if (!separateSpecs.has(name)) {
        this.hosts.delete(name);
        this.hostMeta.delete(name);
        this.retireHost(client);
      }
    }
    for (const [name, spec] of separateSpecs) {
      let client = this.hosts.get(name);
      const prev = this.hostMeta.get(name);
      this.hostMeta.set(name, { main: spec.main, dir: spec.dir ?? "", fingerprint: spec.fingerprint });
      if (!client) {
        client = this.createHostClient(name);
        this.hosts.set(name, client);
        client.update([spec]);
      } else if (repaired.has(name) || (prev && (prev.main !== spec.main || prev.dir !== spec.dir || prev.fingerprint !== spec.fingerprint))) {
        client.replace([spec]);
      } else {
        client.update([spec]);
      }
    }
    marks.lap("start or update hosts");
    if (this.options.separateHosts) pruneSnapshots(this.snapshotRoot, activeSnapshots);
    marks.lap("prune snapshots");
    for (const name of [...this.status.keys()]) if (!this.loaded(name)) this.status.delete(name);
    if (this.takeover && !this.drawing(this.takeover.plugin)) this.takeover = null;
    this.dropDecorations();
    this.foldersChanged();
    marks.lap("folders changed");
    this.announce();
    marks.lap("announce");
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
  foldersChanged(botIds?: string[], reason?: { told: string; shown: string }) {
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
    for (const [botId, byPlugin] of this.chatDatas) {
      for (const name of [...byPlugin.keys()]) {
        if (name !== failed && this.drawing(name)) continue;
        byPlugin.delete(name);
        this.options.world.dataChanged?.(botId, name, null);
      }
      if (!byPlugin.size) this.chatDatas.delete(botId);
    }
  }

  /** What plugins keep for a chat's page, by plugin (ChatSnapshot.pluginData). */
  chatData(botId: string): Record<string, unknown> {
    return Object.fromEntries(this.chatDatas.get(botId) ?? []);
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
    if (name === "botRemoved") {
      this.botGone((data as { botId: string }).botId);
      this.notes.unwatch((data as { botId: string }).botId);
      if (this.markedTabs.forget((data as { botId: string }).botId)) this.announce();
    }
    for (const client of this.orderedHosts()) client.event(name, data);
  }

  announce() {
    this.options.world.changed(this.view());
  }

  /** Whether some plugin listens for workspace changes now; the world is told when that changes. */
  private followWorkspace() {
    const on = this.orderedHosts().some((client) => client.running && client.events.has(WORKSPACE_EVENT));
    if (on === this.watchingWorkspace) return;
    this.watchingWorkspace = on;
    this.options.world.workspaceWatch(on);
  }

  /** The workspace changed: plugins listening hear it (`workspace.onChange`); nothing is sent while none does. */
  workspaceChanged(change: WorkspaceChange) {
    for (const client of this.orderedHosts()) client.event(WORKSPACE_EVENT, change);
  }

  async shutdown() {
    this.notes.close();
    await Promise.all([...this.orderedHosts().map((client) => client.shutdown()), ...this.retiring]);
  }

  // ------------------------------------------------------------------------------------------
  // What the app shows and changes

  /** The version an install replaced and kept for Revert (maintainer.ts `previousOf`); the server sets it. */
  previousVersion: (name: string) => string | null = () => null;

  /** The server sets it: `view()` then carries the tiles (`PluginsView.tiles`, for the page's slots). Off, a bare `view()` is as it was. */
  tilesInView = false;

  view(): PluginsView {
    const sharedRegistered = new Set(this.host.running ? this.host.commands : []);
    return {
      plugins: this.registry.plugins.slice(0, 200).map((plugin) => {
        const ccb = plugin.manifest.ccb;
        const parts = (["web", "host", "claude"] as const).filter((part) => ccb?.[part]);
        const heldBack = plugin.enabled && !plugin.failure && !!ccb?.host
          && (this.started ? this.heldBack.has(plugin.manifest.name) : !this.serverPartAllowed(plugin));
        const failure = plugin.failure ?? (heldBack ? SERVER_PART_HELD_NOTICE : null);
        const grant = this.options.pluginGrant?.(plugin.manifest.name) ?? null;
        const asks = this.options.pluginAsks?.(plugin.manifest.name) ?? null;
        return {
          name: plugin.manifest.name,
          title: title(plugin.manifest).slice(0, 200),
          version: plugin.manifest.version.slice(0, 100),
          description: plugin.manifest.description?.slice(0, 2_000) ?? null,
          enabled: plugin.enabled,
          failure: failure?.slice(0, 2_000) ?? null,
          hostState: !ccb?.host ? "none" as const : plugin.failure ? "failed" as const : !plugin.enabled ? "off" as const : heldBack ? "held" as const : this.hostFor(plugin.manifest.name).runs(plugin.manifest.name) ? "running" as const : "starting" as const,
          installedFrom: plugin.installedFrom?.slice(0, 2_000) ?? null,
          ...(plugin.builtIn ? { builtIn: true } : {}),
          ...(grant !== null ? { grant } : {}),
          ...(asks ? { asks } : {}),
          ...(plugin.replacesBuiltIn ? { replacesBuiltIn: plugin.replacesBuiltIn.slice(0, 100) } : {}),
          ...(plugin.ignoredLibraryCopy ? { ignoredLibraryVersion: plugin.ignoredLibraryCopy.version.slice(0, 100) } : {}),
          ...(plugin.skipped?.length ? { skipped: plugin.skipped.slice(0, 50).map((problem) => problem.slice(0, 2_000)) } : {}),
          ...((!plugin.builtIn || plugin.replacesBuiltIn) && plugin.installedFrom ? { removable: true } : {}),
          ...((() => { const previous = plugin.builtIn && !plugin.replacesBuiltIn ? null : this.previousVersion(plugin.manifest.name); return previous ? { revertTo: previous.slice(0, 100) } : {}; })()),
          permissions: (ccb?.permissions ?? []).slice(0, 20).map((permission) => permission.slice(0, 40)),
          parts: [...parts, ...(ccb?.contributes?.components ? ["components" as const] : [])],
          settings: this.registry.settingsView(plugin).slice(0, 100).map((setting) => ({
            ...setting, title: setting.title.slice(0, 400), type: setting.type.slice(0, 20), options: setting.options.slice(0, 50).map((option) => option.slice(0, 200)),
            value: typeof setting.value === "string" ? setting.value.slice(0, 10_000) : typeof setting.value === "object" ? null : setting.value,
          })),
          commands: (() => {
            const own = this.hosts.get(plugin.manifest.name);
            const registered = own ? new Set(own.running ? own.commands : []) : sharedRegistered;
            return (ccb?.contributes?.commands ?? []).slice(0, 100).map((command) => ({ id: command.id.slice(0, 200), title: command.title.slice(0, 200), registered: registered.has(command.id) }));
          })(),
          panels: plugin.enabled && !plugin.failure && ccb?.web ? (ccb.contributes?.panels ?? []).slice(0, 20).map((panel) => ({ id: panel.id.slice(0, 100), title: panel.title.slice(0, 200) })) : [],
          ...(this.status.get(plugin.manifest.name)?.size ? { status: [...this.status.get(plugin.manifest.name)!.values()].slice(0, 20) } : {}),
        };
      }),
      broken: Object.entries(this.registry.problems).slice(0, 200).map(([folder, problems]) => ({ folder: folder.slice(0, 214), problems: problems.slice(0, 50).map((problem) => problem.slice(0, 2_000)) })),
      host: {
        running: this.orderedHosts().some((client) => client.running),
        problem: this.orderedHosts().map((client) => client.problem).find(Boolean)?.slice(0, 2_000) ?? null,
      },
      secretsProblem: this.secrets.problem?.slice(0, 2_000) ?? null,
      ...commandSurfaces(this.contributions()),
      ...(() => { const componentTokens = this.registry.componentTokens(); return Object.keys(componentTokens).length ? { componentTokens } : {}; })(),
      ...viewSurfaces(this.contributions(), (name) => !!this.registry.webPart(name), (plugin, view) => this.markedTabs.bots(plugin, view)),
      ...(this.tilesInView ? tileView(this.contributions()) : {}),
      takeover: this.takeover ? { plugin: this.takeover.plugin, view: this.takeover.view, botId: this.takeover.botId, wide: this.takeover.wide } : null,
    };
  }

  /** The user (or the app) closed the takeover: the plugin's program part is told by the frame's own call, not here. */
  closeTakeover() {
    if (!this.takeover) return;
    this.takeover = null;
    this.announce();
  }

  /**
   * What enabled plugins contribute, with the keys their program parts set for their own commands
   * (`keybindings.set`) in place of their manifests'; the user's keys still win (shortcuts.ts `pluginBindings`).
   */
  contributions(): Contribution[] {
    return this.registry.effectiveContributions();
  }

  known(name: string) {
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
    const host = this.commandHost(id);
    if (!host) throw new ContractError("not_found", `No command "${id}".`);
    try {
      return await host.command(id, args);
    } catch (error) {
      this.options.world.notice(`Command "${id}" failed: ${(error as Error).message}`);
      throw new ContractError("conflict", (error as Error).message);
    }
  }

  /**
   * A plugin's button in the browser pane's toolbar (menu "browser/tab") was clicked: its command runs in the program part with one
   * argument, `{ botId, tabId, url, path }` (`botId` as plugins name bots, "main" for the main bot; `path`: the local file a file: URL
   * names, else null). Only a command offered there, on a tab its `when` matches.
   */
  async tabCommand(id: string, tab: { botId: string; tabId: string; url: string }): Promise<unknown> {
    const offered = ofKind(this.contributions(), "menu").some((entry) => entry.menu === "browser/tab" && entry.command === id && entry.plugin && id.startsWith(`${entry.plugin}.`) && tabMatches(entry.when, tab.url));
    if (!offered) throw new ContractError("forbidden", `"${id}" is not offered for this browser tab.`);
    const host = this.commandHost(id);
    if (!host) throw new ContractError("not_found", `No command "${id}".`);
    let path: string | null = null;
    try { if (new URL(tab.url).protocol === "file:") path = fileURLToPath(tab.url); } catch { /* not a local file */ }
    const botId = this.options.world.botId?.("main") === tab.botId ? "main" : tab.botId;
    try {
      return await host.command(id, [{ botId, tabId: tab.tabId, url: tab.url, path }]);
    } catch (error) {
      this.options.world.notice(`Command "${id}" failed: ${(error as Error).message}`);
      throw new ContractError("conflict", (error as Error).message);
    }
  }

  /**
   * A plugin's button beside a link in a chat message (menu "chat/link"): runs its command with `{ botId, messageId, url, path }`
   * and nothing more. Only an entry of that plugin whose `when` matches the link; the core (server.ts) has checked the link is in
   * that message. `path`: the local file, for a file: URL or an absolute path (undefined for a web link).
   */
  async linkCommand(id: string, link: { botId: string; messageId: string; url: string }): Promise<unknown> {
    const address = chatLinkAddress(link.url);
    const offered = address !== null && ofKind(this.contributions(), "menu").some((entry) => entry.menu === "chat/link" && entry.command === id && id.startsWith(`${entry.plugin}.`) && tabMatches(entry.when, address));
    if (!offered) throw new ContractError("forbidden", `"${id}" is not offered for this link.`);
    const host = this.commandHost(id);
    if (!host) throw new ContractError("not_found", `No command "${id}".`);
    let path: string | undefined;
    try { if (address && new URL(address).protocol === "file:") path = fileURLToPath(address); } catch { /* not a local file */ }
    // Botling 3 (M5-09, §9A.8): `path` only when the file is on this machine; otherwise the line's content reference, which the
    // plugin reads with `content.read`. A lookup that fails gives no reference (never a made-up path or a skipped check).
    let content: LineContentRef | undefined;
    if (path && this.options.world.lineContent && !isRegularFile(path) && address) {
      try { content = this.options.world.lineContent(link.botId, link.messageId, address) ?? undefined; } catch { content = undefined; }
      if (content) path = undefined;
    }
    const botId = this.options.world.botId?.("main") === link.botId ? "main" : link.botId;
    try {
      return await host.command(id, [{ botId, messageId: link.messageId, url: link.url, ...(path ? { path } : {}), ...(content ? { content } : {}) }]);
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
      ...(spec.builtIn ? { builtIn: true } : {}),
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

  /**
   * The core asks a built-in plugin's own program part something (a pin's author for a link, its words for a problem report): its
   * answer, or null when the plugin is not shipped here, not running, or does not answer. The core then does what it does without it.
   */
  async askBuiltIn(name: string, method: string, params: unknown): Promise<unknown> {
    if (!this.shipped(name) || !this.loaded(name)) return null;
    try { return (await this.host.webCall(name, method, params, "chat")) ?? null; } catch { return null; }
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

  async call(name: string, method: string, params: unknown, from: "frame" | "chat"): Promise<unknown> { return hostEvents.call.call(this, name, method, params, from); }
  async beforeSend(bot: BotInfo, text: string): Promise<{ send: string } | { stoppedBy: string }> { return hostEvents.beforeSend.call(this, bot, text); }
  afterReplyFilter(bot: () => BotInfo): ((text: string) => Promise<string>) | null { return hostEvents.afterReplyFilter.call(this, bot); }
  replied(bot: BotInfo, text: string) { return hostEvents.replied.call(this, bot, text); }
  shipped(name: string) { return hostEvents.shipped.call(this, name); }
  replyTagOwners(): Map<string, string> { return hostEvents.replyTagOwners.call(this); }
  replyTags(bot: BotInfo, tags: PluginTag[]) { return hostEvents.replyTags.call(this, bot, tags); }
  replayHeld() { return hostEvents.replayHeld.call(this); }
  promptSections() { return hostEvents.promptSections.call(this); }
  agentCommands(): { plugin: string; id: string; folder: string; script: string; flag: string; docs: string | null }[] { return hostEvents.agentCommands.call(this); }
  appPlugin(plugin: InstalledPlugin): AppWorld { return hostEvents.appPlugin.call(this, plugin); }
  devBriefing(botId: string, worktree: boolean): string { return hostEvents.devBriefing.call(this, botId, worktree); }
  briefingPlugins(): string[] { return hostEvents.briefingPlugins.call(this); }
  asking(name: string) { return hostEvents.asking.call(this, name); }
  studioPlugin(name: string): StudioWorld | null { return hostEvents.studioPlugin.call(this, name); }
  studioLineExtras(record: { role: string; displays?: unknown }): { component?: string } { return hostEvents.studioLineExtras.call(this, record); }
  approvalState(botId: string, command: string, folder: string) { return hostEvents.approvalState.call(this, botId, command, folder); }
  approvalAsk(name: string, botId: string, command: string, folder: string, card?: string, component?: string, detail?: string, from?: "frame" | "chat"): { needsApproval: ApprovalAskView | null } { return hostEvents.approvalAsk.call(this, name, botId, command, folder, card, component, detail, from); }
  noteSnapshot(name: string, botId: string, picture: { base64: string; name: string } | undefined): { ref: string; url: string | null } { return hostEvents.noteSnapshot.call(this, name, botId, picture); }
  linkTarget(name: string, botId: string, href: string): PluginLinkTarget { return hostEvents.linkTarget.call(this, name, botId, href); }
  tileImages(name: string, botId: string, data: string): { images: Record<string, string> } { return hostEvents.tileImages.call(this, name, botId, data); }
  approve(name: string, botId: string, command: string, folder: string, component?: string, detail?: string | null): { accepted: boolean } { return hostEvents.approve.call(this, name, botId, command, folder, component, detail); }
  loaded(name: unknown) { return hostEvents.loaded.call(this, name); }
  asked<T extends z.ZodTypeAny>(schema: T, params: unknown, owner?: string): { plugin: InstalledPlugin; data: z.infer<T> } { return hostEvents.asked.call(this, schema, params, owner) as { plugin: InstalledPlugin; data: z.infer<T> }; }
  cardsAllowed(plugin: InstalledPlugin) { return hostEvents.cardsAllowed.call(this, plugin); }
  noteFile(botId: string): string { return hostEvents.noteFile.call(this, botId); }
  noteAssetUrl(noteFile: string, ref: string): string | null { return hostEvents.noteAssetUrl.call(this, noteFile, ref); }
  needs(plugin: InstalledPlugin, capability: string, what: string) { return hostEvents.needs.call(this, plugin, capability, what); }
  keybindings(): { command: string; key: string; source: "default" | "user" | "plugin" }[] { return hostEvents.keybindings.call(this); }
  notified(method: string, params: unknown, owner?: string) { return hostEvents.notified.call(this, method, params, owner); }

  /** `workers.*`'s book (plugin-workers.ts): the world's workers, this plugin's facts now, the card in the main chat, the book in `plugin-workers.json`. */
  workers(): PluginWorkers {
    const world = this.options.world.orchestration;
    if (!world) throw new Error("Workers are not available here.");
    const file = join(this.options.dataDir, "plugin-workers.json");
    return this.workerBook ??= new PluginWorkers({
      world,
      facts: (name) => {
        const plugin = this.loaded(name);
        return plugin ? { name, identity: createHash("sha256").update(JSON.stringify(plugin.manifest)).digest("hex"), permissions: plugin.manifest.ccb?.permissions ?? [], botWritten: !plugin.builtIn && !plugin.installedFrom } : null;
      },
      ask: (question) => this.options.world.ask(question),
      // Only the host that runs this plugin: hostFor() falls back to the shared host when a plugin's own host is not
      // there, and a write there would count as told while nobody listening is the plugin (the report would be lost).
      tell: (plugin, event, data) => { const host = this.hostFor(plugin); return host.runs(plugin) && host.deliver(event, data); },
      log: (line) => this.options.world.log(line),
      warn: (_plugin, text) => this.options.world.notice(text),
      file: { read: () => { try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }, write: (text) => writeFileAtomic(file, text) },
    });
  }

  /**
   * F6 (M7-O04, M7-O05): what a message from `plugin` carries (`from`): its name when it is not shipped, else nothing (a shipped plugin is a deputy of the user's).
   * The message keeps it, its turn is made with it and keeps it (`Turn.plugin`); nothing about the bot is remembered, so the user writing meanwhile changes no turn but its own.
   */
  heardFrom(plugin: string): string | undefined { return this.shipped(plugin) ? undefined : plugin; }

  /**
   * What `WorkerCore.handoff` asks (bot/workers.ts `admit`): a worker the bot starts in a turn that stems from `plugin` (the turn's, not the bot's) is checked as that
   * plugin's, else it just starts. Fails closed.
   */
  async admitWorker<T extends { task_id: string; run: number }>(botId: string, kind: string, args: Record<string, unknown>, run: (startedBy?: StartedBy) => Promise<T>, plugin?: string): Promise<T> {
    return plugin ? this.workers().admitHeard(plugin, botId, kind, args, run) : run();
  }

  /** What `WorkerCore.message` asks (app_send_message): in a turn that stems from `plugin`, only that plugin's own worker takes a new run, while it is allowed; else not gated (undefined). Fails closed. */
  async gateWorkerMessage(plugin: string | undefined, taskId: string, words: string): Promise<{ run: number; how: string } | undefined> {
    return plugin ? this.workers().admitMessage(plugin, taskId, words) : undefined;
  }

  /** The unload hook for workers (plugin-workers.ts `reconcile`); never throws into the host's sync. */
  private workersReconcile() {
    try { if (this.options.world.orchestration) this.workers().reconcile(); } catch (error) { this.options.world.log(`plugin workers not handed back: ${(error as Error).message}`); }
  }

  codeOf(plugin: string): string | undefined { return this.hostMeta.get(plugin)?.fingerprint ?? this.sharedCode.get(plugin); }

  /** The user changed what a plugin may do (its `orchestrate` grant): a plugin that no longer has it hands its workers back, as when it is switched off. */
  grantChanged() { this.workersReconcile(); }

  /** A bot was removed: the plugin book closes its entries. */
  private botGone(botId: string) {
    try { if (this.options.world.orchestration) this.workers().botGone([botId]); } catch (error) { this.options.world.log(`plugin workers not closed for a removed bot: ${(error as Error).message}`); }
  }

  /** A host came up: what plugins are owed is told, and the workers the book still counts at work are looked at (restart pickup). */
  private workersPickUp() {
    try { if (this.options.world.orchestration) this.workers().pickUp(); } catch (error) { this.options.world.log(`plugin workers not picked up: ${(error as Error).message}`); }
  }

  /** A worker's run ended (the core's event): the plugin that started it hears `workerReport`, once. */
  workerEnded(taskId: string, run: number, status: string, report: string) {
    try { if (this.options.world.orchestration) this.workers().ended(taskId, run, status, report); } catch (error) { this.options.world.log(`workerReport not told: ${(error as Error).message}`); }
  }

  private requested(method: string, params: unknown, owner?: string): Promise<unknown> {
    return requested.call(this, method, params, owner);
  }
}
