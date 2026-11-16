// @vitest-environment node
// botling.pin-area's program part (src/pins.ts) against a fake Botling API: what bots may do with their tags, how "@card words" is
// rewritten and answered, who may touch which bot's book, and that a restart draws the cards again.
import { describe, expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";
import { activatePins } from "../src/pins";
import * as D from "../src/digest";
import * as M from "../src/model";

type Handler = (data: never) => unknown;
function setup(seed: Record<string, unknown> = {}) {
  const exposed = new Map<string, (params: unknown) => unknown>();
  const events = new Map<string, Handler>();
  const tags = new Map<string, Handler>();
  const hooks: Handler[] = [];
  // storage.json is JSON: what is set is not the same object that is read back
  const stored = new Map<string, unknown>(Object.entries(seed).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
  const setData = vi.fn(async (_botId: string, _data: unknown) => {});
  const decorate = vi.fn(async (_botId: string, _decorations: unknown) => {});
  // the app's bots as workspace.bots lists them (a sub bot names its parent)
  const family: { id: string; parent: string | null; name?: string }[] = [];
  // what workspace.waiting() gives: each bot's open question, or the lines of its memory.md "Waiting on you"
  const waitingItems: { botId: string; text: string; messageId?: string | null }[] = [];
  const api = {
    subscriptions: [] as unknown[],
    storage: { dir: "/s", get: (key: string) => (stored.has(key) ? JSON.parse(JSON.stringify(stored.get(key))) : undefined), set: (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); } },
    chat: { setData, decorate },
    workspace: {
      bots: vi.fn(async () => family.map((bot) => ({ ...bot, name: bot.name ?? bot.id, role: "bot" }))),
      waiting: vi.fn(async () => ({ items: waitingItems.map((item) => ({ messageId: null, ...item })), doing: {} })),
    },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; } },
    events: { on: (event: string, fn: Handler) => { events.set(event, fn); return () => {}; } },
    replyTags: { on: (tag: string, fn: Handler) => { tags.set(tag, fn); return () => {}; } },
    hooks: { beforeSend: (fn: Handler) => { hooks.push(fn); return () => {}; } },
  };
  let clock = 1_000_000;
  const expose = (method: string, fn: (params: Record<string, unknown>) => unknown) => api.ui.expose(method, (params) => fn((params ?? {}) as Record<string, unknown>));
  const subs = activatePins(api as unknown as BotlingApi, expose, () => clock);
  const bot = (id: string) => ({ id, name: id, role: "bot" as const, awake: true });
  const call = (method: string, params: Record<string, unknown>) => exposed.get(method)!(params) as never;
  const emit = (event: string, data: Record<string, unknown>) => events.get(event)!(data as never);
  const tag = (botId: string, name: string, attributes: Record<string, string>, body = "") => tags.get(name)!({ bot: bot(botId), tag: name, attributes, body } as never);
  const send = (botId: string, text: string) => hooks[0]!({ bot: bot(botId), text } as never) as string | false | undefined;
  const book = (botId: string) => M.readBook(stored.get(`pins:${botId}`));
  return { api, subs, exposed, events, tags, hooks, stored, setData, decorate, family, waitingItems, call, emit, tag, send, book, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("the program part", () => {
  it("registers the nine methods, the four events, the two tags and one beforeSend, and `activate` adds them to the plugin's subscriptions", () => {
    const { api, exposed, events, tags, hooks } = setup();
    expect([...exposed.keys()].sort()).toEqual(["collapse", "moveBack", "moveTo", "pinMessage", "repin", "seen", "touch", "unpin", "view"]);
    expect([...events.keys()].sort()).toEqual(["messagePosted", "turnFinished", "turnStarted", "workerDone"]);
    expect([...tags.keys()].sort()).toEqual(["pin-card", "pin-say"]);
    expect(hooks).toHaveLength(1);
    const real = setup();
    real.api.subscriptions.length = 0;
    activate(real.api as unknown as BotlingApi);
    expect(real.api.subscriptions.length).toBeGreaterThanOrEqual(14);
  });

  it("pinMessage makes a user card (running, from the message's first line), draws it, and the same message again is the same card", () => {
    const t = setup();
    const made = t.call("pinMessage", { botId: "B1", messageId: "m1", text: "## 部署計畫\n第二行" });
    expect(made).toEqual({ id: "p-0001" });
    expect(t.call("pinMessage", { botId: "B1", messageId: "m1", text: "## 部署計畫\n第二行" })).toEqual({ id: "p-0001", duplicate: true });
    const pin = t.book("B1").pins[0]!;
    expect([pin.title, pin.origin, pin.state, pin.source, pin.msgRef]).toEqual(["部署計畫", "user", "run", "user", "m1"]);
    expect(t.book("B1").pins).toHaveLength(1);
    const [botId, data] = t.setData.mock.calls.at(-1)!;
    expect(botId).toBe("B1");
    expect((data as M.BookView).pins.map((p) => p.title)).toEqual(["部署計畫"]);
    expect(t.stored.get("pins:bots")).toEqual(["B1"]);
  });

  it("pinMessage with no bot is refused, a message with no words still gets a card titled 釘選, and a full strip says so", () => {
    const t = setup();
    expect(() => t.call("pinMessage", { text: "x" })).toThrow("No bot.");
    t.call("pinMessage", { botId: "B1", text: "" });
    expect(t.book("B1").pins[0]!.title).toBe("釘選");
    for (let n = 0; n < M.MAX_PINS; n++) t.call("pinMessage", { botId: "B2", messageId: `m${n}`, text: `card ${n}` });
    expect(() => t.call("pinMessage", { botId: "B2", messageId: "mx", text: "one more" })).toThrow(/最多釘 8 張/);
  });

  it("keeps each bot's cards to that bot: nothing is drawn or read across bots", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Alpha" });
    t.call("pinMessage", { botId: "B2", messageId: "m1", text: "Beta" });
    expect(t.book("B1").pins.map((pin) => pin.title)).toEqual(["Alpha"]);
    expect(t.book("B2").pins.map((pin) => pin.title)).toEqual(["Beta"]);
    // B2 has a card too, but not Alpha: the words are not routed into any card (no header), whatever else is added
    expect(M.parseAsk(t.send("B2", "@Alpha hello") as string)).toBeNull();
    expect(t.book("B2").pins[0]!.thread).toEqual([]);
    expect(typeof t.send("B1", "@Alpha hello")).toBe("string");
    expect(() => t.call("unpin", { botId: "B2", id: "p-0001", by: "user" })).not.toThrow();
    expect(t.book("B1").pins).toHaveLength(1);
  });
});

