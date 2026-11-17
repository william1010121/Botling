// M7-S93: characterization tests for `src/fe-link/link.ts`, recorded on the base commit (before the file is cut by
// M7-S94). They import `link.ts` directly (the other tests go through the barrel) and drive it with a scripted wire:
// no fake server, every frame the front end sends and every frame it hears is written out in the test, so the golden
// is the exact conversation: hello / welcome, a front end that is too old, batches in and out of order, a closed
// connection and its reconnect, a stale live stream, a server switch, and the `via` of a command (plan change N1).
// The goldens are plain arrays in the test body (frames as short lines, listener calls as short lines); a change of
// behaviour in link.ts, even one that keeps the end state, changes a line here.
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, type ContentReadMessage, type Dial, type FeLinkEvent, type FeLinkOptions, type FeSocket, type SocketHandlers } from "../../src/fe-link/link";
import { MemoryFeStorage } from "../../src/fe-link/storage";
import { encodeFrame, encodeWireFrame, type Message, type Slot, type StreamId, type Via } from "../../src/protocol";
import { PluginRow } from "../../src/protocol/table-rows";
import { FakeClock, flush } from "./fe-link-harness";

// ---------------------------------------------------------------------------------------------
// The scripted wire

const SRV = "srv1";
const SRV_STREAM = `srv:${SRV}` as StreamId;
const SRV_LOG = "incsrv-0001";
const BOT = "bot:b1" as StreamId;
const BOT_LOG = "botlog-0001";
const EPOCH = "00000000000000000000000000000001";
const DEVICE = "desktop";

/** A 64-hex entry hash that is easy to read in a failure: the number `n`. */
const H = (n: number) => n.toString(16).padStart(64, "0");

const react = (messageId: string) => ({ type: "chat.react", botId: "b1", messageId, emoji: "👍", present: true }) as const;
const DH = Buffer.alloc(32, 5).toString("base64url");
const VAPID_KEY = Buffer.from([4, ...new Array(64).fill(3)]).toString("base64url");
const VIA: Via = { plugin: "notes-helper", codeHash: "sha256:" + "ab".repeat(32) };

interface Sess {
  handlers: SocketHandlers;
  /** Every frame the front end sent on this session, parsed. */
  sent: Array<Record<string, unknown>>;
  bytes: Uint8Array[];
  closedByFe: boolean;
}

class Wire {
  readonly sessions: Sess[] = [];
  /** Every dial in order, also one that threw. */
  dials = 0;
  throwOnDial = false;
  throwOnSend = false;
  /** Report `open()` from inside the dial, before it returns (the transport may do either). */
  openEarly = false;
  withBytes = true;
  constructor(readonly local = true) {}

  readonly dial: Dial = (handlers) => {
    this.dials += 1;
    if (this.throwOnDial) throw new Error("dial failed");
    const sess: Sess = { handlers, sent: [], bytes: [], closedByFe: false };
    this.sessions.push(sess);
    const socket: FeSocket = {
      send: (frame) => {
        if (this.throwOnSend) throw new Error("socket is gone");
        sess.sent.push(JSON.parse(frame) as Record<string, unknown>);
      },
      close: () => { sess.closedByFe = true; },
    };
    if (this.withBytes) socket.sendBytes = (bytes) => { sess.bytes.push(bytes); };
    if (this.openEarly) handlers.open();
    return socket;
  };

  get last(): Sess { return this.sessions[this.sessions.length - 1]; }
  /** The transport reports the socket open. */
  open(sess: Sess = this.last): void { sess.handlers.open(); }
  /** The server sends a message. */
  deliver(message: Message, sess: Sess = this.last): void {
    const encoded = encodeFrame(message, "server", { local: this.local });
    if (!encoded.ok) throw new Error(`test wire: cannot encode ${message.t}: ${encoded.detail}`);
    sess.handlers.frame(encoded.text);
  }
  /** The server sends a message of the M3 codec (`rows`). */
  deliverWire(message: Record<string, unknown>, sess: Sess = this.last): void {
    const encoded = encodeWireFrame(message as never, "server", { local: this.local });
    if (!encoded.ok) throw new Error(`test wire: cannot encode ${String(message.t)}: ${encoded.detail}`);
    sess.handlers.frame(encoded.text);
  }
  /** The transport reports the connection closed. */
  drop(detail = "lost", sess: Sess = this.last): void { sess.handlers.close(detail); }
  /** Frames sent on `sess` since the last `take`, as short lines. */
  private readonly taken = new Map<Sess, number>();
  take(sess: Sess = this.last): string[] {
    const from = this.taken.get(sess) ?? 0;
    this.taken.set(sess, sess.sent.length);
    return sess.sent.slice(from).map(brief);
  }
  /** The frames of `sess` since the last `take`, whole. */
  takeRaw(sess: Sess = this.last): Array<Record<string, unknown>> {
    const from = this.taken.get(sess) ?? 0;
    this.taken.set(sess, sess.sent.length);
    return sess.sent.slice(from);
  }
}

const cur = (c: { logId: string; seq: number } | null | undefined) => (c ? `${c.logId}#${c.seq}` : "-");
const slotOf = (s: Slot) => `${s.target}#${s.n}`;

/** One frame the front end sent, as a short line. */
function brief(frame: Record<string, unknown>): string {
  switch (frame.t) {
    case "sub": return `sub ${String(frame.stream)} ${cur(frame.cursor as never)}`;
    case "unsub": return `unsub ${String(frame.stream)}`;
    case "ack": return `ack ${String(frame.stream)} ${cur(frame.cursor as never)}`;
    case "cmd": return `cmd ${slotOf(frame.slot as Slot)} inc=${String(frame.inc)} floor=${String(frame.floor)}${frame.via ? ` via=${(frame.via as Via).plugin}` : ""}${frame.basis ? ` basis=${cur(frame.basis as never)}` : ""}`;
    case "cancel": return `cancel ${slotOf(frame.slot as Slot)}`;
    case "bye": return `bye ${String(frame.reason)}${frame.detail ? ` (${String(frame.detail)})` : ""}`;
    case "live.resync": return `live.resync ${String(frame.stream)}`;
    case "ping": return "ping";
    case "req": return `req ${String(frame.req)} ${String((frame.cmd as { type: string }).type)}`;
    case "history": return `history ${String(frame.req)} ${String(frame.stream)} before=${String(frame.before)}`;
    default: return String(frame.t) + (frame.req ? ` ${String(frame.req)}` : "");
  }
}

/** One listener call, as a short line. */
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

const welcome = (over: Partial<Extract<Message, { t: "welcome" }>> = {}): Message => ({
  t: "welcome", serverId: SRV, protocol: { min: 1, max: 1 }, minFeVersion: "3.0.0", rosterDigest: null, servers: [], next: {}, views: {}, ...over,
});
const snapOf = (stream: StreamId, logId: string, seq = 0): Message => ({ t: "snap", stream, logId, seq, hash: H(seq), view: {} });
const entry = (seq: number, kind: string, body: Record<string, unknown>, logId = BOT_LOG, stream = BOT, slot?: Slot) =>
  ({ stream, logId, seq, hlc: { ms: seq, c: 0 }, kind, body, ...(slot ? { slot } : {}), hash: H(seq) }) as never;
const turnStarted = (seq: number) => entry(seq, "turn.started", { botId: "b1", turnId: `t${seq}`, messageId: `m${seq}` });
const turnFinished = (seq: number) => entry(seq, "turn.finished", { botId: "b1", turnId: `t${seq}`, messageId: `m${seq}`, status: "done", text: "ok" });
const batchOf = (entries: unknown[], prevHash: string, over: { stream?: StreamId; logId?: string; more?: boolean } = {}): Message => {
  const list = entries as Array<{ seq: number }>;
  return { t: "batch", stream: over.stream ?? BOT, logId: over.logId ?? BOT_LOG, from: list[0].seq, to: list[list.length - 1].seq, prevHash, entries: entries as never, more: over.more ?? false };
};
const live = (rev: number, at: number, text: string, turnId = "t1", seg = 0): Message => ({ t: "live", stream: BOT, turnId, seg, rev, at, text });
const resultOf = (slot: Slot, outcome: { kind: "applied"; result?: unknown } | { kind: "cancelled" } | { kind: "refused"; reason: string }, logId = BOT_LOG, seq: number | null = 1): Message =>
  ({ t: "cmd.result", slot, outcome, logId, seq } as never);

// ---------------------------------------------------------------------------------------------
// One link on the wire

const links: FeLink[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
});

const fixedEpoch = () => EPOCH;

interface Rig {
  wire: Wire;
  clock: FakeClock;
  storage: MemoryFeStorage;
  link: FeLink;
  events: string[];
  raw: FeLinkEvent[];
  /** The listener lines since the last call. */
  seen(): string[];
}

