import * as commands from "@codemirror/commands";
import * as state from "@codemirror/state";
import * as view from "@codemirror/view";
import type MarkdownIt from "markdown-it";
import { post } from "./bridge";
import { commandCard, componentElement, componentSizes, detailTarget, hasFrame, keepFrames, markStatusFrames, maxColumns, maxRows, pinSize, pinSizes, reportComponent, resizeFrame, sizeInfo } from "./components";
import type { ChipHandle, ComposerChip } from "./composer";
import { DecorationLayer, type DecorationRenderer } from "./decorations";
import { ownsCommand } from "./frame-protocol";
import { isComposingEnter } from "./ime";
import { language, pieces, t } from "./i18n";
import { intervalRow, LiveSchedule, liveTick, parseInterval, presetMinutes, presetSeconds, refreshWords } from "./refresh";
import { mediaHTML, md, renderMarkdown, resetMarkdown } from "./markdown";
import { extensions } from "./messages";
import { taskCardChipHTML } from "./task-cards";
import type { Action, ChatState, DisplayView, SpecChipView, TaskCardView } from "./types";
import { onScreen, setWindowListener, whenShownAgain, windowVisible } from "./visible";

/** A plugin's web part, as the Swift side sends it. */
export interface PluginSpec {
  name: string;
  version: string;
  /** The bundled ES module text of `ccb.web`; it must export `activate(ccb)`. */
  source: string;
  /** file:// URLs of stylesheets the plugin ships (fonts next to them load relative to them). */
  styles: string[];
  settings: Record<string, unknown>;
  /** `ccb.contributes.commands`: id, title and an optional key ("cmd+shift+l"; the page's key dispatcher reads it). */
  commands: { id: string; title: string; key?: string }[];
  /** Ships with Botling: only such a web part may use `ccb.page` and the message bars (a library plugin gets neither: they hand over the page's own parts). */
  builtIn?: boolean;
}

type Dispose = () => void;

/**
 * Rendering a component a plugin registered: draw into `root`, answer through `answer` (an
 * option's index, words, or `{text, images}` with pictures as `{name, base64}`).
 */
export type ComponentRender = (
  root: HTMLElement,
  data: unknown,
  answer: (value: number | string | { text?: string; images?: { name: string; base64: string }[] }) => void,
) => void | Dispose;

/** What the chat lends the plugin host: the input box and redrawing. */
export interface ChatHooks {
  composer: {
    element: HTMLElement;
    view: view.EditorView;
    getText(): string;
    insert(text: string): void;
    addExtension(extension: state.Extension): Dispose;
    showPopover(content: HTMLElement | string): Dispose;
    /** Chips above the box in the chat open now (`list`: every plugin's). */
    chips: { add(chip: ComposerChip): ChipHandle; list(): ChipHandle[] };
  };
  /** Draw every message again (after a renderer changed). */
  redraw(): void;
  /** The places in the page a plugin may fill (page.slots). */
  slots?: PageSlots;
}

/** Elements of the chat page a plugin may fill: above the input box, the Board's place instead of the messages, and over the whole page. */
export interface PageSlots { pinArea: HTMLElement; board: HTMLElement; overlay: HTMLElement }

/**
 * What the chat page lends a plugin that draws cards of its own over it (botling.board, the Board and pins; plugin-extraction.md §3.3,
 * plugin-platform.md M8): the state it draws from, a way to post what the user did, the page's words and clocks, and the
 * component frames. The same functions the page draws its own cards with, so a card is one thing wherever it shows.
 */
