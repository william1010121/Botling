// M7-S57: tests for the state `BotHead` owns (`head`, `session`, `briefing`, `tidying`) and for every place that writes it,
// written BEFORE the foreign writes were turned into named transitions (so they pass on the base too, and must keep passing):
//   - the S53 review probes (HeadEvents keeps no field; `onExit` writes every reset through; a stale head only drains; `afterTurn`),
//     which found that a swap of `drained` and the stale-head guard, a dropped `settleTurnApprovals` and a `paused` reset that did
//     nothing all survived the old suite (.bot/artifacts/v3-split/M7-S53.md section 7);
//   - the writes of `session`: `becomeEngine`, `newSession`, `networkRestored`, `ensureHead` (fresh session when the prompt changed),
//     `onItem` (the first `init` marks it started and may rename it) and the constructor (a saved Antigravity conversation);
//   - the writes of `briefing`: `deliver` (given once), `onExit` (restart recovery), `handOver` (after the new head starts);
//   - the writes of `tidying` (`sleep`, `maintenance`) and of `head` (set after the head starts, cleared first in `onExit`).
// Driven through a real `Bot` with fake heads (no process, no window), through its private names, which stay on `Bot`.
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
import { HeadEvents } from "../../src/core/bot/head-events";
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

type Engine = "claude" | "codex" | "agy";
const EXIT = { code: 0, signal: null, stderr: "", expected: true, silent: false };

/** A Bot (first engine of `engines`) on fake heads; `settings` is merged into its bot.json. */
function rig(engines: Engine[] = ["claude"], settings: Record<string, unknown> = {}) {
  const folder = tempDir("bot-head-transitions"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: engines[0], model: "m", agyModel: "m", heads: { engines, answerWith: engines[0], codexModel: "m" }, ...settings }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: "acp", command: "/never-spawn" }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit(event) { events.push(event); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10, tidyTimeoutMs: 30 });
  bots.push(b);
  return { b, peek: b as any, events };
}

describe("HeadEvents (the S53 probes)", () => {
  it("keeps no field of its own: only host and ctx", () => {
    const r = rig();
    expect(Object.keys(new HeadEvents(r.peek, r.peek.ctx)).sort()).toEqual(["ctx", "host"]);
  });

  it("onExit writes every reset through to the one copy on the bot", () => {
    const r = rig();
    const head = r.peek.ensureHead();
    r.peek.retryingConnection = true;
    r.peek.codexRetry = { x: 1 };
    r.peek.ignoreResults = 3;
    r.peek.paused = { conducted: true, handoffId: "h" };
    r.peek.contextSent.add("a");
    r.peek.steered.set("a", {});
    r.peek.managedPending = true;
    r.peek.onExit(head, EXIT);
    expect(r.peek.head).toBeNull();
    expect(r.peek.retryingConnection).toBe(false);
    expect(r.peek.codexRetry).toBeNull();
    expect(r.peek.ignoreResults).toBe(0);
    expect(r.peek.paused).toBeNull();
    expect(r.peek.managedPending).toBe(false);
    expect(r.peek.deferred).toBeNull();
    expect(r.peek.contextSent.size).toBe(0);
    expect(r.peek.steered.size).toBe(0);
  });

  it("onExit lets go of the head before it clears the idle timer, and drains first", () => {
    const r = rig();
    const head = r.peek.ensureHead();
    const seen: string[] = [];
    vi.spyOn(r.peek, "drained").mockImplementation(() => { seen.push("drained"); });
    vi.spyOn(r.peek, "clearIdle").mockImplementation(() => { seen.push(r.peek.head === null ? "clearIdle:head gone" : "clearIdle:head still set"); });
    r.peek.onExit(head, EXIT);
    expect(seen).toEqual(["drained", "clearIdle:head gone"]);
  });

  it("a stale head only drains, and leaves everything else alone", () => {
    const r = rig();
    const head = r.peek.ensureHead();
    r.peek.paused = { conducted: true, handoffId: "h" };
    r.peek.ignoreResults = 3;
    const seen: string[] = [];
    vi.spyOn(r.peek, "drained").mockImplementation(() => { seen.push("drained"); });
    vi.spyOn(r.peek, "clearIdle").mockImplementation(() => { seen.push("clearIdle"); });
    r.peek.onExit({ pid: 0 }, EXIT);
    expect(seen).toEqual(["drained"]);
    expect(r.peek.head).toBe(head);
    expect(r.peek.paused).not.toBeNull();
    expect(r.peek.ignoreResults).toBe(3);
  });

  it("afterTurn settles the turn's approvals, then redraws", () => {
    const r = rig();
    const seen: string[] = [];
    vi.spyOn(r.peek, "settleTurnApprovals").mockImplementation(() => { seen.push("settleTurnApprovals"); });
    vi.spyOn(r.peek, "updated").mockImplementation(() => { seen.push("updated"); });
    r.peek.headEvents.afterTurn();
    expect(seen).toEqual(["settleTurnApprovals", "updated"]);
  });
});