describe("what a bot's tags do", () => {
  it("<pin-card> makes a waiting card, rewrites its words in place, and takes it down on unpin; each change is drawn", () => {
    const t = setup();
    t.tag("B1", "pin-card", { id: "build", title: "等你確認", state: "wait" }, "要不要重跑？");
    expect(t.book("B1").pins[0]).toMatchObject({ botKey: "build", state: "wait", status: "要不要重跑？", origin: "bot", source: "bot" });
    expect(t.stored.get("pins:bots")).toEqual(["B1"]);
    t.tick(1000);
    t.tag("B1", "pin-card", { id: "build", state: "run", step: "2/5" }, "重跑中");
    const pin = t.book("B1").pins[0]!;
    expect([pin.state, pin.status, pin.prev, pin.step]).toEqual(["run", "重跑中", "要不要重跑？", { done: 2, total: 5 }]);
    expect((t.setData.mock.calls.at(-1)![1] as M.BookView).pins[0]!.prev).toBe("要不要重跑？");
    const draws = t.setData.mock.calls.length;
    t.tag("B1", "pin-card", { id: "build" }, "重跑中");
    expect(t.setData.mock.calls.length).toBe(draws);
    t.tag("B1", "pin-card", { id: "build", unpin: "yes" });
    expect(t.book("B1").pins).toEqual([]);
    expect(t.book("B1").removed).toHaveLength(1);
  });

  it("drops a card made for a short run, and a tag with an unknown state", () => {
    const t = setup();
    t.tag("B1", "pin-card", { id: "quick", title: "Quick", state: "run", min: "3" }, "soon");
    t.tag("B1", "pin-card", { id: "odd", title: "Odd", state: "banana" }, "x");
    expect(t.stored.has("pins:B1")).toBe(false);
    expect(t.setData).not.toHaveBeenCalled();
  });

  it("only ever touches the book of the bot that wrote it", () => {
    const t = setup();
    t.tag("B1", "pin-card", { id: "k", title: "One", state: "wait" }, "a");
    t.tag("B2", "pin-card", { id: "k", state: "done" }, "hijack");
    t.tag("B2", "pin-card", { id: "k", unpin: "yes" });
    expect(t.book("B1").pins[0]).toMatchObject({ state: "wait", status: "a" });
    expect(t.stored.has("pins:B2")).toBe(false);
  });

  it("a bot can rewrite the status of a user's card by its p-0001 id, and cannot take it down", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m", text: "My task" });
    t.tag("B1", "pin-card", { id: "p-0001", state: "done" }, "做完了");
    t.tag("B1", "pin-card", { id: "p-0001", unpin: "yes" });
    expect(t.book("B1").pins[0]).toMatchObject({ state: "done", status: "做完了", source: "bot", origin: "user" });
  });

  it("stops a bot's tags after 30 in a minute, and takes them again a minute later", () => {
    const t = setup();
    t.tag("B1", "pin-card", { id: "k", title: "Loop", state: "wait" }, "0");
    for (let n = 1; n < 40; n++) t.tag("B1", "pin-card", { id: "k" }, `s${n}`);
    expect(t.book("B1").pins[0]!.status).toBe("s29");
    expect(t.book("B2").pins).toEqual([]);
    t.tag("B2", "pin-card", { id: "k", title: "Other", state: "wait" }, "free");
    expect(t.book("B2").pins).toHaveLength(1);
    t.tick(61_000);
    t.tag("B1", "pin-card", { id: "k" }, "later");
    expect(t.book("B1").pins[0]!.status).toBe("later");
  });

  it("stops a bot's <pin-say> after 30 in a minute too, and takes it again a minute later (review: P5)", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m", text: "Deploy" });
    // nothing waits: each answer is a turn of its own, so the thread counts the tags that got through
    for (let n = 0; n < 40; n++) t.tag("B1", "pin-say", { id: "p-0001" }, `say ${n}`);
    const thread = t.book("B1").pins[0]!.thread;
    expect(thread).toHaveLength(30);
    expect(thread[29]!.a).toBe("say 29");
    t.tick(61_000);
    t.tag("B1", "pin-say", { id: "p-0001" }, "later");
    expect(t.book("B1").pins[0]!.thread.map((turn) => turn.a).at(-1)).toBe("later");
  });

  it("with broken storage reads an empty book and does not throw out of a tag", () => {
    const t = setup({ "pins:B1": "garbage", "pins:bots": "garbage" });
    expect(() => t.tag("B1", "pin-card", { id: "k", title: "T", state: "wait" }, "ok")).not.toThrow();
    expect(t.book("B1").pins).toHaveLength(1);
  });
});

