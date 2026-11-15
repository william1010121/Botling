// M7-S93b: a second characterization file for `src/fe-link/link.ts`, written before M7-S94 moves the stream half out of
// it. The first file (fe-link-characterization.test.ts, M7-S93) left branches of the methods S94 moves unpinned (found
// by the S93 review, 95 one-line mutants of link.ts: 42 survived). This file pins today's behaviour of each of them,
// same style: `FakeClock` and a scripted wire, only FeLink's public methods and the types link.ts exports, goldens
// written in the test body, no real timers.
//
//   table reset      `onTableReset`: outbox.markLost, reviveLost, `settledRecent` reassigned through this path
//   rows             `onRows`: the resub sent on a gap, the `pending` event after an apply, wait and drop
//   peer             `onPeer`: `gone` drops addresses, a known `dh` is reused, a live peer ends its stale marks
//   cancel.noted     `onCancelNoted`: the `pending` event and its guards
//   resolve          `resolveSlot`: a `moved` slot (slot conflict) and its "sending" marker, a late outcome frees the queue
//   queue stop       `isQueueStopped`: epoch and target comparison (D67)
//   res.part         `onResPart`: the whole path
// Not pinned on purpose: `resolveSlot` clearing `unsettledCounts` / `unsettledStopped` of the resolved key. A resolved
// item is no longer in `outbox.unresolved()`, and `onByeUnsettled` drops the counts of every other key, so no public
// call can tell the clear from its absence (an equivalent mutant; see the S93b implementation note).
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, type Dial, type FeLinkEvent, type FeLinkOptions, type FeSocket, type SocketHandlers } from "../../src/fe-link/link";
import { MemoryFeStorage } from "../../src/fe-link/storage";
import { encodeFrame, encodeWireFrame, type Message, type Slot, type StreamId } from "../../src/protocol";
import { FakeClock, flush } from "./fe-link-harness";

// ---------------------------------------------------------------------------------------------
// The scripted wire (as in fe-link-characterization.test.ts)

const SRV = "srv1";
const SRV_STREAM = `srv:${SRV}` as StreamId;
const SRV_LOG = "incsrv-0001";
const BOT = "bot:b1" as StreamId;
const BOT2 = "bot:b2" as StreamId;
const BOT_LOG = "botlog-0001";
const EPOCH = "00000000000000000000000000000001";
const DEVICE = "desktop";
const PEER = "srvB";
const PEER_STREAM = `srv:${PEER}` as StreamId;
const PEER_LOG = "incb-0001";

const H = (n: number) => n.toString(16).padStart(64, "0");
const react = (messageId: string, botId = "b1") => ({ type: "chat.react", botId, messageId, emoji: "👍", present: true }) as const;
const DH = Buffer.alloc(32, 5).toString("base64url");
const DH2 = Buffer.alloc(32, 6).toString("base64url");
const TAILNET = "wss://100.64.0.2:7443/v3/ws";
const TAILNET2 = "wss://100.64.0.9:7443/v3/ws";
const RELAY = { url: "wss://relay.example.com/r", room: "room1" };

interface Sess {
  handlers: SocketHandlers;
  sent: Array<Record<string, unknown>>;
}

class Wire {
  readonly sessions: Sess[] = [];
  dials = 0;

  readonly dial: Dial = (handlers) => {
    this.dials += 1;
    const sess: Sess = { handlers, sent: [] };
    this.sessions.push(sess);
    const socket: FeSocket = {
      send: (frame) => { sess.sent.push(JSON.parse(frame) as Record<string, unknown>); },
      close: () => undefined,
    };
    return socket;
  };

  get last(): Sess { return this.sessions[this.sessions.length - 1]; }
  open(): void { this.last.handlers.open(); }
  deliver(message: Message | Record<string, unknown>): void {
    const encoded = encodeFrame(message as Message, "server", { local: true });
    if (!encoded.ok) throw new Error(`test wire: cannot encode ${String((message as { t: string }).t)}: ${encoded.detail}`);
    this.last.handlers.frame(encoded.text);
  }
  /** The server sends a message of the M3 codec (`rows`). */
  deliverWire(message: Record<string, unknown>): void {
    const encoded = encodeWireFrame(message as never, "server", { local: true });
    if (!encoded.ok) throw new Error(`test wire: cannot encode ${String(message.t)}: ${encoded.detail}`);
    this.last.handlers.frame(encoded.text);
  }
  drop(detail = "lost"): void { this.last.handlers.close(detail); }
  private readonly taken = new Map<Sess, number>();
  take(): string[] { return this.takeRaw().map(brief); }
  takeRaw(): Array<Record<string, unknown>> {
    const sess = this.last;
    const from = this.taken.get(sess) ?? 0;
    this.taken.set(sess, sess.sent.length);
    return sess.sent.slice(from);
  }
}

