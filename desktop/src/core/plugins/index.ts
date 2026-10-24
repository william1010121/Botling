// Plugins in the core (Workspace.swift's plugin host part, `startPluginHost`, `connectPlugins`): the
// library (registry.ts), sealed secrets (secrets.ts) and the plugin host process (host-client.ts),
// and what the host may ask of the core. The host is untrusted: it is told only what a plugin needs
// (bots' names and roles, its own settings and secrets) and may ask only for the few things below,
// each checked here (a plugin it names must be loaded; creating bots and talking to them on the
// user's behalf need the "bots" permission). Everything else is refused.
//
// Web parts: 2.0 does not load third-party web parts into the chat page (the chat page shares the
// app page's origin, so a plugin there could reach the app's bridge). A plugin's panels run its web
// part in a sandboxed frame instead (botling-card://page/…, opaque origin, no network), with a
// small `ccb` (panels, settings, notify, commands, host.call); its other web hooks (the composer,
// markdown, components) are not available there. ccb-latex stays bundled into the chat page.
import { join } from "node:path";
import { z } from "zod";
import type { PluginsView } from "../../contract";
import { PluginHostClient, type HostCommand, type HostTiming, DEFAULT_TIMING } from "./host-client";
import { title } from "./manifest";
import { PluginRegistry } from "./registry";
import { SealedSecretStore, type Sealer } from "./secrets";

export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean }

/** What the core lends the plugins. */
export interface PluginWorld {
  bots(): BotInfo[];
  /** A message to a bot as if the user wrote it (`bots.send`). */
  send(botId: string, text: string): void;
  /** A line in the main bot's chat. */
  notice(text: string): void;
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
const SendParams = z.object({ plugin: str(214), bot: str(64), text: z.string().min(1).max(100_000) });
const RoutineParams = z.object({ plugin: str(214), bot: str(64), cron: str(200), task: str(2_000) });
const CreateParams = z.object({ plugin: str(214) }).passthrough();

export class Plugins {
  readonly registry: PluginRegistry;
  readonly host: PluginHostClient;
  readonly secrets: SealedSecretStore;
  private readonly dataRoot: string;
  private started = false;

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
    this.host.onPluginFailure = (plugin, message, fatal) => { if (plugin) this.registry.recordHostFailure(plugin, message, fatal); };
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
    this.host.update(this.registry.hostSpecs(this.dataRoot));
    this.announce();
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
        };
      }),
      broken: Object.entries(this.registry.problems).slice(0, 200).map(([folder, problems]) => ({ folder: folder.slice(0, 214), problems: problems.slice(0, 50).map((problem) => problem.slice(0, 2_000)) })),
      host: { running: this.host.running, problem: this.host.problem?.slice(0, 2_000) ?? null },
      secretsProblem: this.secrets.problem?.slice(0, 2_000) ?? null,
    };
  }

  private known(name: string) {
    const plugin = this.registry.plugin(name);
    if (!plugin) throw Object.assign(new Error(`No plugin "${name}".`), { code: "not_found" });
    return plugin;
  }

  setEnabled(name: string, enabled: boolean) {
    this.known(name);
    this.registry.setEnabled(name, enabled);
    return this.view();
  }

  setSetting(name: string, key: string, value: boolean | number | string | null) {
    const setting = this.known(name).manifest.ccb?.contributes?.settings?.[key];
    if (!setting) throw Object.assign(new Error(`Plugin "${name}" has no setting "${key}".`), { code: "not_found" });
    if (setting.secret) throw Object.assign(new Error("A secret is set with plugins.secret."), { code: "bad_request" });
    const fits = value === null
      || (setting.type === "boolean" && typeof value === "boolean")
      || (setting.type === "number" && typeof value === "number" && Number.isFinite(value))
      || (setting.type === "string" && typeof value === "string")
      || (setting.type === "enum" && typeof value === "string" && (setting.options ?? []).includes(value));
    if (!fits) throw Object.assign(new Error(`That is not a ${setting.type} for "${key}".`), { code: "bad_request" });
    this.registry.set(name, key, value);
    return this.view();
  }

  async setSecret(name: string, key: string, value: string | null) {
    const setting = this.known(name).manifest.ccb?.contributes?.settings?.[key];
    if (!setting?.secret) throw Object.assign(new Error(`Plugin "${name}" has no secret "${key}".`), { code: "not_found" });
    try {
      await this.registry.setSecret(name, key, value ? value : null);
    } catch (error) {
      throw Object.assign(new Error((error as Error).message), { code: "conflict" });
    }
    return this.view();
  }

  /** A command a program part registered (`Workspace.runCommand`); a failure is said in the main bot's chat too. */
  async command(id: string): Promise<unknown> {
    if (!this.host.commands.includes(id)) throw Object.assign(new Error(`No command "${id}".`), { code: "not_found" });
    try {
      return await this.host.command(id);
    } catch (error) {
      this.options.world.notice(`Command "${id}" failed: ${(error as Error).message}`);
      throw Object.assign(new Error((error as Error).message), { code: "conflict" });
    }
  }

  /** A panel's web part and settings, for its sandboxed frame. */
  panel(name: string, id: string) {
    const entry = this.registry.panels().find((candidate) => candidate.plugin.manifest.name === name && candidate.panel.id === id);
    const part = entry ? this.registry.webPart(name) : null;
    if (!entry || !part) throw Object.assign(new Error(`No panel "${id}" of plugin "${name}".`), { code: "not_found" });
    const settings: Record<string, boolean | number | string | null> = {};
    for (const [key, value] of Object.entries(part.settings)) settings[key] = value === null || typeof value !== "object" ? value : null;
    return { title: entry.panel.title.slice(0, 200), source: part.source, settings };
  }

  /** A panel's `ccb.host.call` to its own plugin's program part. */
  async call(name: string, method: string, params: unknown): Promise<unknown> {
    const plugin = this.known(name);
    if (!plugin.enabled || plugin.failure || !plugin.manifest.ccb?.web) throw Object.assign(new Error(`Plugin "${name}" is not on.`), { code: "conflict" });
    try {
      return await this.host.webCall(name, method, params);
    } catch (error) {
      throw Object.assign(new Error((error as Error).message), { code: "conflict" });
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

  private notified(method: string, params: unknown) {
    const { world } = this.options;
    switch (method) {
      case "notify": {
        const parsed = NotifyParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (parsed.success && plugin) world.notice(`${title(plugin.manifest)}: ${parsed.data.text.slice(0, 4_000)}`);
        return;
      }
      case "bots.send": {
        const parsed = SendParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!parsed.success || !plugin) return;
        // 2.0: talking to a bot as the user needs the "bots" permission (1.x lets any plugin).
        if (!plugin.manifest.ccb?.permissions?.includes("bots")) {
          world.log(`plugin ${plugin.manifest.name}: bots.send refused (no "bots" permission)`);
          return;
        }
        world.send(parsed.data.bot, parsed.data.text);
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
      case "bots.create": {
        const parsed = CreateParams.safeParse(params);
        const plugin = parsed.success ? this.loaded(parsed.data.plugin) : null;
        if (!plugin?.manifest.ccb?.permissions?.includes("bots")) throw new Error("Creating bots needs the \"bots\" permission in package.json.");
        throw new Error("Botling 2.0 cannot make new bots yet.");
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
