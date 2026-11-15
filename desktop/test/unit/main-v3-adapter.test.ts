// Botling 3's window main (src/main-v3, M1 step 11): the renderer adapter between the front-end link and the 2.x
// renderer, run headless. The "renderer" here is the real renderer store (renderer/store.ts WorkspaceStore): it takes
// its snapshots and history pages from the adapter and applies every event the adapter emits, resyncing on a new epoch
// or a seq gap exactly as the window does. The server is the fe-link test's fake botlingd (real slot rules).
import { afterEach, describe, expect, it } from "vitest";
import type { BotView, Command, CommandType, EventEnvelope, MessageView, ResultOf } from "../../src/contract";
import { COMMAND_ROUTES } from "../../src/server/intents/commands";
import { SlotRefusal } from "../../src/server/slots";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { INTERRUPTED_NOTE, type Message, type StreamId } from "../../src/protocol";
import { WorkspaceStore } from "../../src/renderer/store";
import { NOTICE_ID, READ_COMMANDS, RendererAdapter, noticeText, pendingLineId } from "../../src/main-v3/renderer-adapter";
import { BOT, FakeClock, FakeServer, flush } from "./fe-link-harness";
import type { StreamItem } from "../../src/core/agent/stream";
import { headTurnContent } from "../../src/core/head-turn";
import { parseHeadTags } from "../../src/core/heads";
import { parseReply } from "../../src/core/reply";
import { hasVisibleContent, ReplyText } from "../../src/core/worker-core";

const bot = { id: "b1", name: "B1", role: "main", avatar: "circle", folder: "/p", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null } as unknown as BotView;
const line = (id: string, text = `line ${id}`, over: Partial<MessageView> = {}): MessageView => ({ id, role: "bot", text, time: new Date(2026, 0, 1).toISOString(), ...over });

/** The chat's lines as the server's log has them (message.* entries folded). */
function linesOf(server: FakeServer, stream: string): MessageView[] {
  const lines = new Map<string, MessageView>();
  for (const entry of server.entries(stream)) {
    const body = entry.body as { message?: MessageView; messageId?: string };
    if (entry.kind === "message.added" || entry.kind === "message.updated") lines.set(body.message!.id, body.message!);
    if (entry.kind === "message.removed") lines.delete(body.messageId!);
  }
  return [...lines.values()];
}

interface Rig {
  server: FakeServer;
  clock: FakeClock;
  link: FeLink;
  adapter: RendererAdapter;
  store: WorkspaceStore;
  events: EventEnvelope[];
  reqs: Command[];
  ids(): string[];
  chat(): MessageView[];
}

const opened: Array<{ link: FeLink; adapter: RendererAdapter }> = [];
afterEach(async () => {
  for (const { link, adapter } of opened.splice(0)) { adapter.stop(); await link.stop(); }
});