async function rig(over: Partial<FeLinkOptions> & { wire?: Wire; storage?: MemoryFeStorage; clock?: FakeClock; subscribe?: boolean; start?: boolean } = {}): Promise<Rig> {
  const { wire = new Wire(), storage = new MemoryFeStorage(), clock = new FakeClock(), subscribe = true, start = true, ...options } = over;
  const link = await FeLink.open({ storage, dial: wire.dial, deviceId: DEVICE, feVersion: "3.0.0", clock, newEpoch: fixedEpoch, local: wire.local, ...options });
  links.push(link);
  const events: string[] = [];
  const raw: FeLinkEvent[] = [];
  link.on((event) => { raw.push(event); events.push(describeEvent(event)); });
  if (subscribe) link.subscribe(BOT);
  if (start) link.start();
  let from = 0;
  return { wire, clock, storage, link, events, raw, seen: () => { const out = events.slice(from); from = events.length; return out; } };
}

/** Opens the session, welcomes it and delivers the owner's `srv:` snap and the bot's snap: the link is live and the
 *  next lines are the ones a test asserts. */
async function attach(r: Rig, welcomeOver: Partial<Extract<Message, { t: "welcome" }>> = {}): Promise<void> {
  r.wire.open();
  r.wire.deliver(welcome(welcomeOver));
  r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
  r.wire.deliver(snapOf(BOT, BOT_LOG));
  await flush();
  r.wire.take();
  r.seen();
}

// ---------------------------------------------------------------------------------------------

describe("hello and welcome", () => {
  it("the conversation of a first attach: hello, welcome, sub, snaps, acks (golden)", async () => {
    const r = await rig();
    expect(r.wire.dials).toBe(1);
    expect(r.wire.last.sent).toEqual([]); // nothing is sent before the transport is open
    expect(r.link.state).toBe("connecting");
    expect(r.link.attached).toBe(false);

    r.wire.open();
    expect(r.wire.last.sent).toEqual([
      { t: "hello", deviceId: DEVICE, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [BOT] },
    ]);
    expect(r.seen()).toEqual([]);

    r.wire.deliver(welcome());
    expect(r.wire.take()).toEqual(["hello", "sub bot:b1 -", "sub srv:srv1 -"]);
    expect(r.seen()).toEqual(["servers", "state catching up", "attached true"]);
    expect(r.link.attached).toBe(true);
    expect(r.link.server).toBe(SRV);
    expect(r.link.attachedServerId()).toBe(SRV);
    expect(r.link.state).toBe("catching up");

    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG, 0));
    expect(r.wire.take()).toEqual([`ack srv:srv1 ${SRV_LOG}#0`]);
    expect(r.seen()).toEqual(["snap srv:srv1 incsrv-0001#0"]);
    expect(r.link.state).toBe("catching up"); // the bot's snap is still due

    r.wire.deliver(snapOf(BOT, BOT_LOG, 3));
    expect(r.wire.take()).toEqual([`ack bot:b1 ${BOT_LOG}#3`]);
    expect(r.seen()).toEqual(["snap bot:b1 botlog-0001#3", "state live"]);
    expect(r.link.state).toBe("live");
    expect(r.link.status).toMatchObject({ state: "live", attached: true, offline: false, catching: false });
    await flush();
    expect(r.link.cursor(BOT)).toEqual({ logId: BOT_LOG, seq: 3, hash: H(3) });
    expect(r.storage.snapshot().cursors).toEqual({
      [BOT]: { logId: BOT_LOG, seq: 3, hash: H(3) },
      [SRV_STREAM]: { logId: SRV_LOG, seq: 0, hash: H(0) },
    });
  });

  it("hello carries the token when there is one; a remote link keeps working over the remote codec", async () => {
    const r = await rig({ wire: new Wire(false), token: "tok-0123456789abcdef", local: false });
    r.wire.open();
    expect(r.wire.last.sent[0]).toEqual({ t: "hello", deviceId: DEVICE, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [BOT], token: "tok-0123456789abcdef" });
    r.wire.deliver(welcome());
    expect(r.wire.take()).toEqual(["hello", "sub bot:b1 -", "sub srv:srv1 -"]);
    expect(r.link.attached).toBe(true);
  });

  it("the transport may report open before dial returns: the hello goes out once, after it returns", async () => {
    const wire = new Wire();
    wire.openEarly = true;
    const r = await rig({ wire });
    expect(wire.last.sent.map(brief)).toEqual(["hello"]);
    wire.open(); // a second open on the same session sends no second hello
    expect(wire.last.sent.map(brief)).toEqual(["hello"]);
    expect(r.events).toEqual([]);
  });

  it("welcome.servers fills the views (self flagged, a gone server without addresses) and a peer's table is followed", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({
      servers: [
        { id: SRV, name: "Studio", state: "live", since: 1 },
        { id: "srvB", name: "Linux box", state: "live", since: 2, dh: DH, addresses: { tailnet: "wss://100.64.0.2:7443/v3/ws", relay: { url: "wss://relay.example.com/r", room: "room1" } } },
        { id: "srvC", name: "Old box", state: "gone", since: 3, addresses: { tailnet: "wss://100.64.0.3:7443/v3/ws" } },
      ],
    }));
    expect(r.wire.take()).toEqual(["hello", "sub bot:b1 -", "sub srv:srv1 -", "sub srv:srvB -", "sub srv:srvC -"]);
    expect(r.link.servers()).toEqual([
      { id: SRV, name: "Studio", state: "live", since: 1, self: true },
      { id: "srvB", name: "Linux box", state: "live", since: 2, self: false, dh: DH, addresses: { tailnet: "wss://100.64.0.2:7443/v3/ws", relay: { url: "wss://relay.example.com/r", room: "room1" } } },
      { id: "srvC", name: "Old box", state: "gone", since: 3, self: false },
    ]);
    expect(r.link.ownerOf(SRV_STREAM)).toBe(SRV);
    expect(r.link.ownerOf("srv:srvB" as StreamId)).toBe("srvB");
    expect(r.link.ownerOf(BOT)).toBe(SRV);
    expect(r.link.table("srvB")).toMatchObject({ logId: null, rev: 0, caught: false });
    expect(r.link.table("nobody")).toBeNull();
    // the self view is added when the server forgot to list itself
    const alone = await rig();
    alone.wire.open();
    alone.wire.deliver(welcome({ serverId: "lonely" }));
    expect(alone.link.servers()).toEqual([{ id: "lonely", name: "lonely", state: "live", since: null, self: true }]);
  });

  it("the cluster VAPID key of the welcome is kept with its id, and dropped when the next welcome has none", async () => {
    const r = await rig();
    expect(r.link.vapidPublicKey).toBeNull();
    r.wire.open();
    r.wire.deliver(welcome({ vapidPublicKey: VAPID_KEY, vapidId: { gen: 2, id: 5 } }));
    expect(r.link.vapidPublicKey).toBe(VAPID_KEY);
    expect(r.link.vapidId).toEqual({ gen: 2, id: 5 });
    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    r.wire.deliver(welcome());
    expect(r.link.vapidPublicKey).toBeNull();
    expect(r.link.vapidId).toBeNull();
  });

  it("a frame other than welcome / ping / bye before the welcome ends the session with bye malformed, then it redials", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.take();
    r.wire.deliver(batchOf([turnStarted(1)], H(0)));
    expect(r.wire.take()).toEqual([`bye malformed ("batch" before welcome)`]);
    expect(r.wire.last.closedByFe).toBe(true);
    expect(r.events).toEqual([]); // never welcomed: no attached false
    expect(r.wire.dials).toBe(1);
    r.clock.advance(249);
    expect(r.wire.dials).toBe(1);
    r.clock.advance(1);
    expect(r.wire.dials).toBe(2);
  });

  it("rows before the welcome end the session the same way", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.take();
    r.wire.deliverWire({ t: "rows", stream: "srv:srvB", logId: "incb-0001", after: 0, to: 0, rows: [], more: false });
    expect(r.wire.take()).toEqual([`bye malformed ("rows" before welcome)`]);
    expect(r.wire.last.closedByFe).toBe(true);
  });

  it("a ping before the welcome is ignored; a second welcome on the same session changes nothing", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.take();
    r.wire.deliver({ t: "ping", at: 5 });
    expect(r.wire.take()).toEqual([]);
    r.wire.deliver(welcome());
    r.wire.take();
    r.seen();
    r.wire.deliver(welcome({ serverId: "other" }));
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
    expect(r.link.server).toBe(SRV);
  });

  it("a frame that does not decode ends the session: bye with the codec's reason", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.take();
    r.wire.last.handlers.frame("this is not json");
    const [bye] = r.wire.takeRaw();
    expect(bye).toMatchObject({ t: "bye", reason: "malformed" });
    expect(r.wire.last.closedByFe).toBe(true);
    r.clock.advance(250);
    expect(r.wire.dials).toBe(2);
  });

  it("welcome.next above this store's counter moves the outbox to a new epoch (§11.4)", async () => {
    let n = 0;
    const r = await rig({ newEpoch: () => (++n).toString(16).padStart(32, "0") });
    const first = r.link.epoch;
    expect(first).toBe("00000000000000000000000000000001");
    r.wire.open();
    r.wire.deliver(welcome({ next: { [BOT]: 7 } as never }));
    await flush();
    expect(r.link.epoch).toBe("00000000000000000000000000000002");
    const item = await r.link.submit(BOT, react("m1"));
    expect(item.slot).toMatchObject({ originEpoch: "00000000000000000000000000000002", n: 1 });
    // a counter the owner is not past leaves the epoch alone
    const calm = await rig({ newEpoch: fixedEpoch });
    calm.wire.open();
    calm.wire.deliver(welcome({ next: { [BOT]: 1 } as never }));
    await flush();
    expect(calm.link.epoch).toBe(EPOCH);
  });
});