const cur = (c: { logId: string; seq: number } | null | undefined) => (c ? `${c.logId}#${c.seq}` : "-");
const slotOf = (s: Slot) => `${s.target}#${s.n}`;

function brief(frame: Record<string, unknown>): string {
  switch (frame.t) {
    case "sub": return `sub ${String(frame.stream)} ${cur(frame.cursor as never)}`;
    case "ack": return `ack ${String(frame.stream)} ${cur(frame.cursor as never)}`;
    case "cmd": return `cmd ${slotOf(frame.slot as Slot)} inc=${String(frame.inc)} floor=${String(frame.floor)}`;
    case "cancel": return `cancel ${slotOf(frame.slot as Slot)}`;
    case "bye": return `bye ${String(frame.reason)}`;
    case "req": return `req ${String(frame.req)} ${String((frame.cmd as { type: string }).type)}`;
    case "history": return `history ${String(frame.req)} ${String(frame.stream)}`;
    default: return String(frame.t) + (frame.req ? ` ${String(frame.req)}` : "");
  }
}

function describeEvent(event: FeLinkEvent): string {
  switch (event.type) {
    case "state": return `state ${event.status.state}`;
    case "pending": return "pending";
    case "outcome": return `outcome ${slotOf(event.item.slot)} ${event.item.outcome?.kind ?? "?"}`;
    case "snap": return `snap ${event.snap.stream} ${event.snap.logId}#${event.snap.seq}`;
    case "entries": return `entries ${event.stream} ${event.entries.map((e) => `${e.seq}:${e.kind}`).join(",")}`;
    case "reset": return `reset ${event.reset.stream} ${event.reset.logId}`;
    case "dropped": return `dropped ${event.stream} (${event.why})`;
    case "live": return `live ${event.stream} ${event.view ? JSON.stringify(event.view.text) : "null"} stale=${event.stale}`;
    case "message": return `message ${event.message.t}`;
    case "attached": return `attached ${event.attached}`;
    case "servers": return event.table ? `servers ${event.table.stream} +[${event.table.changed.join(",")}] -[${event.table.removed.join(",")}]` : "servers";
    case "bye": return `bye ${event.reason}${event.detail ? ` (${event.detail})` : ""}`;
    case "error": return `error ${String((event.error as Error)?.message ?? event.error)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Messages the server sends

type WelcomeServers = Extract<Message, { t: "welcome" }>["servers"];
const welcome = (over: Partial<Extract<Message, { t: "welcome" }>> = {}): Message => ({
  t: "welcome", serverId: SRV, protocol: { min: 1, max: 1 }, minFeVersion: "3.0.0", rosterDigest: null, servers: [], next: {}, views: {}, ...over,
});
const snapOf = (stream: StreamId, logId: string, seq = 0): Message => ({ t: "snap", stream, logId, seq, hash: H(seq), view: {} });
const resultOf = (slot: Slot, outcome: { kind: "applied"; result?: unknown } | { kind: "cancelled" } | { kind: "refused"; reason: string }, logId = BOT_LOG, seq: number | null = 1): Message =>
  ({ t: "cmd.result", slot, outcome, logId, seq } as never);
const resetOf = (stream: StreamId, logId: string, retired: Array<{ logId: string; keptSeq: number }>): Message =>
  ({ t: "reset", stream, logId, retired, reason: "restored" }) as never;
const peerRows = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ t: "rows", stream: PEER_STREAM, logId: PEER_LOG, after: 0, to: 1, more: false, rows: [], ...over });
const farRow = (rev = 1) => ({ key: "bot:far1", rev, body: summaryRow() });

// ---------------------------------------------------------------------------------------------
// One link on the wire

const links: FeLink[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
});

interface Rig {
  wire: Wire;
  clock: FakeClock;
  storage: MemoryFeStorage;
  link: FeLink;
  events: string[];
  /** The listener lines since the last call. */
  seen(): string[];
}

async function rig(over: Partial<FeLinkOptions> = {}): Promise<Rig> {
  const wire = new Wire();
  const clock = new FakeClock();
  const storage = new MemoryFeStorage();
  const link = await FeLink.open({ storage, dial: wire.dial, deviceId: DEVICE, feVersion: "3.0.0", clock, newEpoch: () => EPOCH, local: true, ...over });
  links.push(link);
  const events: string[] = [];
  link.on((event) => { events.push(describeEvent(event)); });
  link.subscribe(BOT);
  link.start();
  let from = 0;
  return { wire, clock, storage, link, events, seen: () => { const out = events.slice(from); from = events.length; return out; } };
}

/** Opens the session and welcomes it (no snap): the link is catching up, nothing else has come. */
function open(r: Rig, welcomeOver: Partial<Extract<Message, { t: "welcome" }>> = {}): void {
  r.wire.open();
  r.wire.deliver(welcome(welcomeOver));
}

/** Welcome, the owner's `srv:` snap and the bot's snap: live, the next lines are the ones a test asserts. */
async function attach(r: Rig, welcomeOver: Partial<Extract<Message, { t: "welcome" }>> = {}): Promise<void> {
  open(r, welcomeOver);
  r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
  r.wire.deliver(snapOf(BOT, BOT_LOG));
  await flush();
  r.wire.take();
  r.seen();
}

const twoServers = (peer: Partial<WelcomeServers[number]> = {}): WelcomeServers => [
  { id: SRV, name: "Studio", state: "live", since: 1 },
  { id: PEER, name: "Linux box", state: "live", since: 2, ...peer },
];

/** Two servers: the peer's `srv:` table is followed. `rows`: its catch-up (one bot row, rev 1) comes too. */
async function attachPeer(r: Rig, over: { rows?: boolean; peer?: Partial<WelcomeServers[number]> } = {}): Promise<void> {
  open(r, { servers: twoServers(over.peer) });
  r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
  r.wire.deliver(snapOf(BOT, BOT_LOG));
  if (over.rows !== false) r.wire.deliverWire(peerRows({ rows: [farRow()] }));
  await flush();
  r.wire.take();
  r.seen();
}

// ---------------------------------------------------------------------------------------------

describe("a peer table's reset: onTableReset (D50)", () => {
  it("a delivered item of the table's stream is marked lost when the reset's retired logId kept less than the item's seq; one at the kept seq is not", async () => {
    const r = await rig();
    await attachPeer(r, { rows: false }); // the table is followed but has had no catch-up: nothing is sent to it
    const lost = await r.link.submit(PEER_STREAM, react("m1"));
    const kept = await r.link.submit(PEER_STREAM, react("m2"));
    expect(r.wire.take()).toEqual([]);
    r.wire.deliver(resultOf(lost.slot, { kind: "applied", result: {} }, PEER_LOG, 5));
    r.wire.deliver(resultOf(kept.slot, { kind: "applied", result: {} }, PEER_LOG, 2));
    await flush();
    r.wire.deliverWire(peerRows({ to: 5 }));
    await flush();
    // no cursor covers a table: both stay in the outbox as delivered
    expect(r.link.pending(PEER_STREAM).map((p) => [p.slot.n, p.state, p.lost])).toEqual([[1, "delivered", false], [2, "delivered", false]]);
    r.seen();
    r.wire.deliver(resetOf(PEER_STREAM, "incb-0002", [{ logId: PEER_LOG, keptSeq: 2 }]));
    await flush();
    expect(r.link.pending(PEER_STREAM).map((p) => [p.slot.n, p.state, p.lost])).toEqual([[1, "delivered", true], [2, "delivered", false]]);
    // the sync part first, then the UI is asked to look once the write is durable
    expect(r.seen()).toEqual(["servers srv:srvB +[] -[]", "reset srv:srvB incb-0002", "state catching up", "pending"]);
    expect(r.storage.snapshot().retired[PEER_STREAM]).toEqual([{ logId: PEER_LOG, keptSeq: 2 }]); // durable
  });

  it("a reset that marks nothing lost asks the UI to look at nothing: no pending event", async () => {
    const r = await rig();
    await attachPeer(r);
    r.wire.deliver(resetOf(PEER_STREAM, "incb-0002", [{ logId: PEER_LOG, keptSeq: 1 }]));
    await flush();
    expect(r.seen()).toEqual(["servers srv:srvB +[] -[bot:far1]", "reset srv:srvB incb-0002", "state catching up"]);
  });

  it("a settled delivered item comes back as 'delivered, then lost' once, and leaves settledRecent when it does", async () => {
    const r = await rig();
    await attach(r, { servers: [{ id: SRV, name: "Studio", state: "live", since: 1 }] }); // the peer is not known yet
    const item = await r.link.submit(PEER_STREAM, react("m1"));
    r.wire.deliver(resultOf(item.slot, { kind: "applied", result: {} }, PEER_LOG, 5));
    await flush();
    expect(r.link.pending()).toEqual([]); // a stream nobody follows: the delivered item leaves the outbox at once (settledRecent)
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 3 });
    r.wire.deliverWire(peerRows({ to: 3 }));
    await flush();
    r.wire.take();
    r.seen();

    r.wire.deliver(resetOf(PEER_STREAM, "incb-0002", [{ logId: PEER_LOG, keptSeq: 2 }]));
    await flush();
    expect(r.seen()).toEqual([
      "servers srv:srvB +[] -[]", "reset srv:srvB incb-0002", "state catching up",
      "outcome srv:srvB#1 applied", "pending", // the revived item
    ]);
    const [back] = r.link.pending(PEER_STREAM);
    expect(back).toMatchObject({ state: "delivered", lost: true });
    expect(back.slot).toEqual(item.slot);

    // the UI dismisses it; a second reset naming the same retired logId finds nothing left in settledRecent
    await r.link.dismiss(item.slot);
    expect(r.link.pending()).toEqual([]);
    r.seen();
    r.wire.deliver(resetOf(PEER_STREAM, "incb-0003", [{ logId: "incb-0002", keptSeq: 0 }, { logId: PEER_LOG, keptSeq: 2 }]));
    await flush();
    expect(r.seen().filter((line) => line.startsWith("outcome"))).toEqual([]);
    expect(r.link.pending()).toEqual([]);
  });

  it("a settled item whose seq the retired log kept is not revived", async () => {
    const r = await rig();
    await attach(r, { servers: [{ id: SRV, name: "Studio", state: "live", since: 1 }] });
    const item = await r.link.submit(PEER_STREAM, react("m1"));
    r.wire.deliver(resultOf(item.slot, { kind: "applied", result: {} }, PEER_LOG, 2));
    await flush();
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 3 });
    r.wire.deliverWire(peerRows({ to: 3 }));
    await flush();
    r.seen();
    r.wire.deliver(resetOf(PEER_STREAM, "incb-0002", [{ logId: PEER_LOG, keptSeq: 2 }]));
    await flush();
    expect(r.seen()).toEqual(["servers srv:srvB +[] -[]", "reset srv:srvB incb-0002", "state catching up"]);
    expect(r.link.pending()).toEqual([]);
  });
});

describe("rows of a peer's table: onRows", () => {
  it("a batch that starts above the copy's rev is a gap: sub again from the copy's cursor, nothing applied, no event", async () => {
    const r = await rig();
    await attachPeer(r);
    expect(r.link.table(PEER)).toMatchObject({ logId: PEER_LOG, rev: 1, caught: true });
    r.wire.deliverWire(peerRows({ after: 5, to: 6, rows: [{ key: "bot:other", rev: 6, body: summaryRow() }] }));
    expect(r.wire.take()).toEqual([`sub srv:srvB ${PEER_LOG}#1`]);
    expect(r.seen()).toEqual([]);
    expect(r.link.table(PEER)).toMatchObject({ logId: PEER_LOG, rev: 1, caught: true });
    expect([...(r.link.table(PEER)?.rows.keys() ?? [])]).toEqual(["bot:far1"]);
    // the next batch that follows applies
    r.wire.deliverWire(peerRows({ after: 1, to: 2, rows: [{ key: "bot:other", rev: 2, body: summaryRow() }] }));
    expect(r.wire.take()).toEqual([]);
    expect(r.seen().slice(0, 1)).toEqual(["servers srv:srvB +[bot:other] -[]"]);
    expect(r.link.table(PEER)).toMatchObject({ rev: 2 });
  });

  it("rows with no catch-up before them, and a whole table of another logId with no reset, ask for a sub again", async () => {
    const r = await rig();
    await attachPeer(r, { rows: false });
    r.wire.deliverWire(peerRows({ after: 3, to: 4 })); // the copy has no logId yet: ask for the whole table
    expect(r.wire.take()).toEqual(["sub srv:srvB -"]);
    expect(r.seen()).toEqual([]);
    r.wire.deliverWire(peerRows({ to: 1, rows: [farRow()] }));
    r.wire.take();
    r.seen();
    r.wire.deliverWire(peerRows({ logId: "incb-0009", to: 4 })); // another logId, no reset first: only a reset moves the copy
    expect(r.wire.take()).toEqual([`sub srv:srvB ${PEER_LOG}#1`]);
    expect(r.seen()).toEqual([]);
    expect(r.link.table(PEER)).toMatchObject({ logId: PEER_LOG, rev: 1 });
  });

  it("parts of one batch with a part that does not match the first: sub again from the cursor", async () => {
    const r = await rig();
    await attachPeer(r);
    r.wire.deliverWire(peerRows({ after: 1, to: 3, more: true, rows: [{ key: "bot:p1", rev: 2, body: summaryRow() }] }));
    expect(r.wire.take()).toEqual([]);
    r.wire.deliverWire(peerRows({ after: 1, to: 4, rows: [{ key: "bot:p2", rev: 4, body: summaryRow() }] })); // `to` differs
    expect(r.wire.take()).toEqual([`sub srv:srvB ${PEER_LOG}#1`]);
    expect(r.seen()).toEqual([]);
    expect(r.link.table(PEER)).toMatchObject({ rev: 1 });
  });

  it("the catch-up that completes the tables: servers, the outbox goes out, the state turns live, then pending (in that order)", async () => {
    const r = await rig();
    open(r, { servers: twoServers() });
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    await r.link.submit(BOT, react("m1")); // waits: the peer's table has had no catch-up
    r.wire.take();
    r.seen();
    expect(r.link.state).toBe("catching up");
    r.wire.deliverWire(peerRows({ rows: [farRow()] }));
    expect(r.wire.take()).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
    expect(r.seen()).toEqual(["servers srv:srvB +[bot:far1] -[]", "state live", "pending"]);
    expect(r.link.state).toBe("live");
  });

  it("parts wait without an event until the last is in; rows of a stream nobody follows, or of a retired logId, are dropped", async () => {
    const r = await rig();
    await attachPeer(r, { rows: false });
    r.wire.deliverWire(peerRows({ to: 2, more: true, rows: [farRow(1)] }));
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
    expect(r.link.table(PEER)).toMatchObject({ logId: null, caught: false });
    r.wire.deliverWire(peerRows({ to: 2, rows: [{ key: "bot:far2", rev: 2, body: summaryRow() }] }));
    expect(r.seen()[0]).toBe("servers srv:srvB +[bot:far1,bot:far2] -[]");
    expect(r.link.table(PEER)).toMatchObject({ logId: PEER_LOG, rev: 2, caught: true });
    r.wire.take();
    r.seen();

    r.wire.deliverWire(peerRows({ stream: "srv:srvZ", logId: "incz-0001", rows: [farRow()] })); // not followed
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);

    r.wire.deliver(resetOf(PEER_STREAM, "incb-0002", [{ logId: PEER_LOG, keptSeq: 2 }]));
    r.wire.take();
    r.seen();
    r.wire.deliverWire(peerRows({ to: 3, rows: [farRow(3)] })); // the retired logId: dropped, no resub
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
    expect(r.link.table(PEER)).toMatchObject({ logId: "incb-0002", rev: 0, caught: false });
  });
});

