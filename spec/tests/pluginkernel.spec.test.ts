// The plugin kernel against spec/models/pluginkernel: seeded random walks of what a plugin manager, the plugins and a
// code write do drive the real kernel (Web/src/plugin-kernel/) through the adapter. Every step the kernel logs is
// replayed through spec/reference as the model's action: it must be enabled there (the kernel does nothing the model
// does not allow), no invariant may fail, and after each move the kernel's view must equal the reference's. At the end
// of a walk, once every loader and async registration has settled, no unload is left half done (UnloadEnds) and a
// plugin still waiting to load waits for something nobody asked for (LoadEnds). The reference, explored like TLC, has
// the model's states and breaks the property each bug config names.
import { describe as group, expect, it } from "vitest";
import type { KernelSession, KernelStep, KernelWorld } from "../driver/pluginkernel-driver";
import { pluginkernelAdapter } from "../../desktop/spec-adapters/pluginkernel-adapter";
import {
  CONTRIBUTES, OWNS, PLUGINS, PROVIDES, actions, allDeps, describe, enabled, init, open, regLabel, requires, sameReg,
  step, stepViolations, view, violations, type Action, type Bug, type Config, type Plugin, type Reg, type State,
} from "../reference/pluginkernel";

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const one = <T>(list: T[], rnd: () => number) => list[Math.floor(rnd() * list.length)]!;

type Move =
  | { type: "load" | "finishLoad" | "unload" | "swap" | "settle"; p: Plugin }
  | { type: "register"; p: Plugin; reg: Reg; fail: boolean }
  | { type: "registerAsync"; p: Plugin; fail: boolean };

/** The moves the reference allows now (a registration only while its plugin is open, K4). */
function moves(s: State, cfg: Config, world: KernelWorld): Move[] {
  const out: Move[] = [];
  for (const p of PLUGINS) {
    if (enabled(s, cfg, { type: "RequestLoad", p })) out.push({ type: "load", p });
    if (world.asyncLoad.includes(p) && s.state[p] === "loading" && s.want[p] === "load") out.push({ type: "finishLoad", p });
    if (enabled(s, cfg, { type: "RequestUnload", p })) out.push({ type: "unload", p });
    if (enabled(s, cfg, { type: "Swap", p })) out.push({ type: "swap", p });
    if (s.pending[p] > 0) out.push({ type: "settle", p });
    if (open(s, p) && s.regs[p].length + s.pending[p] < cfg.maxRegs) {
      for (const fail of [false, false, false, true]) {
        for (const t of CONTRIBUTES[p]) out.push({ type: "register", p, reg: { kind: "slot", t }, fail });
        out.push({ type: "register", p, reg: { kind: "listener", t: "none" }, fail });
        out.push({ type: "registerAsync", p, fail });
      }
    }
  }
  return out;
}
/** A kind of move first (each as likely), then one of its variants. */
const pick = (list: Move[], rnd: () => number) => {
  const type = one([...new Set(list.map((move) => move.type))], rnd);
  return one(list.filter((move) => move.type === type), rnd);
};

async function drive(session: KernelSession, move: Move) {
  switch (move.type) {
    case "load": return session.load(move.p);
    case "finishLoad": return session.finishLoad(move.p);
    case "unload": return session.unload(move.p);
    case "swap": return session.swap(move.p);
    case "settle": return session.settle(move.p);
    case "register": return session.register(move.p, move.reg, move.fail);
    case "registerAsync": return session.registerAsync(move.p, move.fail);
  }
}

/**
 * Replays the kernel's steps through the reference. The request of an unload is the move itself (the kernel logs it after
 * its dependents' unloads, which are the model's CascadeUnload); a refused registration and the undo it runs at once are
 * no step of the model; neither is the owner's own slot registration.
 */
