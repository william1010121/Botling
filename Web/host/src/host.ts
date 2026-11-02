// Botling's plugin host: one Node process that runs every plugin's program part (`ccb.host`).
// It talks to Botling over stdin/stdout, one JSON-RPC message per line (like LSP, without headers).
// Plugins' own console output goes to stderr so it cannot break the protocol.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createApi, newLoaded, type BotlingApi, type HostPluginSpec, type Incoming, type JSONValue, type Loaded, type Outgoing, type PluginEventName } from "./api";

export type {
  AppSettingKey, BotInfo, BotlingApi, BrowserOperation, BrowserScope, CcbHost, HostPluginSpec, Incoming, Keybinding, NewBot, Outgoing, PluginEvents, StatusItem,
} from "./api";

type Dispose = () => void;

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: JSONValue;
  error?: { message: string };
}

type Activate = (api: BotlingApi) => void | Dispose | Promise<void | Dispose>;

export class Host {
  private readonly plugins = new Map<string, Loaded>();
  private readonly pending = new Map<number, { resolve: (value: JSONValue) => void; reject: (error: Error) => void }>();
  private nextID = 1;
  /** The plugin whose code is running, so a crash can be blamed on it. */
  private current: string | null = null;
  /** Told to shut down: once the answer is written, `onShutdown` ends the process. */
  private shuttingDown = false;
  /** What ends the host after the shutdown answer is written (`main` exits once stdout is flushed). */
  onShutdown: () => void = () => {};

  constructor(private readonly write: (message: Message) => void, private readonly importer: (spec: HostPluginSpec) => Promise<Activate> = importPlugin) {}

  // MARK: Protocol

