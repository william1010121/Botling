// The shell's host for the in-page built-in plugins (M7-02c): the place that runs the trusted loader (inpage-loader.ts, M7-10a)
// against the renderer's kernel. The first card that imports the loader, so it reads the manifest the build wrote INTO the bundle
// (`embeddedFeManifest()`); `fetchFeManifest()` is for the browser page only, the desktop window's CSP (`connect-src 'none'`)
// blocks fetch. test/unit/inpage-built-renderer.test.ts checks the built renderer.js carries the manifest text.
//
// What it does:
//   - `start()` asks the loader for each plugin the build shipped (name and hash from the manifest's own pair: the page's bundle is
//     the trust root for code it bundled itself; a pair the manifest does not list, or a hash that changed, is refused and offered
//     to the frame host, which does not exist yet: `offered()` keeps the list for it). A bundle built with a manifest also asks for every
//     plugin the shell draws a surface for (shell-plugins.ts) that the manifest does not list, so an empty manifest refuses them all and
//     the page is the shell alone (M7-08). Nothing is attempted when the bundle has no manifest at all (a test, Botling Web 2.x).
//   - A module's `activate(api)` gets `api.define(declaration, register)`: the host installs the declaration in the kernel
//     (refused when the name is not one the manifest lists, or the kernel holds it, or a slot it provides has another owner),
//     loads it with `register` and returns the undo, which unloads it (its dependents go first, the kernel's rule) and forgets its
//     declaration. The plugin feed (plugin-feed.ts) is told after each load and unload, so the plugins' rows that were refused
//     while a slot's owner was away are registered again (and taken back when it goes).
//   - `unavailable(name)`: the plugin was refused, failed to load or was unloaded: the surface it owns shows the shell's
//     "unavailable" line instead of a blank page (settings-slot.ts). A name the host never touched is not unavailable (a page
//     drawn without a shell, in a test, keeps what it had).
import type { Kernel, PluginDeclaration } from "../../../../Web/src/plugin-kernel";
import { notifySlots, rendererKernel } from "../renderer-kernel";
import { bundledInPagePlugin } from "./inpage-bundled";
import { embeddedFeManifest, feManifestEmbedded, InPageLoader, type FeManifest, type InPageSource, type LoadResult } from "./inpage-loader";
import { pluginFeed, type PluginFeed } from "./plugin-feed";
import { SHELL_PLUGINS } from "./shell-plugins";

/** The hash asked for a plugin the manifest does not list: no folder hashes to it, so the loader refuses it. */
const NO_HASH = "0".repeat(64);

/** What an in-page plugin module's `activate` gets. */
export interface InPageApi {
  /** Installs `declaration`, loads it with `register` and returns its undo. Rejects when the host or the kernel refuses (the loader then reports a failed load). */
  define(declaration: PluginDeclaration, register: (kernel: Kernel, plugin: string) => void): Promise<() => void>;
}

export function isInPageApi(api: unknown): api is InPageApi {
  return typeof api === "object" && api !== null && typeof (api as InPageApi).define === "function";
}

export interface InPageHostOptions {
  kernel?: Kernel;
  feed?: Pick<PluginFeed, "refresh">;
  /** What the build shipped (default: the manifest inside this bundle). */
  manifest?: FeManifest;
  source?: InPageSource;
  /**
   * The plugins the shell draws a surface for. `start()` asks for each one the manifest does not list too, so it is refused and shows as
   * unavailable (fail closed; M7-08). Default: SHELL_PLUGINS in a bundle built with a manifest, none in a test or a build without one (the page as it was).
   */
  expected?: readonly string[];
  log?: (line: string) => void;
  /** Called when the host's own state changed in a way the kernel's slots do not show (a refusal). Default: the slot listeners. */
  notify?: () => void;
}

export class InPageHost {
  private readonly kernel: Kernel;
  private readonly feed: Pick<PluginFeed, "refresh">;
  private readonly manifest: FeManifest;
  private readonly expected: readonly string[];
  private readonly notify: () => void;
  readonly loader: InPageLoader;
  private readonly down = new Set<string>();
  private readonly offers: { name: string; codeHash: string }[] = [];
  private readonly unloading = new Map<string, Promise<unknown>>();
  private holders = 0;
  private running: Promise<LoadResult[]> | null = null;

