// A bot's turn schedule (spec/models/turns) against the real Bot, through spec-adapters/turns-adapter.ts (claude's head
// a stand-in whose lines wait until the walk says what claude does with them). Conformance: seeded random walks of the
// reference, and fixed ones, are driven into the app; after every step what the bot holds (the queue, the turn under
// way and the one set aside, your steered lines, the pause, the hold, the drain, its process and its folder, what is
// on claude's stdin) must be what the reference says, and the reference keeps the model's invariants and step
// properties. Not driven (the reference's only): a message to both heads (Claim), approvals (Gate), claude's own
// report turns, the tidy and sleep, the tree kill of a stopped turn (Grace), Antigravity (TurnsAgy).
// The reference, explored like TLC, has Turns.cfg's states; none of its states where nothing fair can happen leaves a
// turn, a queue, a hold or a message hanging; and each of the model's bugs breaks what it names.
// SPEC_BUG=turns:<bug> runs the walks against the reference with that bug: they must go red.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTurnsDriver } from "../../desktop/spec-adapters/turns-adapter";
import type { TurnsDriver } from "../driver/turns-driver";
import { TurnsReference, viewOf, type Bug, type TurnsAction, type TurnsConfig, type TurnsState } from "../reference/turns";

const BUG = process.env.SPEC_BUG?.startsWith("turns:") ? process.env.SPEC_BUG.slice(6) as Bug : undefined;
const WALKS: TurnsConfig = { users: ["u1", "u2"], apps: ["a1"], conducted: ["a1"], engine: "claude", maxMoves: 1, maxWork: 1, maxSwaps: 1, bug: BUG };

const dirs: string[] = [];
const drivers: TurnsDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(): Promise<{ driver: TurnsDriver; ref: TurnsReference }> {
  const dataDir = mkdtempSync(join(tmpdir(), "spec-turns-"));
  dirs.push(dataDir);
  const driver = await createTurnsDriver({ dataDir });
  drivers.push(driver);
  return { driver, ref: new TurnsReference(WALKS) };
}

const DRIVEN = new Set(["Arrive", "Stop", "StopQueued", "StopDeferred", "CBegin", "CRead", "CShow", "CEnd", "StartWork", "EndWork", "Move", "SwapOn", "SwapOff", "ReleaseHold"]);

async function drive(driver: TurnsDriver, ref: TurnsReference, a: TurnsAction) {
  switch (a.name) {
    case "Arrive": return driver.arrive(a.m, { user: ref.kind(a.m) === "user", conducted: ref.config.conducted.includes(a.m) });
    case "Stop": return driver.stop();
    case "StopQueued": return driver.stopQueued(a.m);
    case "StopDeferred": return driver.stopDeferred();
    case "CBegin": return driver.begin();
    case "CRead": return driver.read(a.said);
    case "CShow": return driver.show();
    case "CEnd": return driver.end();
    case "StartWork": return driver.startWork();
    // Its work's end is not seen by the app until its news is told (claude's report turn, not driven).
    case "EndWork": return;
    case "Move": return driver.move();
    case "SwapOn": return driver.swap(true);
    case "SwapOff": return driver.swap(false);
    case "ReleaseHold": return driver.releaseHold();
    default: throw new Error(`${a.name} is not driven`);
  }
}

const label = (a: TurnsAction) => a.name + ("m" in a ? `(${a.m})` : "said" in a ? `(${a.said ? "said" : "silent"})` : "");

async function walk(pick: (enabled: TurnsAction[], step: number) => TurnsAction | null, steps: number) {
  const { driver, ref } = await open();
  let s = ref.init();
  const done: string[] = [];
  expect(driver.view()).toEqual(viewOf(s));
  for (let step = 0; step < steps; step++) {
    const a = pick(ref.enabled(s).filter((candidate) => DRIVEN.has(candidate.name)), step);
    if (!a) break;
    const next = ref.step(s, a);
    if (!next) throw new Error(`${label(a)} is not enabled after ${done.join(" ")}`);
    await drive(driver, ref, a);
    done.push(label(a));
    expect(ref.stepProperties(s, next), done.join(" ")).toEqual([]);
    s = next;
    expect(ref.invariants(s), done.join(" ")).toEqual([]);
    expect(driver.view(), done.join(" ")).toEqual(viewOf(s));
  }
  return { s, done, driver, ref };
}

