// M7-S59: the last foreign writes. Each field a collaborator wrote through a bridge setter (`set X(v) { this.host.X = v; }`) is now
// written by its owner through a named transition, and no `set` accessor is left in a bridge block under core/bot/ (check-lines.mjs
// fails on one). This file holds, written before the conversion (so the transitions' effects are what the setters did):
//   - each transition on its owner: it writes its own field(s) and no other;
//   - the order of the writes where a place writes several fields (`retainRestartIdentity`, `adoptSwap`, `adoptRestart`, `stop`);
//   - the check-lines rule on a fixture and on the real tree.
// The fixture (fake heads, `rig`) is the one of bot-split-characterization.test.ts, copied: that file is not edited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  const state = { sink: (_line: string) => {}, snapshot: () => "", insertOk: false, scrub: (text: string) => text };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const cut = (raw: string, n = 70) => { const text = state.scrub(raw).replace(UUID, "<uuid>"); return text.length > n ? `${text.slice(0, n)}…` : text; };
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = [];
    sent: { text: string; id: string; now: boolean }[] = []; steered: string[] = []; offered: string[] = [];
    onInterrupt: (() => void) | null = null;
    readonly n: number;
    constructor(readonly config: any, readonly handlers: any) { this.n = heads.length; heads.push(this); }
    private say(line: string) { state.sink(`h${this.n} ${line}`); }
    start() { this.running = true; this.say(`start resume=${!!this.config.resume} model=${this.config.model ?? "-"}`); queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string, id: string, _images?: string[], options?: any) { this.sent.push({ text, id, now: !!options?.now }); this.say(`send ${JSON.stringify(cut(text))}${options?.now ? " now" : ""}`); }
    steer(text: string) { this.steered.push(text); this.say(`steer ${JSON.stringify(cut(text))}`); return true; }
    offerInsert(id: string, text: string) { this.say(`offerInsert ${JSON.stringify(cut(text))} -> ${state.insertOk}`); if (state.insertOk) this.offered.push(id); return state.insertOk; }
    withdrawInsert(id: string) { this.say("withdrawInsert"); this.offered = this.offered.filter((o) => o !== id); return true; }
    interrupt() { this.say(`interrupt ${state.snapshot()}`); this.onInterrupt?.(); }
    item(item: any) { this.handlers.onItem(item); }
    finish() { this.say("finish"); this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.say(`terminate ${state.snapshot()}`); this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); return { killed: [], forced: false }; }
  }
  return { heads, state, Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/codex", async (original) => ({ ...await original<any>(), CodexHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/agy-acp", () => ({ verifyAcpRuntime() {}, AgyAcpHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-16T09:00:00.000Z")); });
afterEach(async () => {
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0; fixture.state.sink = () => {}; fixture.state.snapshot = () => ""; fixture.state.insertOk = false; fixture.state.scrub = (text) => text;
  vi.useRealTimers();
});

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}

type Engine = "claude" | "codex" | "agy";
interface RigOptions { engines?: Engine[]; insertOk?: boolean; interruptGraceMs?: number; stamp?: () => string[] }

/** A Bot on fake heads that writes one transcript: its events, its heads' calls, and `mark` lines in the order they happened. */
function rig(engine: Engine = "claude", options: RigOptions = {}) {
  const folder = tempDir("bot-split"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  const engines = options.engines ?? [engine];
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "old", agyModel: "old", heads: { engines, answerWith: engine, codexModel: "old" } }));
  const lines: string[] = [];
  const events: any[] = [];
  fixture.state.sink = (line) => lines.push(line);
  fixture.state.insertOk = options.insertOk === true;
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: "acp", command: "/never-spawn" }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    ...(options.stamp ? { pluginStamp: options.stamp } : {}),
    emit(event) { events.push(event); lines.push(`ev ${summary(event)}`); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: options.interruptGraceMs ?? 10 });
  bots.push(b);
  const peek = b as any;
  const state = () => `turn=${peek.turn ? `${peek.turn.origin}${peek.turn.open ? "" : "/closed"}` : "-"} queue=[${peek.queue.map((t: any) => t.origin + (t.sent ? "/sent" : "")).join(",")}] deferred=${peek.deferred ? peek.deferred.origin : "-"} draining=${peek.draining ? "yes" : "no"} ignore=${peek.ignoreResults} paused=${peek.paused ? "yes" : "no"}`;
  fixture.state.snapshot = state;
  const names = [...new Set([folder, (() => { try { return realpathSync(folder); } catch { return folder; } })()])].sort((a, b) => b.length - a.length);
  fixture.state.scrub = (text) => names.reduce((t, name) => t.split(name).join("<dir>"), text);
  const R = {
    b, peek, lines, events, folder, names, state,
    mark(label: string) {
      const v = b.view();
      lines.push(`# ${label} | phase=${v.phase} working=${v.working} connection=${v.connection ?? "-"} approvals=${v.approvals} | ${state()}`);
    },
    head: (n: number) => fixture.heads[n],
    async sent(n: number, count: number) { await waitFor(`head ${n} to have ${count} sent`, () => fixture.heads[n]?.sent.length >= count); await flush(1); },
    delta(n: number, text: string) { fixture.heads[n].item({ kind: "delta", text }); },
    reply(n: number, text: string, subtype = "success") { fixture.heads[n].item({ kind: "result", ok: true, text, subtype }); },
    /** The user's lines in the chat, as the bot keeps them, for a closing look. */
    chat() { return b.snapshot().messages.map((r: any) => `${r.role}${r.state ? `/${r.state}` : ""}${r.interrupted ? "/interrupted" : ""}${r.queued ? "/queued" : ""}: ${String(r.text).slice(0, 60)}`); },
  };
  return R;
}