describe("@card words", () => {
  const pinned = () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Deploy" });
    t.tick(5_000);
    return t;
  };

  it("rewrites the message for the bot with the card's header and reply rule, and writes the user's words into the thread", () => {
    const t = pinned();
    const sent = t.send("B1", "@Deploy 先停一下");
    expect(sent).toBe(M.askText(t.book("B1").pins[0]!, "先停一下"));
    expect(sent).toContain("〔Pin p-0001 · Deploy〕\n先停一下");
    const turn = t.book("B1").pins[0]!.thread[0]!;
    expect([turn.q, turn.a, turn.postedAt, turn.seenAt]).toEqual(["先停一下", null, null, null]);
    expect((t.setData.mock.calls.at(-1)![1] as M.BookView).pins[0]!.thread).toHaveLength(1);
  });

  it("leaves every other message alone: no @, an unknown card, nothing after the name, a bot without cards", () => {
    const t = pinned();
    for (const text of ["hello", "@Nobody hi", "@Deploy", "please @Deploy this"]) {
      const sent = t.send("B1", text) as string;
      // not routed: no card header, the user's own words first, only the note of the cards after them
      expect([M.parseAsk(sent), M.stripBriefing(sent)], text).toEqual([null, text]);
    }
    expect(t.send("B9", "@Deploy hi")).toBeUndefined();
    expect(t.book("B1").pins[0]!.thread).toEqual([]);
  });

  it("stops the same words sent twice at once (a double tap), but takes them again 3 seconds later", () => {
    const t = pinned();
    expect(typeof t.send("B1", "@Deploy go")).toBe("string");
    expect(t.send("B1", "@Deploy go")).toBe(false);
    expect(t.book("B1").pins[0]!.thread).toHaveLength(1);
    t.tick(3_000);
    expect(typeof t.send("B1", "@Deploy go")).toBe("string");
    expect(t.book("B1").pins[0]!.thread).toHaveLength(2);
  });

  it("forgets a routed message that never reached the chat, so the next answer is not held for it", () => {
    const t = pinned();
    t.send("B1", "@Deploy lost");
    t.tick(M.UNPOSTED_MS + 1);
    t.send("B1", "@Deploy again");
    expect(t.book("B1").pins[0]!.thread.map((turn) => turn.q)).toEqual(["again"]);
  });

  it("reads no storage for a message to a bot that has no cards: every message passes this hook (review: P1)", () => {
    const t = pinned();
    const get = vi.spyOn(t.api.storage, "get");
    expect(t.send("B9", "@Deploy words")).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(typeof t.send("B1", "@Deploy words")).toBe("string");
    expect(get).toHaveBeenCalledWith("pins:B1");
  });

  it("does not let a message too long to route through (it is sent as it is)", () => {
    const t = pinned();
    expect(t.send("B1", `@Deploy ${"x".repeat(M.MAX_ROUTED + 1)}`)).toBeUndefined();
  });

  it("shows 'line in the chat' when the routed line is posted, 'bot has seen it' when the bot's next turn begins, and the answer from <pin-say>", () => {
    const t = pinned();
    const sent = t.send("B1", "@Deploy status?") as string;
    // another bot's turn, or a turn before the line showed, has seen nothing
    t.emit("turnStarted", { botId: "B1", turnId: "t0" });
    expect(t.book("B1").pins[0]!.thread[0]!.seenAt).toBeNull();
    t.tick(10);
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u1" });
    expect(t.book("B1").pins[0]!.thread[0]!.postedAt).toBe(t.now());
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u1" });
    t.tick(10);
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    expect(t.book("B1").pins[0]!.thread[0]!.seenAt).toBe(t.now());
    t.tick(10);
    t.tag("B1", "pin-say", { id: "p-0001" }, "  還在跑，快好了  ");
    const turn = t.book("B1").pins[0]!.thread[0]!;
    expect([turn.a, turn.aAt]).toEqual(["還在跑，快好了", t.now()]);
    t.tag("B1", "pin-say", { id: "p-0001" }, "a second answer");
    expect(t.book("B1").pins[0]!.thread[0]!.a).toBe("還在跑，快好了");
  });

  it("answers only the card the <pin-say> names, in the book of the bot that wrote it", () => {
    const t = pinned();
    t.call("pinMessage", { botId: "B1", messageId: "m2", text: "Other" });
    const first = t.send("B1", "@Deploy q1") as string;
    const second = t.send("B1", "@Other q2") as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: first, id: "u1" });
    t.emit("messagePosted", { botId: "B1", role: "user", text: second, id: "u2" });
    t.tag("B2", "pin-say", { id: "p-0002" }, "from another bot");
    t.tag("B1", "pin-say", { id: "p-0002" }, "for Other");
    t.tag("B1", "pin-say", { id: "constructor" }, "junk");
    t.tag("B1", "pin-say", {}, "no id");
    const pins = t.book("B1").pins;
    expect([pins[0]!.thread[0]!.a, pins[1]!.thread[0]!.a]).toEqual([null, "for Other"]);
  });

  it("takes a reply with no <pin-say> for the one card waiting, only if its line was in the chat before the turn began", () => {
    const t = pinned();
    const sent = t.send("B1", "@Deploy ok?") as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u1" });
    t.tick(10);
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    t.tick(10);
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "ok, going on" });
    expect(t.book("B1").pins[0]!.thread[0]!.a).toBe("ok, going on");
  });

  it("with the tag in the reply leaves the answer to the tag; a failed turn and an empty reply answer nothing", () => {
    const t = pinned();
    const sent = t.send("B1", "@Deploy ok?") as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u1" });
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: '<pin-say id="p-0001">x</pin-say>' });
    t.emit("turnFinished", { botId: "B1", ok: false, reply: "failed halfway" });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "   " });
    expect(t.book("B1").pins[0]!.thread[0]!.a).toBeNull();
  });

  it("leaves the chat words of a reply that used <pin-say> to the chat, even with another card waiting (review)", () => {
    const t = pinned();
    t.call("pinMessage", { botId: "B1", messageId: "m2", text: "Other" });
    for (const text of ["@Deploy q1", "@Other q2"]) t.emit("messagePosted", { botId: "B1", role: "user", text: t.send("B1", text) as string, id: text });
    t.tick(10);
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    // the core hands the tag over first, then ends the turn with the reply's text without the tag
    t.tag("B1", "pin-say", { id: "p-0001" }, "for Deploy");
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "and a word for the chat" });
    expect(t.book("B1").pins.map((pin) => pin.thread[0]!.a)).toEqual(["for Deploy", null]);
    // the next turn without a tag may take a plain reply again
    t.emit("turnStarted", { botId: "B1", turnId: "t2" });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "for Other" });
    expect(t.book("B1").pins.map((pin) => pin.thread[0]!.a)).toEqual(["for Deploy", "for Other"]);
  });

  it("with two cards waiting, guesses nothing from a plain reply", () => {
    const t = pinned();
    t.call("pinMessage", { botId: "B1", messageId: "m2", text: "Other" });
    for (const text of ["@Deploy q1", "@Other q2"]) t.emit("messagePosted", { botId: "B1", role: "user", text: t.send("B1", text) as string, id: text });
    t.tick(10);
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "which one do you mean?" });
    expect(t.book("B1").pins.map((pin) => pin.thread[0]!.a)).toEqual([null, null]);
  });

  it("the bot's own line posted in the chat is the reply when the turn's reply text is empty", () => {
    const t = pinned();
    const sent = t.send("B1", "@Deploy ok?") as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u1" });
    t.tick(10);
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    t.tick(10);
    t.emit("messagePosted", { botId: "B1", role: "bot", text: "the line from the bot", id: "b1" });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "" });
    expect(t.book("B1").pins[0]!.thread[0]!.a).toBe("the line from the bot");
  });
});

