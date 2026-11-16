// M7-S59 review probes: the bridge-setter rule of check-lines.mjs on every accessor form it is meant to catch, and on the
// lines it must leave alone. The card's own test (bot-foreign-writes.test.ts) has only a `private set` in its fixture, so a
// rule that wanted a modifier before `set` would still pass there. The script is run as a process, as CI runs it.
// Also (second part): call sites of two S59 transitions whose removal no test saw (review mutants y3, y4 on Linux, 92 files):
// head-events' `workers.lostToNetwork(parent)` for claude's connectionLost line, delivery's `headRun.endFresh()`, and (y6, y7, y8)
// ensureHead's `settings.clearSwitchTo()`, the toolResult's `tasks.scheduleSettled(id)` and a turn's `progress.apiRetriesReset()`.
// The fake heads and `rig` are those of bot-foreign-writes.test.ts, copied (vi.mock is per file).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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



const script = join(__dirname, "../../scripts/check-lines.mjs");

function run(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "setter-forms-"));
  try {
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); }
    const baseline = join(repo, "baseline.json"); writeFileSync(baseline, JSON.stringify({ files: {} }));
    execFileSync("git", ["-C", repo, "init", "-q"]); execFileSync("git", ["-C", repo, "add", "-A"]);
    const result = spawnSync("node", [script, "--root", repo, "--baseline", baseline], { encoding: "utf8" });
    const flagged = result.stderr.split("\n").filter((line) => line.includes("a set accessor in a bridge block")).map((line) => line.replace(/^FAIL: /, "").replace(/: .*$/, ""));
    return { status: result.status, flagged };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

describe("check-lines: the bridge-setter rule (M7-S59 review)", () => {
  it("flags a plain, a public, a protected and a private set accessor, each on its own line", () => {
    const { status, flagged } = run({
      "desktop/src/core/bot/forms.ts": [
        "class F {",
        "  set a(v: number) { this.host.a = v; }",
        "  public set b(v: number) { this.host.b = v; }",
        "  protected set c(v: number) { this.host.c = v; }",
        "  private set d (v: number) { this.host.d = v; }",
        "}",
        "",
      ].join("\n"),
    });
    expect(status).toBe(1);
    expect(flagged).toEqual(["desktop/src/core/bot/forms.ts:2", "desktop/src/core/bot/forms.ts:3", "desktop/src/core/bot/forms.ts:4", "desktop/src/core/bot/forms.ts:5"]);
  });

  it("leaves alone a method named set, Map.set calls, setX methods, a getter named set, comments, and files outside core/bot/*.ts", () => {
    const { status, flagged } = run({
      "desktop/src/core/bot/clean.ts": [
        "class C {",
        "  set(key: string, v: number) { this.m.set(key, v); }",
        "  setA(v: number) { this.a = v; }",
        "  get set() { return 1; }",
        "  // set a(v) is gone (M7-S59)",
        "  /**",
        "   * set b(v) was a bridge setter",
        "   */",
        "  run() { this.map.set(a, b); }",
        "}",
        "",
      ].join("\n"),
      "desktop/src/core/bot.ts": "class Bot {\n  set claimHold(v) {}\n}\n",
      "desktop/src/core/bot/inner/deep.ts": "class D {\n  set a(v) {}\n}\n",
      "desktop/src/core/server.ts": "class S {\n  private set a(v) {}\n}\n",
    });
    expect(flagged).toEqual([]);
    expect(status).toBe(0);
  });
});

describe("call sites of the S59 transitions (M7-S59 review)", () => {
  it("y3: claude's connectionLost line for a subagent marks it cut off by the network; its ended line then waits for the network", async () => {
    const A = rig("claude");
    A.b.send("one"); await A.sent(0, 1);
    A.head(0).item({ kind: "subagentStarted", id: "sub-1", description: "d", type: "general-purpose", prompt: "p", background: true });
    A.head(0).item({ kind: "connectionLost", parent: "sub-1" });
    expect(A.peek.workers.cutOffByNetwork.has("sub-1")).toBe(true);
    expect(A.peek.progress.outage).toBeNull();
    // Its end says nothing of the network ("done"): only the mark tells that the network cut it off.
    A.head(0).item({ kind: "subagentEnded", id: "sub-1", status: "completed", summary: "done" });
    expect(A.peek.progress.outage?.subagents).toEqual(["sub-1"]);
    expect(A.peek.workers.cutOffByNetwork.has("sub-1")).toBe(false);
  });

  it("y4: the first message of a fresh session ends it being fresh, so a later restart says so with its divider", async () => {
    const A = rig("claude");
    // As ensureHead leaves it when it began a new session for this message.
    A.peek.headRun.startedFresh = true;
    A.b.send("one"); await A.sent(0, 1);
    expect(A.peek.headRun.startedFresh).toBe(false);
    A.reply(0, "ok"); await waitFor("the first turn to end", () => !A.peek.turn);
    A.peek.restartFor({ told: "restarted", shown: "probe restart" });
    expect(A.peek.restarts.restartPending).toBe(true);
    A.b.send("two"); await A.sent(1, 1);
    expect(A.chat().filter((line: string) => line.startsWith("divider"))).toContain("divider: Restarted → probe restart");
    expect(fixture.heads[1].sent[0].text).toContain("Botling restarted you in this same conversation (restarted)");
  });

  it("y6: a bot that fell asleep before its switch wakes on the new engine once; the switch is then done, so its next wake keeps its session", async () => {
    const A = rig("claude", { engines: ["claude", "codex"] });
    A.peek.settings.switchTo = "codex";
    A.b.send("one"); await A.sent(0, 1);
    expect(A.peek.engine).toBe("codex"); expect(A.peek.settings.switchTo).toBeNull();
    A.reply(0, "ok"); await waitFor("the first turn to end", () => !A.peek.turn);
    A.head(0).finish();
    // The session its next wake goes on with (the exit decides it); a second switch would start another.
    const session = A.peek.session.sessionId;
    A.b.send("two"); await A.sent(1, 1);
    expect(A.peek.engine).toBe("codex"); expect(A.peek.settings.switchTo).toBeNull();
    expect(A.peek.session.sessionId).toBe(session);
  });

  it("y7: a schedule call's tool result forgets the call", async () => {
    const A = rig("claude");
    A.b.send("one"); await A.sent(0, 1);
    A.head(0).item({ kind: "toolUse", id: "t1", parent: null, tool: "ScheduleWakeup", input: { prompt: "check again", reason: "later" } });
    expect(A.peek.tasks.scheduleCalls.has("t1")).toBe(true);
    A.head(0).item({ kind: "toolResult", id: "t1", parent: null, output: "ok" });
    expect(A.peek.tasks.scheduleCalls.has("t1")).toBe(false);
  });

  it("y8: a turn that ends (not a tidy) starts the API retry count again", async () => {
    const A = rig("claude");
    A.b.send("one"); await A.sent(0, 1);
    A.peek.progress.apiRetries = 2;
    A.reply(0, "ok"); await waitFor("the turn to end", () => !A.peek.turn);
    expect(A.peek.progress.apiRetries).toBe(0);
  });
});
