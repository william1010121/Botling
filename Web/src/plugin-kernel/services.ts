// Services and slots between plugins, on the kernel core (kernel.ts; plugin-kernel design §5.2, §5.3; kernel step 1 step 3).
//
// A plugin's declaration (its manifest's `provides`, `requires`, `uses`; read for built-in plugins only in step 1) is
// installed before it loads. The kernel then:
//   - refuses a declaration that would make a `requires` cycle, or provide a service or slot another plugin provides;
//   - starts or activates an instance only while every service it `requires` is provided by an active instance (P3);
//     `uses` is soft: the service may be absent, and a call then finds nothing;
//   - unloads the instances that require a plugin's services before that plugin's own undos start (P4), keeping them
//     wanted, so they load again (re-bound to the new provider) once the service is back, e.g. after a `swap`;
//   - shows a contribution in a slot only while both its contributor and the slot's owner are active (P2); a contribution
//     to a slot whose owner is gone stays dormant with its contributor and shows again when the owner is back.
// Every service, slot and contribution is an ordinary registration of its plugin, so it goes with the plugin's unload.

import { KernelError, PluginKernel, type KernelOptions, type Registration, type Undo } from "./kernel";

export interface PluginDeclaration {
  name: string;
  provides?: { services?: readonly string[]; slots?: readonly string[] };
  requires?: { services?: readonly string[] };
  uses?: { services?: readonly string[] };
}

/** Loads one instance: registers what the plugin adds (sync or async); the kernel activates it when this settles. */
export type Loader = (plugin: string, generation: number) => unknown;

export type LoadOutcome = { status: "active" } | { status: "waiting"; missing: string[] } | { status: "failed"; message: string };

export interface SlotEntry<T = unknown> { plugin: string; entry: T; registration: Registration }

const list = (values: readonly string[] | undefined) => [...new Set(values ?? [])];
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";

export class Kernel extends PluginKernel {
  private readonly declarations = new Map<string, PluginDeclaration>();
  private readonly services = new Map<string, { plugin: string; impl: unknown; registration: Registration }>();
  private readonly slots = new Map<string, { plugin: string; registration: Registration }>();
  private readonly contributions = new Map<number, { plugin: string; slot: string; entry: unknown; registration: Registration }>();
  private readonly loaders = new Map<string, Loader>();
  private readonly wantedSet = new Set<string>();
  private readonly loads = new Map<string, Promise<LoadOutcome>>();
  private retrying = false;

  constructor(options: KernelOptions = {}) {
    super(options);
  }

  // MARK: Declarations (install)

  /**
   * Installs (or replaces) a plugin's declaration. Refused with a KernelError when it would make a `requires` cycle
   * ("cycle"), or provide a service or slot another installed plugin provides ("conflict").
   */
  install(declaration: PluginDeclaration): void {
    const next: PluginDeclaration = {
      name: declaration.name,
      provides: { services: list(declaration.provides?.services), slots: list(declaration.provides?.slots) },
      requires: { services: list(declaration.requires?.services) },
      uses: { services: list(declaration.uses?.services) },
    };
    for (const other of this.declarations.values()) {
      if (other.name === next.name) continue;
      const service = next.provides!.services!.find((name) => other.provides?.services?.includes(name));
      if (service) throw new KernelError("conflict", `Service "${service}" is already provided by "${other.name}".`);
      const slot = next.provides!.slots!.find((name) => other.provides?.slots?.includes(name));
      if (slot) throw new KernelError("conflict", `Slot "${slot}" is already provided by "${other.name}".`);
    }
    const cycle = findCycle(new Map([...this.declarations, [next.name, next]]));
    if (cycle) throw new KernelError("cycle", `The plugins' requires make a cycle: ${cycle.join(" → ")}.`);
    this.declarations.set(next.name, next);
  }

  /** Forgets a declaration (its instance must be absent). */
  uninstall(plugin: string): void {
    if (this.state(plugin) !== "absent") throw new KernelError("busy", `Plugin "${plugin}" is ${this.state(plugin)}.`);
    this.declarations.delete(plugin);
    this.loaders.delete(plugin);
    this.wantedSet.delete(plugin);
  }

  declaration(plugin: string): PluginDeclaration | undefined {
    return this.declarations.get(plugin);
  }

