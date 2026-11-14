// Botling's plugin kernel (protocol D57, plugin-kernel design §4.2, §5, §6; kernel step 1). Every contribution, service and
// slot a plugin adds is a registration owned by one plugin instance, with its undo. An instance goes
// absent → loading → active → unloading → absent. Unloading follows the kernel's rules, copied from Cordis's semantics
// (not its code):
//   - dependents unload before what they depend on (step 3, services);
//   - the undos run in reverse registration order: each is started in that order and they may be async (a promise); the
//     unload finishes when every one has settled, or after a per-undo time limit marks a hanging one failed;
//   - one failing undo (a throw, a rejection, a time-out) is contained: the others still run, and it is reported once;
//   - an instance that has started unloading accepts no new registration: one that arrives then (a late async one) is
//     undone at once.
// When every undo is synchronous an unload completes synchronously, inside the call that asked for it (the 2.x host's
// unload stays as immediate as it was); the promise it returns is then already settled.
//
// Pure TypeScript, no DOM and no Node API (Web/src/frame-protocol.ts is shared the same way): the renderer, the chat page
// and Web/host (also run by botlingd) use the same kernel. Each step is recorded in an event log (when asked for) with the
// action names of the planned TLA+ model (`RequestLoad`, `StartLoad`, `Register`, `RegisterAsyncStart`,
// `RegisterAsyncSettle`, `Activate`, `RequestUnload`, `BeginUnload`, `RunUndo`, `FinishUnload`, `Swap`), so a reference
// machine can later replay a trace.

export type KernelState = "absent" | "loading" | "active" | "unloading";

/** What takes a registration back. A promise it returns is awaited (within the time limit) before the unload finishes. */
export type Undo = () => unknown;

export const KERNEL_ACTIONS = [
  "RequestLoad", "StartLoad", "Register", "RegisterAsyncStart", "RegisterAsyncSettle", "Activate",
  "RequestUnload", "BeginUnload", "RunUndo", "FinishUnload", "Swap",
] as const;
export type KernelAction = (typeof KERNEL_ACTIONS)[number];

/** One step of the kernel, in the order it happened. `step` counts from 1; nothing in it depends on time. */
export interface KernelEvent {
  step: number;
  action: KernelAction;
  plugin: string;
  /** The instance's generation (each load of a plugin is a new one). */
  generation: number;
  /** The registration it is about (`kind:key#id`), when it is about one. */
  registration?: string;
  /** Why, or what came of it: "refused", "undone at once", "dependency", "failed: …". */
  note?: string;
}

/** A registration as its owner and the kernel see it. `dispose()` takes it back early (once). */
export interface Registration {
  readonly id: number;
  readonly plugin: string;
  readonly generation: number;
  readonly kind: string;
  readonly key: string;
  /** Whether it is still in the kernel. */
  readonly live: boolean;
  dispose(): unknown;
}

export interface UndoFailure {
  plugin: string;
  generation: number;
  /** `kind:key#id`, or "pending" for an async registration that never settled within the time limit. */
  registration: string;
  message: string;
}

export interface UnloadResult {
  plugin: string;
  generation: number;
  failures: UndoFailure[];
}

export interface KernelTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface KernelOptions {
  /** How long one async undo (or a pending async registration) may take before it counts as failed (default 5 s). */
  undoTimeoutMs?: number;
  timers?: KernelTimers;
  /** Told once about each failed undo, when it fails. */
  onUndoFailure?: (failure: UndoFailure) => void;
  /** Keep the event log (`events`): true, or a function that is given each event instead. */
  log?: boolean | ((event: KernelEvent) => void);
}

export class KernelError extends Error {
  constructor(readonly code: "busy" | "not-loading" | "cycle" | "conflict" | "undeclared" | "missing", message: string) {
    super(message);
    this.name = "KernelError";
  }
}

export const DEFAULT_UNDO_TIMEOUT_MS = 5_000;

interface Reg extends Registration {
  undo: Undo;
  done: boolean;
}