describe("taking down and putting back", () => {
  it("unpin removes a card for the user, `by: seen` only a done one; repin puts the same card back", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Task" });
    expect(() => t.call("unpin", { botId: "B1", id: "p-0001", by: "seen" })).toThrow(/還沒做完/);
    expect(t.book("B1").pins).toHaveLength(1);
    t.tag("B1", "pin-card", { id: "p-0001", state: "done" }, "finished");
    expect(t.call("unpin", { botId: "B1", id: "p-0001", by: "seen" })).toEqual({ removed: { id: "p-0001", title: "Task" }, by: "seen" });
    expect(t.book("B1").pins).toEqual([]);
    expect(t.call("repin", { botId: "B1", id: "p-0001" })).toEqual({ id: "p-0001" });
    expect(t.book("B1").pins[0]).toMatchObject({ title: "Task", state: "done", status: "finished" });
    expect(t.call("unpin", { botId: "B1", id: "p-0001" })).toMatchObject({ by: "user" });
    expect(() => t.call("repin", { botId: "B1", id: "constructor" })).toThrow(/釘不回去/);
    expect(() => t.call("unpin", { botId: "B1", id: "p-0099" })).toThrow(/不在了/);
    expect(() => t.call("unpin", { botId: "B1", id: "__proto__" })).toThrow(/不在了/);
  });

  it("the bot cannot undo what the user took down by its tag, and a card taken down no longer takes a routed message", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Task" });
    t.call("unpin", { botId: "B1", id: "p-0001" });
    t.tag("B1", "pin-card", { id: "p-0001" }, "still here?");
    expect(t.book("B1").pins).toEqual([]);
    expect(t.send("B1", "@Task hi")).toBeUndefined();
  });

  it("seen marks a card's words read once, and says nothing changed after", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Task" });
    t.tick(100);
    t.tag("B1", "pin-card", { id: "p-0001" }, "new words");
    expect((t.call("view", { botId: "B1" }) as M.BookView).pins[0]!.unread).toBe(true);
    expect(t.call("seen", { botId: "B1", id: "p-0001" })).toEqual({ seen: true });
    expect(t.call("seen", { botId: "B1", id: "p-0001" })).toEqual({ unchanged: true });
    expect((t.call("view", { botId: "B1" }) as M.BookView).pins[0]!.unread).toBe(false);
  });
});

describe("after a restart", () => {
  it("draws the cards of every bot that has some, hears their answers, and does nothing for bots without", () => {
    const first = setup();
    first.call("pinMessage", { botId: "B1", messageId: "m1", text: "Alpha" });
    first.call("pinMessage", { botId: "B2", messageId: "m1", text: "Beta" });
    const second = setup(Object.fromEntries(first.stored));
    expect(second.setData.mock.calls.map(([botId]) => botId).sort()).toEqual(["B1", "B2"]);
    const sent = second.send("B1", "@Alpha hi") as string;
    second.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u" });
    second.emit("turnStarted", { botId: "B3", turnId: "t" });
    expect(second.stored.has("pins:B3")).toBe(false);
    expect(second.book("B1").pins[0]!.thread[0]!.postedAt).not.toBeNull();
  });

  it("a chat the app cannot draw to (setData rejects or throws) does not break a save", async () => {
    const t = setup();
    t.setData.mockRejectedValueOnce(new Error("gone"));
    expect(() => t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Alpha" })).not.toThrow();
    t.setData.mockImplementationOnce(() => { throw new Error("sync"); });
    expect(() => t.call("pinMessage", { botId: "B1", messageId: "m2", text: "Beta" })).not.toThrow();
    await Promise.resolve();
    expect(t.book("B1").pins).toHaveLength(2);
  });
});

// ---- Phase 2 ----

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const ended = (botId: string, workerId: string, report = "結果\n細節", status = "completed") => ({ botId, workerId, status, report });

describe("worker news into a card", () => {
  const followed = (t = setup()) => {
    t.tag("B1", "pin-card", { id: "job", title: "Build", state: "run", min: "30", worker: "t-9" }, "審核中");
    t.tick(1_000);
    return t;
  };

  it("a worker the card follows ends a run: the status line is rewritten in place (原本 kept), source app, logged, and drawn", () => {
    const t = followed();
    t.emit("workerDone", ended("B1", "t-9"));
    const pin = t.book("B1").pins[0]!;
    expect([pin.status, pin.prev, pin.source, pin.state]).toEqual(["worker 回報：結果", "審核中", "app", "run"]);
    expect(pin.updates.map((u) => [u.status, u.source])).toEqual([["審核中", "bot"], ["worker 回報：結果", "app"]]);
    const view = t.setData.mock.calls.at(-1)![1] as M.BookView;
    expect([view.pins[0]!.status, view.pins[0]!.source, view.pins[0]!.prev]).toEqual(["worker 回報：結果", "app", "審核中"]);
  });

  it("the same run told twice, a worker no card follows, and a card of no worker change and draw nothing", () => {
    const t = followed();
    t.emit("workerDone", ended("B1", "t-9"));
    const draws = t.setData.mock.calls.length;
    t.emit("workerDone", ended("B1", "t-9"));
    t.emit("workerDone", ended("B1", "t-other"));
    t.emit("workerDone", ended("B7", "t-9"));
    expect(t.setData.mock.calls.length).toBe(draws);
    expect(t.book("B1").pins[0]!.updates).toHaveLength(2);
  });

  it("only the bot that owns the worker is heard: another bot's event with the same task id changes nothing", () => {
    const t = followed();
    t.call("pinMessage", { botId: "B2", messageId: "m1", text: "Theirs" });
    t.emit("workerDone", ended("B2", "t-9", "hijack"));
    expect(t.book("B1").pins[0]!.status).toBe("審核中");
    expect(t.book("B2").pins[0]!.status).toBe("Theirs");
  });

  it("a failed worker turns the card into a waiting one, a stopped one says so, and an interrupted one is told as such", () => {
    const t = followed();
    t.emit("workerDone", ended("B1", "t-9", "tests failed: 3", "failed"));
    expect(t.book("B1").pins[0]).toMatchObject({ state: "wait", status: "worker 失敗：tests failed: 3", source: "app" });
    t.emit("workerDone", ended("B1", "t-9", "", "stopped"));
    expect(t.book("B1").pins[0]!.updates.at(-1)!.status).toBe("worker 已停止");
    t.emit("workerDone", ended("B1", "t-9", "x", "something-new"));
    expect(t.book("B1").pins[0]!.updates.at(-1)!.status).toBe("worker 中斷：x");
  });

  it("a worker that ended before the card named it still lands, once, and only for the bot it belongs to", () => {
    const t = setup();
    t.emit("workerDone", ended("B1", "t-early", "早就好了"));
    t.emit("workerDone", ended("B2", "t-theirs", "別人的"));
    t.tag("B1", "pin-card", { id: "job", title: "Late", state: "run", min: "20", worker: "t-early t-theirs" }, "going");
    const pin = t.book("B1").pins[0]!;
    expect([pin.status, pin.prev, pin.source]).toEqual(["worker 回報：早就好了", "going", "app"]);
    expect(pin.updates).toHaveLength(2);
    t.tag("B1", "pin-card", { id: "job", worker: "t-early" }, "");
    expect(t.book("B1").pins[0]!.updates).toHaveLength(2);
  });

  it("a user's card is followed too when the bot names it by its p-0001 id", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m", text: "My task" });
    t.tag("B1", "pin-card", { id: "p-0001", worker: "t-5" }, "");
    t.emit("workerDone", ended("B1", "t-5", "跑完了"));
    expect(t.book("B1").pins[0]).toMatchObject({ origin: "user", status: "worker 回報：跑完了", prev: "My task", source: "app" });
  });

  it("a card that waits for the user keeps its words: the news only goes into its log", () => {
    const t = setup();
    t.tag("B1", "pin-card", { id: "ask", title: "Ask", state: "wait", worker: "t-1" }, "要選哪一個？");
    t.emit("workerDone", ended("B1", "t-1", "排版完成"));
    const pin = t.book("B1").pins[0]!;
    expect([pin.state, pin.status, pin.updates.at(-1)!.status]).toEqual(["wait", "要選哪一個？", "worker 回報：排版完成"]);
  });

  it("after a restart the links are still there, and a bad worker id in the event is dropped", () => {
    const first = followed();
    const second = setup(Object.fromEntries(first.stored));
    second.emit("workerDone", ended("B1", "../t-9"));
    expect(second.book("B1").pins[0]!.status).toBe("審核中");
    second.emit("workerDone", ended("B1", "t-9", "重開機後"));
    expect(second.book("B1").pins[0]!.status).toBe("worker 回報：重開機後");
  });
});

