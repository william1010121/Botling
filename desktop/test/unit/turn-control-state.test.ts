// M7-S54 (from the M7-S52 review probe): unit coverage for what only the spec conformance (`turns.spec`) held before the
// TurnBook transitions: the 15 turn fields exist once (as fields of TurnControl, never an own property of Bot), each Bot accessor
// is the TurnControl's value, `stop`/`await` on one bot reach the peer that owns the turn, and a held message (`claimHold`) is taken
// back on the bot that holds it. The fixture (fake heads, `rig`) is the one of bot-split-characterization.test.ts, copied: that
// file is not edited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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

  it("the 15 fields exist once: none is an own property of the Bot, each accessor is the TurnControl's value", () => {
    const A = rig("claude"); const b = A.peek; const tc = b.turns;
    for (const f of ["turn", "queue", "finished", "draining", "ignoreResults", "paused", "reportAsked", "pendingEnded", "ending", "contextSent", "steered", "claudeMidTurn", "inserting", "deferred", "unbegun"]) {
      expect(Object.prototype.hasOwnProperty.call(b, f), `own property ${f} on Bot`).toBe(false);
      expect(b[f], f).toBe(tc[f]);
    }
    b.turn = { id: "t" }; expect(tc.turn.id).toBe("t"); b.turn = null; expect(tc.turn).toBeNull();
    b.ignoreResults = 3; expect(tc.ignoreResults).toBe(3); expect(b.ignoreResults).toBe(3);
    b.pendingEnded = ["x"]; expect(tc.pendingEnded).toEqual(["x"]);
    const q = [1]; b.queue = q as any; expect(tc.queue).toBe(q); expect(b.queue).toBe(q);
    b.paused = { conducted: true, handoffId: null }; expect(tc.paused).toEqual({ conducted: true, handoffId: null });
    b.draining = null;
  });

  it("two bots: each has its own TurnControl, stop and await on the primary reach the peer's turn and finished", async () => {
    const A = rig("claude"); const P = rig("claude");
    (P.peek.options as any).primary = A.b; A.peek.partners.set("claude", P.b);
    expect(A.peek.turns).not.toBe(P.peek.turns);
    const pt = P.peek.newTurn("app", "hello", null); P.peek.route(pt); await P.sent(0, 1); const sent = { turnId: pt.id };
    expect(P.peek.turn?.id).toBe(sent.turnId); expect(A.peek.turn).toBeNull();
    const r = await A.b.stop(sent.turnId);
    expect(r.stopped).toBe(true);
    expect(P.peek.finished.get(sent.turnId)).toBe("stopped"); expect(A.peek.finished.size).toBe(0);
    expect(P.peek.turn).toBeNull();
    const w = await A.b.await(sent.turnId, new AbortController().signal);
    expect(w).toEqual({ status: "stopped" });
    A.peek.partners.clear(); (P.peek.options as any).primary = null;
  });

  it("a held message (claimHold) is taken back on the bot that holds it; the other bot's claimHold is untouched", async () => {
    const A = rig("claude"); const P = rig("claude");
    (P.peek.options as any).primary = A.b; A.peek.partners.set("claude", P.b);
    const held = P.peek.newTurn("user", "held", null);
    const keep = A.peek.newTurn("user", "other", null);
    P.peek.claimHold = { id: "c1", lead: "claude", held: "claude", turn: held, timer: setTimeout(() => {}, 1e6) };
    A.peek.claimHold = { id: "c2", lead: "claude", held: "claude", turn: keep, timer: setTimeout(() => {}, 1e6) };
    const r = await A.b.stop(held.id);          // A does not own it: forwarded to P
    expect(r.stopped).toBe(true);
    expect(P.peek.claimHold).toBeNull(); expect(held.open).toBe(false);
    expect(A.peek.claimHold?.id).toBe("c2"); expect(keep.open).toBe(true);
    clearTimeout(A.peek.claimHold.timer); A.peek.claimHold = null;
    A.peek.partners.clear(); (P.peek.options as any).primary = null;
  });
});