let epochs = 0;
async function rig(setup: (server: FakeServer) => void = () => undefined, options: { snapPage?: number } = {}): Promise<Rig> {
  const server = new FakeServer();
  const clock = new FakeClock();
  const reqs: Command[] = [];
  const page = options.snapPage ?? 1_000;
  server.snapView = (stream) => {
    const all = linesOf(server, stream);
    const messages = all.slice(-page);
    return { bot: null, messages, history: { hasMore: all.length > messages.length, older: all.length - messages.length }, cards: [] };
  };
  server.applyHook = ({ tx, slot, cmd, log }) => {
    if (cmd.type === "chat.send") {
      if (cmd.text === "refuse me") throw new SlotRefusal("scope", "not here");
      const id = `u-${slot.n}`;
      log.appendEntry(tx, `bot:${cmd.botId}` as StreamId, "message.added", { botId: cmd.botId, message: { id, role: "user", text: cmd.text, time: new Date(2026, 0, 2).toISOString() } }, slot);
      return { result: { messageId: id, turnId: null } };
    }
    if (cmd.type === "chat.react" && cmd.emoji === "✗") throw new SlotRefusal("changed", "gone");
    return { result: { n: slot.n } };
  };
  server.onMessage = (message: Message) => {
    if (message.t === "req") {
      reqs.push(message.cmd);
      if (message.cmd.type === "chat.snapshot") {
        const result = {
          epoch: "server", seq: 0, bots: [bot], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
          chat: { botId: "b1", messages: linesOf(server, BOT).slice(-page), running: null, live: [], runs: [], heads: null },
        };
        server.send({ t: "res", req: message.req, ok: true, result });
      } else server.send({ t: "res", req: message.req, ok: true, result: { read: message.cmd.type } });
    }
    if (message.t === "history") {
      const all = linesOf(server, message.stream);
      const at = all.findIndex((m) => m.id === message.before);
      const messages = all.slice(Math.max(0, at - 2), at);
      const older = Math.max(0, at - 2);
      server.send({ t: "history.page", req: message.req, stream: message.stream, logId: server.log.current(message.stream), messages, hasMore: older > 0, older });
    }
  };
  setup(server);
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0") });
  const events: EventEnvelope[] = [];
  let store!: WorkspaceStore;
  let n = 0;
  const adapter = new RendererAdapter({ link, clock, newEpoch: () => `e${++n}`, emit: (envelope) => { events.push(envelope); store.receive(envelope); } });
  const unwrap = async <T,>(answer: Promise<{ ok: boolean; result?: unknown; error?: unknown }>) => {
    const a = await answer;
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    return a.result as T;
  };
  store = new WorkspaceStore(
    (botId) => unwrap<ResultOf<"chat.snapshot">>(adapter.request({ type: "chat.snapshot", ...(botId ? { botId } : {}) })),
    (botId, before, until) => unwrap<ResultOf<"chat.history">>(adapter.request({ type: "chat.history", botId, before, ...(until ? { until } : {}) })),
  );
  opened.push({ link, adapter });
  adapter.start();
  link.start();
  await flush();
  const chat = () => store.getView().chat?.messages ?? [];
  return { server, clock, link, adapter, store, events, reqs, chat, ids: () => chat().map((m) => m.id) };
}

/** Lets the renderer's resyncs (after a new epoch) finish. */
async function settle(r: Rig): Promise<void> {
  await flush();
  await r.store.resync();
  await flush();
}

const types = (events: EventEnvelope[]) => events.map((e) => e.event.type);

describe("snapshots", () => {
  it("answers chat.snapshot with the server's workspace and the bot stream's lines; events after it keep the seq", async () => {
    const r = await rig((s) => { s.append(BOT, "message.added", { botId: "b1", message: line("m1") }); s.append(BOT, "message.added", { botId: "b1", message: line("m2") }); });
    await r.store.resync();
    expect(r.store.getView().bots.map((b) => b.id)).toEqual(["b1"]);
    expect(r.ids()).toEqual(["m1", "m2"]);
    expect(r.adapter.followed()).toEqual(["b1"]);
    expect(r.reqs.map((c) => c.type)).toEqual(["chat.snapshot"]);
    const resyncs = r.store.getView().resyncs;
    r.server.append(BOT, "message.added", { botId: "b1", message: line("m3") });
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("m1", "edited") });
    await flush();
    expect(r.ids()).toEqual(["m1", "m2", "m3"]);
    expect(r.chat()[0].text).toBe("edited");
    expect(r.store.getView().resyncs).toBe(resyncs);
    // Envelopes are valid, one epoch, gapless.
    const seqs = r.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
  });

  it("a later snapshot is exactly the renderer's view at that seq (the mirror runs the renderer's reducer)", async () => {
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("m1") }));
    await r.store.resync();
    r.server.append(BOT, "message.added", { botId: "b1", message: line("m2") });
    r.server.append(BOT, "message.removed", { botId: "b1", messageId: "m1" });
    await flush();
    const answer = await r.adapter.request({ type: "chat.snapshot", botId: "b1" });
    expect(answer.ok).toBe(true);
    const snap = (answer as { result: ResultOf<"chat.snapshot"> }).result;
    expect(snap.seq).toBe(r.adapter.currentSeq);
    expect(snap.chat!.messages).toEqual(r.chat());
  });

  it("a restore (reset + snap) makes a new epoch: the renderer takes a fresh snapshot with the restored lines", async () => {
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("m1") }));
    await r.store.resync();
    const epoch = r.adapter.currentEpoch;
    r.server.restore();
    await settle(r);
    expect(r.adapter.currentEpoch).not.toBe(epoch);
    expect(r.ids()[0]).toBe("m1");
  });
});

