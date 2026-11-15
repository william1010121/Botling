// M7-S58: tests for the restart flags (`restartPending`, `modelSettingsPending`, `folderPending`, `restartNonModel`,
// `settingsGeneration`, `restartReason`, `restartForPluginsOnly`, `restarting`), the state `BotRestart` owns:
//   - `ensureHead` clears the five "waiting" flags (a restart is not asked for twice)                 [S51 review, mutation M4]
//   - the transitions the other writers use: `request` (restartFor), `consumed` (deliver starts the head again),
//     `dropPluginsOnly` (deliver, reloadPlugins), `switchedInPlace` (switchInPlace), `ended` (onExit)   [M7-S58 mutants]
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
  /** What a head's `applySettings` (the hot switch) does: `apply` answers, `gate` holds it until released. */
  const state = { apply: true, gate: null as null | Promise<void>, entered: 0 };
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
    async applySettings() { state.entered += 1; if (state.gate) await state.gate; return state.apply; }
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { heads, state, Head };
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
  fixture.state.apply = true; fixture.state.gate = null; fixture.state.entered = 0;
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0;
  vi.restoreAllMocks();
});

/** A Bot (engine claude) on fake heads, asleep. */
function rig(options: { pluginStamp?: () => string[] } = {}) {
  const folder = tempDir("bot-restart-flags"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "m", heads: { engines: ["claude"], answerWith: "claude" } }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit(event) { events.push(event); }, log() {}, ...options, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  return { b, peek: b as any, events };
}

async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}
const dividers = (peek: any): string[] => peek.records.filter((m: any) => m.role === "divider").map((m: any) => m.text);

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

