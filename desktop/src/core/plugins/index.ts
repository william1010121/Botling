// Plugins in the core (Workspace.swift's plugin host part, `startPluginHost`, `connectPlugins`): the
// library (registry.ts), sealed secrets (secrets.ts) and the plugin host process (host-client.ts),
// and what the host may ask of the core. The host is untrusted: it is told only what a plugin needs
// (bots' names and roles, its own settings and secrets) and may ask only for the few things below,
// each checked here (a plugin it names must be loaded; creating bots, stopping them and talking to
// them as the user need the "bots" permission — a consistency check, not a sandbox: the host is one
// process). Everything else is refused. A plugin's message to a bot shows as sent by it unless it
// asked to send as the user (plugin-platform.md §5, N1).
//
// Web parts: since Phase 4a the chat page has an origin of its own (botling-chat://chat, no bridge,
// nothing shared with the app page but postMessage), so plugins' web parts run in it again as in 1.x:
// composer, markdown and component hooks, commands and `host.call`; their stylesheets are served by the
// chat origin (only files the manifest names, and fonts beside them). A plugin's panels still run its
// web part in a sandboxed frame (botling-card://page/…, opaque origin, no network). ccb-latex stays
// bundled into the chat page.
import { join } from "node:path";
import { z } from "zod";
import { ContractError, type PluginsView, type WebPluginSpecView } from "../../contract";
import { bindingsFor, findConflict, legacyKey, pluginBindings, type Overrides } from "../../contract/shortcuts";
import { commandSurfaces } from "./commands";
import type { Contribution } from "./contributions";
import { PluginHostClient, type HostCommand, type HostTiming, DEFAULT_TIMING } from "./host-client";
import { title, type JSONValue } from "./manifest";
import { PluginRegistry, type InstalledPlugin } from "./registry";
import { SealedSecretStore, type Sealer } from "./secrets";

export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean }

/** A question of the app's in the main bot's chat (`ui.quickPick`, `ui.input`). */
export interface AppQuestion { text: string; choices: { label: string; detail?: string }[]; typed: boolean }
/** Its answer: a pick, or the user's own words (`typed` only). Ignoring it (no callbacks, by design) answers nothing. */
export type AppAnswer = { index: number } | { text: string };
export interface PluginStatusItem { id: string; text: string; icon: string | null; tooltip: string | null; command: string | null }

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
  /** Botling's own settings plugins may read (`settings.app`). */
  appSettings(): Record<string, JSONValue>;
  /** The keys the user chose (settings.json `shortcutBindings`: Botling's shortcuts and plugin commands). */
  shortcutOverrides(): Overrides;
  /** `bots.create` for a plugin (`makeBot` with its name): the bot's info and whether it is new; throws why not. */
  createBot(plugin: string, title: string, name: string, job: string, avatar: string | undefined): BotInfo & { created: boolean };
  /** A routines.cron line (`routines.add`); false: no such bot, or not a valid schedule. */
  addRoutine(botId: string, cron: string, task: string): "added" | "no-bot" | "bad-schedule";
  /** The library changed: the app shows it. */
  changed(view: PluginsView): void;
  /** A plugin broke: Maintainer is asked to fix it. */
  broken(plugin: string, problem: string): void;
  log(line: string): void;
}

export interface PluginsOptions {
  dataDir: string;
  world: PluginWorld;
  /** How to run Node for the plugin host (null: program parts cannot run). */
  node: HostCommand | null;
  /** The bundled plugin host (out/host/host.mjs). */
  hostScript: string;
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
const EVENT_NAMES = ["messagePosted", "turnFinished", "workerDone"] as const;
export type PluginEventName = (typeof EVENT_NAMES)[number];
const RoutineParams = z.object({ plugin: str(214), bot: str(64), cron: str(200), task: str(2_000) });
const CreateParams = z.object({ plugin: str(214) }).passthrough();

export class Plugins {
  readonly registry: PluginRegistry;
  readonly host: PluginHostClient;
  readonly secrets: SealedSecretStore;
  private readonly dataRoot: string;
  private started = false;
  /** What each plugin shows in the status area (`ui.setStatus`), until it unloads. */
  private readonly status = new Map<string, Map<string, PluginStatusItem>>();

