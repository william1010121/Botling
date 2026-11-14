// Services and slots between plugins (Web/src/plugin-kernel/services.ts, kernel step 1 step 3): provides / requires / uses,
// slot ownership, the requires graph that refuses cycles at install, unload order (dependents first), a provider swap
// that re-binds its users; then seeded random runs that keep P2 (no contribution shown in a slot whose owner or
// contributor is not active), P3 (an active instance always has its required services from an active provider; a provider
// never starts undoing while a loaded plugin requires it), P1 for services, slots and contributions, and end with
// every instance absent.
import { describe, expect, it } from "vitest";
import { Kernel, KernelError, findCycle, type KernelEvent, type PluginDeclaration } from "../../../Web/src/plugin-kernel";
import { deferred, flush, manualTimers, seeded } from "../kernel-driver";

const lines = (events: KernelEvent[]) => events.map((event) => `${event.action} ${event.plugin}${event.note ? ` (${event.note})` : ""}`);

describe("installing declarations", () => {
  it("refuses a requires cycle at install, with the plugins on it", () => {
    const kernel = new Kernel();
    kernel.install({ name: "a", provides: { services: ["a.s"] }, requires: { services: ["b.s"] } });
    kernel.install({ name: "b", provides: { services: ["b.s"] }, requires: { services: ["c.s"] } });
    expect(() => kernel.install({ name: "c", provides: { services: ["c.s"] }, requires: { services: ["a.s"] } }))
      .toThrow(new KernelError("cycle", "The plugins' dependencies (requires, slot contributions) make a cycle: a → b → c → a."));
    expect(kernel.declaration("c")).toBeUndefined();
    // A plugin that requires its own service is a cycle too; uses (soft) never is.
    expect(() => kernel.install({ name: "self", provides: { services: ["self.s"] }, requires: { services: ["self.s"] } })).toThrow(/self → self/);
    kernel.install({ name: "c", provides: { services: ["c.s"] }, uses: { services: ["a.s"] } });
    expect(kernel.requiresGraph()).toEqual({ a: ["b"], b: ["c"], c: [] });
    // Contributing to a slot is depending on its owner: two plugins contributing to each other's slots are a cycle too
    // (each would wait for the other to be active); contributing to one's own slot is not.
    const slots = new Kernel();
    slots.install({ name: "x", provides: { slots: ["x/rail"] }, contributes: { slots: ["y/rail", "x/rail"] } });
    expect(() => slots.install({ name: "y", provides: { slots: ["y/rail"] }, contributes: { slots: ["x/rail"] } })).toThrow(/cycle: x → y → x/);
    slots.install({ name: "y", provides: { slots: ["y/rail"] } });
    expect(slots.dependencyGraph()).toEqual({ x: ["y"], y: [] });
    expect(slots.requiresGraph()).toEqual({ x: [], y: [] });
  });

  it("refuses a service or slot another plugin provides; a plugin may replace its own declaration", () => {
    const kernel = new Kernel();
    kernel.install({ name: "chat", provides: { services: ["composer.insertQuote"], slots: ["chat/link"] } });
    expect(() => kernel.install({ name: "other", provides: { services: ["composer.insertQuote"] } })).toThrow(/already provided by "chat"/);
    expect(() => kernel.install({ name: "other", provides: { slots: ["chat/link"] } })).toThrow(/Slot "chat\/link" is already provided/);
    kernel.install({ name: "chat", provides: { services: ["composer.insertQuote", "chat.current"] } });
    expect(kernel.declaration("chat")?.provides).toEqual({ services: ["composer.insertQuote", "chat.current"], slots: [] });
  });

  it("findCycle finds none in an acyclic graph", () => {
    const declarations = new Map<string, PluginDeclaration>([
      ["a", { name: "a", requires: { services: ["s"] } }], ["b", { name: "b", provides: { services: ["s"] } }],
    ]);
    expect(findCycle(declarations)).toBeNull();
  });
});

