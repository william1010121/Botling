// The row loader (M7-09b; plan-change D56, D64, D65, Q-M7-C3): a front end runs a plugin's web part from the plugin's row in the
// attached server's own table (`plugin:<name>`, fe-link/own-rows.ts), not from the `plugins.web` answer:
//   - the row's `codeHash` and `files.web` (one content reference, M7-09a) say which code it is;
//   - a plugin the FE build shipped (the manifest this bundle was built with, `embeddedFeManifest()`: the desktop window's CSP
//     blocks `fetch`) with exactly that hash runs in the page (inpage-loader.ts); any other web part is a frame: its bytes are
//     fetched by the reference, hash-checked, and held as a registration of the plugin's kernel instance;
//   - a row that changes swaps that plugin only (`Kernel.swap`): its dependents unload first (D64) and load again when its
//     services are back (D65); another plugin's instance is not touched. The new bytes are fetched BEFORE the swap, so a fetch
//     that fails leaves the old code running;
//   - a row with no `files.web` (an older server, or a plugin with no web part) is not this loader's: `plugins.web` stays the
//     source for it (main-v3/web-by-ref.ts reads the same row for the frames' sources).
//
// The instance of a plugin here is named `web:<plugin>`: the plugin feed (plugin-feed.ts) holds the instance named as the plugin
// is, for its view rows, and the two must not take each other's name.
//
// Hot update and a server switch (M7-09c, Q-M7-C1): a newer row never waits behind a fetch of an older one (the older step is let go and
// the new one starts at once), so a bundle that never answers cannot hold an update past the 5 s the plan allows. When the front end
// attaches to ANOTHER server (`switchServer`, told by `followRows`), what was being fetched for the old server is dropped and what
// failed there is tried again; nothing is torn down on a guess: the plugins that run keep running until the new server's own rows
// come, and then `reconcile` decides each one by its (name, codeHash, bundle): the same keeps running untouched, another swaps (D64,
// D65), one the new server lacks unloads. Outbox items are not touched (they stay the shell's).
//
// An outbox item stamped `via` by the old code keeps that `via` (the outbox writes it once); this module only decides where its
// one outcome is shown: on the live instance of that plugin, or, when there is none, in the shell's pending view (§13.1).
//
// Pure TypeScript over the kernel and two ports (the bundle fetcher, the link's rows): no DOM, no Electron, no Node built-ins.
import type { Kernel, Loader } from "../../../../Web/src/plugin-kernel";
import { Sha256 } from "../../fe-link/sha256";
import { contentUrlPath, slotKey, type EntryRef, type Slot } from "../../protocol";
import { PluginRow } from "../../protocol/table-rows";
import { InPageLoader, embeddedFeManifest, type FeManifest, type InPageSource } from "./inpage-loader";

/** The largest web bundle: the same cap the server keeps (server/content/plugin-bundle.ts) and `plugins.web` allows. */
export const MAX_BUNDLE_BYTES = 5_000_000;

/** `files.web` as M7-09a writes it. */
const WEB_REF = /^sha256:[0-9a-f]{64}$/;
// The plugin name pattern of the contract (views-settings.ts `PluginName`); the first character rules out `:shell`, `:chat` and `__proto__`.
const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;

/** The kernel instance that holds a framed plugin's web part. */
export const webInstance = (plugin: string): string => `web:${plugin}`;

/** The content reference a row's `files` names as the plugin's web part, or null (no `files`, no `web`, or not a reference). */
export function webRefOf(files: unknown): string | null {
  if (!files || typeof files !== "object" || !Object.hasOwn(files, "web")) return null;
  const ref = (files as { web?: unknown }).web;
  return typeof ref === "string" && WEB_REF.test(ref) ? ref : null;
}

/** What one `plugin:<name>` row says a front end should run. */
export interface RowPlan {
  name: string;
  codeHash: string;
  /** `files.web`, or null (the web part comes from `plugins.web`). */
  ref: string | null;
  provides: string[];
  requires: string[];
  uses: string[];
}

