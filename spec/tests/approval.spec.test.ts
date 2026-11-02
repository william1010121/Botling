// A plugin frame's approval ask against spec/models/approval: seeded random walks of what a frame and the user
// do drive the real app page sheet, frame broker and core Plugins through the adapter, compared with
// spec/reference after every step; and the reference, explored like TLC, has the model's states and breaks
// OnlyIntended only with the model's bugs.
// The page is a jsdom window made here (spec/ files run in the node environment), before React is loaded.
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDriver, ApprovalSession } from "../driver/approval-driver";
import { actions, init, step, view, violations, type Action, type Config, type State } from "../reference/approval";

const CFG: Config = { slots: ["a1", "a2", "a3"], cmds: ["c1", "c2"] };

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
/** A kind of move first (each as likely), then one of its variants: asks have many, the user's steps one. */
const pick = (list: Move[], rnd: () => number) => {
  const type = one([...new Set(list.map((move) => move.type))], rnd);
  return one(list.filter((move) => move.type === type), rnd);
};

/** What the driver can do: a frame's ask (the app's own steps run inside it), or one thing the user does. */
type Move = { type: "Ask"; a: string; c: string; f: "own" | "other"; stray: boolean } | { type: "StrayClick" | "Arm" | "Allow" | "Cancel" };

function moves(s: State, cfg: Config): Move[] {
  const out: Move[] = [];
  for (const a of actions(s, cfg)) {
    if (a.type === "Ask") out.push({ ...a, stray: false }, { ...a, stray: true });
    else if (a.type !== "CoreAsk" && a.type !== "Open") out.push(a as Move);
  }
  return out;
}

/** The model's steps a move is: an ask runs the core's answer and the sheet's opening (when it gets there). */
function apply(s: State, cfg: Config, move: Move): State {
  if (move.type !== "Ask") return step(s, cfg, move as Action);
  let n = step(s, cfg, { type: "Ask", a: move.a, c: move.c, f: move.f });
  n = step(n, cfg, { type: "CoreAsk", a: move.a });
  if (n.st[move.a] === "toSheet") n = step(n, cfg, { type: "Open", a: move.a, stray: move.stray });
  return n;
}

async function drive(session: ApprovalSession, move: Move) {
  switch (move.type) {
    case "Ask": return session.ask(move.a, move.c, move.f);
    case "StrayClick": return session.strayClick();
    case "Arm": return session.arm();
    case "Allow": return session.allow();
    case "Cancel": return session.cancel();
  }
}

let approvalAdapter: ApprovalDriver;
// jsdom ships no types here: loaded with require and given the little this file uses.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, options: object) => { window: Window & typeof globalThis } };
beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const page = dom.window as unknown as Record<string, unknown>;
  for (const name of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "HTMLButtonElement", "Event", "MessageEvent", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : page[name], configurable: true, writable: true });
  }
  ({ approvalAdapter } = await import("../../desktop/spec-adapters/approval-adapter"));
});

const sessions: ApprovalSession[] = [];
// The test owns the app's timers (the sheet's arming moment).
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms).then(() => {});
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

describe("approval of a plugin frame's ask (spec/models/approval)", () => {
  it("random walks: the app and the reference agree after every step, and no invariant fails", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = random(seed);
      const session = await approvalAdapter.open({ slots: CFG.slots, cmds: CFG.cmds, wait });
      sessions.push(session);
      let s = init(CFG);
      const walk: string[] = [];
      for (let i = 0; i < 12; i++) {
        const options = moves(s, CFG);
        if (!options.length) break;
        const move = pick(options, rnd);
        walk.push(JSON.stringify(move));
        s = apply(s, CFG, move);
        seen.add(move.type === "Ask" ? `Ask:${s.answer[move.a] ?? s.st[move.a]}` : move.type);
        await drive(session, move);
        expect(session.observe(), `seed ${seed}: ${walk.join(" → ")}`).toEqual(view(s));
        expect(violations(s, CFG), `seed ${seed}`).toEqual([]);
      }
      await sessions.pop()!.close();
    }
    // The walks reach every branch: refused, allowed already, a second ask while one is open, the sheet, and each user step.
    expect([...seen].sort()).toEqual(["Allow", "Arm", "Ask:allowed", "Ask:notAllowed", "Ask:onSheet", "Ask:refused", "Cancel", "StrayClick"]);
  }, 60_000);

  it("the reference has the model's state space (TLC: 325 distinct states for Approval.cfg), and its bugs break OnlyIntended as Approval_bug*.cfg do", () => {
    /** Every state the reference reaches (breadth first, as TLC), and the invariants that fail in any. */
    const explore = (cfg: Config) => {
      const seen = new Map<string, State>([[JSON.stringify(init(cfg)), init(cfg)]]);
      const failed = new Set<string>();
      const queue = [init(cfg)];
      while (queue.length) {
        const s = queue.shift()!;
        for (const name of violations(s, cfg)) failed.add(name);
        for (const a of actions(s, cfg)) {
          const n = step(s, cfg, a);
          const key = JSON.stringify(n);
          if (!seen.has(key)) { seen.set(key, n); queue.push(n); }
        }
      }
      return { states: seen.size, failed: [...failed].sort() };
    };
    const tlc: Config = { slots: ["a1", "a2"], cmds: ["c1", "c2"] };
    expect(explore(tlc)).toEqual({ states: 325, failed: [] });
    expect(explore({ ...tlc, bug: "swap" }).failed).toContain("OnlyIntended");
    expect(explore({ ...tlc, bug: "noarm" }).failed).toContain("OnlyIntended");
  });
});
