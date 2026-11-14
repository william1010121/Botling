// Botling's plugin host: one Node process that runs every plugin's program part (`ccb.host`).
// It talks to Botling over stdin/stdout, one JSON-RPC message per line (like LSP, without headers).
// Plugins' own console output goes to stderr so it cannot break the protocol.
//
// Each plugin's registrations (every disposer its api calls return, and what `activate` returns) are kept by Botling's
// plugin kernel (Web/src/plugin-kernel, kernel step 1): at unload they are undone newest first and may be async (each
// within a time limit); one that throws, rejects or hangs does not stop the others and is reported once (`unloadFailed`
// in the next `load` answer); a registration made after the unload started (an `activate` that settles late) is undone at
// once; a plugin another one requires (built-in declarations, given by `declarations`) unloads after it. When every
// disposer is synchronous an unload still completes inside the call, as before.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Kernel, type KernelTimers, type PluginDeclaration } from "../../src/plugin-kernel";
import { createApi, newLoaded, type BotlingApi, type HostPluginSpec, type Incoming, type JSONValue, type Loaded, type Outgoing, type PluginEventName, type WORKSPACE_EVENT } from "./api";

export type {
  AgyCall, AgyQuota, AgyQuotaBucket, AgyUsage, AppSettingKey, BotInfo, BotlingApi, BotSummary, CcbHost, HostPluginSpec, Incoming, Keybinding, NewBot, Outgoing, PluginEvents, ReplyTag, StatusItem,
  WorkspaceApi, WorkspaceChange, WorkspaceKind,
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

export interface HostOptions {
  /** How long one async disposer may take at unload before it counts as failed (default 5 s). */
  undoTimeoutMs?: number;
  timers?: KernelTimers;
  /** What a plugin declares to the kernel (`requires` / `provides`); none: it needs nothing (every 2.x plugin). */
  declarations?: (spec: HostPluginSpec) => Omit<PluginDeclaration, "name"> | null;
}

/** The kernel of the host's plugins: tells the host when an instance starts unloading, so nothing routes to it from then on. */
class HostKernel extends Kernel {
  constructor(private readonly started: (plugin: string, generation: number) => void, options: ConstructorParameters<typeof Kernel>[0]) {
    super(options);
  }

  protected override unloadStarted(plugin: string, generation: number): void {
    this.started(plugin, generation);
  }

  /** `promise`, or settled after the kernel's time limit (the one for undos), whichever is first; never rejects. */
  within(promise: Promise<unknown>): Promise<unknown> {
    return this.bounded(promise, () => {}).catch(() => {});
  }
}

export class Host {
  private readonly plugins = new Map<string, Loaded>();
  /** Each loaded plugin's kernel generation (which instance its registrations belong to). */
  private readonly generations = new WeakMap<Loaded, number>();
  private readonly kernel: HostKernel;
  /** Disposers that failed since the last `load` answer, which reports them once. */
  private unloadFailures: { name: string; message: string }[] = [];
  /** Registrations made so far (their keys in the kernel's log). */
  private registered = 0;
  /** `sync` calls so far: each asks for the whole list, so the newest decides and an older one still going steps aside. */
  private syncs = 0;
  /** Loads in progress, by plugin (a newer sync whose plugins wait for one of them waits for it before giving up). */
  private readonly loading = new Map<string, Promise<"waiting" | void>>();
  private readonly pending = new Map<number, { resolve: (value: JSONValue) => void; reject: (error: Error) => void }>();
  private nextID = 1;
  /** The plugin whose code is running, so a crash can be blamed on it. */
  private current: string | null = null;
  /** Told to shut down: once the answer is written, `onShutdown` ends the process. */
  private shuttingDown = false;
  /** What ends the host after the shutdown answer is written (`main` exits once stdout is flushed). */
  onShutdown: () => void = () => {};

  constructor(private readonly write: (message: Message) => void, private readonly importer: (spec: HostPluginSpec) => Promise<Activate> = importPlugin, private readonly options: HostOptions = {}) {
    this.kernel = new HostKernel((name, generation) => {
      const plugin = this.plugins.get(name);
      if (plugin && this.generations.get(plugin) === generation) this.plugins.delete(name);
    }, {
      ...(options.undoTimeoutMs !== undefined ? { undoTimeoutMs: options.undoTimeoutMs } : {}),
      ...(options.timers ? { timers: options.timers } : {}),
      onUndoFailure: (failure) => { this.unloadFailures.push({ name: failure.plugin, message: failure.message }); },
    });
  }

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
        const name = params.name as PluginEventName | typeof WORKSPACE_EVENT;
        for (const plugin of this.plugins.values()) {
          for (const listener of [...(plugin.events.get(name) ?? [])]) this.run(plugin.spec.name, () => listener(params.data));
        }
        return null;
      }
      case "replyTag": {
        // A bot's reply had a tag this plugin declared (Botling checked it is the plugin's).
        const plugin = this.plugins.get(params.plugin);
        const tag = { bot: params.bot, tag: params.tag, attributes: params.attributes ?? {}, body: params.body ?? "" };
        for (const listener of [...(plugin?.replyTags.get(params.tag) ?? [])]) this.run(plugin!.spec.name, () => listener(tag));
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
        // Started, not waited for: the process ends once the answer is written (as before the kernel).
        for (const name of [...this.plugins.keys()]) void this.unload(name);
        this.shuttingDown = true;
        return null;
      default:
        throw new Error(`Unknown method "${method}".`);
    }
  }

  // MARK: Plugins

  /**
   * Loads, reloads or unloads plugins so exactly `specs` run. A plugin whose unload is async is waited for (within the
   * kernel's time limit per disposer) before anything loads; `unloadFailed` (only when there are some) names the
   * disposers that failed since the last answer.
   */
  async sync(specs: HostPluginSpec[]): Promise<{ loaded: string[]; failed: { name: string; message: string }[]; timings: Record<string, number>; unloadFailed?: { name: string; message: string }[] }> {
    const ticket = ++this.syncs;
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    const unloading: Promise<void>[] = [];
    for (const [name, plugin] of [...this.plugins]) {
      // Unloaded meanwhile as a dependent of one unloaded before it.
      if (this.plugins.get(name) !== plugin) continue;
      const next = wanted.get(name);
      if (!next || next.fingerprint !== plugin.spec.fingerprint || next.main !== plugin.spec.main) {
        const gone = this.unload(name);
        // Only an unload still going is waited for: one that finished inside its call adds no wait (nor a tick).
        if (this.kernel.state(name) === "unloading") unloading.push(gone);
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
    if (unloading.length) await Promise.all(unloading);
    // What is not asked for any more leaves the kernel with its declaration, so another plugin may declare what it provided.
    if (ticket === this.syncs) {
      for (const name of this.kernel.installed()) if (!wanted.has(name) && this.kernel.state(name) === "absent") this.kernel.uninstall(name);
    }
    const failed: { name: string; message: string }[] = [];
    const timings: Record<string, number> = {};
    // A plugin whose required services are not there yet waits for the ones that provide them (none in 2.x).
    let waiting: HostPluginSpec[] = [];
    // Loads of older syncs already waited for: an `activate` has no time limit, so each is waited for once, within the
    // kernel's time limit, not again in every round.
    const waited = new Set<Promise<unknown>>();
    for (let round = [...specs], progress = true; round.length && progress;) {
      waiting = [];
      progress = false;
      for (const spec of round) {
        // A newer sync started while this one waited: it decides what runs (this one loads nothing more, and fails nothing).
        if (ticket !== this.syncs) { waiting = []; break; }
        if (this.plugins.has(spec.name) || failed.some((failure) => failure.name === spec.name)) continue;
        let depends: boolean;
        try {
          depends = this.declare(spec);
        } catch (error) {
          // A declaration the kernel refuses (a requires cycle, a service another plugin provides).
          failed.push({ name: spec.name, message: errorText(error) });
          continue;
        }
        if (depends && this.kernel.waitingFor(spec.name).length) { waiting.push(spec); continue; }
        progress = true;
        const started = performance.now();
        const instance: { generation?: number } = {};
        const going = this.load(spec, ticket, instance);
        this.loading.set(spec.name, going);
        try {
          // What it depends on started going while its code was imported (D65): it waits.
          if ((await going) === "waiting") waiting.push(spec);
          else timings[spec.name] = Math.round(performance.now() - started);
        } catch (error) {
          // Only this load's own failure counts: once another instance replaced it (whose load undid what it left), or,
          // before it started, once a newer sync took over, the failure is of code no longer asked for. Failing the
          // plugin then would unload the newer instance and mark the newer code failed.
          const own = instance.generation === undefined ? ticket === this.syncs : this.kernel.generation(spec.name) === instance.generation;
          if (own) {
            await this.unload(spec.name);
            failed.push({ name: spec.name, message: errorText(error) });
          }
        } finally {
          if (this.loading.get(spec.name) === going) this.loading.delete(spec.name);
        }
      }
      round = waiting;
      // Some wait for a plugin an older sync is still loading, or one still unloading (D65): wait for those, then try the
      // whole list again (a provider asked for that was unloaded meanwhile loads again first). A load is waited for once,
      // at most the kernel's time limit (an `activate` that never settles must not hang this sync too); an unload is
      // bounded already (each undo has the time limit).
      if (!progress && waiting.length && ticket === this.syncs) {
        const loads = [...this.loading.values()].filter((load) => !waited.has(load));
        for (const load of loads) waited.add(load);
        const going: Promise<unknown>[] = [
          ...loads.map((load) => this.kernel.within(load)),
          ...this.kernel.plugins().filter((name) => this.kernel.state(name) === "unloading").map((name) => this.kernel.requestUnload(name)),
        ];
        if (going.length) {
          progress = true;
          await Promise.all(going.map((each) => each.catch(() => {})));
          round = [...specs];
        }
      }
    }
    for (const spec of waiting) failed.push({ name: spec.name, message: `It needs ${this.kernel.waitingFor(spec.name).join(", ")}, which no loaded plugin provides.` });
    this.announce();
    const unloadFailed = this.unloadFailures.splice(0);
    return { loaded: [...this.plugins.keys()], failed, timings, ...(unloadFailed.length ? { unloadFailed } : {}) };
  }

  /** Gives the kernel the plugin's declaration (once per load); whether it depends on another (requires, slot contributions). */
  private declare(spec: HostPluginSpec): boolean {
    const declared = this.options.declarations?.(spec) ?? null;
    if (this.kernel.state(spec.name) === "absent") this.kernel.install({ name: spec.name, ...(declared ?? {}) });
    return !!(declared?.requires?.services?.length || declared?.contributes?.slots?.length);
  }

  /**
   * Loads `spec`'s code; "waiting": what it depends on is not active now (it started going while the code was imported).
   * `instance.generation` is the kernel generation it started, once it did (its caller tells its own failure by it).
   */
  private async load(spec: HostPluginSpec, ticket: number, instance: { generation?: number }): Promise<"waiting" | void> {
    const activate = await this.importer(spec);
    // Still unloading (an async disposer of the code it replaces), or loaded by a call that overlapped: gone first. Each
    // wait may end with another sync's instance there, so it is looked at again; once a newer sync started, it decides.
    for (;;) {
      if (ticket !== this.syncs) return;
      if (this.kernel.state(spec.name) === "absent") break;
      await this.unload(spec.name);
    }
    this.declare(spec);
    if (this.kernel.waitingFor(spec.name).length) return "waiting";
    const plugin = newLoaded(spec);
    const generation = this.kernel.startLoad(spec.name);
    instance.generation = generation;
    this.generations.set(plugin, generation);
    this.plugins.set(spec.name, plugin);
    this.current = spec.name;
    try {
      const result = await activate(createApi(this, plugin));
      if (typeof result === "function") this.own(plugin, result);
    } finally {
      this.current = null;
    }
    // Unloaded while `activate` ran: it stays unloaded (what it registered late was undone at once).
    if (this.kernel.state(spec.name) !== "loading" || this.kernel.generation(spec.name) !== generation) return;
    // What it declares it provides is there once it is up (the host carries no calls between plugins yet).
    for (const service of this.kernel.declaration(spec.name)?.provides?.services ?? []) this.kernel.provide(spec.name, service, spec.name);
    for (const slot of this.kernel.declaration(spec.name)?.provides?.slots ?? []) this.kernel.provideSlot(spec.name, slot);
    this.kernel.activate(spec.name);
  }

  /**
   * Unloads a plugin: nothing routes to it from now on (nor to the plugins that require it, which unload first), and its
   * disposers run newest first. Settles when it is gone; when every disposer was synchronous it is gone already on return.
   */
  unload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin) this.plugins.delete(name);
    if (this.kernel.state(name) === "absent") return Promise.resolve();
    return this.kernel.requestUnload(name).then(() => undefined);
  }

  isLoaded(name: string): boolean {
    return this.plugins.has(name);
  }

  /** One of `plugin`'s registrations (api.ts `own`): kept by the kernel for that instance, or undone at once if it is unloading. */
  own(plugin: Loaded, dispose: Dispose): Dispose {
    const generation = this.generations.get(plugin);
    if (generation === undefined) { plugin.disposers.push(dispose); return dispose; }
    const registration = this.kernel.register(plugin.spec.name, "disposer", String(++this.registered), dispose, generation);
    return registration ? () => { registration.dispose(); } : () => {};
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

  /** `announce` now, while `plugin` is still the one loaded. */
  announceNow(plugin: Loaded): void {
    if (this.plugins.get(plugin.spec.name) === plugin) this.announce();
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