interface Instance {
  plugin: string;
  state: KernelState;
  generation: number;
  /** Live registrations, in registration order. */
  regs: Reg[];
  /** Async registrations not settled yet (their promises, for the unload to wait on). */
  pending: Set<Promise<unknown>>;
  /** The unload in progress (state "unloading"). */
  unloading: Promise<UnloadResult> | null;
  failures: UndoFailure[];
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const defaultTimers: KernelTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Settles when every promise has settled; null when there are none (the caller goes on synchronously). */
const allSettled = (promises: (Promise<unknown> | null)[]): Promise<void> | null => {
  const waiting = promises.filter((promise): promise is Promise<unknown> => promise !== null);
  return waiting.length ? Promise.all(waiting.map((promise) => promise.then(() => undefined, () => undefined))).then(() => undefined) : null;
};


export class PluginKernel {
  /** The event log (kept when `log: true`). */
  readonly events: KernelEvent[] = [];
  protected readonly instances = new Map<string, Instance>();
  private nextId = 1;
  private step = 0;
  private readonly timeoutMs: number;
  private readonly timers: KernelTimers;

  constructor(private readonly options: KernelOptions = {}) {
    this.timeoutMs = options.undoTimeoutMs ?? DEFAULT_UNDO_TIMEOUT_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  // MARK: Reading

  state(plugin: string): KernelState {
    return this.instances.get(plugin)?.state ?? "absent";
  }

  generation(plugin: string): number {
    return this.instances.get(plugin)?.generation ?? 0;
  }

  /** The plugins whose instance is not absent, in the order they were first loaded. */
  plugins(): string[] {
    return [...this.instances.values()].filter((instance) => instance.state !== "absent").map((instance) => instance.plugin);
  }

  /** A plugin's live registrations, in registration order. */
  registrations(plugin: string, kind?: string): Registration[] {
    const regs = this.instances.get(plugin)?.regs ?? [];
    return kind === undefined ? [...regs] : regs.filter((reg) => reg.kind === kind);
  }

  /** Every live registration, by plugin (first-load order) then registration order. */
  allRegistrations(kind?: string): Registration[] {
    return [...this.instances.values()].flatMap((instance) => (kind === undefined ? instance.regs : instance.regs.filter((reg) => reg.kind === kind)));
  }

  /** How many async registrations of a plugin have not settled yet. */
  pendingCount(plugin: string): number {
    return this.instances.get(plugin)?.pending.size ?? 0;
  }

  /** Whether the kernel holds nothing of `plugin` (no registration, nothing pending, absent). */
  holdsNothingOf(plugin: string): boolean {
    const instance = this.instances.get(plugin);
    return !instance || (instance.state === "absent" && instance.regs.length === 0 && instance.pending.size === 0);
  }

  // MARK: Loading

  /** Someone wants the plugin to run (logged; `StartLoad` makes the instance). */
  requestLoad(plugin: string): void {
    this.record("RequestLoad", plugin, this.generation(plugin));
  }

  /** A new instance of `plugin` starts loading. Refused while one is still loaded or unloading. Returns its generation. */
  startLoad(plugin: string): number {
    const instance = this.instances.get(plugin);
    if (instance && instance.state !== "absent") throw new KernelError("busy", `Plugin "${plugin}" is ${instance.state}.`);
    this.checkCanLoad(plugin);
    const next: Instance = { plugin, state: "loading", generation: (instance?.generation ?? 0) + 1, regs: [], pending: new Set(), unloading: null, failures: [] };
    if (instance) this.instances.delete(plugin); // a reload goes to the end of the load order
    this.instances.set(plugin, next);
    this.record("StartLoad", plugin, next.generation);
    return next.generation;
  }

  /** The loading instance is up. */
  activate(plugin: string): void {
    const instance = this.instances.get(plugin);
    if (!instance || instance.state !== "loading") throw new KernelError("not-loading", `Plugin "${plugin}" is ${instance?.state ?? "absent"}, not loading.`);
    this.checkCanActivate(plugin);
    instance.state = "active";
    this.record("Activate", plugin, instance.generation);
    this.activated(plugin);
  }

  /** Overridden by the service layer: whether `plugin` may start loading now. */
  protected checkCanLoad(_plugin: string): void {}
  /** Overridden by the service layer: whether `plugin` may become active now. */
  protected checkCanActivate(_plugin: string): void {}
  /** Overridden by the service layer: `plugin` became active. */
  protected activated(_plugin: string): void {}
  /** Overridden by the service layer: the plugins to unload before `plugin` (its dependents). */
  protected dependentsOf(_plugin: string): string[] { return []; }
  /** Overridden by the service layer: someone asked for `plugin`'s unload (not a dependency or a swap). */
  protected unloadRequested(_plugin: string): void {}
  /** Overridden by a host: `plugin`'s instance `generation` is now unloading, before any of its undos runs (stop routing to it). */
  protected unloadStarted(_plugin: string, _generation: number): void {}

  // MARK: Registering

  /**
   * Records what `plugin` just added, with its undo. The instance must be loading or active (`generation`, when given,
   * must be the current one); otherwise the registration is refused and `undo` runs at once (contained, reported).
   * Returns the registration, or null when it was undone at once.
   */
  register(plugin: string, kind: string, key: string, undo: Undo, generation?: number): Registration | null {
    const instance = this.instances.get(plugin);
    const label = `${kind}:${key}`;
    if (!instance || (instance.state !== "loading" && instance.state !== "active") || (generation !== undefined && generation !== instance.generation)) {
      const gen = generation ?? instance?.generation ?? 0;
      this.record("Register", plugin, gen, label, "refused");
      this.runLate(plugin, gen, label, undo);
      return null;
    }
    const reg = this.makeReg(instance, kind, key, undo);
    instance.regs.push(reg);
    this.record("Register", plugin, instance.generation, this.labelOf(reg));
    return reg;
  }

  /**
   * An async registration: `setup` settles with its undo (or nothing). While it is pending the instance's unload waits for
   * it (within the time limit); when it settles after the instance started unloading (or a new instance replaced it), the
   * undo runs at once. Resolves with the registration, or null.
   */
  registerAsync(plugin: string, kind: string, key: string, setup: PromiseLike<Undo | void | undefined>): Promise<Registration | null> {
    const instance = this.instances.get(plugin);
    const generation = instance?.generation ?? 0;
    const label = `${kind}:${key}`;
    this.record("RegisterAsyncStart", plugin, generation, label);
    const settled = Promise.resolve(setup).then(
      (undo) => {
        instance?.pending.delete(settled);
        this.record("RegisterAsyncSettle", plugin, generation, label);
        if (typeof undo !== "function") return null;
        return this.register(plugin, kind, key, undo, generation);
      },
      (error) => {
        instance?.pending.delete(settled);
        this.record("RegisterAsyncSettle", plugin, generation, label, `failed: ${message(error)}`);
        return null;
      },
    );
    if (instance && (instance.state === "loading" || instance.state === "active")) instance.pending.add(settled);
    return settled;
  }

  private makeReg(instance: Instance, kind: string, key: string, undo: Undo): Reg {
    const reg: Reg = {
      id: this.nextId++, plugin: instance.plugin, generation: instance.generation, kind, key, undo, done: false,
      get live() { return !reg.done; },
      dispose() {
        if (reg.done) return undefined;
        reg.done = true;
        const at = instance.regs.indexOf(reg);
        if (at !== -1) instance.regs.splice(at, 1);
        // Taken back by its owner: as before the kernel, what its undo throws is the owner's.
        return undo();
      },
    };
    return reg;
  }

  private labelOf(reg: Registration): string {
    return `${reg.kind}:${reg.key}#${reg.id}`;
  }

  /** Refuses a registration the layer above does not allow now (`why` is logged): `undo` runs at once, as for a late one. */
  protected refuse(plugin: string, kind: string, key: string, undo: Undo, why: string): null {
    const label = `${kind}:${key}`;
    const generation = this.generation(plugin);
    this.record("Register", plugin, generation, label, `refused: ${why}`);
    this.runLate(plugin, generation, label, undo);
    return null;
  }

  /**
   * Runs the undo of a registration that came too late, now; a failure is reported, never thrown. Nothing waits for it,
   * but one that never settles is reported at the time limit, like any other undo.
   */
  private runLate(plugin: string, generation: number, label: string, undo: Undo): void {
    this.record("RunUndo", plugin, generation, label, "undone at once");
    const failed = (error: unknown) => this.fail({ plugin, generation, registration: label, message: message(error) });
    try {
      const result = undo();
      if (isThenable(result)) void this.bounded(Promise.resolve(result), () => failed(new Error(`its undo did not finish within ${this.timeoutMs} ms`))).then(undefined, failed);
    } catch (error) {
      failed(error);
    }
  }

  // MARK: Unloading

  /**
   * Unloads `plugin`: its dependents first, then its undos in reverse order. The instance is "unloading" as soon as this
   * returns (no registration is accepted from then on). Resolves when it is absent, with the undos that failed. Asked
   * again while it unloads, it gives the same promise.
   */
  requestUnload(plugin: string): Promise<UnloadResult> {
    const done = this.unload(plugin, "request");
    return done ?? Promise.resolve({ plugin, generation: this.generation(plugin), failures: [...(this.instances.get(plugin)?.failures ?? [])] });
  }

  /** Unloads every instance (dependents before what they need; otherwise last loaded first). */
  unloadAll(): Promise<UnloadResult[]> {
    const names = this.plugins().reverse();
    return Promise.all(names.map((name) => this.requestUnload(name)));
  }

  /**
   * The unload itself: null when it finished synchronously (or there was nothing to unload), else the promise of its result.
   * `cause`: someone asked ("request"), something the plugin requires is going ("dependency"), or its code is replaced ("swap");
   * only a request makes the plugin unwanted.
   */
  protected unload(plugin: string, cause: "request" | "dependency" | "swap" = "request"): Promise<UnloadResult> | null {
    if (cause === "request") this.unloadRequested(plugin);
    const instance = this.instances.get(plugin);
    if (!instance || instance.state === "absent") return null;
    if (instance.state === "unloading") return instance.unloading;
    // Dependents go to "unloading" first, so no active instance ever requires one that is unloading (P3).
    const dependents = this.dependentsOf(plugin).map((name) => this.unload(name, "dependency"));
    instance.state = "unloading";
    instance.failures = [];
    this.record("RequestUnload", plugin, instance.generation, undefined, cause === "request" ? undefined : cause);
    this.unloadStarted(plugin, instance.generation);
    let finish!: (result: UnloadResult) => void;
    const promise = new Promise<UnloadResult>((resolve) => { finish = resolve; });
    instance.unloading = promise;
    const deps = allSettled(dependents);
    const undos: Promise<void> | null = deps ? deps.then(() => this.runUndos(instance) ?? undefined) : this.runUndos(instance);
    if (!undos) {
      // Finished synchronously: the caller sees it absent already, and the promise is settled too.
      this.finishUnload(instance, finish);
      return null;
    }
    void undos.then(() => this.finishUnload(instance, finish));
    return promise;
  }

  /** `BeginUnload` and each `RunUndo`, newest first; null when every undo was synchronous. */
  private runUndos(instance: Instance): Promise<void> | null {
    this.record("BeginUnload", instance.plugin, instance.generation);
    const regs = instance.regs.splice(0).reverse();
    const waits: (Promise<unknown> | null)[] = [];
    for (const reg of regs) {
      if (reg.done) continue;
      reg.done = true;
      const label = this.labelOf(reg);
      this.record("RunUndo", instance.plugin, instance.generation, label);
      const failed = (error: unknown) => this.fail({ plugin: instance.plugin, generation: instance.generation, registration: label, message: message(error) }, instance);
      try {
        const result = reg.undo();
        if (isThenable(result)) waits.push(this.bounded(Promise.resolve(result), () => failed(new Error(`its undo did not finish within ${this.timeoutMs} ms`))).then(undefined, failed));
      } catch (error) {
        failed(error);
      }
    }
    // Async registrations still pending: waited for (they undo themselves at once when they settle), within the limit.
    for (const pending of instance.pending) {
      waits.push(this.bounded(pending, () => this.fail({ plugin: instance.plugin, generation: instance.generation, registration: "pending", message: `an async registration did not settle within ${this.timeoutMs} ms` }, instance)));
    }
    return allSettled(waits);
  }

  private finishUnload(instance: Instance, finish: (result: UnloadResult) => void): void {
    instance.state = "absent";
    instance.unloading = null;
    instance.pending.clear();
    this.record("FinishUnload", instance.plugin, instance.generation, undefined, instance.failures.length ? `${instance.failures.length} failed` : undefined);
    finish({ plugin: instance.plugin, generation: instance.generation, failures: [...instance.failures] });
  }

  /** `promise`, or `onTimeout` and settled after the time limit, whichever is first. */
  private bounded(promise: Promise<unknown>, onTimeout: () => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => { onTimeout(); resolve(undefined); }, this.timeoutMs);
      promise.then(
        (value) => { this.timers.clear(timer); resolve(value); },
        (error) => { this.timers.clear(timer); reject(error); },
      );
    });
  }

  private fail(failure: UndoFailure, instance?: Instance): void {
    instance?.failures.push(failure);
    this.options.onUndoFailure?.(failure);
  }

  // MARK: Log

  protected record(action: KernelAction, plugin: string, generation: number, registration?: string, note?: string): void {
    const log = this.options.log;
    if (!log) return;
    const event: KernelEvent = { step: ++this.step, action, plugin, generation, ...(registration ? { registration } : {}), ...(note ? { note } : {}) };
    if (typeof log === "function") log(event);
    else this.events.push(event);
  }
}
