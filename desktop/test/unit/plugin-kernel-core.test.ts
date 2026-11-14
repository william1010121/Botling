// The plugin kernel's core (Web/src/plugin-kernel/kernel.ts, kernel step 1 step 2): instance states, registrations with
// undos, reverse undo order, async undos, contained failures, "no registration once unloading" (a late one is undone at
// once), and the event log; then seeded random runs over three plugins that keep P1 (no residue), P4 (undos in reverse
// order), P5 (nothing registered by an unloading or absent instance) and end with every instance absent (P6 stand-in).
import { describe, expect, it } from "vitest";
import { KernelError, PluginKernel, type KernelEvent, type UndoFailure } from "../../../Web/src/plugin-kernel";
import { deferred, flush, manualTimers, seeded } from "../kernel-driver";

const kernelWith = (more: ConstructorParameters<typeof PluginKernel>[0] = {}) => {
  const failures: UndoFailure[] = [];
  const timers = manualTimers();
  const kernel = new PluginKernel({ log: true, timers, onUndoFailure: (failure) => failures.push(failure), ...more });
  return { kernel, failures, timers };
};

const actions = (events: KernelEvent[]) => events.map((event) => `${event.action} ${event.plugin}${event.registration ? ` ${event.registration}` : ""}${event.note ? ` (${event.note})` : ""}`);

