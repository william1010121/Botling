// fu-callin-outbox, B's side (M5-03b review F4): marking a call-in answered and queueing its answer are ONE transaction
// (`ServerOrigin.submitIn`), so no kill leaves a row marked sent with no answer queued (the host would wait 16 minutes).
// The fake sender writes a marker row into the caller's transaction, the way the real one writes the queue row, and the
// crash hook (the point where the real process is SIGKILLed in the two-process test) snapshots what is durable there.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command, type Command as CommandType } from "../../src/contract";
import type { Slot, Target } from "../../src/protocol";
import { callInCrash, type CallInGuestSender } from "../../src/server/callin";
import type { Db } from "../../src/server/store";
import { tempDir } from "../helpers";
import { effectRows, harness, type Harness } from "./server-intents-harness";

const GUEST = "GUEST";
const HOST = "6A0B0000-0000-4000-8000-000000000003";
const ORIGIN = "srv-host";
const HOST_TARGET = `bot:${HOST}` as Target;
const ask = (callId: string): CommandType => ({
  type: "callin.ask", botId: GUEST, callId, host: { server: ORIGIN, botId: HOST, name: "build" },
  transcript: "User (newest): @tester status?", asked: "@tester status?", by: "user", depth: 1,
});

/** A sender whose `submitIn` writes `queued:<callId>` into the caller's transaction (what the queue row is), then throws if told to. */
function markerSender(options: { failFor?: (callId: string, attempt: number) => boolean } = {}) {
  const done: Array<Extract<CommandType, { type: "callin.reply" }>> = [];
  const attempts = new Map<string, number>();
  const sender: CallInGuestSender = {
    ownerOf: (target) => (target === HOST_TARGET ? ORIGIN : null),
    async submit() { throw new Error("the answer must not take the two-step path"); },
    submitIn(tx: Db, target, cmd) {
      const reply = Command.parse(cmd) as Extract<CommandType, { type: "callin.reply" }>;
      const attempt = (attempts.get(reply.callId) ?? 0) + 1;
      attempts.set(reply.callId, attempt);
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`queued:${reply.callId}`, JSON.stringify(reply.outcome));
      if (options.failFor?.(reply.callId, attempt)) throw new TypeError("test: the answer cannot be queued");
      return { slot: { origin: "srv-b", originEpoch: "f".repeat(32), target, n: done.length + 1 } as Slot, done: () => { done.push(reply); } };
    },
  };
  return { sender, done };
}

const open: Harness[] = [];
afterEach(() => { for (const h of open.splice(0)) h.close(); });
const queued = (h: Harness) => h.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'queued:%' ORDER BY key").all().map((row) => [String(row.key), JSON.parse(String(row.value)) as { kind: string; why?: string }] as const);
const rowsOf = (h: Harness) => effectRows(h.db).filter((row) => row.kind === "callin").map((row) => [row.state, row.payload.replied] as const);

/** The durable state at each crash point: B's row and the queued marker, and whether the queue was pumped (`done`) yet. */
function crashProbe(getHarness: () => Harness, sent: () => number) {
  const seen: Array<{ point: string; callId: string; rows: Array<readonly [string, unknown]>; queued: string[]; pumped: number }> = [];
  const crash = (point: string, callId: string) => {
    const h = getHarness();
    seen.push({ point, callId, rows: rowsOf(h), queued: queued(h).map(([key]) => key), pumped: sent() });
  };
  return { seen, crash: crash as never };
}

describe("fu-callin-outbox: the guest's answer is one durable step", () => {
  it("1. at the crash point (committed, not pumped) the row is finished AND replied AND the answer is queued; the pump follows", async () => {
    const s = markerSender();
    let h!: Harness;
    const probe = crashProbe(() => h, () => s.done.length);
    h = await harness({ bots: ["MAIN", GUEST] }, undefined, { callInCrash: probe.crash });
    open.push(h);
    h.runtime.callIns.attach(s.sender);
    await h.send(ask("call-1"), { origin: ORIGIN });
    await h.settle();
    expect(probe.seen).toEqual([{ point: "guest", callId: "call-1", rows: [["finished", true]], queued: ["queued:call-1"], pumped: 0 }]);
    expect(s.done).toHaveLength(1);
    expect(s.done[0]!.outcome).toMatchObject({ kind: "reply" });
  });

  it("2. an answer that cannot be queued rolls back whole: the failed try's marker is gone, the short answer is the one queued, once", async () => {
    const s = markerSender({ failFor: (_id, attempt) => attempt === 1 });
    const h = await harness({ bots: ["MAIN", GUEST] });
    open.push(h);
    h.runtime.callIns.attach(s.sender);
    await h.send(ask("call-2"), { origin: ORIGIN });
    await h.settle();
    expect(queued(h)).toEqual([["queued:call-2", { kind: "failed", why: "its answer could not be sent" }]]);
    expect(rowsOf(h)).toEqual([["finished", true]]);
    expect(s.done.map((reply) => reply.outcome)).toEqual([{ kind: "failed", why: "its answer could not be sent" }]);
  });

  it("3. neither answer can be queued: nothing is queued, the row ends once (finished, replied) and is never retried", async () => {
    const s = markerSender({ failFor: () => true });
    const h = await harness({ bots: ["MAIN", GUEST] });
    open.push(h);
    h.runtime.callIns.attach(s.sender);
    await h.send(ask("call-3"), { origin: ORIGIN });
    await h.settle();
    expect(queued(h)).toEqual([]);
    expect(rowsOf(h)).toEqual([["finished", true]]);
    expect(s.done).toEqual([]);
    expect(h.logs.filter((line) => /even the short answer to call-3 was not sent/.test(line))).toHaveLength(1);
  });

  it("4. a restart answers each interrupted call-in once, each in its own transaction (row replied + answer queued, together)", async () => {
    const first = await harness({ bots: ["MAIN", GUEST] });
    open.push(first);
    first.engine.callInMode = "hold";
    first.runtime.callIns.attach(markerSender().sender);
    for (const id of ["call-4a", "call-4b"]) await first.send(ask(id), { origin: ORIGIN });
    for (let i = 0; i < 200 && first.engine.callIns.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rowsOf(first).map(([state]) => state)).toEqual(["started", "started"]);
    // The kill: a new runtime on the same database. call-4a's answer cannot be queued at all; call-4b's can.
    const s = markerSender({ failFor: (id) => id === "call-4a" });
    const second = await first.restart({ bots: ["MAIN", GUEST] });
    open.push(second);
    second.runtime.callIns.attach(s.sender);
    await second.settle();
    expect(second.engine.callIns).toHaveLength(0); // never run again
    expect(queued(second)).toEqual([["queued:call-4b", { kind: "failed", why: "its machine restarted during the answer" }]]);
    expect(rowsOf(second)).toEqual([["interrupted", true], ["interrupted", true]]);
    expect(s.done.map((reply) => reply.callId)).toEqual(["call-4b"]);
    // Another restart adds nothing.
    const third = await second.restart({ bots: ["MAIN", GUEST] });
    open.push(third);
    const again = markerSender();
    third.runtime.callIns.attach(again.sender);
    await third.settle();
    expect(again.done).toEqual([]);
  });
});

