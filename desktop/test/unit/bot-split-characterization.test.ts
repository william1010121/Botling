// M7-S40: characterization of `Bot` (desktop/src/core/bot.ts) before it is cut into collaborators (M7-S41 ... M7-S60).
//
// Two kinds of test, both driven through the public API of an unchanged `Bot` with fake heads (no process, no window):
//   1. golden transcripts: for each scripted run, what the bot emitted (its events), what its heads were told (send,
//      steer, interrupt, finish, terminate) and the bot's state after each step (`view()` and the turn/queue state), in the
//      order it all happened. The golden lines below were produced by the unchanged Bot on the base commit f27f064f (the run
//      prints `GOLDEN-BEGIN <name>` blocks when a golden is missing; they were pasted here, then read). A later card that
//      moves code must leave every transcript identical.
//   2. orders that must not change (health-audit v3 design-bot.md section 5): stop closes the turn before the head hears
//      it; `next` does nothing while a turn, the tidy, a switch or a drain is under way; `routeTurn` tries swap hold, switch,
//      settings hold, begin, pending settings, pause, steer, insert, queue in that order; a stopped set-aside turn bumps
//      `ignoreResults`; shutdown empties queue and deferred before it stops the head; a switch of engine hands over before
//      the message.
//
// Determinism: only `Date` is faked (fixed, moved by hand where a run needs minutes to pass); ids (uuid, turn ids) are
// replaced by #1, #2 ... in order of first appearance; folders by <dir>. No timer of the bot fires in a run (idle and
// deferred-start timers are minutes long); the stop runs use interruptGraceMs of a few ms, as the existing tests do.
// The private names it reads are the ones frozen in bot-private-names.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  const state = { sink: (_line: string) => {}, snapshot: () => "", insertOk: false };
  const cut = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n)}…` : text);
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = [];
    sent: { text: string; id: string; now: boolean }[] = []; steered: string[] = []; offered: string[] = [];
    onInterrupt: (() => void) | null = null;
    readonly n: number;
    constructor(readonly config: any, readonly handlers: any) { this.n = heads.length; heads.push(this); }
    private say(line: string) { state.sink(`h${this.n} ${line}`); }
    start() { this.running = true; this.say("start"); queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
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
import { botPrompts, PAUSE_NOTE, RESUME_NOTE } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { toSwiftDate } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const T0 = new Date("2026-11-16T09:00:00.000Z");
const bots: Bot[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(async () => {
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0; fixture.state.sink = () => {}; fixture.state.snapshot = () => ""; fixture.state.insertOk = false;
  vi.useRealTimers();
});

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}

type Engine = "claude" | "codex" | "agy";
interface RigOptions { engines?: Engine[]; insertOk?: boolean; interruptGraceMs?: number; stamp?: () => unknown }

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
  const names = [folder, (() => { try { return realpathSync(folder); } catch { return folder; } })()];
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
    chat() { return peek.records.map((r: any) => `${r.role}${r.state ? `/${r.state}` : ""}${r.interrupted ? "/interrupted" : ""}${r.queued ? "/queued" : ""}: ${String(r.text).slice(0, 60)}`); },
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

/** Ids become #1, #2 ... in order of first appearance, folders <dir>; runs of identical lines are folded into one with "xN". */
function normalize(rigged: { lines: string[]; names: string[] }): string[] {
  const ids = new Map<string, number>();
  let text = rigged.lines.join("\n");
  for (const name of [...new Set(rigged.names)].sort((a, b) => b.length - a.length)) text = text.split(name).join("<dir>");
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
    const key = id.toLowerCase();
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return `#${ids.get(key)}`;
  });
  const out: string[] = [];
  let count = 1;
  for (const line of text.split("\n")) {
    if (out.length && out[out.length - 1]!.replace(/ x\d+$/, "") === line) { count++; out[out.length - 1] = `${line} x${count}`; } else { out.push(line); count = 1; }
  }
  return out;
}

