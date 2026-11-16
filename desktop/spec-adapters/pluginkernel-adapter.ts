// spec/driver/pluginkernel-driver.ts against the real kernel (Web/src/plugin-kernel/ `Kernel`, services and slots on the
// kernel core): each model plugin is installed with its declaration; its loader provides its services and opens the
// slots it owns (sync, or held open until `finishLoad`); contributions go through `contribute`, listeners through
// `register` and `registerAsync`. The steps are the kernel's own event log, its registration labels turned into the
// model's registrations. Undo time limits are off (the model's undo is atomic): no timer ever fires. Translation only.
import { Kernel, type KernelEvent, type Undo } from "../../Web/src/plugin-kernel";
import type { KernelDriver, KernelSession, KernelStep, KernelWorld } from "../../spec/driver/pluginkernel-driver";
import type { PState, Plugin, Reg, Slot, View } from "../../spec/reference/pluginkernel";

const PLUGINS: Plugin[] = ["p1", "p2", "p3"];
const SLOTS: Slot[] = ["k1", "k2"];

/** `kind:key#id` or `kind:key` → the model's registration (null: the owner's own slot). */
function regOf(label: string | undefined): Reg | null | undefined {
  if (!label) return undefined;
  const [kind, rest] = [label.slice(0, label.indexOf(":")), label.slice(label.indexOf(":") + 1).replace(/#\d+$/, "")];
  if (kind === "service") return { kind: "service", t: rest };
  if (kind === "contribution") return { kind: "slot", t: rest };
  if (kind === "listener") return { kind: "listener", t: "none" };
  if (kind === "slot") return null;
  throw new Error(`unknown registration ${JSON.stringify(label)}`);
}

export const pluginkernelAdapter: KernelDriver = {
  async open(world: KernelWorld): Promise<KernelSession> {
    const log: KernelStep[] = [];
    const onEvent = (event: KernelEvent) => {
      const step: KernelStep = { action: event.action, plugin: event.plugin as Plugin };
      if (event.registration !== undefined) step.reg = regOf(event.registration);
      if (event.note?.startsWith("refused")) step.refused = true;
      if (event.note === "undone at once") step.late = true;
      if (event.action === "RequestUnload") step.cause = event.note === "dependency" ? "dependency" : event.note === "swap" ? "swap" : "request";
      log.push(step);
    };
    const kernel = new Kernel({
      log: onEvent,
      timers: { set: () => null, clear: () => {} },
      onUndoFailure: (failure) => {
        for (let i = log.length - 1; i >= 0; i--) {
          const step = log[i]!;
          if (step.action === "RunUndo" && step.plugin === failure.plugin) { step.failed = true; return; }
        }
      },
    });
    for (const p of PLUGINS) {
      kernel.install({ name: p, provides: { services: world.provides[p], slots: world.owns[p] }, requires: { services: world.requires[p] }, contributes: { slots: world.contributes[p] } });
    }

    // Each instance's async loader, held open until finishLoad (by plugin and generation).
    const loaders = new Map<string, () => void>();
    const loader = (plugin: string, generation: number): unknown => {
      const p = plugin as Plugin;
      for (const service of world.provides[p]) kernel.provide(p, service, () => service);
      for (const slot of world.owns[p]) kernel.provideSlot(p, slot);
      if (!world.asyncLoad.includes(p)) return undefined;
      return new Promise<void>((resolve) => loaders.set(`${p}#${generation}`, resolve));
    };
    // The undos the kernel runs; one that should fail throws.
    const undoFor = (failUndo: boolean): Undo => () => { if (failUndo) throw new Error("spec: this undo fails"); };
    const asyncs = new Map<Plugin, (() => void)[]>(PLUGINS.map((p) => [p, []]));
    // Lets every promise the kernel chains settle.
    const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

    return {
      async load(p) {
        void kernel.load(p, loader);
        for (const q of closure(kernel.dependencyGraph(), p)) {
          if (kernel.state(q) === "absent" && !kernel.wanted().includes(q)) void kernel.load(q, loader);
        }
        await settled();
      },
      async finishLoad(p) {
        const key = `${p}#${kernel.generation(p)}`;
        loaders.get(key)?.();
        loaders.delete(key);
        await settled();
      },
      async unload(p) { void kernel.requestUnload(p); await settled(); },
      async swap(p) { void kernel.swap(p, loader); await settled(); },
      async register(p, reg, failUndo) {
        if (reg.kind === "slot") kernel.contribute(p, reg.t, `${p}→${reg.t}`, undoFor(failUndo));
        else if (reg.kind === "listener") kernel.register(p, "listener", "none", undoFor(failUndo));
        else throw new Error("services are provided by the loader");
        await settled();
      },
      async registerAsync(p, failUndo) {
        void kernel.registerAsync(p, "listener", "none", new Promise<Undo>((resolve) => asyncs.get(p)!.push(() => resolve(undoFor(failUndo)))));
        await settled();
      },
      async settle(p) { asyncs.get(p)!.shift()?.(); await settled(); },
      steps: () => log.splice(0),
      observe(): View {
        const per = <T>(value: (p: Plugin) => T) => Object.fromEntries(PLUGINS.map((p) => [p, value(p)])) as Record<Plugin, T>;
        const state = per((p) => kernel.state(p) as PState);
        return {
          state,
          waiting: per((p) => kernel.wanted().includes(p) && (state[p] === "absent" || state[p] === "loading")),
          regs: per((p) => kernel.registrations(p).filter((r) => r.kind !== "slot").map((r) => {
            const reg = regOf(`${r.kind}:${r.key}`)!;
            return `${reg.kind}:${reg.t}`;
          })),
          pending: per((p) => kernel.pendingCount(p)),
          shown: Object.fromEntries(SLOTS.map((k) => [k, kernel.entries(k).map((e) => e.plugin as Plugin).sort()])) as Record<Slot, Plugin[]>,
        };
      },
      async close() {
        for (const resolve of loaders.values()) resolve();
        for (const list of asyncs.values()) for (const resolve of list.splice(0)) resolve();
        await settled();
      },
    };
  },
};

/** Everything `p` depends on in the kernel's dependency graph (providers and slot owners, transitively). */
function closure(graph: Record<string, string[]>, p: string): Plugin[] {
  const out: string[] = [];
  const visit = (name: string) => { for (const q of graph[name] ?? []) if (!out.includes(q)) { out.push(q); visit(q); } };
  visit(p);
  return out as Plugin[];
}
