// M7-T1: tests for places where a review of the bot.ts split (M7-S47, M7-S50) found a mutation that no test caught:
//   - `deliver`: the error thrown by `head.send` must end the turn as failed (it must not be swallowed)         [S50 mutation B]
//   - `releaseClaim`: a held turn whose route is blocked is failed, not routed ("cross-engine held turn blocked") [S50 mutation E]
//   - `redrawQueued`: the line is redrawn through the OWNER bot (a partner's own emit would mirror and persist)  [S47 (b)]
//   - `identifyDecision`: a handed-over open question gets its decision id (`decisionID ??= id`) and option ids   [S47 (b)]
//   - `associateDecision`: a <decision-ref/> copies the shared decision's view only when the hand-off named it    [S47]
// Driven through a real `Bot` with fake heads (no process, no window), through its private names, which stay on `Bot`
// as delegates after the split (bot-private-names.test.ts); so this file must pass on every card of the lane.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  const state = { sendError: null as Error | null };
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = [];
    sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { if (state.sendError) throw state.sendError; this.sent.push(text); }
    steer(_text: string) { return true; }
    offerInsert() { return false; }
    withdrawInsert() { return true; }
    interrupt() {}
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
import { CodexThreads } from "../../src/core/agent/codex";
import { toSwiftDate } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => {
  fixture.state.sendError = null;
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

/** A Bot (engine claude) on fake heads; `engines` lists its heads: ["claude", "codex"] gives it a partner bot for Codex. */
function rig(engines: Engine[] = ["claude"]) {
  const folder = tempDir("bot-coverage"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "m", agyModel: "m", heads: { engines, answerWith: "claude", codexModel: "m" } }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: "acp", command: "/never-spawn" }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit(event) { events.push(event); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  const peek = b as any;
  return { b, peek, events, partner: (engine: Engine): any => peek.partners.get(engine) };
}

describe("deliver: the error of head.send ends the turn", () => {
  it("a head that cannot take the message fails the turn with its error, and the bot is free again", async () => {
    const r = rig();
    fixture.state.sendError = new Error("pipe closed by the head");
    r.b.send("hello");
    await waitFor("the turn to finish", () => r.events.some((e) => e.type === "turn.finished"));
    const finished = r.events.filter((e) => e.type === "turn.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "failed", text: "pipe closed by the head", error: "pipe closed by the head" });
    // The turn is over, not left open: nothing under way, and the line says what happened.
    expect(r.peek.turn).toBeNull();
    expect(r.peek.records.find((m: any) => m.role === "bot")).toMatchObject({ state: "failed", text: "pipe closed by the head" });
    expect(r.b.view().working).toBe(false);
  });

  it("control: a head that takes the message leaves the turn open and sends once", async () => {
    const r = rig();
    r.b.send("hello");
    await waitFor("the head to be sent the message", () => fixture.heads[0]?.sent.length >= 1);
    await flush();
    expect(r.events.some((e) => e.type === "turn.finished")).toBe(false);
    expect(r.peek.turn?.open).toBe(true);
    expect(fixture.heads[0].sent).toHaveLength(1);
  });
});

describe("releaseClaim: a held message goes on, or is failed when its route is blocked", () => {
  /** A hold on a user turn of `held`'s bot, led by `lead`; the timer must never fire (it is cleared by the release). */
  function hold(r: ReturnType<typeof rig>, held: Engine, lead: Engine, words = "the user's words") {
    const target = r.peek.botFor(held) ?? r.peek;
    const turn = target.newTurn("user", words, null);
    const timer = { fired: false, handle: setTimeout(() => { timer.fired = true; }, 40) };
    r.peek.claimHold = { id: randomUUID(), lead, held, turn, timer: timer.handle };
    return { turn, timer };
  }

  it("cross-engine held turn blocked: an Antigravity route that is not enabled fails the held turn and routes nothing", async () => {
    const r = rig(["claude", "codex"]);
    const { turn, timer } = hold(r, "claude", "claude");
    // The held head is Antigravity, which is not one of the bot's heads: the route is not allowed.
    r.peek.claimHold.held = "agy";
    expect(r.peek.allowsEngineRoute("agy", "claude")).toBe(false);
    r.peek.releaseClaim("The lead's words", ["about-1"]);
    expect(r.peek.claimHold).toBeNull();
    expect(turn.open).toBe(false);
    const finished = r.events.filter((e) => e.type === "turn.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ turnId: turn.id, status: "failed", text: "Antigravity cross-engine held turn blocked; nothing was routed." });
    // Nothing was routed: no turn begun, nothing queued, no head asked.
    expect(r.peek.turn).toBeNull();
    expect(r.peek.queue).toHaveLength(0);
    await flush();
    expect(fixture.heads).toHaveLength(0);
    // The release cancelled the wait.
    await new Promise((done) => setTimeout(done, 80));
    expect(timer.fired).toBe(false);
  });

  it("the lead's words go in front of the held message, with what they are about, and the held head's bot takes it", async () => {
    const r = rig(["claude", "codex"]);
    const { turn, timer } = hold(r, "codex", "claude", "what the user said");
    expect(r.peek.allowsEngineRoute("codex", "claude")).toBe(true);
    r.peek.releaseClaim("What Claude takes on", ["about-1", "about-2"]);
    expect(r.peek.claimHold).toBeNull();
    expect(turn.words).toBe("What Claude takes on\n\nwhat the user said");
    expect(turn.about).toEqual(["about-1", "about-2"]);
    // Routed to the Codex bot: it begins the turn and its head is sent the words.
    await waitFor("the Codex head to be sent the message", () => fixture.heads.some((h) => h.sent.some((text: string) => text.includes("What Claude takes on"))));
    expect(r.partner("codex").turn).toBe(turn);
    expect(r.events.some((e) => e.type === "turn.finished" && e.status === "failed")).toBe(false);
    await new Promise((done) => setTimeout(done, 80));
    expect(timer.fired).toBe(false);
  });

  it("without words the held message goes on as it was", async () => {
    const r = rig(["claude", "codex"]);
    const { turn } = hold(r, "codex", "claude", "what the user said");
    r.peek.releaseClaim();
    expect(r.peek.claimHold).toBeNull();
    expect(turn.words).toBe("what the user said");
    expect(turn.about).toEqual([]);
    await waitFor("the Codex head to be sent the message", () => fixture.heads.some((h) => h.sent.some((text: string) => text.includes("what the user said"))));
    expect(r.partner("codex").turn).toBe(turn);
  });

  it("with nothing held it does nothing", () => {
    const r = rig(["claude", "codex"]);
    expect(r.peek.claimHold).toBeNull();
    expect(() => r.peek.releaseClaim("words", ["x"])).not.toThrow();
    expect(r.events).toEqual([]);
  });
});

describe("redrawQueued: your line is drawn again through the owner's chat", () => {
  const line = (id: string) => ({ id, role: "user", text: "hello", date: toSwiftDate() });

  it("a partner's queued line is emitted by the owner itself: from the owner's records, not mirrored through fromPartner (which would also save the chat)", () => {
    const r = rig(["claude", "codex"]);
    const partner = r.partner("codex");
    expect(partner).toBeTruthy();
    const id = randomUUID();
    // The line is in the shared chat (the owner's records); the partner's own list does not hold it.
    r.peek.records.push(line(id));
    expect(partner.records.some((m: any) => m.id === id)).toBe(false);
    const turn = partner.newTurn("user", "hello", id);
    partner.queue.push(turn);
    const mirrored = vi.spyOn(r.peek, "fromPartner");
    r.events.length = 0;
    partner.redrawQueued(turn);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "message.updated", botId: r.peek.id, message: { id, role: "user", queued: true } });
    expect(mirrored).not.toHaveBeenCalled();
    expect(r.peek.saveTimer ?? null).toBeNull();
  });

  it("the owner's own queued line is drawn with its Queued mark, and without it once it left the queue", () => {
    const r = rig();
    const id = randomUUID();
    r.peek.records.push(line(id));
    const turn = r.peek.newTurn("user", "hello", id);
    r.peek.queue.push(turn);
    r.peek.redrawQueued(turn);
    expect(r.events.at(-1)).toMatchObject({ type: "message.updated", botId: r.peek.id, message: { id, queued: true } });
    r.peek.queue.splice(0);
    r.peek.redrawQueued(turn);
    expect(r.events).toHaveLength(2);
    expect(r.events.at(-1).message.queued).toBeUndefined();
  });

  it("draws nothing for a turn that is not a line of yours: the app's turn, a turn with no line, a line the chat does not have", () => {
    const r = rig();
    const id = randomUUID();
    r.peek.records.push(line(id));
    r.peek.redrawQueued(r.peek.newTurn("app", "a report", id));
    r.peek.redrawQueued(r.peek.newTurn("user", "no line", null));
    r.peek.redrawQueued(r.peek.newTurn("user", "unknown line", randomUUID()));
    expect(r.events).toEqual([]);
  });
});

describe("identifyDecision: an open question handed over gets its identity", () => {
  const question = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(), role: "bot", text: "Which way?", date: toSwiftDate(), engine: "claude",
    choices: [{ label: "Fast" }, { label: "Slow", id: "keep-me" }], ...extra,
  });
  function spies(r: ReturnType<typeof rig>) {
    return { owner: vi.spyOn(r.peek, "persist").mockImplementation(() => {}), partner: vi.spyOn(r.partner("codex"), "persist").mockImplementation(() => {}) };
  }

  it("the question is its own decision, its options get ids (an id it has is kept), and the chat is saved by both heads' bots", () => {
    const r = rig(["claude", "codex"]);
    const saved = spies(r);
    const record: any = question();
    r.peek.records.push(record);
    r.peek.identifyDecision(record.id);
    expect(record.decisionID).toBe(record.id);
    expect(record.choices.map((c: any) => c.label)).toEqual(["Fast", "Slow"]);
    expect(typeof record.choices[0].id).toBe("string");
    expect(record.choices[0].id.length).toBeGreaterThan(0);
    expect(record.choices[1].id).toBe("keep-me");
    expect(saved.owner).toHaveBeenCalledTimes(1);
    expect(saved.partner).toHaveBeenCalledTimes(1);
    // Asking again changes nothing: the identity and the ids are stable.
    const ids = record.choices.map((c: any) => c.id);
    r.peek.identifyDecision(record.id);
    expect(record.decisionID).toBe(record.id);
    expect(record.choices.map((c: any) => c.id)).toEqual(ids);
  });

  it("a question that already has a decision id keeps it", () => {
    const r = rig(["claude", "codex"]);
    spies(r);
    const record: any = question({ decisionID: "older-decision" });
    r.peek.records.push(record);
    r.peek.identifyDecision(record.id);
    expect(record.decisionID).toBe("older-decision");
    expect(typeof record.choices[0].id).toBe("string");
  });

  it.each([
    ["an answered question", { chosen: 0 }],
    ["a question answered in words", { answer: "Fast" }],
    ["an ignored question", { ignoredAt: "2026-11-16T09:00:00Z" }],
    ["an invalidated question", { questionInvalidatedAt: "2026-11-16T09:00:00Z" }],
    ["a permission card", { permissionTool: "Bash" }],
    ["a line of yours", { role: "user" }],
    ["a question of no head", { engine: undefined }],
    ["a line with no choices", { choices: undefined }],
  ])("%s gets no identity and nothing is saved", (_name, extra) => {
    const r = rig(["claude", "codex"]);
    const saved = spies(r);
    const record: any = question(extra);
    const before = JSON.stringify(record);
    r.peek.records.push(record);
    r.peek.identifyDecision(record.id);
    expect(record.decisionID).toBeUndefined();
    expect(JSON.stringify(record)).toBe(before);
    expect(saved.owner).not.toHaveBeenCalled();
    expect(saved.partner).not.toHaveBeenCalled();
  });

  it("an id the chat does not have does nothing", () => {
    const r = rig(["claude", "codex"]);
    const saved = spies(r);
    const record: any = question();
    r.peek.records.push(record);
    expect(() => r.peek.identifyDecision(randomUUID())).not.toThrow();
    expect(record.decisionID).toBeUndefined();
    expect(saved.owner).not.toHaveBeenCalled();
  });
});