describe("a front end that is too old", () => {
  it("minFeVersion above the front end: bye version, state update required, no redial, the outbox is kept", async () => {
    const r = await rig();
    await r.link.submit(BOT, react("m1")); // waiting in the outbox before any session
    r.seen();
    r.wire.open();
    r.wire.take();
    r.wire.deliver(welcome({ minFeVersion: "4.0.0" }));
    expect(r.wire.take()).toEqual(["bye version"]);
    expect(r.wire.last.closedByFe).toBe(true);
    expect(r.seen()).toEqual(["state update required"]);
    expect(r.link.state).toBe("update required");
    expect(r.link.status.minFeVersion).toBe("4.0.0");
    expect(r.link.attached).toBe(false);
    r.clock.advance(120_000);
    expect(r.wire.dials).toBe(1);
    expect(r.link.state).toBe("update required"); // final: the offline timer does not change it
    // the outbox is kept, and nothing is sent for it
    await flush();
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.state])).toEqual([[1, "waiting"]]);
    expect(r.storage.snapshot().items.map((item) => item.slot.n)).toEqual([1]);
    const later = await r.link.submit(BOT, react("m2"));
    expect(later.slot.n).toBe(2);
    expect(r.wire.last.sent.map(brief)).toEqual(["hello", "bye version"]); // no sub, no cmd: the session ended at the welcome
  });

  it.each([
    ["3.0.0", false],
    ["3.0.1", true],
    ["3.1.0", true],
    ["2.9.9", false],
    ["3.0.0-beta.2", false],
    ["3.0", false],
    ["3.0.0.1", true],
  ])("welcome.minFeVersion %s against feVersion 3.0.0: update required = %s", async (min, tooOld) => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({ minFeVersion: min }));
    expect(r.link.state === "update required").toBe(tooOld);
    expect(r.link.attached).toBe(!tooOld);
  });

  it.each([
    [{ min: 2, max: 3 }, "update required"],
    [{ min: 1, max: 3 }, "catching up"],
    [{ min: 1, max: 1 }, "catching up"],
  ])("welcome.protocol %j (this front end speaks 1) gives state %s", async (protocol, state) => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({ protocol }));
    expect(r.link.state).toBe(state);
    if (state === "update required") expect(r.wire.take()).toEqual(["hello", "bye version"]);
    expect(r.link.attached).toBe(state !== "update required");
  });

  it("bye{version} from the server is the same final state", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.take();
    r.seen();
    r.wire.deliver({ t: "bye", reason: "version" });
    expect(r.seen()).toEqual(["state update required", "attached false"]);
    expect(r.wire.take()).toEqual(["bye version"]);
    r.clock.advance(60_000);
    expect(r.wire.dials).toBe(1);
  });
});

describe("batches in and out of order (§8.1, §8.3)", () => {
  it("in order: entries, persist, ack; a batch at or below the cursor is dropped; an overlap applies only the new entries", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0)));
    expect(r.seen()).toEqual(["entries bot:b1 1:turn.started,2:turn.finished"]);
    expect(r.wire.take()).toEqual([`ack bot:b1 ${BOT_LOG}#2`]);
    expect(r.link.cursor(BOT)).toEqual({ logId: BOT_LOG, seq: 2, hash: H(2) });

    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0))); // a duplicate
    expect(r.seen()).toEqual([]);
    expect(r.wire.take()).toEqual([]);

    r.wire.deliver(batchOf([turnFinished(2), turnStarted(3), turnFinished(4)], H(1))); // an overlap
    expect(r.seen()).toEqual(["entries bot:b1 3:turn.started,4:turn.finished"]);
    expect(r.wire.take()).toEqual([`ack bot:b1 ${BOT_LOG}#4`]);
    await flush();
    expect(r.storage.snapshot().cursors[BOT]).toEqual({ logId: BOT_LOG, seq: 4, hash: H(4) });
  });

  it("out of order: a batch ahead of the cursor asks for a re-sub from the cursor and applies nothing; the batch that fills the gap applies; the early one, sent again, applies", async () => {
    const r = await rig();
    await attach(r);
    const early = batchOf([turnStarted(3), turnFinished(4)], H(2));
    r.wire.deliver(early);
    expect(r.wire.take()).toEqual([`sub bot:b1 ${BOT_LOG}#0`]);
    expect(r.seen()).toEqual([]);
    expect(r.link.cursor(BOT)?.seq).toBe(0);
    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0)));
    expect(r.wire.take()).toEqual([`ack bot:b1 ${BOT_LOG}#2`]);
    r.wire.deliver(early);
    expect(r.wire.take()).toEqual([`ack bot:b1 ${BOT_LOG}#4`]);
    expect(r.seen()).toEqual(["entries bot:b1 1:turn.started,2:turn.finished", "entries bot:b1 3:turn.started,4:turn.finished"]);
  });

  it("a prevHash that does not match drops the cache (event dropped, cursor gone) and asks for a snap", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1)], H(0)));
    r.wire.take();
    r.seen();
    r.wire.deliver(batchOf([turnFinished(2)], H(999)));
    expect(r.seen()).toEqual(["dropped bot:b1 (hash mismatch)", "state catching up"]);
    expect(r.wire.take()).toEqual(["sub bot:b1 -"]);
    expect(r.link.cursor(BOT)).toBeNull();
    await flush();
    expect(r.storage.snapshot().cursors[BOT]).toBeUndefined();
    expect(r.link.state).toBe("catching up"); // waiting for the snap
    r.wire.deliver(snapOf(BOT, BOT_LOG, 2));
    expect(r.link.state).toBe("live");
  });

  it("a batch for a stream nobody follows, one before the snap, one of another logId: nothing happens", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.take();
    r.seen();
    r.wire.deliver(batchOf([turnStarted(1)], H(0))); // the snap of the bot has not come
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
    r.wire.deliver(snapOf(BOT, BOT_LOG, 0));
    r.wire.take();
    r.seen();
    r.wire.deliver(batchOf([entry(1, "turn.started", { botId: "b1", turnId: "t1", messageId: "m1" }, "otherlog-01")], H(0), { logId: "otherlog-01" }));
    expect(r.wire.take()).toEqual([]);
    const other = "bot:other" as StreamId;
    r.wire.deliver(batchOf([entry(1, "turn.started", { botId: "other", turnId: "t1", messageId: "m1" }, "otherlog-01", other)], H(0), { stream: other, logId: "otherlog-01" }));
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
  });

  it("a page with more: true holds the state at catching up until the last page", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1)], H(0), { more: true }));
    expect(r.seen()).toEqual(["entries bot:b1 1:turn.started", "state catching up"]);
    r.wire.deliver(batchOf([turnFinished(2)], H(1)));
    expect(r.seen()).toEqual(["entries bot:b1 2:turn.finished", "state live"]);
  });

  it("an outcome entry of this device's slot resolves the outbox item: one outcome call, the item leaves the outbox once the cursor covers it", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    expect(r.wire.take()).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
    r.seen();
    r.wire.deliver(batchOf([entry(1, "cmd.applied", { slot: item.slot, result: { n: 1 } }, BOT_LOG, BOT, item.slot)], H(0)));
    await flush();
    expect(r.seen()).toEqual(["entries bot:b1 1:cmd.applied", "outcome bot:b1#1 applied", "pending", "pending"]);
    expect(r.link.pending()).toEqual([]);
    // an entry of someone else's slot is not this device's business
    r.wire.deliver(batchOf([entry(2, "cmd.applied", { slot: { ...item.slot, origin: "phone" }, result: {} }, BOT_LOG, BOT, { ...item.slot, origin: "phone" })], H(1)));
    await flush();
    expect(r.seen()).toEqual(["entries bot:b1 2:cmd.applied"]);
  });

  it("cmd.skipped of this device: the items below the floor leave with outcome skipped", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(resultOf({ origin: DEVICE, originEpoch: EPOCH, target: BOT, n: 1 }, { kind: "applied" }, SRV_LOG)); // no such slot yet: ignored
    await flush();
    expect(r.seen()).toEqual([]);
    const item = await r.link.submit(BOT, react("m1"));
    r.wire.take();
    r.seen();
    r.wire.deliver(batchOf([entry(1, "cmd.skipped", { origin: DEVICE, originEpoch: EPOCH, target: BOT, from: 1, to: 1 })], H(0)));
    await flush();
    expect(r.seen()).toEqual(["entries bot:b1 1:cmd.skipped", "outcome bot:b1#1 skipped", "pending"]);
    // the item stays as "not sent / skipped" until the UI dismisses it
    expect(r.link.pending().map((p) => [p.slot.n, p.state, p.reason])).toEqual([[1, "not sent", "skipped"]]);
    await r.link.dismiss(item.slot);
    expect(r.link.pending()).toEqual([]);
  });
});