describe("history", () => {
  it("chat.history pages the bot stream; `until` reads back page by page to that line", async () => {
    const r = await rig((s) => { for (let i = 1; i <= 7; i += 1) s.append(BOT, "message.added", { botId: "b1", message: line(`m${i}`) }); }, { snapPage: 2 });
    await r.store.resync();
    expect(r.ids()).toEqual(["m6", "m7"]);
    expect(r.store.getView().chat!.history).toEqual({ hasMore: true, older: 5 });
    await r.store.loadOlder();
    expect(r.ids()).toEqual(["m4", "m5", "m6", "m7"]);
    await r.store.loadOlder("m1");
    expect(r.ids()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    expect(r.store.getView().chat!.history).toBeUndefined();
    expect(r.server.received.filter((m) => m.t === "history").map((m) => (m as { before: string }).before)).toEqual(["m6", "m4", "m2"]);
  });

  it("a line from an older page gets its later updates (the renderer appends nothing twice)", async () => {
    const r = await rig((s) => { for (let i = 1; i <= 4; i += 1) s.append(BOT, "message.added", { botId: "b1", message: line(`m${i}`) }); }, { snapPage: 2 });
    await r.store.resync();
    await r.store.loadOlder();
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("m1", "changed") });
    await flush();
    expect(r.ids()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.chat()[0].text).toBe("changed");
  });
});

describe("live text", () => {
  const live = (r: Rig, seg: number, rev: number, at: number, text: string) => r.server.send({ t: "live", stream: BOT, turnId: "t1", seg, rev, at, text });

  it("live frames grow the reply as turn.delta; a new segment adds to the earlier ones; turn.finished sets the text", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    live(r, 0, 0, 0, "Hel");
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ role: "bot", text: "Hel", state: "streaming" });
    live(r, 0, 1, 3, "lo");
    await flush();
    expect(r.chat().find((m) => m.id === "r1")!.text).toBe("Hello");
    // A step boundary: the server commits the reply so far, then streams the next segment from 0.
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("r1", "Hello", { turnId: "t1", state: "streaming" }) });
    await flush();
    live(r, 1, 0, 0, " world");
    await flush();
    expect(r.chat().find((m) => m.id === "r1")!.text).toBe("Hello world");
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: "Hello world!" });
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ text: "Hello world!", state: "done" });
    expect(types(r.events)).toContain("turn.delta");
    expect(r.ids().filter((id) => id === "r1")).toHaveLength(1);
  });

  it("joining mid-turn: a later segment's first frame starts from the reply's committed text", async () => {
    const r = await rig((s) => {
      s.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
      s.append(BOT, "message.added", { botId: "b1", message: line("r1", "First part.", { turnId: "t1", state: "streaming" }) });
    });
    await r.store.resync();
    r.server.append(BOT, "turn.steps", { botId: "b1", turnId: "t1", messageId: "r1", steps: [] });
    await flush();
    // The snap does not say which turn runs (no runs in M1's snap view): the reply line is known by the turn.started
    // this test sends again (a server mid-turn would carry it in its snapshot's runs).
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    live(r, 2, 0, 0, " Second.");
    await flush();
    expect(r.chat().find((m) => m.id === "r1")!.text).toBe("First part. Second.");
  });

  it("turn.interrupted shows the checkpoint text as 2.x shows a reply its core died during (failed, with the note)", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    live(r, 0, 0, 0, "partial answ");
    await flush();
    r.server.append(BOT, "turn.interrupted", { botId: "b1", turnId: "t1", messageId: "r1", text: "partial" });
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ text: `partial\n\n${INTERRUPTED_NOTE}`, state: "failed", interrupted: true });
    expect(r.store.getView().chat?.running ?? null).toBeNull();
    // A snapshot now is what the renderer holds (the mirror ran the same events).
    const snapshot = await r.adapter.snapshot("b1");
    expect(snapshot.chat?.messages.find((m) => m.id === "r1")).toEqual(r.chat().find((m) => m.id === "r1"));
  });
});