/** One line for an event: its type and the fields a split could change. */
function summary(e: any): string {
  const bits: string[] = [e.type];
  if (e.turnId) bits.push(`turn=${e.turnId}`);
  if (e.messageId) bits.push(`msg=${e.messageId}`);
  if (e.head) bits.push(`head=${e.head}`);
  if (e.status) bits.push(`status=${e.status}`);
  if (typeof e.text === "string") bits.push(`text=${JSON.stringify(e.text.slice(0, 60))}`);
  if (e.steps) bits.push(`steps=${e.steps.length}`);
  if (e.message) {
    const m = e.message;
    bits.push(`${m.role}${m.state ? `/${m.state}` : ""}${m.interrupted ? "/interrupted" : ""}${m.queued ? "/queued" : ""}`, `id=${m.id}`, `text=${JSON.stringify(String(m.text).slice(0, 60))}`);
    if (m.turnId) bits.push(`turn=${m.turnId}`);
    if (m.engine) bits.push(`engine=${m.engine}`);
  }
  if (e.bot) bits.push(`phase=${e.bot.phase}`, `working=${e.bot.working}`, `connection=${e.bot.connection ?? "-"}`, `approvals=${e.bot.approvals}`, `subagents=${e.bot.subagents}`);
  if (e.heads) bits.push(`heads=${JSON.stringify(e.heads.engines ?? e.heads)}`);
  return bits.join(" ");
}


const claim = (order: string[], peek: any, id = "held-turn") => {
  const turn: any = { id, messageId: "m1", open: true, resolve: (status: string) => order.push(`resolve:${status} claimHold=${peek.claimHold ? "set" : "null"} open=${turn.open}`) };
  return { id: "hold", lead: "claude", held: "codex", turn, timer: setTimeout(() => {}, 1_000_000) as NodeJS.Timeout };
};

