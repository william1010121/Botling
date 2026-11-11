// A Claude worker on another machine (spec/models/remoteworker/RemoteWorker.tla), reached over ssh or the relay.
// The app does not have remote workers yet (multi-machine phase 1): until its adapter exists
// (desktop/spec-adapters/remote-worker-adapter.ts behind spec/driver/remote-worker-driver.ts), these tests hold the
// reference to the model: explored like TLC it reaches exactly TLC's states for RemoteWorker.cfg and breaks no
// property; each bug breaks its property; the scenarios TLC's counterexamples walk through end as the model says.
// SPEC_BUG=remote-nolock, remote-stale, remote-nogen or remote-revoke turns on that bug: the exploration goes red.
import { describe, expect, it } from "vitest";
import {
  actions, init, label, step, stepViolations, view, violations, type Action, type Bug, type Config, type State,
} from "../reference/remote-worker";

/** Every reachable state (breadth first): how many, and the first broken property with the path to it. */
function explore(cfg: Config, only?: string): { states: number; broken: string | null } {
  const key = (s: State) => JSON.stringify(s);
  const start = init(cfg);
  const seen = new Set([key(start)]);
  const queue: { s: State; path: string[] }[] = [{ s: start, path: [] }];
  for (let head = 0; head < queue.length; head++) {
    const { s, path } = queue[head]!;
    queue[head] = undefined as never;
    for (const a of actions(s, cfg)) {
      const n = step(s, cfg, a);
      const broken = [...violations(n), ...stepViolations(s, n)].filter((v) => !only || v === only);
      if (broken.length) return { states: seen.size, broken: `${broken.join(", ")} after ${[...path, label(a)].join(" → ")}` };
      const k = key(n);
      if (!seen.has(k)) { seen.add(k); queue.push({ s: n, path: [...path, label(a)] }); }
    }
  }
  return { states: seen.size, broken: null };
}

function run(cfg: Config, path: Action[]): State {
  let s = init(cfg);
  for (const a of path) {
    s = step(s, cfg, a);
    expect(violations(s), label(a)).toEqual([]);
  }
  return s;
}

/** RemoteWorker.cfg */
const MAIN: Config = { paths: ["ssh", "relay"], maxConns: 3, maxReqs: 1, maxOut: 1, maxTries: 2, maxPairs: 1, bug: "none" };
/** The bug cfgs' bounds (RemoteWorker_bug_*.cfg). */
const BUGGY = (bug: Bug): Config => ({ paths: [bug === "revoke" ? "relay" : "ssh"], maxConns: 3, maxReqs: 1, maxOut: 0, maxTries: 2, maxPairs: 1, bug });
/** Scenarios: ssh, three connections. */
const CFG: Config = { paths: ["ssh", "relay"], maxConns: 3, maxReqs: 1, maxOut: 1, maxTries: 2, maxPairs: 2, bug: "none" };

const A = {
  pair: (p: "ssh" | "relay"): Action => ({ type: "Pair", p }),
  app: (g: number): Action => ({ type: "AppRecv", g }), agent: (g: number): Action => ({ type: "AgentRecv", g }),
  drop: (i: number): Action => ({ type: "Drop", i }), answer: (k: number): Action => ({ type: "Answer", k }),
  ask: (r: number, k: number): Action => ({ type: "Ask", r, k }),
};
const APPROVE: Action = { type: "Approve" }, CONNECT: Action = { type: "Connect" }, UPGRADE: Action = { type: "Upgrade" };
const START: Action = { type: "Start" }, CANCEL: Action = { type: "Cancel" };

/** Paired over `path`; the first connection finds no agent, uploads (or self-updates) it; the second starts the worker
 * and claude asks request 1, whose card the user answers. */
const asked = (path: "ssh" | "relay"): Action[] => [
  A.pair(path), APPROVE, CONNECT, A.agent(1), A.app(1), UPGRADE, CONNECT, A.agent(2), A.app(2),
  START, A.agent(2), A.ask(1, 1), A.app(2), A.answer(1),
];

describe("remote worker model: the reference explored like TLC", () => {
  it("reaches exactly TLC's 221,568 states for RemoteWorker.cfg and breaks no property", () => {
    const result = explore(MAIN);
    expect(result.broken).toBeNull();
    expect(result.states).toBe(221_568);
  }, 120_000);

  it.each([["nolock", "OneProc"], ["stale", "OpenNotApplied"], ["nogen", "OpenNotApplied"], ["revoke", "RevokeEnds"]] as [Bug, string][])(
    "with bug %s breaks %s", (bug, property) => {
      expect(explore(BUGGY(bug), property).broken).toContain(property);
    });
});

