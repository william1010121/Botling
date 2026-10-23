// Botling's plugin host: one Node process that runs every plugin's program part (`ccb.host`).
// It talks to Botling over stdin/stdout, one JSON-RPC message per line (like LSP, without headers).
// Plugins' own console output goes to stderr so it cannot break the protocol.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type Dispose = () => void;
type JSONValue = unknown;

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: JSONValue;
  error?: { message: string };
}

/** What Botling sends for each plugin with a program part. */
export interface HostPluginSpec {
  name: string;
  version: string;
  /** Absolute path of the bundled ES module that exports `activate(ccb)`. */
  main: string;
  /** Changes whenever the plugin's files change, so a new version is imported fresh. */
  fingerprint: string;
  settings: Record<string, JSONValue>;
  /** A folder the plugin may keep data in. */
  storageDir: string;
}

/** "bot" is a bot of its own (made with `bots.create`), not a project's manager. */
export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean; created?: boolean }
/** A new bot: its name in the left column, what it is for, and optionally its shape. */
export interface NewBot { name: string; job: string; avatar?: string }
export interface Outgoing { bot: BotInfo; text: string }
export interface Incoming { bot: BotInfo; text: string }

/** The `ccb` object a program part's `activate` receives. */
export interface CcbHost {
  name: string;
  bots: {
    list(): Promise<BotInfo[]>;
    /**
     * Makes a bot of its own (`created: true`), or returns the one this plugin made by that name
     * (`created: false`). Throws if the name is someone else's or the user removed it. Needs the
     * "bots" permission.
     */
    create(bot: NewBot): Promise<BotInfo>;
    send(botId: string, text: string): void;
    onReply(fn: (bot: BotInfo, reply: string) => void): Dispose;
  };
  hooks: {
    /** Return new text, or false to stop the message from being sent. */
    beforeSend(fn: (message: Outgoing) => Outgoing | string | false | void | Promise<Outgoing | string | false | void>): Dispose;
    afterReply(fn: (message: Incoming) => Incoming | string | void | Promise<Incoming | string | void>): Dispose;
  };
  commands: { register(id: string, run: (...args: unknown[]) => unknown): Dispose };
  routines: { add(botId: string, cron: string, task: string): Promise<void> };
  storage: { dir: string; get(key: string): unknown; set(key: string, value: unknown): void };
  web: { handle(method: string, fn: (params: unknown) => unknown): Dispose };
  settings: { get<T>(key: string): T; onChange(key: string, fn: (value: unknown) => void): Dispose };
  notify(text: string): void;
}

type Activate = (ccb: CcbHost) => void | Dispose | Promise<void | Dispose>;