describe("a peer's state: onPeer", () => {
  it("a peer frame without dh or addresses keeps the dh and addresses of the view; the name stays, the state and since follow", async () => {
    const r = await rig();
    await attachPeer(r, { peer: { dh: DH, addresses: { tailnet: TAILNET, relay: RELAY } } });
    r.wire.deliver({ t: "peer", serverId: PEER, state: "stale", since: 6 });
    expect(r.link.servers().find((s) => s.id === PEER)).toEqual({ id: PEER, name: "Linux box", state: "stale", since: 6, self: false, dh: DH, addresses: { tailnet: TAILNET, relay: RELAY } });
    // a new dh replaces the known one; the addresses are still the known ones
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 7, dh: DH2 });
    expect(r.link.servers().find((s) => s.id === PEER)).toEqual({ id: PEER, name: "Linux box", state: "live", since: 7, self: false, dh: DH2, addresses: { tailnet: TAILNET, relay: RELAY } });
  });

  it("a peer that never told its dh has none; one that tells it gets it, and keeps it over the next frames", async () => {
    const r = await rig();
    await attachPeer(r);
    expect("dh" in (r.link.servers().find((s) => s.id === PEER) ?? {})).toBe(false);
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 4, dh: DH });
    expect(r.link.servers().find((s) => s.id === PEER)?.dh).toBe(DH);
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 5 });
    expect(r.link.servers().find((s) => s.id === PEER)?.dh).toBe(DH);
  });

  it("addresses in a peer frame replace the known ones whole; empty addresses clear them", async () => {
    const r = await rig();
    await attachPeer(r, { peer: { addresses: { tailnet: TAILNET, relay: RELAY } } });
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 4, addresses: { tailnet: TAILNET2 } });
    expect(r.link.servers().find((s) => s.id === PEER)?.addresses).toEqual({ tailnet: TAILNET2 }); // the relay is not merged in
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 5, addresses: {} });
    expect("addresses" in (r.link.servers().find((s) => s.id === PEER) ?? {})).toBe(false);
  });

  it("a peer that is gone has no addresses, even when its frame carries them or the view had them; the dh stays; a later frame does not bring them back", async () => {
    const r = await rig();
    await attachPeer(r, { peer: { dh: DH, addresses: { tailnet: TAILNET, relay: RELAY } } });
    r.wire.deliver({ t: "peer", serverId: PEER, state: "gone", since: 9, addresses: { tailnet: TAILNET2 } });
    const gone = r.link.servers().find((s) => s.id === PEER);
    expect(gone).toEqual({ id: PEER, name: "Linux box", state: "gone", since: 9, self: false, dh: DH });
    expect("addresses" in (gone ?? {})).toBe(false);
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 10 });
    const back = r.link.servers().find((s) => s.id === PEER);
    expect(back).toEqual({ id: PEER, name: "Linux box", state: "live", since: 10, self: false, dh: DH });
    expect("addresses" in (back ?? {})).toBe(false);
  });

  it("a live peer ends the stale marks of the streams it owns, and only those; a peer that is not live does not", async () => {
    const r = await rig();
    await attachPeer(r);
    const far = "bot:far1" as StreamId;
    r.wire.deliver({ t: "stale", stream: far, since: 5 });
    r.wire.deliver({ t: "stale", stream: BOT, since: 6 });
    expect(r.link.staleSince(far)).toBe(5);
    r.wire.deliver({ t: "peer", serverId: PEER, state: "stale", since: 7 });
    expect(r.link.staleSince(far)).toBe(5);
    r.wire.deliver({ t: "peer", serverId: PEER, state: "live", since: 8 });
    expect(r.link.staleSince(far)).toBeNull();
    expect(r.link.staleSince(BOT)).toBe(6); // owned by the attached server
  });
});