  constructor(private readonly options: PluginsOptions) {
    const { dataDir, world } = options;
    this.secrets = new SealedSecretStore(join(dataDir, "plugin-secrets.json"), options.sealer);
    this.registry = new PluginRegistry(join(dataDir, "plugins"), join(dataDir, "plugins.json"), this.secrets);
    this.dataRoot = join(dataDir, "plugin-data");
    this.host = new PluginHostClient(options.hostScript, options.node, this.dataRoot, (line) => world.log(line), options.timing ?? DEFAULT_TIMING, options.onPid);
    this.registry.onNotice = (text) => world.notice(text);
    this.registry.onBroken = (plugin, problem) => world.broken(plugin, problem);
    this.registry.onUpdated = (plugin, from) => world.notice(`Plugin "${title(plugin.manifest)}" updated: ${from} → ${plugin.manifest.version}`);
    this.registry.onChanged = () => this.sync();
    this.host.onPluginFailure = (plugin, message, fatal) => {
      if (!plugin) return;
      this.status.delete(plugin);
      this.registry.recordHostFailure(plugin, message, fatal);
    };
    this.host.onRegistered = () => this.announce();
    this.host.onNotification = (method, params) => this.notified(method, params);
    this.host.onRequest = (method, params) => this.requested(method, params);
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
    if (!this.started) return;
    const app = this.options.world.appSettings();
    this.host.update(this.registry.hostSpecs(this.dataRoot).map((spec) => ({ ...spec, app })));
    for (const name of [...this.status.keys()]) if (!this.loaded(name)) this.status.delete(name);
    this.announce();
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
    };
  }

  /**
   * What enabled plugins contribute, with the keys their program parts set for their own commands
   * (`keybindings.set`) in place of their manifests'; the user's keys still win (shortcuts.ts `pluginBindings`).
   */
  private contributions(): Contribution[] {
    const set = this.registry.commandKeyOverrides();
    const list = this.registry.contributions();
    const on = new Set(list.map((entry) => entry.plugin));
    const kept = list.filter((entry) => !(entry.kind === "keybinding" && set[entry.plugin] && Object.hasOwn(set[entry.plugin]!, entry.command)));
    for (const [plugin, keys] of Object.entries(set)) {
      if (!on.has(plugin)) continue;
      for (const [command, key] of Object.entries(keys)) if (key) kept.push({ kind: "keybinding", plugin, command, key });
    }
    return kept;
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

  /** A panel's web part and settings, for its sandboxed frame. */
  panel(name: string, id: string) {
    const entry = this.registry.panels().find((candidate) => candidate.plugin.manifest.name === name && candidate.panel.id === id);
    const part = entry ? this.registry.webPart(name) : null;
    if (!entry || !part) throw new ContractError("not_found", `No panel "${id}" of plugin "${name}".`);
    const settings: Record<string, boolean | number | string | null> = {};
    for (const [key, value] of Object.entries(part.settings)) settings[key] = value === null || typeof value !== "object" ? value : null;
    return { title: entry.panel.title.slice(0, 200), source: part.source, settings };
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
      case "browser.register":
      case "browser.unregister":
        // 2.0 has no browser yet: its tools are not offered anywhere.
        return;
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
      case "routines.add": {
        const parsed = RoutineParams.safeParse(params);
        if (!parsed.success || !this.loaded(parsed.data.plugin)) throw new Error("No such bot.");
        const outcome = world.addRoutine(parsed.data.bot, parsed.data.cron, parsed.data.task);
        if (outcome === "no-bot") throw new Error("No such bot.");
        if (outcome === "bad-schedule") throw new Error("Invalid schedule (it must be the 5 crontab fields).");
        return null;
      }
      case "browser.perform":
        throw new Error("No active browser tool invocation.");
      default:
        throw new Error(`Unknown method "${method.slice(0, 80)}".`);
    }
  }
}