interface Loaded {
  spec: HostPluginSpec;
  disposers: Dispose[];
  beforeSend: ((message: Outgoing) => unknown)[];
  afterReply: ((message: Incoming) => unknown)[];
  replyListeners: ((bot: BotInfo, reply: string) => void)[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  web: Map<string, (params: unknown) => unknown>;
  settingHandlers: Map<string, ((value: unknown) => void)[]>;
}

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
      case "command": {
        const owner = [...this.plugins.values()].find((plugin) => plugin.commands.has(params.id));
        if (!owner) throw new Error(`No command "${params.id}".`);
        return this.runAsync(owner.spec.name, () => owner.commands.get(params.id)!(...(params.args ?? [])));
      }
      case "web": {
        const plugin = this.plugins.get(params.plugin);
        const handler = plugin?.web.get(params.method);
        if (!plugin || !handler) throw new Error(`Plugin "${params.plugin}" does not handle "${params.method}".`);
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
      } else if (JSON.stringify(next.settings) !== JSON.stringify(plugin.spec.settings)) {
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
    const plugin: Loaded = {
      spec,
      disposers: [],
      beforeSend: [],
      afterReply: [],
      replyListeners: [],
      commands: new Map(),
      web: new Map(),
      settingHandlers: new Map(),
    };
    this.plugins.set(spec.name, plugin);
    this.current = spec.name;
    try {
      const result = await activate(this.api(plugin));
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

  /** Tells Botling which hooks and commands exist, so it only asks when someone is listening. */
  private announce(): void {
    const plugins = [...this.plugins.values()];
    this.notify("registered", {
      beforeSend: plugins.reduce((sum, plugin) => sum + plugin.beforeSend.length, 0),
      afterReply: plugins.reduce((sum, plugin) => sum + plugin.afterReply.length, 0),
      commands: plugins.flatMap((plugin) => [...plugin.commands.keys()]),
    });
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

  private api(plugin: Loaded): CcbHost {
    const name = plugin.spec.name;
    const own = (dispose: Dispose): Dispose => {
      plugin.disposers.push(dispose);
      return dispose;
    };
    const remove = <T>(list: T[], item: T) => own(() => {
      const at = list.indexOf(item);
      if (at !== -1) list.splice(at, 1);
    });
    const announceLater = () => queueMicrotask(() => { if (this.plugins.get(name) === plugin) this.announce(); });
    let stored: Record<string, unknown> | null = null;
    const storageFile = join(plugin.spec.storageDir, "storage.json");
    const storage = () => {
      if (stored) return stored;
      try { stored = JSON.parse(readFileSync(storageFile, "utf8")); } catch { stored = {}; }
      return stored!;
    };
    mkdirSync(plugin.spec.storageDir, { recursive: true });

    return {
      name,
      bots: {
        list: async () => (await this.request("bots.list", {})) as BotInfo[],
        create: async (bot) => (await this.request("bots.create", { plugin: name, name: bot?.name, job: bot?.job, avatar: bot?.avatar })) as BotInfo,
        send: (botId, text) => this.notify("bots.send", { plugin: name, bot: botId, text }),
        onReply: (fn) => {
          plugin.replyListeners.push(fn);
          return remove(plugin.replyListeners, fn);
        },
      },
      hooks: {
        beforeSend: (fn) => {
          plugin.beforeSend.push(fn);
          announceLater();
          return remove(plugin.beforeSend, fn);
        },
        afterReply: (fn) => {
          plugin.afterReply.push(fn);
          announceLater();
          return remove(plugin.afterReply, fn);
        },
      },
      commands: {
        register: (id, run) => {
          plugin.commands.set(id, run);
          announceLater();
          return own(() => plugin.commands.delete(id));
        },
      },
      routines: {
        add: async (botId, cron, task) => { await this.request("routines.add", { plugin: name, bot: botId, cron, task }); },
      },
      storage: {
        dir: plugin.spec.storageDir,
        get: (key) => storage()[key],
        set: (key, value) => {
          storage()[key] = value;
          writeFileSync(storageFile, JSON.stringify(storage(), null, 2));
        },
      },
      web: {
        handle: (method, fn) => {
          plugin.web.set(method, fn);
          return own(() => plugin.web.delete(method));
        },
      },
      settings: {
        get: <T>(key: string) => plugin.spec.settings[key] as T,
        onChange: (key, fn) => {
          const list = plugin.settingHandlers.get(key) ?? [];
          list.push(fn);
          plugin.settingHandlers.set(key, list);
          return remove(list, fn);
        },
      },
      notify: (text) => this.notify("notify", { plugin: name, text }),
    };
  }
}

async function importPlugin(spec: HostPluginSpec): Promise<Activate> {
  // The fingerprint in the URL makes an edited plugin load fresh instead of from Node's cache.
  const url = `${pathToFileURL(spec.main).href}?v=${encodeURIComponent(spec.fingerprint)}`;
  const module = (await import(url)) as { activate?: Activate; default?: { activate?: Activate } };
  const activate = module.activate ?? module.default?.activate;
  if (typeof activate !== "function") throw new Error("The program part does not export activate(ccb).");
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