describe("a reply with nothing to show (2.x draws no line for it)", () => {
  const step = (id: string) => ({ id, kind: "tool" as const, tool: "Bash", title: "Run", detail: null, output: null, failed: false, done: true });
  /** The core's verdict for a finished turn (bot.ts finishTurn): whether it keeps a line, and the line's words and buttons. */
  const verdict = (items: StreamItem[], origin: "user" | "app" | "background", steps: number) => {
    const reply = new ReplyText();
    for (const item of items) reply.add(item);
    const parsed = parseReply(reply.text);
    const tags = parseHeadTags(parsed.body);
    const content = headTurnContent({ status: "done", origin, sharesChat: false, raw: reply.text, parsed, body: tags.body, handoff: false, steps, error: null });
    return { shows: hasVisibleContent(content), raw: reply.text, text: content.body, choices: parsed.choices ?? [] };
  };

  it("a worker's question answered with a tool call and only <no-reply/>: no empty bubble (the screenshot of 2026-11-15)", async () => {
    // The core keeps it out: the app's note answered with <no-reply/>, after two tool calls.
    const core = verdict([{ kind: "textBlock" }, { kind: "delta", text: "<no-reply/>" }] as StreamItem[], "app", 2);
    expect(core.shows).toBe(false);
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("m1", "the worker's question", { role: "user" }) }));
    await r.store.resync();
    // What the core sends for it: the turn, its steps, and its end with no text (no message.added: it never had words).
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "turn.steps", { botId: "b1", turnId: "t1", messageId: "r1", steps: [step("s1"), step("s2")] });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: core.text });
    await flush();
    expect(r.ids()).toEqual(["m1"]);
    expect(r.store.getView().chat?.running ?? null).toBeNull();
    // A snapshot now is what the renderer holds.
    expect((await r.adapter.snapshot("b1")).chat?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a line the core drew and then took away (message.removed) does not come back when the turn ends with no text", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "message.added", { botId: "b1", message: line("r1", "", { turnId: "t1", state: "streaming" }) });
    r.server.append(BOT, "message.removed", { botId: "b1", messageId: "r1" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: "" });
    await flush();
    expect(r.ids()).toEqual([]);
    // A turn cut off before it said anything shows nothing either (2.x: an interrupted reply with no words has no bubble).
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t2", messageId: "r2" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t2", messageId: "r2", status: "stopped", text: "" });
    await flush();
    expect(r.ids()).toEqual([]);
  });

  it("a line only the live frames drew goes when the turn ends with no text and no line in the log", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    r.server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 0, at: 0, text: " " });
    await flush();
    expect(r.ids()).toEqual(["r1"]);
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: "" });
    await flush();
    expect(r.ids()).toEqual([]);
    expect((await r.adapter.snapshot("b1")).chat?.messages).toEqual([]);
  });

  it("blank text, and a message the server ended with a turn it was read into, draw no line either", async () => {
    const r = await rig();
    await r.store.resync();
    // A stop of a turn with no line: the core sends the reply's raw body, which may be only blank.
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "stopped", text: " \n\n" });
    // A message read into another turn: the server ends its own turn with that one, text "", no turn.started (worker.ts).
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t2", messageId: "r2", status: "done", text: "" });
    await flush();
    expect(r.ids()).toEqual([]);
    expect((await r.adapter.snapshot("b1")).chat?.messages).toEqual([]);
  });

  it("a reply the core keeps with no words (only its tool steps) stays where it is when the turn ends with no text", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "message.added", { botId: "b1", message: line("r1", "", { turnId: "t1", state: "streaming" }) });
    r.server.append(BOT, "message.added", { botId: "b1", message: line("m2", "a later line") });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: "" });
    await flush();
    expect(r.ids()).toEqual(["r1", "m2"]);
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("r1", "", { turnId: "t1", state: "done", steps: [step("s1")] }) });
    await flush();
    expect(r.ids()).toEqual(["r1", "m2"]);
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ state: "done", steps: [{ id: "s1" }] });
  });

  it("a failed turn with no line still shows one (the server's own turn.finished for a turn the core never ended)", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "failed", text: "", error: "the engine went away" });
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ role: "bot", state: "failed" });
  });

  it("turns absorbed into a failed main turn end failed with no text and no error: no empty failed bubble for them", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t2", messageId: "r2" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "failed", text: "", error: "the engine went away" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t2", messageId: "r2", status: "failed", text: "" });
    await flush();
    expect(r.ids()).toEqual(["r1"]);
    expect((await r.adapter.snapshot("b1")).chat?.messages.map((m) => m.id)).toEqual(["r1"]);
  });

  it("a failed turn with no text and no error still shows when the server log holds a line for it", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "message.added", { botId: "b1", message: line("r1", "", { turnId: "t1", state: "failed" }) });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "failed", text: "" });
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ role: "bot", state: "failed" });
  });

  it("a failed turn that carries text still shows (the ordinary failed reply)", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "failed", text: "half an answer" });
    await flush();
    expect(r.chat().find((m) => m.id === "r1")).toMatchObject({ role: "bot", state: "failed", text: "half an answer" });
  });

  it("your message answered with words and choices, a tool call, then a last <no-reply/>: the words and choices show, the tag does not", async () => {
    const said = "Both are not done yet.";
    const choices = '<choices question="Phone">\n* Deploy now | it changes the live relay\n- Wait | phone keeps 2.x\n</choices>';
    const core = verdict([
      { kind: "delta", text: `${said}\n\n${choices}` },
      { kind: "textBlock" }, // a tool call, then a new text block
      { kind: "delta", text: "<no-reply/>" },
    ] as StreamItem[], "user", 1);
    expect(core.raw).toContain("<no-reply/>");
    expect(core.shows).toBe(true);
    expect(core.text).toBe(said);
    expect(core.choices.map((c) => c.label)).toEqual(["Deploy now", "Wait"]);
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("u1", "is it done?", { role: "user" }) }));
    await r.store.resync();
    // The core's events: the words stream (its tags held back), the line is placed, a tool call, and the end.
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    r.server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 0, at: 0, text: said });
    r.server.append(BOT, "message.added", { botId: "b1", message: line("r1", said, { turnId: "t1", state: "streaming" }) });
    await flush();
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("r1", said, { turnId: "t1", state: "streaming" }) });
    r.server.append(BOT, "turn.steps", { botId: "b1", turnId: "t1", messageId: "r1", steps: [step("s1")] });
    r.server.append(BOT, "turn.finished", { botId: "b1", turnId: "t1", messageId: "r1", status: "done", text: core.text });
    const final = line("r1", core.text, {
      turnId: "t1", state: "done", steps: [step("s1")],
      choices: core.choices.map((c) => ({ label: c.label, detail: c.detail ?? null, recommended: c.recommended, action: null })),
    });
    r.server.append(BOT, "message.updated", { botId: "b1", message: final });
    await flush();
    expect(r.ids()).toEqual(["u1", "r1"]);
    const shown = r.chat().find((m) => m.id === "r1")!;
    expect(shown).toMatchObject({ text: said, state: "done" });
    expect(shown.text).not.toContain("no-reply");
    expect(shown.choices?.map((c) => c.label)).toEqual(["Deploy now", "Wait"]);
  });
});