describe("named transitions on the owner of the field", () => {
  it("BotGroup.dropClaim empties claimHold and nothing else; Bot.claimHold is still the group's value", () => {
    const { peek } = rig("claude"); const order: string[] = [];
    const hold = claim(order, peek); peek.claimHold = hold;
    expect(peek.group.claimHold).toBe(hold);
    peek.group.dropClaim();
    expect(peek.group.claimHold).toBeNull(); expect(peek.claimHold).toBeNull();
    expect(hold.turn.open).toBe(true); expect(order).toEqual([]);
    clearTimeout(hold.timer);
  });

  it("stop(turnId) of a held message: the claim is dropped first, then the turn is closed, announced and resolved", async () => {
    const A = rig("claude"); const { peek } = A; const order: string[] = [];
    const hold = claim(order, peek); peek.claimHold = hold;
    const seen = A.events.length;
    const result = await peek.stop("held-turn");
    expect(result).toMatchObject({ stopped: true });
    // `resolve` ran after the claim was dropped and the turn was closed.
    expect(order).toEqual(["resolve:stopped claimHold=null open=false"]);
    const finished = A.events.slice(seen).filter((e) => e.type === "turn.finished");
    expect(finished).toHaveLength(1); expect(finished[0]).toMatchObject({ turnId: "held-turn", status: "stopped" });
    expect(peek.claimHold).toBeNull();
  });

  it("shutdown with a held message resolves it as stopped, then drops the claim (the old order)", async () => {
    const A = rig("claude"); const { peek } = A; const order: string[] = [];
    peek.claimHold = claim(order, peek);
    const done = peek.shutdown({ tidy: false });
    expect(order).toEqual(["resolve:stopped claimHold=set open=true"]);
    await done;
    expect(peek.claimHold).toBeNull();
  });

  it("BotWorkers: managedEnded clears managedPending; lostToNetwork adds the id to cutOffByNetwork (once, with the others kept)", () => {
    const { peek } = rig("claude"); const w = peek.workers;
    w.managedPending = true; w.managedEnded(); expect(w.managedPending).toBe(false);
    w.lostToNetwork("a"); w.lostToNetwork("b"); w.lostToNetwork("a");
    expect([...w.cutOffByNetwork]).toEqual(["a", "b"]); expect(peek.cutOffByNetwork).toBe(w.cutOffByNetwork);
  });

  it("BotTasks: scheduleCalled keeps the call by id (the later one replaces); scheduleSettled forgets only that id", () => {
    const { peek } = rig("claude"); const t = peek.tasks;
    t.scheduleCalled("c1", { a: 1 }); t.scheduleCalled("c2", { a: 2 }); t.scheduleCalled("c1", { a: 3 });
    expect([...t.scheduleCalls]).toEqual([["c1", { a: 3 }], ["c2", { a: 2 }]]);
    t.scheduleSettled("c1"); t.scheduleSettled("never");
    expect([...t.scheduleCalls.keys()]).toEqual(["c2"]); expect(peek.scheduleCalls).toBe(t.scheduleCalls);
  });

  it("BotProgress: retryingStarted/Ended, apiRetriesReset and codexRetryEnded each write their one field", () => {
    const { peek } = rig("claude"); const p = peek.progress;
    p.retryingStarted(); expect(p.retryingConnection).toBe(true); expect(peek.retryingConnection).toBe(true);
    p.apiRetries = 4; p.codexRetry = { n: 1 }; p.retryingStarted();
    p.retryingEnded(); expect(p.retryingConnection).toBe(false); expect(p.apiRetries).toBe(4); expect(p.codexRetry).toEqual({ n: 1 });
    p.apiRetriesReset(); expect(p.apiRetries).toBe(0); expect(p.codexRetry).toEqual({ n: 1 });
    p.codexRetryEnded(); expect(p.codexRetry).toBeNull(); expect(p.retryingConnection).toBe(false);
  });

  it("BotSettings.clearSwitchTo, BotDelivery.queueNote/forgetQueuedNote, BotCards.forgetBriefed, BotRecords.seeReactions/forgetReactions", () => {
    const { peek } = rig("claude");
    peek.settings.switchTo = "codex"; peek.settings.clearSwitchTo(); expect(peek.settings.switchTo).toBeNull(); expect(peek.switchTo).toBeNull();
    peek.delivery.queueNote("cut off"); expect(peek.delivery.queuedNote).toBe("cut off"); expect(peek.queuedNote).toBe("cut off");
    peek.delivery.forgetQueuedNote(); expect(peek.delivery.queuedNote).toBeNull();
    peek.cards.briefedComponents = { a: 1 }; peek.cards.forgetBriefed(); expect(peek.cards.briefedComponents).toBeNull(); expect(peek.briefedComponents).toBeNull();
    const seen = { x: 1 };
    peek.recordsBook.seeReactions(seen); expect(peek.recordsBook.reactionsSeen).toBe(seen); expect(peek.reactionsSeen).toBe(seen);
    peek.recordsBook.forgetReactions(); expect(peek.recordsBook.reactionsSeen).toBeNull();
  });

  it("BotRecords owns problem and readOnly; Bot reads them through (no own property)", () => {
    const { peek } = rig("claude"); const r = peek.recordsBook;
    for (const f of ["problem", "readOnly"]) expect(Object.prototype.hasOwnProperty.call(peek, f), f).toBe(false);
    expect(peek.problem).toBeNull(); expect(peek.readOnly).toBe(false);
    r.problem = "cannot read"; r.readOnly = true;
    expect(peek.problem).toBe("cannot read"); expect(peek.readOnly).toBe(true);
  });

  it("BotHead.endFresh / sessionAdopted / adoptedAs / freshSessionAsked and BotRestart.recoveryStarted / restartAdopted / restartResumed", () => {
    const { peek } = rig("claude"); const h = peek.headRun; const r = peek.restarts;
    h.startedFresh = true; h.endFresh(); expect(h.startedFresh).toBe(false);
    const session = { sessionId: "s-1", started: true, promptHash: "p" };
    h.sessionAdopted(session); expect(h.session).toBe(session); expect(peek.session).toBe(session);
    h.adoptedAs(true); expect(h.adoptedSession).toBe(true); h.adoptedAs(false); expect(h.adoptedSession).toBe(false);
    h.freshSessionPending = false; h.freshSessionAsked(); expect(h.freshSessionPending).toBe(true);
    r.recoveryStarted(); expect(r.restartRecovery).toBe(true);
    const workers = [{ id: "w" }];
    r.restartAdopted(workers, 77, "pt-1");
    expect([r.restartWorkerRecords, r.restartWorkersSince, r.restartProviderTurn]).toEqual([workers, 77, "pt-1"]);
    r.restartResumed();
    expect([r.restartWorkerRecords, r.restartWorkersSince, r.restartProviderTurn]).toEqual([undefined, undefined, undefined]);
  });
});