describe("a closed connection and the reconnect (§13.3, D18)", () => {
  it("the backoff doubles from 250 ms to 5 s on dials that never welcome; the offline state comes after 10 s", async () => {
    const r = await rig();
    expect(r.wire.dials).toBe(1);
    const gaps: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = r.wire.dials;
      r.wire.drop("refused");
      let waited = 0;
      while (r.wire.dials === before && waited < 20_000) { r.clock.advance(1); waited += 1; }
      gaps.push(waited);
    }
    expect(gaps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    // 10 s without a session: connecting turns offline, once
    expect(r.events.filter((e) => e.startsWith("state"))).toEqual(["state offline"]);
    expect(r.link.state).toBe("offline");
  });

  // Local socket, opt-in `reconnectFastMs`: botlingd restarts take seconds, so the first minute of an outage retries at <= 500 ms.
  async function gapsOf(r: Awaited<ReturnType<typeof rig>>, count: number): Promise<number[]> {
    const gaps: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const before = r.wire.dials;
      r.wire.drop("refused");
      let waited = 0;
      while (r.wire.dials === before && waited < 20_000) { r.clock.advance(1); waited += 1; }
      gaps.push(waited);
    }
    return gaps;
  }

  it("reconnectFastMs on a local link: dials never wait more than 500 ms in the first minute of an outage, then back off to 5 s", async () => {
    const r = await rig({ reconnectFastMs: 500, reconnectFastWindowMs: 5_000 });
    const early = await gapsOf(r, 6);
    expect(early).toEqual([250, 500, 500, 500, 500, 500]);
    r.clock.advance(5_000); // the window (5 s here) is over; the next gaps double from 500 again
    const late = await gapsOf(r, 5);
    expect(late.slice(1)).toEqual([1000, 2000, 4000, 5000]);
  });

  it("reconnectFastMs after a welcomed session ended: a new outage starts, so the fast window starts again", async () => {
    const r = await rig({ reconnectFastMs: 500, reconnectFastWindowMs: 5_000 });
    r.wire.drop("refused"); // the first outage starts here ...
    r.clock.advance(250);
    r.clock.advance(30_000); // ... and is long over the 5 s window when the server finally answers
    await attach(r);
    expect(await gapsOf(r, 5)).toEqual([250, 500, 500, 500, 500]);
  });

  it("reconnectFastMs is for the local socket only: a remote link keeps the 250 ms doubling", async () => {
    const r = await rig({ wire: new Wire(false), token: "tok-0123456789abcdef", local: false, reconnectFastMs: 500 });
    expect(await gapsOf(r, 5)).toEqual([250, 500, 1000, 2000, 4000]);
  });

  it("a welcome resets the backoff to 250 ms; the close of a welcomed session says attached false and state connecting", async () => {
    const r = await rig();
    r.wire.drop("refused");
    r.clock.advance(250);
    r.wire.drop("refused");
    r.clock.advance(500);
    expect(r.wire.dials).toBe(3);
    await attach(r);
    r.wire.drop("net down");
    expect(r.seen()).toEqual(["attached false", "state connecting"]);
    expect(r.link.attached).toBe(false);
    expect(r.link.status.asOf).not.toBeNull();
    r.clock.advance(249);
    expect(r.wire.dials).toBe(3);
    r.clock.advance(1);
    expect(r.wire.dials).toBe(4);
  });

  it("the reconnect sends hello with the stored cursors and subs from them: no snap, straight to live; an older session's frames are ignored", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0)));
    await flush();
    const old = r.wire.last;
    r.wire.drop();
    r.clock.advance(250);
    expect(r.wire.sessions.length).toBe(2);
    r.wire.open();
    expect(r.wire.last.sent).toEqual([
      {
        t: "hello", deviceId: DEVICE, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, outbox: [], want: [BOT],
        cursors: { [BOT]: { logId: BOT_LOG, seq: 2 }, [SRV_STREAM]: { logId: SRV_LOG, seq: 0 } },
      },
    ]);
    r.seen();
    r.wire.deliver(welcome());
    expect(r.wire.take()).toEqual(["hello", `sub bot:b1 ${BOT_LOG}#2`, `sub srv:srv1 ${SRV_LOG}#0`]);
    expect(r.seen()).toEqual(["servers", "state live", "attached true"]);
    // a frame of the closed session changes nothing
    old.handlers.frame(JSON.stringify({ t: "ping", at: 1 }));
    old.handlers.close("late");
    expect(r.link.attached).toBe(true);
    expect(r.wire.dials).toBe(2);
  });

  it("no frame for 45 s ends the session with bye dead; a ping goes out after 15 s of sending nothing; any frame resets the dead timer", async () => {
    const r = await rig();
    await attach(r);
    r.clock.advance(14_999);
    expect(r.wire.take()).toEqual([]);
    r.clock.advance(1);
    expect(r.wire.take()).toEqual(["ping"]); // 15 s after the last frame sent
    r.clock.advance(15_000);
    expect(r.wire.take()).toEqual(["ping"]); // the ping itself re-arms the ping timer
    r.wire.deliver({ t: "ping", at: 1 }); // a frame heard: the dead timer starts again
    r.clock.advance(44_999);
    expect(r.wire.sessions.length).toBe(1);
    r.clock.advance(1);
    expect(r.wire.take().slice(-1)).toEqual(["bye dead"]);
    expect(r.wire.sessions[0].closedByFe).toBe(true);
    expect(r.seen().slice(-2)).toEqual(["attached false", "state connecting"]);
    r.clock.advance(250);
    expect(r.wire.dials).toBe(2);
  });

  it("a dial that throws, and a socket whose send throws, both lead to a redial with the backoff", async () => {
    const wire = new Wire();
    wire.throwOnDial = true;
    const r = await rig({ wire });
    expect(wire.dials).toBe(1);
    expect(wire.sessions.length).toBe(0);
    wire.throwOnDial = false;
    r.clock.advance(250);
    expect(wire.dials).toBe(2);
    wire.throwOnSend = true;
    wire.open(); // the hello cannot be sent: the session ends
    r.clock.advance(500);
    expect(wire.dials).toBe(3);
    wire.throwOnSend = false;
    await attach(r);
    expect(r.link.attached).toBe(true);
  });

  it("stop(): bye closing, no redial, later frames and timers do nothing; start() after stop does nothing", async () => {
    const r = await rig();
    await attach(r);
    await r.link.stop();
    expect(r.wire.take()).toEqual(["bye closing"]);
    expect(r.wire.last.closedByFe).toBe(true);
    expect(r.seen()).toEqual(["attached false", "state connecting"]);
    r.clock.advance(600_000);
    expect(r.wire.dials).toBe(1);
    r.link.start();
    expect(r.wire.dials).toBe(1);
    r.link.replaceSocket();
    expect(r.wire.dials).toBe(1);
  });

  it("start() twice dials once; replaceSocket before start does nothing", async () => {
    const r = await rig({ start: false });
    r.link.replaceSocket();
    expect(r.wire.dials).toBe(0);
    r.link.start();
    r.link.start();
    expect(r.wire.dials).toBe(1);
  });

  it("replaceSocket: bye closing on the old session, a new dial at once (with the new dial), the backoff back to 250 ms", async () => {
    const r = await rig();
    await attach(r);
    const second = new Wire();
    const oldSession = r.wire.last;
    r.link.replaceSocket(second.dial);
    expect(oldSession.sent.map(brief).slice(-1)).toEqual(["bye closing"]);
    expect(oldSession.closedByFe).toBe(true);
    expect(second.dials).toBe(1); // dialed at once, with the new dial
    expect(r.wire.dials).toBe(1);
    expect(r.seen()).toEqual(["attached false", "state connecting"]);
    second.open();
    second.deliver(welcome());
    expect(second.take()).toEqual(["hello", `sub bot:b1 ${BOT_LOG}#0`, `sub srv:srv1 ${SRV_LOG}#0`]);
  });

  it("the offline timer stops once attached and restarts when the session ends", async () => {
    const r = await rig();
    r.clock.advance(9_999);
    expect(r.link.state).toBe("connecting");
    r.wire.open();
    r.wire.deliver(welcome());
    r.clock.advance(14_000); // past the offline delay, short of the 15 s ping and the 45 s dead timer
    expect(r.events.filter((e) => e === "state offline")).toEqual([]);
    r.wire.drop();
    r.clock.advance(9_999);
    expect(r.link.state).toBe("connecting");
    r.clock.advance(1);
    expect(r.link.state).toBe("offline");
  });

  it("a listener that throws does not stop the other listeners; the unsubscribe function removes one", async () => {
    const r = await rig();
    const heard: string[] = [];
    r.link.on(() => { throw new Error("listener bug"); });
    const off = r.link.on((event) => heard.push(event.type));
    r.wire.open();
    r.wire.deliver(welcome());
    expect(heard).toEqual(["servers", "state", "attached"]);
    off();
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    expect(heard).toEqual(["servers", "state", "attached"]);
  });
});