describe("pending lines → delivered by slot", () => {
  it("chat.send answers once durable, shows a pending line, and swaps it for the line carrying its slot", async () => {
    const r = await rig();
    await r.store.resync();
    const answer = await r.adapter.request({ type: "chat.send", botId: "b1", text: "hi there" });
    expect(answer.ok).toBe(true);
    const pendingId = (answer as { result: { messageId: string } }).result.messageId;
    expect(pendingId).toMatch(/^fe-p-[0-9a-f]{16}$/);
    await flush();
    expect(r.ids()).toEqual(["u-1"]);
    expect(r.chat()[0]).toMatchObject({ role: "user", text: "hi there" });
    const seen = r.events.map((e) => e.event as { type: string; message?: MessageView; messageId?: string });
    const added = seen.findIndex((e) => e.type === "message.added" && e.message?.id === pendingId);
    const removed = seen.findIndex((e) => e.type === "message.removed" && e.messageId === pendingId);
    const real = seen.findIndex((e) => e.type === "message.added" && e.message?.id === "u-1");
    expect(added).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(added);
    expect(real).toBeGreaterThan(removed);
    // A fast ack never flashes the "sending" marker.
    expect(seen.some((e) => e.message?.queued)).toBe(false);
  });

  it("offline: the line waits with the sending marker after 150 ms, then is delivered on reconnect with no duplicate", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.refuse = true;
    r.server.kill();
    await flush();
    const answer = await r.adapter.request({ type: "chat.send", botId: "b1", text: "later" });
    const pendingId = (answer as { result: { messageId: string } }).result.messageId;
    await flush();
    expect(r.chat().find((m) => m.id === pendingId)).toMatchObject({ role: "user", text: "later" });
    expect(r.chat().find((m) => m.id === pendingId)!.queued).toBeUndefined();
    r.clock.advance(200);
    await flush();
    expect(r.chat().find((m) => m.id === pendingId)!.queued).toBe(true);
    r.server.refuse = false;
    for (let i = 0; i < 6 && !r.link.status.attached; i += 1) { r.clock.advance(5_000); await flush(); }
    await settle(r);
    expect(r.link.status.attached).toBe(true);
    expect(r.ids().filter((id) => id !== NOTICE_ID)).toEqual(["u-1"]);
  });

  it("a refused send turns its line into a 'not sent' line; the next send clears it", async () => {
    const r = await rig();
    await r.store.resync();
    const answer = await r.adapter.request({ type: "chat.send", botId: "b1", text: "refuse me" });
    const pendingId = (answer as { result: { messageId: string } }).result.messageId;
    await flush();
    expect(r.chat().find((m) => m.id === pendingId)).toMatchObject({ role: "error", text: "Not sent (scope): refuse me" });
    await r.adapter.request({ type: "chat.send", botId: "b1", text: "ok now" });
    await flush();
    expect(r.ids()).toEqual(["u-2"]);
  });

  it("other commands answer with their outcome; reads go as requests with no slot", async () => {
    const r = await rig();
    await r.store.resync();
    expect(await r.adapter.request({ type: "chat.react", botId: "b1", messageId: "m1", emoji: "👍", present: true })).toEqual({ ok: true, result: { n: 1 } });
    const refused = await r.adapter.request({ type: "chat.react", botId: "b1", messageId: "m1", emoji: "✗", present: true });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await r.adapter.request({ type: "settings.get" })).toEqual({ ok: true, result: { read: "settings.get" } });
    expect(r.reqs.map((c) => c.type)).toContain("settings.get");
    expect(READ_COMMANDS.has("chat.send")).toBe(false);
    expect(r.server.copies.map((c) => c.cmd.type)).toEqual(["chat.react", "chat.react"]);
  });

  it("plugins.panel goes as a request with no slot (a slot's cmd.applied cannot hold a large panel; 2026-11-15 hang)", async () => {
    const r = await rig();
    await r.store.resync();
    expect(await r.adapter.request({ type: "plugins.panel", name: "note", panel: "main" })).toEqual({ ok: true, result: { read: "plugins.panel" } });
    expect(r.reqs.map((c) => c.type)).toContain("plugins.panel");
    expect(r.server.copies).toEqual([]);
  });

  describe("a plugins.call whose result the owner kept (too large for one log entry; N2)", () => {
    const call = { type: "plugins.call", name: "note", method: "load", params: {}, from: "frame" } as Command;
    const big = { result: { doc: "筆記".repeat(2_000) } }; // the fake server sends one frame; res.parts are server-session-frames's
    /** The owner answers the call with a kept-result marker; `answer` is how it answers the `slot.result` req. */
    async function keptRig(marker: { bytes: number; kept: boolean }, answer: (message: Extract<Message, { t: "req" }>, server: FakeServer) => void) {
      const r = await rig((server) => {
        const apply = server.applyHook!;
        server.applyHook = (context) => context.cmd.type === "plugins.call" ? { result: { resultKept: marker } } : apply(context);
        const base = server.onMessage!;
        server.onMessage = (message: Message) => {
          if (message.t === "req" && message.cmd.type === "slot.result") { r.reqs.push(message.cmd); answer(message, server); return; }
          base(message);
        };
      });
      await r.store.resync();
      return r;
    }

    it("fetches the kept result with a slot.result req for its own slot and answers the call with the real result", async () => {
      const r = await keptRig({ bytes: 1_200_000, kept: true }, (message, server) => server.send({ t: "res", req: message.req, ok: true, result: big }));
      expect(await r.adapter.request(call)).toEqual({ ok: true, result: big });
      const fetch = r.reqs.find((cmd) => cmd.type === "slot.result") as Extract<Command, { type: "slot.result" }>;
      expect(fetch.slot).toEqual(r.server.copies.find((copy) => copy.cmd.type === "plugins.call")!.slot);
    });

    it("a result that could not be fetched answers an error that says the call ran, never \"not sent\"", async () => {
      const r = await keptRig({ bytes: 1_200_000, kept: true }, (message, server) => server.send({ t: "res", req: message.req, ok: false, error: { code: "not_found", message: "no longer kept" } }));
      const answer = await r.adapter.request(call);
      expect(answer.ok).toBe(false);
      const text = (answer as { error: { message: string } }).error.message;
      expect(text).toMatch(/plugins\.call ran/);
      expect(text).not.toMatch(/not sent/i);
    });

    it("a result too large to keep answers an error that says the call ran (no fetch)", async () => {
      const r = await keptRig({ bytes: 40_000_000, kept: false }, () => { throw new Error("no fetch expected"); });
      const answer = await r.adapter.request(call);
      expect(answer).toMatchObject({ ok: false, error: { message: expect.stringMatching(/plugins\.call ran.*too large/) } });
      expect(r.reqs.some((cmd) => cmd.type === "slot.result")).toBe(false);
    });
  });

  it("every command the server takes only as a read is sent as a request, never as a slot", () => {
    const reads = (Object.keys(COMMAND_ROUTES) as CommandType[]).filter((type) => COMMAND_ROUTES[type].kind === "read");
    expect(reads.length).toBeGreaterThan(10);
    expect(reads.filter((type) => !READ_COMMANDS.has(type))).toEqual([]);
  });

  it("pending line ids are stable per slot and valid message ids", () => {
    const slot = { origin: "desktop", originEpoch: "0".repeat(32), target: BOT, n: 7 };
    expect(pendingLineId(slot)).toBe(pendingLineId({ ...slot }));
    expect(pendingLineId(slot)).not.toBe(pendingLineId({ ...slot, n: 8 }));
    expect(pendingLineId(slot)).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  });
});