export interface PageKit {
  slots: PageSlots;
  /** Called with the chat's state after each draw (and at once, with the latest, when it is added). */
  onState(fn: (state: ChatState) => void): Dispose;
  /** Told whether the app's window is shown (`ccb.setWindowVisible`). */
  onWindowVisible(fn: () => void): Dispose;
  post(action: Action): void;
  /** Calls what this plugin's program part exposes (`ui.expose`), as `ccb.call`. */
  call(method: string, params?: unknown): Promise<unknown>;
  /**
   * Asks the user, on the app page's ApprovalSheet, to allow a command of a component's card in a bot's folder. The core says what the
   * sheet shows (the command, its folder, the component's Detail command), never the page; true once Allow was pressed.
   */
  requestApproval(ask: { botId: string; command: string; folder: string; component: string; card?: string }): Promise<boolean>;
  t: typeof t;
  language: typeof language;
  pieces: typeof pieces;
  isComposingEnter: typeof isComposingEnter;
  /** Whether the window is shown, whether an element is in view, and what runs again when the window is shown. */
  visible: { windowVisible: typeof windowVisible; onScreen: typeof onScreen; whenShownAgain: typeof whenShownAgain };
  refresh: { intervalRow: typeof intervalRow; LiveSchedule: typeof LiveSchedule; liveTick: number; parseInterval: typeof parseInterval; presetMinutes: number; presetSeconds: number; refreshWords: typeof refreshWords };
  components: {
    commandCard: typeof commandCard; componentElement: typeof componentElement; componentSizes: typeof componentSizes; detailTarget: typeof detailTarget;
    hasFrame: typeof hasFrame; keepFrames: typeof keepFrames; markStatusFrames: typeof markStatusFrames; maxColumns: number; maxRows: number;
    pinSize: typeof pinSize; pinSizes: typeof pinSizes; reportComponent: typeof reportComponent; resizeFrame: typeof resizeFrame; sizeInfo: typeof sizeInfo;
  };
}

/** The `ccb` object a plugin's `activate` receives. */
export interface CcbWeb {
  name: string;
  codemirror: { state: typeof state; view: typeof view; commands: typeof commands };
  composer: ChatHooks["composer"] & {
    onKeyDown(handler: (event: KeyboardEvent) => boolean | void): Dispose;
    /** A paste of text, before the box takes it; return true to take it yourself. */
    onPaste(handler: (text: string, event: ClipboardEvent) => boolean | void): Dispose;
  };
  messages: {
    use(plugin: (md: MarkdownIt) => void): void;
    /** What the bubble of your own message shows, from its text (each handler gets what the one before left; empty: no bubble). */
    userText(handler: (text: string) => string): Dispose;
    afterRender(handler: (element: HTMLElement, message: { id: string; role: string; text: string }) => void): Dispose;
    /**
     * A bar over each component a bot's message shows (the Board's pin / ↻ / ⋯); null: none for that card. `stamp(state)` is asked with each
     * state before the messages are drawn (it may keep the state): a message with a card is drawn again when its text changes.
     */
    cardBar(make: (display: DisplayView, messageID: string, index: number) => HTMLElement | null, stamp?: (state: ChatState) => string): Dispose;
    /** A button in the head of a component made from a reply; null: none. */
    specButton(make: (spec: SpecChipView) => HTMLElement | null): Dispose;
    /** Words as the chat draws a message's (Markdown, with every plugin's renderers), as HTML. */
    render(text: string): string;
    /** A picture or video as the chat draws one in a message, as HTML. */
    media(url: string, label: string): string;
    /** A task's chip as the chat draws it under a reply, as HTML; `action`: the chip's data-action. */
    taskChip(task: TaskCardView, action?: string): string;
  };
  /**
   * Chat extension v2: draws what this plugin's program part put among a chat's messages
   * (`chat.decorate`): folded lines behind a card, or a card after a line (decorations.ts).
   */
  decorations: { register(renderer: DecorationRenderer): Dispose };
  /** The chat page's own parts, for a plugin that draws cards over it (the Board). */
  page: PageKit;
  components: { register(name: string, render: ComponentRender): Dispose };
  /** A page in the right column, declared in contributes.panels; drawn when you open it. */
  panels: { register(id: string, render: (root: HTMLElement) => void | Dispose): Dispose };
  commands: { register(id: string, run: () => void): Dispose; execute(id: string): void };
  settings: { get<T>(key: string): T; onChange(key: string, handler: (value: unknown) => void): Dispose };
  notify(text: string): void;
  /** Calls what this plugin's own program part exposes (`ui.expose`, or `web.handle`). */
  call(method: string, params?: unknown): Promise<unknown>;
  /** `call`'s 1.x name. */
  host: { call(method: string, params?: unknown): Promise<unknown> };
}