describe("a stale live stream (§9.4)", () => {
  it("live frames apply in order; a rev that does not follow asks live.resync and is dropped; the next whole segment applies", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(live(1, 0, "Hel"));
    r.wire.deliver(live(2, 3, "lo"));
    expect(r.seen()).toEqual(['live bot:b1 "Hel" stale=false', 'live bot:b1 "Hello" stale=false']);
    expect(r.link.live(BOT)).toEqual({ view: { turnId: "t1", seg: 0, rev: 2, text: "Hello" }, stale: false });
    r.wire.deliver(live(5, 5, "!"));
    expect(r.wire.take()).toEqual(["live.resync bot:b1"]);
    expect(r.seen()).toEqual([]);
    r.wire.deliver(live(6, 5, "?")); // already asked: dropped without a second resync
    expect(r.wire.take()).toEqual([]);
    expect(r.seen()).toEqual([]);
    r.wire.deliver(live(7, 0, "Fresh", "t1", 1)); // a whole segment (at 0) repairs the view
    expect(r.seen()).toEqual(['live bot:b1 "Fresh" stale=false']);
  });

  it("a live frame of a stream nobody follows is ignored", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver({ t: "live", stream: "bot:other" as StreamId, turnId: "t1", seg: 0, rev: 1, at: 0, text: "x" });
    expect(r.seen()).toEqual([]);
    expect(r.link.live("bot:other" as StreamId)).toBeNull();
  });

  it("the session ends: the text is marked stale once (an event with the text kept); a live frame after the reattach clears the mark", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(live(1, 0, "Hel"));
    r.wire.deliver(live(2, 3, "lo"));
    r.seen();
    r.wire.drop();
    expect(r.seen()).toEqual(["attached false", 'live bot:b1 "Hello" stale=true', "state connecting"]);
    expect(r.link.live(BOT)).toEqual({ view: { turnId: "t1", seg: 0, rev: 2, text: "Hello" }, stale: true });
    // a second end (a dial that never welcomed) does not mark it again
    r.clock.advance(250);
    r.wire.drop("refused");
    expect(r.seen()).toEqual([]);
    r.clock.advance(500);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.seen();
    expect(r.link.live(BOT)?.stale).toBe(true);
    r.wire.deliver(live(3, 5, "!"));
    expect(r.seen()).toEqual(['live bot:b1 "Hello!" stale=false']);
    expect(r.link.live(BOT)).toEqual({ view: { turnId: "t1", seg: 0, rev: 3, text: "Hello!" }, stale: false });
  });

  it("the stale text goes when the stream's snap, a turn end entry, a reset or unsubscribe replaces it: one live null event", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(live(1, 0, "Hel"));
    r.seen();
    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0)));
    expect(r.seen()).toEqual(["entries bot:b1 1:turn.started,2:turn.finished", "live bot:b1 null stale=false"]);
    expect(r.link.live(BOT)).toBeNull();

    r.wire.deliver(live(1, 0, "Again", "t3"));
    r.seen();
    r.wire.deliver(snapOf(BOT, BOT_LOG, 5));
    expect(r.seen()).toEqual(["snap bot:b1 botlog-0001#5", "live bot:b1 null stale=false"]);

    r.wire.deliver(live(1, 0, "Third", "t4"));
    r.seen();
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0002", retired: [{ logId: BOT_LOG, keptSeq: 3 }], reason: "restored" });
    expect(r.seen()).toEqual(["live bot:b1 null stale=false", "state history restored", "reset bot:b1 botlog-0002"]);

    r.wire.deliver(snapOf(BOT, "botlog-0002", 0));
    r.wire.deliver(live(1, 0, "Fourth", "t5"));
    r.wire.take();
    r.seen();
    r.link.unsubscribe(BOT);
    expect(r.wire.take()).toEqual(["unsub bot:b1"]);
    expect(r.link.live(BOT)).toBeNull();
    r.link.unsubscribe(BOT); // nothing more to say
    expect(r.wire.take()).toEqual([]);
  });
});

describe("reset and snap (§8.3, D50)", () => {
  it("a reset naming the cursor's logId as retired moves the reader: state history restored, the new snap is taken, batches of the old logId are dropped", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1), turnFinished(2)], H(0)));
    r.wire.take();
    r.seen();
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0002", retired: [{ logId: BOT_LOG, keptSeq: 1 }], reason: "restored", restoredTo: 777 });
    expect(r.seen()).toEqual(["state history restored", "reset bot:b1 botlog-0002"]);
    expect(r.link.retired(BOT)).toEqual([{ logId: BOT_LOG, keptSeq: 1 }]);
    expect(r.link.status).toMatchObject({ state: "history restored", restoredTo: 777 });
    r.wire.deliver(batchOf([turnStarted(3)], H(2))); // the old logId: dropped
    expect(r.seen()).toEqual([]);
    r.wire.deliver(snapOf(BOT, "botlog-0002", 0));
    expect(r.seen()).toEqual(["snap bot:b1 botlog-0002#0"]);
    expect(r.link.state).toBe("history restored"); // the notice stays until the UI dismisses it
    r.link.dismissRestored();
    expect(r.seen()).toEqual(["state live"]);
    // a reset of an unknown lineage (neither the cursor's logId retired nor a no-cursor reader) is dropped
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0009", retired: [{ logId: "botlog-0007", keptSeq: 1 }], reason: "restored" });
    expect(r.seen()).toEqual([]);
  });

  it("a reset of a bot another server owns (a peer's restore) does not show 'history restored' for this machine", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({ servers: [{ id: SRV, name: "A", state: "live", since: 1 }, { id: "srvB", name: "B", state: "live", since: 1 }] }));
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    r.wire.deliverWire({
      t: "rows", stream: "srv:srvB", logId: "incb-0001", after: 0, to: 1, more: false,
      rows: [{ key: "bot:b1", rev: 1, body: summaryRow() }],
    });
    r.wire.take();
    r.seen();
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0002", retired: [{ logId: BOT_LOG, keptSeq: 0 }], reason: "restored" });
    expect(r.seen()).toEqual(["reset bot:b1 botlog-0002", "state catching up"]); // no "history restored": only the snap is due
    expect(r.link.state).toBe("catching up");
  });

  it("dropCache forgets the cursor, persists that, and subs again from a snap when attached", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver(batchOf([turnStarted(1)], H(0)));
    await flush();
    r.wire.take();
    await r.link.dropCache(BOT);
    expect(r.link.cursor(BOT)).toBeNull();
    expect(r.wire.take()).toEqual(["sub bot:b1 -"]);
    expect(r.storage.snapshot().cursors[BOT]).toBeUndefined();
  });

  it("subscribe while attached subs from the cursor at once; a second subscribe to the same stream sends nothing", async () => {
    const r = await rig();
    await attach(r);
    const second = "bot:b2" as StreamId;
    r.link.subscribe(second);
    r.link.subscribe(second);
    expect(r.wire.take()).toEqual(["sub bot:b2 -"]);
    expect(r.seen()).toEqual(["state catching up"]); // its snap is due
  });
});

