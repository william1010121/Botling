// @vitest-environment jsdom
// Kernel step 1 acceptance harness (brief §5, step 8): the scripted scenarios and seeded random runs against the real
// kernel (Web/src/plugin-kernel), the real contribution list (core/plugins/kernel-list.ts over the built-in plugins and the
// two fixture third-party plugins), the real plugin host (Web/host) and the real frame broker with the renderer's kernel.
// No window, nothing that takes focus. Each random run is seeded; a failure names its seed (KERNEL_ACCEPTANCE_SEED=<n>
// runs that one alone).
//
// What is synthetic: the host runs, for each plugin name, an `activate` this file writes (random registrations, async
// steps and disposers), not the built-ins' own code; the fixtures' service edges (zed.tools requires the chat surface's
// composer.insertQuote in the kernel runs; acme-board provides and zed.tools requires `acme.board` in the host runs) are
// test-only declarations, so P3 and D64 have service edges to work on (no 2.x plugin declares one).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kernel, type KernelEvent, type PluginDeclaration, type UndoFailure } from "../../../Web/src/plugin-kernel";
import { Host, type CcbHost, type HostOptions, type HostPluginSpec } from "../../../Web/host/src/host";
import type { Loaded } from "../../../Web/host/src/api";
import { CORE_PLUGIN, CORE_SLOTS, ContributionKernel, slotOf } from "../../src/core/plugins/kernel-list";
import type { Contribution } from "../../src/core/plugins/contributions";
import { API_VERSION } from "../../src/core/plugins/manifest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { PROTOCOL_VERSION, type BotView, type PluginsView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { quoteIntoComposer, setComposerQuoter } from "../../src/renderer/composer-quote";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { startChatPlugin } from "../chat-plugin-host";
import { INSERT_QUOTE, rendererKernel } from "../../src/renderer/renderer-kernel";
import { writeFixturePlugins } from "../kernel-goldens";
import { deferred, flush, manualTimers, seeded } from "../kernel-driver";
import { ruleWatcher } from "../kernel-invariants";
import { rendererKernelRun } from "../kernel-renderer-run";
import { desktop, envCount } from "../helpers";

const RUNS = envCount("KERNEL_ACCEPTANCE_RUNS", 500); // CI lowers it on pull requests
const FIRST_SEED = 1001;
const ONE = Number(process.env.KERNEL_ACCEPTANCE_SEED ?? "") || null;
/** One check's time budget: a random run is a few ms (the jsdom frame run about 40 ms), so it grows with the run count (10,000 on the Linux host for the M7-11a evidence). */
const BUDGET = ONE ? 20_000 : Math.max(120_000, RUNS * 100);
/**
 * The jsdom frame run opens real iframes: each run costs about 35 ms and about 1 MB of heap that jsdom does not give back, so a
 * 10,000-run request (M7-11a, Linux host) stopped a 4 GB worker at about 4,250 runs. It runs the first FRAME_RUNS seeds at most;
 * the kernel, list, host and renderer-kernel runs take all RUNS.
 */
const FRAME_RUNS = Math.min(RUNS, 1_000);
const seeds = () => (ONE ? [ONE] : Array.from({ length: RUNS }, (_, index) => FIRST_SEED + index));
/** Run counts and the most steps an unload-all took, per check, for the evidence file (printed at the end). */
const evidence: Record<string, unknown> = {};

// ---------------------------------------------------------------------------------------------------------------------
// The plugin set: the built-ins and the two fixtures, as the registry reads them (all turned on).

interface PluginEntry { name: string; builtIn: boolean; contributions: Contribution[] }
let PLUGINS: PluginEntry[] = [];
let scratch = "";

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "kernel-acceptance-")));
  writeFixturePlugins(join(scratch, "plugins"));
  // The built-ins as the app ships them (built, as the step-1 goldens read them). esbuild does not run under jsdom, so the
  // build runs in a node of its own.
  const script = `import(${JSON.stringify(pathToFileURL(join(desktop, "build-builtin-plugins.mjs")).href)}).then((m) => m.buildBuiltinPlugins({ outdir: ${JSON.stringify(join(scratch, "builtin-plugins"))} })).then((dir) => process.stdout.write(dir))`;
  const built = realpathSync(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: desktop, encoding: "utf8" }).trim());
  const registry = new PluginRegistry(join(scratch, "plugins"), join(scratch, "plugins.json"), new MemorySecretStore(), built);
  registry.rescan(true);
  for (const plugin of registry.plugins) if (!plugin.enabled) registry.setEnabled(plugin.manifest.name, true);
  const list = registry.contributions();
  PLUGINS = registry.plugins.filter((plugin) => !plugin.failure).map((plugin) => ({
    name: plugin.manifest.name, builtIn: plugin.builtIn, contributions: list.filter((entry) => entry.plugin === plugin.manifest.name),
  }));
}, 60_000);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  // The numbers the evidence file quotes.
  console.log(`[kernel acceptance] ${JSON.stringify(evidence)}`);
});