describe("a sub bot's reply into a card", () => {
  const withSub = (parent: string | null = "B1") => {
    const t = setup();
    t.family.push({ id: "S1", parent }, { id: "B1", parent: null });
    t.tag("B1", "pin-card", { id: "job", title: "Sub work", state: "run", min: "30", worker: "S1" }, "交給 sub bot");
    t.tick(1_000);
    return t;
  };
  const speak = async (t: ReturnType<typeof setup>, botId: string, text: string) => { t.emit("messagePosted", { botId, role: "bot", text, id: "x" }); await flush(); };

  it("its reply rewrites the card's status line (source app) when the sub bot works under the bot whose card follows it", async () => {
    const t = withSub();
    await speak(t, "S1", "分析好了\n共 3 點");
    expect(t.book("B1").pins[0]).toMatchObject({ status: "sub bot 回覆：分析好了", prev: "交給 sub bot", source: "app" });
  });

  it("a bot that is not its parent's child is not followed: the parent is checked at the moment of the news", async () => {
    const t = withSub("B9");
    await speak(t, "S1", "我不是你的");
    expect(t.book("B1").pins[0]!.status).toBe("交給 sub bot");
    const none = withSub(null);
    await speak(none, "S1", "no parent");
    expect(none.book("B1").pins[0]!.status).toBe("交給 sub bot");
  });

  it("fails closed when the app cannot say who is whose child, and when the sub bot says nothing", async () => {
    const t = withSub();
    (t.api.workspace.bots as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await speak(t, "S1", "x");
    expect(t.book("B1").pins[0]!.status).toBe("交給 sub bot");
    await speak(t, "S1", "  ");
    expect(t.book("B1").pins[0]!.status).toBe("交給 sub bot");
  });

  it("a card that stopped following it (the bot linked other ids and the card was unpinned) hears nothing", async () => {
    const t = withSub();
    t.tag("B1", "pin-card", { id: "job", unpin: "yes" });
    await speak(t, "S1", "late");
    expect(t.book("B1").pins).toEqual([]);
  });

  it("its own replies still count as ordinary replies of a bot with no cards: nothing is saved for it", async () => {
    const t = withSub();
    await speak(t, "S1", "hi");
    expect(t.stored.has("pins:S1")).toBe(false);
  });
});

describe("a plain message the bot moves into a card", () => {
  const withCards = () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "Deploy" });
    t.call("pinMessage", { botId: "B1", messageId: "m2", text: "Docs" });
    t.tick(5_000);
    return t;
  };
  /** The user writes `text`; the chat shows the line (id `id`). */
  const plain = (t: ReturnType<typeof setup>, text: string, id = "u1") => {
    const sent = t.send("B1", text) as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id });
    return sent;
  };
  const moveTag = (t: ReturnType<typeof setup>, id: string, body = "還沒好。") => t.tag("B1", "pin-say", { id, move: "yes" }, body);

  it("a plain message of a chat with cards goes to the bot with the note of the cards after the user's words; nothing else changes", () => {
    const t = withCards();
    const sent = t.send("B1", "部署那個好了嗎") as string;
    expect(M.stripBriefing(sent)).toBe("部署那個好了嗎");
    expect(sent).toContain("p-0001「Deploy」進行中");
    expect(sent).toContain("p-0002「Docs」進行中");
    expect(t.book("B1").pins.map((pin) => pin.thread)).toEqual([[], []]);
  });

  it("the note carries no @Name (review probe): a pinned line \"@DAFAWU 看一下\" would otherwise call that bot into the chat with every plain message", () => {
    const t = setup();
    t.call("pinMessage", { botId: "B1", messageId: "m1", text: "@DAFAWU 看一下部署" });
    t.tag("B1", "pin-card", { id: "p-0001" }, "等 @Maintainer 回覆");
    const sent = t.send("B1", "還在嗎 @Codex") as string;
    expect(M.stripBriefing(sent)).toBe("還在嗎 @Codex");
    const note = sent.slice(M.stripBriefing(sent).length);
    expect(note).toContain("＠DAFAWU 看一下部署");
    expect(note).toContain("等 ＠Maintainer 回覆");
    expect(note).not.toContain("@");
  });

  it("leaves a slash command and another plugin's 〔header〕 message exactly as they are", () => {
    const t = withCards();
    expect(t.send("B1", "/陪讀 paper.pdf")).toBeUndefined();
    expect(t.send("B1", "〔陪讀提問 q-0001〕 這句")).toBeUndefined();
  });

  it("<pin-say move=\"yes\"> puts the user's line and the answer into that card (via auto, with the chat line's id), draws it and folds the line behind a trace", () => {
    const t = withCards();
    plain(t, "部署那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001");
    const pin = t.book("B1").pins[0]!;
    expect(pin.thread).toHaveLength(1);
    expect(pin.thread[0]).toMatchObject({ q: "部署那個好了嗎", a: "還沒好。", via: "auto", msgId: "u1" });
    expect(t.book("B1").pins[1]!.thread).toEqual([]);
    const view = t.setData.mock.calls.at(-1)![1] as M.BookView;
    expect(view.pins.find((p) => p.id === "p-0001")!.thread).toHaveLength(1);
    const traces = t.decorate.mock.calls.at(-1)![1] as { key: string; fold?: string[]; data: M.TraceData }[];
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ key: `mv-${pin.thread[0]!.rid}`, fold: ["u1"], data: { kind: "moved", pin: "p-0001", title: "Deploy", by: "bot" } });
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "" });
  });

  it("a line moves once: a second move tag in the same turn, or in a later turn, moves no line (its answer is kept in that card as its own turn)", () => {
    const t = withCards();
    plain(t, "部署那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001");
    moveTag(t, "p-0002", "again");
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "" });
    t.emit("turnStarted", { botId: "B1", turnId: "t2" });
    moveTag(t, "p-0002", "a routine's turn");
    const [deploy, docs] = t.book("B1").pins;
    expect(deploy!.thread.map((turn) => [turn.q, turn.msgId])).toEqual([["部署那個好了嗎", "u1"]]);
    expect(docs!.thread.map((turn) => [turn.q, turn.a, turn.via, turn.msgId])).toEqual([["", "again", "at", undefined], ["", "a routine's turn", "at", undefined]]);
    const traces = t.decorate.mock.calls.at(-1)![1] as unknown[];
    expect(traces).toHaveLength(1);
  });

  it("a wrong card id keeps the line free for the right one in the same turn", () => {
    const t = withCards();
    plain(t, "文件寫好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0099");
    moveTag(t, "constructor");
    expect(t.book("B1").pins.map((pin) => pin.thread.length)).toEqual([0, 0]);
    moveTag(t, "p-0002", "快好了");
    expect(t.book("B1").pins[1]!.thread[0]).toMatchObject({ a: "快好了", msgId: "u1" });
  });

  it("with no plain line behind the turn (none sent, or the turn began for something else) a move tag moves nothing but its answer is not lost, and a plain pin-say still answers an open turn as before", () => {
    const t = withCards();
    t.emit("turnStarted", { botId: "B1", turnId: "t0" });
    moveTag(t, "p-0001");
    // review probe: the core already took the tag out of the reply, so a dropped answer would be gone from the chat and the card
    expect(t.book("B1").pins[0]!.thread.map((turn) => [turn.q, turn.a, turn.via])).toEqual([["", "還沒好。", "at"]]);
    expect(t.decorate).not.toHaveBeenCalled();
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "" });
    const sent = t.send("B1", "@Deploy 先停一下") as string;
    t.emit("messagePosted", { botId: "B1", role: "user", text: sent, id: "u9" });
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    t.tag("B1", "pin-say", { id: "p-0001" }, "好");
    expect(t.book("B1").pins[0]!.thread[1]).toMatchObject({ q: "先停一下", a: "好", via: "at" });
  });

  it("a line that comes while a turn is running waits for its own turn: the running turn cannot take it", () => {
    const t = withCards();
    plain(t, "第一句", "u1");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    plain(t, "第二句", "u2");
    moveTag(t, "p-0001", "答第一句");
    expect(t.book("B1").pins[0]!.thread.map((turn) => [turn.q, turn.msgId])).toEqual([["第一句", "u1"]]);
    t.emit("turnFinished", { botId: "B1", ok: true, reply: "" });
    t.emit("turnStarted", { botId: "B1", turnId: "t2" });
    moveTag(t, "p-0002", "答第二句");
    expect(t.book("B1").pins[1]!.thread.map((turn) => [turn.q, turn.msgId])).toEqual([["第二句", "u2"]]);
  });

  it("only a line that carried the note counts (a worker's report posted as a user line, a routed @ line, are never moved)", () => {
    const t = withCards();
    t.emit("messagePosted", { botId: "B1", role: "user", text: "<app_task_result task_id=\"t\" run=\"1\" status=\"completed\">ok</app_task_result>", id: "w1" });
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001");
    expect(t.book("B1").pins[0]!.thread.filter((turn) => turn.via === "auto" || turn.msgId)).toEqual([]);
  });

  it("移回聊天: the line leaves the card's view, the chat shows the answer under its line, a second tap changes nothing, and only that bot's book is touched", () => {
    const t = withCards();
    plain(t, "部署那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001");
    const rid = t.book("B1").pins[0]!.thread[0]!.rid;
    t.call("pinMessage", { botId: "B2", messageId: "x", text: "Other" });
    expect(t.call("moveBack", { botId: "B2", rid })).toEqual({ unchanged: true });
    expect(t.book("B1").pins[0]!.thread[0]!.moved).toBeUndefined();
    expect(t.call("moveBack", { botId: "B1", rid })).toEqual({ moved: "chat" });
    expect(t.call("moveBack", { botId: "B1", rid })).toEqual({ unchanged: true });
    expect((t.call("view", { botId: "B1" }) as M.BookView).pins[0]!.thread).toEqual([]);
    const traces = t.decorate.mock.calls.at(-1)![1] as { key: string; after?: string; fold?: string[]; data: M.TraceData }[];
    expect(traces[0]).toMatchObject({ key: `mv-${rid}`, after: "u1", data: { kind: "back", a: "還沒好。" } });
    expect(traces[0]!.fold).toBeUndefined();
    // the bot is told, in the next note, that this was a wrong guess
    expect(M.stripBriefing(t.send("B1", "下一句") as string)).toBe("下一句");
    expect(t.send("B1", "下一句")).toContain("最近被使用者更正：「部署那個好了嗎」不是 p-0001「Deploy」，是 聊天");
  });

  it("改到…: the line and its answer go to the other card, marked as the user's choice, the trace follows, and a missing or same card changes nothing", () => {
    const t = withCards();
    plain(t, "文件那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001", "不確定");
    const rid = t.book("B1").pins[0]!.thread[0]!.rid;
    expect(t.call("moveTo", { botId: "B1", rid, to: "p-0001" })).toEqual({ unchanged: true });
    expect(t.call("moveTo", { botId: "B1", rid, to: "p-0099" })).toEqual({ unchanged: true });
    expect(t.call("moveTo", { botId: "B1", rid, to: "__proto__" })).toEqual({ unchanged: true });
    expect(t.call("moveTo", { botId: "B1", rid: "nope", to: "p-0002" })).toEqual({ unchanged: true });
    expect(t.call("moveTo", { botId: "B1", rid, to: "p-0002" })).toEqual({ moved: "p-0002" });
    expect(t.book("B1").pins.map((pin) => pin.thread.length)).toEqual([0, 1]);
    expect(t.book("B1").pins[1]!.thread[0]).toMatchObject({ q: "文件那個好了嗎", a: "不確定", redirected: true, msgId: "u1" });
    const traces = t.decorate.mock.calls.at(-1)![1] as { fold?: string[]; data: M.TraceData }[];
    expect(traces[0]).toMatchObject({ fold: ["u1"], data: { kind: "moved", pin: "p-0002", title: "Docs", by: "user" } });
    expect(t.send("B1", "再一句")).toContain(`不是 p-0001「Deploy」，是 p-0002「Docs」`);
  });

  it("a card taken down gives the lines back to the chat with their answers; 釘回 folds them again", () => {
    const t = withCards();
    plain(t, "部署那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(t, "p-0001");
    t.call("unpin", { botId: "B1", id: "p-0001" });
    expect((t.decorate.mock.calls.at(-1)![1] as { data: M.TraceData }[])[0]!.data.kind).toBe("back");
    t.call("repin", { botId: "B1", id: "p-0001" });
    expect((t.decorate.mock.calls.at(-1)![1] as { data: M.TraceData }[])[0]!.data.kind).toBe("moved");
  });

  it("a chat with no moved line is never asked to draw traces, and a chat that cannot draw them does not break a save", async () => {
    const t = withCards();
    expect(t.decorate).not.toHaveBeenCalled();
    t.decorate.mockImplementation(() => { throw new Error("sync"); });
    plain(t, "部署那個好了嗎");
    t.emit("turnStarted", { botId: "B1", turnId: "t1" });
    expect(() => moveTag(t, "p-0001")).not.toThrow();
    t.decorate.mockRejectedValue(new Error("gone"));
    t.call("unpin", { botId: "B1", id: "p-0002" });
    await flush();
    expect(t.book("B1").pins[0]!.thread).toHaveLength(1);
  });

  it("the moved lines come back after a restart: the traces are drawn again from the book", () => {
    const first = withCards();
    plain(first, "部署那個好了嗎");
    first.emit("turnStarted", { botId: "B1", turnId: "t1" });
    moveTag(first, "p-0001");
    const second = setup(Object.fromEntries(first.stored));
    expect((second.decorate.mock.calls.at(-1)![1] as { fold: string[] }[])[0]!.fold).toEqual(["u1"]);
  });

  it("the briefing carries cards the user pinned and the bot's own, so the bot can route into and update either", () => {
    const t = withCards();
    t.tag("B1", "pin-card", { id: "mine", title: "Bot card", state: "wait" }, "等你確認");
    const sent = t.send("B1", "嗨") as string;
    for (const part of ["p-0001「Deploy」進行中", "p-0003「Bot card」等你 · 等你確認"]) expect(sent).toContain(part);
    t.tag("B1", "pin-card", { id: "p-0001", state: "done" }, "做完了");
    expect(t.book("B1").pins[0]).toMatchObject({ state: "done", status: "做完了", origin: "user" });
  });
});