/** A seeded generator (mulberry32). */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randomly = (seed: number) => {
  const next = random(seed);
  const any = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  return (enabled: TurnsAction[]) => {
    if (!enabled.length) return null;
    const name = any([...new Set(enabled.map((a) => a.name))]);
    return any(enabled.filter((a) => a.name === name));
  };
};
const fixed = (actions: TurnsAction[]) => (_: TurnsAction[], step: number) => actions[step] ?? null;
const arrive = (m: string): TurnsAction => ({ name: "Arrive", m });
const begin: TurnsAction = { name: "CBegin" };
const end: TurnsAction = { name: "CEnd" };
const show: TurnsAction = { name: "CShow" };
const read = (said: boolean): TurnsAction => ({ name: "CRead", said });

/** The fair actions of the model (its Fairness): a state where none is enabled stays as it is for good. */
const FAIR = new Set(["CBegin", "CEnd", "CReport", "EndWork", "GateOff", "ReleaseClaim", "SwapOff", "ReleaseHold", "Grace", "TidyLate", "Sleep"]);
/** What a state where nothing fair can happen leaves hanging (the liveness properties it breaks). */
function hanging(ref: TurnsReference, s: TurnsState): string[] {
  if (ref.enabled(s).some((a) => FAIR.has(a.name))) return [];
  const out: string[] = [];
  if (s.turn.open) out.push("TurnEnds");
  if (s.queue.length) out.push("QueueDrains");
  if (s.hold) out.push("HoldEnds");
  if (ref.msgs.some((m) => !s.fresh.includes(m) && s.read[m] === 0 && !s.stopped.includes(m))) out.push("EveryMessageRead");
  return out;
}

/** Breadth-first over every reachable state, as TLC does: the count, and the properties some state breaks. */
function explore(config: TurnsConfig, limit = 400_000) {
  const ref = new TurnsReference(config);
  const init = ref.init();
  const seen = new Set([JSON.stringify(init)]);
  const failed = new Set<string>();
  const queue: TurnsState[] = [init];
  for (let at = 0; at < queue.length; at++) {
    const s = queue[at]!;
    for (const name of [...ref.invariants(s), ...hanging(ref, s)]) failed.add(name);
    for (const a of ref.candidates()) {
      const n = ref.step(s, a);
      if (!n) continue;
      for (const name of ref.stepProperties(s, n)) failed.add(name);
      const key = JSON.stringify(n);
      if (seen.has(key)) continue;
      if (seen.size >= limit) throw new Error(`more than ${limit} states`);
      seen.add(key);
      queue.push(n);
    }
  }
  return { states: seen.size, failed: [...failed].sort() };
}