describe("associateDecision: a <decision-ref/> shows the shared decision it names, if the hand-off carried it", () => {
  const SOURCE = "5d3c0f4e-0000-4000-8000-000000000001";
  const OTHER = "5d3c0f4e-0000-4000-8000-000000000002";
  const source = (extra: Record<string, unknown> = {}): any => ({
    id: SOURCE, decisionID: SOURCE, role: "bot", text: "Which way?", date: toSwiftDate(), engine: "claude",
    choices: [{ label: "Fast", id: "c1" }, { label: "Slow", id: "c2" }],
    questions: [{ question: "How?", multiple: false, options: [{ label: "A" }, { label: "B" }] }],
    picks: [{ question: 0, options: [1], notes: { "1": "because" } }],
    chosen: 0, answer: "go fast", ignoredAt: "2026-11-16T09:00:00Z", ...extra,
  });
  const reply = (extra: Record<string, unknown> = {}): any => ({ id: randomUUID(), role: "bot", text: "", date: toSwiftDate(), engine: "codex", ...extra });
  const turn = (handoffId: string | null = "h1", peer: string[] = []): any => ({ handoffId, peer: new Set(peer) });

  it("named by the hand-off (asked on the partner's bot, read from the owner's chat): the reply shows copies of the decision, answer and all", () => {
    const r = rig(["claude", "codex"]);
    const from = source();
    r.peek.records.push(from);
    r.peek.handoffDecisions.set("h1", new Set([SOURCE]));
    const record = reply();
    r.partner("codex").associateDecision(record, SOURCE, turn("h1"));
    expect(record.decisionID).toBe(SOURCE);
    expect(record.choices).toEqual(from.choices);
    expect(record.questions).toEqual(from.questions);
    expect(record.picks).toEqual(from.picks);
    expect(record.chosen).toBe(0);
    expect(record.answer).toBe("go fast");
    expect(record.ignoredAt).toBe("2026-11-16T09:00:00Z");
    // Copies: a change to the view does not reach the decision.
    expect(record.choices).not.toBe(from.choices);
    expect(record.choices[0]).not.toBe(from.choices[0]);
    expect(record.questions[0]).not.toBe(from.questions[0]);
    expect(record.questions[0].options[0]).not.toBe(from.questions[0].options[0]);
    expect(record.picks[0]).not.toBe(from.picks[0]);
    expect(record.picks[0].options).not.toBe(from.picks[0].options);
    expect(record.picks[0].notes).not.toBe(from.picks[0].notes);
    record.choices[0].label = "changed"; record.picks[0].notes["1"] = "changed";
    expect(from.choices[0].label).toBe("Fast");
    expect(from.picks[0].notes["1"]).toBe("because");
  });

  it("seen by the head in a message it was handed (turn.peer), with no hand-off id", () => {
    const r = rig(["claude", "codex"]);
    r.peek.records.push(source());
    const record = reply();
    r.peek.associateDecision(record, SOURCE, turn(null, [SOURCE]));
    expect(record.decisionID).toBe(SOURCE);
    expect(record.choices).toEqual(source().choices);
  });

  it("a decision that has no answer yet is copied without one (chosen 0 is an answer, a missing one is not set)", () => {
    const r = rig(["claude", "codex"]);
    r.peek.records.push(source({ questions: undefined, picks: undefined, chosen: undefined, answer: undefined, ignoredAt: undefined }));
    r.peek.handoffDecisions.set("h1", new Set([SOURCE]));
    const record = reply();
    r.peek.associateDecision(record, SOURCE, turn("h1"));
    expect(record.decisionID).toBe(SOURCE);
    expect(record.choices).toHaveLength(2);
    for (const key of ["questions", "picks", "chosen", "answer", "ignoredAt"]) expect(key in record, key).toBe(false);
  });

  it.each([
    ["a reference nobody handed over (never a guess)", () => ({ turn: turn("h1"), set: new Set([OTHER]) as Set<string> | null })],
    ["a hand-off that named none", () => ({ turn: turn("h1"), set: null })],
    ["a message handed over that has another decision", () => ({ turn: turn(null, [OTHER]), set: null })],
  ])("%s: the reply is left as it is", (_name, make) => {
    const r = rig(["claude", "codex"]);
    r.peek.records.push(source(), { ...source(), id: OTHER, decisionID: OTHER });
    const { turn: t, set } = make();
    if (set) r.peek.handoffDecisions.set("h1", set);
    const record = reply();
    const before = JSON.stringify(record);
    r.peek.associateDecision(record, SOURCE, t);
    expect(JSON.stringify(record)).toBe(before);
  });

  it.each([
    ["no reference", () => ({ reference: null as string | null, record: reply(), from: source() })],
    ["a reply that has its own choices", () => ({ reference: SOURCE as string | null, record: reply({ choices: [{ label: "Mine" }] }), from: source() })],
    ["a source that is not a decision (no decisionID of its own)", () => ({ reference: SOURCE as string | null, record: reply(), from: source({ decisionID: undefined }) })],
    ["a source that is a line of yours", () => ({ reference: SOURCE as string | null, record: reply(), from: source({ role: "user" }) })],
    ["a source that is a permission card", () => ({ reference: SOURCE as string | null, record: reply(), from: source({ permissionTool: "Bash" }) })],
    ["a source the chat does not have", () => ({ reference: SOURCE as string | null, record: reply(), from: source({ id: OTHER, decisionID: OTHER }) })],
  ])("%s: the reply is left as it is, though the hand-off carried the reference", (_name, make) => {
    const r = rig(["claude", "codex"]);
    const { reference, record, from } = make();
    r.peek.records.push(from);
    r.peek.handoffDecisions.set("h1", new Set([SOURCE]));
    const before = JSON.stringify(record);
    r.peek.associateDecision(record, reference, turn("h1", [SOURCE]));
    expect(JSON.stringify(record)).toBe(before);
  });
});