describe("the places that write another bot's state, in their old order", () => {
  /** What the saved head sees at the moment `saveHead` runs. */
  function watchSave(A: ReturnType<typeof rig>) {
    const saved: any[] = [];
    vi.spyOn(A.peek.store, "saveHead").mockImplementation((head: any) => {
      saved.push({ head: { ...head }, session: { ...A.peek.headRun.session }, briefing: A.peek.headRun.briefing, adopted: A.peek.headRun.adoptedSession,
        recovery: A.peek.restarts.restartRecovery, note: A.peek.delivery.queuedNote });
    });
    return saved;
  }

  it("retainRestartIdentity: session, briefing, adoptedSession, then saveHead, then restartRecovery", () => {
    const A = rig("claude"); const saved = watchSave(A);
    A.peek.headRun.briefing = false; A.peek.headRun.adoptedSession = false;
    const bot = A.peek.retainRestartIdentity({ botId: "chat", engine: "claude", sessionId: "sess-1", sessionStarted: false, continue: true, queued: [] });
    expect(bot).toBe(A.peek);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ session: { sessionId: "sess-1", started: false }, briefing: true, adopted: true, recovery: false });
    expect(A.peek.restarts.restartRecovery).toBe(true);
  });

  it("retainRestartIdentity: a started session needs no briefing; nothing to continue and no workers is not an adopted session", () => {
    const A = rig("claude"); const saved = watchSave(A);
    A.peek.headRun.briefing = true;
    A.peek.retainRestartIdentity({ botId: "chat", engine: "claude", sessionId: "sess-2", queued: [] });
    expect(saved[0]).toMatchObject({ session: { sessionId: "sess-2", started: true }, briefing: false, adopted: false, recovery: false });
  });

  it("retainRestartIdentity: with no session id it throws and writes nothing", () => {
    const A = rig("claude"); const saved = watchSave(A);
    const before = A.peek.headRun.session;
    expect(() => A.peek.retainRestartIdentity({ botId: "chat", engine: "claude", queued: [] })).toThrow(/unavailable/);
    expect(saved).toHaveLength(0); expect(A.peek.headRun.session).toBe(before); expect(A.peek.restarts.restartRecovery).toBe(false);
  });

  it("adoptRestart: hands the head the ledger (workers, restartedAt, provider turn) after the identity is kept", () => {
    const A = rig("claude"); const saved = watchSave(A);
    const workers = [{ id: "w1", wasActive: false, reportPending: false }];
    A.peek.adoptRestart({ botId: "chat", engine: "claude", sessionId: "sess-3", sessionStarted: true, continue: false, queued: [], workers, restartedAt: 1234, providerTurnId: "pt-9" });
    const r = A.peek.restarts;
    expect(saved).toHaveLength(1); expect(saved[0].recovery).toBe(false); expect(saved[0].adopted).toBe(true);
    expect(r.restartRecovery).toBe(true);
    expect([r.restartWorkerRecords, r.restartWorkersSince, r.restartProviderTurn]).toEqual([workers, 1234, "pt-9"]);
  });

  it("adoptSwap: session, adoptedSession, briefing off, saveHead, and only then the cut-off note is queued", () => {
    const A = rig("claude"); const saved = watchSave(A);
    A.peek.headRun.briefing = true; A.peek.takeInterruptedNote = () => "cut off by the swap";
    A.peek.adoptSwap([{ engine: "claude", sessionId: "sess-4", continue: false, queued: [] }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ session: { sessionId: "sess-4", started: true }, briefing: false, adopted: false, note: null });
    expect(A.peek.delivery.queuedNote).toBe("cut off by the swap");
  });

  it("adoptSwap: no cut-off note leaves the queued note alone; a 'continue' entry marks the session adopted", () => {
    const A = rig("claude"); const saved = watchSave(A);
    A.peek.delivery.queueNote("older"); A.peek.takeInterruptedNote = () => "";
    A.peek.adoptSwap([{ engine: "claude", sessionId: "sess-5", continue: false, queued: [] }]);
    expect(A.peek.delivery.queuedNote).toBe("older");
    A.peek.adoptSwap([{ engine: "claude", sessionId: "sess-6", continue: true, queued: [] }]);
    expect(saved.map((s) => [s.session.sessionId, s.adopted])).toEqual([["sess-5", false], ["sess-6", true]]);
  });

  it("restartNow: a claude head asks for a fresh session, a codex one does not", () => {
    const A = rig("claude", { engines: ["claude", "codex"] });
    const codex = A.peek.members.find((m: any) => m.engine === "codex");
    A.b.restartNow();
    expect(A.peek.headRun.freshSessionPending).toBe(true);
    if (codex) expect(codex.headRun.freshSessionPending).toBe(false);
  });
});