describe("a server switch (§13.1, D72)", () => {
  it("a stale mark comes with `stale`, goes with a frame from the owner, and goes with a welcome from another server", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver({ t: "stale", stream: BOT, since: 42 });
    expect(r.seen()).toEqual(["servers", "message stale"]);
    expect(r.link.staleSince(BOT)).toBe(42);
    r.wire.deliver(batchOf([turnStarted(1)], H(0))); // a frame from the owner: no longer stale
    expect(r.seen()).toEqual(["servers", "entries bot:b1 1:turn.started"]);
    expect(r.link.staleSince(BOT)).toBeNull();

    r.wire.deliver({ t: "stale", stream: BOT, since: 43 });
    r.seen();
    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    expect(r.link.staleSince(BOT)).toBe(43); // the same server: the mark stays until it is heard from
    r.wire.deliver(welcome({ serverId: "srv2" }));
    expect(r.link.staleSince(BOT)).toBeNull(); // another server: the marks of the first are gone
  });

  it("a live frame or a snap from the owner clears the stale mark too (not only a batch)", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliver({ t: "stale", stream: BOT, since: 7 });
    r.seen();
    r.wire.deliver(live(1, 0, "Hi"));
    expect(r.seen()).toEqual(["servers", 'live bot:b1 "Hi" stale=false']);
    expect(r.link.staleSince(BOT)).toBeNull();
    r.wire.deliver({ t: "stale", stream: BOT, since: 8 });
    r.seen();
    r.wire.deliver(live(9, 5, "x")); // a frame the receiver drops (resync) is no proof of life
    expect(r.link.staleSince(BOT)).toBe(8);
    r.wire.deliver(snapOf(BOT, BOT_LOG, 1));
    expect(r.link.staleSince(BOT)).toBeNull();
    expect(r.seen()[0]).toBe("servers");
  });

  it("the switch: hello still names the old owner's stream; the welcome of srv2 follows srv:srv2 from a snap; the views are replaced; the old srv: stream is no longer followed", async () => {
    const r = await rig();
    await attach(r, { servers: [{ id: SRV, name: "Studio", state: "live", since: 1 }] });
    r.wire.deliver(batchOf([turnStarted(1)], H(0)));
    await flush();
    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    expect(r.wire.last.sent[0]).toMatchObject({
      t: "hello", want: [BOT],
      cursors: { [BOT]: { logId: BOT_LOG, seq: 1 }, [SRV_STREAM]: { logId: SRV_LOG, seq: 0 } },
    });
    r.wire.take();
    r.seen();
    r.wire.deliver(welcome({ serverId: "srv2", servers: [{ id: "srv2", name: "Laptop", state: "live", since: 9 }, { id: SRV, name: "Studio", state: "live", since: 1 }] }));
    expect(r.wire.take()).toEqual([`sub bot:b1 ${BOT_LOG}#1`, "sub srv:srv2 -", `sub srv:srv1 -`]);
    expect(r.link.server).toBe("srv2");
    expect(r.link.servers()).toEqual([
      { id: "srv2", name: "Laptop", state: "live", since: 9, self: true },
      { id: SRV, name: "Studio", state: "live", since: 1, self: false },
    ]);
    expect(r.link.ownerOf(BOT)).toBe("srv2");
    expect(r.link.ownerOf(SRV_STREAM)).toBe(SRV);
    expect(r.seen()).toEqual(["servers", "state catching up", "attached true"]);
    // the new owner's snap makes the link live; a frame of the old owner's own stream is a peer table now, not a log
    r.wire.deliver(snapOf("srv:srv2" as StreamId, "incsrv-0002"));
    expect(r.wire.take()).toEqual(["ack srv:srv2 incsrv-0002#0"]);
  });

  it("an item waiting across the switch is sent under the new owner's inc, once per session", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    expect(r.wire.take()).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    r.wire.deliver(welcome({ serverId: "srv2" }));
    r.wire.take();
    expect(r.wire.last.sent.some((f) => f.t === "cmd")).toBe(false); // the inc of srv2 is unknown until its snap
    r.wire.deliver(snapOf("srv:srv2" as StreamId, "incsrv-0002"));
    expect(r.wire.take()).toEqual(["ack srv:srv2 incsrv-0002#0", "cmd bot:b1#1 inc=incsrv-0002 floor=1"]);
    expect(item.slot.n).toBe(1);
    r.wire.deliver(snapOf("srv:srv2" as StreamId, "incsrv-0002", 1)); // a second snap does not send it again
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([]);
  });

  it("a peer frame adds the peer's table, follows it, and tells the listeners; the peer of this server itself is ignored", async () => {
    const r = await rig();
    await attach(r, { servers: [{ id: SRV, name: "Studio", state: "live", since: 1 }] });
    r.wire.deliver({ t: "peer", serverId: SRV, state: "stale", since: 5 });
    expect(r.seen()).toEqual(["message peer"]); // about this server itself: no view change, the message still reaches the listeners
    expect(r.link.servers()[0]).toMatchObject({ id: SRV, state: "live", since: 1 });
    r.wire.deliver({ t: "peer", serverId: "srvB", state: "live", since: 6 });
    expect(r.wire.take()).toEqual(["sub srv:srvB -"]);
    expect(r.seen()).toEqual(["state catching up", "servers", "pending", "message peer"]);
    expect(r.link.servers().map((s) => [s.id, s.name, s.state, s.self])).toEqual([[SRV, "Studio", "live", true], ["srvB", "srvB", "live", false]]);
    r.wire.deliver({ t: "peer", serverId: "srvB", state: "stale", since: 7 });
    expect(r.wire.take()).toEqual([]); // already followed
    expect(r.link.servers().find((s) => s.id === "srvB")).toMatchObject({ state: "stale", since: 7 });
  });

  it("a bot in a peer's table is owned by that peer: its command waits for the table's catch-up and carries the peer's logId as inc", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({ servers: [{ id: SRV, name: "A", state: "live", since: 1 }, { id: "srvB", name: "B", state: "live", since: 1 }] }));
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    r.wire.take();
    r.seen();
    const far = "bot:far1" as StreamId;
    const item = await r.link.submit(far, { ...react("m1"), botId: "far1" } as never);
    expect(r.wire.take()).toEqual([]); // srv:srvB has not had its catch-up
    r.wire.deliverWire({ t: "rows", stream: "srv:srvB", logId: "incb-0001", after: 0, to: 2, more: false, rows: [{ key: "bot:far1", rev: 2, body: summaryRow() }] });
    expect(r.wire.take()).toEqual([`cmd bot:far1#1 inc=incb-0001 floor=1`]);
    expect(r.seen()).toContain("servers srv:srvB +[bot:far1] -[]");
    expect(r.link.ownerOf(far)).toBe("srvB");
    expect(r.link.table("srvB")).toMatchObject({ logId: "incb-0001", rev: 2, caught: true });
    expect(r.link.pending(far)[0]).toMatchObject({ owner: "srvB", ownerName: "B", state: "waiting" });
    expect(item.slot.target).toBe(far);
  });

  it("a peer table that has no copy stops holding the outbox after absentTableMs", async () => {
    const r = await rig({ absentTableMs: 1_000 });
    r.wire.open();
    r.wire.deliver(welcome({ servers: [{ id: SRV, name: "A", state: "live", since: 1 }, { id: "srvB", name: "B", state: "live", since: 1 }] }));
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    await r.link.submit(BOT, react("m1"));
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([]);
    r.clock.advance(1_000);
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([]);
    r.clock.advance(2);
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([`cmd bot:b1#1 inc=${SRV_LOG} floor=1`]);
  });

  it("the attached server's own rows come after the log sub: a servers event, never a peer table", async () => {
    const r = await rig();
    await attach(r);
    r.wire.deliverWire({ t: "rows", stream: SRV_STREAM, logId: SRV_LOG, after: 0, to: 1, more: false, rows: [{ key: "plugin:notes", rev: 1, body: pluginRow("notes") }] });
    expect(r.seen()).toEqual(["servers srv:srv1 +[plugin:notes] -[]"]);
    expect(r.link.table(SRV)).toMatchObject({ logId: SRV_LOG, rev: 1 });
  });

  it("a table's reset (a peer's restore): the listeners hear servers and reset, the old logId is retired", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome({ servers: [{ id: SRV, name: "A", state: "live", since: 1 }, { id: "srvB", name: "B", state: "live", since: 1 }] }));
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    r.wire.deliverWire({ t: "rows", stream: "srv:srvB", logId: "incb-0001", after: 0, to: 1, more: false, rows: [{ key: "bot:far1", rev: 1, body: summaryRow() }] });
    r.wire.take();
    r.seen();
    r.wire.deliver({ t: "reset", stream: "srv:srvB" as StreamId, logId: "incb-0002", retired: [{ logId: "incb-0001", keptSeq: 1 }], reason: "restored" });
    expect(r.seen()).toEqual(["servers srv:srvB +[] -[bot:far1]", "reset srv:srvB incb-0002", "state catching up"]);
    await flush();
    expect(r.storage.snapshot().retired["srv:srvB"]).toEqual([{ logId: "incb-0001", keptSeq: 1 }]);
  });
});