it("the plugin set is the built-ins plus the two fixtures, with their real contribution lists", () => {
  const builtIns = readdirSync(join(desktop, "builtin-plugins")).filter((name) => !name.includes(".md") && !name.startsWith(".")).sort();
  expect(PLUGINS.filter((plugin) => plugin.builtIn).map((plugin) => plugin.name).sort()).toEqual(builtIns);
  expect(PLUGINS.filter((plugin) => !plugin.builtIn).map((plugin) => plugin.name).sort()).toEqual(["acme-board", "zed.tools"]);
  expect(PLUGINS.reduce((sum, plugin) => sum + plugin.contributions.length, 0)).toBeGreaterThan(50);
  evidence.plugins = PLUGINS.length;
  evidence.contributions = PLUGINS.reduce((sum, plugin) => sum + plugin.contributions.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// §5 check 1: no visible change.

/** The step-1 goldens' sha256, recorded on the unchanged code (commit de71d3a0) before any kernel change. */
const GOLDENS: Record<string, string> = {
  "contributions-after-disable.json": "ed83f7990a1b23146f98af4603dbafaf89748c90e5b2648e05b22c19db9e9776",
  "contributions-with-keys.json": "c4ed9dfba176840c55359a1ee1231a1e2e316e39f68d240b98926585e80d4a30",
  "contributions.json": "7086a04fff8b005af8ce8ee63d6f5ae217c4b8911ae2874e141275709899448a",
  "frame-broker.json": "f67f7ec2d79045d56ed018b5f03b663da140217a2982942daa3f5afb0656e37d",
  "host-session.json": "8ac71e51dbc22cfbad46f5bc39ee8fa224488944a82e40f57f0a4901470ff02b",
  "plugins-list.json": "016bbf7077f5a06de2da1a488886341953b35eae4d81d5d3aae9a4cbc8d8b79c",
  "plugins-panel.json": "f849021fec1ffc3b0c31893bb989030a95a8543c90ba429ed2625f5ec133e8f1",
  "plugins-web.json": "c1b04565824bf16c9cbf51bcf1cc9e5162d967f86658b6e5be6b96cbc981673b",
  "registry-plugins.json": "e612cee2fd61982164a1a54cd918548753e412badacc91c5225a5e75ed4a50f3",
  "view-surfaces-after-disable.json": "c9555a6a695dca2807a8194460ecc7631fe0bd73f96635c59e4ac6ed0402bdeb",
  "view-surfaces.json": "be0ec3a9c245ae46d012c477809368136f090b6868a9e086be20ef8b518baf78",
};

describe("check 1: no visible change", () => {
  it("the step-1 golden files are byte-identical to those recorded before the kernel (the golden tests compare today's output with them)", () => {
    const folder = join(desktop, "test", "fixtures", "kernel-goldens");
    const now = Object.fromEntries(readdirSync(folder).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(folder, name))).digest("hex")]));
    expect(now).toEqual(GOLDENS);
  });

  it("the Plugin API is 2.8 (M7-O03a moved it from 2.7: workers.*, decided by the coordinator, user to confirm)", () => {
    expect(API_VERSION).toEqual({ major: 2, minor: 8 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Checks 2, 3, 5, 6 on the kernel itself: the plugin set as instances, `:core` owning every 2.x slot, the chat surface
// providing composer.insertQuote; random load / register / async settle / unload / swap / fail.

const CHAT = ":chat";
const QUOTE = "composer.insertQuote";

function setDeclarations(): PluginDeclaration[] {
  return [
    { name: CORE_PLUGIN, provides: { slots: CORE_SLOTS } },
    { name: CHAT, provides: { services: [QUOTE] } },
    ...PLUGINS.map((plugin): PluginDeclaration => ({
      name: plugin.name,
      contributes: { slots: [...new Set(plugin.contributions.map(slotOf))] },
      ...(plugin.name === "botling.note" ? { uses: { services: [QUOTE] } } : {}),
      ...(plugin.name === "zed.tools" ? { requires: { services: [QUOTE] } } : {}),
    })),
  ];
}

async function kernelRun(seed: number, maxActions = 40) {
  const random = seeded(seed);
  const timers = manualTimers();
  const timeout = 30;
  const problems: string[] = [];
  const declarations = setDeclarations();
  const names = declarations.map((declaration) => declaration.name);
  const failures: UndoFailure[] = [];
  let watching = true;
  const watcher = ruleWatcher(declarations, () => kernel, problems);
  const trace: KernelEvent[] = [];
  const kernel: Kernel = new Kernel({ timers, undoTimeoutMs: timeout, log: (event) => { trace.push(event); if (watching) watcher(event); }, onUndoFailure: (failure) => failures.push(failure) });
  for (const declaration of declarations) kernel.install(declaration);

  // What each registration with an undo stands for (deleted by its undo), and the failing undos that ran (by item name).
  const world = new Map<string, string>();
  const failing = new Set<string>();
  const gates: ((ok: boolean) => void)[] = [];
  const loaderGates: (() => void)[] = [];
  let item = 0;
  const undoFor = (name: string, item: boolean) => {
    const kind = random.pick(["sync", "sync", "sync", "throws", "async", "hangs"] as const);
    return () => {
      world.delete(name);
      if (item && (kind === "throws" || kind === "hangs")) failing.add(name);
      if (kind === "throws") throw new Error("undo throws");
      if (kind === "hangs") return new Promise(() => {});
      if (kind === "async") { const gate = deferred(); gates.push((ok) => (ok ? gate.resolve() : gate.reject(new Error("undo rejects")))); return gate.promise; }
      return undefined;
    };
  };
  const addItem = (plugin: string) => { const name = `${plugin}-${++item}`; world.set(name, plugin); kernel.register(plugin, "item", name, undoFor(name, true)); };
  const addContribution = (plugin: string, slot: string) => {
    const name = `${plugin}→${slot}-${++item}`;
    world.set(name, plugin);
    if (!kernel.contribute(plugin, slot, name, undoFor(name, false))) world.delete(name);
  };
  const plugin = (name: string) => PLUGINS.find((entry) => entry.name === name);
  const loaderFor = (version: number) => (name: string) => {
    if (name === CORE_PLUGIN) for (const slot of CORE_SLOTS) kernel.provideSlot(name, slot);
    if (name === CHAT) kernel.provide(name, QUOTE, async () => `quoted by ${version}`);
    const own = plugin(name)?.contributions ?? [];
    for (const contribution of own) kernel.contribute(name, slotOf(contribution), contribution);
    if (own.length && random.chance(0.5)) addContribution(name, slotOf(random.pick(own)));
    if (name === "botling.note") kernel.call(name, QUOTE, "bot", "text", false);
    for (let n = random.int(3); n > 0; n -= 1) addItem(name);
    if (!random.chance(0.3)) return undefined;
    // An async loader: what it registers after the await may come after its unload (then it is undone at once, P5).
    const gate = deferred();
    loaderGates.push(() => gate.resolve());
    return gate.promise.then(() => {
      addItem(name);
      if (own.length) addContribution(name, slotOf(random.pick(own)));
    });
  };

  const check = (where: string) => {
    for (const name of names) {
      const state = kernel.state(name);
      if (state === "active" && kernel.missing(name).length) problems.push(`${where}: ${name} active without ${kernel.missing(name).join(", ")}`);
      // P1/P5: what a plugin registered with an undo is either still held by its instance or undone.
      const live = new Set([...kernel.registrations(name).map((reg) => reg.key), ...kernel.allContributions<unknown>().filter((c) => c.plugin === name).map((c) => c.entry)]);
      for (const [thing, owner] of world) if (owner === name && !live.has(thing)) problems.push(`${where}: ${name} left ${thing}`);
    }
    for (const contribution of kernel.allContributions()) {
      if (kernel.state(contribution.plugin) === "absent") problems.push(`${where}: absent ${contribution.plugin} still contributes`);
    }
    const provider = kernel.providerOf(QUOTE);
    if (provider && kernel.state(provider) === "absent") problems.push(`${where}: absent ${provider} still provides ${QUOTE}`);
    if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  };

  const loads: Promise<unknown>[] = [];
  let version = 0;
  for (let index = 0; index < maxActions; index += 1) {
    // The core and the chat surface are picked more often than one plugin each, so their teardown meets the others'.
    const target = random.chance(0.25) ? random.pick([CORE_PLUGIN, CHAT]) : random.pick(names);
    const choice = random.int(8);
    let action: string;
    if (choice <= 1) { action = `load ${target}`; loads.push(kernel.load(target, loaderFor(++version))); }
    else if (choice === 2) { action = `unload ${target}`; loads.push(kernel.requestUnload(target)); }
    else if (choice === 3) { action = `swap ${target}`; loads.push(kernel.swap(target, loaderFor(++version))); }
    else if (choice === 4 && gates.length) { action = "settle undo"; gates.splice(random.int(gates.length), 1)[0]!(random.chance(0.7)); }
    else if (choice === 5 && loaderGates.length) { action = "settle loader"; loaderGates.splice(random.int(loaderGates.length), 1)[0]!(); }
    else if (choice === 6) { action = "tick"; timers.advance(random.int(timeout + 5)); }
    else if (random.chance(0.3)) {
      // A contribution to any of the core's slots, which it may not have declared: refused then (it would put an edge
      // outside the declared graph), and otherwise refused unless the core is active (K2), whatever state either is in.
      const slot = random.pick(CORE_SLOTS);
      action = `contribute ${target} → ${slot}`;
      addContribution(target, slot);
    } else { action = `register ${target}`; addItem(target); }
    await flush();
    check(action);
  }

  // Check 6: unload-all ends within a bounded number of rounds (a hanging undo is cut off by its time limit).
  const before = trace.length;
  let rounds = 0;
  for (let pass = 0; pass < 5 && kernel.plugins().length; pass += 1) {
    let finished = false;
    const all = kernel.unloadAll().then(() => { finished = true; });
    for (let round = 0; round < 20 && !finished; round += 1) {
      rounds += 1;
      for (const gate of gates.splice(0)) gate(random.chance(0.5));
      for (const gate of loaderGates.splice(0)) gate();
      await flush();
      timers.advance(timeout);
      await flush();
    }
    if (!finished) throw new Error(`seed ${seed}: unload-all did not finish within 20 rounds`);
    await all;
    // Loads still waiting to start (wanted) may have started meanwhile: once more until quiet.
    await flush();
  }
  for (const gate of loaderGates.splice(0)) gate();
  await Promise.all(loads.map((load) => load.catch(() => {})));
  for (let pass = 0; pass < 3 && kernel.plugins().length; pass += 1) {
    const again = kernel.unloadAll();
    for (let tick = 0; tick < 10; tick += 1) { for (const gate of gates.splice(0)) gate(true); await flush(); timers.advance(timeout); await flush(); }
    await again;
  }
  // A loader settled last may have registered into an absent instance: refused, its undo run at once; one that hangs is
  // reported at the time limit.
  timers.advance(timeout);
  await flush();
  watching = false;
  check("unload-all");
  // Check 2: the kernel holds nothing.
  for (const name of names) if (!kernel.holdsNothingOf(name)) throw new Error(`seed ${seed}: the kernel still holds ${name} (${kernel.state(name)})`);
  if (world.size || kernel.allContributions().length || kernel.providerOf(QUOTE) || kernel.plugins().length || names.some((name) => kernel.pendingCount(name) !== 0)) throw new Error(`seed ${seed}: residue after unload-all`);
  // Check 5: each failing undo is reported, once.
  // (A registration refused at once has no id, so two refused contributions to one slot share a label: only those with
  // an id are compared; each item's failing undo is counted below.)
  const keys = failures.filter((failure) => failure.registration.includes("#")).map((failure) => `${failure.plugin}#${failure.generation}#${failure.registration}`);
  if (new Set(keys).size !== keys.length) throw new Error(`seed ${seed}: an undo failure was reported twice: ${keys.filter((key, at) => keys.indexOf(key) !== at).join(", ")}`);
  for (const name of failing) {
    if (failures.filter((failure) => failure.registration === `item:${name}` || failure.registration.startsWith(`item:${name}#`)).length !== 1) throw new Error(`seed ${seed}: the failing undo of ${name} was not reported once ${JSON.stringify(failures.filter((f) => name.startsWith(f.plugin)))} ${JSON.stringify(trace.filter((e) => e.registration === `item:${name}` || e.registration?.startsWith(`item:${name}#`)))}`);
  }
  return { steps: trace.length - before, rounds, failures: failures.length, events: trace.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Check 2 on the contribution list: random enable / disable / reload / reorder through the registry's reconcile.

async function listRun(seed: number, maxActions = 30) {
  const random = seeded(seed);
  const problems: string[] = [];
  const declarations = [{ name: CORE_PLUGIN, provides: { slots: CORE_SLOTS } }, ...PLUGINS.map((plugin) => ({ name: plugin.name, contributes: { slots: [...new Set(plugin.contributions.map(slotOf))] } }))];
  let list: ContributionKernel | undefined;
  // (The core loads inside the constructor, before `list` is set: those first steps are not watched.)
  const watcher = ruleWatcher(declarations, () => list?.kernel, problems);
  list = new ContributionKernel({ log: watcher });
  const on = new Set(PLUGINS.filter(() => random.chance(0.6)).map((plugin) => plugin.name));
  const versions = new Map(PLUGINS.map((plugin) => [plugin.name, 1]));
  let order = PLUGINS.map((plugin) => plugin.name);
  for (let index = 0; index < maxActions; index += 1) {
    const name = random.pick(PLUGINS).name;
    const choice = random.int(4);
    if (choice === 0) { if (on.has(name)) on.delete(name); else on.add(name); }
    else if (choice === 1) versions.set(name, versions.get(name)! + 1);
    else if (choice === 2) order = [...order].sort(() => random.next() - 0.5);
    const asked = order.filter((each) => on.has(each)).map((each) => PLUGINS.find((plugin) => plugin.name === each)!);
    const got = list.reconcile(asked.map((plugin) => ({ name: plugin.name, contributions: plugin.contributions, version: String(versions.get(plugin.name)) })));
    // The list is exactly the asked plugins' contributions, in order (what the registry handed out before the kernel).
    if (JSON.stringify(got) !== JSON.stringify(asked.flatMap((plugin) => plugin.contributions))) problems.push(`step ${index}: the list differs from the plugins' contributions`);
    if (list.loaded().sort().join() !== asked.map((plugin) => plugin.name).sort().join()) problems.push(`step ${index}: the kernel holds other plugins than those asked`);
    if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  }
  list.reconcile([]);
  await list.kernel.unloadAll();
  if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  for (const name of [CORE_PLUGIN, ...PLUGINS.map((plugin) => plugin.name)]) if (!list.kernel.holdsNothingOf(name)) throw new Error(`seed ${seed}: the list's kernel still holds ${name}`);
  if (list.kernel.allContributions().length || list.kernel.plugins().length) throw new Error(`seed ${seed}: the list's kernel has residue`);
  return {};
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks 2-6 on the plugin host: random syncs (load, reload with new code, unload) of the plugin set with synthetic
// activates; the hook lists, commands, events and exposed methods hold nothing after unload-all.

const hostSpec = (name: string, version: number): HostPluginSpec =>
  ({ name, version: `1.0.${version}`, main: "", fingerprint: String(version), settings: {}, storageDir: join(scratch, "host", name) });

async function hostRun(seed: number, maxActions = 25) {
  const random = seeded(seed);
  const timers = manualTimers();
  const timeout = 30;
  const problems: string[] = [];
  const names = PLUGINS.map((plugin) => plugin.name);
  const world = new Map<string, string>();
  const gates: ((ok: boolean) => void)[] = [];
  const loadeds = new Set<Loaded>();
  let item = 0;
  // acme-board's async activates still pending, by when each started; one pending for the time limit makes a newer sync
  // give up waiting for it (an activate has no time limit, the wait for another sync's load does), so zed.tools fails.
  const acmeStarting = new Map<number, number>();
  let acmeOutlived = false;
  const noteSlowAcme = () => { for (const started of acmeStarting.values()) if (timers.now - started >= timeout) acmeOutlived = true; };
  let host!: Host;
  const kernelOf = () => (host as unknown as { kernel: Kernel }).kernel;
  const activate = (ccb: CcbHost) => {
    const name = ccb.plugin.name;
    const generation = kernelOf().generation(name);
    const register = () => {
      const n = ++item;
      const which = random.int(5);
      if (which === 0) ccb.commands.register(`${name}.c${n}`, () => n);
      else if (which === 1) ccb.events.on("chatRead", () => {});
      else if (which === 2) ccb.hooks.beforeSend((message) => message);
      else if (which === 3) ccb.hooks.afterReply((message) => message);
      else ccb.ui.expose(`m${n}`, () => n);
    };
    for (let n = random.int(4); n > 0; n -= 1) register();
    const pushed = `${name}-sub-${++item}`;
    world.set(pushed, name);
    ccb.subscriptions.push(() => { world.delete(pushed); });
    const disposer = () => {
      const returned = `${name}-returned-${++item}`;
      world.set(returned, name);
      const kind = random.pick(["sync", "sync", "throws", "async", "hangs"] as const);
      return () => {
        world.delete(returned);
        // D64/P3 in the host: acme-board's teardown starts only once zed.tools (which requires it) is gone. (Not the disposer
        // an older instance hands back late: that one is undone at once, whatever runs now.)
        const tearingDown = kernelOf().state(name) === "unloading" && kernelOf().generation(name) === generation;
        if (name === "acme-board" && tearingDown && kernelOf().state("zed.tools") !== "absent") problems.push(`acme-board's disposer ran while zed.tools was ${kernelOf().state("zed.tools")}`);
        if (kind === "throws") throw new Error("cleanup throws");
        if (kind === "hangs") return new Promise(() => {});
        if (kind === "async") { const gate = deferred(); gates.push((ok) => (ok ? gate.resolve() : gate.reject(new Error("cleanup rejects")))); return gate.promise; }
        return undefined;
      };
    };
    if (!random.chance(0.3)) return disposer();
    // An async activate: what it registers after the await may come after its unload (undone at once, P5).
    const gate = deferred();
    const starting = ++item;
    if (name === "acme-board") acmeStarting.set(starting, timers.now);
    gates.push(() => { acmeStarting.delete(starting); gate.resolve(); });
    return gate.promise.then(() => { register(); return disposer(); });
  };
  const declarations: HostOptions["declarations"] = (spec) =>
    spec.name === "acme-board" ? { provides: { services: ["acme.board"] } } : spec.name === "zed.tools" ? { requires: { services: ["acme.board"] } } : null;
  const written: any[] = [];
  host = new Host((message) => written.push(message), async () => activate as any, { timers, undoTimeoutMs: timeout, declarations });
  const own = host.own.bind(host);
  host.own = (plugin, dispose) => { loadeds.add(plugin); return own(plugin, dispose); };
  const versions = new Map(names.map((name) => [name, 1]));
  const on = new Set<string>();
  const syncs: Promise<unknown>[] = [];
  let newestFailed: string[] = [];
  const check = (where: string) => {
    for (const name of names) {
      // P1/P5: an absent plugin's subscriptions and returned disposer have run.
      if (kernelOf().state(name) === "absent" && [...world.values()].includes(name)) problems.push(`${where}: absent ${name} left something`);
      if (host.isLoaded(name) && kernelOf().state(name) === "absent") problems.push(`${where}: ${name} routed to while absent`);
    }
    if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  };
  for (let index = 0; index < maxActions; index += 1) {
    const choice = random.int(6);
    let action: string;
    if (choice <= 1) {
      action = "sync";
      for (const name of names) if (random.chance(0.2)) { if (on.has(name)) on.delete(name); else on.add(name); }
      for (const name of on) if (random.chance(0.1)) versions.set(name, versions.get(name)! + 1);
      // Its answer names no failure but zed.tools waiting for acme-board: one that sync did not ask for, or one whose
      // activate (begun by an older sync) outlived the time limit.
      const asked = names.filter((name) => on.has(name));
      const number = syncs.length;
      syncs.push(host.sync(asked.map((name) => hostSpec(name, versions.get(name)!))).then((answer) => {
        if (number === syncs.length - 1) newestFailed = answer.failed.map((failure) => failure.name);
        for (const failure of answer.failed) {
          if (!(failure.name === "zed.tools" && (!asked.includes("acme-board") || acmeOutlived) && failure.message.startsWith("It needs"))) problems.push(`a sync answered ${failure.name} failed: ${failure.message}`);
        }
      }));
    } else if (choice === 2 && gates.length) { action = "settle"; gates.splice(random.int(gates.length), 1)[0]!(random.chance(0.7)); }
    else if (choice === 3) { action = "tick"; timers.advance(random.int(timeout + 5)); noteSlowAcme(); }
    else if (choice === 4) { action = "beforeSend"; void host.receive({ id: 9000 + index, method: "beforeSend", params: { bot: "b", text: "t" } }); }
    else { action = "event"; void host.receive({ method: "event", params: { name: "chatRead", data: {} } }); }
    await flush();
    check(action);
  }
  // The syncs still going finish first (their activates and disposers settle or time out). Each sync asks for the whole
  // list; an older one that overlaps a newer one steps aside (nothing failed) and the newest decides.
  let drained = false;
  const draining = Promise.all(syncs.map((sync) => sync.catch(() => {}))).then(() => { drained = true; });
  for (let round = 0; round < 50 && !drained; round += 1) {
    for (const gate of gates.splice(0)) gate(random.chance(0.5));
    await flush();
    timers.advance(timeout);
    noteSlowAcme();
    await flush();
  }
  if (!drained) throw new Error(`seed ${seed}: the host's syncs did not finish within 50 rounds`);
  await draining;
  // Then exactly what the newest sync asked for runs, each once, at its newest code (zed.tools only with acme-board), but
  // what its answer named failed (checked above).
  for (const name of names) {
    const expected = on.has(name) && (name !== "zed.tools" || on.has("acme-board")) && !newestFailed.includes(name);
    const loaded = (host as unknown as { plugins: Map<string, Loaded> }).plugins.get(name);
    const instances = [...world.entries()].filter(([thing, owner]) => owner === name && thing.includes("-sub-")).length;
    if (!!loaded !== expected) problems.push(`after the syncs ${name} is ${loaded ? "" : "not "}loaded`);
    else if (loaded && loaded.spec.fingerprint !== String(versions.get(name))) problems.push(`after the syncs ${name} runs code ${loaded.spec.fingerprint}, not ${versions.get(name)}`);
    if (instances !== (expected ? 1 : 0)) problems.push(`after the syncs ${name} has ${instances} live instance(s)`);
  }
  if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  // Unload-all: Botling turns every plugin off (a sync with none); it ends within a bounded number of rounds.
  let rounds = 0;
  let finished = false;
  const off = host.sync([]).then(() => { finished = true; });
  for (let round = 0; round < 20 && !finished; round += 1) {
    rounds += 1;
    for (const gate of gates.splice(0)) gate(random.chance(0.5));
    await flush();
    timers.advance(timeout);
    await flush();
  }
  if (!finished) throw new Error(`seed ${seed}: the host's unload-all did not finish within 20 rounds`);
  await off;
  await Promise.all(syncs.map((sync) => sync.catch(() => {})));
  check("unload-all");
  for (const name of names) {
    if (host.isLoaded(name)) throw new Error(`seed ${seed}: ${name} still loaded`);
    if (!kernelOf().holdsNothingOf(name)) throw new Error(`seed ${seed}: the host's kernel still holds ${name}`);
  }
  if (world.size) throw new Error(`seed ${seed}: ${[...world.keys()][0]} was not disposed`);
  // The hook lists and the rest of every instance that ever loaded are empty: nothing routes anywhere.
  for (const loaded of loadeds) {
    const held = loaded.beforeSend.length + loaded.afterReply.length + loaded.commands.size + loaded.exposed.size + [...loaded.events.values()].reduce((sum, listeners) => sum + listeners.length, 0);
    if (held) throw new Error(`seed ${seed}: an instance of ${loaded.spec.name} still holds ${held} hook(s) or handler(s)`);
  }
  written.length = 0;
  await host.sync([]);
  const registered = written.filter((message) => message.method === "registered").at(-1)?.params;
  if (JSON.stringify(registered) !== JSON.stringify({ beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: [] })) throw new Error(`seed ${seed}: the host still announces ${JSON.stringify(registered)}`);
  return { rounds, instances: loadeds.size };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks 2 and 4 in the renderer: the chat surface's quoter comes and goes, plugin frames of the set open and close and
// ask for quotes; after unload-all the renderer's kernel and the broker hold nothing.

const BOT = "6A0B0000-0000-4000-8000-000000000050";
const BOTS = [{ id: BOT, role: "manager", name: "Site" }] as BotView[];

async function rendererRun(seed: number, maxActions = 20) {
  const random = seeded(seed);
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe() { return () => {}; }, post() {} });
  const broker = new FrameBroker(window, { name: "acceptance broker" });
  const frameHost = pluginFrameHost({ client, components: () => ({}), bots: () => BOTS, ask: (_v, _a, done) => done(false) });
  const quoters: (() => void)[] = [];
  const frames: { close: () => void; send: (data: unknown) => void; posted: any[]; closed: boolean }[] = [];
  let quoted = 0;
  let id = 0;
  // `botling.chat` provides the quote service for every run (M7-07b; it was the `:chat` stand-in, loaded while a quoter was registered): the test starts it once.
  if (rendererKernel.state(CHAT_PLUGIN) !== "active") throw new Error(`seed ${seed}: the chat plugin is not up`);
  for (let index = 0; index < maxActions; index += 1) {
    const choice = random.int(5);
    if (choice === 0) quoters.push(setComposerQuoter(async () => { quoted += 1; return true; }));
    else if (choice === 1 && quoters.length) quoters.splice(random.int(quoters.length), 1)[0]!();
    else if (choice === 2) {
      const element = document.createElement("iframe");
      document.body.append(element);
      const posted: any[] = [];
      element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
      const close = registerPluginFrame(broker, frameHost, { frame: element, plugin: random.pick(PLUGINS).name, bot: BOT });
      const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
      frames.push({ close, send, posted, closed: false });
    } else if (choice === 3 && frames.length) { const frame = random.pick(frames); if (!frame.closed) { frame.close(); frame.closed = true; } }
    else if (frames.length) random.pick(frames).send({ ccb: "composerQuote", id: ++id, text: "x", botId: BOT, focus: false });
    await flush();
    // While the plugin is up it provides the service, quoter or not; the quoter is what it forwards to.
    if (rendererKernel.providerOf(INSERT_QUOTE) !== CHAT_PLUGIN || rendererKernel.state(CHAT_PLUGIN) !== "active") throw new Error(`seed ${seed}: the chat plugin does not provide while ${rendererKernel.state(CHAT_PLUGIN)}`);
  }
  for (const stop of quoters.splice(0)) stop();
  for (const frame of frames) if (!frame.closed) { frame.close(); frame.closed = true; }
  await flush();
  // With every quoter taken back the plugin is still the provider, and a quote is not inserted.
  if (rendererKernel.providerOf(INSERT_QUOTE) !== CHAT_PLUGIN) throw new Error(`seed ${seed}: the chat plugin stopped providing`);
  const before = quoted;
  if (await quoteIntoComposer(BOT, "x", false)) throw new Error(`seed ${seed}: a quote went in with no quoter`);
  if ((broker as unknown as { targets: Set<unknown> }).targets.size) throw new Error(`seed ${seed}: the broker still holds frames`);
  // A closed frame's message is refused, not answered.
  const answered = frames.reduce((sum, frame) => sum + frame.posted.length, 0);
  if (frames.length) frames[0]!.send({ ccb: "composerQuote", id: ++id, text: "x", botId: BOT, focus: false });
  await flush();
  if (frames.reduce((sum, frame) => sum + frame.posted.length, 0) !== answered || quoted !== before) throw new Error(`seed ${seed}: a closed frame was answered`);
  broker.dispose();
  document.body.innerHTML = "";
  return { frames: frames.length };
}

describe("check 2 (no residue, P1) with check 3's invariants, check 5 and check 6, in seeded random runs", () => {
  it(`the kernel: ${RUNS} runs over the plugin set keep P1-P5, K1/D64 and K2/D65 at every step, report each failure once, and unload-all ends with nothing held`, async () => {
    const started = Date.now();
    let maxSteps = 0, maxRounds = 0, failures = 0, events = 0;
    for (const seed of seeds()) {
      const result = await kernelRun(seed);
      maxSteps = Math.max(maxSteps, result.steps);
      maxRounds = Math.max(maxRounds, result.rounds);
      failures += result.failures;
      events += result.events;
    }
    expect(failures).toBeGreaterThan(0);
    evidence.kernel = { runs: seeds().length, seeds: ONE ? [ONE] : [FIRST_SEED, FIRST_SEED + RUNS - 1], maxUnloadAllSteps: maxSteps, maxUnloadAllRounds: maxRounds, reportedFailures: failures, events, ms: Date.now() - started };
  }, BUDGET);

  it(`the contribution list: ${RUNS} runs of enable / disable / reload / reorder hand out the same list as the plugins' own, and unload-all leaves nothing`, async () => {
    const started = Date.now();
    for (const seed of seeds()) await listRun(seed);
    evidence.list = { runs: seeds().length, seeds: ONE ? [ONE] : [FIRST_SEED, FIRST_SEED + RUNS - 1], ms: Date.now() - started };
  }, BUDGET);

  it(`the plugin host: ${RUNS} runs of overlapping syncs leave no hook, command, event, exposed method or disposer behind`, async () => {
    const started = Date.now();
    let maxRounds = 0, instances = 0;
    for (const seed of seeds()) { const result = await hostRun(seed); maxRounds = Math.max(maxRounds, result.rounds); instances += result.instances; }
    expect(instances).toBeGreaterThan(seeds().length);
    evidence.host = { runs: seeds().length, seeds: ONE ? [ONE] : [FIRST_SEED, FIRST_SEED + RUNS - 1], maxUnloadAllRounds: maxRounds, instances, ms: Date.now() - started };
  }, BUDGET);

  it(`the renderer: ${FRAME_RUNS} runs of quoters and plugin frames coming and going leave the renderer's kernel and the broker empty`, async () => {
    const started = Date.now();
    let frames = 0;
    const frameSeeds = seeds().slice(0, FRAME_RUNS);
    // `botling.chat` provides the quote service for every run (M7-07b): started once for the test, not per run.
    const chat = await startChatPlugin();
    try {
      for (const seed of frameSeeds) frames += (await rendererRun(seed)).frames;
    } finally {
      await chat.stop();
    }
    // Check 4 in the renderer: after the plugin's unload nothing is provided, and a quote is not inserted.
    expect(rendererKernel.holdsNothingOf(CHAT_PLUGIN)).toBe(true);
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
    await expect(quoteIntoComposer(BOT, "x", false)).resolves.toBe(false);
    evidence.renderer = { runs: frameSeeds.length, seeds: ONE ? [ONE] : [FIRST_SEED, FIRST_SEED + frameSeeds.length - 1], frames, ms: Date.now() - started };
  }, BUDGET);

  it(`the renderer's kernel with the plugin feed: ${RUNS} runs of random plugin views, in-page and framed plugins on slots under either name, and the shell and chat surface coming and going keep P1-P5, K1/K2, the alias and feed invariants, and unload-all ends with nothing held`, async () => {
    const started = Date.now();
    const base = (JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView).plugins[0]!;
    const input = { plugins: PLUGINS.map((plugin) => plugin.name), base };
    const total = { events: 0, rounds: 0, failures: 0, aliasShown: 0, feedCompared: 0, frameEntries: 0, componentEntries: 0, shellUnloads: 0, chatUnloads: 0, settingsUnloads: 0 };
    for (const seed of seeds()) {
      const result = await rendererKernelRun(seed, input);
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key];
    }
    // The run did something: undo failures, slots that showed entries under both names, feed rows compared, both kinds of entry,
    // and the shell and the chat surface unloaded while active.
    for (const key of Object.keys(total) as (keyof typeof total)[]) expect(total[key], key).toBeGreaterThan(0);
    evidence.rendererKernel = { runs: seeds().length, seeds: ONE ? [ONE] : [FIRST_SEED, FIRST_SEED + RUNS - 1], ...total, ms: Date.now() - started };
  }, BUDGET);
});

// ---------------------------------------------------------------------------------------------------------------------
// Check 3 as scripted cases, check 4 and check 5 scripted.

function coreKernel(timers = manualTimers()) {
  const declarations = setDeclarations();
  const problems: string[] = [];
  let kernel!: Kernel;
  const watcher = ruleWatcher(declarations, () => kernel, problems);
  const failures: UndoFailure[] = [];
  kernel = new Kernel({ timers, undoTimeoutMs: 1000, log: (event) => { kernel.events.push(event); watcher(event); }, onUndoFailure: (failure) => failures.push(failure) });
  for (const declaration of declarations) kernel.install(declaration);
  const lines = () => kernel.events.map((event) => `${event.action} ${event.plugin}${event.registration ? ` ${event.registration.replace(/#\d+$/, "")}` : ""}${event.note ? ` (${event.note})` : ""}`);
  const loadPlain = (name: string) => kernel.load(name, (plugin) => {
    if (plugin === CORE_PLUGIN) for (const slot of CORE_SLOTS) kernel.provideSlot(plugin, slot);
    for (const contribution of PLUGINS.find((entry) => entry.name === plugin)?.contributions ?? []) kernel.contribute(plugin, slotOf(contribution), contribution);
  });
  return { kernel, problems, failures, lines, loadPlain, timers };
}

describe("check 3: order, scripted", () => {
  it("D64: the slot owner runs no undo until a dependent with a slow async undo is absent; no contribution outlives its owner", async () => {
    const { kernel, problems, lines, loadPlain } = coreKernel();
    await loadPlain(CORE_PLUGIN);
    const slow = deferred();
    await kernel.load("botling.note", (plugin) => {
      for (const contribution of PLUGINS.find((entry) => entry.name === plugin)!.contributions) kernel.contribute(plugin, slotOf(contribution), contribution);
      kernel.register(plugin, "item", "slow", () => slow.promise);
    });
    kernel.register(CORE_PLUGIN, "item", "core-own", () => {});
    expect(kernel.allContributions().length).toBeGreaterThan(0);
    const unloading = kernel.requestUnload(CORE_PLUGIN);
    await flush();
    expect([kernel.state("botling.note"), kernel.state(CORE_PLUGIN)]).toEqual(["unloading", "unloading"]);
    expect(lines().filter((line) => line.startsWith("RunUndo :core"))).toEqual([]);
    slow.resolve();
    await unloading;
    const log = lines();
    const noteGone = log.indexOf("FinishUnload botling.note");
    const coreFirstUndo = log.findIndex((line) => line.startsWith("RunUndo :core"));
    expect(noteGone).toBeGreaterThan(-1);
    expect(coreFirstUndo).toBeGreaterThan(noteGone);
    expect(log.indexOf("BeginUnload :core")).toBeGreaterThan(noteGone);
    expect(problems).toEqual([]);
    expect(kernel.holdsNothingOf(CORE_PLUGIN) && kernel.holdsNothingOf("botling.note")).toBe(true);
  });

  it("D65: a plugin that only contributes to the core's slots, asked to load while the core unloads, stays absent until the core is active again; none of its registrations overlaps the core's undos", async () => {
    const { kernel, problems, lines, loadPlain } = coreKernel();
    await loadPlain(CORE_PLUGIN);
    const slow = deferred();
    await kernel.load("botling.note", (plugin) => { kernel.register(plugin, "item", "slow", () => slow.promise); });
    const unloading = kernel.requestUnload(CORE_PLUGIN);
    await flush();
    expect(kernel.state(CORE_PLUGIN)).toBe("unloading");
    const loading = loadPlain("acme-board");
    await flush();
    expect(kernel.state("acme-board")).toBe("absent");
    slow.resolve();
    await unloading;
    // The core is absent now: still absent, waiting for it.
    expect([kernel.state(CORE_PLUGIN), kernel.state("acme-board")]).toEqual(["absent", "absent"]);
    expect(kernel.waitingFor("acme-board").some((what) => what.startsWith("slot "))).toBe(true);
    await loadPlain(CORE_PLUGIN);
    await loading;
    await flush();
    expect(kernel.state("acme-board")).toBe("active");
    const log = lines();
    const coreGone = log.indexOf("FinishUnload :core");
    const firstAcme = log.findIndex((line) => line.startsWith("StartLoad acme-board") || line.startsWith("Register acme-board"));
    expect(firstAcme).toBeGreaterThan(coreGone);
    expect(log.slice(log.indexOf("BeginUnload :core"), coreGone).some((line) => line.includes("acme-board"))).toBe(false);
    expect(problems).toEqual([]);
  });

  it("P3/P4: a dependent unloads before its provider, and each instance's undos run newest first", async () => {
    const { kernel, problems, lines } = coreKernel();
    await kernel.load(CHAT, (plugin) => { kernel.provide(plugin, QUOTE, () => true); kernel.register(plugin, "item", "c1", () => {}); kernel.register(plugin, "item", "c2", () => {}); });
    await kernel.load(CORE_PLUGIN, (plugin) => { for (const slot of CORE_SLOTS) kernel.provideSlot(plugin, slot); });
    await kernel.load("zed.tools", (plugin) => { kernel.register(plugin, "item", "z1", () => {}); kernel.register(plugin, "item", "z2", () => {}); });
    expect(kernel.state("zed.tools")).toBe("active");
    await kernel.requestUnload(CHAT);
    expect(lines().filter((line) => /^(BeginUnload|RunUndo|FinishUnload)/.test(line))).toEqual([
      "BeginUnload zed.tools", "RunUndo zed.tools item:z2", "RunUndo zed.tools item:z1", "FinishUnload zed.tools",
      "BeginUnload :chat", "RunUndo :chat item:c2", "RunUndo :chat item:c1", `RunUndo :chat service:${QUOTE}`, "FinishUnload :chat",
    ]);
    expect(problems).toEqual([]);
  });
});

describe("check 4: closed unload, scripted", () => {
  it("in the kernel: a registration while unloading or after is refused or undone at once", async () => {
    const { kernel, lines } = coreKernel();
    const slow = deferred();
    await kernel.load(CORE_PLUGIN, (plugin) => { kernel.register(plugin, "item", "slow", () => slow.promise); });
    const unloading = kernel.requestUnload(CORE_PLUGIN);
    const undone: string[] = [];
    expect(kernel.register(CORE_PLUGIN, "item", "during", () => { undone.push("during"); })).toBeNull();
    slow.resolve();
    await unloading;
    expect(kernel.register(CORE_PLUGIN, "item", "after", () => { undone.push("after"); })).toBeNull();
    expect(undone).toEqual(["during", "after"]);
    expect(kernel.holdsNothingOf(CORE_PLUGIN)).toBe(true);
    expect(lines().filter((line) => line.startsWith("Register :core item:during") || line.startsWith("Register :core item:after")).length).toBe(2);
  });

  it("in the host: what an activate registers after its plugin was unloaded is undone at once and never routed to", async () => {
    const gate = deferred();
    const written: any[] = [];
    let ran = 0;
    const host = new Host((message) => written.push(message), async () => (async (ccb: CcbHost) => {
      await gate.promise;
      ccb.commands.register("late.run", () => { ran += 1; });
      ccb.hooks.beforeSend(() => false);
      return () => { ran += 10; };
    }) as any);
    const loading = host.sync([hostSpec("late", 1)]);
    await flush();
    await host.sync([]);
    gate.resolve();
    await loading;
    await flush();
    expect(ran).toBe(10);
    await host.receive({ id: 1, method: "command", params: { id: "late.run" } });
    expect(written.find((message) => message.id === 1)?.error?.message).toBe('No command "late.run".');
    await host.receive({ id: 2, method: "beforeSend", params: { bot: "b", text: "t" } });
    expect(written.find((message) => message.id === 2)?.result).toEqual({ text: "t" });
    expect((host as unknown as { kernel: Kernel }).kernel.holdsNothingOf("late")).toBe(true);
  });

  it("in the renderer: a provision after the chat plugin's unload is refused and undone at once; the quote is not inserted", async () => {
    const chat = await startChatPlugin();
    try {
      const stop = setComposerQuoter(async () => true);
      const generation = rendererKernel.generation(CHAT_PLUGIN);
      await rendererKernel.requestUnload(CHAT_PLUGIN);
      stop();
      let undone = 0;
      expect(rendererKernel.register(CHAT_PLUGIN, "item", "late", () => { undone += 1; }, generation)).toBeNull();
      expect(undone).toBe(1);
      expect(rendererKernel.holdsNothingOf(CHAT_PLUGIN)).toBe(true);
      await expect(quoteIntoComposer(BOT, "x", false, "botling.note")).resolves.toBe(false);
    } finally {
      await chat.stop();
    }
  });
});

describe("check 5: contained failure, scripted", () => {
  it("a throwing and a rejecting undo do not stop the others, which run newest first; each is reported once", async () => {
    const { kernel, failures, loadPlain } = coreKernel();
    await loadPlain(CORE_PLUGIN);
    const ran: string[] = [];
    await kernel.load("botling.note", (plugin) => {
      kernel.register(plugin, "item", "first", () => { ran.push("first"); });
      kernel.register(plugin, "item", "rejects", async () => { ran.push("rejects"); throw new Error("rejected"); });
      kernel.register(plugin, "item", "middle", () => { ran.push("middle"); });
      kernel.register(plugin, "item", "throws", () => { ran.push("throws"); throw new Error("thrown"); });
      kernel.register(plugin, "item", "last", () => { ran.push("last"); });
    });
    await kernel.requestUnload("botling.note");
    expect(ran).toEqual(["last", "throws", "middle", "rejects", "first"]);
    expect(failures.map((failure) => [failure.registration.replace(/#\d+$/, ""), failure.message])).toEqual([["item:throws", "thrown"], ["item:rejects", "rejected"]]);
    expect(kernel.holdsNothingOf("botling.note")).toBe(true);
  });

  it("check 6, scripted: a never-settling undo is marked failed at the time limit and the unload finishes", async () => {
    const timers = manualTimers();
    const { kernel, failures, loadPlain } = coreKernel(timers);
    await loadPlain(CORE_PLUGIN);
    await kernel.load("botling.note", (plugin) => { kernel.register(plugin, "item", "hangs", () => new Promise(() => {})); kernel.register(plugin, "item", "fine", () => {}); });
    let done = false;
    const unloading = kernel.requestUnload("botling.note").then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    timers.advance(1000);
    await unloading;
    expect(failures.map((failure) => failure.message)).toEqual(["its undo did not finish within 1000 ms"]);
    expect(kernel.state("botling.note")).toBe("absent");
    // One that comes too late (refused, undone at once) blocks nothing, and is reported at the time limit too.
    expect(kernel.register("botling.note", "item", "late", () => new Promise(() => {}))).toBeNull();
    expect(failures).toHaveLength(1);
    timers.advance(1000);
    expect(failures.map((failure) => [failure.registration, failure.message])).toEqual([
      [expect.stringMatching(/^item:hangs#/), "its undo did not finish within 1000 ms"], ["item:late", "its undo did not finish within 1000 ms"],
    ]);
  });
});