describe("connection states in the renderer", () => {
  const notice = (r: Rig) => r.chat().find((m) => m.id === NOTICE_ID);

  it("connecting shows (after a short delay) as a notice line; offline after 10 s; it goes when live again", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.refuse = true;
    r.server.kill();
    await flush();
    expect(r.link.status.state).toBe("connecting");
    expect(notice(r)).toBeUndefined();
    r.clock.advance(450);
    await flush();
    expect(notice(r)).toMatchObject({ role: "notice", text: "Connecting to the Botling server…" });
    r.clock.advance(10_000);
    await flush();
    expect(r.link.status.state).toBe("offline");
    expect(notice(r)!.text).toMatch(/^Offline · as of \d\d:\d\d\./);
    r.server.refuse = false;
    for (let i = 0; i < 6 && !r.link.status.attached; i += 1) { r.clock.advance(5_000); await flush(); }
    await settle(r);
    expect(r.link.status.state).toBe("live");
    expect(notice(r)).toBeUndefined();
  });

  it("a normal attach never flashes the notice", async () => {
    const r = await rig();
    await r.store.resync();
    expect(r.events.some((e) => (e.event as { message?: MessageView }).message?.id === NOTICE_ID)).toBe(false);
  });

  it("history restored shows at once and stays until the user sends again", async () => {
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("m1") }));
    await r.store.resync();
    r.server.restore();
    await settle(r);
    expect(r.link.status.state).toBe("history restored");
    expect(notice(r)).toMatchObject({ role: "notice" });
    expect(notice(r)!.text).toMatch(/^This machine's history was restored from a backup \(noticed at \d\d:\d\d\)/);
    r.clock.advance(60_000);
    await flush();
    expect(notice(r)).toBeDefined();
    await r.adapter.request({ type: "chat.send", botId: "b1", text: "seen" });
    await flush();
    expect(r.link.status.state).toBe("live");
    expect(notice(r)).toBeUndefined();
  });

  it("every state has words, and live has none", () => {
    const base = { since: 0, attached: false, offline: false, catching: false, restoredAt: null, asOf: null, minFeVersion: null };
    expect(noticeText({ ...base, state: "live", attached: true })).toBeNull();
    for (const state of ["connecting", "offline", "catching up", "history restored", "update required"] as const) expect(noticeText({ ...base, state })).toMatch(/\w/);
  });
});