describe("head: set once it runs, cleared first when it exits", () => {
  it("ensureHead sets the head after it started and before the workers it hosts are synced", () => {
    const r = rig(["codex"]);
    let seen: unknown = "not called";
    vi.spyOn(r.peek, "syncWorkerOwners").mockImplementation(() => { seen = r.peek.head; });
    const head = r.peek.ensureHead();
    expect(head.running).toBe(true);
    expect(r.peek.head).toBe(head);
    expect(seen).toBe(head);
  });

  it("an expired head is cleared by onExit, and a running one is returned again, not replaced", () => {
    const r = rig();
    const head = r.peek.ensureHead();
    expect(r.peek.ensureHead()).toBe(head);
    expect(fixture.heads).toHaveLength(1);
    head.running = false;
    r.peek.onExit(head, EXIT);
    expect(r.peek.head).toBeNull();
    expect(r.peek.ensureHead()).not.toBe(head);
  });
});

describe("session: every write", () => {
  const uuid = () => randomUUID();

  it("a new bot is a new session that has not started and needs the wake briefing", () => {
    const r = rig();
    expect(r.peek.session).toMatchObject({ started: false });
    expect(r.peek.session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.peek.briefing).toBe(true);
  });

  it("the constructor resumes the Antigravity conversation it saved, with no briefing", () => {
    const saved = uuid();
    const r = rig(["agy"], { agyConversation: saved });
    expect(r.peek.session).toEqual({ sessionId: saved, started: true });
    expect(r.peek.briefing).toBe(false);
    const other = rig(["agy"], { agyConversation: "not-a-uuid" });
    expect(other.peek.session.started).toBe(false);
    expect(other.peek.briefing).toBe(true);
  });

  it("newSession: a new id, not started, briefing again, and what the old one was told is forgotten", () => {
    const r = rig();
    const before = r.peek.session.sessionId;
    r.peek.session = { sessionId: before, started: true, promptHash: "h" };
    r.peek.briefing = false;
    r.peek.queuedNote = "note";
    r.peek.freshSessionPending = true;
    r.peek.reactionsSeen = {};
    r.peek.briefedComponents = {};
    r.b.newSession();
    expect(r.peek.session.sessionId).not.toBe(before);
    expect(r.peek.session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.peek.session.started).toBe(false);
    expect(r.peek.session.promptHash).toBeUndefined();
    expect(r.peek.briefing).toBe(true);
    expect(r.peek.queuedNote).toBeNull();
    expect(r.peek.freshSessionPending).toBe(false);
    expect(r.peek.reactionsSeen).toBeNull();
    expect(r.peek.briefedComponents).toBeNull();
  });

  it("becomeEngine: Antigravity's saved conversation is resumed as it is, anything else is a new session; both are saved", () => {
    const r = rig(["claude", "agy"]);
    const saved = uuid();
    const save = vi.spyOn(r.peek.store, "saveHead");
    r.peek.store.saveSetting("agyConversation", saved);
    r.peek.becomeEngine("agy");
    expect(r.peek.engine).toBe("agy");
    expect(r.peek.session).toEqual({ sessionId: saved, started: true });
    expect(r.peek.briefing).toBe(false);
    expect(save).toHaveBeenLastCalledWith(r.peek.session);
    // On to Claude: its session is new, whatever Antigravity had.
    r.peek.becomeEngine("claude");
    expect(r.peek.session.sessionId).not.toBe(saved);
    expect(r.peek.session.started).toBe(false);
    expect(r.peek.briefing).toBe(true);
    expect(save).toHaveBeenLastCalledWith(r.peek.session);
    // An agy with no saved conversation (or one that is not an id) is new too.
    r.peek.store.saveSetting("agyConversation", "not-a-uuid");
    r.peek.becomeEngine("agy");
    expect(r.peek.session.started).toBe(false);
    expect(r.peek.briefing).toBe(true);
  });

  it("networkRestored: within the warm window and with no head, the lost session goes on as it was, no briefing", () => {
    const r = rig();
    const lost = uuid();
    const deliver = vi.spyOn(r.peek, "deliverTo").mockReturnValue({} as any);
    const save = vi.spyOn(r.peek.store, "saveHead");
    const now = Date.now();
    r.peek.progress.outage = { since: now - 1_000, subagents: [], turnFailed: false, lostSession: lost };
    r.peek.networkRestored(now);
    expect(r.peek.outage).toBeNull();
    expect(r.peek.session).toEqual({ sessionId: lost, started: true });
    expect(r.peek.briefing).toBe(false);
    expect(save).toHaveBeenLastCalledWith(r.peek.session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![3]).toMatchObject({ origin: "app" });
  });

  it("networkRestored: after the warm window, or with a head running, the session is left alone", () => {
    const r = rig();
    const before = { ...r.peek.session }, lost = uuid();
    vi.spyOn(r.peek, "deliverTo").mockReturnValue({} as any);
    const now = Date.now();
    r.peek.progress.outage = { since: now - WARM_WINDOW_MS - 60_000, subagents: [], turnFailed: false, lostSession: lost };
    r.peek.networkRestored(now);
    expect(r.peek.session).toEqual(before);
    expect(r.peek.briefing).toBe(true);
    r.peek.ensureHead();
    const running = { ...r.peek.session };
    r.peek.progress.outage = { since: now - 1_000, subagents: [], turnFailed: false, lostSession: lost };
    r.peek.networkRestored(now);
    expect(r.peek.session).toEqual(running);
  });

  it("ensureHead: a changed prompt starts a new session (said, and flagged), the same prompt resumes the one it has", () => {
    const stale = rig();
    const old = uuid();
    stale.peek.session = { sessionId: old, started: true, promptHash: "an older prompt" };
    stale.peek.briefing = false;
    stale.peek.ensureHead();
    expect(stale.peek.session.sessionId).not.toBe(old);
    expect(stale.peek.startedFresh).toBe(true);
    expect(stale.peek.session.promptHash).toBe(stale.peek.promptHash());
    expect(stale.peek.records.some((m: any) => m.role === "divider")).toBe(true);

    const same = rig();
    same.peek.session = { sessionId: old, started: true, promptHash: same.peek.promptHash() };
    same.peek.briefing = false;
    same.peek.ensureHead();
    expect(same.peek.session).toMatchObject({ sessionId: old, started: true });
    expect(same.peek.startedFresh).toBe(false);
    expect(fixture.heads.at(-1).config.resume).toBe(true);

    const adopted = rig();
    adopted.peek.session = { sessionId: old, started: true, promptHash: "an older prompt" };
    adopted.peek.briefing = false;
    adopted.peek.adoptedSession = true;
    adopted.peek.ensureHead();
    expect(adopted.peek.session.sessionId).toBe(old);
    expect(adopted.peek.adoptedSession).toBe(false);
  });

  it("ensureHead: a session that never started takes the prompt's hash for the next resume", () => {
    const r = rig();
    expect(r.peek.session.promptHash).toBeUndefined();
    r.peek.ensureHead();
    expect(r.peek.session.promptHash).toBe(r.peek.promptHash());
  });

  it("onItem init: the first one marks the session started and saved; a valid new id renames it; a bad id does not", () => {
    const r = rig();
    const head = r.peek.ensureHead();
    const save = vi.spyOn(r.peek.store, "saveHead");
    r.peek.session = { sessionId: "11111111-1111-1111-1111-111111111111", started: false };
    r.peek.onItem(head, { kind: "init", sessionId: "not an id" });
    expect(r.peek.session).toEqual({ sessionId: "11111111-1111-1111-1111-111111111111", started: true });
    expect(save).toHaveBeenCalledTimes(1);
    // Already started and the same id: nothing to save.
    r.peek.onItem(head, { kind: "init", sessionId: "11111111-1111-1111-1111-111111111111" });
    expect(save).toHaveBeenCalledTimes(1);
    const renamed = uuid();
    r.peek.onItem(head, { kind: "init", sessionId: renamed });
    expect(r.peek.session).toEqual({ sessionId: renamed, started: true });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(r.peek.session);
  });

  it("onItem init on Antigravity also keeps the conversation id for the next start", () => {
    const r = rig(["agy"]);
    const head = r.peek.ensureHead();
    const id = uuid();
    r.peek.onItem(head, { kind: "init", sessionId: id });
    expect(r.peek.session).toMatchObject({ sessionId: id, started: true });
    expect(r.peek.store.loadSettings().agyConversation).toBe(id);
  });
});