describe("cancel.noted: onCancelNoted (D59)", () => {
  it("the UI is asked to look once; a repeat, an unknown slot, an item with no cancel asked and a resolved item say nothing", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    const plain = await r.link.submit(BOT, react("m2"));
    await r.link.cancel(item.slot);
    expect(r.wire.take()).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`, `cmd bot:b1#2 inc=${SRV_LOG} floor=1`, "cancel bot:b1#1"]);
    r.seen();
    r.wire.deliver({ t: "cancel.noted", slot: item.slot });
    expect(r.seen()).toEqual(["pending"]);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.cancelNoted === true])).toEqual([[1, true], [2, false]]);
    r.wire.deliver({ t: "cancel.noted", slot: item.slot }); // noted again
    r.wire.deliver({ t: "cancel.noted", slot: { ...item.slot, n: 77 } }); // unknown
    r.wire.deliver({ t: "cancel.noted", slot: plain.slot }); // its cancel was never asked
    expect(r.seen()).toEqual([]);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.cancelNoted === true])).toEqual([[1, true], [2, false]]);
    r.wire.deliver(resultOf(item.slot, { kind: "cancelled" }, BOT_LOG, 1));
    await flush();
    r.seen();
    r.wire.deliver({ t: "cancel.noted", slot: item.slot }); // the item is resolved
    expect(r.seen()).toEqual([]);
    expect(r.link.pending(BOT)[0].cancelNoted).toBeUndefined();
  });

  it("the owner's note ends the D67 stop of that slot", async () => {
    const r = await rig();
    await attach(r);
    const a = await r.link.submit(BOT, react("m1"));
    await stopSlot(r, a.slot);
    expect(r.link.pending(BOT)[0].stopped).toBe(true);
    await r.link.cancel(a.slot); // a stopped slot sends no cancel
    expect(r.wire.take().filter((line) => line.startsWith("cancel"))).toEqual([]);
    r.seen();
    r.wire.deliver({ t: "cancel.noted", slot: a.slot });
    expect(r.seen()).toEqual(["pending"]);
    const [view] = r.link.pending(BOT);
    expect(view.cancelNoted).toBe(true);
    expect(view.stopped).toBeUndefined();
  });
});