/** Whether two plans ask for the same thing (the same code, the same reference, the same declared services). */
export const planKey = (plan: RowPlan): string => JSON.stringify([plan.codeHash, plan.ref, plan.provides, plan.requires, plan.uses]);

/** The plan of one row, or null (a name that is not a plugin's, or a body that is not a plugin row: fails closed). */
export function planOf(name: string, body: unknown): RowPlan | null {
  if (!PLUGIN_NAME.test(name)) return null;
  const parsed = PluginRow.safeParse(body);
  if (!parsed.success) return null;
  const { codeHash, manifest, files } = parsed.data;
  return { name, codeHash, ref: webRefOf(files), provides: [...manifest.provides], requires: [...manifest.requires], uses: [...manifest.uses] };
}

/** The plans of every `plugin:` row of a table. */
export function plansOf(rows: ReadonlyMap<string, unknown> | null | undefined): Map<string, RowPlan> {
  const plans = new Map<string, RowPlan>();
  for (const [key, body] of rows ?? []) {
    if (!key.startsWith("plugin:")) continue;
    const plan = planOf(key.slice("plugin:".length), body);
    if (plan) plans.set(plan.name, plan);
  }
  return plans;
}

// ---------------------------------------------------------------------------------------------
// The bytes

/** A web part's bytes are asked for by the frame's plugin (its row's name) and the reference its row names, nothing else. */
export interface BundleRequest { plugin: string; ref: string }
/**
 * The bytes are there but are not the web part the row names (a hash mismatch, over the cap, not UTF-8 text): a refusal, not an outage
 * (M7-09b-F, FU-6). A loader that meets it runs nothing for that row and never falls back to a source the server offers; any other
 * rejection only says the bundle could not be had.
 */
export class BundleRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "BundleRefusedError"; }
}

const sha256Of = (bytes: Uint8Array): string => `sha256:${new Sha256().update(bytes).hex()}`;

/**
 * Whether `text` is, as UTF-8, exactly the content `ref` names. Every consumer of a `BundleFetcher` asks this of what it got, so a
 * fetcher that skipped its own check (or a fake) cannot put other bytes in front of a frame.
 */
export function bundleMatches(text: string, ref: string): boolean {
  if (typeof text !== "string" || !WEB_REF.test(ref)) return false;
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= MAX_BUNDLE_BYTES && sha256Of(bytes) === ref;
}

/** The bundle's text, checked against the reference. Rejects when it cannot be had; rejects with `BundleRefusedError` when it does not match. */
export type BundleFetcher = (request: BundleRequest) => Promise<string>;

/** What the ticket fetcher needs of the link (fe-link `FeLink` has it). */
export interface BundleTicketPort {
  readonly server: string | null;
  remoteContent(message: { t: "content.ticket"; owner: string; id: string; entry: { stream: string; seq: number }; plugin: string }): Promise<{ t: string; ticket?: unknown; reason?: unknown }>;
}

export interface TicketFetcherOptions {
  link: BundleTicketPort;
  /** The origin the content URL is made relative to: the page's own, or (the desktop's main) the server's loopback listener, asked at each fetch; null: none now. */
  base: string | (() => string | null);
  fetch?: typeof fetch;
  /** How many fetched bundles are kept (default 32). */
  keep?: number;
}

/**
 * Fetches a plugin's bundle over the content path (M7-09a): a plugin-bound ticket for the plugin's row entry of the attached server
 * (`srv:<self>`, `seq: 1`: the entry is the row, not a line), then the ticketed `/v3/c/` URL. The bytes must hash to the reference
 * (nothing else is ever returned). The plugin named in the ticket and the URL is the one the request names.
 */