describe("briefing: every write", () => {
  it("deliver gives the wake briefing once: the first message of a session carries it, the next does not", async () => {
    const r = rig();
    expect(r.peek.briefing).toBe(true);
    r.b.send("first");
    await waitFor("the first message to reach the head", () => fixture.heads[0]?.sent.length === 1);
    expect(r.peek.briefing).toBe(false);
    // The head going to sleep is a wake next time: a new session with its briefing.
    await flush();
    const head = fixture.heads[0];
    r.peek.finishTurn(r.peek.turn, "done");
    await r.b.sleep({ tidyMs: 0 });
    expect(head.running).toBe(false);
    expect(r.peek.briefing).toBe(true);
    expect(r.peek.session.started).toBe(false);
    r.b.send("second");
    await waitFor("the second message to reach a new head", () => fixture.heads[1]?.sent.length === 1);
    expect(r.peek.briefing).toBe(false);
  });

  it("onExit after a restart (or on Antigravity) keeps the session, and needs the briefing only if it never started", () => {
    const r = rig();
    for (const started of [true, false]) {
      const head = r.peek.ensureHead();
      r.peek.restartRecovery = true;
      r.peek.session = { sessionId: randomUUID(), started };
      r.peek.briefing = started;
      const id = r.peek.session.sessionId;
      r.peek.onExit(head, EXIT);
      expect(r.peek.briefing).toBe(!started);
      expect(r.peek.session.sessionId).toBe(id);
    }
  });

  it("handOver: after the new engine's head starts in its new session, the briefing is given by the handover itself", async () => {
    const r = rig(["claude", "codex"]);
    const old = r.peek.ensureHead();
    r.peek.switchTo = "codex";
    await r.peek.handOver();
    expect(r.peek.engine).toBe("codex");
    expect(r.peek.switchTo).toBeNull();
    expect(r.peek.head).not.toBe(old);
    expect(r.peek.head?.running).toBe(true);
    expect(r.peek.briefing).toBe(false);
    expect(r.peek.switching).toBe(false);
  });
});

