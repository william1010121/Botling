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
import { WARM_WINDOW_MS } from "../../src/core/network-resume";
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

function rig(engine: "claude" | "codex" = "claude") {
  const folder = tempDir("bot-cold-resume"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", agyModel: "m", heads: { engines: [engine], answerWith: engine, codexModel: "m" } }));
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: "acp", command: "/never-spawn" }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit() {}, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10, tidyTimeoutMs: 30 });
  bots.push(b);
  return { b, peek: b as any };
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