describe("turn schedule conformance", () => {
  it.each([
    ["your line while it works on handed-over work pauses it; the work goes on with the resume note after your answer", [
      arrive("a1"), begin, arrive("u1"), read(true), end, begin, end,
    ]],
    ["your line steered into your turn and read there leaves nothing behind", [
      arrive("u1"), begin, arrive("u2"), read(false), end, arrive("a1"), begin, end,
    ]],
    ["a steered line the turn ended before reading gets a turn of its own; the app's line sent meanwhile waits for it", [
      arrive("u1"), begin, arrive("u2"), end, arrive("a1"), begin, read(false), end,
    ]],
    // silentsteer: claude read your line into the turn under way, saying "started" for it; it is no turn of its own.
    ["a line read into the turn under way with a \"started\" is not a turn of its own", [
      arrive("a1"), arrive("u1"), begin, read(true), end, begin, end,
    ]],
    // apphold: the resume note waits for the restart a move owes (your unread line is work of its own).
    ["after a move, the resume note waits for its own work and goes to the new process", [
      arrive("a1"), arrive("u1"), begin, { name: "Move" }, end, begin, end,
    ]],
    ["after a move with its own work running, the app's line waits too", [
      arrive("u1"), begin, { name: "StartWork" }, { name: "Move" }, end, arrive("a1"),
    ]],
    // steerold: nothing is steered into the process still in the old folder.
    ["after a move your line is not steered into the old process: it waits for the turn under way", [
      arrive("a1"), { name: "Move" }, arrive("u1"), begin, end, begin, end,
    ]],
    // drainnext: nothing begins while a stopped turn drains.
    ["while a stopped turn drains nothing else begins, and the turn set aside does not come back", [
      arrive("a1"), { name: "Stop" }, arrive("u1"), arrive("u2"), { name: "Stop" }, begin, end, begin, end,
    ]],
    ["a turn set aside comes back only once the stopped turn has drained", [
      arrive("u1"), begin, arrive("u2"), end, arrive("a1"), { name: "SwapOn" }, begin, { name: "Stop" }, { name: "SwapOff" }, read(false), end,
    ]],
    ["a move while idle: the next line restarts the process in the new folder", [
      arrive("u1"), begin, end, { name: "Move" }, arrive("a1"), begin, show, end,
    ]],
    ["a line waiting is taken back; Esc on the turn under way drains it, then the queue goes on", [
      arrive("u1"), begin, show, arrive("a1"), arrive("u2"), { name: "StopQueued", m: "a1" }, { name: "Stop" }, end, begin, end,
    ]],
  ] as [string, TurnsAction[]][])("%s", async (_, actions) => {
    const { done } = await walk(fixed(actions), actions.length);
    expect(done).toHaveLength(actions.length);
  });

  it.each(Array.from({ length: 40 }, (_, i) => 7000 + i))("random walk %i", async (seed) => {
    await walk(randomly(seed), 50);
  });

  const cfg: TurnsConfig = { users: ["u1"], apps: ["a1"], conducted: ["a1"], engine: "claude", maxMoves: 1, maxWork: 1, maxSwaps: 0 };

  it("the reference has the model's state space (TLC: Turns.cfg, TurnsAgy.cfg) and keeps its properties", () => {
    expect(explore(cfg)).toEqual({ states: TLC_STATES, failed: [] });
    expect(explore(TURNS_AGY)).toEqual({ states: TLC_AGY_STATES, failed: [] });
  }, 120_000);

  it.each([
    ["silentsteer", "TurnEnds", { users: ["u1", "u2", "u3"], apps: [], conducted: [], maxMoves: 0, maxWork: 0 }],
    ["apphold", "StaleSend", {}],
    ["steerold", "StaleSend", {}],
    ["tidysteer", "EveryMessageRead", {}],
    ["drainnext", "TurnEnds", { maxSwaps: 1 }],
    ["gracesend", "EveryMessageRead", { users: ["u1", "u2"] }],
    ["reportgate", "HoldEnds", TURNS_AGY],
  ] as [Bug, string, Partial<TurnsConfig>][])("the bug %s breaks %s (as Turns_bug*.cfg)", (bug, property, change) => {
    expect(explore({ ...cfg, ...change, bug }).failed).toContain(property);
  }, 120_000);
});

const TURNS_AGY: TurnsConfig = { users: ["u1"], apps: ["a1"], conducted: [], engine: "agy", maxMoves: 1, maxWork: 1, maxSwaps: 0 };
/** TLC on TurnsAgy.cfg: "4496 distinct states found". */
const TLC_AGY_STATES = 4496;
/** TLC on Turns.cfg: "6360 distinct states found". */
const TLC_STATES = 6360;
