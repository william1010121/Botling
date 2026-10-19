import * as commands from "@codemirror/commands";
import * as state from "@codemirror/state";
import * as view from "@codemirror/view";
import type MarkdownIt from "markdown-it";
import { post } from "./bridge";
import { md, resetMarkdown } from "./markdown";
import { extensions } from "./messages";

/** A plugin's web part, as the Swift side sends it. */
export interface PluginSpec {
  name: string;
  version: string;
  /** The bundled ES module text of `deck.web`; it must export `activate(deck)`. */
  source: string;
  /** file:// URLs of stylesheets the plugin ships (fonts next to them load relative to them). */
  styles: string[];
  settings: Record<string, unknown>;
  /** `deck.contributes.commands`: id, title and an optional key like "cmd+shift+l". */
  commands: { id: string; title: string; key?: string }[];
}

type Dispose = () => void;

/** Rendering a component a plugin registered: draw into `root`, answer through `answer`. */
export type ComponentRender = (root: HTMLElement, data: unknown, answer: (value: number | string) => void) => void | Dispose;

/** What the chat lends the plugin host: the input box and redrawing. */
export interface ChatHooks {
  composer: {
    element: HTMLElement;
    view: view.EditorView;
    getText(): string;
    insert(text: string): void;
    addExtension(extension: state.Extension): Dispose;
    showPopover(content: HTMLElement | string): Dispose;
  };
  /** Draw every message again (after a renderer changed). */
  redraw(): void;
}

/** The `deck` object a plugin's `activate` receives. */
export interface DeckWeb {
  name: string;
  codemirror: { state: typeof state; view: typeof view; commands: typeof commands };
  composer: ChatHooks["composer"] & { onKeyDown(handler: (event: KeyboardEvent) => boolean | void): Dispose };
  messages: {
    use(plugin: (md: MarkdownIt) => void): void;
    afterRender(handler: (element: HTMLElement, message: { id: string; role: string; text: string }) => void): Dispose;
  };
  components: { register(name: string, render: ComponentRender): Dispose };
  /** A page in the right column, declared in contributes.panels; drawn when you open it. */
  panels: { register(id: string, render: (root: HTMLElement) => void | Dispose): Dispose };
  commands: { register(id: string, run: () => void): Dispose; execute(id: string): void };
  settings: { get<T>(key: string): T; onChange(key: string, handler: (value: unknown) => void): Dispose };
  notify(text: string): void;
  host: { call(method: string, params?: unknown): Promise<unknown> };
}

type Activate = (deck: DeckWeb) => void | Dispose | Promise<void | Dispose>;

interface Loaded {
  spec: PluginSpec;
  disposers: Dispose[];
}

/**
 * Runs plugins' web parts in the chat page. Each runs inside try/catch: a plugin that throws is
 * unloaded and reported to Swift, which turns its web part off; the chat keeps working.
 */
export class PluginHost {
  private readonly loaded = new Map<string, Loaded>();
  private readonly settingHandlers = new Map<string, ((value: unknown) => void)[]>();
  /** markdown-it plugins by plugin, reapplied whenever the renderer is rebuilt. */
  private readonly markdownPlugins: { plugin: string; use: (md: MarkdownIt) => void }[] = [];
  private readonly commandRuns = new Map<string, () => void>();
  private readonly keyHandlers: { plugin: string; handler: (event: KeyboardEvent) => boolean | void }[] = [];
  private markdownChanged = false;
  /** Called when a plugin registers a panel (the panel page waits for its own). */
  onPanels: (() => void) | null = null;
  /** host.call requests waiting for the plugin host's answer. */
  private readonly hostCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextCall = 1;

  constructor(private readonly hooks: ChatHooks) {
    document.addEventListener("keydown", (event) => this.runShortcut(event), true);
    extensions.guard = (plugin, run) => this.guard(plugin, run);
  }