// M1 demo bug 1: the 2.x window re-binds its chat frame at every app render (every 30 s at least) and then asks for the
// whole chat state and `plugins.web` again. On Botling 3 that must not redraw the newest row (a playing video in it
// would start over) nor fetch ~2 MB of plugin sources each time.
describe("what a re-bind asks again", () => {
  const pluginsView = { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null };
  const webReqs = (r: Rig) => r.reqs.filter((c) => c.type === "plugins.web").length;

  it("plugins.web is asked of the server once, then again only after plugins.updated, a plugins command or a re-attach", async () => {
    const r = await rig();
    await r.store.resync();
    for (let i = 0; i < 5; i += 1) expect(await r.adapter.request({ type: "plugins.web" })).toEqual({ ok: true, result: { read: "plugins.web" } });
    expect(webReqs(r)).toBe(1);
    // The fake server's srv: stream does not carry appended entries; the event reaches the adapter the same way on a
    // followed stream (every contract event the renderer gets goes through one emit).
    r.server.append(BOT, "plugins.updated", { plugins: pluginsView });
    await flush();
    await r.adapter.request({ type: "plugins.web" });
    await r.adapter.request({ type: "plugins.web" });
    expect(webReqs(r)).toBe(2);
    await r.adapter.request({ type: "plugins.enable", name: "notes", enabled: false });
    await r.adapter.request({ type: "plugins.web" });
    expect(webReqs(r)).toBe(3);
    r.server.kill();
    await flush();
    r.clock.advance(60_000);
    await flush();
    await settle(r);
    await r.adapter.request({ type: "plugins.web" });
    expect(webReqs(r)).toBe(4);
  });

  it("a line entry that changes nothing the renderer holds is not sent again (its row is not drawn anew)", async () => {
    const r = await rig((s) => s.append(BOT, "message.added", { botId: "b1", message: line("m1", "![v](file:///v.mp4)") }));
    await r.store.resync();
    const before = r.events.length;
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("m1", "![v](file:///v.mp4)") });
    await flush();
    expect(r.events.length).toBe(before);
    r.server.append(BOT, "message.updated", { botId: "b1", message: line("m1", "![v](file:///v.mp4) more") });
    await flush();
    expect(types(r.events.slice(before))).toEqual(["message.updated"]);
    expect(r.chat()[0].text).toBe("![v](file:///v.mp4) more");
  });

  it("a checkpoint of the text the live frames already showed sends nothing", async () => {
    const r = await rig();
    await r.store.resync();
    r.server.append(BOT, "turn.started", { botId: "b1", turnId: "t1", messageId: "r1" });
    await flush();
    r.server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 0, at: 0, text: "Hello" });
    await flush();
    const held = r.chat().find((m) => m.id === "r1")!;
    const before = r.events.length;
    r.server.append(BOT, "message.updated", { botId: "b1", message: held });
    await flush();
    expect(r.events.slice(before)).toEqual([]);
    expect(r.chat().find((m) => m.id === "r1")!.text).toBe("Hello");
  });
});
