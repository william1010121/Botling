// M3 step 11 (m3-brief §4 row 11; protocol v1 §10.1, §11.6, §13.1, §13.3, D49, D50): the front-end link and the
// renderer adapter attached to server A of two. The fake server (fe-link-harness) plays A: `welcome.servers` names B,
// it serves B's `srv:` table as `rows`, and "forwards" commands for B's bot (held at A while partitioned). Checks:
// B's bots come from the replicated table (the directory); a command to B's bot carries B's logId as `inc`; the outbox
// goes out only after every `srv:` catch-up; held at A → delivered once after the partition heals; "waiting for B"
// while B is stale; a restart with items held re-sends them after the catch-up with the current inc (after B's
// restore: the new logId); an outcome a restore took away shows "delivered, then lost when B was restored"; the
// adapter lists B's bots, says "B offline · as of <time>" over B's bot, and draws the lost line with B's name.
import { afterEach, describe, expect, it } from "vitest";
import type { Command, EventEnvelope, MessageView } from "../../src/contract";
import { FeLink, MemoryFeStorage, type FeLinkOptions, type FeStorage } from "../../src/fe-link";
import { NOTICE_ID, RendererAdapter, botViewOfSummary, peerNoticeText, type LinkPort } from "../../src/main-v3/renderer-adapter";
import type { Message, StreamId, Target } from "../../src/protocol";
import type { SummaryRow } from "../../src/protocol/table-rows";
import { FakeClock, FakeServer, flush, SERVER_ID } from "./fe-link-harness";

const B = "srvB";
const SRV_B = `srv:${B}`;
const FAR = "far1";
const FAR_STREAM = `bot:${FAR}` as StreamId;
const summary = (over: Partial<SummaryRow> = {}): SummaryRow => ({
  name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
  waiting: [], unread: 0, lastAt: null, lines: ["hello"], ...over,
} as SummaryRow);

const links: FeLink[] = [];
const adapters: RendererAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  for (const link of links.splice(0)) await link.stop();
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");
const react = (messageId: string) => ({ type: "chat.react", botId: FAR, messageId, emoji: "👍", present: true }) as const;

/** Server A of two: B is live, B's table holds bot `far1` under logId `incb-0001`. */
function twoServers(): FakeServer {
  const server = new FakeServer();
  server.servers = [
    { id: SERVER_ID, name: "Studio", state: "live", since: 1 },
    { id: B, name: "Linux box", state: "live", since: 2 },
  ];
  server.tables.set(SRV_B, { logId: "incb-0001", rev: 1, rows: new Map([[`bot:${FAR}`, { rev: 1, body: summary() }]]), retired: [] });
  server.peerTargets.add(FAR_STREAM);
  return server;
}

async function openLink(server: FakeServer, storage: FeStorage, clock: FakeClock, over: Partial<FeLinkOptions> = {}): Promise<FeLink> {
  const link = await FeLink.open({ storage, dial: server.dial, deviceId: "phone", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true, ...over });
  links.push(link);
  link.start();
  return link;
}

const copiesFor = (server: FakeServer, target: string) => server.copies.filter((copy) => copy.slot.target === target);
const peerMsg = (state: "live" | "stale", since: number): Message => ({ t: "peer", serverId: B, state, since });