function check(name: string, rigged: { lines: string[]; names: string[] }) {
  const actual = normalize(rigged);
  const want = GOLDEN[name];
  if (!want) console.log(`GOLDEN-BEGIN ${name}\n${actual.map((line) => `    ${JSON.stringify(line)},`).join("\n")}\nGOLDEN-END ${name}`);
  expect(actual).toEqual(want ?? ["(no golden yet)"]);
}
const index = (rigged: { lines: string[] }, find: string | RegExp, from = 0) =>
  rigged.lines.findIndex((line, i) => i >= from && (typeof find === "string" ? line.includes(find) : find.test(line)));

describe("golden transcripts of an unchanged Bot", () => {
  it("a plain turn", async () => {
    const r = rig();
    r.b.send("hello");
    await r.sent(0, 1); r.mark("sent");
    r.delta(0, "Hi "); r.delta(0, "there"); await flush(); r.mark("streaming");
    r.reply(0, "Hi there"); await flush(); r.mark("done");
    expect(r.chat()).toEqual(["user: hello", "bot/done: Hi there"]);
    check("plain turn", r);
  });

  it("a message while working: an Antigravity head cannot take it in, so it waits in the queue (marked Queued) and goes after the turn", async () => {
    const r = rig("agy");
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); await flush(); r.mark("second queued");
    expect(r.chat()).toContain("user/queued: second");
    r.reply(0, "First done"); await r.sent(0, 2); r.mark("second sent");
    r.reply(0, "Second done"); await flush(); r.mark("all done");
    check("queue behind a working head", r);
  });

  it("steer: a message while claude works goes into its turn (priority now); claude answers both", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); await flush(); r.mark("steered");
    expect(r.head(0).sent.map((s: any) => s.now)).toEqual([false, true]);
    r.reply(0, "Answer to both"); await flush(); r.mark("done");
    check("steer", r);
  });

  it("steer, cut off: claude ends the turn for the new line, begins a turn of its own for it, and the cut-off shows no bubble", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1);
    r.delta(0, "Half an answer"); await flush();
    r.b.send("second"); await r.sent(0, 2);
    const steeredId = r.head(0).sent[1].id.toLowerCase();
    r.head(0).item({ kind: "result", ok: false, text: "", error: "error_during_execution", subtype: "error_during_execution" }); await flush(); r.mark("cut off");
    r.head(0).item({ kind: "command", id: steeredId, state: "started" }); await flush(); r.mark("began for the steered line");
    r.reply(0, "Answer to second"); await flush(); r.mark("done");
    check("steer cut off", r);
  });

  it("insert: an Antigravity head takes the line with its next tool result; the turn goes on, nothing is queued afterwards", async () => {
    const r = rig("agy", { insertOk: true });
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); await flush(); r.mark("offered");
    expect(r.head(0).offered).toHaveLength(1);
    r.head(0).item({ kind: "inserted", id: r.head(0).offered[0] }); await flush(); r.mark("delivered");
    r.reply(0, "Both done"); await flush(); r.mark("done");
    check("insert", r);
  });

  it("insert offered but the turn ends first: the line is taken back and goes as the next turn", async () => {
    const r = rig("agy", { insertOk: true });
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); await flush(); r.mark("offered");
    r.reply(0, "First done"); await r.sent(0, 2); r.mark("second sent as its own turn");
    r.reply(0, "Second done"); await flush(); r.mark("done");
    check("insert not delivered", r);
  });

  it("pause and resume: your line while the app's own turn works pauses that work; it carries on after you are answered", async () => {
    const r = rig();
    expect(r.b.appMessage("(App: a worker report)")).not.toBeNull();
    await r.sent(0, 1); await flush(); r.mark("app turn under way");
    r.b.send("a question from me"); await r.sent(0, 2); r.mark("paused for me");
    expect(r.head(0).sent[1].text.startsWith(PAUSE_NOTE)).toBe(true);
    r.reply(0, "Here is my answer"); await r.sent(0, 3); r.mark("work resumed");
    expect(r.head(0).sent[2].text).toBe(RESUME_NOTE);
    r.reply(0, "Back to the report"); await flush(); r.mark("done");
    check("pause and resume", r);
  });

  it("stop while working: the head is asked to end the turn and does", async () => {
    const r = rig();
    const sent = r.b.send("work please"); await r.sent(0, 1);
    r.delta(0, "Starting"); await flush();
    r.head(0).onInterrupt = () => queueMicrotask(() => r.head(0).item({ kind: "result", ok: false, text: "", error: "error_during_execution", subtype: "error_during_execution" }));
    r.mark("before stop");
    expect(await r.b.stop(sent.turnId)).toEqual({ stopped: true, killed: [], forced: false });
    r.mark("stopped");
    // The stop closed the turn, and said so, before the head heard of it.
    expect(index(r, /ev turn\.finished .*status=stopped/)).toBeGreaterThan(-1);
    expect(index(r, /ev turn\.finished .*status=stopped/)).toBeLessThan(index(r, "h0 interrupt"));
    expect(r.lines[index(r, "h0 interrupt")]).toContain("turn=- ");
    r.b.send("after the stop"); await r.sent(0, 2); r.reply(0, "Fine"); await flush(); r.mark("next message answered");
    check("stop while working", r);
  });

  it("stop while working, head does not answer in time: its tree is ended, the next message starts it again", async () => {
    const r = rig();
    const sent = r.b.send("work please"); await r.sent(0, 1);
    r.delta(0, "Starting"); await flush();
    await r.b.stop(sent.turnId); await flush(); r.mark("stopped, head ended");
    r.b.send("after the stop"); await r.sent(1, 1); r.reply(1, "Fine"); await flush(); r.mark("next message on a new head");
    expect(r.head(1).config.resume).toBe(true);
    check("stop with no answer", r);
  });

  it("stop while draining: a message sent before the head ended the stopped turn waits for it, then goes", async () => {
    const r = rig("claude", { interruptGraceMs: 60_000 });
    const sent = r.b.send("work please"); await r.sent(0, 1);
    const stopping = r.b.stop(sent.turnId); await flush(); r.mark("draining");
    expect(r.peek.draining).not.toBeNull();
    r.b.send("quick one"); await flush(); r.mark("message sent while draining");
    expect(r.head(0).sent).toHaveLength(1);
    r.head(0).item({ kind: "result", ok: false, text: "", error: "error_during_execution", subtype: "error_during_execution" });
    await stopping; await r.sent(0, 2); r.mark("drained, message sent");
    r.reply(0, "Quick answer"); await flush(); r.mark("done");
    check("stop while draining", r);
  });

  it("stop a set-aside turn, then the head dies and is resumed: ignoreResults, restart, one transcript", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); await r.sent(0, 2);
    const steeredId = r.head(0).sent[1].id.toLowerCase();
    r.reply(0, "Answer to first", "end_turn"); await flush(); r.mark("first ended, second not read yet");
    const appTurn = r.b.appMessage("(App: a report)")!; await r.sent(0, 3); r.mark("app message sent");
    r.head(0).item({ kind: "command", id: steeredId, state: "started" }); await flush(); r.mark("claude began the steered line: app turn set aside");
    expect(r.peek.deferred).not.toBeNull();
    expect(await r.b.stop(appTurn)).toEqual({ stopped: true, killed: [], forced: false }); r.mark("set-aside turn stopped");
    r.reply(0, "Answer to second", "end_turn"); await flush(); r.mark("second ended: the stopped turn's result is to be ignored");
    expect(r.peek.ignoreResults).toBe(1);
    r.head(0).item({ kind: "result", ok: false, text: "", error: "error_during_execution", subtype: "error_during_execution" }); await flush(); r.mark("that result swallowed");
    expect(r.peek.ignoreResults).toBe(0);
    r.b.send("third"); await r.sent(0, 4);
    r.head(0).handlers.onExit({ code: 1, signal: null, stderr: "", expected: false, silent: false }); await flush(); r.mark("head died mid-turn");
    r.b.send("fourth"); await r.sent(1, 1); r.reply(1, "Fourth answered"); await flush(); r.mark("resumed on a new head");
    check("stop set-aside restart", r);
  });

  it("head exit mid-turn: the turn fails with what is known; the next message starts the head again in the same session", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1);
    r.delta(0, "Working on it"); await flush();
    r.head(0).handlers.onExit({ code: 1, signal: null, stderr: "boom", expected: false, silent: false }); await flush(); r.mark("exited mid-turn");
    r.b.send("again"); await r.sent(1, 1); r.mark("resumed");
    expect(r.head(1).config.resume).toBe(true);
    r.reply(1, "Done"); await flush(); r.mark("done");
    check("head exit and resume", r);
  });

  it("a resume of a session claude no longer has: a new session, and the message is sent again once", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    r.head(0).finish(); await flush(); r.mark("asleep");
    r.b.send("second"); await r.sent(1, 1); r.mark("woke on a resume");
    r.head(1).handlers.onExit({ code: 1, signal: null, stderr: "No conversation found", expected: false, silent: true }); await r.sent(2, 1); r.mark("new session, sent again");
    expect(r.head(2).config.resume).toBe(false);
    r.reply(2, "Second answered"); await flush(); r.mark("done");
    check("resume refused", r);
  });

  it("network outage and networkRestored: the head is lost to the network; when it is back the same session carries on", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1);
    r.delta(0, "Looking"); await flush();
    r.head(0).handlers.onExit({ code: 1, signal: null, stderr: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", expected: false, silent: false }); await flush(); r.mark("lost to the network");
    expect(r.b.view().connection).toBe("disconnected");
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    r.b.networkRestored(Date.now()); await r.sent(1, 1); r.mark("network back after 10 minutes");
    expect(r.head(1).config.resume).toBe(true);
    r.reply(1, "Carrying on"); await flush(); r.mark("done");
    check("network outage", r);
  });

  it("engine switch while a message waits: the old head writes the handoff, ends, the new head reads it, then the messages go in order", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    await r.b.setHeads(["codex"]); r.mark("switch wanted, nothing said yet");
    expect(r.peek.switchTo).toBe("codex");
    r.b.send("second"); await r.sent(0, 2); r.mark("handoff asked of the old head");
    r.b.send("third"); await flush(); r.mark("third queued while switching");
    r.reply(0, "OK."); await r.sent(1, 1); r.mark("new head reads the handoff");
    r.reply(1, "OK."); await r.sent(1, 2); r.mark("second goes to the new head");
    r.reply(1, "Second done"); await r.sent(1, 3); r.mark("third goes");
    r.reply(1, "Third done"); await flush(); r.mark("done");
    check("engine switch", r);
  });

  it("a settings change that holds: the message waits for the head's own work, with a card, then goes after a restart on the new model", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    r.peek.records.push({ id: "reply-own-task", role: "bot", text: "", date: toSwiftDate(), state: "done", engine: "claude", backgroundTasks: [{ id: "own-task", kind: "agent", title: "worker", status: "running", startedAt: toSwiftDate() }] });
    r.b.configure({ model: "new-model" });
    r.b.send("use the new model"); await flush(); r.mark("held");
    expect(r.peek.settingsHold).not.toBeNull();
    expect(r.head(0).sent).toHaveLength(1);
    r.peek.endBackground("own-task", "completed", null); await r.sent(1, 1); r.mark("work ended: restarted, message sent");
    expect(r.head(1).config.model).toBe("new-model");
    r.reply(1, "On the new model"); await flush(); r.mark("done");
    check("settings hold", r);
  });

  it("plugin reload: an awake bot restarts just before its next message, so the new plugins are there", async () => {
    let stamp = "a";
    const r = rig("claude", { stamp: () => ({ v: stamp }) });
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    stamp = "b"; r.b.reloadPlugins(); await flush(); r.mark("plugins changed");
    expect(r.head(0).sent).toHaveLength(1);
    r.b.send("after the reload"); await r.sent(1, 1); r.mark("restarted before the message");
    expect(r.head(1).sent[0].text).toContain("loading new plugins");
    r.reply(1, "Done"); await flush(); r.mark("done");
    check("plugin reload", r);
  });

  it("shutdown with a queue: the waiting messages and the set-aside turn are dropped before the head is stopped", async () => {
    const r = rig("agy");
    r.b.send("first"); await r.sent(0, 1);
    r.b.send("second"); r.b.send("third"); await flush(); r.mark("two waiting");
    expect(r.peek.queue).toHaveLength(2);
    bots.splice(bots.indexOf(r.b), 1);
    await r.b.shutdown({ tidy: false }); r.mark("shut down");
    const stopped = r.lines.find((line) => line.includes("h0 terminate")) ?? "";
    expect(stopped).toContain("queue=[]");
    expect(stopped).toContain("deferred=-");
    expect(stopped).toContain("turn=-");
    check("shutdown with a queue", r);
  });
});