export function ticketBundleFetcher(options: TicketFetcherOptions): BundleFetcher {
  const kept = new Map<string, Promise<string>>();
  const keep = options.keep ?? 32;
  const run = async (plugin: string, ref: string, server: string): Promise<string> => {
    const entry = { stream: `srv:${server}`, seq: 1 };
    const answer = await options.link.remoteContent({ t: "content.ticket", owner: server, id: ref, entry, plugin });
    if (answer.t !== "content.granted" || typeof answer.ticket !== "string") throw new Error(`no ticket for the web part (${String(answer.reason ?? answer.t).slice(0, 60)})`);
    const base = typeof options.base === "function" ? options.base() : options.base;
    if (!base) throw new Error("the server has no content address");
    const url = base.replace(/\/+$/, "") + contentUrlPath({ owner: server, id: ref, variant: "original", entry: entry as EntryRef, ticket: answer.ticket, plugin });
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`the web part could not be read (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new BundleRefusedError("the web part is too large");
    if (sha256Of(bytes) !== ref) throw new BundleRefusedError("the bytes are not the web part its row names");
    // The byte order mark stays in the text: the consumers hash it back to the same bytes (`bundleMatches`).
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new BundleRefusedError("the web part is not UTF-8 text");
    }
  };
  return ({ plugin, ref }) => {
    const server = options.link.server;
    if (!server) return Promise.reject(new Error("not attached to a server"));
    if (!PLUGIN_NAME.test(plugin) || !WEB_REF.test(ref)) return Promise.reject(new Error("not a plugin and a web part reference"));
    const key = `${server}\u0000${plugin}\u0000${ref}`;
    const held = kept.get(key);
    if (held) return held;
    const asked = run(plugin, ref, server);
    kept.set(key, asked);
    asked.catch(() => { if (kept.get(key) === asked) kept.delete(key); });
    while (kept.size > keep) kept.delete(kept.keys().next().value as string);
    return asked;
  };
}

// ---------------------------------------------------------------------------------------------
// The loader

/** What a plugin's frame runs. */
export interface WebSource { codeHash: string; ref: string; source: string }

/** What the loader needs of an outbox item to place its outcome. */
export interface OutcomeItem { slot: Slot; via?: { plugin: string; codeHash: string } }
export type OutcomePlace = "instance" | "pending" | "none" | "duplicate";

export interface RowLoaderOptions {
  kernel: Kernel;
  fetch: BundleFetcher;
  /** The FE build's manifest (default: the one built into this bundle). */
  manifest?: FeManifest;
  /** The modules the build bundled (default: none, so every web part is a frame). */
  source?: InPageSource;
  /** What an in-page plugin's `activate` gets. */
  api?: unknown;
  /** One clean line per refusal or failure (default: console.warn). */
  log?: (line: string) => void;
  /** The shell's pending view: an outcome whose plugin has no live instance. */
  pending?: (item: OutcomeItem) => void;
}

/** A name or text from outside as one short quoted line (control characters escaped). */
const quoted = (text: unknown) => JSON.stringify(String(text).slice(0, 120));
const DELIVERED_KEEP = 2_000;

/** The service a framed plugin provides is answered by its frame; nothing in the renderer wires it yet (the Note card does). */
const frameService = (plugin: string, service: string) => (): never => { throw new Error(`the service ${quoted(service)} of ${quoted(plugin)} is answered by its frame`); };

export class RowLoader {
  private plans = new Map<string, RowPlan>();
  /** The plan each plugin was last started for (running, or wanted and waiting for its services). */
  private readonly applied = new Map<string, string>();
  /** A plan that failed to load: not tried again until the row changes or `retry`. */
  private readonly failed = new Map<string, string>();
  private readonly where = new Map<string, "page" | "frame">();
  private readonly live = new Map<string, WebSource & { generation: number }>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly sinks = new Map<string, Set<(item: OutcomeItem) => void>>();
  private readonly delivered = new Set<string>();
  /** A fetch of a web part that is under way, by plugin: `wake` lets its step go (the row moved on, or the server did). */
  private readonly fetching = new Map<string, { key: string; wake: () => void }>();
  /** Counts the server switches: a step that began before one is of the old server and does nothing more (M7-09c). */
  private epoch = 0;
  private readonly inPage: InPageLoader;
  private readonly log: (line: string) => void;
  private stopped = false;

  constructor(private readonly options: RowLoaderOptions) {
    this.log = options.log ?? ((line) => console.warn(line));
    this.inPage = new InPageLoader({
      manifest: options.manifest ?? embeddedFeManifest(),
      source: options.source ?? (() => undefined),
      // The refusal is read from the load's result: a refused web part is a frame's to run (below).
      offerToFrame: () => undefined,
      log: this.log,
      api: options.api,
    });
  }

  /** The table's `plugin:` rows are now `rows` (the attached server's own): starts, swaps and unloads what changed. Settles when each is done. */
  reconcile(rows: ReadonlyMap<string, unknown> | null | undefined): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.plans = plansOf(rows);
    // A fetch for a plan that is not the row's now is let go: the newer step is queued behind it and must not wait for its bytes.
    for (const [name, held] of this.fetching) { const plan = this.plans.get(name); if (!plan || planKey(plan) !== held.key) held.wake(); }
    const names = new Set([...this.applied.keys(), ...this.plans.keys(), ...this.chains.keys()]);
    return Promise.all([...names].map((name) => this.enqueue(name))).then(() => undefined);
  }

  /**
   * The front end is attached to another server now (its rows are not here yet). Whatever was being fetched for the old server is
   * dropped, and a plan that failed there is not "failed" for the new one. Plugins that run keep running until `reconcile` gets the
   * new server's rows.
   */
  switchServer(): void {
    this.epoch += 1;
    this.failed.clear();
    for (const held of [...this.fetching.values()]) held.wake();
  }

  /** Tries again the plugins that failed (a re-attach: the bytes may be there now). */
  retry(): Promise<void> {
    if (!this.failed.size) return Promise.resolve();
    const names = [...this.failed.keys()];
    this.failed.clear();
    return Promise.all(names.map((name) => this.enqueue(name))).then(() => undefined);
  }

  /** What a plugin's frame runs now: its web part's bytes while its instance is active (null otherwise, or when it runs in the page). */
  webSource(plugin: string): WebSource | null {
    const held = this.live.get(plugin);
    if (!held || this.options.kernel.state(webInstance(plugin)) !== "active") return null;
    return { codeHash: held.codeHash, ref: held.ref, source: held.source };
  }

  /** The plugins this loader runs now: `page` (the build's copy) or `frame`. */
  loaded(): { name: string; where: "page" | "frame"; codeHash: string }[] {
    const out: { name: string; where: "page" | "frame"; codeHash: string }[] = [];
    for (const [name, place] of this.where) {
      const plan = this.plans.get(name);
      const held = this.live.get(name);
      if (place === "frame" && !this.webSource(name)) continue;
      if (place === "page" && !this.inPage.loaded().some((entry) => entry.name === name)) continue;
      out.push({ name, where: place, codeHash: place === "frame" ? held!.codeHash : plan?.codeHash ?? "" });
    }
    return out;
  }

  /** Told after every change to what runs (a start, a swap, an unload). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The live instance of `plugin` shows its outcomes through `sink`; returns the undo. */
  attach(plugin: string, sink: (item: OutcomeItem) => void): () => void {
    const set = this.sinks.get(plugin) ?? new Set();
    set.add(sink);
    this.sinks.set(plugin, set);
    return () => { set.delete(sink); if (!set.size && this.sinks.get(plugin) === set) this.sinks.delete(plugin); };
  }

  /**
   * Places the one outcome of an outbox item: on the live instance of the plugin that caused it (its `via`, fixed when the item was
   * written, so the old code's item still names the old code), or in the shell's pending view when that plugin has no live
   * instance now. A second outcome for the same slot is dropped (L-007).
   */
  route(item: OutcomeItem): OutcomePlace {
    const plugin = item.via?.plugin;
    if (!plugin) return "none";
    const key = slotKey(item.slot);
    if (this.delivered.has(key)) return "duplicate";
    this.delivered.add(key);
    while (this.delivered.size > DELIVERED_KEEP) this.delivered.delete(this.delivered.values().next().value as string);
    const sinks = this.sinks.get(plugin);
    const running = this.where.get(plugin) === "page" || this.options.kernel.state(webInstance(plugin)) === "active";
    if (running && sinks?.size) {
      for (const sink of [...sinks]) { try { sink(item); } catch (error) { this.log(`outcome sink of ${quoted(plugin)} failed: ${quoted((error as Error)?.message)}`); } }
      return "instance";
    }
    try { this.options.pending?.(item); } catch (error) { this.log(`the pending view refused an outcome: ${quoted((error as Error)?.message)}`); }
    return "pending";
  }

  /** Unloads everything this loader runs (the window closes). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.plans = new Map();
    for (const held of [...this.fetching.values()]) held.wake();
    await Promise.all([...new Set([...this.applied.keys(), ...this.chains.keys()])].map((name) => this.enqueue(name)));
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------

  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* a listener's failure is its own */ } }
  }

  /** One plugin at a time: a step starts only when the one before it settled, and reads the plan as it is then. */
  private enqueue(name: string): Promise<void> {
    const before = this.chains.get(name) ?? Promise.resolve();
    const run = before.then(() => this.sync(name)).catch((error) => { this.log(`row loader ${quoted(name)}: ${quoted((error as Error)?.message ?? error)}`); });
    this.chains.set(name, run);
    void run.then(() => { if (this.chains.get(name) === run) this.chains.delete(name); });
    return run;
  }

  /** Whether the plan the step began with is still the row's, of the same server. A newer step is queued behind this one and will do it. */
  private current(name: string, key: string, epoch: number): boolean {
    const plan = this.plans.get(name);
    return !this.stopped && epoch === this.epoch && !!plan && planKey(plan) === key;
  }

  private async sync(name: string): Promise<void> {
    const plan = this.plans.get(name);
    if (!plan) { await this.remove(name); return; }
    const key = planKey(plan);
    const epoch = this.epoch;
    if (this.applied.get(name) === key || this.failed.get(name) === key) return;
    // 1. The build's own copy, when the build shipped exactly this code.
    const result = await this.inPage.load(name, plan.codeHash);
    if (!this.current(name, key, epoch)) return;
    if (result.status === "loaded") {
      await this.dropFrame(name);
      this.where.set(name, "page");
      this.applied.set(name, key);
      this.failed.delete(name);
      this.changed();
      return;
    }
    if (result.status === "failed" || (result.status === "refused" && result.reason === "bad-request")) {
      this.failed.set(name, key);
      return;
    }
    // 2. A frame from the bytes the row names. A row with no reference: `plugins.web` is its source, nothing to run here.
    if (!plan.ref) {
      await this.dropFrame(name);
      this.where.delete(name);
      this.applied.set(name, key);
      this.failed.delete(name);
      return;
    }
    let wake!: () => void;
    const letGo = new Promise<null>((resolve) => { wake = () => resolve(null); });
    const held = { key, wake };
    this.fetching.set(name, held);
    let source: string | null;
    try {
      source = await Promise.race([this.options.fetch({ plugin: name, ref: plan.ref }), letGo]);
      // Whatever the fetcher is, these bytes are checked against the row's reference before they can run (FU-6).
      if (source !== null && !bundleMatches(source, plan.ref)) throw new BundleRefusedError("the bytes are not the web part its row names");
    } catch (error) {
      // The old code, if any, keeps running: nothing was undone for a web part that could not be had or was refused.
      // A failure that belongs to a row or a server that is gone is not recorded on the plan of the new one.
      if (this.current(name, key, epoch)) this.failed.set(name, key);
      const why = quoted((error as Error)?.message ?? error);
      this.log(error instanceof BundleRefusedError
        ? `row loader: the web part of ${quoted(name)} was refused (the old code, if any, keeps running): ${why}`
        : `row loader: the web part of ${quoted(name)} was not loaded: ${why}`);
      return;
    } finally {
      if (this.fetching.get(name) === held) this.fetching.delete(name);
    }
    if (source === null || !this.current(name, key, epoch)) return;
    await this.startFrame(plan, key, source);
  }

  private async startFrame(plan: RowPlan, key: string, source: string): Promise<void> {
    const { kernel } = this.options;
    const { name } = plan;
    const instance = webInstance(name);
    const had = kernel.declaration(instance) !== undefined;
    try {
      kernel.install({ name: instance, provides: { services: plan.provides }, requires: { services: plan.requires }, uses: { services: plan.uses } });
    } catch (error) {
      this.failed.set(name, key);
      this.log(`row loader: ${quoted(name)} cannot be declared: ${quoted((error as Error)?.message)}`);
      return;
    }
    const loader: Loader = (id, generation) => {
      const registered = kernel.register(id, "web", plan.ref!, () => {
        if (this.live.get(name)?.generation === generation) this.live.delete(name);
        this.changed();
      }, generation);
      if (!registered) throw new Error("the plugin was unloaded while it loaded");
      this.live.set(name, { codeHash: plan.codeHash, ref: plan.ref!, source, generation });
      for (const service of plan.provides) kernel.provide(id, service, frameService(name, service));
    };
    this.where.set(name, "frame");
    this.applied.set(name, key);
    this.failed.delete(name);
    // A plugin whose instance exists (running, or waiting for a service) is swapped: its dependents unload first and load again.
    const outcome = had ? await kernel.swap(instance, loader) : await kernel.load(instance, loader);
    if (outcome.status === "failed") {
      this.failed.set(name, key);
      this.applied.delete(name);
      this.log(`row loader: ${quoted(name)} failed to load: ${quoted(outcome.message)}`);
    }
    this.changed();
  }

  /** Unloads a plugin's frame instance (its dependents first) and forgets its declaration. */
  private async dropFrame(name: string): Promise<void> {
    const { kernel } = this.options;
    const instance = webInstance(name);
    if (kernel.declaration(instance) === undefined) return;
    await kernel.requestUnload(instance);
    try { kernel.uninstall(instance); } catch { /* still unloading: the next step meets it again */ }
    this.live.delete(name);
    this.changed();
  }

  private async remove(name: string): Promise<void> {
    this.inPage.unload(name);
    await this.dropFrame(name);
    this.where.delete(name);
    this.applied.delete(name);
    this.failed.delete(name);
    this.changed();
  }
}

// ---------------------------------------------------------------------------------------------
// Following the link

/** What `followRows` needs of the link (the renderer adapter's `LinkPort` has it). */
export interface RowsLink {
  readonly server: string | null;
  table?(serverId: string): { rows: ReadonlyMap<string, unknown> } | null;
  on(listener: (event: { type: string; table?: { stream: string }; attached?: boolean }) => void): () => void;
}

/**
 * Keeps `loader` on the attached server's own `plugin:` rows: on each change of that table, and on a (re-)attach. A table the link
 * does not hold yet (an older server sends none) changes nothing. Returns the undo.
 */
export function followRows(loader: RowLoader, link: RowsLink): () => void {
  // The server whose rows the loader holds. Another server attached (M7-09c, Q-M7-C1): its rows replace the list when they come.
  let followed = link.server;
  const sync = () => {
    const server = link.server;
    if (server !== followed) { followed = server; loader.switchServer(); }
    const table = server ? link.table?.(server) : null;
    if (table) void loader.reconcile(table.rows);
  };
  const off = link.on((event) => {
    if (event.type === "attached" && event.attached) { sync(); void loader.retry(); return; }
    if (event.type === "servers" && link.server && (!event.table || event.table.stream === `srv:${link.server}`)) sync();
  });
  sync();
  return off;
}

// ---------------------------------------------------------------------------------------------
// Following the outbox

/** What `followOutcomes` needs of the link (fe-link `FeLink` has it): an outbox item got its outcome. */
export interface OutcomeLink {
  on(listener: (event: { type: string; item?: OutcomeItem }) => void): () => void;
}

/**
 * Places every outbox outcome the link reports (M7-11b, M7-09b FU-4): `RowLoader.route` decides where, by the item's own `via`.
 * The link may report an item again ("delivered, then lost", D50): `route` drops the second, so an item is placed once. Returns the undo.
 */
export function followOutcomes(loader: RowLoader, link: OutcomeLink): () => void {
  return link.on((event) => { if (event.type === "outcome" && event.item) loader.route(event.item); });
}