describe("no set accessor in a bridge block (check-lines)", () => {
  const script = join(__dirname, "../../scripts/check-lines.mjs");

  it("the collaborators under core/bot/ have none today", () => {
    const dir = join(__dirname, "../../src/core/bot");
    const found: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      readFileSync(join(dir, name), "utf8").split("\n").forEach((line, i) => { if (/^\s*(?:(?:private|public|protected)\s+)?set\s+\w+\s*\(/.test(line)) found.push(`${name}:${i + 1}`); });
    }
    expect(found).toEqual([]);
  });

  it("the script fails on a setter in a file there, names it, and ignores one elsewhere", () => {
    const repo = mkdtempSync(join(tmpdir(), "setter-gate-"));
    try {
      const put = (path: string, text: string) => { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); };
      const baseline = join(repo, "baseline.json"); writeFileSync(baseline, JSON.stringify({ files: {} }));
      put("desktop/src/core/bot.ts", "class Bot { set claimHold(v) {} }\n");
      put("desktop/src/core/bot/group.ts", "class G {\n  get a() { return 1; }\n  private set a(v: number) { this.host.a = v; }\n}\n");
      put("desktop/src/core/bot/ok.ts", "class O { setA(v: number) {} reset(a) {} get set() { return 1; } }\n");
      execFileSync("git", ["-C", repo, "init", "-q"]); execFileSync("git", ["-C", repo, "add", "-A"]);
      const run = spawnSync("node", [script, "--root", repo, "--baseline", baseline], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("desktop/src/core/bot/group.ts:3");
      expect(run.stderr).not.toContain("ok.ts"); expect(run.stderr).not.toContain("core/bot.ts");
      writeFileSync(join(repo, "desktop/src/core/bot/group.ts"), "class G {\n  get a() { return 1; }\n}\n");
      execFileSync("git", ["-C", repo, "add", "-A"]);
      const clean = spawnSync("node", [script, "--root", repo, "--baseline", baseline], { encoding: "utf8" });
      expect(clean.status).toBe(0); expect(clean.stdout).toContain("check-lines: ok");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

// The two mutants of the M7-S58 review that no test killed (.bot/artifacts/v3-split/M7-S58-review.md, x5 and x6): writes moved byte
// for byte by S58, asserted here so a change to them shows.
describe("restart flags the M7-S58 review found unguarded", () => {
  const REASON = { told: "restarted", shown: "restart" };

  it("x5, consumed: the folder restart no longer waits once its head is ended for it, though the new head has not started yet", () => {
    const { peek } = rig("claude"); const r = peek.restarts; const old: any = { id: "old" };
    r.folderPending = true; r.restartPending = true; r.restartNonModel = true; r.restartForPluginsOnly = true; r.restartReason = REASON;
    expect(peek.consumeRestart(old)).toBe(REASON);
    expect(r.folderPending).toBe(false); expect(r.restartPending).toBe(false); expect(r.restartNonModel).toBe(false);
    expect(r.restartForPluginsOnly).toBe(false); expect(r.restarting).toBe(old); expect(r.restartReason).toBeNull();
  });

  it("x5, in flight: while the old head has not exited, the message that ended it has taken the folder restart (no new head yet)", async () => {
    const A = rig("claude");
    A.b.send("one"); await A.sent(0, 1); A.reply(0, "ok"); await waitFor("the first turn to end", () => !A.peek.turn);
    A.head(0).exited = new Promise(() => {});
    A.peek.restartFor(REASON, false, true);
    expect(A.peek.restarts.folderPending).toBe(true);
    A.b.send("two");
    await waitFor("the restart to be taken", () => A.peek.restarts.restartPending === false);
    expect(A.peek.restarts.folderPending).toBe(false);
    expect(fixture.heads).toHaveLength(1);
  });

  it("x6, request: it clears restartForPluginsOnly first, asleep or awake", () => {
    const A = rig("claude"); const r = A.peek.restarts;
    expect(A.peek.head?.running).toBeFalsy();
    r.restartForPluginsOnly = true; r.restartPending = true; r.folderPending = true;
    A.peek.restartFor(REASON);
    expect(r.restartForPluginsOnly).toBe(false); expect(r.restartPending).toBe(false); expect(r.folderPending).toBe(false);
    // Awake: a head is running; the flag is cleared and the restart waits.
    A.peek.head = { running: true } as any;
    r.restartForPluginsOnly = true;
    A.peek.restartFor(REASON);
    expect(r.restartForPluginsOnly).toBe(false); expect(r.restartPending).toBe(true);
    A.peek.head = null;
  });

  it("x6, through reloadPlugins: an only-plugins restart still flagged, then a restart asked asleep, leaves no only-plugins flag", () => {
    const A = rig("claude"); const r = A.peek.restarts;
    r.restartPending = true; r.restartForPluginsOnly = true; r.restartReason = REASON;
    expect(A.peek.head?.running).toBeFalsy();
    A.peek.restartFor({ told: "other", shown: "other" });
    expect(r.restartForPluginsOnly).toBe(false); expect(r.restartPending).toBe(false);
  });
});