describe("the other transitions (M7-S58)", () => {
  const ALL = ["restartPending", "restartNonModel", "modelSettingsPending", "folderPending", "restartForPluginsOnly"] as const;

  describe("request (restartFor)", () => {
    it("awake: a model change counts a generation and keeps its reason; another change is not about the model", () => {
      const { peek } = rig();
      awake(peek);
      expect(peek.settingsGeneration).toBe(0);
      peek.restartFor(REASON, true);
      expect(peek.settingsGeneration).toBe(1);
      expect(waiting(peek)).toEqual({ ...NONE, restartPending: true, modelSettingsPending: true });
      expect(peek.restartReason).toEqual(REASON);
      peek.restartFor(null);
      expect(peek.restartNonModel).toBe(true);
      expect(peek.settingsGeneration).toBe(1);
      expect(peek.restartReason).toEqual(REASON);
      peek.restartFor({ told: "b", shown: "c" }, false, true);
      expect(peek.folderPending).toBe(true);
      expect(peek.restartReason).toEqual({ told: "b", shown: "c" });
    });

    it("asleep: nothing waits, whatever waited for a plain restart; the model change stays for the wake", () => {
      const { peek } = rig();
      const head = awake(peek);
      peek.restartFor(REASON, true, true);
      peek.restartFor(REASON);
      head.finish();
      peek.restartFor(REASON, true, true);
      expect(waiting(peek)).toEqual({ ...NONE, modelSettingsPending: true });
    });

    it("every request ends an only-plugins restart: a later change back to the plugins' stamp does not drop it", () => {
      let stamp = ["a"];
      const { peek } = rig({ pluginStamp: () => stamp });
      awake(peek);
      stamp = ["b"];
      peek.reloadPlugins();
      expect(peek.restartForPluginsOnly).toBe(true);
      peek.restartFor(REASON, true);
      expect(peek.restartForPluginsOnly).toBe(false);
      stamp = ["a"];
      peek.reloadPlugins();
      expect(peek.restartPending).toBe(true);
      expect(peek.modelSettingsPending).toBe(true);
    });
  });

  describe("dropPluginsOnly (reloadPlugins, deliver)", () => {
    it("reloadPlugins: plugins that came back to the session's stamp drop the restart they asked for, with its reason", () => {
      let stamp = ["a"];
      const { peek } = rig({ pluginStamp: () => stamp });
      awake(peek);
      stamp = ["b"];
      peek.reloadPlugins();
      expect(waiting(peek)).toEqual({ ...NONE, restartPending: true, restartNonModel: true, restartForPluginsOnly: true });
      expect(peek.restartReason).toMatchObject({ shown: "loading new plugins" });
      stamp = ["a"];
      peek.reloadPlugins();
      expect(waiting(peek)).toEqual(NONE);
      expect(peek.restartReason).toBeNull();
    });

    it("deliver: the same, found when the next message comes; the head is not restarted", async () => {
      let stamp = ["a"];
      const { peek, b } = rig({ pluginStamp: () => stamp });
      awake(peek);
      stamp = ["b"];
      peek.reloadPlugins();
      stamp = ["a"];
      b.send("hello");
      await waitFor("the head to be sent the message", () => fixture.heads[0].sent.length === 1);
      expect(waiting(peek)).toEqual(NONE);
      expect(peek.restartReason).toBeNull();
      expect(fixture.heads).toHaveLength(1);
      expect(dividers(peek).some((text) => text.startsWith("Restarted"))).toBe(false);
    });
  });

  describe("consumed (deliver) and ended (onExit)", () => {
    it("the head ends for the restart that waited and starts again in the same session: reason shown once, nothing waits, `restarting` is let go", async () => {
      const { peek, b } = rig();
      const first = awake(peek);
      const session = { ...peek.session };
      peek.restartFor({ told: "may read /x", shown: "may read /x" }, false, true);
      expect(peek.folderPending).toBe(true);
      b.send("hello");
      await waitFor("the second head to be sent the message", () => fixture.heads[1]?.sent.length === 1);
      expect(first.running).toBe(false);
      expect(waiting(peek)).toEqual(NONE);
      expect(peek.restartReason).toBeNull();
      expect(peek.restarting).toBeNull();
      expect(dividers(peek).filter((text) => text === "Restarted → may read /x")).toHaveLength(1);
      // The same session goes on (the head's ending is `restarting`'s, so `onExit` does not make a new session for the next wake).
      expect(peek.session.sessionId).toBe(session.sessionId);
      expect(fixture.heads[1].config.sessionId).toBe(session.sessionId);
      expect(fixture.heads[1].sent[0]).toContain("Botling restarted you in this same conversation (may read /x)");
    });
  });

  describe("switchedInPlace (switchInPlace)", () => {
    it("a model change the head takes in place: no restart, a divider, and nothing waits", async () => {
      const { peek, b } = rig();
      awake(peek);
      peek.restartFor(REASON, true);
      b.send("hello");
      await waitFor("the head to be sent the message", () => fixture.heads[0].sent.length === 1);
      expect(fixture.heads).toHaveLength(1);
      expect(waiting(peek)).toEqual(NONE);
      expect(peek.restartReason).toBeNull();
      expect(dividers(peek)).toContain("Switched → new settings");
    });

    it("a restart that waits for something else too stays: only the model part is done, and the head restarts for the rest", async () => {
      const { peek, b } = rig();
      awake(peek);
      peek.restartFor(REASON, true);
      peek.restartFor({ told: "may read /y", shown: "may read /y" });
      b.send("hello");
      await waitFor("the second head to be sent the message", () => fixture.heads[1]?.sent.length === 1);
      // The latest reason is the one both dividers say.
      expect(dividers(peek)).toContain("Switched → may read /y");
      expect(dividers(peek)).toContain("Restarted → may read /y");
      expect(waiting(peek)).toEqual(NONE);
    });

    it("a head that cannot switch in place: the model change waits for the restart", async () => {
      fixture.state.apply = false;
      const { peek, b } = rig();
      awake(peek);
      peek.restartFor(REASON, true);
      b.send("hello");
      await waitFor("the second head to be sent the message", () => fixture.heads[1]?.sent.length === 1);
      expect(dividers(peek)).not.toContain("Switched → new settings");
      expect(dividers(peek)).toContain("Restarted → new settings");
    });

    it("changed again while it switched: the newer change still waits (nothing is cleared, no divider)", async () => {
      let open!: () => void;
      fixture.state.gate = new Promise<void>((resolve) => { open = resolve; });
      const { peek, b } = rig();
      awake(peek);
      peek.restartFor(REASON, true);
      b.send("hello");
      await waitFor("the hot switch to be under way", () => fixture.state.entered === 1);
      peek.restartFor({ told: "newer", shown: "newer" }, true);
      expect(peek.settingsGeneration).toBe(2);
      open();
      // The hot switch finished after the newer change: it is not applied for it, so the message goes on a restart.
      await waitFor("the second head to be sent the message", () => fixture.heads[1]?.sent.length === 1);
      expect(dividers(peek)).not.toContain("Switched → newer");
      expect(dividers(peek)).toContain("Restarted → newer");
      expect(ALL.every((name) => peek[name] === false)).toBe(true);
    });
  });
});
