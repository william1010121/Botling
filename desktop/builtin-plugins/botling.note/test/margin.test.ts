// botling.note, margin comments (旁註), program part (src/margin.ts): a question goes to the bot as a message of the plugin, the answer is read
// back from the bot's reply, and everything is kept in plugin storage: never in the note, never through notes.write.
import { describe, expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { MAX_THREADS, activateMargin, askText, readBook, splitReply } from "../src/margin";

type Handler = (data: never) => void;

function setup(opts: { send?: () => Promise<unknown>; stored?: Map<string, unknown>; start?: number } = {}) {
  const exposed = new Map<string, (params: unknown) => unknown>();
  const events = new Map<string, Handler>();
  const stored = opts.stored ?? new Map<string, unknown>();
  let clock = opts.start ?? 1_000;
  const api = {
    notes: { read: vi.fn(), write: vi.fn(), outline: vi.fn() },
    bots: { send: vi.fn(opts.send ?? (async () => ({ messageId: "msg-1" }))) },
    storage: { dir: "/s", get: (key: string) => stored.get(key), set: (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); } },
    ui: { emit: vi.fn() },
    events: { on: (event: string, fn: Handler) => { events.set(event, fn); return () => {}; } },
  };
  const expose = (method: string, fn: (params: Record<string, unknown>) => unknown) => { exposed.set(method, fn as (params: unknown) => unknown); return () => {}; };
  activateMargin(api as unknown as BotlingApi, expose, () => clock);
  const call = (method: string, params: Record<string, unknown> = {}) => exposed.get(method)!({ botId: "B1", ...params }) as Promise<any>;
  const fire = (name: string, data: Record<string, unknown>) => (events.get(name) as unknown as (d: unknown) => void)(data);
  const tick = (ms = 10) => { clock += ms; };
  return { api, call, fire, stored, tick, exposed, events };
}

const ANCHOR = { cell: "b7k3f9", label: "Note #b7k3f9 · Loading › Lazy load", kind: "text", scope: "selection", quote: "標籤相同就視為同一版" };
const ask = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => s.call("marginAsk", { rid: "r1", question: "為什麼？", anchor: ANCHOR, ...extra });
const book = (s: ReturnType<typeof setup>) => readBook(s.stored.get("margin:B1"));

describe("asking", () => {
  it("sends one message of the plugin (no `as: user`, so no permission is widened), keeps the thread beside the note, and never touches the note", async () => {
    const s = setup();
    const r = await ask(s);
    expect(r.thread).toMatchObject({ id: "c-0001", answering: true, folded: false, anchor: { cell: "b7k3f9", kind: "text", scope: "selection" } });
    expect(s.api.bots.send).toHaveBeenCalledTimes(1);
    const [bot, text, ...rest] = s.api.bots.send.mock.calls[0] as unknown as [string, string];
    expect(bot).toBe("B1");
    expect(rest).toEqual([]); // no options: not as the user
    expect(text).toContain("〔Note 旁註 c-0001〕");
    expect(text).toContain("> 〔Note #b7k3f9 · Loading › Lazy load〕\n> 標籤相同就視為同一版");
    expect(text).toContain("問題：\n為什麼？");
    expect(text).toContain("〔回答 c-0001〕");
    expect(text).toContain("app_note_read 讀 #b7k3f9");
    expect(book(s).threads).toHaveLength(1);
    expect(s.api.notes.write).not.toHaveBeenCalled();
    expect(s.api.notes.read).not.toHaveBeenCalled();
    expect(s.api.ui.emit).toHaveBeenCalledWith("marginChanged", { botId: "B1" }, { botId: "B1" });
  });

  it("a retry with the same request id (a double tap) is answered with the same thread and sends nothing again", async () => {
    const s = setup();
    await ask(s);
    const again = await ask(s);
    expect(again.duplicate).toBe(true);
    expect(s.api.bots.send).toHaveBeenCalledTimes(1);
    expect(book(s).threads).toHaveLength(1);
  });

  it("a message that cannot be sent leaves nothing waiting and says why", async () => {
    const s = setup({ send: async () => { throw new Error("No such bot."); } });
    await expect(ask(s)).rejects.toThrow("沒能把問題送給 bot：No such bot.");
    expect(book(s).threads).toEqual([]);
    expect(await s.call("marginList")).toEqual({ threads: [] });
    // and the bot's next reply is not taken for an answer
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕 hi" });
    expect(book(s).threads).toEqual([]);
  });

  it("refuses an empty question, an anchor without a quote, a bad request id and a bot-less call; control characters are dropped", async () => {
    const s = setup();
    await expect(ask(s, { question: "  " })).rejects.toThrow("空的");
    await expect(ask(s, { anchor: { ...ANCHOR, quote: " " } })).rejects.toThrow("沒有可以掛旁註的引用");
    await expect(ask(s, { anchor: { ...ANCHOR, kind: "constructor" } })).rejects.toThrow("沒有可以掛旁註的引用");
    await expect(ask(s, { rid: "../x" })).rejects.toThrow("編號");
    await expect(s.exposed.get("marginList")!({}) as Promise<unknown>).rejects.toThrow("No bot.");
    const r = await ask(s, { question: "a\u0000b\u001bc\r\nd", anchor: { ...ANCHOR, label: "Note #x\nline2", cell: "has space" } });
    expect(r.thread.turns[0].q).toBe("abc\nd");
    expect(r.thread.anchor.label).toBe("Note #x line2");
    expect(r.thread.anchor.cell).toBe("");
  });

  it("holds at most MAX_THREADS comments", async () => {
    const stored = new Map<string, unknown>();
    const threads = Array.from({ length: MAX_THREADS }, (_, i) => ({ id: `c-${String(i + 1).padStart(4, "0")}`, anchor: ANCHOR, turns: [{ rid: `r${i}`, q: "q", a: "a", qAt: 1, aAt: 2, seenAt: null }], folded: false, created: 1, updated: 2 }));
    stored.set("margin:B1", { seq: MAX_THREADS, threads });
    const s = setup({ stored });
    await expect(ask(s, { rid: "new" })).rejects.toThrow(`最多 ${MAX_THREADS} 則`);
    expect(s.api.bots.send).not.toHaveBeenCalled();
  });
});