describe("fu-callin-outbox: an interrupted call-in is not answered before its host's server is known", () => {
  it("7. attached while the peer directory knows no peer: nothing is sent, nothing is marked answered; once the peer is known it is answered once", async () => {
    const first = await harness({ bots: ["MAIN", GUEST] });
    open.push(first);
    first.engine.callInMode = "hold";
    first.runtime.callIns.attach(markerSender().sender);
    await first.send(ask("call-7"), { origin: ORIGIN });
    for (let i = 0; i < 200 && first.engine.callIns.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rowsOf(first)).toEqual([["started", false]]);
    // The kill and the restart: the server attaches the guest while `peers.start()` has not run (the directory knows no peer).
    const second = await first.restart({ bots: ["MAIN", GUEST] });
    open.push(second);
    let known = false;
    const s = markerSender();
    let calls = 0;
    const sender: CallInGuestSender = { ...s.sender, ownerOf: (target) => (known && target === HOST_TARGET ? ORIGIN : null), submitIn: (...args) => { calls += 1; return s.sender.submitIn(...args); } };
    second.runtime.callIns.attach(sender);
    await second.settle();
    expect(calls).toBe(0);
    expect(s.done).toEqual([]);
    expect(queued(second)).toEqual([]);
    expect(rowsOf(second)).toEqual([["interrupted", false]]); // not marked answered: nothing lost
    expect(second.logs.filter((line) => /wait for their host's server/.test(line))).toHaveLength(1);
    // The peers come up (the roster changed): the one failed answer goes out, in one transaction with the mark.
    known = true;
    second.runtime.callIns.retry();
    await second.settle();
    expect(calls).toBe(1);
    expect(queued(second)).toEqual([["queued:call-7", { kind: "failed", why: "its machine restarted during the answer" }]]);
    expect(rowsOf(second)).toEqual([["interrupted", true]]);
    expect(s.done.map((reply) => reply.callId)).toEqual(["call-7"]);
    // A second poke (another roster change) answers nothing again.
    second.runtime.callIns.retry();
    await second.settle();
    expect(s.done).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("fu-callin-outbox: the crash hook is a fake-agent test knob", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const file = () => join(tempDir("callin-crash"), "crash.txt");

  it("5. off unless BOTLING_AGENT=fake; a malformed value throws; unknown points (constructor, __proto__) are refused", () => {
    const where = file();
    expect(callInCrash({})).toBeNull();
    expect(callInCrash({ BOTLING_SERVER_CALLIN_CRASH: `guest=${where}` })).toBeNull();
    expect(callInCrash({ BOTLING_AGENT: "claude", BOTLING_SERVER_CALLIN_CRASH: `guest=${where}` })).toBeNull();
    for (const bad of ["guest", "=x", "guest=", "other=x", "constructor=x", "__proto__=x", "toString=x"]) {
      expect(() => callInCrash({ BOTLING_AGENT: "fake", BOTLING_SERVER_CALLIN_CRASH: bad }), bad).toThrow(/point=file/);
    }
  });

  it("6. fires only while its file holds `armed` and only for its own point; it writes the hit first, so a restart does not die again", () => {
    const where = file();
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const crash = callInCrash({ BOTLING_AGENT: "fake", BOTLING_SERVER_CALLIN_CRASH: `guest=${where}` })!;
    crash("guest", "c1"); // no file: nothing
    crash("host", "c1"); // not its point
    writeFileSync(where, "armed");
    crash("host", "c2");
    expect(kill).not.toHaveBeenCalled();
    crash("guest", "c3");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
    expect(readFileSync(where, "utf8")).toBe("hit:c3");
    crash("guest", "c4"); // already hit: disarmed
    expect(kill).toHaveBeenCalledTimes(1);
    rmSync(where, { force: true });
  });
});
