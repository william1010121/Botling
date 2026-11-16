// @vitest-environment node
// botling.pin-area's program part (src/pins.ts) against a fake Botling API: what bots may do with their tags, how "@card words" is
// rewritten and answered, who may touch which bot's book, and that a restart draws the cards again.
import { describe, expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";
import { activatePins } from "../src/pins";
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
  const api = {
    subscriptions: [] as unknown[],
    storage: { dir: "/s", get: (key: string) => (stored.has(key) ? JSON.parse(JSON.stringify(stored.get(key))) : undefined), set: (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); } },
    chat: { setData },
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
  return { api, subs, exposed, events, tags, hooks, stored, setData, call, emit, tag, send, book, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("the program part", () => {
  it("registers the five methods, the three events, the two tags and one beforeSend, and `activate` adds them to the plugin's subscriptions", () => {
    const { api, exposed, events, tags, hooks } = setup();
    expect([...exposed.keys()].sort()).toEqual(["pinMessage", "repin", "seen", "unpin", "view"]);
    expect([...events.keys()].sort()).toEqual(["messagePosted", "turnFinished", "turnStarted"]);
    expect([...tags.keys()].sort()).toEqual(["pin-card", "pin-say"]);
    expect(hooks).toHaveLength(1);
    const real = setup();
    real.api.subscriptions.length = 0;
    activate(real.api as unknown as BotlingApi);
    expect(real.api.subscriptions.length).toBeGreaterThanOrEqual(10);
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
    expect(t.send("B2", "@Alpha hello")).toBeUndefined();
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
    for (const text of ["hello", "@Nobody hi", "@Deploy", "please @Deploy this"]) expect(t.send("B1", text), text).toBeUndefined();
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
