// M7-S58: tests for the restart flags (`restartPending`, `modelSettingsPending`, `folderPending`, `restartNonModel`,
// `settingsGeneration`, `restartReason`, `restartForPluginsOnly`, `restarting`), the state `BotRestart` owns:
//   - `ensureHead` clears the five "waiting" flags (a restart is not asked for twice)                 [S51 review, mutation M4]
//   - `adoptRestart` marks the continuation and every queued turn `retried`: a failed resume of a restarted
//     session never silently becomes a new session                                                   [S51 review, mutation M5]
// Driven through a real `Bot` with fake heads (no process, no window), through the names that stay on `Bot`
// after the split (bot-private-names.test.ts), so this file must pass on every card of the lane. It never writes a flag:
// the flags are set the way the app sets them (`restartFor`, `reloadPlugins`) so it needs no setter on `Bot`.
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
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0;
  vi.restoreAllMocks();
});

/** A Bot (engine claude) on fake heads, asleep. */
function rig() {
  const folder = tempDir("bot-restart-flags"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "m", heads: { engines: ["claude"], answerWith: "claude" } }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit(event) { events.push(event); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  return { b, peek: b as any, events };
}

const REASON = { told: "its settings changed", shown: "new settings" };
/** The five flags `ensureHead` clears. */
const WAITING = ["restartPending", "restartNonModel", "modelSettingsPending", "folderPending", "restartForPluginsOnly"] as const;
const waiting = (peek: any) => Object.fromEntries(WAITING.map((name) => [name, peek[name]]));
const NONE = { restartPending: false, restartNonModel: false, modelSettingsPending: false, folderPending: false, restartForPluginsOnly: false };

/** Awake: a head running. */
function awake(peek: any) {
  peek.ensureHead();
  const head = fixture.heads[0];
  expect(head.running).toBe(true);
  return head;
}

describe("ensureHead: a head's start takes the restart that waited (S51 review, M4)", () => {
  it("a model change with a new folder, then a restart for something else: all of those flags are cleared by the next start", () => {
    const { peek } = rig();
    const head = awake(peek);
    peek.restartFor(REASON, true, true);
    peek.restartFor(REASON);
    expect(waiting(peek)).toEqual({ restartPending: true, restartNonModel: true, modelSettingsPending: true, folderPending: true, restartForPluginsOnly: false });
    head.finish();
    // Nothing restarts an asleep bot's flags by itself: they stay until the head starts.
    expect(waiting(peek)).toMatchObject({ restartPending: true, modelSettingsPending: true, folderPending: true, restartNonModel: true });
    peek.ensureHead();
    expect(waiting(peek)).toEqual(NONE);
    expect(fixture.heads).toHaveLength(2);
  });

  it("plugins changed while awake (only-plugins restart): the next start clears restartForPluginsOnly with the rest", () => {
    const { peek } = rig();
    const head = awake(peek);
    peek.reloadPlugins();
    expect(waiting(peek)).toEqual({ ...NONE, restartPending: true, restartNonModel: true, restartForPluginsOnly: true });
    head.finish();
    expect(peek.restartForPluginsOnly).toBe(true);
    peek.ensureHead();
    expect(waiting(peek)).toEqual(NONE);
  });

  it("a head that is still running keeps what waits (the start is not asked for twice)", () => {
    const { peek } = rig();
    awake(peek);
    peek.restartFor(REASON, true);
    peek.ensureHead();
    expect(peek.restartPending).toBe(true);
    expect(peek.modelSettingsPending).toBe(true);
    expect(fixture.heads).toHaveLength(1);
  });
});

describe("adoptRestart: a failed resume never becomes a new session (S51 review, M5)", () => {
  const queued = (words: string, origin: string) => ({ words, userId: undefined, origin, turnId: randomUUID(), messageId: randomUUID(), handoffId: null, conducted: false });
  const entry = (over: object = {}) => ({ botId: "main", engine: "claude", sessionId: randomUUID(), sessionStarted: true, continue: true, queued: [], restartedAt: Date.now(), ...over });

  it("the continuation turn and every turn that waited are queued marked retried, in order, and the bot is asked to go on", () => {
    const { peek } = rig();
    const next = vi.spyOn(peek, "next").mockImplementation(() => {});
    peek.adoptRestart(entry({ queued: [queued("first waiting", "user"), queued("second waiting", "app")] }) as any);
    const turns = peek.queue as any[];
    expect(turns.map((turn) => turn.retried)).toEqual([true, true, true]);
    expect(turns[0].words).toContain("explicitly approved restarting");
    expect(turns.slice(1).map((turn) => turn.words)).toEqual(["first waiting", "second waiting"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("without a continuation only the turns that waited are queued, and they are marked retried too", () => {
    const { peek } = rig();
    vi.spyOn(peek, "next").mockImplementation(() => {});
    peek.adoptRestart(entry({ continue: false, queued: [queued("only waiting", "background")] }) as any);
    expect((peek.queue as any[]).map((turn) => [turn.words, turn.retried])).toEqual([["only waiting", true]]);
  });

  it("the identity of the session is kept: the same id, started, no briefing, and the head is not asked for a new one", () => {
    const { peek } = rig();
    vi.spyOn(peek, "next").mockImplementation(() => {});
    const e = entry();
    peek.adoptRestart(e as any);
    expect(peek.session).toMatchObject({ sessionId: e.sessionId, started: true });
    expect(peek.briefing).toBe(false);
    expect(peek.restartRecovery).toBe(true);
  });
});