describe("cancel.noted and the D67 count", () => {
  it("the owner's note also restarts the count of unsettled endings: four before it and one after do not stop the slot", async () => {
    const r = await rig();
    await attach(r);
    const a = await r.link.submit(BOT, react("m1"));
    await byeRounds(r, a.slot, 4);
    await r.link.cancel(a.slot);
    r.wire.deliver({ t: "cancel.noted", slot: a.slot });
    await byeRounds(r, a.slot, 1);
    expect(r.link.pending(BOT)[0].stopped).toBeUndefined();
    expect(r.link.pending(BOT)[0].cancelNoted).toBe(true);
    // without the note, the fifth ending stops a slot
    const b = await r.link.submit(BOT2, react("m2", "b2"));
    await byeRounds(r, b.slot, 5);
    expect(r.link.pending(BOT2)[0].stopped).toBe(true);
  });
});

describe("an outcome for a slot: resolveSlot", () => {
  it("a slot conflict moves the item to a new slot: one pending event, the item goes out at once under the new slot, and its 'sending' marker starts again", async () => {
    let n = 0;
    const r = await rig({ newEpoch: () => (++n).toString(16).padStart(32, "0") });
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    expect(r.wire.takeRaw().map((f) => (f.slot as Slot).originEpoch)).toEqual([EPOCH]);
    r.clock.advance(1_000); // long past the marker's 150 ms
    expect(r.link.pending(BOT)[0].sending).toBe(true);
    r.seen();
    r.wire.deliver(resultOf(item.slot, { kind: "refused", reason: "slot conflict" }, SRV_LOG, null));
    await flush();
    expect(r.seen()).toEqual(["pending"]); // no outcome: the item is not resolved, it moved
    const sent = r.wire.takeRaw();
    expect(sent.map(brief)).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
    const moved = { origin: DEVICE, originEpoch: "00000000000000000000000000000002", target: BOT, n: 1 };
    expect(sent[0].slot).toEqual(moved);
    expect(sent[0].cmd).toEqual(react("m1"));
    const [view] = r.link.pending(BOT);
    expect(view).toMatchObject({ slot: moved, state: "waiting", sending: false });
    r.clock.advance(149);
    expect(r.link.pending(BOT)[0].sending).toBe(false);
    r.clock.advance(1);
    expect(r.link.pending(BOT)[0].sending).toBe(true);
  });

  it("a late outcome for a stopped slot ends its stop: the item shows its outcome and the next attach sends the one behind it", async () => {
    const r = await rig();
    await attach(r);
    const a = await r.link.submit(BOT, react("m1"));
    await r.link.submit(BOT, react("m2"));
    await stopSlot(r, a.slot);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.stopped === true])).toEqual([[1, true], [2, false]]);
    r.seen();
    r.wire.deliver(resultOf(a.slot, { kind: "refused", reason: "changed" }, BOT_LOG, 1));
    await flush();
    expect(r.seen()).toEqual(["outcome bot:b1#1 refused", "pending"]);
    const views = r.link.pending(BOT);
    expect(views.map((p) => [p.slot.n, p.state, p.stopped === true])).toEqual([[1, "not sent", false], [2, "waiting", false]]);
    r.wire.drop();
    r.clock.advance(5_000);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    expect(r.wire.take().filter((line) => line.startsWith("cmd"))).toEqual([`cmd bot:b1#2 inc=${SRV_LOG} floor=2`]);
  });
});