  /** Each installed plugin with the plugins whose services it requires (by declaration). */
  requiresGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    for (const [name, declaration] of this.declarations) graph[name] = providersOf(this.declarations, declaration);
    return graph;
  }

  // MARK: Services

  /** `plugin` provides `service` (it must declare it). Refused when another provider holds it. */
  provide(plugin: string, service: string, impl: unknown): Registration | null {
    const declared = this.declarations.get(plugin)?.provides?.services ?? [];
    if (!declared.includes(service)) throw new KernelError("undeclared", `Plugin "${plugin}" does not declare that it provides "${service}".`);
    const held = this.services.get(service);
    if (held && held.registration.live) throw new KernelError("conflict", `Service "${service}" is already provided by "${held.plugin}".`);
    let registration: Registration | null = null;
    registration = this.register(plugin, "service", service, () => {
      if (this.services.get(service)?.registration === registration) this.services.delete(service);
    });
    if (registration) {
      this.services.set(service, { plugin, impl, registration });
      this.retryWanted();
    }
    return registration;
  }

  /** The plugin whose registration provides `service` now (null: none). */
  providerOf(service: string): string | null {
    return this.services.get(service)?.plugin ?? null;
  }

  /** The implementation of `service` while it is registered (also while its provider waits for dependents to unload); null: absent. */
  service<T = unknown>(service: string): T | null {
    return (this.services.get(service)?.impl as T | undefined) ?? null;
  }

  /** Calls a function service for `caller`; `absent` (and no call) when no plugin provides it. */
  call<R = unknown>(caller: string, service: string, ...args: unknown[]): { absent: true } | { absent: false; value: R } {
    void caller; // who asks is known here; grants (M5) will check it
    const impl = this.service<(...given: unknown[]) => R>(service);
    if (typeof impl !== "function") return { absent: true };
    return { absent: false, value: impl(...args) };
  }

  // MARK: Slots

  /** `plugin` owns `slot` (it must declare it). Refused when another owner holds it. */
  provideSlot(plugin: string, slot: string): Registration | null {
    const declared = this.declarations.get(plugin)?.provides?.slots ?? [];
    if (!declared.includes(slot)) throw new KernelError("undeclared", `Plugin "${plugin}" does not declare that it provides slot "${slot}".`);
    const held = this.slots.get(slot);
    if (held && held.registration.live) throw new KernelError("conflict", `Slot "${slot}" is already provided by "${held.plugin}".`);
    let registration: Registration | null = null;
    registration = this.register(plugin, "slot", slot, () => {
      if (this.slots.get(slot)?.registration === registration) this.slots.delete(slot);
    });
    if (registration) this.slots.set(slot, { plugin, registration });
    return registration;
  }

  slotOwner(slot: string): string | null {
    return this.slots.get(slot)?.plugin ?? null;
  }

  /** `plugin` adds `entry` to `slot` (whoever owns it, or nobody yet: then it is dormant). `undo` is anything more to take back. */
  contribute<T>(plugin: string, slot: string, entry: T, undo?: Undo): Registration | null {
    let registration: Registration | null = null;
    registration = this.register(plugin, "contribution", slot, () => {
      if (registration) this.contributions.delete(registration.id);
      return undo?.();
    });
    if (registration) this.contributions.set(registration.id, { plugin, slot, entry, registration });
    return registration;
  }

  /** What `slot` shows: the contributions whose contributor and slot owner are both active, in registration order (P2). */
  entries<T = unknown>(slot: string): SlotEntry<T>[] {
    const owner = this.slots.get(slot);
    if (!owner || this.state(owner.plugin) !== "active") return [];
    return [...this.contributions.values()]
      .filter((contribution) => contribution.slot === slot && this.state(contribution.plugin) === "active")
      .map((contribution) => ({ plugin: contribution.plugin, entry: contribution.entry as T, registration: contribution.registration }));
  }

  /** Every contribution held (shown or dormant), by registration order. */
  allContributions<T = unknown>(): { plugin: string; slot: string; entry: T }[] {
    return [...this.contributions.values()].map(({ plugin, slot, entry }) => ({ plugin, slot, entry: entry as T }));
  }

  // MARK: Loading with loaders

  /** The plugins someone wants loaded (they load again by themselves when what they require comes back). */
  wanted(): string[] {
    return [...this.wantedSet];
  }

  /** The required services that no active instance provides now. */
  missing(plugin: string): string[] {
    const requires = this.declarations.get(plugin)?.requires?.services ?? [];
    return requires.filter((service) => {
      const held = this.services.get(service);
      return !held || this.state(held.plugin) !== "active";
    });
  }

  /**
   * Wants `plugin` loaded (by `loader`, remembered for later loads) and loads it when what it requires is there:
   * StartLoad, the loader, Activate. A loader that throws or rejects unloads what it registered and is not retried.
   */
  load(plugin: string, loader?: Loader): Promise<LoadOutcome> {
    if (loader) this.loaders.set(plugin, loader);
    this.wantedSet.add(plugin);
    this.requestLoad(plugin);
    return this.tryLoad(plugin);
  }

  /**
   * Replaces a plugin's code (a hot update): its dependents unload first (and stay wanted), then the old instance, then
   * the new one loads by `loader`, and the dependents load again, now bound to the new provider.
   */
  async swap(plugin: string, loader: Loader): Promise<LoadOutcome> {
    this.record("Swap", plugin, this.generation(plugin));
    this.loaders.set(plugin, loader);
    this.wantedSet.add(plugin);
    await (this.unload(plugin, "swap") ?? Promise.resolve());
    return this.tryLoad(plugin);
  }

  private tryLoad(plugin: string): Promise<LoadOutcome> {
    const state = this.state(plugin);
    if (state === "active") return Promise.resolve({ status: "active" });
    if (state === "loading") return this.loads.get(plugin) ?? Promise.resolve({ status: "active" });
    if (state === "unloading") return (this.unload(plugin, "swap") ?? Promise.resolve()).then(() => (this.wantedSet.has(plugin) ? this.tryLoad(plugin) : { status: "waiting", missing: [] }));
    const missing = this.missing(plugin);
    if (missing.length) return Promise.resolve({ status: "waiting", missing });
    const loader = this.loaders.get(plugin);
    const generation = this.startLoad(plugin);
    const failed = (error: unknown): Promise<LoadOutcome> => {
      this.wantedSet.delete(plugin);
      const message = error instanceof Error ? error.message : String(error);
      return (this.unload(plugin, "request") ?? Promise.resolve()).then(() => ({ status: "failed" as const, message }));
    };
    const finish = (): Promise<LoadOutcome> | LoadOutcome => {
      if (this.state(plugin) !== "loading" || this.generation(plugin) !== generation) return { status: "waiting", missing: this.missing(plugin) };
      try {
        this.activate(plugin);
      } catch (error) {
        return failed(error);
      }
      return { status: "active" };
    };
    let result: unknown;
    try {
      result = loader?.(plugin, generation);
    } catch (error) {
      return failed(error);
    }
    if (!isThenable(result)) return Promise.resolve(finish());
    const promise = Promise.resolve(result).then(finish, failed).finally(() => { if (this.loads.get(plugin) === promise) this.loads.delete(plugin); });
    this.loads.set(plugin, promise);
    return promise;
  }

  /** Loads the wanted plugins that are absent and whose requirements now hold (after a provider became active). */
  private retryWanted(): void {
    if (this.retrying) return;
    this.retrying = true;
    try {
      for (let progress = true; progress;) {
        progress = false;
        for (const plugin of this.wantedSet) {
          if (this.state(plugin) !== "absent" || this.missing(plugin).length || !this.loaders.has(plugin)) continue;
          void this.tryLoad(plugin);
          progress = true;
        }
      }
    } finally {
      this.retrying = false;
    }
  }

  // MARK: The core's hooks

  protected override checkCanLoad(plugin: string): void {
    const missing = this.missing(plugin);
    if (missing.length) throw new KernelError("missing", `Plugin "${plugin}" requires ${missing.map((name) => `"${name}"`).join(", ")}, which no active plugin provides.`);
  }

  protected override checkCanActivate(plugin: string): void {
    this.checkCanLoad(plugin);
  }

  protected override activated(_plugin: string): void {
    this.retryWanted();
  }

  /**
   * The instances (not absent) that require a service `plugin` provides, by its declaration or its registrations; the last
   * loaded first, as unloadAll and the undos go.
   */
  protected override dependentsOf(plugin: string): string[] {
    const provided = new Set([
      ...(this.declarations.get(plugin)?.provides?.services ?? []),
      ...[...this.services].filter(([, held]) => held.plugin === plugin).map(([service]) => service),
    ]);
    if (!provided.size) return [];
    return this.plugins().reverse().filter((other) => other !== plugin && (this.declarations.get(other)?.requires?.services ?? []).some((service) => provided.has(service)));
  }

  protected override unloadRequested(plugin: string): void {
    this.wantedSet.delete(plugin);
  }
}

/** The plugins that provide what `declaration` requires. */
function providersOf(declarations: Map<string, PluginDeclaration>, declaration: PluginDeclaration): string[] {
  const out: string[] = [];
  for (const service of declaration.requires?.services ?? []) {
    for (const other of declarations.values()) if (other.provides?.services?.includes(service) && !out.includes(other.name)) out.push(other.name);
  }
  return out;
}

/** A cycle in the requires graph (the plugins on it, the first repeated at the end), or null. */
export function findCycle(declarations: Map<string, PluginDeclaration>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "open") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "open");
    path.push(name);
    const declaration = declarations.get(name);
    for (const next of declaration ? providersOf(declarations, declaration) : []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, "done");
    return null;
  };
  for (const name of [...declarations.keys()].sort()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}