describe("services", () => {
  it("a plugin that requires a service waits until an active plugin provides it, then loads by itself", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { services: ["composer.insertQuote"] } });
    kernel.install({ name: "note", requires: { services: ["composer.insertQuote"] } });
    expect(await kernel.load("note", () => {})).toEqual({ status: "waiting", missing: ['"composer.insertQuote"'] });
    expect(kernel.state("note")).toBe("absent");
    expect(() => kernel.startLoad("note")).toThrow(/requires "composer.insertQuote", which no active plugin provides/);
    const quoted: string[] = [];
    expect(await kernel.load("chat", (plugin) => { kernel.provide(plugin, "composer.insertQuote", (text: string) => { quoted.push(text); return true; }); })).toEqual({ status: "active" });
    expect(kernel.state("note")).toBe("active");
    expect(kernel.call("note", "composer.insertQuote", "> hi")).toEqual({ absent: false, value: true });
    expect(quoted).toEqual(["> hi"]);
    expect(kernel.providerOf("composer.insertQuote")).toBe("chat");
  });

  it("a soft dependency (uses) may be absent: the call finds nothing", async () => {
    const kernel = new Kernel();
    kernel.install({ name: "note", uses: { services: ["reader.at"] } });
    expect(await kernel.load("note", () => {})).toEqual({ status: "active" });
    expect(kernel.call("note", "reader.at", 1)).toEqual({ absent: true });
  });

  it("a plugin may provide only what it declares, and one provider at a time", async () => {
    const kernel = new Kernel();
    kernel.install({ name: "a", provides: { services: ["a.s"] } });
    await kernel.load("a", () => {});
    expect(() => kernel.provide("a", "b.s", 1)).toThrow(/does not declare that it provides "b.s"/);
    kernel.provide("a", "a.s", 1);
    expect(() => kernel.provide("a", "a.s", 2)).toThrow(/already provided by "a"/);
    expect(() => kernel.provideSlot("a", "x/y")).toThrow(/does not declare that it provides slot/);
  });

  it("dependents unload first (and stay wanted), their teardown may still call the service, and they come back with the provider", async () => {
    const kernel = new Kernel({ log: true });
    const seen: string[] = [];
    kernel.install({ name: "chat", provides: { services: ["quote"] } });
    kernel.install({ name: "note", requires: { services: ["quote"] } });
    kernel.install({ name: "coach", requires: { services: ["quote"] } });
    const chat = (plugin: string) => { kernel.provide(plugin, "quote", (text: string) => seen.push(`quote ${text}`)); kernel.register(plugin, "x", "chat-ui", () => seen.push("chat undone")); };
    const user = (plugin: string) => { kernel.register(plugin, "x", `${plugin}-ui`, () => { kernel.call(plugin, "quote", `bye from ${plugin}`); seen.push(`${plugin} undone`); }); };
    await kernel.load("chat", chat);
    await kernel.load("note", user);
    await kernel.load("coach", user);
    kernel.events.splice(0);
    const unloaded = kernel.requestUnload("chat");
    expect(["note", "coach", "chat"].map((name) => kernel.state(name))).toEqual(["absent", "absent", "absent"]);
    await unloaded;
    // The last loaded dependent first.
    expect(seen).toEqual(["quote bye from coach", "coach undone", "quote bye from note", "note undone", "chat undone"]);
    expect(lines(kernel.events)).toEqual([
      "RequestUnload coach (dependency)", "BeginUnload coach", "RunUndo coach", "FinishUnload coach",
      "RequestUnload note (dependency)", "BeginUnload note", "RunUndo note", "FinishUnload note",
      "RequestUnload chat", "BeginUnload chat", "RunUndo chat", "RunUndo chat", "FinishUnload chat",
    ]);
    expect(kernel.wanted().sort()).toEqual(["coach", "note"]);
    await kernel.load("chat");
    expect(["note", "coach"].map((name) => kernel.state(name))).toEqual(["active", "active"]);
    // Asked for by name, a dependent is no longer wanted and stays away.
    await kernel.requestUnload("note");
    await kernel.requestUnload("chat");
    await kernel.load("chat");
    expect([kernel.state("note"), kernel.state("coach")]).toEqual(["absent", "active"]);
  });

  it("a provider's undos wait until a dependent's async teardown finished (P4)", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "p", provides: { services: ["s"] } });
    kernel.install({ name: "d", requires: { services: ["s"] } });
    const slow = deferred();
    let providerUndone = false;
    await kernel.load("p", (plugin) => { kernel.provide(plugin, "s", 1); kernel.register(plugin, "x", "p", () => { providerUndone = true; }); });
    await kernel.load("d", (plugin) => { kernel.register(plugin, "x", "d", () => slow.promise); });
    const unloaded = kernel.requestUnload("p");
    expect([kernel.state("d"), kernel.state("p")]).toEqual(["unloading", "unloading"]);
    // The service is still there for d's teardown.
    expect(kernel.service("s")).toBe(1);
    await flush();
    expect(providerUndone).toBe(false);
    slow.resolve();
    await unloaded;
    expect(providerUndone).toBe(true);
    expect(kernel.providerOf("s")).toBeNull();
    const at = (line: string) => lines(kernel.events).indexOf(line);
    expect(at("FinishUnload d")).toBeLessThan(at("BeginUnload p"));
  });

  it("a swap replaces the provider: its users unload first, then load again bound to the new code", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { services: ["version"] } });
    kernel.install({ name: "note", requires: { services: ["version"] } });
    const bound: unknown[] = [];
    await kernel.load("chat", (plugin) => { kernel.provide(plugin, "version", () => 1); });
    await kernel.load("note", (plugin) => { bound.push(kernel.call(plugin, "version")); });
    expect(await kernel.swap("chat", (plugin) => { kernel.provide(plugin, "version", () => 2); })).toEqual({ status: "active" });
    expect(bound).toEqual([{ absent: false, value: 1 }, { absent: false, value: 2 }]);
    expect([kernel.generation("chat"), kernel.generation("note")]).toEqual([2, 2]);
    expect(lines(kernel.events).filter((line) => /Swap|RequestUnload|Activate/.test(line)).slice(-5)).toEqual([
      "Swap chat", "RequestUnload note (dependency)", "RequestUnload chat (swap)", "Activate chat", "Activate note",
    ]);
  });

  it("a loader that fails unloads what it registered and is not tried again", async () => {
    const kernel = new Kernel();
    const world = new Set<string>();
    kernel.install({ name: "p", provides: { services: ["s"] } });
    const outcome = await kernel.load("p", (plugin) => { kernel.provide(plugin, "s", 1); world.add("x"); kernel.register(plugin, "x", "x", () => world.delete("x")); throw new Error("broken"); });
    expect(outcome).toEqual({ status: "failed", message: "broken" });
    expect(kernel.state("p")).toBe("absent");
    expect(world.size).toBe(0);
    expect(kernel.providerOf("s")).toBeNull();
    expect(kernel.wanted()).toEqual([]);
    const late = await kernel.load("p", async () => { await Promise.resolve(); throw new Error("async broken"); });
    expect(late).toEqual({ status: "failed", message: "async broken" });
  });
});