describe("a stopped slot holds back the queue behind it: isQueueStopped (D67)", () => {
  it("only the same epoch and the same target are held back: a slot of a later epoch, and one of another target, are sent", async () => {
    const r = await rig({ newEpoch: (() => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); })() });
    await attach(r);
    r.link.subscribe(BOT2);
    const a = await r.link.submit(BOT, react("m1"));
    const behind = await r.link.submit(BOT, react("m2"));
    r.wire.take();
    await stopSlot(r, a.slot);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.stopped === true])).toEqual([[1, true], [2, false]]);
    expect(r.wire.take().filter((line) => line.startsWith("cmd"))).toEqual([]); // both are held back
    expect(behind.slot.n).toBe(2);

    // another target: not held back
    const other = await r.link.submit(BOT2, react("m3", "b2"));
    expect(r.wire.take()).toEqual([`cmd bot:b2#1 inc=${SRV_LOG} floor=1`]);
    expect(other.slot.target).toBe(BOT2);

    // the owner is past this store's counter: new slots go under a new epoch, which the old epoch's stop does not hold back
    r.wire.drop();
    r.clock.advance(5_000);
    r.wire.open();
    r.wire.deliver(welcome({ next: { [BOT]: 50 } as never }));
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG, 9));
    r.wire.deliver(snapOf(BOT, BOT_LOG, 9));
    await flush();
    r.wire.take();
    const later = await r.link.submit(BOT, react("m4"));
    expect(later.slot).toMatchObject({ originEpoch: "00000000000000000000000000000002", n: 1 });
    expect(r.wire.takeRaw().filter((f) => f.t === "cmd").map(brief)).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
    // the two slots of the old epoch are still held back
    expect(r.link.pending(BOT).map((p) => [p.slot.originEpoch.slice(-1), p.slot.n, p.stopped === true])).toEqual([["1", 1, true], ["1", 2, false], ["2", 1, false]]);
  });
});