  constructor(options: InPageHostOptions = {}) {
    this.kernel = options.kernel ?? rendererKernel;
    this.feed = options.feed ?? pluginFeed;
    this.manifest = options.manifest ?? embeddedFeManifest();
    this.expected = options.expected ?? (feManifestEmbedded() ? SHELL_PLUGINS : []);
    this.notify = options.notify ?? notifySlots;
    // An expected plugin the manifest does not list can never load from this bundle: it is away from the start, so the first paint (before
    // `start()`, which runs after the frame mounts) is already the shell alone, not the old column and rail for a frame (M7-08 review).
    const listed = new Set(this.manifest.plugins.map((entry) => entry.name));
    for (const name of this.expected) if (!listed.has(name)) this.down.add(name);
    this.loader = new InPageLoader({
      manifest: this.manifest,
      source: options.source ?? bundledInPagePlugin,
      offerToFrame: (name, codeHash) => { this.offers.push({ name, codeHash }); },
      ...(options.log ? { log: options.log } : {}),
      api: { define: (declaration, register) => this.define(declaration, register) } satisfies InPageApi,
    });
  }

  /** The list the loader trusts (what the build shipped, or the one given): `approveRoute(source, host.feManifest)` asks the same list. */
  get feManifest(): FeManifest { return this.manifest; }

  /** The plugins the loader refused (not listed, or not the shipped code), for the frame host (a later card) to run in a frame. */
  offered(): readonly { name: string; codeHash: string }[] { return this.offers; }

  /** True when `name` was refused, failed to load or was unloaded (and has not loaded since): what it owns is not there. */
  unavailable(name: string): boolean { return this.down.has(name); }

  /** The plugins running in the page now. */
  loaded(): { name: string; codeHash: string }[] { return this.loader.loaded(); }

  /**
   * Loads each of `entries` (name and hash; default: every plugin the manifest lists, under the hash it lists, and each expected plugin it does
   * not list, which is refused). Each answer is recorded: a refusal or a failure makes the name unavailable.
   */
  start(entries: readonly { name: string; codeHash: string }[] = this.defaults()): Promise<LoadResult[]> {
    const run = Promise.all(entries.map(async ({ name, codeHash }) => {
      const result = await this.loader.load(name, codeHash);
      if (result.status === "loaded") this.down.delete(name); else this.down.add(name);
      this.notify();
      return result;
    }));
    this.running = run;
    return run;
  }

  private defaults(): { name: string; codeHash: string }[] {
    const listed = new Set(this.manifest.plugins.map((entry) => entry.name));
    return [...this.manifest.plugins, ...this.expected.filter((name) => !listed.has(name)).map((name) => ({ name, codeHash: NO_HASH }))];
  }

  /** Unloads one plugin this host runs (its undo runs once); the name is unavailable until it loads again. True when it was running. */
  unload(name: string): boolean {
    const was = this.loader.unload(name);
    if (was) { this.down.add(name); this.notify(); }
    return was;
  }

  /** Unloads every plugin this host runs (after any load still in flight). */
  async stop(): Promise<void> {
    await this.running?.catch(() => undefined);
    for (const { name } of this.loader.loaded()) { this.loader.unload(name); this.down.delete(name); }
    await Promise.all([...this.unloading.values()]);
    this.notify();
  }

  /**
   * The shell frame holds the host while it is up: the first holder starts it, the last one to let go stops it (StrictMode runs
   * an effect, its cleanup, and the effect again: the plugins are loaded again, not left half-loaded).
   */
  acquire(): () => void {
    if (this.holders++ === 0) void this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holders === 0) void this.stop();
    };
  }

  private async define(declaration: PluginDeclaration, register: (kernel: Kernel, plugin: string) => void): Promise<() => void> {
    const { kernel } = this;
    const name = declaration?.name;
    if (typeof name !== "string" || !this.manifest.plugins.some((entry) => entry.name === name)) throw new Error("the build's manifest does not list that plugin");
    await this.unloading.get(name);
    if (kernel.state(name) !== "absent" || kernel.declaration(name)) throw new Error("the kernel already holds that plugin");
    kernel.install(declaration);
    const slots = [...(kernel.declaration(name)?.provides?.slots ?? [])];
    const forget = () => {
      const done = Promise.resolve(kernel.requestUnload(name)).then(() => { kernel.uninstall(name); this.feed.refresh(slots); this.notify(); }, () => undefined);
      this.unloading.set(name, done);
      void done.finally(() => { if (this.unloading.get(name) === done) this.unloading.delete(name); });
    };
    let outcome;
    try {
      outcome = await kernel.load(name, (plugin) => register(kernel, plugin));
    } catch (error) {
      forget();
      throw error;
    }
    if (outcome.status !== "active") {
      forget();
      throw new Error(outcome.status === "failed" ? outcome.message : `it is waiting for ${outcome.missing.join(", ")}`);
    }
    this.feed.refresh(slots);
    return forget;
  }
}

/** The renderer's host (shell/ShellFrame.tsx holds it while the page is up). */
export const inPageHost = new InPageHost();