describe("「你不在時」: the digest of what happened while the user was away", () => {
  const MIN = 60_000;
  type Setup = ReturnType<typeof setup>;
  /** The newest thing a chat was told to draw. */
  const drawn = (t: Setup, botId: string) => [...t.setData.mock.calls].reverse().find(([id]) => id === botId)![1] as D.PinsView;
  /** Bot B1 has a running card; the user is here (a sign of them is on record) and leaves from this moment. */
  async function here() {
    const t = setup();
    t.family.push({ id: "B1", parent: null, name: "botling" }, { id: "B2", parent: null, name: "DAFAWU" });
    t.tag("B1", "pin-card", { id: "k", title: "Deploy", state: "run", min: "30" }, "building");
    t.tick(MIN);
    expect(await t.call("touch", { botId: "B1" })).toEqual({ away: false });
    return t;
  }
  /** The card turns waiting 10 minutes after the user left, and they are back 35 minutes after. */
  async function back(t: Setup) {
    t.tick(10 * MIN);
    t.tag("B1", "pin-card", { id: "k", state: "wait" }, "要你確認");
    t.tick(25 * MIN);
    return t.call("touch", { botId: "B1" });
  }

  it("a sign of the user after 30 minutes opens the digest: the cards that changed meanwhile, counted, for exactly the gap; the view call has it too", async () => {
    const t = await here();
    const left = t.now();
    expect(await back(t)).toEqual({ away: true });
    const away = drawn(t, "B1").away!;
    expect([away.from, away.to, away.collapsed]).toEqual([left, left + 35 * MIN, false]);
    expect(away.counts).toEqual({ wait: 1, run: 0, done: 0 });
    expect(away.rows).toMatchObject([{ id: "p-0001", title: "Deploy", state: "wait", status: "要你確認", source: "bot" }]);
    expect(((await t.call("view", { botId: "B1" })) as D.PinsView).away!.rows).toHaveLength(1);
  });

  it("29 minutes is not away: nothing opens and the chat draws only its cards", async () => {
    const t = await here();
    t.tick(29 * MIN);
    expect(await t.call("touch", { botId: "B1" })).toEqual({ away: false });
    expect(drawn(t, "B1").away).toBeUndefined();
    expect(t.api.workspace.waiting).not.toHaveBeenCalled();
  });

  it("lists other bots' waiting items one line per bot (by name, a bot's own items are not repeated), read through workspace.waiting and never from files", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B2", text: "選一個版本" }, { botId: "B2", text: "再確認日期" }, { botId: "B1", text: "this chat's own" });
    await back(t);
    expect(drawn(t, "B1").away!.others).toEqual([{ botId: "B2", name: "DAFAWU", text: "選一個版本", more: 1 }]);
    expect(t.api.workspace.waiting).toHaveBeenCalledTimes(1);
    expect(t.stored.has("pins:B2")).toBe(false);
    // the same chat from the other bot's side: it waits on B1's items, not its own
    t.waitingItems.push({ botId: "B1", text: "別的 bot 的問題", messageId: "q7" });
    t.tick(31_000);
    await t.call("touch", { botId: "B2" });
    expect(drawn(t, "B2").away!.others).toEqual([{ botId: "B1", name: "botling", text: "this chat's own", more: 1 }]);
  });

  it("an empty \"Waiting on you\" section, or one with only a placeholder, adds no row; with no card changed either, the chat has no digest", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B2", text: "—" }, { botId: "B2", text: "(none)" });
    t.tick(40 * MIN);
    expect(await t.call("touch", { botId: "B1" })).toEqual({ away: true });
    expect(drawn(t, "B1").away).toBeUndefined();
    expect(drawn(t, "B1").pins).toHaveLength(1);
  });

  it("only the other bots' lines are in it when no card of this chat changed", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B2", text: "選一個版本", messageId: "q1" });
    t.tick(40 * MIN);
    await t.call("touch", { botId: "B1" });
    const away = drawn(t, "B1").away!;
    expect([away.rows, away.counts, away.others]).toEqual([[], { wait: 0, run: 0, done: 0 }, [{ botId: "B2", name: "DAFAWU", text: "選一個版本", more: 0, messageId: "q1" }]]);
  });

  it("the next message of the user, in any chat, takes the digest away from every chat and from storage; a later sign does not bring it back", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B1", text: "確認日期" });
    await back(t);
    await t.call("view", { botId: "B2" });
    expect(drawn(t, "B2").away).toBeDefined();
    t.emit("messagePosted", { botId: "B2", role: "user", text: "hi", id: "u1" });
    expect(drawn(t, "B1").away).toBeUndefined();
    expect(drawn(t, "B2").away).toBeUndefined();
    expect(t.stored.get("presence")).toMatchObject({ away: null });
    t.tick(MIN);
    expect(await t.call("touch", { botId: "B1" })).toEqual({ away: false });
    expect(drawn(t, "B1").away).toBeUndefined();
  });

  it("a bot's own line is not the user's message: the digest stays", async () => {
    const t = await here();
    await back(t);
    t.emit("messagePosted", { botId: "B1", role: "bot", text: "好了", id: "b1" });
    expect(drawn(t, "B1").away).toBeDefined();
  });

  it("看完了 folds it in every chat and in storage, the same again changes nothing, and the chip's reopen opens it again", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B1", text: "確認日期" });
    await back(t);
    await t.call("view", { botId: "B2" });
    expect(t.call("collapse", { collapsed: true })).toEqual({ collapsed: true });
    expect(drawn(t, "B1").away!.collapsed).toBe(true);
    expect(drawn(t, "B2").away!.collapsed).toBe(true);
    expect((t.stored.get("presence") as D.Presence).away!.collapsed).toBe(true);
    const draws = t.setData.mock.calls.length;
    expect(t.call("collapse", { collapsed: true })).toEqual({ unchanged: true });
    expect(t.setData.mock.calls).toHaveLength(draws);
    expect(t.call("collapse", { collapsed: false })).toEqual({ collapsed: false });
    expect(drawn(t, "B1").away!.collapsed).toBe(false);
  });

  it("with no digest open, 看完了 changes nothing", async () => {
    const t = await here();
    expect(t.call("collapse", { collapsed: true })).toEqual({ unchanged: true });
    expect(t.stored.has("presence")).toBe(false);
  });

  it("a digest open (even folded) is still there after a restart, with the same range; the other bots' lines come back with the next sign of the user", async () => {
    const first = await here();
    await back(first);
    first.call("collapse", { collapsed: true });
    const second = setup(Object.fromEntries(first.stored));
    second.family.push({ id: "B2", parent: null, name: "DAFAWU" });
    second.waitingItems.push({ botId: "B2", text: "選一個版本" });
    const away = drawn(second, "B1").away!;
    expect([away.collapsed, away.rows.length, away.others]).toEqual([true, 1, []]);
    expect(await second.call("touch", { botId: "B1" })).toEqual({ away: true });
    expect(second.api.workspace.waiting).toHaveBeenCalledTimes(1);
    expect(drawn(second, "B1").away!.others).toHaveLength(1);
  });

  it("other bots' lines are read again only when 30 seconds old, so an item the user dealt with goes", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B2", text: "選一個版本" });
    await back(t);
    t.waitingItems.length = 0;
    t.tick(10_000);
    await t.call("touch", { botId: "B1" });
    expect(t.api.workspace.waiting).toHaveBeenCalledTimes(1);
    expect(drawn(t, "B1").away!.others).toHaveLength(1);
    t.tick(25_000);
    await t.call("touch", { botId: "B1" });
    expect(t.api.workspace.waiting).toHaveBeenCalledTimes(2);
    expect(drawn(t, "B1").away!.others).toEqual([]);
  });

  it("when the app cannot say what waits (it throws, or has no such call), the digest still shows the cards and no line of other bots", async () => {
    const t = await here();
    t.waitingItems.push({ botId: "B2", text: "選一個版本" });
    (t.api.workspace.waiting as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await back(t);
    expect(drawn(t, "B1").away).toMatchObject({ others: [], rows: [{ title: "Deploy" }] });
    const bare = await here();
    delete (bare.api.workspace as { waiting?: unknown }).waiting;
    await back(bare);
    expect(drawn(bare, "B1").away!.others).toEqual([]);
  });

  it("writes the presence at most every 5 minutes (storage.json is rewritten whole), and at once when a digest opens", async () => {
    const t = setup();
    await t.call("touch", { botId: "B1" });
    t.tick(MIN);
    await t.call("touch", { botId: "B1" });
    expect(t.stored.has("presence")).toBe(false);
    t.tick(5 * MIN);
    await t.call("touch", { botId: "B1" });
    expect((t.stored.get("presence") as D.Presence).lastPresent).toBe(t.now());
    t.tick(40 * MIN);
    await t.call("touch", { botId: "B1" });
    expect((t.stored.get("presence") as D.Presence).away).toMatchObject({ collapsed: false });
  });

  it("a touch names its bot; a presence in storage that is garbage is none", async () => {
    const t = setup({ presence: "garbage" });
    await expect(t.call("touch", {})).rejects.toThrow("No bot.");
    expect(await t.call("touch", { botId: "B1" })).toEqual({ away: false });
  });
});