describe("fe-link attached to A of two servers", () => {
  it("B's bots come from B's replicated table; the outbox waits for every srv: catch-up; inc = B's logId", async () => {
    const server = twoServers();
    server.holdRows = true;
    const clock = new FakeClock();
    const link = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    expect(link.servers().map((s) => [s.name, s.state, s.self])).toEqual([["Studio", "live", true], ["Linux box", "live", false]]);
    expect(server.received.some((m) => m.t === "sub" && m.stream === SRV_B && m.cursor === null)).toBe(true);
    // B's table has not come: the directory does not know far1 yet, and nothing goes out.
    expect(link.state).toBe("catching up");
    await link.submit(FAR_STREAM, react("m1"));
    await flush();
    expect(copiesFor(server, FAR_STREAM)).toEqual([]);
    server.releaseRows();
    await flush();
    expect(link.ownerOf(FAR_STREAM)).toBe(B);
    expect(link.table(B)?.rows.has(`bot:${FAR}`)).toBe(true);
    const sent = copiesFor(server, FAR_STREAM);
    expect(sent).toHaveLength(1);
    expect(sent[0].inc).toBe("incb-0001");
    expect(link.state).toBe("live");
    // Applied once; the stream is not followed, so the delivered item leaves the outbox at once.
    expect(server.applied.filter((a) => a.slot.target === FAR_STREAM)).toHaveLength(1);
    expect(link.pending(FAR_STREAM)).toEqual([]);
  });

  it("held at A while B is partitioned, 'waiting for B' while B is stale, delivered once after the heal", async () => {
    const server = twoServers();
    const clock = new FakeClock();
    const link = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    server.partitioned = true;
    const item = await link.submit(FAR_STREAM, react("m1"));
    await flush();
    expect(link.pending(FAR_STREAM)[0]).toMatchObject({ state: "held", heldAt: SERVER_ID, heldAtName: "Studio" });
    expect(link.pending(FAR_STREAM)[0].waitingFor).toBeUndefined();
    server.send(peerMsg("stale", 5_000));
    server.send({ t: "stale", stream: FAR_STREAM, since: 5_000 });
    await flush();
    expect(link.servers().find((s) => s.id === B)).toMatchObject({ state: "stale", since: 5_000 });
    expect(link.pending(FAR_STREAM)[0]).toMatchObject({ state: "held", waitingFor: "Linux box" });
    expect(link.staleSince(FAR_STREAM)).toBe(5_000);
    await server.heal();
    server.send(peerMsg("live", 6_000));
    await flush();
    expect(server.applied.filter((a) => a.slot.target === FAR_STREAM).map((a) => a.slot.n)).toEqual([item.slot.n]);
    expect(link.pending(FAR_STREAM).every((p) => p.state === "delivered") || link.pending(FAR_STREAM).length === 0).toBe(true);
    expect(link.staleSince(FAR_STREAM)).toBeNull();
  });

  it("a restart with items held re-sends them after every srv: catch-up, with the current inc (B restored meanwhile)", async () => {
    const server = twoServers();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const first = await openLink(server, storage, clock);
    await flush();
    server.partitioned = true;
    await first.submit(FAR_STREAM, react("m1"));
    await first.submit(FAR_STREAM, react("m2"));
    await flush();
    expect(first.pending(FAR_STREAM).map((p) => p.state)).toEqual(["held", "held"]);
    await first.stop();
    // A dropped what it held (as after cmd.retry); B was restored: its table is on a new logId.
    (server as unknown as { forwardQueue: unknown[] }).forwardQueue.splice(0);
    server.partitioned = false;
    server.tables.get(SRV_B)!.retired.push({ logId: "incb-0001", keptSeq: 1 });
    server.tables.get(SRV_B)!.logId = "incb-0002";
    server.holdRows = true;
    const copiesBefore = copiesFor(server, FAR_STREAM).length;
    const second = await openLink(server, storage, clock);
    await flush();
    expect(copiesFor(server, FAR_STREAM).length).toBe(copiesBefore); // not before B's table came
    server.releaseRows();
    await flush();
    const resent = copiesFor(server, FAR_STREAM).slice(copiesBefore);
    expect(resent.map((c) => [c.slot.n, c.inc])).toEqual([[1, "incb-0002"], [2, "incb-0002"]]);
    expect(server.applied.filter((a) => a.slot.target === FAR_STREAM).map((a) => a.slot.n)).toEqual([1, 2]);
    expect(second.pending(FAR_STREAM).filter((p) => p.state === "waiting" || p.state === "held")).toEqual([]);
  });

  it("a table reset of B moves the copy to the new logId and drops rows of the retired one (D50)", async () => {
    const server = twoServers();
    const clock = new FakeClock();
    const link = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    server.restoreTable(SRV_B, "incb-0002");
    await flush();
    expect(link.table(B)).toMatchObject({ logId: "incb-0002", caught: true });
    // A late batch of the retired logId changes nothing.
    server.sendWire({ t: "rows", stream: SRV_B, logId: "incb-0001", after: 1, to: 2, rows: [{ key: "bot:ghost", rev: 2, body: summary({ name: "Ghost" }) }], more: false });
    await flush();
    expect(link.table(B)?.rows.has("bot:ghost")).toBe(false);
    expect(link.ownerOf("bot:ghost" as StreamId)).toBe(SERVER_ID);
  });

  it("an outcome a restore of B took away (already shown, so settled) shows 'delivered, then lost when B was restored'", async () => {
    const server = twoServers();
    const clock = new FakeClock();
    const link = await openLink(server, new MemoryFeStorage(), clock);
    link.subscribe(FAR_STREAM);
    await flush();
    await link.submit(FAR_STREAM, react("m1"));
    await flush();
    // The outcome entry was shown: the item left the outbox.
    expect(link.pending(FAR_STREAM)).toEqual([]);
    server.restore(0); // B's bot stream restored, keeping nothing of the old incarnation
    await flush();
    expect(link.pending(FAR_STREAM).map((p) => [p.state, p.lost, p.ownerName])).toEqual([["delivered", true, "Linux box"]]);
  });

  it("a table the attached server has no copy of stops holding the outbox after absentTableMs", async () => {
    const server = twoServers();
    server.tables.clear(); // A never reached B: it serves nothing for srv:B
    server.peerTargets.clear();
    const clock = new FakeClock();
    const link = await openLink(server, new MemoryFeStorage(), clock, { absentTableMs: 3_000 });
    await flush();
    const own = "bot:b1" as Target;
    await link.submit(own, { type: "chat.react", botId: "b1", messageId: "x", emoji: "👍", present: true });
    await flush();
    expect(copiesFor(server, own)).toEqual([]);
    clock.advance(3_100);
    await flush();
    expect(copiesFor(server, own)).toHaveLength(1);
  });
});

