// M7-S40: the private names of `Bot` (desktop/src/core/bot.ts) that tests and spec adapters reach through a cast
// ((bot as any).turn, vi.spyOn(bot as any, "deliver"), Bot.prototype.monitorState.call(fake)), frozen before the class is
// cut into collaborators (M7-S41 ... M7-S60). The thin `Bot` that remains keeps a forwarding accessor or delegate for
// every name below, so no test and no spec adapter has to change. This file must pass unchanged on every card of the lane.
//
// How the list was made (base f27f064f, nothing here is typed by hand from memory):
//   1. node (TypeScript parser) over `class Bot` in desktop/src/core/bot.ts: 477 members, 331 of them private/protected,
//      each with its kind (field, method, getter).
//   2. a scan of desktop/test, desktop/spec-adapters and desktop/src/**/*.test.ts for those names behind a cast:
//      `(x as any).name`, `(x as unknown as {..}).name`, `["name"]`, and `vi.spyOn(x, "name")` / `Bot.prototype`;
//      false hits (a `remove` of a CLI prompt, a `notice` object key) were read and dropped; 49 names remained.
//   3. the names the S40 characterization test (bot-split-characterization.test.ts) itself reads or patches.
// Public members that the card also calls "private names" (`subagents`) are listed too: they are reached the same way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = []; sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    interrupt() {}
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { heads, Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

/** Fields (and plain properties): they must exist on an instance; what tests do with them is listed in `ASSIGNED`. */
const FIELDS = [
  "alwaysAllowed", "approvals", "claudeWorkerHost", "conductor", "deferred", "draining", "guestTurn", "head", "headsSettings",
  "partners", "queue", "records", "session", "steered", "subagents", "turn",
  // read or set by the S40 characterization test
  "ignoreResults", "paused", "settingsHold", "swapHold", "switching", "switchTo", "tidying",
] as const;
/** Methods: they must exist on `Bot.prototype` (tests spy there) and be callable on an instance. */
const METHODS = [
  "add", "addBackgroundTask", "ask", "backgroundTurn", "becomeEngine", "begin", "changed", "checkSettingsHold", "compose", "deliver",
  "deliverTo", "emit", "endBackground", "finishTurn", "makePartner", "messageView", "monitorState", "newSession", "newTurn", "onExit",
  "onItem", "onSubagentItem", "onWorkerOutput", "projectWorker", "prompts", "restartFor", "route", "showAppReply", "subagentChanged",
  "tellHead", "workerNoted", "workerReport", "workerReported",
  // read or set by the S40 characterization test
  "handOver", "next", "routeTurn",
] as const;
/** Getters: they exist on the prototype chain and reading one on a fresh bot does not throw. */
const GETTERS = ["allowRules", "chat", "switchReady", "working"] as const;
/** Public methods that tests replace on `Bot.prototype` (vi.spyOn(Bot.prototype, ...)). */
const PROTOTYPE_SPIED = ["relay", "workerNote"] as const;

const bots: Bot[] = [];
afterEach(async () => { for (const b of bots.splice(0)) await b.shutdown({ tidy: false }); fixture.heads.length = 0; vi.restoreAllMocks(); });
function make() {
  const folder = tempDir("bot-private-names"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "m", heads: { engines: ["claude"], answerWith: "claude" } }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (engine, heads) => botPrompts({ profile, engine, heads }), emit(e) { events.push(e); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  return { b, events };
}
const settle = () => new Promise((r) => setImmediate(r));

describe("the private names of Bot that tests and spec adapters reach", () => {
  it("the list has the names it had when it was made (49 reached through a cast, 14 more the S40 test and the spies use)", () => {
    const all = [...FIELDS, ...METHODS, ...GETTERS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(63);
  });

  it("every field is on a Bot instance", () => {
    const { b } = make();
    for (const name of FIELDS) expect(name in b, `field ${name}`).toBe(true);
  });

  it("every method is on Bot.prototype and a function on an instance", () => {
    const { b } = make();
    for (const name of METHODS) {
      expect(typeof (Bot.prototype as any)[name], `Bot.prototype.${name}`).toBe("function");
      expect(typeof (b as any)[name], `bot.${name}`).toBe("function");
    }
    for (const name of PROTOTYPE_SPIED) expect(typeof (Bot.prototype as any)[name], `Bot.prototype.${name}`).toBe("function");
  });

  it("every getter is on the prototype chain and reads without throwing", () => {
    const { b } = make();
    for (const name of GETTERS) {
      let proto: object | null = Bot.prototype, found: PropertyDescriptor | undefined;
      while (proto && !found) { found = Object.getOwnPropertyDescriptor(proto, name); proto = Object.getPrototypeOf(proto); }
      expect(typeof found?.get, `getter ${name}`).toBe("function");
      expect(() => (b as any)[name], `read ${name}`).not.toThrow();
    }
  });

  it("a fresh bot's fields start as the tests expect: nothing under way, nothing queued, an empty chat", () => {
    const { b } = make();
    const peek = b as any;
    expect(peek.turn).toBeNull();
    expect(peek.deferred).toBeNull();
    expect(peek.draining).toBeNull();
    expect(peek.queue).toEqual([]);
    expect(peek.records).toEqual([]);
    expect(peek.ignoreResults).toBe(0);
    expect(peek.paused).toBeNull();
    expect(peek.tidying).toBe(false);
    expect(peek.switching).toBe(false);
    expect(peek.swapHold).toBe(false);
    expect(peek.settingsHold).toBeNull();
    expect(peek.switchTo).toBeNull();
    expect(peek.steered.size).toBe(0);
    expect(peek.approvals.size).toBe(0);
    expect(peek.working).toBe(false);
    expect(peek.chat).toEqual([]);
    expect(peek.head).toBeNull();
  });

  it("fields that tests assign take the value and give it back (head, alwaysAllowed, guestTurn, claudeWorkerHost)", () => {
    const { b } = make();
    const peek = b as any;
    const before = { head: peek.head, alwaysAllowed: peek.alwaysAllowed, guestTurn: peek.guestTurn, claudeWorkerHost: peek.claudeWorkerHost };
    const stand = { running: false, marker: "stand-in" };
    try {
      peek.head = stand; peek.alwaysAllowed = ["Bash"]; peek.guestTurn = true; peek.claudeWorkerHost = stand;
      expect(peek.head).toBe(stand);
      expect(peek.alwaysAllowed).toEqual(["Bash"]);
      expect(peek.guestTurn).toBe(true);
      expect(peek.claudeWorkerHost).toBe(stand);
    } finally { Object.assign(peek, before); }
    expect(peek.head).toBe(before.head);
  });

  it("a test's instance patch of a private method is what the callers inside Bot run (relayed-card adapter: deliver, newTurn, begin)", async () => {
    const { b } = make();
    const peek = b as any;
    const calls: string[] = [];
    const wrap = (name: string) => { const original = peek[name].bind(b); peek[name] = (...args: unknown[]) => { calls.push(name); return original(...args); }; };
    const route = vi.spyOn(Bot.prototype as any, "route");
    wrap("newTurn"); wrap("begin"); wrap("deliver");
    b.send("hello");
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["newTurn", "begin", "deliver"]);
    expect(fixture.heads).toHaveLength(1);
    expect(fixture.heads[0].sent).toHaveLength(1);
  });

  it("a stubbed deliver (relayed-card adapter) leaves the turn open and starts no head", async () => {
    const { b } = make();
    const peek = b as any;
    peek.deliver = async () => {};
    const sent = b.send("hello");
    await settle();
    expect(peek.turn?.id).toBe(sent.turnId);
    expect(peek.turn.open).toBe(true);
    expect(fixture.heads).toHaveLength(0);
  });

  it("an app message goes deliverTo -> newTurn -> route -> begin -> deliver, each through the instance", async () => {
    const { b } = make();
    const peek = b as any;
    const calls: string[] = [];
    for (const name of ["deliverTo", "newTurn", "begin", "deliver"]) { const original = peek[name].bind(b); peek[name] = (...args: unknown[]) => { calls.push(name); return original(...args); }; }
    const route = vi.spyOn(Bot.prototype as any, "route").mockImplementation(function (this: any, turn: any) { calls.push("route"); return turn; });
    expect(b.appMessage("(App: a note)")).not.toBeNull();
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["deliverTo", "newTurn", "route"]);
    expect(fixture.heads).toHaveLength(0);
  });

  it("emit is a method that tests spy on: a line added reaches it", async () => {
    const { b, events } = make();
    const emit = vi.spyOn(b as any, "emit");
    b.send("hello");
    await settle();
    expect(emit).toHaveBeenCalled();
    expect(emit.mock.calls.some(([event]: any[]) => event.type === "message.added")).toBe(true);
    expect(events.some((event) => event.type === "message.added")).toBe(true);
  });

  it("monitorState runs on a bare object as `this`, as monitor-policy.test.ts calls it from Bot.prototype", () => {
    const original = { engine: "codex", steps: [{ id: "m", tool: "Monitor" }] };
    const changed: unknown[] = [];
    const target = { session: { sessionId: "owner" }, records: [original], turn: null, changed: (r: unknown) => changed.push(r) };
    const record = { id: "m", owner: "OWNER", ownerRole: "coordinator", command: "echo ok", cwd: "/tmp", state: "running", wake: "none", stdout: "", stderr: "", detail: "", createdAt: 1 };
    (Bot.prototype as any).monitorState.call(target, record);
    expect(changed).toEqual([original]);
  });
});