describe("commands and the via of N1 (§11, D49, D53)", () => {
  it("a command waits for the owner's srv: snap (its inc), then goes out: the frame is exact, with no via key when there is none", async () => {
    const r = await rig();
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.take();
    const item = await r.link.submit(BOT, react("m1"));
    expect(item.slot).toEqual({ origin: DEVICE, originEpoch: EPOCH, target: BOT, n: 1 });
    expect(r.wire.take()).toEqual([]);
    expect(r.seen().slice(-1)).toEqual(["pending"]);
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    const frames = r.wire.takeRaw();
    expect(frames).toEqual([
      { t: "ack", stream: SRV_STREAM, cursor: { logId: SRV_LOG, seq: 0 } },
      { t: "cmd", slot: { origin: DEVICE, originEpoch: EPOCH, target: BOT, n: 1 }, floor: 1, inc: SRV_LOG, cmd: react("m1") },
    ]);
    expect("via" in frames[1]).toBe(false);
    expect("basis" in frames[1]).toBe(false);
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.state, p.owner])).toEqual([[1, "waiting", SRV]]);
  });

  it("N1: via and basis are stored with the item and sent unchanged on every re-send (reconnect and a restart of the link)", async () => {
    const r = await rig();
    await attach(r);
    const basis = { logId: BOT_LOG, seq: 3 };
    await r.link.submit(BOT, react("m1"), basis, VIA);
    await r.link.submit(BOT, react("m2"));
    const first = r.wire.takeRaw();
    expect(first.map(brief)).toEqual([
      `cmd bot:b1#1 inc=${SRV_LOG} floor=1 via=notes-helper basis=${BOT_LOG}#3`,
      `cmd bot:b1#2 inc=${SRV_LOG} floor=1`,
    ]);
    expect(first[0]).toEqual({ t: "cmd", slot: { origin: DEVICE, originEpoch: EPOCH, target: BOT, n: 1 }, floor: 1, inc: SRV_LOG, cmd: react("m1"), basis, via: VIA });
    expect("via" in first[1]).toBe(false);

    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    const again = r.wire.takeRaw().filter((f) => f.t === "cmd");
    expect(again).toEqual(first); // the same two frames, the same order

    // a new link on the same storage (a restart) sends the same frames again
    await r.link.stop();
    const restarted = await rig({ storage: r.storage });
    restarted.wire.open();
    restarted.wire.deliver(welcome());
    restarted.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    expect(restarted.wire.takeRaw().filter((f) => f.t === "cmd")).toEqual(first);
    expect(restarted.link.pending().map((p) => [p.slot.n, p.state])).toEqual([[1, "waiting"], [2, "waiting"]]);
  });

  it("each unresolved item goes once per session, and in slot order; the floor is the smallest n still held", async () => {
    const r = await rig();
    await attach(r);
    const a = await r.link.submit(BOT, react("m1"));
    await r.link.submit(BOT, react("m2"));
    await r.link.submit(BOT, react("m3"));
    expect(r.wire.take()).toEqual([
      `cmd bot:b1#1 inc=${SRV_LOG} floor=1`, `cmd bot:b1#2 inc=${SRV_LOG} floor=1`, `cmd bot:b1#3 inc=${SRV_LOG} floor=1`,
    ]);
    r.wire.deliver(resultOf(a.slot, { kind: "applied", result: { n: 1 } }));
    await flush();
    r.wire.drop();
    r.clock.advance(250);
    r.wire.open();
    r.wire.deliver(welcome());
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG));
    r.wire.deliver(snapOf(BOT, BOT_LOG));
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([`cmd bot:b1#2 inc=${SRV_LOG} floor=2`, `cmd bot:b1#3 inc=${SRV_LOG} floor=2`]);
    r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG, 1));
    r.wire.deliver(snapOf(BOT, BOT_LOG, 1));
    expect(r.wire.take().filter((l) => l.startsWith("cmd"))).toEqual([]);
  });

  it("cmd.result: one outcome call and the item leaves the pending list when it is delivered and the cursor covers it; a repeat is ignored", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    r.wire.take();
    r.seen();
    r.wire.deliver(resultOf(item.slot, { kind: "applied", result: { n: 1 } }));
    await flush();
    expect(r.seen()).toEqual(["outcome bot:b1#1 applied", "pending"]);
    expect(r.link.pending(BOT).map((p) => [p.state])).toEqual([["delivered"]]); // until a batch covers its entry
    r.wire.deliver(resultOf(item.slot, { kind: "applied", result: { n: 1 } }));
    await flush();
    expect(r.seen()).toEqual([]);
    r.wire.deliver(batchOf([entry(1, "cmd.applied", { slot: item.slot, result: { n: 1 } }, BOT_LOG, BOT, item.slot)], H(0)));
    await flush();
    expect(r.link.pending(BOT)).toEqual([]);
  });

  it("a refused outcome: state not sent with reason and the words of the reason", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    r.wire.deliver(resultOf(item.slot, { kind: "refused", reason: "grant" }, BOT_LOG, 1));
    await flush();
    const [view] = r.link.pending(BOT);
    expect(view).toMatchObject({ state: "not sent", reason: "grant" });
    expect(typeof view.reasonText).toBe("string");
    expect(r.seen()).toContain("outcome bot:b1#1 refused");
    await r.link.dismiss(item.slot);
    expect(r.link.pending(BOT)).toEqual([]);
  });

  it("the outcome of a retired logId is never taken", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0002", retired: [{ logId: BOT_LOG, keptSeq: 0 }], reason: "restored" });
    r.seen();
    r.wire.deliver(resultOf(item.slot, { kind: "applied", result: {} }, BOT_LOG, 5));
    await flush();
    expect(r.seen()).toEqual([]);
    expect(r.link.pending(BOT)[0].state).toBe("waiting");
  });

  it("held: the item shows held at the server named; the word of the server comes from the views", async () => {
    const r = await rig();
    await attach(r, { servers: [{ id: SRV, name: "Studio", state: "live", since: 1 }] });
    const item = await r.link.submit(BOT, react("m1"));
    r.seen();
    r.wire.deliver({ t: "held", slot: item.slot, at: SRV });
    await flush();
    expect(r.seen()).toEqual(["pending"]);
    expect(r.link.pending(BOT)[0]).toMatchObject({ state: "held", heldAt: SRV });
    expect(r.link.pending(BOT)[0].heldAtName).toBe("Studio");
    r.wire.deliver({ t: "held", slot: { ...item.slot, n: 99 }, at: SRV }); // unknown slot: nothing
    await flush();
    expect(r.seen()).toEqual([]);
  });

  it("cmd.retry: an item told to wait for another inc is not sent until the reset of the owner; cancel goes out after the cmd and is answered", async () => {
    const r = await rig();
    await attach(r);
    const item = await r.link.submit(BOT, react("m1"));
    r.wire.take();
    r.wire.deliver({ t: "cmd.retry", slot: item.slot, inc: "incsrv-0002" });
    await flush();
    expect(r.wire.take()).toEqual([]); // the owner's reset has not come
    r.wire.deliver({ t: "reset", stream: SRV_STREAM, logId: "incsrv-0002", retired: [{ logId: SRV_LOG, keptSeq: 0 }], reason: "restored" });
    expect(r.wire.take()).toEqual([`cmd bot:b1#1 inc=incsrv-0002 floor=1`]);
    r.wire.deliver({ t: "cmd.retry", slot: { ...item.slot, n: 42 }, inc: "incsrv-0003" }); // an unknown slot is ignored
    await flush();
    expect(r.wire.take()).toEqual([]);

    await r.link.cancel(item.slot);
    expect(r.wire.take()).toEqual(["cancel bot:b1#1"]);
    r.wire.deliver({ t: "cancel.noted", slot: item.slot });
    expect(r.link.pending(BOT)[0]).toMatchObject({ cancelNoted: true, state: "waiting" });
    r.wire.deliver(resultOf(item.slot, { kind: "cancelled" }, "incsrv-0002", 1));
    await flush();
    expect(r.seen()).toContain("outcome bot:b1#1 cancelled");
    expect(r.link.pending(BOT)[0]).toMatchObject({ state: "not sent", reason: "cancelled" });
    expect(r.link.pending(BOT)[0].cancelNoted).toBeUndefined();
  });

  it("the 'sending' marker shows after sendingMarkerMs without held or an outcome", async () => {
    const r = await rig({ sendingMarkerMs: 150 });
    await attach(r);
    r.wire.drop();
    const item = await r.link.submit(BOT, react("m1"));
    r.seen();
    expect(r.link.pending(BOT)[0].sending).toBe(false);
    r.clock.advance(150);
    expect(r.link.pending(BOT)[0].sending).toBe(true);
    expect(r.seen().slice(-1)).toEqual(["pending"]); // the marker timer asked the UI to look again
    expect(item.slot.n).toBe(1);
  });

  it("D67: five sessions in a row ending bye{unsettled} on a slot stop it; giveUp skips it and the queue moves on", async () => {
    const r = await rig();
    await attach(r);
    const a = await r.link.submit(BOT, react("m1"));
    const b = await r.link.submit(BOT, react("m2"));
    r.wire.take();
    r.seen();
    for (let i = 0; i < 5; i += 1) {
      r.wire.deliver({ t: "bye", reason: "unsettled", slot: a.slot });
      // the fifth bye on the slot stops it: the UI is asked to look (pending) before the bye reaches the listeners
      expect(r.seen()).toEqual([...(i === 4 ? ["pending"] : []), "bye unsettled", "attached false", "state connecting"]);
      expect(r.link.pending(BOT)[0].stopped).toBe(i === 4 ? true : undefined);
      r.clock.advance(5_000);
      r.wire.open();
      r.wire.deliver(welcome());
      r.wire.deliver(snapOf(SRV_STREAM, SRV_LOG, i));
      r.wire.deliver(snapOf(BOT, BOT_LOG, i));
      r.wire.take();
      r.seen();
    }
    const sentAfter = r.wire.sessions.slice(-1)[0].sent.filter((f) => f.t === "cmd");
    expect(sentAfter).toEqual([]); // the stopped slot and the one behind it are not sent
    expect(r.link.pending(BOT).map((p) => [p.slot.n, p.stopped === true])).toEqual([[1, true], [2, false]]);
    await r.link.giveUp(a.slot);
    expect(r.seen()).toEqual(["outcome bot:b1#1 skipped", "pending"]);
    expect(r.wire.take()).toEqual([`cmd bot:b1#2 inc=${SRV_LOG} floor=2`]);
    expect(b.slot.n).toBe(2);
  });
});