describe("renderer adapter attached to A of two servers", () => {
  async function rig() {
    const server = twoServers();
    const clock = new FakeClock();
    server.onMessage = (message) => {
      if (message.t !== "req") return;
      const cmd = (message as { cmd: Command }).cmd;
      if (cmd.type === "chat.snapshot") {
        const own = { id: "b1", name: "Main", role: "main", avatar: "circle", folder: "/p", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
        server.send({ t: "res", req: message.req, ok: true, result: { epoch: "e", seq: 0, bots: [own], imported: null, components: {}, plugins: null, settings: null, doctor: null, waiting: { items: [], doing: {} }, chat: null } } as unknown as Message);
      } else server.send({ t: "res", req: message.req, ok: true, result: {} } as unknown as Message);
    };
    server.snapView = () => ({ bot: null, messages: [], history: { hasMore: false, older: 0 }, cards: [] });
    const link = await openLink(server, new MemoryFeStorage(), clock);
    const events: EventEnvelope[] = [];
    const adapter = new RendererAdapter({ link: link as unknown as LinkPort, emit: (envelope) => { events.push(envelope); }, clock, noticeDelayMs: 0 });
    adapters.push(adapter);
    adapter.start();
    await flush();
    return { server, clock, link, adapter, events };
  }

  it("lists B's bots from B's table and follows row changes; B's chat opens from its bot stream", async () => {
    const { server, adapter, events } = await rig();
    const snap = await adapter.snapshot(FAR);
    expect(snap.bots.map((bot) => [bot.id, bot.name])).toEqual([["b1", "Main"], [FAR, "Faraway"]]);
    // The core of A was asked for no chat of B's bot.
    expect(server.received.filter((m) => m.t === "req").every((m) => !(m as { cmd: { botId?: string } }).cmd.botId)).toBe(true);
    server.setRow(SRV_B, `bot:${FAR}`, summary({ name: "Faraway", status: "running", unread: 2 }));
    await flush();
    const updated = events.map((e) => e.event).filter((e) => e.type === "bot.updated").pop() as { bot: { id: string; working: boolean; unread: number } } | undefined;
    expect(updated?.bot).toMatchObject({ id: FAR, working: true, unread: 2 });
    expect((await adapter.request({ type: "chat.shown", botId: FAR } as Command)).ok).toBe(true);
  });

  it("over B's bot: 'B offline · as of <time>' with the held message, gone when B is back", async () => {
    const { server, clock, link, adapter, events } = await rig();
    await adapter.snapshot(FAR);
    await flush();
    server.partitioned = true;
    await adapter.request({ type: "chat.send", botId: FAR, text: "while away" } as Command);
    await flush();
    const since = clock.now();
    server.send(peerMsg("stale", since));
    await flush();
    clock.advance(10);
    await flush();
    const notice = () => events.map((e) => e.event).filter((e): e is { type: "message.updated"; botId: string; message: MessageView } => e.type === "message.updated" && (e as { message?: MessageView }).message?.id === NOTICE_ID).pop();
    expect(notice()?.message.text).toMatch(/^Linux box offline · as of \d\d:\d\d\. 1 message waiting for Linux box \(held at Studio\)/);
    expect(link.pending(FAR_STREAM)[0]).toMatchObject({ state: "held", waitingFor: "Linux box" });
    await server.heal();
    server.send(peerMsg("live", clock.now()));
    await flush();
    expect(events.map((e) => e.event).some((e) => e.type === "message.removed" && (e as { messageId: string }).messageId === NOTICE_ID)).toBe(true);
  });

  it("words: the summary row maps to a list entry with no folder path; notices for stale and gone", () => {
    const view = botViewOfSummary("x1", summary({ folderName: "repo", status: "running" }));
    expect(view).toMatchObject({ id: "x1", folder: "repo", working: true, phase: "awake" });
    const owner = { id: B, name: "Linux box", state: "stale" as const, since: new Date(2026, 0, 1, 9, 5).getTime(), self: false };
    const attached = { id: SERVER_ID, name: "Studio", state: "live" as const, since: 1, self: true };
    expect(peerNoticeText(owner, attached, [])).toBe("Linux box offline · as of 09:05. New messages are held at Studio and go when Linux box is back.");
    expect(peerNoticeText({ ...owner, state: "gone" }, attached, [])).toMatch(/^Linux box removed · read-only\./);
    expect(peerNoticeText({ ...owner, state: "live" }, attached, [])).toBeNull();
  });
});
