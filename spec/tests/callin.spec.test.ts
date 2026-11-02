// @ routing and call-ins (spec/models/callin) against the real Core, through spec-adapters/callin-adapter.ts.
// (a) Conformance: seeded random walks of the reference, and a few fixed ones, are driven into the app;
//     after every step what the app shows must be what the reference says.
// (b) Trace check: the same walks run with BOTLING_SPEC_TRACE set; every line the app wrote must be a step
//     the reference allows (after steps the app does not trace: a callee's turn beginning, an own turn
//     ending with nothing to show, a sub bot removed).
// SPEC_BUG=callin runs the reference as the app was before 78bf1640 (drops left no notice);
// SPEC_BUG=callin-sub as before 9d7c0bda (sub bots not callable either): both must go red.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCallinDriver } from "../../desktop/spec-adapters/callin-adapter";
import type { CallinDriver } from "../driver/callin-driver";
import { CallinReference, viewOf, type CallinAction, type CallinState, type Outcome } from "../reference/callin";

const BUG = process.env.SPEC_BUG === "callin" ? "silent" : process.env.SPEC_BUG === "callin-sub" ? "sub" : "none";
const BODIES = ["deploy it", "check it"];
const BOUNDS = { maxAts: 12, maxOwn: 2 };
const INTERNAL = ["Start", "Take", "GiveUp"] as const;
// The app runs these itself: a call-in's turn comes, its callee is free or not (it waits 0 ms here).
const isInternal = (a: CallinAction) => (INTERNAL as readonly string[]).includes(a.name);

const dirs: string[] = [];
const drivers: CallinDriver[] = [];
afterEach(async () => {
  delete process.env.BOTLING_SPEC_TRACE;
  for (const driver of drivers.splice(0)) await driver.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); dirs.push(dir); return dir; };

async function open(): Promise<{ driver: CallinDriver; ref: CallinReference }> {
  const driver = await createCallinDriver({ dataDir: temp("spec-callin-") });
  drivers.push(driver);
  // The app's BOT_MENTIONS_PER_USER_LINE and MAX_FOLLOW_DEPTH.
  return { driver, ref: new CallinReference({ top: driver.top, parent: driver.parent, cap: 3, maxDepth: 2, bug: BUG }) };
}

/** Runs the steps the app takes by itself until none is left. */
function internal(ref: CallinReference, s: CallinState): CallinState {
  for (let moved = true; moved;) {
    moved = false;
    for (const c of ref.config.top) for (const name of INTERNAL) {
      const next = ref.step(s, { name, c });
      if (next) { s = next; moved = true; }
    }
  }
  return s;
}

/** Drives one model action into the app; `ids` maps a reply's model msg to its id in the app. */
async function drive(driver: CallinDriver, s: CallinState, a: CallinAction, ids: Map<number, string>) {
  switch (a.name) {
    case "UserLine": return driver.userLine(a.c, a.t);
    case "BotReply": { const id = await driver.botReply(a.c, a.t, a.b); if (a.t !== null) ids.set(s.ev.length + 1, id); return; }
    case "Rehear": { const e = s.ev[a.k - 1]!; return driver.rehear(e.chat, ids.get(e.msg)!); }
    case "OwnEnd": return driver.ownEnd(a.b);
    case "Remove": return driver.remove(a.s);
    case "Answer": return driver.answer(a.c);
    case "NoAnswer": return driver.noAnswer(a.c);
    default: throw new Error(`${a.name} is the app's own step`);
  }
}

const label = (a: CallinAction) => `${a.name}(${Object.entries(a).filter(([key]) => key !== "name").map(([, value]) => JSON.stringify(value)).join(", ")})`;

/** Drives `actions` (or, when a function, picks each next one) and compares app and reference after every step. */
async function walk(pick: (enabled: CallinAction[], step: number, s: CallinState) => CallinAction | null, steps: number, bodies = BODIES) {
  const { driver, ref } = await open();
  let s = ref.init();
  const ids = new Map<number, string>();
  const done: string[] = [];
  for (let step = 0; step < steps; step++) {
    const a = pick(ref.enabled(s, bodies, BOUNDS).filter((candidate) => !isInternal(candidate)), step, s);
    if (!a) break;
    const next = ref.step(s, a);
    if (!next) throw new Error(`${label(a)} is not enabled after ${done.join(" ")}`);
    await drive(driver, s, a, ids);
    s = internal(ref, next);
    done.push(label(a));
    expect(ref.invariants(s), done.join(" ")).toEqual([]);
    expect(driver.view(), done.join(" ")).toEqual(viewOf(ref, s));
  }
  return { driver, ref, s, done };
}