describe("slots", () => {
  it("a contribution shows only while its contributor and the slot's owner are active; one to a slot nobody owns is refused", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "coach", contributes: { slots: ["chat/link", "free/slot"] } });
    const undone: string[] = [];
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); });
    await kernel.load("coach", (plugin) => {
      kernel.contribute(plugin, "chat/link", { command: "coach.start", title: "開始陪讀" }, () => undone.push("coach.start"));
      // No plugin declares that it provides this slot: refused and undone at once (K2).
      kernel.contribute(plugin, "free/slot", "x", () => undone.push("free"));
    });
    expect(undone).toEqual(["free"]);
    expect(lines(kernel.events).filter((line) => line.startsWith("Register coach (refused"))).toEqual(["Register coach (refused: no plugin owns the slot)"]);
    expect(kernel.entries("chat/link").map((entry) => [entry.plugin, entry.entry])).toEqual([["coach", { command: "coach.start", title: "開始陪讀" }]]);
    expect(kernel.slotOwner("chat/link")).toBe("chat");
    // coach is a dependent of chat: it unloads first, and stays wanted.
    await kernel.requestUnload("chat");
    expect([kernel.state("coach"), kernel.entries("chat/link"), kernel.allContributions(), undone]).toEqual(["absent", [], [], ["free", "coach.start"]]);
    await kernel.load("chat");
    expect(kernel.state("coach")).toBe("active");
  });

  it("a plugin that declares a contribution waits for the slot's owner, loads by itself once it is active, and unloads before it", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "coach", contributes: { slots: ["chat/link"] } });
    const coach = (plugin: string) => { kernel.contribute(plugin, "chat/link", "開始陪讀"); };
    expect(await kernel.load("coach", coach)).toEqual({ status: "waiting", missing: ['slot "chat/link"'] });
    expect(() => kernel.startLoad("coach")).toThrow('Plugin "coach" contributes to slot "chat/link", whose owner is not active.');
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); });
    expect(kernel.entries("chat/link").map((entry) => entry.entry)).toEqual(["開始陪讀"]);
    kernel.events.splice(0);
    await kernel.requestUnload("chat");
    expect(lines(kernel.events)).toEqual([
      "RequestUnload coach (dependency)", "BeginUnload coach", "RunUndo coach", "FinishUnload coach",
      "RequestUnload chat", "BeginUnload chat", "RunUndo chat", "FinishUnload chat",
    ]);
  });
});

