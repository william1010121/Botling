// A claude head is never --resumed for a new turn when its prompt cache is cold (last model call older than WARM_WINDOW_MS).
// Seen 2026-11-17: eeg was woken by a routine after 5.5 h asleep and resumed its old session (243,988 tokens written, 0 read),
// because a core restart had left `restartRecovery` on for good and the sleep exit took its "keep the session" branch.
// Driven through a real `Bot` with fake heads (the rig of bot-head-transitions.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = [];
    sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    steer(_text: string) { return true; }
    offerInsert() { return false; }
    withdrawInsert() { return true; }
    interrupt() {}
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { heads, Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/codex", async (original) => ({ ...await original<any>(), CodexHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/agy-acp", () => ({ verifyAcpRuntime() {}, AgyAcpHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { CACHE_TTL_MS, WARM_WINDOW_MS } from "../../src/core/network-resume";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0;
  vi.restoreAllMocks();
});

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}

function rig(engine: "claude" | "codex" = "claude", sameFolder?: string) {
  const folder = sameFolder ?? tempDir("bot-cold-resume"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", agyModel: "m", heads: { engines: [engine], answerWith: engine, codexModel: "m" } }));
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: "acp", command: "/never-spawn" }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit() {}, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10, tidyTimeoutMs: 30 });
  bots.push(b);
  return { b, peek: b as any, folder };
}

/** One answered message, so the session has started (claude wrote it) and its first line has gone. */
async function answered(r: ReturnType<typeof rig>, words = "first") {
  r.b.send(words);
  await waitFor("the message to reach the head", () => fixture.heads.at(-1)?.sent.length === 1);
  await flush();
  r.peek.finishTurn(r.peek.turn, "done");
}