/** A seeded generator (mulberry32). */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A random walk, each kind of action as likely as another, each reply heard again at most once; `skip` names actions left out. */
const randomly = (seed: number, skip: string[] = []) => {
  const next = random(seed);
  const any = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  return (enabled: CallinAction[], _: number, s: CallinState) => {
    const once = (a: CallinAction) => a.name !== "Rehear" || s.ev.filter((e) => e.msg === s.ev[a.k - 1]!.msg).length === 1;
    const left = enabled.filter((a) => !skip.includes(a.name) && once(a));
    if (!left.length) return null;
    const name = any([...new Set(left.map((a) => a.name))]);
    return any(left.filter((a) => a.name === name));
  };
};
const fixed = (actions: CallinAction[]) => (_: CallinAction[], step: number) => actions[step] ?? null;

const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i);
/** Every outcome the random walks reached, so a walk that goes nowhere shows. */
const reached = new Set<string>();

describe("callin conformance", () => {
  it.each([
    ["a project bot's reply reaches its own sub bot in its chat", [{ name: "UserLine", c: "C", t: null }, { name: "BotReply", c: "C", t: "S", b: BODIES[0] }, { name: "Answer", c: "C" }]],
    ["another bot's sub bot is not called, and the chat says so", [{ name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "S", b: BODIES[0] }]],
    ["a busy callee does not answer, and the chat says so", [{ name: "UserLine", c: "B", t: null }, { name: "UserLine", c: "A", t: "B" }]],
    ["one chat's call-ins answer one at a time, the next queued", [{ name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }, { name: "UserLine", c: "A", t: "C" }, { name: "Answer", c: "A" }, { name: "Answer", c: "A" }]],
    ["the same words again: quiet while pending, a notice once answered", [{ name: "UserLine", c: "A", t: null }, { name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }, { name: "Answer", c: "A" }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }]],
    ["a reply heard again is not delivered again", [{ name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }, { name: "Rehear", k: 1 }, { name: "Answer", c: "A" }, { name: "Rehear", k: 1 }]],
    ["the hand-back chain stops at the depth limit", [{ name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "B", b: BODIES[0] }, { name: "Answer", c: "A" }, { name: "BotReply", c: "A", t: "C", b: BODIES[0] }, { name: "Answer", c: "A" }]],
    ["a callee removed before its turn is told of", [{ name: "UserLine", c: "C", t: "A" }, { name: "UserLine", c: "C", t: "S" }, { name: "Remove", s: "S" }, { name: "Answer", c: "C" }]],
  ] as [string, CallinAction[]][])("%s", async (_, actions) => {
    const { done } = await walk(fixed(actions), actions.length);
    expect(done).toHaveLength(actions.length);
  });

  // NoAnswer is left out until a failed call-in turn leaves its notice (the it.fails below).
  it.each(SEEDS)("random walk, seed %i", async (seed) => {
    // One body on even seeds, so the same words come again more often.
    const { s } = await walk(randomly(seed, ["NoAnswer"]), 40, seed % 2 ? BODIES : [BODIES[0]!]);
    for (const e of s.ev) reached.add(e.st);
  });

  it("the random walks reach every outcome of an @ but a failed turn's", () => {
    expect([...reached]).toEqual(expect.arrayContaining(["answered", "dropped", "merged", "seen", "unheard", "unreachable"]));
  });
});

describe("callin real bugs", () => {
  // A failed guest turn calls onReply("") (finishTurn), which groupTurn takes for an empty reply: no line, no notice.
  it.fails("a call-in whose turn fails leaves a notice", async () => {
    const { driver } = await walk(fixed([{ name: "UserLine", c: "A", t: "B" }]), 1);
    await driver.noAnswer("A");
    expect(driver.view().pending.A).toEqual([]);
    expect(driver.view().notices.A).toBe(1);
  });
});

// ---- (b) Trace check

interface Line { action: string; state: { chat: string; to: string | null; body?: string | null; msg?: string; outcome: string; posted?: boolean; followUp?: number; pending: { id: string; state: string }[] } }