describe("K1: a provider's teardown starts only after its dependents finished unloading (found by the TLA+ model)", () => {
  it("a slot owner waits until a contributor's async undos (of its contribution there and in a third plugin's slot) are done", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "board", provides: { slots: ["board/rail"] } });
    kernel.install({ name: "coach", contributes: { slots: ["chat/link", "board/rail"] } });
    const slow = deferred();
    let ownerTornDown = false;
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); kernel.register(plugin, "ui", "chat", () => { ownerTornDown = true; }); });
    await kernel.load("board", (plugin) => { kernel.provideSlot(plugin, "board/rail"); });
    await kernel.load("coach", (plugin) => {
      kernel.contribute(plugin, "board/rail", "rail entry");
      kernel.contribute(plugin, "chat/link", "開始陪讀", () => slow.promise);
    });
    const unloaded = kernel.requestUnload("chat");
    // The contributor left the active state at once, but is still unloading: its contributions are still held.
    expect([kernel.state("coach"), kernel.state("chat")]).toEqual(["unloading", "unloading"]);
    await flush();
    expect(ownerTornDown).toBe(false);
    expect(lines(kernel.events)).not.toContain("BeginUnload chat");
    slow.resolve();
    await unloaded;
    expect(ownerTornDown).toBe(true);
    expect(kernel.allContributions()).toEqual([]);
    const at = (line: string) => lines(kernel.events).indexOf(line);
    expect(at("FinishUnload coach")).toBeLessThan(at("BeginUnload chat"));
    // The third plugin's slot lost the contribution too; board itself never unloaded.
    expect([kernel.state("board"), kernel.entries("board/rail")]).toEqual(["active", []]);
  });

  it("a declared contributor's slow undo of its contribution keeps the owner from beginning its own", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "note", contributes: { slots: ["chat/link"] } });
    const slow = deferred();
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); });
    await kernel.load("note", (plugin) => { kernel.contribute(plugin, "chat/link", "問", () => slow.promise); });
    const unloaded = kernel.requestUnload("chat");
    await flush();
    // note is still unloading (its contribution's undo has not finished): chat has not begun.
    expect(kernel.state("note")).toBe("unloading");
    expect(lines(kernel.events)).not.toContain("BeginUnload chat");
    slow.resolve();
    await unloaded;
    expect(kernel.allContributions()).toEqual([]);
  });
});

