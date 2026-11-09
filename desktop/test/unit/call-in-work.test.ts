// The follow-up route of a worker a bot started for another bot's @ (spec/models/worker: Link, Expire, TurnEnd):
// a turn on its report always tells the asking bot something as it ends (its reply, or that it ended without one);
// a turn on a note tells only a reply; nothing goes back once the three days ran out; the route survives a restart.
import { describe, expect, it } from "vitest";
import { CALL_IN_WORK_MS, CallInWorkBook, followUpOf, type CallInWork } from "../../src/core/call-in-work";

function book(start = 1_000) {
  let saved: unknown = undefined;
  let now = start;
  const store = { load: () => saved, save: (work: Record<string, CallInWork>) => { saved = JSON.parse(JSON.stringify(work)); } };
  return { store, clock: { set: (t: number) => { now = t; }, get: () => now }, make: () => new CallInWorkBook(store, () => now) };
}

describe("call-in work follow-up route", () => {
  it("a turn on a report tells its reply, or why it ended without one", () => {
    const relay = { caller: "a", asked: "q", until: 10, news: "report" as const };
    expect(followUpOf(relay, { status: "done", visible: true }, 5)).toEqual({ kind: "reply" });
    expect(followUpOf(relay, { status: "done", visible: false }, 5)).toEqual({ kind: "noReply", why: "it said nothing" });
    expect(followUpOf(relay, { status: "stopped", visible: true }, 5)).toEqual({ kind: "noReply", why: "its turn was stopped" });
    expect(followUpOf(relay, { status: "failed", visible: false, error: "boom\nstack" }, 5)).toEqual({ kind: "noReply", why: "its turn failed: boom" });
  });

  it("a turn on a note tells only a reply; an expired or missing route tells nothing", () => {
    const note = { caller: "a", asked: "q", until: 10, news: "note" as const };
    expect(followUpOf(note, { status: "done", visible: true }, 5)).toEqual({ kind: "reply" });
    expect(followUpOf(note, { status: "failed", visible: false }, 5)).toBeNull();
    expect(followUpOf({ ...note, news: "report" }, { status: "done", visible: true }, 10)).toBeNull();
    expect(followUpOf(undefined, { status: "done", visible: true }, 5)).toBeNull();
  });

  it("the route is kept across a restart and runs out after three days", () => {
    const b = book();
    b.make().link("w1", "caller", "asked");
    const again = b.make();
    expect(again.relay("w1", "note")).toMatchObject({ caller: "caller", asked: "asked", news: "note" });
    b.clock.set(1_000 + CALL_IN_WORK_MS);
    expect(again.relay("w1", "report")).toBeUndefined();
    expect(b.make().relay("w1", "report")).toBeUndefined();
  });
});