/** Replays the app's trace lines through the reference; returns the first line that is not an allowed step, or null. */
function replay(ref: CallinReference, lines: Line[], nameOf: (id: string) => string | null): string | null {
  let s = ref.init();
  const msgs = new Map<string, number>();
  // Untraced steps from `from`: a callee's turn begins, a bot's own turns end (any number), a sub bot is removed.
  const hidden = (from: CallinState): CallinState[] => [
    ...[...ref.config.top.map((c) => ({ name: "Take" as const, c })), ...Object.keys(ref.config.parent).map((sub) => ({ name: "Remove" as const, s: sub }))]
      .flatMap((a) => ref.step(from, a) ?? []),
    ...ref.bots.flatMap((b) => {
      const ends: CallinState[] = [];
      for (let at = ref.step(from, { name: "OwnEnd", b }); at; at = ref.step(at, { name: "OwnEnd", b })) ends.push(at);
      return ends;
    }),
  ];
  for (const [i, line] of lines.entries()) {
    const { state } = line;
    const c = nameOf(state.chat)!, to = state.to === null ? null : nameOf(state.to);
    let action: CallinAction;
    if (line.action === "UserLine") action = { name: "UserLine", c, t: to };
    else if (line.action === "BotReply") {
      const k = msgs.has(state.msg!) ? s.ev.findIndex((e) => e.msg === msgs.get(state.msg!)) + 1 : 0;
      action = k ? { name: "Rehear", k } : { name: "BotReply", c, t: state.outcome === "none" ? null : to, b: state.body ?? "" };
    } else action = { name: line.action, c } as CallinAction;
    const matches = (before: CallinState, after: CallinState) => {
      const pending = after.pending[c]?.map((p) => ({ id: after.ev[p.ev - 1]!.to, state: p.st }));
      if (JSON.stringify(pending ?? []) !== JSON.stringify(state.pending.map((p) => ({ id: nameOf(p.id), state: p.state })))) return false;
      let outcome: Outcome | "none";
      if (action.name === "UserLine") return true;
      if (action.name === "BotReply" || action.name === "Rehear") outcome = after.ev.length > before.ev.length ? after.ev.at(-1)!.st : "none";
      else if (action.name === "Start") outcome = after.ev[before.ev.findIndex((e) => e.chat === c && e.st === "queued")]!.st;
      else outcome = after.ev[before.cur[c]! - 1]!.st;
      if (outcome !== state.outcome) return false;
      return action.name !== "Answer" || (state.posted === true && after.followUp[c] === state.followUp);
    };
    // The shortest run of untraced steps after which the line's action gives what the app wrote.
    let found: CallinState | null = null;
    for (let queue: CallinState[] = [s], depth = 0; !found && depth <= 3; depth++) {
      const deeper: CallinState[] = [];
      for (const from of queue) {
        const after = ref.step(from, action);
        if (after && matches(from, after)) { found = after; break; }
        deeper.push(...hidden(from));
      }
      queue = deeper;
    }
    if (!found) return `line ${i + 1}: ${line.action} ${JSON.stringify(state)} after ${JSON.stringify({ ...s, ev: s.ev.map((e) => `${e.by} ${e.chat}>${e.to} ${e.st} d${e.depth}`) })}`;
    if (action.name === "BotReply" && found.ev.length > s.ev.length) msgs.set(state.msg!, found.ev.at(-1)!.msg);
    s = found;
    // A callee's turn begins as soon as it is free, unless the chat's next call-in line says it gave up.
    for (const chat of ref.config.top) {
      const next = lines.slice(i + 1).find((later) => later.action !== "UserLine" && later.action !== "BotReply" && nameOf(later.state.chat) === chat);
      if (next?.action !== "GiveUp") s = ref.step(s, { name: "Take", c: chat }) ?? s;
    }
    if (ref.invariants(s).length) return `line ${i + 1}: breaks ${ref.invariants(s).join(", ")}`;
  }
  return null;
}

describe("callin trace check", () => {
  it("a trace the model does not allow is caught", async () => {
    const dir = temp("spec-callin-trace-");
    process.env.BOTLING_SPEC_TRACE = dir;
    const { driver, ref } = await walk(fixed([{ name: "UserLine", c: "A", t: null }, { name: "BotReply", c: "A", t: "S", b: BODIES[0] }, { name: "UserLine", c: "C", t: null }, { name: "BotReply", c: "C", t: "S", b: BODIES[0] }, { name: "Answer", c: "C" }]), 5);
    const lines: Line[] = readFileSync(join(dir, "callin.jsonl"), "utf8").trim().split("\n").map((text) => JSON.parse(text));
    const nameOf = (id: string) => driver.nameOf(id);
    expect(replay(ref, lines, nameOf)).toBeNull();
    // A's @ to C's sub bot delivered, C's dropped, an answer posted twice, the callee's turn left out.
    const unreachable = lines.findIndex((line) => line.state.outcome === "unreachable");
    const queued = lines.findIndex((line) => line.state.outcome === "queued");
    const answer = lines.findIndex((line) => line.action === "Answer");
    const tampered = [
      lines.map((line, i) => (i === unreachable ? { ...line, state: { ...line.state, outcome: "queued" } } : line)),
      lines.map((line, i) => (i === queued ? { ...line, state: { ...line.state, outcome: "unreachable" } } : line)),
      [...lines.slice(0, answer + 1), lines[answer]!],
      lines.filter((line) => line.action !== "Start"),
    ];
    for (const trace of tampered) expect(replay(ref, trace, nameOf)).not.toBeNull();
  });

  it.each(SEEDS.slice(0, 8))("every line the app traces is a step of the model, seed %i", async (seed) => {
    const dir = temp("spec-callin-trace-");
    process.env.BOTLING_SPEC_TRACE = dir;
    const { driver, ref } = await walk(randomly(seed, ["NoAnswer"]), 30);
    const lines: Line[] = readFileSync(join(dir, "callin.jsonl"), "utf8").trim().split("\n").map((text) => JSON.parse(text));
    expect(lines.length).toBeGreaterThan(0);
    expect(replay(ref, lines, (id) => driver.nameOf(id))).toBeNull();
  });
});
