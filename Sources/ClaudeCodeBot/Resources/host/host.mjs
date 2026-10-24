// host/src/host.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
var Host = class {
  constructor(write, importer = importPlugin) {
    this.write = write;
    this.importer = importer;
  }
  write;
  importer;
  plugins = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  nextID = 1;
  /** The plugin whose code is running, so a crash can be blamed on it. */
  current = null;
  /** Told to shut down: once the answer is written, `onShutdown` ends the process. */
  shuttingDown = false;
  /** What ends the host after the shutdown answer is written (`main` exits once stdout is flushed). */
  onShutdown = () => {
  };
  // MARK: Protocol
  async receive(message) {
    if (message.method === void 0) {
      const waiter = message.id === void 0 ? void 0 : this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    try {
      const result = await this.handle(message.method, message.params ?? {});
      if (message.id !== void 0) this.write({ id: message.id, result: result ?? null });
    } catch (error) {
      if (message.id !== void 0) this.write({ id: message.id, error: { message: errorText(error) } });
    }
    if (this.shuttingDown) this.onShutdown();
  }
  request(method, params) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method, params) {
    this.write({ method, params });
  }
  async handle(method, params) {
    switch (method) {
      case "ping":
        return "pong";
      case "load":
        return this.sync(params.plugins);
      case "beforeSend":
        return this.beforeSend(params);
      case "afterReply":
        return this.afterReply(params);
      case "reply":
        for (const plugin of this.plugins.values()) {
          for (const listener of plugin.replyListeners) this.run(plugin.spec.name, () => listener(params.bot, params.text));
        }
        return null;
      case "command": {
        const owner = [...this.plugins.values()].find((plugin) => plugin.commands.has(params.id));
        if (!owner) throw new Error(`No command "${params.id}".`);
        return this.runAsync(owner.spec.name, () => owner.commands.get(params.id)(...params.args ?? []));
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
  async sync(specs) {
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    for (const [name, plugin] of this.plugins) {
      const next = wanted.get(name);
      if (!next || next.fingerprint !== plugin.spec.fingerprint || next.main !== plugin.spec.main) {
        this.unload(name);
      } else if (JSON.stringify(next.settings) !== JSON.stringify(plugin.spec.settings)) {
        const before = plugin.spec.settings;
        plugin.spec = next;
        for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(next.settings)])) {
          if (JSON.stringify(before[key]) === JSON.stringify(next.settings[key])) continue;
          for (const handler of plugin.settingHandlers.get(key) ?? []) this.run(name, () => handler(next.settings[key]));
        }
      }
    }
    const failed = [];
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
  async load(spec) {
    const activate = await this.importer(spec);
    const plugin = {
      spec,
      disposers: [],
      beforeSend: [],
      afterReply: [],
      replyListeners: [],
      commands: /* @__PURE__ */ new Map(),
      web: /* @__PURE__ */ new Map(),
      settingHandlers: /* @__PURE__ */ new Map()
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
  unload(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    this.plugins.delete(name);
    for (const dispose of plugin.disposers.reverse()) {
      try {
        dispose();
      } catch {
      }
    }
  }
  isLoaded(name) {
    return this.plugins.has(name);
  }
  /** Tells Botling which hooks and commands exist, so it only asks when someone is listening. */
  announce() {
    const plugins = [...this.plugins.values()];
    this.notify("registered", {
      beforeSend: plugins.reduce((sum, plugin) => sum + plugin.beforeSend.length, 0),
      afterReply: plugins.reduce((sum, plugin) => sum + plugin.afterReply.length, 0),
      commands: plugins.flatMap((plugin) => [...plugin.commands.keys()])
    });
  }
  // MARK: Hooks
  async beforeSend(message) {
    let current = message;
    for (const plugin of [...this.plugins.values()]) {
      for (const hook of [...plugin.beforeSend]) {
        let result;
        try {
          result = await this.runAsync(plugin.spec.name, () => hook(current));
        } catch (error) {
          this.report(plugin.spec.name, error);
          continue;
        }
        if (result === false) return { cancel: true, by: plugin.spec.name };
        if (typeof result === "string") current = { ...current, text: result };
        else if (result && typeof result === "object" && typeof result.text === "string") current = result;
      }
    }
    return { text: current.text };
  }
  async afterReply(message) {
    let current = message;
    for (const plugin of [...this.plugins.values()]) {
      for (const hook of [...plugin.afterReply]) {
        let result;
        try {
          result = await this.runAsync(plugin.spec.name, () => hook(current));
        } catch (error) {
          this.report(plugin.spec.name, error);
          continue;
        }
        if (typeof result === "string") current = { ...current, text: result };
        else if (result && typeof result === "object" && typeof result.text === "string") current = result;
      }
    }
    return { text: current.text };
  }
  // MARK: Running plugin code
  run(plugin, body) {
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
  async runAsync(plugin, body) {
    this.current = plugin;
    try {
      return await body();
    } finally {
      this.current = null;
    }
  }
  /** A plugin threw: Botling counts it, and turns the plugin off if it keeps happening. */
  report(plugin, error) {
    this.notify("pluginError", { plugin: plugin ?? this.current, message: errorText(error) });
  }
  api(plugin) {
    const name = plugin.spec.name;
    const own = (dispose) => {
      plugin.disposers.push(dispose);
      return dispose;
    };
    const remove = (list, item) => own(() => {
      const at = list.indexOf(item);
      if (at !== -1) list.splice(at, 1);
    });
    const announceLater = () => queueMicrotask(() => {
      if (this.plugins.get(name) === plugin) this.announce();
    });
    let stored = null;
    const storageFile = join(plugin.spec.storageDir, "storage.json");
    const storage = () => {
      if (stored) return stored;
      try {
        stored = JSON.parse(readFileSync(storageFile, "utf8"));
      } catch {
        stored = {};
      }
      return stored;
    };
    mkdirSync(plugin.spec.storageDir, { recursive: true });
    return {
      name,
      browser: {
        registerTool: (tool, run) => {
          const method = `browser.tool.${tool.id}`;
          plugin.web.set(method, run);
          this.notify("browser.register", { ...tool, plugin: name });
          return own(() => {
            plugin.web.delete(method);
            this.notify("browser.unregister", { id: tool.id, plugin: name });
          });
        },
        perform: async (operation) => this.request("browser.perform", { ...operation, plugin: name })
      },
      bots: {
        list: async () => await this.request("bots.list", {}),
        create: async (bot) => await this.request("bots.create", { plugin: name, name: bot?.name, job: bot?.job, avatar: bot?.avatar }),
        send: (botId, text) => this.notify("bots.send", { plugin: name, bot: botId, text }),
        onReply: (fn) => {
          plugin.replyListeners.push(fn);
          return remove(plugin.replyListeners, fn);
        }
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
        }
      },
      commands: {
        register: (id, run) => {
          plugin.commands.set(id, run);
          announceLater();
          return own(() => plugin.commands.delete(id));
        }
      },
      routines: {
        add: async (botId, cron, task) => {
          await this.request("routines.add", { plugin: name, bot: botId, cron, task });
        }
      },
      storage: {
        dir: plugin.spec.storageDir,
        get: (key) => storage()[key],
        set: (key, value) => {
          storage()[key] = value;
          writeFileSync(storageFile, JSON.stringify(storage(), null, 2));
        }
      },
      web: {
        handle: (method, fn) => {
          plugin.web.set(method, fn);
          return own(() => plugin.web.delete(method));
        }
      },
      settings: {
        get: (key) => plugin.spec.settings[key],
        onChange: (key, fn) => {
          const list = plugin.settingHandlers.get(key) ?? [];
          list.push(fn);
          plugin.settingHandlers.set(key, list);
          return remove(list, fn);
        }
      },
      notify: (text) => this.notify("notify", { plugin: name, text })
    };
  }
};
async function importPlugin(spec) {
  const url = `${pathToFileURL(spec.main).href}?v=${encodeURIComponent(spec.fingerprint)}`;
  const module = await import(url);
  const activate = module.activate ?? module.default?.activate;
  if (typeof activate !== "function") throw new Error("The program part does not export activate(ccb).");
  return activate;
}
var shutdownFallback = 1e3;
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function main() {
  const out = process.stdout;
  const write = (message) => out.write(JSON.stringify(message) + "\n");
  const toStderr = (...parts) => process.stderr.write(parts.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const host = new Host(write);
  host.onShutdown = () => {
    setTimeout(() => process.exit(0), shutdownFallback).unref();
    out.write("", () => process.exit(0));
  };
  process.on("uncaughtException", (error) => host.report(null, error));
  process.on("unhandledRejection", (error) => host.report(null, error));
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void host.receive(message);
  });
  lines.on("close", () => process.exit(0));
  host.notify("ready", { pid: process.pid });
}
if (process.env.CCB_PLUGIN_HOST === "1") main();
export {
  Host,
  main
};