describe("a contribution stays inside the declared graph", () => {
  it("one to a slot the plugin did not declare is refused and undone at once, so live contributions cannot make a cycle", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "A", provides: { slots: ["a"] } });
    kernel.install({ name: "B", provides: { slots: ["b"] } });
    await kernel.load("A", (plugin) => { kernel.provideSlot(plugin, "a"); });
    await kernel.load("B", (plugin) => { kernel.provideSlot(plugin, "b"); });
    const undone: string[] = [];
    expect(kernel.contribute("A", "b", 1, () => undone.push("A→b"))).toBeNull();
    expect(kernel.contribute("B", "a", 2, () => undone.push("B→a"))).toBeNull();
    expect([undone, kernel.allContributions()]).toEqual([["A→b", "B→a"], []]);
    expect(lines(kernel.events).filter((line) => line.startsWith("Register A") || line.startsWith("Register B")).slice(-2)).toEqual([
      'Register A (refused: "A" does not declare that it contributes to slot "b")', 'Register B (refused: "B" does not declare that it contributes to slot "a")',
    ]);
    // A plugin's own slot needs no declaration.
    expect(kernel.contribute("A", "a", "own")).not.toBeNull();
    await kernel.requestUnload("A");
    expect([kernel.state("A"), kernel.state("B")]).toEqual(["absent", "active"]);
  });
});

