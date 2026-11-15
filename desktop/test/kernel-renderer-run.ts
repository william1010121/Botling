// The renderer-kernel run of the kernel acceptance (M7-11a, plan-change §4.3 check 8): a kernel built like the renderer's
// (renderer-kernel.ts: slot names through `canonicalSlot`, `:shell` owning the root slots and the feed's slots, `:chat` providing
// `composer.insertQuote`) with the plugin feed (renderer/shell/plugin-feed.ts) fed random `PluginsView`s over the real plugin
// names, in-page plugins (component entries) and framed plugins (frame entries) contributing to slots under either name of
// the slot, and the shell and the chat surface unloading, loading and swapping under them. Undos are sync, throwing, async or
// never settling; loaders are sync or async; time is the test's.
//
// Invariants (the same as the kernel run's, plus the ones the renderer adds):
//   P1/P5  what a plugin registered with an undo is either held by its instance or undone;
//   P2     a contribution is shown only while its contributor and its slot's owner are active, and is never held without an owner;
//   P3/P4, K1/D64, K2/D65 the rule watcher (kernel-invariants.ts) over the declarations installed now;
//   aliases  a slot and its alias are one slot: both names show the same entries and the same owner, and the kernel holds every
//            slot, contribution and slot registration under one name only (the 2.x id when there is one);
//   feed   every feed plugin that is active holds exactly its rows of the last view, in its own order, under both names of each slot;
//   6      unload-all ends within a bounded number of rounds; afterwards the kernel and the feed hold nothing, and each failing
//          undo was reported once.
// A failure names its seed (`seed <n>: ...`); the acceptance test runs one alone with KERNEL_ACCEPTANCE_SEED=<n>.
import {
  Kernel, ROOT_SLOTS, SLOT_ALIASES, canonicalSlot, legacySlotId, slotForms,
  type KernelEvent, type PluginDeclaration, type UndoFailure,
} from "../../Web/src/plugin-kernel";
import type { PluginsView } from "../src/contract";
import { FEED_MENU_SLOTS, FEED_SLOTS, FEED_VIEWS, PLUGIN_OWNED_SLOTS } from "../src/renderer/shell/feed-slots";
import { PluginFeed, type FeedEntry } from "../src/renderer/shell/plugin-feed";
import { deferred, flush, manualTimers, seeded } from "./kernel-driver";
import { ruleWatcher } from "./kernel-invariants";

const SHELL = ":shell";
const CHAT = ":chat";
const QUOTE = "composer.insertQuote";
/** Stands in for `botling.settings` (M7-02c): the in-page plugin that owns the two settings slots, not `:shell`. */
const SETTINGS = ":settings";
const SHELL_SLOTS = [...ROOT_SLOTS, ...FEED_SLOTS];
const ALL_SLOTS = [...SHELL_SLOTS, ...PLUGIN_OWNED_SLOTS];
const PAGE_PLUGINS = ["page.a", "page.b", "page.c"] as const; // in-page plugins: component entries
const FRAMED_PLUGINS = ["frame.a", "frame.b", "frame.quoter"] as const; // framed plugins: frame entries (`frame.quoter` requires the chat surface's service)
const MENUS = FEED_MENU_SLOTS.map((slot) => slot.slice("menu/".length));
const TIMEOUT = 30;

type Random = ReturnType<typeof seeded>;
type ListedPlugin = PluginsView["plugins"][number];
type Rows = Map<string, Map<string, unknown[]>>; // plugin → canonical slot → rows