describe("tidying: set while it tidies, put back after", () => {
  it("sleep: tidying from the start of the tidy until the head has ended", async () => {
    const r = rig();
    const head = r.peek.ensureHead();
    expect(r.peek.tidying).toBe(false);
    const done = r.b.sleep({ tidyMs: 20 });
    expect(r.peek.tidying).toBe(true);
    // Not asleep a second time while it tidies.
    await r.b.sleep({ tidyMs: 20 });
    expect(head.running).toBe(true);
    await done;
    expect(r.peek.tidying).toBe(false);
    expect(head.running).toBe(false);
    expect(r.peek.head).toBeNull();
  });

  it("sleep with no time to tidy still ends the head and leaves tidying off", async () => {
    const r = rig();
    const head = r.peek.ensureHead();
    await r.b.sleep({ tidyMs: 0 });
    expect(r.peek.tidying).toBe(false);
    expect(head.running).toBe(false);
  });

  it("maintenance: tidying is on while it runs and goes back to what it was (on or off)", async () => {
    const r = rig();
    const head = r.peek.ensureHead();
    const during: boolean[] = [];
    vi.spyOn(r.peek.headRun, "internal").mockImplementation(async () => { during.push(r.peek.tidying); return "OK"; });
    r.peek.tidying = false;
    expect(await r.b.maintenance("tidy", 50, head)).toBe("OK");
    expect(r.peek.tidying).toBe(false);
    r.peek.tidying = true;
    expect(await r.b.maintenance("tidy", 50, head)).toBe("OK");
    expect(r.peek.tidying).toBe(true);
    expect(during).toEqual([true, true]);
  });

  it("maintenance puts tidying back even when the turn throws", async () => {
    const r = rig();
    const head = r.peek.ensureHead();
    vi.spyOn(r.peek.headRun, "internal").mockImplementation(() => { throw new Error("no turn"); });
    r.peek.tidying = false;
    await expect(r.b.maintenance("tidy", 50, head)).rejects.toThrow("no turn");
    expect(r.peek.tidying).toBe(false);
  });
});