function follow(start: State, cfg: Config, move: Move, steps: KernelStep[], seen: Set<string>): { s: State; trail: string[] } {
  let s = start;
  const trail: string[] = [];
  const apply = (a: Action) => {
    const n = step(s, cfg, a);
    trail.push(describe(a));
    seen.add(a.type === "RunUndo" ? `RunUndo:${a.fail}` : a.type);
    const bad = [...violations(n, cfg), ...stepViolations(s, n)];
    if (bad.length) throw new Error(`${bad.join(", ")} fails after ${trail.join(" → ")}`);
    s = n;
  };
  try {
    if (move.type === "unload") apply({ type: "RequestUnload", p: move.p });
    for (let i = 0; i < steps.length; i++) {
      const k = steps[i]!;
      const p = k.plugin;
      switch (k.action) {
        case "RequestLoad":
          if (s.state[p] === "absent" && s.want[p] === "none") apply({ type: "RequestLoad", p });
          break;
        case "StartLoad": case "Activate": case "BeginUnload": case "FinishUnload": case "Swap": case "RegisterAsyncStart":
          apply({ type: k.action, p });
          break;
        case "Register":
          // Refused (a contribution while the slot's owner is not active: unreachable under K5, as the model's
          // "contribnoowner" note says), or the owner's own slot.
          if (k.refused || k.reg === null) break;
          apply({ type: "Register", p, r: k.reg! });
          break;
        case "RegisterAsyncSettle": {
          const next = steps[i + 1];
          const own = next?.action === "Register" && next.plugin === p;
          const r: Reg = (own ? next!.reg : null) ?? { kind: "listener", t: "none" };
          if (own) i++;
          const before = s.regs[p].length;
          apply({ type: "RegisterAsyncSettle", p, r });
          const kept = s.regs[p].length > before;
          seen.add(kept ? "settle:kept" : "settle:undone");
          if (kept !== (own && !next!.refused)) throw new Error(`the kernel ${kept ? "refused" : "kept"} ${regLabel(r)} of ${p}, the model did not`);
          break;
        }
        case "RequestUnload":
          if (k.cause === "dependency") {
            const from = PLUGINS.find((q) => enabled(s, cfg, { type: "CascadeUnload", p: q, q: p }));
            if (!from) throw new Error(`the kernel unloads ${p} as a dependent, and no CascadeUnload(_, ${p}) is enabled`);
            apply({ type: "CascadeUnload", p: from, q: p });
          } else if (s.want[p] !== "unload") {
            apply({ type: "RequestUnload", p });
          }
          break;
        case "RunUndo": {
          if (k.late || k.reg === null) break;
          const top = s.undoing[p][s.undoing[p].length - 1];
          if (!top || !sameReg(top, k.reg!)) throw new Error(`the kernel undoes ${regLabel(k.reg!)} of ${p}; the model's next undo is ${top ? regLabel(top) : "none"}`);
          apply({ type: "RunUndo", p, fail: !!k.failed });
          break;
        }
        default:
          throw new Error(`unknown kernel step ${k.action}`);
      }
    }
  } catch (error) {
    throw new Error(`${(error as Error).message}\n  kernel steps: ${JSON.stringify(steps)}\n  model: ${trail.join(" → ")}`);
  }
  return { s, trail };
}

const WORLD = (asyncLoad: Plugin[]): KernelWorld => ({ provides: PROVIDES, requires: requires(), owns: OWNS, contributes: CONTRIBUTES, asyncLoad });
/** Walks are not bounded by the CI config's budgets: more swaps, failures and registrations. */
const WALK: Config = { maxSwap: 3, maxFail: 1000, maxRegs: 4 };
const SEEDS = Number(process.env.SPEC_PLUGINKERNEL_SEEDS ?? 1000);