describe("the kernel core", () => {
  it("an instance goes absent → loading → active → unloading → absent, and its undos run newest first", async () => {
    const { kernel } = kernelWith();
    const done: string[] = [];
    expect(kernel.state("a")).toBe("absent");
    kernel.requestLoad("a");
    expect(kernel.startLoad("a")).toBe(1);
    expect(kernel.state("a")).toBe("loading");
    kernel.register("a", "command", "a.one", () => done.push("one"));
    kernel.register("a", "view", "a.two", () => done.push("two"));
    kernel.activate("a");
    kernel.register("a", "hook", "beforeSend", () => done.push("three"));
    expect(kernel.state("a")).toBe("active");
    expect(kernel.registrations("a").map((reg) => reg.key)).toEqual(["a.one", "a.two", "beforeSend"]);
    const unloaded = kernel.requestUnload("a");
    // Every undo was synchronous: gone before requestUnload returned.
    expect(kernel.state("a")).toBe("absent");
    expect(done).toEqual(["three", "two", "one"]);
    expect(await unloaded).toEqual({ plugin: "a", generation: 1, failures: [] });
    expect(kernel.holdsNothingOf("a")).toBe(true);
    expect(actions(kernel.events)).toEqual([
      "RequestLoad a", "StartLoad a", "Register a command:a.one#1", "Register a view:a.two#2", "Activate a", "Register a hook:beforeSend#3",
      "RequestUnload a", "BeginUnload a", "RunUndo a hook:beforeSend#3", "RunUndo a view:a.two#2", "RunUndo a command:a.one#1", "FinishUnload a",
    ]);
    expect(kernel.events.map((event) => event.step)).toEqual(kernel.events.map((_, index) => index + 1));
  });

  it("a second load while one is loaded or unloading is refused; a reload is a new generation", async () => {
    const { kernel, timers } = kernelWith();
    kernel.startLoad("a");
    expect(() => kernel.startLoad("a")).toThrow(KernelError);
    const slow = deferred();
    kernel.register("a", "x", "slow", () => slow.promise);
    kernel.activate("a");
    const unloaded = kernel.requestUnload("a");
    expect(kernel.state("a")).toBe("unloading");
    expect(() => kernel.startLoad("a")).toThrow(/unloading/);
    expect(kernel.requestUnload("a")).toBe(unloaded);
    slow.resolve();
    await unloaded;
    expect(kernel.startLoad("a")).toBe(2);
    expect(timers.pending()).toBe(0);
    expect(() => kernel.activate("b")).toThrow(/absent, not loading/);
  });

  it("a registration taken back early leaves the kernel; its undo runs once, and an error in it is the owner's", () => {
    const { kernel } = kernelWith();
    kernel.startLoad("a");
    let undone = 0;
    const reg = kernel.register("a", "x", "k", () => { undone += 1; })!;
    expect(reg.live).toBe(true);
    reg.dispose();
    reg.dispose();
    expect(undone).toBe(1);
    expect(reg.live).toBe(false);
    expect(kernel.registrations("a")).toEqual([]);
    const loud = kernel.register("a", "x", "loud", () => { throw new Error("mine"); })!;
    expect(() => loud.dispose()).toThrow("mine");
    kernel.activate("a");
    kernel.requestUnload("a");
    expect(undone).toBe(1);
  });

  it("async undos: started newest first, awaited, and the unload finishes when the last settles", async () => {
    const { kernel } = kernelWith();
    const started: string[] = [];
    const gates = [deferred(), deferred()];
    kernel.startLoad("a");
    kernel.register("a", "x", "first", () => { started.push("first"); return gates[0]!.promise; });
    kernel.register("a", "x", "sync", () => { started.push("sync"); });
    kernel.register("a", "x", "last", () => { started.push("last"); return gates[1]!.promise; });
    kernel.activate("a");
    let finished = false;
    const unloaded = kernel.requestUnload("a").then((result) => { finished = true; return result; });
    expect(started).toEqual(["last", "sync", "first"]);
    expect(kernel.state("a")).toBe("unloading");
    gates[1]!.resolve();
    await flush();
    expect(finished).toBe(false);
    gates[0]!.resolve();
    expect((await unloaded).failures).toEqual([]);
    expect(kernel.state("a")).toBe("absent");
  });

  it("one failing undo (throwing, rejecting or hanging) is contained, the others run, and each is reported once", async () => {
    const { kernel, failures, timers } = kernelWith({ undoTimeoutMs: 100 });
    const ran: string[] = [];
    kernel.startLoad("a");
    kernel.register("a", "x", "ok1", () => ran.push("ok1"));
    kernel.register("a", "x", "throws", () => { ran.push("throws"); throw new Error("boom"); });
    kernel.register("a", "x", "rejects", () => { ran.push("rejects"); return Promise.reject(new Error("nope")); });
    kernel.register("a", "x", "hangs", () => { ran.push("hangs"); return new Promise(() => {}); });
    kernel.register("a", "x", "ok2", () => ran.push("ok2"));
    kernel.activate("a");
    const unloaded = kernel.requestUnload("a");
    expect(ran).toEqual(["ok2", "hangs", "rejects", "throws", "ok1"]);
    await flush();
    expect(kernel.state("a")).toBe("unloading");
    timers.advance(100);
    const result = await unloaded;
    expect(kernel.state("a")).toBe("absent");
    expect(result.failures.map((failure) => [failure.registration, failure.message])).toEqual([
      ["x:throws#2", "boom"], ["x:rejects#3", "nope"], ["x:hangs#4", "its undo did not finish within 100 ms"],
    ]);
    expect(failures).toEqual(result.failures);
    // Asked again once absent: the same report, not a new one.
    expect((await kernel.requestUnload("a")).failures).toEqual(result.failures);
    expect(failures).toHaveLength(3);
  });

  it("no registration once unloading: a late one is undone at once, also an async one that settles late", async () => {
    const { kernel } = kernelWith();
    const world = new Set<string>();
    const add = (item: string) => { world.add(item); return () => { world.delete(item); }; };
    kernel.startLoad("a");
    const late = deferred<() => void>();
    const pending = kernel.registerAsync("a", "x", "late", late.promise);
    expect(kernel.pendingCount("a")).toBe(1);
    kernel.activate("a");
    const slow = deferred();
    kernel.register("a", "x", "slow", () => slow.promise);
    const unloaded = kernel.requestUnload("a");
    expect(kernel.state("a")).toBe("unloading");
    // While unloading: refused and undone at once.
    expect(kernel.register("a", "x", "during", add("during"))).toBeNull();
    expect(world.has("during")).toBe(false);
    late.resolve(add("late"));
    expect(await pending).toBeNull();
    expect(world.has("late")).toBe(false);
    slow.resolve();
    await unloaded;
    // After: refused too.
    expect(kernel.register("a", "x", "after", add("after"))).toBeNull();
    expect(world.size).toBe(0);
    expect(kernel.holdsNothingOf("a")).toBe(true);
    expect(actions(kernel.events).filter((line) => line.includes("refused") || line.includes("at once") || line.startsWith("RegisterAsync"))).toEqual([
      "RegisterAsyncStart a x:late",
      "Register a x:during (refused)", "RunUndo a x:during (undone at once)",
      "RegisterAsyncSettle a x:late", "Register a x:late (refused)", "RunUndo a x:late (undone at once)",
      "Register a x:after (refused)", "RunUndo a x:after (undone at once)",
    ]);
  });

  it("an async registration of an old generation is undone even when a new instance runs; a pending one is waited for, within the limit", async () => {
    const { kernel, timers, failures } = kernelWith({ undoTimeoutMs: 50 });
    const world = new Set<string>();
    kernel.startLoad("a");
    const stuck = deferred<() => void>();
    void kernel.registerAsync("a", "x", "stuck", stuck.promise);
    kernel.activate("a");
    const unloaded = kernel.requestUnload("a");
    expect(kernel.state("a")).toBe("unloading");
    timers.advance(50);
    expect((await unloaded).failures.map((failure) => failure.registration)).toEqual(["pending"]);
    kernel.startLoad("a");
    kernel.activate("a");
    world.add("stuck");
    stuck.resolve(() => { world.delete("stuck"); });
    await flush();
    expect(world.size).toBe(0);
    expect(kernel.registrations("a")).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it("the event log can go to a function instead, and is off by default", () => {
    const seen: string[] = [];
    const told = new PluginKernel({ log: (event) => seen.push(event.action) });
    told.startLoad("a");
    told.activate("a");
    expect(seen).toEqual(["StartLoad", "Activate"]);
    expect(told.events).toEqual([]);
    const quiet = new PluginKernel();
    quiet.startLoad("a");
    expect(quiet.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Seeded random runs (brief §4 step 2): 3 plugins, at most 40 actions each run.

type UndoKind = "sync" | "throws" | "async" | "rejects" | "hangs";

interface CoreRun { seed: number; actions: string[]; events: KernelEvent[]; steps: number }

/**
 * One random run over the core. Each registration adds an item to `world` and its undo takes it out first (so a failing
 * or hanging undo still leaves the world clean, and residue in the world can only come from the kernel losing an undo).
 * Checks P1, P4, P5 after every action and ends with an unload of everything.
 */
async function coreRun(seed: number, maxActions = 40): Promise<CoreRun> {
  const random = seeded(seed);
  const timers = manualTimers();
  const timeout = 30;
  const kernel = new PluginKernel({ log: true, timers, undoTimeoutMs: timeout });
  const plugins = ["a", "b", "c"];
  const world = new Map<string, string>(); // item → plugin
  const gates: { settle: (ok: boolean) => void }[] = [];
  const asyncSetups: { plugin: string; settle: (ok: boolean) => void }[] = [];
  const unloads: Promise<unknown>[] = [];
  const log: string[] = [];
  let item = 0;

  const makeUndo = (plugin: string, name: string): (() => unknown) => {
    const kind: UndoKind = random.pick(["sync", "sync", "sync", "throws", "async", "rejects", "hangs"] as const);
    return () => {
      world.delete(name);
      if (kind === "throws") throw new Error(`${name} throws`);
      if (kind === "sync") return undefined;
      if (kind === "hangs") return new Promise(() => {});
      const gate = deferred();
      gates.push({ settle: (ok) => (ok && kind !== "rejects" ? gate.resolve() : gate.reject(new Error(`${name} rejects (${plugin})`))) });
      return gate.promise;
    };
  };
  const registerOne = (plugin: string) => {
    const name = `${plugin}-${++item}`;
    world.set(name, plugin);
    kernel.register(plugin, "item", name, makeUndo(plugin, name));
  };
  const registerLater = (plugin: string) => {
    const name = `${plugin}-${++item}`;
    const setup = deferred<(() => unknown) | void>();
    asyncSetups.push({ plugin, settle: (ok) => {
      if (!ok) { setup.reject(new Error("setup failed")); return; }
      world.set(name, plugin);
      setup.resolve(makeUndo(plugin, name));
    } });
    void kernel.registerAsync(plugin, "item", name, setup.promise);
  };

  const check = (where: string) => {
    for (const plugin of plugins) {
      const state = kernel.state(plugin);
      const live = new Set(kernel.registrations(plugin).map((reg) => reg.key));
      const items = [...world].filter(([, owner]) => owner === plugin).map(([name]) => name);
      // P1 (strong form): what the world holds of a plugin is exactly its live registrations.
      const stray = items.filter((name) => !live.has(name));
      if (stray.length) throw new Error(`seed ${seed} ${where}: ${plugin} (${state}) left ${stray.join(", ")} in the world`);
      if (state === "absent" && kernel.pendingCount(plugin) === 0 && !kernel.holdsNothingOf(plugin)) throw new Error(`seed ${seed} ${where}: absent ${plugin} still in the kernel`);
      // P5: an unloading or absent instance holds no live registration (the core unloads at once).
      if ((state === "unloading" || state === "absent") && live.size) throw new Error(`seed ${seed} ${where}: ${state} ${plugin} holds ${[...live].join(", ")}`);
    }
  };

  for (let index = 0; index < maxActions; index += 1) {
    const plugin = random.pick(plugins);
    const state = kernel.state(plugin);
    const choice = random.int(9);
    let action: string;
    if (choice === 0 || (choice === 1 && state === "absent")) {
      action = `load ${plugin}`;
      if (state === "absent") {
        kernel.requestLoad(plugin);
        kernel.startLoad(plugin);
        for (let n = random.int(4); n > 0; n -= 1) registerOne(plugin);
        if (random.chance(0.4)) registerLater(plugin);
        if (random.chance(0.7)) kernel.activate(plugin);
      }
    } else if (choice === 1) {
      action = `activate ${plugin}`;
      if (state === "loading") kernel.activate(plugin);
    } else if (choice === 2) {
      action = `register ${plugin}`;
      registerOne(plugin);
    } else if (choice === 3) {
      action = `register-async ${plugin}`;
      registerLater(plugin);
    } else if (choice === 4 && asyncSetups.length) {
      const at = random.int(asyncSetups.length);
      const ok = random.chance(0.8);
      action = `settle-setup ${asyncSetups[at]!.plugin} ${ok ? "ok" : "fail"}`;
      asyncSetups.splice(at, 1)[0]!.settle(ok);
    } else if (choice === 5 && gates.length) {
      const ok = random.chance(0.7);
      action = `settle-undo ${ok ? "ok" : "fail"}`;
      gates.splice(random.int(gates.length), 1)[0]!.settle(ok);
    } else if (choice === 6) {
      action = `dispose ${plugin}`;
      const regs = kernel.registrations(plugin);
      if (regs.length) {
        // The owner takes it back: what its undo throws or rejects with is the owner's.
        try { void Promise.resolve(regs[random.int(regs.length)]!.dispose()).catch(() => {}); } catch { /* the owner's */ }
      }
    } else if (choice === 7) {
      action = `tick`;
      timers.advance(random.int(timeout + 5));
    } else {
      action = `unload ${plugin}`;
      const before = kernel.registrations(plugin).map((reg) => `${reg.kind}:${reg.key}#${reg.id}`);
      const generation = kernel.generation(plugin);
      const wasLive = state === "loading" || state === "active";
      unloads.push(kernel.requestUnload(plugin));
      if (wasLive) {
        // P4: this unload's undos ran newest first.
        const ran = kernel.events.filter((event) => event.action === "RunUndo" && event.plugin === plugin && event.generation === generation && !event.note).map((event) => event.registration);
        const expected = [...before].reverse();
        if (JSON.stringify(ran.slice(-expected.length || ran.length)) !== JSON.stringify(expected) && expected.length) throw new Error(`seed ${seed}: ${plugin} undid ${ran.join(",")} not ${expected.join(",")}`);
      }
    }
    log.push(action);
    await flush();
    check(action);
  }

  // Unload everything: settles within a bounded number of steps whatever hangs (the time limit marks it failed).
  const startStep = kernel.events.length;
  let finished = false;
  const all = kernel.unloadAll().then(() => { finished = true; });
  for (const setup of asyncSetups.splice(0)) setup.settle(random.chance(0.5));
  for (let round = 0; round < 10 && !finished; round += 1) {
    for (const gate of gates.splice(0)) gate.settle(random.chance(0.5));
    await flush();
    timers.advance(timeout);
    await flush();
  }
  await all;
  await Promise.all(unloads);
  await flush();
  check("unload-all");
  for (const plugin of plugins) {
    if (kernel.state(plugin) !== "absent") throw new Error(`seed ${seed}: ${plugin} is ${kernel.state(plugin)} after unload-all`);
    if (!kernel.holdsNothingOf(plugin)) throw new Error(`seed ${seed}: the kernel still holds ${plugin}`);
  }
  if (world.size) throw new Error(`seed ${seed}: the world still holds ${[...world.keys()].join(", ")}`);
  // P5 over the whole log: every accepted Register came while its instance was loading or active.
  const states = new Map<string, string>();
  for (const event of kernel.events) {
    if (event.action === "StartLoad") states.set(event.plugin, "loading");
    if (event.action === "Activate") states.set(event.plugin, "active");
    if (event.action === "RequestUnload") states.set(event.plugin, "unloading");
    if (event.action === "FinishUnload") states.set(event.plugin, "absent");
    if (event.action === "Register" && !event.note && !["loading", "active"].includes(states.get(event.plugin) ?? "absent")) throw new Error(`seed ${seed}: ${event.registration} accepted while ${states.get(event.plugin)}`);
  }
  return { seed, actions: log, events: kernel.events, steps: kernel.events.length - startStep };
}

describe("seeded random runs over three plugins (P1, P4, P5, P6 stand-in)", () => {
  it("300 runs of at most 40 actions keep the properties and end with every instance absent", async () => {
    let longest = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const run = await coreRun(seed);
      longest = Math.max(longest, run.steps);
    }
    // Unload-all is bounded: at most a handful of events per registration ever made.
    expect(longest).toBeLessThan(400);
  });

  it("a run is deterministic: the same seed gives the same event log", async () => {
    const one = await coreRun(42);
    const two = await coreRun(42);
    expect(two.events).toEqual(one.events);
    expect(two.actions).toEqual(one.actions);
  });
});

