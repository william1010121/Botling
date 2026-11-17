// What the plugin host process and the app's frames do with the plugins (M7-S76): the hooks on messages (`beforeSend`,
// `afterReplyFilter`, `replied`), reply tags and prompt sections, the app and studio seams, the approvals a frame asks
// for, a plugin's note picture and links, the checks every request starts with (`loaded`, `asked`, `needs`), and what the
// host tells without asking (`notified`). Moved out of `Plugins` in index.ts unchanged; `Plugins` keeps a one-line delegate
// for each, which calls the function here with itself as `this` (the structural `HostEventsHost`, as `RequestHost` in
// requests.ts). This file imports nothing from index.ts.
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { ContractError, type ApprovalAskView } from "../../contract";
import { bindingsFor, pluginBindings } from "../../contract/shortcuts";
import type { PluginTag } from "../reply";
import { commandSurfaces } from "./commands";
import { CORE_PROMPT_SECTIONS } from "../prompts";
import { HANDED_TAGS, ofKind, type Contribution } from "./contributions";
import type { PluginHostClient } from "./host-client";
import { title } from "./manifest";
import { mustOwnNote } from "./plugin-owns";
import type { InstalledPlugin, PluginRegistry } from "./registry";
import type { PendingTags } from "./pending-tags";
import type { BriefingBook, AppWorld } from "./app-seam";
import type { StudioWorld } from "./studio-seam";
import { readNote } from "../bot-note";
import { pluginLinkTarget, type PluginLinkTarget } from "../plugin-link";
import { assetFile, importAssetBytes } from "../note-assets";
import type { BotInfo, PluginStatusItem, PluginsOptions } from "./types";
import { SERVER_PART_HELD_NOTICE } from "./snapshot";
import { NotifyParams, NotifyMore, EmitParams, EMIT_MAX, StatusParams } from "./request-params";

/** What these functions use of `Plugins` through `this` (the class has them; its members are not `private` for that). */
export interface HostEventsHost {
  readonly options: PluginsOptions;
  readonly registry: PluginRegistry;
  readonly briefings: BriefingBook;
  readonly held: PendingTags;
  readonly heldBack: ReadonlySet<string>;
  readonly status: Map<string, Map<string, PluginStatusItem>>;
  announce(): void;
  command(id: string, from?: "frame" | "chat", name?: string, args?: string[]): Promise<unknown>;
  contributions(): Contribution[];
  hostFor(name: string): PluginHostClient;
  known(name: string): InstalledPlugin;
  orderedHosts(): PluginHostClient[];
  // The members moved here, which the moved bodies call through `this`.
  approvalState(botId: string, command: string, folder: string): { folder: string; approved: boolean };
  asking(name: string): InstalledPlugin;
  briefingPlugins(): string[];
  loaded(name: unknown): InstalledPlugin | null;
  needs(plugin: InstalledPlugin, capability: string, what: string): void;
  noteAssetUrl(noteFile: string, ref: string): string | null;
  noteFile(botId: string): string;
  replayHeld(): void;
  replyTagOwners(): Map<string, string>;
  shipped(name: string): boolean;
  studioPlugin(name: string): StudioWorld | null;
}

/**
 * A frame's or the chat page's `ccb.call` to its own plugin's program part (G3): only a method the
 * program part exposed (`ui.expose`, or `web.handle`), never a website tool or anything else in the
 * host. A frame's plugin is the one the page bound it to; the chat page's is only what its web part
 * claims (one realm), so the plugin must at least have a web part there.
 */
export async function call(this: HostEventsHost, name: string, method: string, params: unknown, from: "frame" | "chat"): Promise<unknown> {
  const plugin = this.known(name);
  if (!plugin.enabled || plugin.failure || !plugin.manifest.ccb?.web) throw new ContractError("conflict", `Plugin "${name}" is not on.`);
  if (this.heldBack.has(name)) throw new ContractError("conflict", SERVER_PART_HELD_NOTICE);
  try {
    return await this.hostFor(name).webCall(name, method, params, from);
  } catch (error) {
    throw new ContractError("conflict", (error as Error).message);
  }
}