  /** Loads, reloads or unloads plugins so exactly `specs` run. Each is loaded from its source. */
  async sync(specs: PluginSpec[], importer: (spec: PluginSpec) => Promise<Activate> = importModule): Promise<void> {
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    for (const [name, entry] of this.loaded) {
      const next = wanted.get(name);
      if (!next || next.version !== entry.spec.version || next.source !== entry.spec.source) {
        this.unload(name);
      } else if (JSON.stringify(next.settings) !== JSON.stringify(entry.spec.settings)) {
        this.updateSettings(name, entry.spec.settings, next.settings);
        entry.spec = next;
      }
    }
    for (const spec of specs) {
      if (this.loaded.has(spec.name)) continue;
      try {
        await this.load(spec, await importer(spec));
      } catch (error) {
        this.fail(spec.name, error);
      }
    }
    this.redrawIfChanged();
  }

  private redrawIfChanged(): void {
    if (!this.markdownChanged) return;
    this.markdownChanged = false;
    this.hooks.redraw();
  }

  /** Runs one plugin's `activate`. */
  async load(spec: PluginSpec, activate: Activate): Promise<void> {
    const entry: Loaded = { spec, disposers: [] };
    this.loaded.set(spec.name, entry);
    for (const href of spec.styles) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.plugin = spec.name;
      document.head.append(link);
      entry.disposers.push(() => link.remove());
    }
    try {
      const result = await activate(this.api(spec.name, entry));
      if (typeof result === "function") entry.disposers.push(result);
      // Deck keeps this version as the one to fall back to if a later one breaks.
      if (this.loaded.get(spec.name) === entry) post({ type: "pluginLoaded", name: spec.name, version: spec.version });
    } catch (error) {
      this.fail(spec.name, error);
    }
  }

  unload(name: string): void {
    const entry = this.loaded.get(name);
    if (!entry) return;
    this.loaded.delete(name);
    for (const dispose of entry.disposers.reverse()) {
      try { dispose(); } catch { /* a plugin's cleanup failing does not stop the others */ }
    }
    this.settingHandlers.forEach((handlers, key) => {
      if (key.startsWith(`${name}\u0000`)) this.settingHandlers.delete(key);
    });
    // markdown-it plugins cannot be taken out: rebuild the renderer with the ones still loaded.
    const kept = this.markdownPlugins.filter((entry) => entry.plugin !== name);
    if (kept.length !== this.markdownPlugins.length) {
      this.markdownPlugins.splice(0, this.markdownPlugins.length, ...kept);
      const fresh = resetMarkdown();
      for (const entry of kept) this.guard(entry.plugin, () => entry.use(fresh));
    }
    this.markdownChanged = true;
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Runs a plugin hook, reporting and unloading the plugin if it throws. */
  guard<T>(plugin: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.fail(plugin, error);
      return undefined;
    }
  }

  fail(name: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.unload(name);
    post({ type: "pluginError", name, message });
    this.redrawIfChanged();
  }

  /** Commands from plugins' manifests that have a key, e.g. "cmd+shift+l". */
  private runShortcut(event: KeyboardEvent): void {
    for (const entry of this.loaded.values()) {
      for (const command of entry.spec.commands) {
        if (command.key && matches(command.key, event) && this.commandRuns.has(command.id)) {
          event.preventDefault();
          this.execute(command.id);
          return;
        }
      }
    }
  }

  /** Runs a command: in the page if a web part registered it, otherwise in the plugin host. */
  execute(id: string): void {
    const run = this.commandRuns.get(id);
    const plugin = id.split(".")[0];
    if (run) this.guard(plugin, run);
    else post({ type: "command", id });
  }

  /** The plugin host answered a `host.call`. */
  hostReply(callID: number, ok: boolean, value: unknown): void {
    const waiter = this.hostCalls.get(callID);
    if (!waiter) return;
    this.hostCalls.delete(callID);
    if (ok) waiter.resolve(value);
    else waiter.reject(new Error(String(value)));
  }

  /** Key presses offered to plugins before the input box handles them. */
  handleKey(event: KeyboardEvent): boolean {
    for (const { plugin, handler } of this.keyHandlers) {
      if (this.guard(plugin, () => handler(event)) === true) return true;
    }
    return false;
  }

  private updateSettings(name: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      for (const handler of this.settingHandlers.get(`${name}\u0000${key}`) ?? []) {
        this.guard(name, () => handler(after[key]));
      }
    }
  }

  private api(name: string, entry: Loaded): DeckWeb {
    const own = (dispose: Dispose): Dispose => {
      entry.disposers.push(dispose);
      return dispose;
    };
    const remove = <T>(list: T[], item: T) => () => {
      const at = list.indexOf(item);
      if (at !== -1) list.splice(at, 1);
    };
    return {
      name,
      codemirror: { state, view, commands },
      composer: {
        ...this.hooks.composer,
        addExtension: (extension) => own(this.hooks.composer.addExtension(extension)),
        showPopover: (content) => own(this.hooks.composer.showPopover(content)),
        onKeyDown: (handler) => {
          const item = { plugin: name, handler };
          this.keyHandlers.push(item);
          return own(remove(this.keyHandlers, item));
        },
      },
      messages: {
        use: (plugin) => {
          plugin(md);
          this.markdownPlugins.push({ plugin: name, use: plugin });
          this.markdownChanged = true;
        },
        afterRender: (handler) => {
          const item = { plugin: name, handler };
          extensions.afterRender.push(item);
          this.markdownChanged = true;
          return own(remove(extensions.afterRender, item));
        },
      },
      components: {
        register: (component, render) => {
          extensions.components.set(component, { plugin: name, render });
          this.markdownChanged = true;
          return own(() => { extensions.components.delete(component); });
        },
      },
      panels: {
        register: (id, render) => {
          const key = `${name}/${id}`;
          extensions.panels.set(key, { plugin: name, render });
          this.onPanels?.();
          return own(() => { extensions.panels.delete(key); });
        },
      },
      commands: {
        register: (id, run) => {
          this.commandRuns.set(id, run);
          return own(() => this.commandRuns.delete(id));
        },
        execute: (id) => this.execute(id),
      },
      settings: {
        get: <T>(key: string) => this.loaded.get(name)?.spec.settings[key] as T,
        onChange: (key, handler) => {
          const slot = `${name}\u0000${key}`;
          const list = this.settingHandlers.get(slot) ?? [];
          list.push(handler);
          this.settingHandlers.set(slot, list);
          return own(remove(list, handler));
        },
      },
      notify: (text) => post({ type: "pluginNotice", name, text }),
      host: {
        call: (method, params) => new Promise((resolve, reject) => {
          const callID = this.nextCall++;
          this.hostCalls.set(callID, { resolve, reject });
          post({ type: "hostCall", plugin: name, method, params: params ?? null, callID });
        }),
      },
    };
  }
}

/** Loads a bundled ES module from its text. A failed import is tried once more before it counts. */
async function importModule(spec: PluginSpec): Promise<Activate> {
  try {
    return await importOnce(spec);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return importOnce(spec);
  }
}

async function importOnce(spec: PluginSpec): Promise<Activate> {
  const url = URL.createObjectURL(new Blob([spec.source], { type: "text/javascript" }));
  try {
    const module = (await import(/* @vite-ignore */ url)) as { activate?: Activate; default?: { activate?: Activate } };
    const activate = module.activate ?? module.default?.activate;
    if (typeof activate !== "function") throw new Error("網頁部分沒有匯出 activate(deck)。");
    return activate;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "cmd+shift+l" against a key event. */
export function matches(key: string, event: KeyboardEvent): boolean {
  const parts = key.toLowerCase().split("+");
  const letter = parts.pop();
  return (
    event.key.toLowerCase() === letter &&
    event.metaKey === parts.includes("cmd") &&
    event.ctrlKey === parts.includes("ctrl") &&
    event.altKey === (parts.includes("alt") || parts.includes("option")) &&
    event.shiftKey === parts.includes("shift")
  );
}