/** A `PluginsView` over `names` (some listed, some off, some only named by a row), rows in every view place and menu. */
function randomView(random: Random, names: readonly string[], base: ListedPlugin): PluginsView {
  const listed = names.filter(() => random.chance(0.45));
  const unlisted = names.filter((name) => !listed.includes(name) && random.chance(0.08));
  const view: Record<string, unknown> = {
    plugins: listed.map((name) => ({ ...base, name, version: `1.${random.int(2)}.0`, enabled: random.chance(0.9), failure: null })),
    broken: [], host: { running: true, problem: null }, secretsProblem: null,
  };
  const rowners = [...listed, ...unlisted];
  for (const [key] of FEED_VIEWS) {
    view[key] = rowners.flatMap((plugin) => Array.from({ length: random.int(3) }, (_, index) => ({ plugin, id: `${plugin}.${key}.${index}`, title: `t${random.int(2)}` })));
  }
  view.menus = rowners.flatMap((plugin) => Array.from({ length: random.int(3) }, (_, index) => ({ menu: random.pick(MENUS), command: `${plugin}.c${index}`, plugin, title: `m${random.int(2)}` })));
  return view as unknown as PluginsView;
}

/** What the view says, read from its arrays: each plugin's rows per slot (own order), and the plugin names the feed must hold. */
function readView(view: PluginsView): { rows: Rows; names: Set<string> } {
  const rows: Rows = new Map();
  const add = (plugin: string, slot: string, row: unknown) => {
    const bySlot = rows.get(plugin) ?? new Map<string, unknown[]>();
    rows.set(plugin, bySlot);
    const key = canonicalSlot(slot);
    bySlot.set(key, [...(bySlot.get(key) ?? []), row]);
  };
  for (const [key, slot] of FEED_VIEWS) for (const row of view[key] ?? []) add(row.plugin, slot, row);
  for (const row of view.menus ?? []) add(row.plugin, `menu/${row.menu}`, row);
  const names = new Set<string>(rows.keys());
  for (const plugin of view.plugins) if (plugin.enabled && plugin.failure === null) names.add(plugin.name);
  return { rows, names };
}

const ALL_CANONICAL = [...new Set(ALL_SLOTS.map(canonicalSlot))];
const OWNED_CANONICAL = new Set(PLUGIN_OWNED_SLOTS.map(canonicalSlot));
type SlotEntries = { plugin: string; entry: unknown }[];
/** The feed rows one plugin holds in a slot's entries, in order. */
const feedRows = (entries: SlotEntries, plugin: string): unknown[] => entries.filter((held) => held.plugin === plugin && (held.entry as Partial<FeedEntry>).kind === "feed").map((held) => (held.entry as FeedEntry).row);
/** The same rows: the same objects (the feed keeps the view's rows as they are), or equal by value. */
const sameRows = (a: unknown[], b: unknown[]) => (a.length === b.length && a.every((row, at) => row === b[at])) || JSON.stringify(a) === JSON.stringify(b);

export interface RendererRunInput {
  /** The real plugin set's names (built-ins and the two fixtures): the feed's plugins. */
  plugins: readonly string[];
  /** A plugin list entry the random views copy (the step-1 fixture's first). */
  base: ListedPlugin;
}
export interface RendererRunResult {
  events: number;
  rounds: number;
  failures: number;
  /** Slots that showed something under both names (the alias check was not vacuous). */
  aliasShown: number;
  /** Active feed plugins whose rows were compared with the view. */
  feedCompared: number;
  frameEntries: number;
  componentEntries: number;
  shellUnloads: number;
  chatUnloads: number;
  settingsUnloads: number;
}