describe("remote worker model: scenarios", () => {
  it.each(["ssh", "relay"] as const)("over %s: an answer in flight when the connection ends applies at most once; the card opens again with a note, and is answered when the resumed run asks again", (path) => {
    const lost = [
      ...asked(path), A.drop(1), CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3), // attach: the replay holds no `ans`
    ];
    const reopened = run(CFG, lost);
    expect(view(reopened)).toMatchObject({ conn: "up", w: "running", card: ["open"], noted: [true] });
    // the old connection's answer reaches the agent now: refused (the agent is on connection 3)
    const refused = run(CFG, [...lost, A.agent(2)]);
    expect(refused.applied).toEqual([0]);
    expect(refused.up[1]).toEqual([{ t: "refused", n: 1 }]);
    // an answer before the resumed run asks again is refused at once; once it asks, the answer applies, once
    const early = run(CFG, [...lost, A.agent(2), A.answer(1)]);
    expect(view(early)).toMatchObject({ card: ["open"], noted: [true] });
    expect(early.down[2]).toEqual([{ t: "start", n: 1 }]);
    const done = run(CFG, [...lost, A.agent(2), A.agent(3), A.ask(2, 1), A.app(3), A.answer(1), A.agent(3), A.app(3)]);
    expect(done.applied).toEqual([1]);
    expect(view(done)).toMatchObject({ card: ["settled"], got: 3 });
    expect(done.alive).toEqual([2]);
  });

  it("an answer that applied before the agent saw the disconnect is shown by the replay, not asked again", () => {
    const s = run(CFG, [...asked("ssh"), A.drop(1), A.agent(2), CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3), A.app(3)]);
    expect(s.applied).toEqual([1]);
    expect(view(s)).toMatchObject({ w: "running", card: ["settled"], got: 2 });
  });

  it("with bug stale, the old answer lands on the resumed run's request while its card is open again", () => {
    const cfg = { ...CFG, bug: "stale" as Bug };
    let s = init(cfg);
    for (const a of [...asked("ssh"), A.drop(1), CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3), A.agent(3), A.ask(2, 1), A.app(3)]) {
      s = step(s, cfg, a);
    }
    expect(violations(s)).toEqual([]);
    expect(violations(step(s, cfg, A.agent(2)))).toContain("OpenNotApplied");
  });

  it("the resume takes the session lock: the claude the agent has not stopped yet ends before the resumed one starts", () => {
    const s = run(CFG, [...asked("ssh"), A.drop(0), CONNECT, A.agent(3), A.app(3)]);
    expect(s.alive).toEqual([1]);
    const attached = run(CFG, [...asked("ssh"), A.drop(0), CONNECT, A.agent(3), A.app(3), A.agent(3)]);
    expect(attached.alive).toEqual([]);
    const resumed = run(CFG, [...asked("ssh"), A.drop(0), CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3), A.agent(3)]);
    expect(resumed.alive).toEqual([2]);
  });

  it("cancelled while away: cancelled at once, claude there stops, and the next connection only fetches the tail", () => {
    const away = run(CFG, [...asked("relay"), A.drop(0), CANCEL]);
    expect(view(away)).toMatchObject({ w: "cancelled", card: ["closed"] });
    expect(run(CFG, [...asked("relay"), A.drop(0), CANCEL, { type: "Notice" }]).alive).toEqual([]);
    const swept = run(CFG, [...asked("relay"), A.drop(0), CANCEL, CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3)]);
    expect(swept).toMatchObject({ alive: [], runs: 1, sweep: false, conn: "up", w: "cancelled" });
    expect(swept.down[2]).toEqual([]);
  });

  it("revoked: the connection ends, nothing more is taken from the machine until it is approved again", () => {
    const s = run(CFG, [...asked("relay"), { type: "Revoke", i: 0 }]);
    expect(view(s)).toMatchObject({ trust: "revoked", conn: "down", w: "interrupted" });
    expect(actions(s, CFG).map((a) => a.type)).not.toContain("Connect");
    expect(actions(s, CFG).some((a) => a.type === "AppRecv")).toBe(false);
    const again = run(CFG, [...asked("relay"), { type: "Revoke", i: 0 }, A.pair("ssh"), APPROVE, CONNECT, A.agent(3), A.app(3), A.agent(3), A.app(3)]);
    expect(view(again)).toMatchObject({ via: "ssh", trust: "trusted", conn: "up", w: "running" });
  });

  it("after the app updates, the older agent is replaced before the worker resumes", () => {
    const s = run(CFG, [...asked("ssh"), A.drop(0), { type: "AppUpdate" }, CONNECT, A.agent(3), A.app(3)]);
    expect(view(s)).toMatchObject({ conn: "upgrade", w: "interrupted" });
    expect(s.alive).toEqual([1]);
  });

  it.todo("the app through spec/driver/remote-worker-driver.ts: random walks equal the reference's view after every step");
});