  async receive(message: Message): Promise<void> {
    if (message.method === undefined) {
      // A response to one of our requests.
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    try {
      const result = await this.handle(message.method, message.params ?? {});
      if (message.id !== undefined) this.write({ id: message.id, result: result ?? null });
    } catch (error) {
      if (message.id !== undefined) this.write({ id: message.id, error: { message: errorText(error) } });
    }
    if (this.shuttingDown) this.onShutdown();
  }

  request(method: string, params: JSONValue): Promise<JSONValue> {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: JSONValue): void {
    this.write({ method, params });
  }

  private async handle(method: string, params: any): Promise<JSONValue> {
    switch (method) {
      case "ping":
        return "pong";
      case "load":
        return this.sync(params.plugins as HostPluginSpec[]);
      case "beforeSend":
        return this.beforeSend(params as Outgoing);
      case "afterReply":
        return this.afterReply(params as Incoming);
      case "reply":
        for (const plugin of this.plugins.values()) {
          for (const listener of plugin.replyListeners) this.run(plugin.spec.name, () => listener(params.bot, params.text));
        }
        return null;
      case "event": {
        // Something happened in Botling that plugins listen for (`events.on`).
        const name = params.name as PluginEventName;
        for (const plugin of this.plugins.values()) {
          for (const listener of [...(plugin.events.get(name) ?? [])]) this.run(plugin.spec.name, () => listener(params.data));
        }
        return null;
      }
      case "command": {
        const owner = [...this.plugins.values()].find((plugin) => plugin.commands.has(params.id));
        if (!owner) throw new Error(`No command "${params.id}".`);
        return this.runAsync(owner.spec.name, () => owner.commands.get(params.id)!(...(params.args ?? [])));
      }
      case "web": {
        const plugin = this.plugins.get(params.plugin);
        const handler = plugin?.web.get(params.method);
        if (!plugin || !handler) throw new Error(`Plugin "${params.plugin}" does not handle "${params.method}".`);
        // A frame's or the chat page's call (`from`): only what the plugin exposed.
        if (params.from !== undefined && !plugin.exposed.has(params.method)) throw new Error(`Plugin "${params.plugin}" does not expose "${params.method}".`);
        return this.runAsync(plugin.spec.name, () => handler(params.params));
      }
      case "shutdown":
        for (const name of [...this.plugins.keys()]) this.unload(name);
        this.shuttingDown = true;
        return null;
      default:
        throw new Error(`Unknown method "${method}".`);
    }
  }

  // MARK: Plugins

  /** Loads, reloads or unloads plugins so exactly `specs` run. */
  async sync(specs: HostPluginSpec[]): Promise<{ loaded: string[]; failed: { name: string; message: string }[] }> {
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    for (const [name, plugin] of this.plugins) {
      const next = wanted.get(name);
      if (!next || next.fingerprint !== plugin.spec.fingerprint || next.main !== plugin.spec.main) {
        this.unload(name);
      } else {
        // Same code: new settings (its own, or Botling's that it reads) are told, not reloaded.
        const before = plugin.spec.settings;
        plugin.spec = next;
        for (const key of new Set([...Object.keys(before), ...Object.keys(next.settings)])) {
          if (JSON.stringify(before[key]) === JSON.stringify(next.settings[key])) continue;
          for (const handler of plugin.settingHandlers.get(key) ?? []) this.run(name, () => handler(next.settings[key]));
        }
      }
    }
    const failed: { name: string; message: string }[] = [];
    for (const spec of specs) {
      if (this.plugins.has(spec.name)) continue;
      try {
        await this.load(spec);
      } catch (error) {
        this.unload(spec.name);
        failed.push({ name: spec.name, message: errorText(error) });
      }
    }
    this.announce();
    return { loaded: [...this.plugins.keys()], failed };
  }

  private async load(spec: HostPluginSpec): Promise<void> {
    const activate = await this.importer(spec);
    const plugin = newLoaded(spec);
    this.plugins.set(spec.name, plugin);
    this.current = spec.name;
    try {
      const result = await activate(createApi(this, plugin));
      if (typeof result === "function") plugin.disposers.push(result);
    } finally {
      this.current = null;
    }
  }

  unload(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    this.plugins.delete(name);
    for (const dispose of plugin.disposers.reverse()) {
      try { dispose(); } catch { /* one cleanup failing does not stop the rest */ }
    }
  }

  isLoaded(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Tells Botling which hooks, commands and exposed methods exist, so it only asks when someone is listening. */
  private announce(): void {
    const plugins = [...this.plugins.values()];
    this.notify("registered", {
      beforeSend: plugins.reduce((sum, plugin) => sum + plugin.beforeSend.length, 0),
      afterReply: plugins.reduce((sum, plugin) => sum + plugin.afterReply.length, 0),
      commands: plugins.flatMap((plugin) => [...plugin.commands.keys()]),
      exposed: Object.fromEntries(plugins.map((plugin) => [plugin.spec.name, [...plugin.exposed]])),
      events: [...new Set(plugins.flatMap((plugin) => [...plugin.events].filter(([, listeners]) => listeners.length).map(([name]) => name)))],
    });
  }

  /** `announce` soon, once per tick, while `plugin` is still the one loaded. */
  announceLater(plugin: Loaded): void {
    queueMicrotask(() => { if (this.plugins.get(plugin.spec.name) === plugin) this.announce(); });
  }

  // MARK: Hooks

  private async beforeSend(message: Outgoing): Promise<{ text: string } | { cancel: true; by: string }> {
    let current = message;
    for (const plugin of [...this.plugins.values()]) {
      for (const hook of [...plugin.beforeSend]) {
        let result: unknown;
        try {
          result = await this.runAsync(plugin.spec.name, () => hook(current));
        } catch (error) {
          this.report(plugin.spec.name, error);
          continue;
        }
        if (result === false) return { cancel: true, by: plugin.spec.name };
        if (typeof result === "string") current = { ...current, text: result };
        else if (result && typeof result === "object" && typeof (result as Outgoing).text === "string") current = result as Outgoing;
      }
    }
    return { text: current.text };
  }

  private async afterReply(message: Incoming): Promise<{ text: string }> {
    let current = message;
    for (const plugin of [...this.plugins.values()]) {
      for (const hook of [...plugin.afterReply]) {
        let result: unknown;
        try {
          result = await this.runAsync(plugin.spec.name, () => hook(current));
        } catch (error) {
          this.report(plugin.spec.name, error);
          continue;
        }
        if (typeof result === "string") current = { ...current, text: result };
        else if (result && typeof result === "object" && typeof (result as Incoming).text === "string") current = result as Incoming;
      }
    }
    return { text: current.text };
  }

  // MARK: Running plugin code

  private run(plugin: string, body: () => unknown): void {
    this.current = plugin;
    try {
      const result = body();
      if (result instanceof Promise) result.catch((error) => this.report(plugin, error));
    } catch (error) {
      this.report(plugin, error);
    } finally {
      this.current = null;
    }
  }

  private async runAsync(plugin: string, body: () => unknown): Promise<unknown> {
    this.current = plugin;
    try {
      return await body();
    } finally {
      this.current = null;
    }
  }

  /** A plugin threw: Botling counts it, and turns the plugin off if it keeps happening. */
  report(plugin: string | null, error: unknown): void {
    this.notify("pluginError", { plugin: plugin ?? this.current, message: errorText(error) });
  }
}

async function importPlugin(spec: HostPluginSpec): Promise<Activate> {
  // The fingerprint in the URL makes an edited plugin load fresh instead of from Node's cache.
  const url = `${pathToFileURL(spec.main).href}?v=${encodeURIComponent(spec.fingerprint)}`;
  const module = (await import(url)) as { activate?: Activate; default?: { activate?: Activate } };
  const activate = module.activate ?? module.default?.activate;
  if (typeof activate !== "function") throw new Error("The program part does not export activate(api).");
  return activate;
}

/** The most the host waits for stdout to drain before it exits on shutdown, in ms. */
const shutdownFallback = 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the host on stdin/stdout. */
export function main(): void {
  const out = process.stdout;
  const write = (message: Message) => out.write(JSON.stringify(message) + "\n");
  // Plugins printing must not break the protocol.
  const toStderr = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const host = new Host(write);
  // Exits once everything written has reached the pipe; a pipe that never drains (Botling
  // stopped reading) still lets it go after `shutdownFallback` ms.
  host.onShutdown = () => {
    setTimeout(() => process.exit(0), shutdownFallback).unref();
    out.write("", () => process.exit(0));
  };
  process.on("uncaughtException", (error) => host.report(null, error));
  process.on("unhandledRejection", (error) => host.report(null, error));
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void host.receive(message);
  });
  // Botling went away: so does the host.
  lines.on("close", () => process.exit(0));
  host.notify("ready", { pid: process.pid });
}

if (process.env.CCB_PLUGIN_HOST === "1") main();