describe("requests and the content path (§9A, §11.1)", () => {
  it("request: req r1 goes out, res ok resolves with the result, res not ok rejects with the wire error; ids count on", async () => {
    const r = await rig();
    await attach(r);
    const ok = r.link.request({ type: "plugins.web" } as never);
    expect(r.wire.take()).toEqual(["req r1 plugins.web"]);
    r.wire.deliver({ t: "res", req: "r1", ok: true, result: { plugins: [] } });
    await expect(ok).resolves.toEqual({ plugins: [] });
    const bad = r.link.request({ type: "plugins.web" } as never);
    expect(r.wire.take()).toEqual(["req r2 plugins.web"]);
    r.wire.deliver({ t: "res", req: "r2", ok: false, error: { code: "internal", message: "boom" } });
    await expect(bad).rejects.toMatchObject({ message: "boom", wire: { code: "internal", message: "boom" } });
    expect(r.link.newReq()).toBe("r3");
    r.wire.deliver({ t: "res", req: "r9", ok: true, result: 1 }); // an answer nobody waits for
  });

  it("request while not attached rejects at once; one in flight when the session ends rejects; so does a content reader (null)", async () => {
    const r = await rig();
    await expect(r.link.request({ type: "plugins.web" } as never)).rejects.toThrow("fe-link: not attached");
    await attach(r);
    const flight = r.link.request({ type: "plugins.web" } as never);
    const heard: Array<ContentReadMessage | null> = [];
    r.link.onContent("rc1", (m) => heard.push(m));
    r.wire.drop();
    await expect(flight).rejects.toThrow("fe-link: the session ended");
    expect(heard).toEqual([null]);
  });

  it("history: the frame, the page resolves; a page of a retired logId is refused", async () => {
    const r = await rig();
    await attach(r);
    const page = r.link.history(BOT, "m5", 4096);
    expect(r.wire.takeRaw()).toEqual([{ t: "history", req: "r1", stream: BOT, before: "m5", bytes: 4096 }]);
    r.wire.deliver({ t: "history.page", req: "r1", stream: BOT, logId: BOT_LOG, messages: [], hasMore: false, older: 0 });
    await expect(page).resolves.toMatchObject({ t: "history.page", hasMore: false });
    const second = r.link.history(BOT, "m5");
    expect(r.wire.takeRaw()).toEqual([{ t: "history", req: "r2", stream: BOT, before: "m5" }]);
    r.wire.deliver({ t: "reset", stream: BOT, logId: "botlog-0002", retired: [{ logId: BOT_LOG, keptSeq: 0 }], reason: "restored" });
    r.wire.deliver({ t: "history.page", req: "r2", stream: BOT, logId: BOT_LOG, messages: [], hasMore: false, older: 0 });
    await expect(second).rejects.toThrow("a page of a retired logId");
  });

  it("an answer of the wrong kind for its request is dropped and the request stays open", async () => {
    const r = await rig();
    await attach(r);
    const page = r.link.history(BOT, "m5");
    r.wire.take();
    r.wire.deliver({ t: "res", req: "r1", ok: true, result: 1 });
    let settled = false;
    void page.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    r.wire.deliver({ t: "history.page", req: "r1", stream: BOT, logId: BOT_LOG, messages: [], hasMore: false, older: 0 });
    await expect(page).resolves.toMatchObject({ t: "history.page" });
  });

  it("content(): the content.find frame gets its req; content.found resolves it; content.gone resolves a content request too", async () => {
    const r = await rig();
    await attach(r);
    const found = r.link.content({ t: "content.find", botId: "b1", line: "l1", url: "file:///a.png" });
    expect(r.wire.takeRaw()).toEqual([{ t: "content.find", req: "r1", botId: "b1", line: "l1", url: "file:///a.png" }]);
    r.wire.deliver({ t: "content.found", req: "r1", ref: null });
    await expect(found).resolves.toEqual({ t: "content.found", req: "r1", ref: null });
    const gone = r.link.content({ t: "content.find", botId: "b1", line: "l1", url: "file:///b.png" });
    r.wire.take();
    r.wire.deliver({ t: "content.gone", req: "r2", id: "pending:" + "1".repeat(32), reason: "deleted" } as never);
    await expect(gone).resolves.toMatchObject({ t: "content.gone", reason: "deleted" });
  });

  it("content frames go to an upload listener, a read listener, or the listeners of the link, by req", async () => {
    const r = await rig();
    await attach(r);
    const uploads: string[] = [];
    const reads: Array<string | null> = [];
    const offUpload = r.link.onUpload("up1", (m) => uploads.push(m.t));
    r.link.onContent("rd1", (m) => reads.push(m ? m.t : null));
    const stored = { t: "content.stored", req: "up1", id: "sha256:" + "a".repeat(64), have: 4 };
    r.wire.deliver(stored as never);
    r.wire.deliver({ t: "content.credit", req: "up1", bytes: 100 });
    r.wire.deliver({ t: "content.gone", req: "up1", id: "pending:" + "2".repeat(32), reason: "denied" } as never);
    expect(uploads).toEqual(["content.stored", "content.credit", "content.gone"]);
    r.wire.deliver({ t: "content.gone", req: "rd1", id: "pending:" + "2".repeat(32), reason: "offline" } as never);
    expect(reads).toEqual(["content.gone"]);
    // a content.meta with no reader waiting is a plain message event
    r.seen();
    r.wire.deliver({ t: "content.meta", req: "nobody", id: "sha256:" + "b".repeat(64), size: 1, type: "text/plain", chunkSize: 1024 * 1024, variants: [] } as never);
    expect(r.seen()).toEqual(["message content.meta"]);
    offUpload();
    r.wire.deliver(stored as never);
    expect(uploads.length).toBe(3);
  });

  it("postUpload / postContent / post: false without a session; text frames go out; a chunk needs the bulk lane", async () => {
    const r = await rig();
    expect(r.link.postContent({ t: "content.cancel", req: "x1" })).toBe(false);
    expect(r.link.post({ t: "shell.done", req: "s1", ok: true })).toBe(false);
    expect(r.link.postUpload({ t: "content.put", req: "u1", id: "sha256:" + "a".repeat(64), size: 3, type: "text/plain", name: "a.txt" } as never)).toBe(false);
    await attach(r);
    expect(r.link.postContent({ t: "content.cancel", req: "x1" })).toBe(true);
    expect(r.link.post({ t: "shell.done", req: "s1", ok: true })).toBe(true);
    expect(r.link.postUpload({ t: "content.put", req: "u1", id: "sha256:" + "a".repeat(64), size: 3, type: "text/plain", name: "a.txt" } as never)).toBe(true);
    expect(r.wire.take()).toEqual(["content.cancel x1", "shell.done s1", "content.put u1"]);
    expect(r.link.postUpload({ t: "content.chunk", req: "u1", offset: 0, bytes: new Uint8Array([1, 2, 3]) })).toBe(true);
    expect(r.wire.last.bytes.length).toBe(1);
    expect(r.wire.last.bytes[0]).toBeInstanceOf(Uint8Array);
    // a transport with no binary frame
    const wire = new Wire();
    wire.withBytes = false;
    const plain = await rig({ wire });
    await attach(plain);
    expect(plain.link.postUpload({ t: "content.chunk", req: "u1", offset: 0, bytes: new Uint8Array([1]) })).toBe(false);
  });

  it("sendPushSubscribe: false on a local session, false when unattached; a valid subscription goes out live on a remote one", async () => {
    const key = Buffer.from([4, ...new Array(64).fill(7)]).toString("base64url");
    const auth = Buffer.alloc(16, 9).toString("base64url");
    const sub = { endpoint: "https://push.example.com/send/abc", keys: { p256dh: key, auth } };
    const local = await rig();
    await attach(local);
    expect(local.link.sendPushSubscribe(sub)).toBe(false);

    const remote = await rig({ wire: new Wire(false), local: false });
    expect(remote.link.sendPushSubscribe(sub)).toBe(false); // not attached
    await attach(remote);
    expect(remote.link.sendPushSubscribe({ ...sub, endpoint: "http://insecure.example.com/x" })).toBe(false);
    expect(remote.link.sendPushSubscribe(sub)).toBe(true);
    expect(remote.wire.takeRaw()).toEqual([{ t: "push.subscribe", endpoint: sub.endpoint, keys: sub.keys }]);
  });
});

// ---------------------------------------------------------------------------------------------

const EMPTY_MANIFEST = { reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
function pluginRow(name: string): unknown {
  return PluginRow.parse({ codeHash: `sha256:${name}`, manifest: { tier: "read", ...EMPTY_MANIFEST }, author: "user", grants: {} });
}

function summaryRow() {
  return {
    name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
    waiting: [], unread: 0, lastAt: null, lines: ["hello"],
  };
}