group("the plugin kernel (spec/models/pluginkernel)", () => {
  it("random walks: every kernel step is a model step, no invariant fails, the views agree, and nothing is left half done", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = random(seed);
      const asyncLoad = PLUGINS.filter(() => rnd() < 0.5);
      const world = WORLD(asyncLoad);
      const session = await pluginkernelAdapter.open(world);
      let s = init(WALK);
      const walk: string[] = [`async ${asyncLoad.join(",") || "none"}`];
      const run = async (move: Move) => {
        walk.push(JSON.stringify(move));
        seen.add(`move:${move.type}`);
        await drive(session, move);
        const followed = follow(s, WALK, move, session.steps(), seen);
        s = followed.s;
        expect(session.observe(), `seed ${seed}: ${walk.join(" → ")}\n  model: ${followed.trail.join(" → ")}`).toEqual(view(s));
      };
      try {
        for (let i = 0; i < 30; i++) {
          const options = moves(s, WALK, world);
          if (!options.length) break;
          await run(pick(options, rnd));
        }
        // Drain: every async registration and loader settles.
        for (let options = moves(s, WALK, world).filter((m) => m.type === "settle" || m.type === "finishLoad"); options.length;
          options = moves(s, WALK, world).filter((m) => m.type === "settle" || m.type === "finishLoad")) {
          await run(options[0]!);
        }
        // UnloadEnds: no unload is left half done. LoadEnds: a plugin still wanted waits for one nobody wants.
        for (const p of PLUGINS) {
          expect(view(s).state[p], `seed ${seed}: ${p} still unloading after ${walk.join(" → ")}`).not.toBe("unloading");
          if (s.want[p] === "load") {
            expect(allDeps(p).some((q) => s.state[q] === "absent" && s.want[q] === "none"), `seed ${seed}: ${p} waits for nothing after ${walk.join(" → ")}`).toBe(true);
          }
        }
      } catch (error) {
        throw new Error(`seed ${seed}: ${walk.join(" → ")}\n${(error as Error).message}`);
      } finally {
        await session.close();
      }
    }
    // The walks reach every move, every model action (both RunUndo outcomes), and an async registration both kept and
    // undone at once.
    expect([...seen].sort()).toEqual([
      "Activate", "BeginUnload", "CascadeUnload", "FinishUnload", "Register", "RegisterAsyncSettle", "RegisterAsyncStart",
      "RequestLoad", "RequestUnload", "RunUndo:false", "RunUndo:true", "StartLoad", "Swap",
      "move:finishLoad", "move:load", "move:register", "move:registerAsync", "move:settle", "move:swap", "move:unload",
      "settle:kept", "settle:undone",
    ]);
  }, 120_000);

  it("the reference has the model's state space (TLC: 21,632 distinct states for PluginKernel.cfg), and each bug breaks what its config names", () => {
    /** Every state the reference reaches (breadth first, as TLC), and the properties that fail; stops once `stopAt` fails. */
    const explore = (cfg: Config, stopAt?: string) => {
      const start = init(cfg);
      const seen = new Set<string>([JSON.stringify(start)]);
      const failed = new Set<string>();
      const queue = [start];
      for (let at = 0; at < queue.length; at++) {
        const s = queue[at]!;
        for (const name of violations(s, cfg)) failed.add(name);
        for (const a of actions(s, cfg)) {
          const n = step(s, cfg, a);
          for (const name of stepViolations(s, n)) failed.add(name);
          const key = JSON.stringify(n);
          if (!seen.has(key)) { seen.add(key); queue.push(n); }
        }
        if (stopAt && failed.has(stopAt)) break;
      }
      return { states: seen.size, failed: [...failed].sort() };
    };
    expect(explore({ maxSwap: 1, maxFail: 1, maxRegs: 1 })).toEqual({ states: 21_632, failed: [] });
    // The bug configs (MaxRegs = 2); "cycle" breaks LoadEnds, a liveness property TLC checks and this search does not.
    const bugs: [Bug, string][] = [
      ["noundo", "NoResidue"], ["lateasync", "ClosedUnload"], ["providerfirst", "TeardownOrder"],
      ["acceptunloading", "ClosedUnload"], ["failstops", "NoResidue"], ["contribnoowner", "NoOrphan"],
      ["unloadingdep", "NoOrphan"], ["loadintounloading", "TeardownOrder"], ["ownerloading", "OwnerActive"],
    ];
    for (const [bug, property] of bugs) expect(explore({ maxSwap: 1, maxFail: 1, maxRegs: 2, bug }, property).failed, bug).toContain(property);
  }, 60_000);
});