describe("the answer coming back", () => {
  it("is taken from the reply that names the question; the tag is cut off and the thread says it is answered", async () => {
    const s = setup();
    await ask(s);
    s.fire("turnStarted", { botId: "B1", turnId: "t1" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕\n因為標籤沒變。" });
    const list = await s.call("marginList");
    expect(list.threads[0]).toMatchObject({ answering: false, turns: [{ q: "為什麼？", a: "因為標籤沒變。" }] });
    expect(book(s).threads[0].turns[0].a).toBe("因為標籤沒變。");
    expect(s.api.ui.emit).toHaveBeenLastCalledWith("marginChanged", { botId: "B1" }, { botId: "B1" });
    expect(s.api.notes.write).not.toHaveBeenCalled();
  });

  it("without a tag, the only question waiting takes the reply, but only one whose line was in the chat before the turn began", async () => {
    const s = setup();
    await ask(s);
    s.tick(5);
    // the turn began before the question's line showed in the chat: it is some other turn's reply
    s.fire("turnStarted", { botId: "B1", turnId: "t0" });
    s.tick(5);
    s.fire("messagePosted", { botId: "B1", role: "user", text: "〔Note 旁註 c-0001〕使用者在 Note 上選了一段", id: "m1" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "別的回答" });
    expect((await s.call("marginList")).threads[0].answering).toBe(true);
    // a turn that begins after the line showed answers it
    s.tick(5);
    s.fire("turnStarted", { botId: "B1", turnId: "t1" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "這是它的回答" });
    expect((await s.call("marginList")).threads[0]).toMatchObject({ answering: false, turns: [{ a: "這是它的回答" }] });
  });

  it("with two questions waiting, an untagged reply answers neither; a tagged one answers only the one it names", async () => {
    const s = setup();
    await ask(s);
    await ask(s, { rid: "r2", question: "第二個問題" });
    s.tick(5);
    s.fire("turnStarted", { botId: "B1", turnId: "t1" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "沒有標籤的回答" });
    expect((await s.call("marginList")).threads.map((t: { answering: boolean }) => t.answering)).toEqual([true, true]);
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0002〕\n第二個的回答" });
    const after = (await s.call("marginList")).threads;
    expect(after.map((t: { answering: boolean }) => t.answering)).toEqual([true, false]);
    expect(after[1].turns[0].a).toBe("第二個的回答");
  });

  it("ignores a failed turn, an empty reply, another bot, and a tag that names nothing waiting", async () => {
    const s = setup();
    await ask(s);
    s.fire("turnFinished", { botId: "B1", ok: false, reply: "〔回答 c-0001〕 x" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕" });
    s.fire("turnFinished", { botId: "B2", ok: true, reply: "〔回答 c-0001〕 other bot" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0099〕 nobody" });
    expect((await s.call("marginList")).threads[0].answering).toBe(true);
  });

  it("is still heard after the app restarted (the bots with a question waiting are kept in storage)", async () => {
    const first = setup();
    await ask(first);
    const second = setup({ stored: first.stored });
    second.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕 after restart" });
    expect((await second.call("marginList")).threads[0].turns[0].a).toBe("after restart");
  });

  it("a reply that arrives for a thread the user deleted is dropped", async () => {
    const s = setup();
    await ask(s);
    await s.call("marginDelete", { id: "c-0001" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕 late" });
    expect(book(s).threads).toEqual([]);
  });
});

describe("follow-ups, folding, cancelling and deleting", () => {
  it("a follow-up goes on the same thread (one at a time, never before the answer) and asks the bot again with the quote", async () => {
    const s = setup();
    await ask(s);
    await expect(s.call("marginAsk", { rid: "r2", id: "c-0001", question: "再問" })).rejects.toThrow("還在回答中");
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕 first" });
    const r = await s.call("marginAsk", { rid: "r2", id: "c-0001", question: "那 bundle id 呢？" });
    expect(r.thread).toMatchObject({ id: "c-0001", answering: true });
    expect(r.thread.turns.map((t: { q: string }) => t.q)).toEqual(["為什麼？", "那 bundle id 呢？"]);
    const text = (s.api.bots.send.mock.calls[1] as unknown as [string, string])[1];
    expect(text).toContain("〔Note 旁註 c-0001 · 追問〕");
    expect(text).toContain("> 標籤相同就視為同一版");
    expect(text).toContain("問題：\n那 bundle id 呢？");
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0001〕 second" });
    expect(book(s).threads[0].turns.map((t) => t.a)).toEqual(["first", "second"]);
    await expect(s.call("marginAsk", { rid: "r3", id: "constructor", question: "x" })).rejects.toThrow("已經不在了");
    await expect(s.call("marginAsk", { rid: "r3", id: "c-0009", question: "x" })).rejects.toThrow("已經不在了");
  });

  it("fold is kept, cancel drops the unanswered question (the thread too when it was the only one), delete removes a thread", async () => {
    const s = setup();
    await ask(s);
    await s.call("marginCancel", { id: "c-0001" });
    expect(book(s).threads).toEqual([]);
    await ask(s, { rid: "r2" });
    s.fire("turnFinished", { botId: "B1", ok: true, reply: "〔回答 c-0002〕 a" });
    await s.call("marginFold", { id: "c-0002", folded: true });
    expect(book(s).threads[0].folded).toBe(true);
    // cancel on an answered thread keeps it
    await s.call("marginCancel", { id: "c-0002" });
    expect(book(s).threads).toHaveLength(1);
    await s.call("marginDelete", { id: "c-0002" });
    expect(book(s).threads).toEqual([]);
    await expect(s.call("marginDelete", { id: "c-0002" })).rejects.toThrow("已經不在了");
  });
});

describe("what is stored and sent", () => {
  it("readBook keeps only well-formed threads and the next id never goes back", () => {
    const b = readBook({ seq: 3, threads: [
      { id: "c-0007", anchor: ANCHOR, turns: [{ rid: "a", q: "q", a: null, qAt: 1, aAt: null, seenAt: null }], folded: true, created: 1, updated: 1 },
      { id: "c-0007", anchor: ANCHOR, turns: [{ rid: "b", q: "dup", a: null }] },
      { id: "x-1", anchor: ANCHOR, turns: [{ rid: "a", q: "q" }] },
      { id: "c-0008", anchor: { ...ANCHOR, quote: "" }, turns: [{ rid: "a", q: "q" }] },
      { id: "c-0009", anchor: ANCHOR, turns: [] },
      "junk", null,
    ] });
    expect(b.threads.map((t) => t.id)).toEqual(["c-0007"]);
    expect(b.seq).toBe(7);
    expect(readBook(null)).toEqual({ seq: 0, threads: [] });
    expect(readBook({ threads: "no" })).toEqual({ seq: 0, threads: [] });
  });

  it("splitReply finds every id a reply names and strips the tags", () => {
    expect(splitReply("〔回答 c-0001〕\nhello 〔回答 c-0002〕 world")).toEqual({ ids: ["c-0001", "c-0002"], body: "hello  world" });
    expect(splitReply("plain")).toEqual({ ids: [], body: "plain" });
  });

  it("the message names the scope and tells the bot where to answer", () => {
    const thread = { id: "c-0004", anchor: { ...ANCHOR, cell: "", label: "", scope: "note" as const, kind: "cell" as const, quote: "line one\n\nline two" }, turns: [{ rid: "r", q: "Q?", a: null, qAt: 1, aAt: null, seenAt: null }], folded: false, created: 1, updated: 1 };
    const text = askText(thread, 0);
    expect(text).toContain("> line one\n>\n> line two");
    expect(text).toContain("範圍：整份 Note");
    expect(text).not.toContain("app_note_read");
    expect(text).toContain("第一行只寫 〔回答 c-0004〕");
  });
});