describe("orders that must not change", () => {
  it("next() does nothing while a turn, the tidy, a switch or a drain is under way, and sends the waiting message once all are over", async () => {
    const r = rig();
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    const turnLike = () => ({ id: "t-x", messageId: "m-x", userId: null, origin: "user", words: "waiting", open: true, sent: false, head: null, ended: [], about: [], peer: new Set(), told: 0, steps: [], resolve() {}, done: Promise.resolve("done"), reply: { text: "" } });
    const blockers: [string, () => void, () => void][] = [
      ["a turn", () => { r.peek.turn = { origin: "user", open: true }; }, () => { r.peek.turn = null; }],
      ["the tidy", () => { r.peek.tidying = true; }, () => { r.peek.tidying = false; }],
      ["a switch", () => { r.peek.switching = true; }, () => { r.peek.switching = false; }],
      ["a drain", () => { r.peek.draining = { head: r.head(0), resolve() {}, promise: Promise.resolve() }; }, () => { r.peek.draining = null; }],
    ];
    for (const [name, on, off] of blockers) {
      const waiting = turnLike();
      r.peek.queue.push(waiting);
      on(); r.peek.next(); await flush();
      expect(r.peek.queue, `while ${name}`).toEqual([waiting]);
      expect(r.head(0).sent, `while ${name}`).toHaveLength(1);
      off(); r.peek.queue.splice(0);
    }
    const sent = r.b.send("one more"); await r.sent(0, 2);
    expect(r.peek.turn.id).toBe(sent.turnId);
  });

  it("routeTurn: a swap hold comes before a switch of engine", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    await r.b.setHeads(["codex"]);
    r.b.holdForSwap(true);
    r.b.send("held"); await flush();
    expect(r.peek.queue).toHaveLength(1);
    expect(r.peek.switching).toBe(false);
    expect(r.head(0).sent).toHaveLength(1);
    r.b.holdForSwap(false); await r.sent(0, 2);
    expect(r.head(0).sent[1]!.text).toContain("The model is about to change");
  });

  it("routeTurn: a switch of engine comes before the settings hold", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    r.peek.records.push({ id: "reply-own-task", role: "bot", text: "", date: toSwiftDate(), state: "done", engine: "claude", backgroundTasks: [{ id: "own-task", kind: "agent", title: "worker", status: "running", startedAt: toSwiftDate() }] });
    r.b.configure({ model: "new-model" });
    await r.b.setHeads(["codex"]);
    r.b.send("held"); await r.sent(0, 2);
    expect(r.head(0).sent[1]!.text).toContain("The model is about to change");
    expect(r.peek.settingsHold).toBeNull();
    expect(r.b.snapshot().messages.some((m: any) => String(m.text).includes("waiting for active work"))).toBe(false);
  });

  it("routeTurn: with nothing under way a turn begins at once, even with a model change pending", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    r.b.configure({ model: "new-model" });
    const sent = r.b.send("second"); await flush();
    expect(r.peek.turn?.id).toBe(sent.turnId);
    expect(r.peek.queue).toEqual([]);
    await r.sent(1, 1);
    expect(r.head(1).config.model).toBe("new-model");
  });

  it("routeTurn: with a turn under way a pending model change queues the message, where otherwise it would be steered", async () => {
    const a = rig();
    a.b.send("first"); await a.sent(0, 1);
    a.b.send("second"); await a.sent(0, 2);
    expect(a.head(0).sent[1].now).toBe(true);
    expect(a.peek.queue).toEqual([]);
    const b = rig("claude");
    b.b.send("first"); await b.sent(1, 1);
    b.b.configure({ model: "new-model" });
    b.b.send("second"); await flush();
    expect(b.head(1).sent).toHaveLength(1);
    expect(b.peek.queue).toHaveLength(1);
  });

  it("routeTurn: pause comes before steer: your line during the app's own turn pauses it (PAUSE_NOTE), while during your own turn it is a plain steer", async () => {
    const appTurn = rig();
    appTurn.b.appMessage("(App: a report)"); await appTurn.sent(0, 1);
    appTurn.b.send("question"); await appTurn.sent(0, 2);
    expect(appTurn.head(0).sent[1].text.startsWith(PAUSE_NOTE)).toBe(true);
    expect(appTurn.peek.paused).not.toBeNull();
    const yours = rig();
    yours.b.send("first"); await yours.sent(1, 1);
    yours.b.send("question"); await yours.sent(1, 2);
    expect(yours.head(1).sent[1].text).not.toContain(PAUSE_NOTE);
    expect(yours.peek.paused).toBeNull();
  });

  it("routeTurn: steer is for claude and Codex, insert is for Antigravity, and what neither takes is queued", async () => {
    const claude = rig();
    claude.b.send("first"); await claude.sent(0, 1);
    claude.b.send("second"); await claude.sent(0, 2);
    expect(claude.head(0).sent[1].now).toBe(true);
    const codex = rig("codex");
    codex.b.send("first"); await codex.sent(1, 1);
    codex.b.send("second"); await flush();
    expect(codex.head(1).steered).toHaveLength(1);
    expect(codex.peek.queue).toEqual([]);
    const agyInsert = rig("agy", { insertOk: true });
    agyInsert.b.send("first"); await agyInsert.sent(2, 1);
    agyInsert.b.send("second"); await flush();
    expect(agyInsert.head(2).offered).toHaveLength(1);
    expect(agyInsert.peek.queue).toHaveLength(1);
    expect(agyInsert.head(2).sent).toHaveLength(1);
    const agyQueue = rig("agy");
    agyQueue.b.send("first"); await agyQueue.sent(3, 1);
    agyQueue.b.send("second"); await flush();
    expect(agyQueue.head(3).offered).toHaveLength(0);
    expect(agyQueue.peek.queue).toHaveLength(1);
  });

  it("an engine switch hands over before the message: the handoff prompt reaches the old head, then the new head is read to, then the message", async () => {
    const r = rig("claude");
    r.b.send("first"); await r.sent(0, 1); r.reply(0, "Hi"); await flush();
    await r.b.setHeads(["codex"]);
    r.b.send("the message"); await r.sent(0, 2);
    r.reply(0, "OK."); await r.sent(1, 1); r.reply(1, "OK."); await r.sent(1, 2);
    const handoff = index(r, "h0 send \"(App: The model is about to change");
    const resumed = index(r, "h1 send \"(App: You just took over");
    const message = index(r, "h1 send \"the message");
    expect(handoff).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(handoff);
    expect(message).toBeGreaterThan(resumed);
    expect(r.lines.some((line) => line.includes("Handoff → Codex"))).toBe(true);
    expect(r.head(0).sent.some((s: any) => s.text.includes("the message"))).toBe(false);
  });
});

/** Golden transcripts: produced by the unchanged Bot at f27f064f (see the header). */
const GOLDEN: Record<string, string[]> = {};