export async function rendererKernelRun(seed: number, input: RendererRunInput, maxActions = 30): Promise<RendererRunResult> {
  const random = seeded(seed);
  const timers = manualTimers();
  const problems: string[] = [];
  const failures: UndoFailure[] = [];
  let watching = true;
  let kernel!: Kernel;
  const declarations = () => kernel.installed().map((name) => kernel.declaration(name)!);
  const watcher = ruleWatcher(declarations, () => kernel, problems);
  const trace: KernelEvent[] = [];
  // The instances that were active when the settings plugin's current instance started loading: the only ones that may stay
  // active while it is loading (they loaded while it was not installed; a new instance of theirs starts only with it active, K2).
  let activeAtOwnerStart = new Set<string>();
  const noteStart = (event: KernelEvent) => {
    if (event.action !== "StartLoad") return;
    if (event.plugin === SETTINGS) activeAtOwnerStart = new Set(kernel.plugins().filter((name) => name !== SETTINGS && kernel.state(name) === "active"));
    else activeAtOwnerStart.delete(event.plugin);
  };
  kernel = new Kernel({
    slotName: canonicalSlot, timers, undoTimeoutMs: TIMEOUT,
    log: (event) => { trace.push(event); noteStart(event); if (watching) watcher(event); },
    onUndoFailure: (failure) => failures.push(failure),
  });
  const result: RendererRunResult = { events: 0, rounds: 0, failures: 0, aliasShown: 0, feedCompared: 0, frameEntries: 0, componentEntries: 0, shellUnloads: 0, chatUnloads: 0, settingsUnloads: 0 };

  // What each registration with an undo stands for (deleted by its undo), and the failing undos that ran (by item name).
  const world = new Map<string, string>();
  const failing = new Set<string>();
  const gates: ((ok: boolean) => void)[] = [];
  const loaderGates: (() => void)[] = [];
  let item = 0;
  const undoFor = (name: string, isItem: boolean) => {
    const kind = random.pick(["sync", "sync", "sync", "throws", "async", "hangs"] as const);
    return () => {
      world.delete(name);
      if (isItem && (kind === "throws" || kind === "hangs")) failing.add(name);
      if (kind === "throws") throw new Error("undo throws");
      if (kind === "hangs") return new Promise(() => {});
      if (kind === "async") { const gate = deferred(); gates.push((ok) => (ok ? gate.resolve() : gate.reject(new Error("undo rejects")))); return gate.promise; }
      return undefined;
    };
  };
  const addItem = (plugin: string) => { const name = `${plugin}-${++item}`; world.set(name, plugin); kernel.register(plugin, "item", name, undoFor(name, true)); };
  const entryFor = (plugin: string, tag: string) => (FRAMED_PLUGINS as readonly string[]).includes(plugin)
    ? { kind: "frame" as const, frame: "slot" as const, plugin, view: "v", title: "t", tag }
    : { kind: "component" as const, render: () => null, tag };
  /**
   * `kernel.contribute`, and the answer checked: accepted exactly when the instance is loading or active, the plugin owns the slot
   * or declares it (the slot given by either name), and the slot's owner is the plugin itself or active (K2); otherwise refused.
   */
  const contribute = (plugin: string, slot: string, entry: unknown, undo?: () => unknown): boolean => {
    const canonical = canonicalSlot(slot);
    const up = kernel.state(plugin) === "loading" || kernel.state(plugin) === "active";
    const allowed = kernel.declaredOwner(canonical) === plugin || (kernel.declaration(plugin)?.contributes?.slots ?? []).includes(canonical);
    const owner = kernel.slotOwner(canonical);
    const expected = up && allowed && owner !== null && (owner === plugin || kernel.state(owner) === "active");
    const accepted = kernel.contribute(plugin, slot, entry, undo) !== null;
    if (accepted !== expected) problems.push(`${plugin}'s contribution to ${slot} was ${accepted ? "accepted" : "refused"}, expected ${expected ? "accepted" : "refused"} (${up ? "up" : kernel.state(plugin)}, ${allowed ? "declared" : "undeclared"}, owner ${owner ?? "none"} ${owner ? kernel.state(owner) : ""})`);
    return accepted;
  };
  const addContribution = (plugin: string, slot: string) => {
    const tag = `${plugin}→${slot}-${++item}`;
    world.set(tag, plugin);
    if (!contribute(plugin, slot, entryFor(plugin, tag), undoFor(tag, false))) world.delete(tag);
  };
  /** Either name of a slot, at random (a plugin may use the 2.x id or the new name). */
  const form = (slot: string) => random.pick(slotForms(slot));

  // The shell and the chat surface, as renderer-kernel.ts declares them; the plugins that contribute to slots declare the
  // slots they use (each plugin its own few, given by either name).
  const wanted = new Map<string, string[]>();
  for (const name of [...PAGE_PLUGINS, ...FRAMED_PLUGINS]) wanted.set(name, Array.from({ length: 1 + random.int(4) }, () => random.pick(ALL_SLOTS)));
  kernel.install({ name: CHAT, provides: { services: [QUOTE] } });
  kernel.install({ name: SHELL, provides: { slots: SHELL_SLOTS.map(form) } });
  kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS.map(form) } });
  for (const [name, slots] of wanted) {
    kernel.install({
      name, contributes: { slots: slots.map(form) },
      ...(name === "frame.quoter" ? { requires: { services: [QUOTE] } } : {}),
      ...(name === "page.c" ? { uses: { services: [QUOTE] } } : {}),
    } satisfies PluginDeclaration);
  }
  const maybeAsync = (name: string) => {
    if (!random.chance(0.3)) return undefined;
    const gate = deferred();
    loaderGates.push(() => gate.resolve());
    return gate.promise.then(() => { addItem(name); });
  };
  const shellLoader = (name: string) => {
    for (const slot of SHELL_SLOTS) kernel.provideSlot(name, form(slot));
    if (random.chance(0.3)) addItem(name);
    return maybeAsync(name);
  };
  const settingsLoader = (name: string) => {
    for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(name, form(slot));
    if (random.chance(0.3)) addItem(name);
    return maybeAsync(name);
  };
  const chatLoader = (name: string) => {
    kernel.provide(name, QUOTE, async () => "quoted");
    if (random.chance(0.3)) addItem(name);
    return maybeAsync(name);
  };
  const pluginLoader = (name: string) => {
    for (const slot of wanted.get(name)!) for (let n = 1 + random.int(2); n > 0; n -= 1) contribute(name, form(slot), entryFor(name, ""));
    if (random.chance(0.5)) addContribution(name, form(random.pick(wanted.get(name)!)));
    if (name === "page.c") kernel.call(name, QUOTE, "text");
    for (let n = random.int(3); n > 0; n -= 1) addItem(name);
    if (!random.chance(0.3)) return undefined;
    // An async loader: what it registers after the await may come after its unload (then it is undone at once, P5).
    const gate = deferred();
    loaderGates.push(() => gate.resolve());
    return gate.promise.then(() => { addItem(name); addContribution(name, form(random.pick(wanted.get(name)!))); });
  };
  void kernel.load(CHAT, chatLoader);
  void kernel.load(SHELL, shellLoader);
  void kernel.load(SETTINGS, settingsLoader);

  const feed = new PluginFeed(kernel);
  const last: { view: PluginsView | null } = { view: null };
  let read = readView({ plugins: [] } as unknown as PluginsView);
  const reconcile = (next: PluginsView | null) => {
    last.view = next;
    read = next ? readView(next) : { rows: new Map(), names: new Set() };
    feed.reconcile(next);
  };

  const check = (where: string) => {
    const fail = (text: string) => problems.push(`${where}: ${text}`);
    const names = new Set([...kernel.installed(), ...kernel.plugins()]);
    const contributions = kernel.allContributions();
    // P1/P5: what a plugin registered with an undo is held by its instance or undone.
    const live = new Map<string, Set<unknown>>();
    for (const [thing, owner] of world) {
      let held = live.get(owner);
      if (!held) {
        held = new Set([...kernel.registrations(owner).map((reg) => reg.key), ...contributions.filter((c) => c.plugin === owner).map((c) => (c.entry as { tag?: string }).tag)]);
        live.set(owner, held);
      }
      if (!held.has(thing)) fail(`${owner} left ${thing}`);
    }
    for (const name of names) {
      if (kernel.state(name) === "active") {
        if (kernel.missing(name).length) fail(`${name} active without ${kernel.missing(name).join(", ")}`);
        for (const slot of kernel.declaration(name)?.contributes?.slots ?? []) {
          const owner = kernel.declaredOwner(slot);
          // An owner that is installed after its contributors loaded (the settings plugin, which stands in here for every
          // PLUGIN_OWNED_SLOTS owner, comes up with feed plugins already active: K2 looks at the declared owner at StartLoad, and
          // there was none) is loading while they are active; the host then calls `feed.refresh`, which loads them again with the
          // owner active. Only an instance that was already active when the owner started loading is excused; any other state of
          // the owner, or a contributor that started or became active after it, is an error.
          const lateOwner = owner === SETTINGS && kernel.state(owner) === "loading" && activeAtOwnerStart.has(name) && OWNED_CANONICAL.has(canonicalSlot(slot));
          if (owner && owner !== name && kernel.state(owner) !== "active" && !lateOwner) fail(`${name} active while ${slot}'s owner ${owner} is ${kernel.state(owner)}`);
        }
      }
    }
    for (const contribution of contributions) {
      if (kernel.state(contribution.plugin) === "absent") fail(`absent ${contribution.plugin} still contributes`);
      if (canonicalSlot(contribution.slot) !== contribution.slot) fail(`a contribution is held under ${contribution.slot}, not ${canonicalSlot(contribution.slot)}`);
    }
    for (const reg of kernel.allRegistrations()) if ((reg.kind === "slot" || reg.kind === "contribution") && canonicalSlot(reg.key) !== reg.key) fail(`a ${reg.kind} is registered under ${reg.key}, not ${canonicalSlot(reg.key)}`);
    const provider = kernel.providerOf(QUOTE);
    if (provider && kernel.state(provider) === "absent") fail(`absent ${provider} still provides ${QUOTE}`);
    // P2 and the aliases: what a slot shows is exactly the held contributions whose contributor and owner are active, and the
    // two names of a slot show the same.
    const held = new Map<string, unknown[]>();
    for (const c of contributions) {
      const owner = kernel.slotOwner(c.slot);
      if (owner && kernel.state(owner) === "active" && kernel.state(c.plugin) === "active") held.set(c.slot, [...(held.get(c.slot) ?? []), c.entry]);
    }
    const shownBy = new Map<string, SlotEntries>(); // each shell slot's entries, read once (under its 2.x id)
    for (const slot of ALL_CANONICAL) shownBy.set(slot, kernel.entries(slot));
    const entriesOf = (slot: string) => shownBy.get(slot) ?? kernel.entries(slot);
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((entry, at) => entry === b[at]);
    for (const alias of SLOT_ALIASES) {
      const legacy = legacySlotId(alias);
      const old = entriesOf(legacy).map(({ entry }) => entry);
      if (!same(old, kernel.entries(alias.name).map(({ entry }) => entry))) fail(`${legacy} and ${alias.name} show different entries`);
      if (kernel.slotOwner(legacy) !== kernel.slotOwner(alias.name)) fail(`${legacy} and ${alias.name} have different owners`);
      if (!same(old, held.get(legacy) ?? [])) fail(`${legacy} shows ${old.length} entries, the held contributions say ${(held.get(legacy) ?? []).length}`);
      if (old.length) result.aliasShown += 1;
    }
    for (const slot of ROOT_SLOTS) {
      if (!same(entriesOf(canonicalSlot(slot)).map(({ entry }) => entry), held.get(canonicalSlot(slot)) ?? [])) fail(`${slot} shows other entries than the held contributions say`);
    }
    // What a plugin's entries look like: in-page plugins' components, framed plugins' frames.
    for (const [slot, entries] of shownBy) {
      for (const { plugin, entry } of entries as { plugin: string; entry: { kind: string } }[]) {
        if ((PAGE_PLUGINS as readonly string[]).includes(plugin)) { if (entry.kind !== "component") fail(`${plugin}'s entry in ${slot} is a ${entry.kind}`); else result.componentEntries += 1; }
        else if ((FRAMED_PLUGINS as readonly string[]).includes(plugin)) { if (entry.kind !== "frame") fail(`${plugin}'s entry in ${slot} is a ${entry.kind}`); else result.frameEntries += 1; }
      }
    }
    // The feed: each active feed plugin holds exactly its rows of the last view in each slot (a slot and its alias show the same, above).
    for (const name of feed.loaded()) {
      if (kernel.state(name) !== "active") continue;
      if (!read.names.has(name)) { fail(`feed plugin ${name} is active but the view does not name it`); continue; }
      const own = read.rows.get(name) ?? new Map<string, unknown[]>();
      for (const [slot, entries] of shownBy) {
        const rows = feedRows(entries, name);
        // A place a plugin owns shows the rows only while it is there (a row refused while it was away is registered again by the
        // feed's `refresh`, which the host calls once the owner is back: by the time a step is checked it has).
        const owner = kernel.slotOwner(slot);
        const expected = OWNED_CANONICAL.has(slot) && (!owner || kernel.state(owner) !== "active") ? [] : own.get(slot) ?? [];
        if (!sameRows(rows, expected)) fail(`feed plugin ${name} holds ${rows.length} row(s) in ${slot}, the view has ${expected.length}`);
      }
      result.feedCompared += 1;
    }
    if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  };

  const loads: Promise<unknown>[] = [];
  // Like the host's `define`: a load waits for the unload of the same name, and refuses a plugin the kernel already holds.
  let settingsUnloading: Promise<unknown> | undefined;
  const unloadSettings = () => {
    const done: Promise<unknown> = kernel.requestUnload(SETTINGS).then(() => {
      if (kernel.state(SETTINGS) === "absent") kernel.uninstall(SETTINGS);
      feed.refresh(PLUGIN_OWNED_SLOTS);
    });
    settingsUnloading = done;
    void done.finally(() => { if (settingsUnloading === done) settingsUnloading = undefined; });
    return done;
  };
  const loadSettings = async () => {
    await settingsUnloading;
    if (kernel.state(SETTINGS) !== "absent" || kernel.installed().includes(SETTINGS)) return;
    kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS.map(form) } });
    const outcome = await kernel.load(SETTINGS, settingsLoader);
    if (outcome.status === "active") feed.refresh(PLUGIN_OWNED_SLOTS);
  };
  const swapSettings = async () => {
    await settingsUnloading;
    if (kernel.state(SETTINGS) !== "active") return;
    await kernel.swap(SETTINGS, settingsLoader);
    feed.refresh(PLUGIN_OWNED_SLOTS);
  };
  const lower = [...PAGE_PLUGINS, ...FRAMED_PLUGINS];
  for (let index = 0; index < maxActions; index += 1) {
    const choice = random.int(12);
    let action: string;
    if (choice <= 1) { action = "reconcile"; reconcile(randomView(random, input.plugins, input.base)); }
    else if (choice === 2) { const name = random.pick(lower); action = `load ${name}`; loads.push(kernel.load(name, pluginLoader)); }
    else if (choice === 3) { const name = random.pick(lower); action = `unload ${name}`; loads.push(kernel.requestUnload(name)); }
    else if (choice === 4) { const name = random.pick(lower); action = `swap ${name}`; loads.push(kernel.swap(name, pluginLoader)); }
    else if (choice === 5) {
      // The shell and the chat surface go and come back under everything that depends on them.
      const which = random.int(20);
      const name = which < 8 ? SHELL : which < 14 ? CHAT : SETTINGS;
      const what = random.int(10);
      if (name === SETTINGS) {
        // The in-page host's way (inpage-host.ts `define`): the declaration is installed with the load and forgotten with the unload,
        // and the feed is told after each, so the rows refused while the owner was away are registered again.
        if (what < 5) { action = `unload ${name}`; if (kernel.state(name) === "active") result.settingsUnloads += 1; loads.push(unloadSettings()); }
        else if (what < 9) { action = `load ${name}`; loads.push(loadSettings()); }
        else { action = `swap ${name}`; loads.push(swapSettings()); }
      } else {
        const loader = name === SHELL ? shellLoader : chatLoader;
        if (what < 5) { action = `unload ${name}`; if (kernel.state(name) === "active") result[name === SHELL ? "shellUnloads" : "chatUnloads"] += 1; loads.push(kernel.requestUnload(name)); }
        else if (what < 9) { action = `load ${name}`; loads.push(kernel.load(name, loader)); }
        else { action = `swap ${name}`; loads.push(kernel.swap(name, loader)); }
      }
    }
    else if (choice === 6 && gates.length) { action = "settle undo"; gates.splice(random.int(gates.length), 1)[0]!(random.chance(0.7)); }
    else if (choice === 7 && loaderGates.length) { action = "settle loader"; loaderGates.splice(random.int(loaderGates.length), 1)[0]!(); }
    else if (choice === 8) { action = "tick"; timers.advance(random.int(TIMEOUT + 5)); }
    else if (choice === 9 || choice === 10) {
      // A contribution from any plugin (a feed plugin's, which declared other slots, included) to any shell slot, under either
      // name: refused unless the plugin declared the slot and its owner is active (K2).
      const target = random.pick([...lower, SHELL, ...feed.loaded()]);
      const slot = form(random.pick(ALL_SLOTS));
      action = `contribute ${target} → ${slot}`;
      addContribution(target, slot);
    }
    else { const target = random.pick([...lower, SHELL, CHAT, ...feed.loaded()]); action = `register ${target}`; addItem(target); }
    await flush();
    check(action);
  }

  // Settles what is pending, at random (each undo or loader gate once per round), time moving on.
  const round = async (ok: () => boolean) => {
    result.rounds += 1;
    for (const gate of gates.splice(0)) gate(ok());
    for (const gate of loaderGates.splice(0)) gate();
    await flush();
    timers.advance(TIMEOUT);
    await flush();
  };
  /** Rounds until nothing is pending (no gate, no timer), at most `most`. */
  const settle = async (ok: () => boolean, most = 20) => {
    for (let n = 0; n < most; n += 1) {
      await round(ok);
      if (!gates.length && !loaderGates.length && !timers.pending()) return;
    }
  };

  // Quiescence: the shell and the chat surface come back, everything settles, and the last view is held exactly (the feed
  // reloads what a hanging unload or the shell's going held back, and what the page shows is what the view says).
  void kernel.load(CHAT, chatLoader);
  void kernel.load(SHELL, shellLoader);
  void loadSettings();
  const converged = () => !last.view || ([...read.names].sort().join() === feed.loaded().sort().join() && [...read.names].every((name) => kernel.state(name) === "active"));
  for (let step = 0; step < 4; step += 1) {
    await settle(() => true);
    // The settings plugin is the owner of the plugin-owned places: until it is up the feed cannot hold their rows, and the host
    // asks the feed again (`refresh`) only once it is.
    if (kernel.state(SETTINGS) !== "active") { void loadSettings(); await settle(() => true); }
    const ownerUp = kernel.state(SETTINGS) === "active";
    if (last.view) reconcile(last.view);
    feed.refresh(PLUGIN_OWNED_SLOTS);
    await flush();
    if (ownerUp && converged() && !gates.length && !loaderGates.length) break;
  }
  await settle(() => true);
  if (last.view) {
    const expected = [...read.names].sort();
    if (feed.loaded().sort().join() !== expected.join()) throw new Error(`seed ${seed}: after settling the feed holds [${feed.loaded().sort()}], the view names [${expected}]`);
    for (const name of expected) if (kernel.state(name) !== "active") throw new Error(`seed ${seed}: after settling ${name} is ${kernel.state(name)}`);
    for (const slot of ALL_CANONICAL) {
      const rows = kernel.entries(slot).filter((entry) => (entry.entry as Partial<FeedEntry>).kind === "feed");
      for (const name of expected) {
        const mine = feedRows(rows, name);
        const wantedRows = read.rows.get(name)?.get(slot) ?? [];
        if (!sameRows(mine, wantedRows)) throw new Error(`seed ${seed}: after settling ${name} holds ${mine.length} row(s) in ${slot}, the view has ${wantedRows.length} (owner ${kernel.slotOwner(slot)} is ${kernel.state(kernel.slotOwner(slot) ?? "")}, ${name} is ${kernel.state(name)}, declares [${kernel.declaration(name)?.contributes?.slots}])`);
      }
      const total = [...read.rows.values()].reduce((sum, bySlot) => sum + (bySlot.get(slot)?.length ?? 0), 0);
      if (rows.length !== total) throw new Error(`seed ${seed}: after settling ${slot} holds ${rows.length} feed row(s), the view has ${total}`);
    }
  }
  check("settled");

  // Check 6: unload-all ends within a bounded number of rounds (a hanging undo is cut off by its time limit).
  reconcile(null);
  for (let pass = 0; pass < 5 && (kernel.plugins().length || kernel.wanted().length); pass += 1) {
    for (const name of kernel.wanted()) void kernel.requestUnload(name); // waiting ones too: nothing loads again
    let finished = false;
    const all = kernel.unloadAll().then(() => { finished = true; });
    for (let n = 0; n < 20 && !finished; n += 1) await round(() => random.chance(0.5));
    if (!finished) throw new Error(`seed ${seed}: unload-all did not finish within 20 rounds`);
    await all;
    await flush();
  }
  for (const gate of loaderGates.splice(0)) gate();
  await Promise.all(loads.map((load) => load.catch(() => {})));
  for (let pass = 0; pass < 3 && (kernel.plugins().length || kernel.wanted().length); pass += 1) {
    for (const name of kernel.wanted()) void kernel.requestUnload(name);
    const again = kernel.unloadAll();
    await settle(() => true, 10);
    await again;
  }
  timers.advance(TIMEOUT);
  await flush();
  watching = false;
  reconcile(null); // the feed forgets what it held (their instances are absent now)
  check("unload-all");
  // Check 2: the kernel holds nothing, and the feed nothing of its own.
  const left = [...kernel.installed(), ...kernel.plugins()];
  for (const name of left) if (!kernel.holdsNothingOf(name)) throw new Error(`seed ${seed}: the kernel still holds ${name} (${kernel.state(name)})`);
  if (world.size || kernel.allContributions().length || kernel.allRegistrations().length || kernel.providerOf(QUOTE) || kernel.plugins().length || kernel.wanted().length) throw new Error(`seed ${seed}: residue after unload-all`);
  if (feed.loaded().length) throw new Error(`seed ${seed}: the feed still holds [${feed.loaded()}]`);
  const installed = kernel.installed().sort();
  const fixed = [CHAT, SHELL, ...lower, ...(installed.includes(SETTINGS) ? [SETTINGS] : [])].sort();
  if (installed.join() !== fixed.join()) throw new Error(`seed ${seed}: the declarations left are [${installed}], not [${fixed}]`);
  // Check 5: each failing undo is reported, once.
  const keys = failures.filter((failure) => failure.registration.includes("#")).map((failure) => `${failure.plugin}#${failure.generation}#${failure.registration}`);
  if (new Set(keys).size !== keys.length) throw new Error(`seed ${seed}: an undo failure was reported twice: ${keys.filter((key, at) => keys.indexOf(key) !== at).join(", ")}`);
  for (const name of failing) {
    if (failures.filter((failure) => failure.registration === `item:${name}` || failure.registration.startsWith(`item:${name}#`)).length !== 1) throw new Error(`seed ${seed}: the failing undo of ${name} was not reported once`);
  }
  result.events = trace.length;
  result.failures = failures.length;
  return result;
}