describe("a slot behind the stopped one only", () => {
  it("a slot with a lower n than the stopped one is still sent on every attach", async () => {
    const r = await rig();
    await attach(r);
    const first = await r.link.submit(BOT, react("m1"));
    const second = await r.link.submit(BOT, react("m2"));
    const cmds = await stopSlot(r, second.slot);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.stopped === true])).toEqual([[1, false], [2, true]]);
    expect(cmds).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]); // the stopped slot waits for the user, the one before it goes
    expect(first.slot.n).toBe(1);
  });
});

describe("a res too large for one frame: res.part (onResPart)", () => {
  const resText = (req: string, result: unknown) => JSON.stringify({ t: "res", req, ok: true, result });
  const parts = (req: string, text: string, sizes: number[]) => {
    let at = 0;
    return sizes.map((size, i) => { const part = { t: "res.part", req, i, n: sizes.length, text: text.slice(at, at + size) }; at += size; return part; });
  };

  it("the parts are joined in order into the res of that req; the request resolves only after the last part", async () => {
    const r = await rig();
    await attach(r);
    const answer = r.link.request({ type: "plugins.web" } as never);
    expect(r.wire.take()).toEqual(["req r1 plugins.web"]);
    const text = resText("r1", { plugins: ["筆記", "x".repeat(40)] });
    const [p0, p1, p2] = parts("r1", text, [10, 20, text.length - 30]);
    let settled = false;
    void answer.then(() => { settled = true; }, () => { settled = true; });
    r.wire.deliver(p0);
    r.wire.deliver(p1);
    await flush();
    expect(settled).toBe(false);
    r.wire.deliver(p2);
    await expect(answer).resolves.toEqual({ plugins: ["筆記", "x".repeat(40)] });
    r.wire.deliver({ t: "res", req: "r1", ok: true, result: 1 }); // the request is gone: nothing more
    expect(r.seen()).toEqual([]);
  });

  it("parts of an error res reject the request with the wire error", async () => {
    const r = await rig();
    await attach(r);
    const answer = r.link.request({ type: "plugins.web" } as never);
    const text = JSON.stringify({ t: "res", req: "r1", ok: false, error: { code: "internal", message: "boom" } });
    for (const part of parts("r1", text, [15, text.length - 15])) r.wire.deliver(part);
    await expect(answer).rejects.toMatchObject({ message: "boom", wire: { code: "internal", message: "boom" } });
  });

  it("parts out of order reject the request with an internal wire error, once; a part after that is dropped", async () => {
    const r = await rig();
    await attach(r);
    const answer = r.link.request({ type: "plugins.web" } as never);
    const text = resText("r1", { a: 1 });
    const [p0, p1] = parts("r1", text, [10, text.length - 10]);
    r.wire.deliver(p1); // i = 1 first
    await expect(answer).rejects.toMatchObject({
      message: "fe-link: res.part 2/2 of r1 out of order",
      wire: { code: "internal", message: "res.part 2/2 of r1 out of order" },
    });
    r.wire.deliver(p0); // no request any more
    await flush();
    expect(r.seen()).toEqual([]);
  });

  it("parts that are not JSON, or are the res of another req, reject the request", async () => {
    const r = await rig();
    await attach(r);
    const notJson = r.link.request({ type: "plugins.web" } as never);
    for (const part of parts("r1", "this is not json at all", [10, 13])) r.wire.deliver(part);
    await expect(notJson).rejects.toMatchObject({ message: "fe-link: the parts of r1 are not JSON", wire: { code: "internal" } });
    const other = r.link.request({ type: "plugins.web" } as never);
    const text = resText("r9", { a: 1 }); // a res, but of another request
    for (const part of parts("r2", text, [10, text.length - 10])) r.wire.deliver(part);
    await expect(other).rejects.toMatchObject({ message: "fe-link: the parts of r2 are not its res", wire: { code: "internal" } });
  });

  it("parts for a request nobody waits for, or one that is not a res request, are dropped: the other request stays open", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver({ t: "res.part", req: "r7", i: 1, n: 2, text: "{}" }); // no request r7
    const page = r.link.history(BOT, "m5");
    expect(r.wire.take()).toEqual([`history r1 ${BOT}`]);
    // out of order parts would fail a res request: for a history request they are ignored
    r.wire.deliver({ t: "res.part", req: "r1", i: 1, n: 2, text: "{}" });
    let settled = false;
    void page.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    r.wire.deliver({ t: "history.page", req: "r1", stream: BOT, logId: BOT_LOG, messages: [], hasMore: false, older: 0 });
    await expect(page).resolves.toMatchObject({ t: "history.page", hasMore: false });
    expect(r.seen()).toEqual([]);
  });

  it("the session ends with a part in: the request rejects, and a res of the next request is joined from its own parts", async () => {
    const r = await rig();
    await attach(r);
    const first = r.link.request({ type: "plugins.web" } as never);
    const text = resText("r1", { a: 1 });
    const [p0] = parts("r1", text, [10, text.length - 10]);
    r.wire.deliver(p0);
    r.wire.drop();
    await expect(first).rejects.toThrow("fe-link: the session ended");
    r.clock.advance(250);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    const second = r.link.request({ type: "plugins.web" } as never);
    const text2 = resText("r2", { b: 2 });
    for (const part of parts("r2", text2, [8, text2.length - 8])) r.wire.deliver(part);
    await expect(second).resolves.toEqual({ b: 2 });
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * D67: `rounds` sessions in a row (five stop a slot) end `bye{unsettled}` on `slot`, each followed by a reconnect.
 * Leaves a fresh attached session; returns the `cmd` lines the last attach sent.
 */
async function byeRounds(r: Rig, slot: Slot, rounds: number): Promise<string[]> {
  for (let i = 0; i < rounds; i += 1) {
    r.wire.deliver({ t: "bye", reason: "unsettled", slot });
    r.clock.advance(5_000);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG, i));
    r.wire.deliver(snapOf(BOT, BOT_LOG, i));
  }
  await flush();
  const cmds = r.wire.take().filter((line) => line.startsWith("cmd"));
  r.seen();
  return cmds;
}
const stopSlot = (r: Rig, slot: Slot) => byeRounds(r, slot, 5);

function summaryRow() {
  return {
    name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
    waiting: [], unread: 0, lastAt: null, lines: ["hello"],
  };
}