// ------------------------------------------------------------------------------------------
// Hooks on messages

/** Your message through the plugins' beforeSend hooks: changed, or stopped by one. */
export async function beforeSend(this: HostEventsHost, bot: BotInfo, text: string): Promise<{ send: string } | { stoppedBy: string }> {
  if (!text.trim()) return { send: text };
  let current = text;
  for (const client of this.orderedHosts()) {
    if (client.beforeSendHooks <= 0 || !client.running) continue;
    const outcome = await client.beforeSend(bot, current);
    if ("stoppedBy" in outcome) return outcome;
    current = outcome.send;
  }
  return { send: current };
}

/** A reply through the plugins' afterReply hooks (null: none listen, it shows as it is). */
export function afterReplyFilter(this: HostEventsHost, bot: () => BotInfo): ((text: string) => Promise<string>) | null {
  if (!this.orderedHosts().some((client) => client.afterReplyHooks > 0 && client.running)) return null;
  return async (text) => {
    let current = text;
    for (const client of this.orderedHosts()) {
      if (client.afterReplyHooks > 0 && client.running) current = await client.afterReply(bot(), current);
    }
    return current;
  };
}

export function replied(this: HostEventsHost, bot: BotInfo, text: string) {
  for (const client of this.orderedHosts()) client.replied(bot, text);
}

// ------------------------------------------------------------------------------------------
// Reply tags and prompt sections (plugin-extraction.md W3)

/**
 * Whether a plugin ships with the app. Only one may take over what the core gives today (a handed tag such as
 * <whiteboard>, a core prompt section's id): a library plugin of the same name replaces a built-in one, so the
 * name alone proves nothing.
 */
export function shipped(this: HostEventsHost, name: string) {
  return this.registry.plugin(name)?.builtIn === true;
}