type Activate = (ccb: CcbWeb) => void | Dispose | Promise<void | Dispose>;

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
  private readonly pasteHandlers: { plugin: string; handler: (text: string, event: ClipboardEvent) => boolean | void }[] = [];
  private markdownChanged = false;
  /** Called when a plugin registers a panel (the panel page waits for its own). */
  onPanels: (() => void) | null = null;
  /** What plugins draw among the messages (decorations.ts); the chat places it on every update. */
  readonly decorations = new DecorationLayer((plugin, run) => this.guard(plugin, run));
  /** host.call requests waiting for the plugin host's answer. */
  /** The chat's last state, and who wants it (`page.onState`). */
  private lastState: ChatState | null = null;
  private readonly stateListeners: { plugin: string; fn: (state: ChatState) => void }[] = [];
  private readonly approvals = new Map<number, (allowed: boolean) => void>();
  private readonly windowListeners: { plugin: string; fn: () => void }[] = [];
  private readonly hostCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextCall = 1;

  constructor(private readonly hooks: ChatHooks) {
    extensions.guard = (plugin, run) => this.guard(plugin, run);
    setWindowListener(() => { for (const { plugin, fn } of [...this.windowListeners]) this.guard(plugin, fn); });
  }

  /** The chat drew `state`: the plugins that draw from it (`page.onState`) draw theirs. */
  chatState(state: ChatState): void {
    this.lastState = state;
    for (const { plugin, fn } of [...this.stateListeners]) this.guard(plugin, () => fn(state));
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
      // Botling keeps this version as the one to fall back to if a later one breaks.
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

  /**
   * A command a key asks for (the page's one key dispatcher, shortcuts.ts): run here when a web part
   * registered it; false otherwise, and the app page runs it in the plugin host.
   */
  runLocal(id: string): boolean {
    const run = this.commandRuns.get(id);
    if (run) this.guard(id.split(".")[0], run);
    return !!run;
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

  /** A paste of text offered to plugins before the input box takes it. */
  handlePaste(event: ClipboardEvent): boolean {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    for (const { plugin, handler } of this.pasteHandlers) {
      if (this.guard(plugin, () => handler(text, event)) === true) return true;
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

  private callHost(name: string, method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const callID = this.nextCall++;
      this.hostCalls.set(callID, { resolve, reject });
      post({ type: "hostCall", plugin: name, method, params: params ?? null, callID });
    });
  }

  /** The app page answered a `requestApproval`: the user pressed Allow, or did not. */
  approvalReply(requestId: number, allowed: boolean): void {
    const waiter = this.approvals.get(requestId);
    if (!waiter) return;
    this.approvals.delete(requestId);
    waiter(allowed);
  }

  /** What the bars plugins draw over cards depend on, from this state (asked before the messages are drawn). */
  cardStamp(state: ChatState): string {
    return extensions.cardBars.map(({ plugin, stamp }) => (stamp ? this.guard(plugin, () => stamp(state)) ?? "" : "")).join("|");
  }

  private pageKit(name: string, own: (dispose: Dispose) => Dispose, remove: <T>(list: T[], item: T) => () => void): PageKit {
    const slots = this.hooks.slots ?? { pinArea: document.createElement("div"), board: document.createElement("div"), overlay: document.body };
    return pageKit(slots, {
      onState: (fn) => {
        const item = { plugin: name, fn };
        this.stateListeners.push(item);
        if (this.lastState) this.guard(name, () => fn(this.lastState!));
        return own(remove(this.stateListeners, item));
      },
      onWindowVisible: (fn) => {
        const item = { plugin: name, fn };
        this.windowListeners.push(item);
        return own(remove(this.windowListeners, item));
      },
      call: (method, params) => this.callHost(name, method, params),
      requestApproval: (ask) => new Promise<boolean>((resolve) => {
        const requestId = this.nextCall++;
        this.approvals.set(requestId, resolve);
        post({ type: "approvalRequest", plugin: name, requestId, ...ask });
      }),
    });
  }

  private api(name: string, entry: Loaded): CcbWeb {
    const own = (dispose: Dispose): Dispose => {
      entry.disposers.push(dispose);
      return dispose;
    };
    const remove = <T>(list: T[], item: T) => () => {
      const at = list.indexOf(item);
      if (at !== -1) list.splice(at, 1);
    };
    const chips = new Set<ChipHandle>();
    own(() => { for (const handle of [...chips]) handle.remove(); });
    // The plugin is named here, not by the caller (the page is one realm: the core checks again).
    const call = (method: string, params?: unknown) => this.callHost(name, method, params);
    const builtIn = !!entry.spec.builtIn;
    let kit: PageKit | null = null;
    const page = (): PageKit => (kit ??= this.pageKit(name, own, remove));
    /** What only a plugin that ships with Botling may use. */
    const ownParts = (what: string): void => {
      if (!builtIn) throw new Error(`${what} is for the plugins that ship with Botling.`);
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
        onPaste: (handler) => {
          const item = { plugin: name, handler };
          this.pasteHandlers.push(item);
          return own(remove(this.pasteHandlers, item));
        },
        // Its chips go when it does; `list` gives it only its own.
        chips: {
          add: (chip) => {
            const handle: ChipHandle = this.hooks.composer.chips.add({
              render: () => this.guard(name, () => chip.render()) ?? document.createTextNode(""),
              preview: () => this.guard(name, () => chip.preview?.() ?? null) ?? null,
              serialize: () => this.guard(name, () => chip.serialize()) ?? "",
              onRemove: () => { chips.delete(handle); this.guard(name, () => chip.onRemove?.()); },
            });
            chips.add(handle);
            return handle;
          },
          list: () => this.hooks.composer.chips.list().filter((handle) => chips.has(handle)),
        },
      },
      messages: {
        use: (plugin) => {
          plugin(md);
          this.markdownPlugins.push({ plugin: name, use: plugin });
          this.markdownChanged = true;
        },
        userText: (handler) => {
          const item = { plugin: name, handler };
          extensions.userText.push(item);
          this.markdownChanged = true;
          return own(remove(extensions.userText, item));
        },
        afterRender: (handler) => {
          const item = { plugin: name, handler };
          extensions.afterRender.push(item);
          this.markdownChanged = true;
          return own(remove(extensions.afterRender, item));
        },
        cardBar: (make, stamp) => {
          ownParts("ccb.messages.cardBar");
          const item = { plugin: name, make, ...(stamp ? { stamp } : {}) };
          extensions.cardBars.push(item);
          this.markdownChanged = true;
          return own(() => { remove(extensions.cardBars, item)(); this.hooks.redraw(); });
        },
        specButton: (make) => {
          ownParts("ccb.messages.specButton");
          const item = { plugin: name, make };
          extensions.specButtons.push(item);
          this.markdownChanged = true;
          return own(() => { remove(extensions.specButtons, item)(); this.hooks.redraw(); });
        },
        render: (text) => renderMarkdown(text),
        media: (url, label) => mediaHTML(url, label),
        taskChip: (task, action) => taskCardChipHTML(task, action),
      },
      decorations: {
        register: (renderer) => own(this.decorations.register(name, renderer)),
      },
      get page(): PageKit { ownParts("ccb.page"); return page(); },
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
        // Only its own, as in a panel (frame-protocol.ts): who runs it is this plugin.
        execute: (id) => { if (ownsCommand(name, id)) this.execute(id); else console.warn(`[plugins] ${name} may not run "${id}"`); },
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
      call,
      host: { call },
    };
  }
}

/** The page's parts for a plugin that draws cards over it; `listen` says how it hears the chat's state and the window (a test gives none). */
export function pageKit(slots: PageSlots, listen: Pick<PageKit, "onState" | "onWindowVisible" | "call" | "requestApproval"> = {
  onState: () => () => {}, onWindowVisible: () => () => {}, call: () => Promise.reject(new Error("No program part here.")), requestApproval: () => Promise.resolve(false),
}): PageKit {
  return {
    slots,
    ...listen,
    post: (action) => post(action),
    t, language, pieces, isComposingEnter,
    visible: { windowVisible, onScreen, whenShownAgain },
    refresh: { intervalRow, LiveSchedule, liveTick, parseInterval, presetMinutes, presetSeconds, refreshWords },
    components: {
      commandCard, componentElement, componentSizes, detailTarget, hasFrame, keepFrames, markStatusFrames, maxColumns, maxRows,
      pinSize, pinSizes, reportComponent, resizeFrame, sizeInfo,
    },
  };
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
    if (typeof activate !== "function") throw new Error("The web part does not export activate(ccb).");
    return activate;
  } finally {
    URL.revokeObjectURL(url);
  }
}
