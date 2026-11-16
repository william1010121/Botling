// M7-S60b (S59 review F1): the collection writes that callers made straight on another collaborator's field are named transitions on the
// owner now: `BotSubagentRows.queueNote` -> `BotDelivery.queueNote`, `BotWorkers.endTaskHandoff` / `takeManagedHandback`,
// `BotGuests.offerPicks` / `forgetPicks`, `BotGroup.dropPartner`, `BotSubagentRows.markDirty`. Each writes its one field and no other.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { BotSubagentRows } from "../../src/core/bot/subagent-rows";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => { for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {}); });

function make(engine: "claude" | "codex" = "claude") {
  const folder = tempDir("bot-owner-writes"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", heads: { engines: [engine], answerWith: engine } }));
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit() {}, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  return b;
}

describe("BotSubagentRows.queueNote hands the note to the primary's delivery, and only while its head runs", () => {
  it("a running head keeps the note on the delivery, a later note replaces it", () => {
    const b = make();
    b.headRun.head = { running: true } as any;
    b.subagentRowBook.queueNote("first");
    expect(b.delivery.queuedNote).toBe("first");
    b.subagentRowBook.queueNote("second");
    expect(b.delivery.queuedNote).toBe("second");
  });

  it("no running head: the note is dropped (an asleep bot reads it all at its wake)", () => {
    const b = make();
    b.headRun.head = { running: false } as any;
    b.subagentRowBook.queueNote("lost");
    expect(b.delivery.queuedNote).toBeNull();
    b.headRun.head = null;
    b.subagentRowBook.queueNote("lost too");
    expect(b.delivery.queuedNote).toBeNull();
  });

  it("with a primary the note goes to the primary, not to the bot that holds the rows", () => {
    const primary = make(), other = make();
    primary.headRun.head = { running: true } as any;
    other.headRun.head = { running: true } as any;
    BotSubagentRows.prototype.queueNote.call({ options: { primary }, host: other } as any, "for the primary");
    expect(primary.delivery.queuedNote).toBe("for the primary");
    expect(other.delivery.queuedNote).toBeNull();
    BotSubagentRows.prototype.queueNote.call({ options: {}, host: other } as any, "for itself");
    expect(other.delivery.queuedNote).toBe("for itself");
    expect(primary.delivery.queuedNote).toBe("for the primary");
  });
});

describe("BotWorkers: endTaskHandoff and takeManagedHandback", () => {
  it("endTaskHandoff forgets the worker's hand-off and says which it was; an unknown worker changes nothing", () => {
    const w = make("codex").workers;
    w.managedTaskHandoffs.set("t1", "h1"); w.managedTaskHandoffs.set("t2", "h2");
    expect(w.endTaskHandoff("t1")).toBe("h1");
    expect([...w.managedTaskHandoffs]).toEqual([["t2", "h2"]]);
    expect(w.endTaskHandoff("nope")).toBeUndefined();
    expect([...w.managedTaskHandoffs]).toEqual([["t2", "h2"]]);
  });

  it("takeManagedHandback says whether that hand-off waited for its worker's report, and takes only it", () => {
    const w = make("codex").workers;
    w.managedHandbacks.add("h1"); w.managedHandbacks.add("h2");
    expect(w.takeManagedHandback("h1")).toBe(true);
    expect(w.takeManagedHandback("h1")).toBe(false);
    expect([...w.managedHandbacks]).toEqual(["h2"]);
    expect(w.managedTaskHandoffs.size).toBe(0);
  });
});

describe("the other owners", () => {
  it("BotGuests.offerPicks keeps the card's picks; forgetPicks takes back that card only", () => {
    const g = make().guests;
    g.offerPicks("m1", [{ kind: "a" } as any]); g.offerPicks("m2", [{ kind: "b" } as any]);
    expect([...g.cardPicks.keys()]).toEqual(["m1", "m2"]);
    g.offerPicks("m1", [{ kind: "c" } as any]);
    expect(g.cardPicks.get("m1")).toEqual([{ kind: "c" }]);
    g.forgetPicks("m1"); g.forgetPicks("never-there");
    expect([...g.cardPicks.keys()]).toEqual(["m2"]);
  });

  it("BotGroup.dropPartner forgets that engine's partner only", () => {
    const g = make().group;
    const claude = {} as Bot, codex = {} as Bot;
    g.partners.set("claude", claude); g.partners.set("codex", codex);
    g.dropPartner("codex"); g.dropPartner("agy");
    expect([...g.partners]).toEqual([["claude", claude]]);
  });

  it("BotSubagentRows.markDirty adds that subagent to the rows the next push sends", () => {
    const rows = make().subagentRowBook;
    rows.markDirty("s1"); rows.markDirty("s2"); rows.markDirty("s1");
    expect([...rows.dirtySubagents]).toEqual(["s1", "s2"]);
  });
});

describe("HeadEvents: the report of a worker that owns a hand-off goes back as that hand-off's reply", () => {
  function report(taskId: string | undefined, setup: (w: Bot["workers"]) => void) {
    const b = make("codex") as any;
    const turn: any = { ended: [], conducted: false, handoffId: null };
    vi.spyOn(b, "backgroundTurn").mockReturnValue(turn);
    vi.spyOn(b.workers, "relayIfCallInWork").mockImplementation(() => {});
    setup(b.workers);
    b.onItem({} as any, { kind: "backgroundTurn", taskId });
    return { turn, w: b.workers as Bot["workers"] };
  }

  it("a hand-off that waits for its hand-back: the turn is conducted for it, and both routes are used up", () => {
    const { turn, w } = report("t1", (workers) => { workers.managedTaskHandoffs.set("t1", "h1"); workers.managedTaskHandoffs.set("t2", "h2"); workers.managedHandbacks.add("h1"); workers.managedHandbacks.add("h2"); });
    expect(turn.ended).toEqual(["t1"]);
    expect(turn.conducted).toBe(true);
    expect(turn.handoffId).toBe("h1");
    expect([...w.managedTaskHandoffs]).toEqual([["t2", "h2"]]);
    expect([...w.managedHandbacks]).toEqual(["h2"]);
  });

  it("a hand-off that no hand-back waits for: the worker's route is dropped, the turn is not conducted", () => {
    const { turn, w } = report("t1", (workers) => { workers.managedTaskHandoffs.set("t1", "h1"); });
    expect(turn.ended).toEqual(["t1"]);
    expect(turn.conducted).toBe(false);
    expect(turn.handoffId).toBeNull();
    expect(w.managedTaskHandoffs.size).toBe(0);
  });

  it("a worker that owns no hand-off, or a report with no worker id, leaves every route alone", () => {
    const a = report("t9", (workers) => { workers.managedTaskHandoffs.set("t1", "h1"); workers.managedHandbacks.add("h1"); });
    expect(a.turn.conducted).toBe(false);
    expect([...a.w.managedTaskHandoffs]).toEqual([["t1", "h1"]]);
    expect([...a.w.managedHandbacks]).toEqual(["h1"]);
    const b = report(undefined, (workers) => { workers.managedTaskHandoffs.set("t1", "h1"); workers.managedHandbacks.add("h1"); });
    expect(b.turn.ended).toEqual([]);
    expect(b.turn.conducted).toBe(false);
    expect([...b.w.managedHandbacks]).toEqual(["h1"]);
  });
});