/** Each tag enabled plugins declare (`replyTags`), with the plugin it goes to: the first by name when two declare it. */
export function replyTagOwners(this: HostEventsHost): Map<string, string> {
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
export function replyTags(this: HostEventsHost, bot: BotInfo, tags: PluginTag[]) {
  const owners = this.replyTagOwners();
  for (const tag of tags) {
    const plugin = owners.get(tag.tag);
    if (!plugin || !this.loaded(plugin)) continue;
    const host = this.hostFor(plugin);
    if (host.runs(plugin) && !this.held.has(plugin)) host.replyTag(plugin, bot, tag);
    else this.held.hold(plugin, bot, tag);
  }
  // The host may run it already (only the order mattered above).
  this.replayHeld();
}

/** Tags held for plugins the host runs now are handed over, in the order they came. */
export function replayHeld(this: HostEventsHost) {
  for (const plugin of new Set(this.replyTagOwners().values())) {
    const host = this.hostFor(plugin);
    if (!this.held.has(plugin) || !this.loaded(plugin) || !host.runs(plugin)) continue;
    for (const entry of this.held.take(plugin)) {
      if (this.replyTagOwners().get(entry.tag) === plugin) host.replyTag(plugin, entry.bot, { tag: entry.tag, attributes: entry.attributes, body: entry.body });
    }
  }
}

/** What enabled plugins add to bots' instructions (`promptSections`), in the plugins' order; a core section's id only from a built-in plugin. */
export function promptSections(this: HostEventsHost) {
  return ofKind(this.registry.contributions(), "promptSection")
    .filter((entry) => !CORE_PROMPT_SECTIONS.some((section) => section.id === entry.id) || this.shipped(entry.plugin))
    // A section that names a command goes with a plugin shipped with the app only (it tells bots to run that command).
    .filter((entry) => entry.command === undefined || this.shipped(entry.plugin));
}

/** The commands enabled, shipped plugins give the bots (`agentCommands`), with the script and guide as absolute paths. */
export function agentCommands(this: HostEventsHost): { plugin: string; id: string; folder: string; script: string; flag: string; docs: string | null }[] {
  return ofKind(this.registry.contributions(), "agentCommand").flatMap((entry) => {
    const plugin = this.registry.plugin(entry.plugin);
    if (!plugin?.builtIn) return [];
    return [{ plugin: entry.plugin, id: entry.id, folder: plugin.folder, script: join(plugin.folder, entry.script), flag: entry.flag, docs: entry.docs === null ? null : join(plugin.folder, entry.docs) }];
  });
}

// ------------------------------------------------------------------------------------------
// The app seam (app-seam.ts, plugin-extraction.md §3.2 #6): built-in plugins only

/** A plugin shipped with the app, running, with the "app" permission. */
export function appPlugin(this: HostEventsHost, plugin: InstalledPlugin): AppWorld {
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
export function devBriefing(this: HostEventsHost, botId: string, worktree: boolean): string {
  for (const name of this.briefingPlugins()) {
    const kept = this.briefings.get(name);
    if (kept?.bot === botId) return worktree ? kept.worktree : kept.plain;
  }
  return "";
}

export function briefingPlugins(this: HostEventsHost): string[] {
  return this.registry.plugins.filter((plugin) => plugin.enabled && !plugin.failure && plugin.builtIn && !!plugin.manifest.ccb?.permissions?.includes("app")).map((plugin) => plugin.manifest.name).sort();
}

// ------------------------------------------------------------------------------------------
// Approvals a plugin's frame asks for (plugin-extraction.md W4, `ccb.requestApproval`)

/** A plugin on now (enabled, not failed) that may ask: it has a frame of its own (a web part). */
export function asking(this: HostEventsHost, name: string) {
  const plugin = this.known(name);
  if (!plugin.enabled || plugin.failure) throw new ContractError("conflict", `Plugin "${name}" is not on.`);
  return plugin;
}

/** The studio seam's world, when `name` is a plugin shipped with Botling that has the "studio" permission (the only kind whose frames may ask for a command in another folder). */
export function studioPlugin(this: HostEventsHost, name: string): StudioWorld | null {
  const plugin = this.registry.plugin(name);
  if (!plugin || !plugin.enabled || plugin.failure || !plugin.builtIn || !plugin.manifest.ccb?.permissions?.includes("studio")) return null;
  return this.options.world.studio ?? null;
}

/**
 * What a chat's line shows besides itself for the component studio (bot.ts `lineExtras`): asked of the studio seam's world, and only
 * while a plugin shipped with Botling that has the "studio" permission is on (none: nothing, as no reply is then a library component to add to another bot).
 */
export function studioLineExtras(this: HostEventsHost, record: { role: string; displays?: unknown }): { component?: string } {
  const on = this.registry.plugins.find((plugin) => plugin.enabled && !plugin.failure && plugin.builtIn && !!plugin.manifest.ccb?.permissions?.includes("studio"));
  return (on && this.options.world.studio?.lineExtras(record)) || {};
}

/** The bot's command as the core has it: refused unless `folder` is that bot's own folder. */
export function approvalState(this: HostEventsHost, botId: string, command: string, folder: string) {
  const state = this.options.world.commandApproval(botId, command);
  if (!state) throw new ContractError("not_found", "No such bot.");
  if (state.folder !== folder) throw new ContractError("bad_request", `A plugin's command runs in its bot's folder (${state.folder}), not ${folder}.`);
  return state;
}

/**
 * A frame's `ccb.requestApproval`, from the app page (which bound the frame to `name`): what the app page's
 * ApprovalSheet shows (null: allowed already, nothing to ask). Asking allows nothing.
 */
export function approvalAsk(this: HostEventsHost, name: string, botId: string, command: string, folder: string, card?: string, component?: string, detail?: string, from?: "frame" | "chat"): { needsApproval: ApprovalAskView | null } {
  const plugin = this.asking(name);
  // A pin's card (botling.board): the component's own Detail command comes with it, and the sheet names the component, as a card's does.
  if (component !== undefined) {
    if (!this.shipped(name)) throw new ContractError("forbidden", "Only a plugin shipped with Botling may ask about a component's card.");
    if (!card || !/^pin\/[A-Za-z0-9-]{1,100}$/.test(card)) throw new ContractError("bad_request", "A component's card is asked about with its key (pin/<id>).");
    const ask = this.options.world.cardAsk?.(botId, card, command, component);
    if (ask === undefined || ask === null) return { needsApproval: null };
    if (resolvePath(ask.folder) !== resolvePath(folder)) throw new ContractError("conflict", "That is not the folder this bot's commands run in.");
    return { needsApproval: ask };
  }
  // The chat page is one realm for every plugin's web part: only the component studio's may ask from there (a frame is told apart by its own window).
  if (from === "chat" && !this.studioPlugin(name)) throw new ContractError("forbidden", `A web part of "${name}" may not ask for approval in the chat.`);
  // The component studio's commands run in the folder of the reply they came from, and may have a Detail command: what the
  // sheet asks is exactly the command, folder and detail the user will allow (the core's own words for the card).
  const studio = this.studioPlugin(name);
  if (studio) {
    if (!this.options.world.botId?.(botId)) throw new ContractError("not_found", "No such bot.");
    if (studio.commands.isApproved(command, folder) && studio.commands.isDetailApproved(detail ?? null, folder)) return { needsApproval: null };
    return { needsApproval: { command, folder, detail: detail ?? null, card: card ? card.slice(0, 100) : title(plugin.manifest).slice(0, 100) } };
  }
  const state = this.approvalState(botId, command, folder);
  if (state.approved) return { needsApproval: null };
  const who = title(plugin.manifest).slice(0, 100);
  return { needsApproval: { command, folder: state.folder, detail: null, card: card ? `${who}: ${card.slice(0, 100)}` : who } };
}

/** The pictures a frame's tile data names, as card-page URLs (`ccb.tile`: the app page puts them into the tile's page). */
/**
 * A plugin frame's `ccb.snapshot` ("freeze to image" in the Note tab): the picture main took of that frame's own rect,
 * kept in the bot's note-assets folder like a pasted one. Needs "files" and owning the note (plugin-owns.ts); the plugin links the ref itself.
 */
export function noteSnapshot(this: HostEventsHost, name: string, botId: string, picture: { base64: string; name: string } | undefined): { ref: string; url: string | null } {
  const plugin = this.asking(name);
  this.needs(plugin, "files", "Adding a picture to a bot's note");
  mustOwnNote(plugin, "Adding a picture to a bot's note");
  if (!picture) throw new ContractError("conflict", "No picture could be taken of that card.");
  const file = this.noteFile(botId);
  const ref = importAssetBytes(file, Buffer.from(picture.base64, "base64"), picture.name);
  return { ref, url: this.noteAssetUrl(file, ref) };
}

/**
 * What a plugin frame's `ccb.openLink` opens (plugin-link.ts): a web link, or a local file inside the bot's folder or its
 * note's folder (relative links against the note's folder) or one the saved note links. Main opens it as a chat link.
 * A local file needs "files" (as `notes.*`); a web link needs nothing.
 */
export function linkTarget(this: HostEventsHost, name: string, botId: string, href: string): PluginLinkTarget {
  const plugin = this.asking(name);
  if (!/^\s*(https?|mailto):/i.test(href)) this.needs(plugin, "files", "Opening a file a bot's note links");
  const file = this.noteFile(botId);
  let noteText = "";
  try { noteText = readNote(file).text; } catch { noteText = ""; }
  try {
    return pluginLinkTarget(href, { noteDir: dirname(file), botFolder: this.options.world.botFolder?.(botId) ?? null, home: homedir(), noteText });
  } catch (error) {
    throw new ContractError("forbidden", (error as Error).message);
  }
}

export function tileImages(this: HostEventsHost, name: string, botId: string, data: string): { images: Record<string, string> } {
  this.asking(name);
  const images = this.options.world.imageUrls(botId, data);
  if (!images) throw new ContractError("not_found", "No such bot.");
  return { images };
}

/** "Allow and run" on the ApprovalSheet for a plugin's ask: the command as the sheet showed it, in that bot's folder. */
export function approve(this: HostEventsHost, name: string, botId: string, command: string, folder: string, component?: string, detail?: string | null): { accepted: boolean } {
  this.asking(name);
  if (component !== undefined) {
    if (!this.shipped(name)) throw new ContractError("forbidden", "Only a plugin shipped with Botling may approve a component's card.");
    return { accepted: this.options.world.cardApprove?.(botId, command, component, folder, detail ?? null) ?? false };
  }
  const studio = this.studioPlugin(name);
  if (studio) {
    if (!this.options.world.botId?.(botId)) throw new ContractError("not_found", "No such bot.");
    studio.commands.approve(command, folder, detail ?? null);
    return { accepted: true };
  }
  this.approvalState(botId, command, folder);
  return { accepted: this.options.world.approveCommand(botId, command) };
}

/** The plugin whose name a host message gives, if it is loaded (the host names it; it is all one process). */
export function loaded(this: HostEventsHost, name: unknown) {
  if (typeof name !== "string") return null;
  const plugin = this.registry.plugin(name);
  return plugin && plugin.enabled && !plugin.failure && plugin.manifest.ccb?.host && !this.heldBack.has(plugin.manifest.name) ? plugin : null;
}

/** A request's params and the loaded plugin it names; throws when either is wrong. */
export function asked<T extends z.ZodTypeAny>(this: HostEventsHost, schema: T, params: unknown, owner?: string): { plugin: InstalledPlugin; data: z.infer<T> } {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new Error(`Not a request a plugin can make: ${parsed.error.issues[0]?.message ?? "bad params"}.`);
  const claimed = (parsed.data as { plugin?: unknown }).plugin;
  if (owner !== undefined && claimed !== owner) throw new Error(`This host may only act for "${owner}".`);
  const plugin = this.loaded(claimed);
  if (!plugin) throw new Error("That plugin is not running.");
  return { plugin, data: parsed.data };
}

/** The cards a chat shows and their commands are for the plugins that ship with Botling and say so (`cards` in package.json). */
export function cardsAllowed(this: HostEventsHost, plugin: InstalledPlugin) {
  this.needs(plugin, "cards", "Reading and running a chat's cards");
  if (!this.shipped(plugin.manifest.name)) throw new Error("Only a plugin shipped with Botling may use a chat's cards.");
}

/** A bot's note (`notes.*`): the core alone says where it is; a plugin never names a path. */
export function noteFile(this: HostEventsHost, botId: string): string {
  const file = this.options.world.botNote?.(botId);
  if (!file) throw new Error("No such bot.");
  return file;
}

/** The URL a frame shows a note's picture from (null: no such picture in the note's own note-assets folder). */
export function noteAssetUrl(this: HostEventsHost, noteFile: string, ref: string): string | null {
  const asset = assetFile(noteFile, ref);
  const url = asset ? this.options.world.imageUrl?.(asset.path, asset.type) : undefined;
  return url ?? null;
}

/** The consistency check of plugin-platform.md §5: what acts as the user needs the capability declared. */
export function needs(this: HostEventsHost, plugin: InstalledPlugin, capability: string, what: string) {
  if (!plugin.manifest.ccb?.permissions?.includes(capability)) throw new Error(`${what} needs the "${capability}" permission in package.json.`);
}

/** Every key in effect: Botling's shortcuts, then plugins' commands' (those not left without one). */
export function keybindings(this: HostEventsHost): { command: string; key: string; source: "default" | "user" | "plugin" }[] {
  const overrides = this.options.world.shortcutOverrides();
  const user = (id: string) => Object.hasOwn(overrides, id);
  return [
    ...Object.entries(bindingsFor(overrides)).map(([command, key]) => ({ command, key, source: user(command) ? "user" as const : "default" as const })),
    ...pluginBindings(commandSurfaces(this.contributions()).keybindings, overrides)
      .flatMap((binding) => (binding.combo ? [{ command: binding.command, key: binding.combo, source: user(binding.command) ? "user" as const : "plugin" as const }] : [])),
  ];
}

export function notified(this: HostEventsHost, method: string, params: unknown, owner?: string) {
  if (owner !== undefined) {
    const claimed = params && typeof params === "object" ? (params as { plugin?: unknown }).plugin : undefined;
    if (claimed !== owner) return;
  }
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