describe("K2: nothing loads or contributes into a slot whose owner is being torn down (found by the TLA+ model)", () => {
  it("a contributor asked to load while the owner unloads waits, and loads once the owner is active again", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "coach", contributes: { slots: ["chat/link"] } });
    const slow = deferred();
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); kernel.register(plugin, "ui", "chat", () => slow.promise); });
    const unloading = kernel.requestUnload("chat");
    expect(kernel.state("chat")).toBe("unloading");
    expect(await kernel.load("coach", (plugin) => { kernel.contribute(plugin, "chat/link", "開始陪讀"); })).toEqual({ status: "waiting", missing: ['slot "chat/link"'] });
    expect(kernel.state("coach")).toBe("absent");
    expect(kernel.allContributions()).toEqual([]);
    slow.resolve();
    await unloading;
    await kernel.load("chat");
    expect(kernel.state("coach")).toBe("active");
    expect(kernel.entries("chat/link").map((entry) => entry.entry)).toEqual(["開始陪讀"]);
  });

  it("a contribution offered while the owner waits for its dependents (its slot still open) is refused and undone at once", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "coach", contributes: { slots: ["chat/link"] } });
    kernel.install({ name: "other", contributes: { slots: ["chat/link"] } });
    const slow = deferred();
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); });
    await kernel.load("coach", (plugin) => { kernel.contribute(plugin, "chat/link", "開始陪讀", () => slow.promise); });
    await kernel.load("other", () => {});
    const unloading = kernel.requestUnload("chat");
    // chat is unloading but has not begun its undos (K1: coach is still unloading), so the slot is still registered.
    expect([kernel.state("chat"), kernel.slotOwner("chat/link"), kernel.state("coach")]).toEqual(["unloading", "chat", "unloading"]);
    const undone: string[] = [];
    expect(kernel.contribute("other", "chat/link", "late", () => undone.push("late"))).toBeNull();
    expect([undone, kernel.allContributions()]).toEqual([["late"], []]);
    // other declares the slot, so it is a dependent of chat and went first (absent by now); the owner's state is what the
    // refusal names.
    expect(lines(kernel.events).filter((line) => line.startsWith("Register other"))).toEqual(['Register other (refused: the slot\'s owner "chat" is unloading)']);
    slow.resolve();
    await unloading;
    await kernel.load("chat");
    expect(kernel.state("other")).toBe("active");
  });

  it("a contribution made while the owner is unloading is refused and undone at once", async () => {
    const kernel = new Kernel({ log: true });
    kernel.install({ name: "chat", provides: { slots: ["chat/link"] } });
    kernel.install({ name: "other", contributes: { slots: ["chat/link"] } });
    const slow = deferred();
    await kernel.load("chat", (plugin) => { kernel.provideSlot(plugin, "chat/link"); kernel.register(plugin, "ui", "chat", () => slow.promise); });
    await kernel.load("other", () => {});
    const unloading = kernel.requestUnload("chat");
    const undone: string[] = [];
    expect(kernel.contribute("other", "chat/link", "late", () => undone.push("late"))).toBeNull();
    expect([undone, kernel.allContributions()]).toEqual([["late"], []]);
    expect([kernel.state("chat"), kernel.state("other")]).toEqual(["unloading", "absent"]);
    expect(lines(kernel.events).filter((line) => line.startsWith("Register other"))).toEqual(['Register other (refused: the slot\'s owner "chat" is unloading)']);
    slow.resolve();
    await unloading;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Seeded random runs (brief §4 step 3).

const SERVICES = ["s1", "s2"];
const SLOTS = ["slot/x", "slot/y"];
const PLUGINS = ["a", "b", "c"];

/** Whether the declarations' dependency graph (requires, slot contributions) has a cycle (brute force: some plugin reaches itself). */
function hasCycle(declarations: PluginDeclaration[]): boolean {
  const providers = (name: string) => {
    const declaration = declarations.find((d) => d.name === name);
    return declarations.filter((other) => (declaration?.requires?.services ?? []).some((service) => other.provides?.services?.includes(service))
      || (other.name !== name && (declaration?.contributes?.slots ?? []).some((slot) => other.provides?.slots?.includes(slot)))).map((other) => other.name);
  };
  return declarations.some((start) => {
    const seen = new Set<string>();
    const stack = providers(start.name);
    while (stack.length) {
      const next = stack.pop()!;
      if (next === start.name) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...providers(next));
    }
    return false;
  });
}

async function serviceRun(seed: number, maxActions = 40): Promise<{ steps: number; refusedCycles: number }> {
  const random = seeded(seed);
  const timers = manualTimers();
  const timeout = 30;
  let kernel!: Kernel;
  const problems: string[] = [];
  const declarations: PluginDeclaration[] = [];
  kernel = new Kernel({
    timers, undoTimeoutMs: timeout,
    log: (event) => {
      const declared = declarations.find((d) => d.name === event.plugin);
      if (event.action === "BeginUnload") {
        // P4 and K1 at the moment a provider starts undoing: everything that depends on it (requires its services, or
        // contributes to its slots by declaration or by a live contribution) has finished unloading: absent, not just inactive.
        const provided = declared?.provides?.services ?? [];
        const owned = declared?.provides?.slots ?? [];
        const contributing = new Set(kernel.allContributions().filter((c) => owned.includes(c.slot)).map((c) => c.plugin));
        for (const other of declarations) {
          if (other.name === event.plugin) continue;
          const depends = (other.requires?.services ?? []).some((service) => provided.includes(service)) || (other.contributes?.slots ?? []).some((slot) => owned.includes(slot)) || contributing.has(other.name);
          if (depends && kernel.state(other.name) !== "absent") problems.push(`${event.plugin} began undoing while ${other.name} (depending on it) was ${kernel.state(other.name)}`);
        }
      } else if (event.action === "StartLoad") {
        // P3 and K2 at the start of a load: its providers and the owners of the slots it contributes to are active.
        for (const service of declared?.requires?.services ?? []) {
          const provider = declarations.find((d) => d.provides?.services?.includes(service))?.name;
          if (!provider || kernel.state(provider) !== "active") problems.push(`${event.plugin} started loading while ${service}'s provider was ${provider ? kernel.state(provider) : "missing"}`);
        }
        for (const slot of declared?.contributes?.slots ?? []) {
          const owner = declarations.find((d) => d.provides?.slots?.includes(slot))?.name;
          if (owner && owner !== event.plugin && kernel.state(owner) !== "active") problems.push(`${event.plugin} started loading while ${slot}'s owner was ${kernel.state(owner)}`);
        }
      } else if (event.action === "Register" && !event.note && event.registration?.startsWith("contribution:")) {
        // K2 at each accepted contribution: the slot's owner is active (or it is the contributor's own slot).
        const slot = event.registration.slice("contribution:".length, event.registration.lastIndexOf("#"));
        const owner = kernel.slotOwner(slot);
        if (!owner || (owner !== event.plugin && kernel.state(owner) !== "active")) problems.push(`${event.plugin}'s contribution to ${slot} was accepted while its owner was ${owner ? kernel.state(owner) : "missing"}`);
      }
    },
  });
  // Random declarations: each service has one provider; requires point at the others' services; a cycle is refused.
  const owners = new Map(SERVICES.map((service) => [service, random.pick(PLUGINS)]));
  const slotOwners = new Map(SLOTS.map((slot) => [slot, random.pick(PLUGINS)]));
  let refusedCycles = 0;
  for (const name of PLUGINS) {
    const provides = SERVICES.filter((service) => owners.get(service) === name);
    const requires = SERVICES.filter((service) => owners.get(service) !== name && random.chance(0.5));
    const contributes = SLOTS.filter((slot) => slotOwners.get(slot) !== name && random.chance(0.5));
    const declaration: PluginDeclaration = { name, provides: { services: provides, slots: SLOTS.filter((slot) => slotOwners.get(slot) === name) }, requires: { services: requires }, contributes: { slots: contributes } };
    const cyclic = hasCycle([...declarations, declaration]);
    try {
      kernel.install(declaration);
      if (cyclic) throw new Error(`seed ${seed}: a cycle was installed`);
      declarations.push(declaration);
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== "cycle" || !cyclic) throw error;
      refusedCycles += 1;
      // Installed without its dependencies instead.
      const plain = { ...declaration, requires: { services: [] }, contributes: { slots: [] } };
      kernel.install(plain);
      declarations.push(plain);
    }
  }

  const world = new Map<string, string>();
  const gates: ((ok: boolean) => void)[] = [];
  let item = 0;
  const undoFor = (name: string) => {
    const kind = random.pick(["sync", "sync", "throws", "async", "hangs"] as const);
    return () => {
      world.delete(name);
      if (kind === "throws") throw new Error("undo throws");
      if (kind === "hangs") return new Promise(() => {});
      if (kind === "async") { const gate = deferred(); gates.push((ok) => (ok ? gate.resolve() : gate.reject(new Error("undo rejects")))); return gate.promise; }
      return undefined;
    };
  };
  const loaderFor = (version: number) => (plugin: string) => {
    const declaration = declarations.find((d) => d.name === plugin)!;
    for (const service of declaration.provides?.services ?? []) kernel.provide(plugin, service, `${plugin}@${version}`);
    for (const slot of declaration.provides?.slots ?? []) kernel.provideSlot(plugin, slot);
    // Its declared contributions (their owners are active: K2), and sometimes one it did not declare (refused unless the owner is active).
    for (const slot of SLOTS) {
      if (!declaration.contributes?.slots?.includes(slot) && !random.chance(0.3)) continue;
      const name = `${plugin}→${slot}-${++item}`;
      world.set(name, plugin);
      if (!kernel.contribute(plugin, slot, name, undoFor(name))) world.delete(name);
    }
    for (let n = random.int(3); n > 0; n -= 1) { const name = `${plugin}-${++item}`; world.set(name, plugin); kernel.register(plugin, "item", name, undoFor(name)); }
  };
  const loads: Promise<unknown>[] = [];

  const check = (where: string) => {
    for (const plugin of PLUGINS) {
      const state = kernel.state(plugin);
      // P3: an active instance has every required service from an active provider.
      if (state === "active" && kernel.missing(plugin).length) problems.push(`${where}: ${plugin} active without ${kernel.missing(plugin).join(", ")}`);
      const live = new Set([...kernel.registrations(plugin).map((reg) => reg.key), ...kernel.allContributions<string>().filter((c) => c.plugin === plugin).map((c) => c.entry)]);
      for (const [name, owner] of world) if (owner === plugin && !live.has(name)) problems.push(`${where}: ${plugin} left ${name}`);
    }
    // P2: what a slot shows has an active contributor and an active owner.
    for (const slot of SLOTS) {
      for (const entry of kernel.entries(slot)) {
        if (kernel.state(entry.plugin) !== "active" || kernel.state(kernel.slotOwner(slot)!) !== "active") problems.push(`${where}: ${slot} shows ${entry.plugin}'s entry`);
      }
    }
    // P1 for contributions and services: none belongs to an absent instance; P2 as the model states it (NoOrphan): a held
    // contribution's slot has an owner that is not absent.
    for (const contribution of kernel.allContributions()) {
      if (kernel.state(contribution.plugin) === "absent") problems.push(`${where}: absent ${contribution.plugin} still contributes`);
      const owner = kernel.slotOwner(contribution.slot);
      if (!owner || kernel.state(owner) === "absent") problems.push(`${where}: ${contribution.plugin}'s contribution to ${contribution.slot} outlived its owner`);
    }
    for (const service of SERVICES) { const provider = kernel.providerOf(service); if (provider && kernel.state(provider) === "absent") problems.push(`${where}: absent ${provider} still provides ${service}`); }
    if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`);
  };

  let version = 0;
  for (let index = 0; index < maxActions; index += 1) {
    const plugin = random.pick(PLUGINS);
    const choice = random.int(7);
    let action: string;
    if (choice <= 1) { action = `load ${plugin}`; loads.push(kernel.load(plugin, loaderFor(++version))); }
    else if (choice === 2) { action = `unload ${plugin}`; loads.push(kernel.requestUnload(plugin)); }
    else if (choice === 3) { action = `swap ${plugin}`; loads.push(kernel.swap(plugin, loaderFor(++version))); }
    else if (choice === 4 && gates.length) { action = "settle"; gates.splice(random.int(gates.length), 1)[0]!(random.chance(0.7)); }
    else if (choice === 5) { action = "tick"; timers.advance(random.int(timeout + 5)); }
    else { action = `register ${plugin}`; const name = `${plugin}-${++item}`; world.set(name, plugin); kernel.register(plugin, "item", name, undoFor(name)); }
    await flush();
    check(action);
  }
  const before = kernel.events.length;
  let finished = false;
  const all = kernel.unloadAll().then(() => { finished = true; });
  for (let round = 0; round < 20 && !finished; round += 1) {
    for (const gate of gates.splice(0)) gate(random.chance(0.5));
    await flush();
    timers.advance(timeout);
    await flush();
  }
  await all;
  await Promise.all(loads.map((load) => load.catch(() => {})));
  // Loads that were waiting to start after an unload may have started meanwhile; unload once more until quiet.
  for (let round = 0; round < 5 && kernel.plugins().length; round += 1) {
    const again = kernel.unloadAll();
    for (let tick = 0; tick < 10; tick += 1) { for (const gate of gates.splice(0)) gate(true); await flush(); timers.advance(timeout); await flush(); }
    await again;
  }
  check("unload-all");
  for (const plugin of PLUGINS) if (!kernel.holdsNothingOf(plugin)) throw new Error(`seed ${seed}: the kernel still holds ${plugin} (${kernel.state(plugin)})`);
  if (world.size || kernel.allContributions().length || SERVICES.some((service) => kernel.providerOf(service))) throw new Error(`seed ${seed}: residue after unload-all`);
  return { steps: kernel.events.length - before, refusedCycles };
}

describe("seeded random runs with services and slots (P1, P2, P3/P4, P6 stand-in)", () => {
  it("300 runs keep the properties (with K1 and K2), refuse every cycle at install, and end with every instance absent", async () => {
    let cycles = 0;
    for (let seed = 1; seed <= 300; seed += 1) cycles += (await serviceRun(seed)).refusedCycles;
    // The random declarations do try cycles (two plugins each requiring the other's service).
    expect(cycles).toBeGreaterThan(0);
  });
});
