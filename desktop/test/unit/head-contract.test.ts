// The head-stream contract (provider-layer plan §9 step 7): one suite every bot head class must pass, the safety net for
// putting ClaudeHead, CodexHead and AgyAcpHead behind one HeadSession interface (step 8). Each engine's REAL head runs
// on a fake process fed head streams (test/fixtures/head-streams, recorded or written from the protocol code; replay.ts
// says which and how), and every assertion reads only what the Bot sees, in one format for all three: the StreamItems,
// each turn's end through headTurnEnd, and whether it gets a bubble through headTurnContent → hasVisibleContent.
//
// Every engine has every scenario in SCENARIOS; what all engines must agree on is SHARED, what differs (the reply's
// words, step counts, the engine's stop request) is in <scenario>.expect.json. A head must also write what the
// recording shows it wrote (its requests, answers and stops, in order) and ask for every response the stream answers.
// test:changed runs this file when replay.ts or an adapter changes, or a head's code (head.ts, codex.ts, agy-acp.ts,
// stream.ts, head-turn.ts, worker-core).
//
// HEAD_CONTRACT_BUG puts known head bugs back at the shared seams, without editing code; each must turn the suite red
// for EVERY engine:
//   HEAD_CONTRACT_BUG=classify      every head turn's end is classified done (classifyRun)      → failed-turn, interrupt red
//   HEAD_CONTRACT_BUG=blank-bubble  a turn with nothing to show still gets a bubble (D5 undone)  → silent red
//   HEAD_CONTRACT_BUG=usage         the head's usage items never reach the Bot                   → turn red
//   e.g. HEAD_CONTRACT_BUG=classify npx vitest run test/unit/head-contract.test.ts
// HEAD_CONTRACT_DUMP=1 prints each scenario's observed values (to write or check an expect.json by hand).
import { describe, expect, it, vi } from "vitest";
import { registration as agy } from "../head-streams/adapter-agy";
import { registration as claude } from "../head-streams/adapter-claude";
import { registration as codex } from "../head-streams/adapter-codex";
import { headScenarios, loadHeadFixture, replayHead, unmetHead, type HeadExpectation, type HeadRegistration } from "../head-streams/replay";

const bugs = vi.hoisted(() => new Set((process.env.HEAD_CONTRACT_BUG ?? "").split(",").map((bug) => bug.trim()).filter(Boolean)));

vi.mock("../../src/core/worker-core/classify", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/worker-core/classify")>();
  if (!bugs.has("classify")) return real;
  return { ...real, classifyRun: (facts: Parameters<typeof real.classifyRun>[0]) => ({ ...real.classifyRun(facts), status: "done" as const }) };
});

vi.mock("../../src/core/worker-core/visible", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/worker-core/visible")>();
  return bugs.has("blank-bubble") ? { ...real, hasVisibleContent: () => true } : real;
});

const drop = bugs.has("usage") ? (item: { kind: string }) => item.kind === "usage" : undefined;

const REGISTRATIONS: HeadRegistration[] = [claude, codex, agy];

/** Every engine's scenarios, and what every engine's Bot view must show for each. */
const SHARED: Record<string, HeadExpectation> = {
  // start, send: the session is reported; one user turn ends done with a reply in a bubble; usage and token speed come.
  turn: { init: true, status: "done", reply: "^\\S", bubble: true, usage: ">=1", outputTokens: ">=1", requests: ">=1" },
  // A failed tool does not fail a turn that ends normally with a reply.
  "failed-tool": { init: true, turns: 1, status: "done", failedSteps: 1, reply: "^\\S", bubble: true },
  // Stop: the head writes its engine's stop request (expect.json `writes`) and the turn ends, not done.
  interrupt: { turns: 1, status: "failed", openTurn: false },
  // A permission request reaches the Bot; the answer goes back and the turn goes on to its end.
  permission: { permissions: 1, status: "done", bubble: true },
  // A message while a turn runs: joined into it (Claude, Codex) or queued for the next turn (Antigravity); none is lost.
  steer: { steered: true, status: "done", openTurn: false },
  // The engine fails the turn: failed, with words, and the error shows.
  "failed-turn": { turns: 1, status: "failed", error: "^\\S", bubble: true },
  // Your message answered with <no-reply/> only: done, and no bubble (shared-core D5).
  silent: { turns: 1, status: "done", reply: "", bubble: false },
  // The process dies by itself: the Bot hears an unexpected exit.
  exit: { exit: "unexpected" },
};
const SCENARIOS = Object.keys(SHARED);

describe.each(REGISTRATIONS.map((registration) => [registration.label, registration] as const))("%s", (_label, registration) => {
  const { engine } = registration;
  const present = headScenarios(engine);

  it("has a fixture for every shared scenario", () => {
    expect(SCENARIOS.filter((scenario) => !present.includes(scenario))).toEqual([]);
  });

  for (const scenario of [...new Set([...SCENARIOS, ...present])].filter((name) => present.includes(name))) {
    const fixture = loadHeadFixture(engine, scenario);
    it(`${scenario} (${fixture.header.source})`, async () => {
      const r = await replayHead(registration, fixture, { drop });
      if (process.env.HEAD_CONTRACT_DUMP) console.log(`${engine}/${scenario}`, JSON.stringify(r.observed));
      expect(r.unanswered, "responses in the stream to requests the head never made").toEqual([]);
      expect(r.missingWrites, "writes the recording shows and the head did not make").toEqual([]);
      expect(unmetHead(SHARED[scenario] ?? {}, r.observed), "the shared contract").toEqual([]);
      expect(unmetHead(fixture.expect, r.observed), `${engine}/${scenario}.expect.json`).toEqual([]);
    });
  }
});