describe("the sleep after a restart's recovery", () => {
  it("a claude head that went to sleep wakes in a NEW session even when a restart's recovery was on", async () => {
    const r = rig();
    await answered(r);
    const first = r.peek.session.sessionId;
    // What `retainRestartIdentity` leaves behind after a core restart, for as long as the bot object lives.
    r.peek.restarts.recoveryStarted();
    r.peek.headRun.lastModelAt = Date.now() - 60_000;
    await r.b.sleep({ tidyMs: 0 });
    expect(r.peek.session.started).toBe(false);
    expect(r.peek.briefing).toBe(true);
    expect(r.peek.headRun.lastModelAt).toBeNull();
    r.b.send("woken by a routine");
    await waitFor("the wake message", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(false);
    expect(fixture.heads[1].config.sessionId).not.toBe(first);
  });

  it("the recovery is over once the claude session is replaced: a crash later keeps no stale identity", async () => {
    const r = rig();
    await answered(r);
    r.peek.restarts.recoveryStarted();
    await r.b.sleep({ tidyMs: 0 });
    expect(r.peek.restartRecovery).toBe(false);
  });

  it("a head lost to a crash during the recovery still keeps its session (the recovery's own rule)", async () => {
    const r = rig();
    await answered(r);
    const id = r.peek.session.sessionId;
    r.peek.restarts.recoveryStarted();
    const head = fixture.heads[0];
    head.running = false;
    r.peek.onExit(head, { code: 1, signal: null, stderr: "boom", expected: false, silent: false });
    expect(r.peek.session).toMatchObject({ sessionId: id, started: true });
    expect(r.peek.briefing).toBe(false);
  });

  it("Codex keeps its thread through a sleep after a restart's recovery (unchanged)", async () => {
    const r = rig("codex");
    r.peek.ensureHead();
    r.peek.session = { sessionId: randomUUID(), started: true };
    r.peek.briefing = false;
    r.peek.restarts.recoveryStarted();
    const id = r.peek.session.sessionId;
    r.peek.onExit(fixture.heads[0], { code: 0, signal: null, stderr: "", expected: true, silent: false });
    expect(r.peek.session).toMatchObject({ sessionId: id, started: true });
    expect(r.peek.briefing).toBe(false);
  });
});

describe("a cold cache is never resumed (ensureHead)", () => {
  /** A claude bot with a started session and no head, as a restart for a setting leaves it, its last model call `agoMs` ago. */
  async function restarted(agoMs: number | null) {
    const r = rig();
    await answered(r);
    const head = fixture.heads[0];
    head.running = false;
    r.peek.headRun.detach();
    const id = r.peek.session.sessionId;
    r.peek.headRun.lastModelAt = agoMs === null ? null : Date.now() - agoMs;
    r.peek.briefing = false;
    return { r, id };
  }

  it("last model call older than the warm window: a new session, briefed again", async () => {
    const { r, id } = await restarted(WARM_WINDOW_MS + 60_000);
    r.b.send("after an hour");
    await waitFor("the message to reach a new head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(false);
    expect(fixture.heads[1].config.sessionId).not.toBe(id);
  });

  it("last model call inside the warm window: the same session is resumed", async () => {
    const { r, id } = await restarted(10 * 60_000);
    r.b.send("soon after");
    await waitFor("the message to reach the resumed head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(true);
    expect(fixture.heads[1].config.sessionId).toBe(id);
  });

  it("a handed-over session (a cut-off turn recovered after a restart) is resumed as it is, once", async () => {
    const { r, id } = await restarted(WARM_WINDOW_MS + 60_000);
    r.peek.headRun.adoptedAs(true);
    r.b.send("recovered turn");
    await waitFor("the message to reach the resumed head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(true);
    expect(fixture.heads[1].config.sessionId).toBe(id);
  });

  it("a cold head that a restart was waiting to end starts new once: one briefing, no \"Botling restarted you\" note on top", async () => {
    const r = rig();
    await answered(r);
    const id = r.peek.session.sessionId;
    expect(fixture.heads[0].running).toBe(true);
    r.peek.restartFor({ told: "model", shown: "M" });
    r.peek.headRun.lastModelAt = Date.now() - WARM_WINDOW_MS - 60_000;
    r.peek.briefing = false;
    r.b.send("after a long idle");
    await waitFor("the message to reach a new head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(false);
    expect(fixture.heads[1].config.sessionId).not.toBe(id);
    expect(fixture.heads[1].sent[0]).not.toContain("Botling restarted you");
    expect(r.peek.briefing).toBe(false);
  });

  it("no record of a model call (the object is new): nothing is forced", async () => {
    const { r, id } = await restarted(null);
    r.b.send("unknown age");
    await waitFor("the message to reach the resumed head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[1].config.resume).toBe(true);
    expect(fixture.heads[1].config.sessionId).toBe(id);
  });
});

describe("what counts as a model call", () => {
  const counts: [string, any, boolean][] = [
    ["delta", { kind: "delta", text: "h" }, true],
    ["assistantText", { kind: "assistantText", text: "hello" }, true],
    ["usage", { kind: "usage", totalCost: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, true],
    ["result", { kind: "result", ok: true, text: "", error: "", subtype: "success" }, true],
    ["the coordinator's own toolUse", { kind: "toolUse", id: "t1", tool: "Bash", title: "x", detail: "x", parent: null, input: {} }, true],
    ["a subagent's toolUse", { kind: "toolUse", id: "t2", tool: "Bash", title: "x", detail: "x", parent: "sub", input: {} }, false],
    ["a subagent's text", { kind: "subagentText", parent: "x", text: "worker talking" }, false],
    ["an init", { kind: "init", sessionId: "s" }, false],
  ];
  for (const [name, item, counted] of counts) {
    it(`${name}: ${counted ? "counts" : "does not count"}`, async () => {
      const r = rig();
      r.peek.ensureHead();
      const head = fixture.heads[0];
      await flush();
      r.peek.headRun.lastModelAt = null;
      const before = Date.now();
      // What the item does after it is noted is not this test's business; only the stamp is.
      try { r.peek.onItem(head, item); } catch { /* ignored */ }
      if (counted) expect(r.peek.headRun.lastModelAt).toBeGreaterThanOrEqual(before);
      else expect(r.peek.headRun.lastModelAt).toBeNull();
    });
  }

  it("Codex never records one (its cache is not this rule's)", async () => {
    const r = rig("codex");
    r.peek.ensureHead();
    await flush();
    try { r.peek.onItem(fixture.heads[0], { kind: "assistantText", text: "hello" }); } catch { /* ignored */ }
    expect(r.peek.headRun.lastModelAt).toBeNull();
  });
});

// Item 1 of the invariant review (a Claude session is never reused once its prompt cache is past its TTL): the check sits where a new
// turn is sent, so a head that is still running, a handed-over session and a restarted core all meet it. Fake clock: only Date.
describe("a cold cache is never reused, on every path a new turn takes", () => {
  const MIN = 60_000;
  const at = (minutes: number) => vi.setSystemTime(new Date(T0 + minutes * MIN));
  const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
  afterEach(() => { vi.useRealTimers(); });
  const clock = () => { vi.useFakeTimers({ toFake: ["Date"] }); at(0); };

  it("a head that is still running (a long idle timer): the next message starts a new session once idle > TTL", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    const id = r.peek.session.sessionId;
    expect(fixture.heads[0].running).toBe(true);
    at(CACHE_TTL_MS / MIN + 1);
    r.b.send("after a long idle");
    await waitFor("the message to reach a new head", () => fixture.heads[1]?.sent.length === 1);
    expect(fixture.heads[0].running).toBe(false);
    expect(fixture.heads[1].config.resume).toBe(false);
    expect(fixture.heads[1].config.sessionId).not.toBe(id);
    expect(fixture.heads[1].sent[0]).toContain("after a long idle");
  });

  it("the same running head inside the warm window keeps serving: the one process, the one session", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    at(10);
    r.b.send("soon after");
    await waitFor("the message to reach the same head", () => fixture.heads[0].sent.length === 2);
    expect(fixture.heads.length).toBe(1);
  });

  it("a running head with its own work under way (a subagent) is not cut off: its work goes on, the session stays", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    r.peek.managedPending = true;
    at(CACHE_TTL_MS / MIN + 1);
    r.b.send("while it works");
    await waitFor("the message to reach the same head", () => fixture.heads[0].sent.length === 2);
    expect(fixture.heads.length).toBe(1);
    expect(fixture.heads[0].running).toBe(true);
  });

  it("a tidy turn is never the one that ends a cold head (the tidy is what the sleep runs)", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    at(CACHE_TTL_MS / MIN + 1);
    const tidy = r.peek.newTurn("tidy", "tidy", null);
    r.peek.begin(tidy, r.peek.head);
    await waitFor("the tidy to reach the same head", () => fixture.heads[0].sent.length === 2);
    expect(fixture.heads.length).toBe(1);
  });

  it("the last model call is kept in head.json, so a restarted core knows how old it is", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    expect(r.peek.store.loadHead()).toMatchObject({ sessionId: r.peek.session.sessionId, lastModelAt: T0 });
    at(10);
    r.peek.headRun.modelCalled();
    expect(r.peek.store.loadHead()?.lastModelAt).toBe(T0 + 10 * MIN);
  });

  /** A new core takes over the session the old one left in head.json (the restart's handover). */
  async function handedOver(idleMin: number, how: "restart" | "swap") {
    const old = rig();
    await answered(old);
    old.peek.headRun.modelCalled();
    const id = old.peek.session.sessionId;
    old.peek.store.saveHead(old.peek.session);
    // The old core is left as it is (its heads count no more); the new one reads what it wrote.
    fixture.heads.length = 0;
    at(idleMin);
    const next = rig("claude", old.folder);
    if (how === "restart") next.peek.retainRestartIdentity({ engine: "claude", sessionId: id, sessionStarted: true, continue: true, queued: [] });
    else next.peek.adoptSwap([{ botId: "x", engine: "claude", sessionId: id, continue: false, queued: [] }]);
    return { next, id };
  }
  for (const how of ["restart", "swap"] as const) {
    it(`handed over by a core ${how}, idle > TTL: a new session, not the old one`, async () => {
      clock();
      const { next, id } = await handedOver(CACHE_TTL_MS / MIN + 1, how);
      next.b.send("after the handover");
      await waitFor("the message to reach a new head", () => fixture.heads[0]?.sent.length === 1);
      expect(fixture.heads[0].config.resume).toBe(false);
      expect(fixture.heads[0].config.sessionId).not.toBe(id);
    });
  }

  it("the one exception, kept narrow: in-flight work handed over inside the TTL (past the warm window) still resumes", async () => {
    clock();
    const { next, id } = await handedOver(WARM_WINDOW_MS / MIN + 5, "restart");
    next.b.send("the cut-off turn goes on");
    await waitFor("the message to reach the resumed head", () => fixture.heads[0]?.sent.length === 1);
    expect(fixture.heads[0].config.resume).toBe(true);
    expect(fixture.heads[0].config.sessionId).toBe(id);
  });

  /** A cold claude head still running, and a user turn handed straight to `begin` (what `send` ends in), so no gate of `send` is in the way. */
  async function coldRunning() {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    at(CACHE_TTL_MS / MIN + 1);
    const turn = r.peek.newTurn("user", "a cold one", null);
    return { r, turn };
  }

  it("while the bot shuts down, a cold running head is left alone (no new head starts)", async () => {
    const { r, turn } = await coldRunning();
    r.peek.shuttingDown = true;
    r.peek.begin(turn);
    await waitFor("the turn to reach the same head", () => fixture.heads[0].sent.length === 2);
    expect(fixture.heads.length).toBe(1);
    expect(fixture.heads[0].running).toBe(true);
  });

  it("while it tidies, a cold running head serves a turn that is not a tidy one (kept: tidying is set by the sleep, not by the turn's origin)", async () => {
    const { r, turn } = await coldRunning();
    r.peek.headRun.tidyStart();
    r.peek.begin(turn);
    await waitFor("the turn to reach the same head", () => fixture.heads[0].sent.length === 2);
    expect(fixture.heads.length).toBe(1);
    expect(fixture.heads[0].running).toBe(true);
  });

  it("a turn whose head is the cold head ends it without failing: the new session's head is the turn's head, and it was sent", async () => {
    const { r, turn } = await coldRunning();
    const cold = fixture.heads[0];
    // The cold head is the turn's head and is handed in as `given`; its exit is slow (the turn must not read it as its own failure).
    turn.head = cold;
    let exitDone!: () => void;
    cold.exited = new Promise<void>((resolve) => { exitDone = resolve; });
    const finish = cold.finish.bind(cold);
    cold.finish = () => { finish(); setImmediate(() => setImmediate(exitDone)); };
    r.peek.begin(turn, cold);
    await waitFor("the turn to reach a new head", () => fixture.heads[1]?.sent.length === 1);
    expect(turn.open).toBe(true);
    expect(turn.head).toBe(fixture.heads[1]);
    expect(turn.sent).toBe(true);
    expect(cold.sent.length).toBe(1);
    expect(fixture.heads[1].config.resume).toBe(false);
  });

  it("the clock reaches head.json at most once a minute, and again after it (or when the clock goes back)", async () => {
    clock();
    const r = rig();
    await answered(r);
    const save = vi.spyOn(r.peek.store, "saveHead");
    r.peek.headRun.modelCalled();
    at(0.1); r.peek.headRun.modelCalled();
    at(0.9); r.peek.headRun.modelCalled();
    expect(save).toHaveBeenCalledTimes(1);
    at(1); r.peek.headRun.modelCalled();
    expect(save).toHaveBeenCalledTimes(2);
    at(1.5); r.peek.headRun.modelCalled();
    expect(save).toHaveBeenCalledTimes(2);
    at(0.5); r.peek.headRun.modelCalled();
    expect(save).toHaveBeenCalledTimes(3);
    expect(r.peek.store.loadHead()?.lastModelAt).toBe(T0 + 0.5 * MIN);
  });

  it("a session resumed after a lost network keeps its model clock", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    r.peek.headRun.sessionResumed("11111111-1111-4111-8111-111111111111");
    expect(r.peek.session).toMatchObject({ sessionId: "11111111-1111-4111-8111-111111111111", started: true });
    expect(r.peek.headRun.lastModelAt).toBe(T0);
  });

  it("a new session starts with no model clock, in memory and in head.json", async () => {
    clock();
    const r = rig();
    await answered(r);
    r.peek.headRun.modelCalled();
    expect(r.peek.store.loadHead()?.lastModelAt).toBe(T0);
    r.peek.newSession();
    expect(r.peek.headRun.lastModelAt).toBeNull();
    r.peek.store.saveHead(r.peek.session);
    expect(r.peek.store.loadHead()).not.toHaveProperty("lastModelAt");
  });

  describe("cacheCold", () => {
    async function old() {
      clock();
      const r = rig();
      await answered(r);
      r.peek.headRun.modelCalled();
      at(WARM_WINDOW_MS / MIN + 1);
      return r;
    }
    it("past the warm window of a started, briefed claude session: cold (and warm just inside it)", async () => {
      const r = await old();
      expect(r.peek.headRun.cacheCold()).toBe(true);
      at(WARM_WINDOW_MS / MIN - 1);
      expect(r.peek.headRun.cacheCold()).toBe(false);
    });
    it("while the next head is a new session's first (briefing due): not cold, it is new anyway", async () => {
      const r = await old();
      r.peek.briefing = true;
      expect(r.peek.headRun.cacheCold()).toBe(false);
    });
    it("a session claude has not written yet: not cold, there is nothing to resume", async () => {
      const r = await old();
      r.peek.session.started = false;
      expect(r.peek.headRun.cacheCold()).toBe(false);
    });
    it("handed over: warm until the real TTL, cold after it", async () => {
      const r = await old();
      expect(r.peek.headRun.cacheCold(true)).toBe(false);
      at(CACHE_TTL_MS / MIN + 1);
      expect(r.peek.headRun.cacheCold(true)).toBe(true);
    });
  });
});
