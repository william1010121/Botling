// Botling 3 M7-12a (Q-M7-C8 a): the owner accepts a desktop-window command a peer forwarded.
//
// Window → A → B in one process: A runs the real Forwarder on its own server.db, B the real OwnerInbox in front of the
// real SlotEngine with the real `slotAuthorize` (roster: A is a valid server, one phone is a device). The window's
// `cmd` reaches A stated `local`, and A stamps the forwarded copy `manage`:
//
// - `chat.send` and `chat.choose` (a card answer, which a server origin may never send) for B's bot apply on B once
//   (a re-sent copy gets the stored outcome, the handler does not run again);
// - an `admin` or `machine` command is refused at A ("needs the desktop window on that machine"): the window gets
//   `refused scope`, the row moves into `forwarddead`, B never sees it, and the next command of the queue still applies;
// - a phone with `read` is forwarded as stated and B refuses `chat.send` for its scope; `peerScope` stays as it was;
// - B decides `manage` under the window's origin only (any other scope, a stated `manage` that is not the window's
//   origin, a roster device called "desktop": refused).
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, Message, MessageOf, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, OwnerInbox, type ForwardSession, type InboxSession } from "../../src/server/forward";
import { peerScope } from "../../src/server/forward/owner-inbox";
import { WINDOW_ORIGIN, windowForward, windowOwnerCheck } from "../../src/server/forward/window-scope";
import { slotAuthorize, type DeviceRoster } from "../../src/server/session";
import { SlotEngine, type ApplyFn, type ReceiveOptions } from "../../src/server/slots";
import { until } from "../helpers";
import { FakeLog, memoryStore } from "./server-slots-harness";

const A = "srv-a";
const B = "srv-b";
const PHONE = "dev-phone";
const BOT = "6A0B0000-0000-4000-8000-0000000000B1";
const CARD = "6A0B0000-0000-4000-8000-0000000000C1";
const EPOCH = "c".repeat(32);
const INC = "inc-00000001"; // the slot harness log's incarnation
const TARGET = `bot:${BOT}` as const;

const send = (text: string): Command => ({ type: "chat.send", botId: BOT, text });
const choose: Command = { type: "chat.choose", botId: BOT, messageId: CARD, index: 0 };
const adminCmd: Command = { type: "mobile.view" };
const machineCmd: Command = { type: "settings.set", change: { key: "developerMode", value: true } };
const callinCancel: Command = { type: "callin.cancel", botId: BOT, callId: "6A0B0000-0000-4000-8000-0000000000D1" };

interface World {
  applied: Array<{ origin: string; n: number; type: string }>;
  results: Array<MessageOf<"cmd.result">>;
  seenAtB: CmdBody[];
  forwarder: Forwarder;
  dead(): unknown[];
  queued(): number;
  /** The window (origin "desktop") or a phone sends a command to A; A states the scope a session would. */
  fromWindow(n: number, cmd: Command, over?: Partial<Slot>): Promise<void>;
  fromPhone(n: number, cmd: Command, scope: CmdBody["scope"]): Promise<void>;
  result(origin: string, n: number): MessageOf<"cmd.result"> | undefined;
  close(): Promise<void>;
}

async function world(roster: Partial<DeviceRoster> = {}): Promise<World> {
  const a = memoryStore();
  const b = memoryStore();
  const applied: World["applied"] = [];
  const results: World["results"] = [];
  const seenAtB: CmdBody[] = [];
  const apply: ApplyFn = ({ slot, cmd, log, tx }) => {
    log.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot);
    applied.push({ origin: slot.origin, n: slot.n, type: cmd.type });
    return { result: { n: slot.n } };
  };
  const ownerRoster: DeviceRoster = {
    memberId: B,
    device: (member) => (member === PHONE ? { keys: { sign: "s", dh: "d" }, scope: ["read", "reply", "approve"] } : null),
    server: (member) => member === A,
    ...roster,
  };
  const engine = new SlotEngine({ submit: (c) => b.writer.submit(c), log: new FakeLog(), apply, authorize: slotAuthorize(ownerRoster), basis: { turnRunning: () => true, card: () => ({ open: true, rev: 1 }) } });
  const runtime = {
    receive: (body: CmdBody, options: ReceiveOptions) => { seenAtB.push(body); return engine.receive(body, options); },
    slots: engine,
    legacy: { receive: (body: CmdBody, options: ReceiveOptions) => { seenAtB.push(body); return engine.receive(body, options); } },
  };
  const inbox = new OwnerInbox({ self: B, runtime: runtime as never, log: () => undefined });
  // The A ↔ B session: frames go straight across, as copies.
  const onB: InboxSession = {
    get peer() { return A; }, state: "open",
    sendWire: (m: WireMessage) => { void forwarder.onMessage(onA, structuredClone(m)); return true; },
    bye: () => undefined,
  };
  const onA: ForwardSession = {
    get peer() { return B; }, state: "open",
    sendWire: (m: WireMessage) => { inbox.onMessage(onB, structuredClone(m)); return true; },
  };
  await a.writer.submit((tx) => { tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, '{}', 0)").run(`srv:${B}`, TARGET); });
  const directory = new Directory({ self: A, reader: () => a.db, peers: () => [B], hasBot: () => false });
  const forwarder: Forwarder = new Forwarder({ self: A, submit: (c) => a.writer.submit(c), reader: () => a.db, directory, session: () => onA, log: () => undefined });
  const sink = (message: Message) => { if (message.t === "cmd.result") results.push(message); return true; };
  forwarder.attach(WINDOW_ORIGIN, sink);
  forwarder.attach(PHONE, sink);
  forwarder.opened(onA);

  const envelope = (origin: string, n: number, cmd: Command, scope: CmdBody["scope"], slotOver: Partial<Slot> = {}): CmdBody =>
    ({ slot: { origin, originEpoch: EPOCH, target: TARGET, n, ...slotOver }, floor: 1, inc: INC, cmd, scope }) as CmdBody;
  return {
    applied, results, seenAtB, forwarder,
    dead: () => a.db.prepare("SELECT n, reason FROM forwarddead ORDER BY n").all(),
    queued: () => a.db.prepare("SELECT n FROM forwardq").all().length,
    fromWindow: (n, cmd, over = {}) => forwarder.commit(envelope(WINDOW_ORIGIN, n, cmd, "local", over), B),
    fromPhone: (n, cmd, scope) => forwarder.commit(envelope(PHONE, n, cmd, scope), B),
    result: (origin, n) => results.find((r) => r.slot.origin === origin && r.slot.n === n),
    close: async () => { await a.writer.close(); await b.writer.close(); a.db.close(); b.db.close(); },
  };
}

describe("M7-12a: a window command forwarded by a peer", () => {
  it("chat.send and a card answer for a bot B owns apply on B once, each stamped manage", async () => {
    const w = await world();
    try {
      await w.fromWindow(1, send("hello"));
      await w.fromWindow(2, choose);
      await until(() => w.result(WINDOW_ORIGIN, 1) && w.result(WINDOW_ORIGIN, 2), { what: "both answers" });
      expect(w.result(WINDOW_ORIGIN, 1)!.outcome).toMatchObject({ kind: "applied" });
      expect(w.result(WINDOW_ORIGIN, 2)!.outcome).toMatchObject({ kind: "applied" });
      expect(w.applied).toEqual([{ origin: "desktop", n: 1, type: "chat.send" }, { origin: "desktop", n: 2, type: "chat.choose" }]);
      expect(w.seenAtB.map((b) => b.scope)).toEqual(["manage", "manage"]);
      // A re-sent copy (the window's outbox) gets the stored outcome; nothing applies twice.
      await w.fromWindow(1, send("hello"));
      await until(() => w.results.filter((r) => r.slot.n === 1).length >= 2, { what: "the stored outcome again" });
      expect(w.applied).toHaveLength(2);
      expect(w.queued()).toBe(0);
    } finally { await w.close(); }
  });

  it("an admin or machine command is refused at A, never reaches B, and the queue goes on", async () => {
    const w = await world();
    try {
      await w.fromWindow(1, adminCmd);
      await w.fromWindow(2, machineCmd);
      await w.fromWindow(3, send("after"));
      await until(() => w.result(WINDOW_ORIGIN, 3), { what: "the command after them" });
      for (const n of [1, 2]) {
        const outcome = w.result(WINDOW_ORIGIN, n)!.outcome;
        expect(outcome).toMatchObject({ kind: "refused", reason: "scope" });
        expect((outcome as { detail?: string }).detail).toContain("needs the desktop window on that machine");
      }
      expect(w.result(WINDOW_ORIGIN, 3)!.outcome).toMatchObject({ kind: "applied" });
      expect(w.seenAtB.map((b) => b.cmd.type)).toEqual(["chat.send"]);
      expect(w.applied.map((x) => x.n)).toEqual([3]);
      // Nothing is left to send for the two refused slots (their dead rows may already be pruned).
      expect(w.queued()).toBe(0);
      expect(w.dead().every((d) => [1, 2].includes(Number((d as { n: number }).n)))).toBe(true);
    } finally { await w.close(); }
  });

  it("a phone with read still gets its scope from B (forwarded as stated, never raised)", async () => {
    const w = await world();
    try {
      await w.fromPhone(1, send("from a read-only phone"), "read");
      await until(() => w.result(PHONE, 1), { what: "the refusal" });
      expect(w.result(PHONE, 1)!.outcome).toMatchObject({ kind: "refused", reason: "scope" });
      expect(w.seenAtB[0]!.scope).toBe("read");
      expect(w.applied).toEqual([]);
      // The same phone with the scope the command needs is applied: the window rule did not change the device path.
      await w.fromPhone(2, send("reply scope"), "reply");
      await until(() => w.result(PHONE, 2), { what: "the applied answer" });
      expect(w.result(PHONE, 2)!.outcome).toMatchObject({ kind: "applied" });
    } finally { await w.close(); }
  });

  it("a local command under another origin is not stamped: B decides it as read and refuses it", async () => {
    const w = await world();
    try {
      await w.fromWindow(1, send("a local client posing as the phone"), { origin: PHONE });
      await until(() => w.result(PHONE, 1), { what: "the refusal" });
      expect(w.seenAtB[0]!.scope).toBe("local");
      expect(w.result(PHONE, 1)!.outcome).toMatchObject({ kind: "refused", reason: "scope" });
      expect(w.applied).toEqual([]);
    } finally { await w.close(); }
  });

  it("a local manage command under another valid server's origin is not applied at B (no borrowed server origin)", async () => {
    // B knows a third server C. Stamped `manage`, `bot.restart` (a manage command) would pass B's server-origin rule
    // under C's name; A forwards it as stated `local`, B decides it as `read` and refuses it.
    const C = "srv-c";
    const w = await world({ server: (member) => member === A || member === C });
    const atC: Array<MessageOf<"cmd.result">> = [];
    w.forwarder.attach(C, (m) => { if (m.t === "cmd.result") atC.push(m); return true; });
    try {
      await w.fromWindow(1, { type: "bot.restart", botId: BOT }, { origin: C });
      await until(() => atC.length > 0, { what: "B's answer" });
      expect(atC[0]!.outcome).toMatchObject({ kind: "refused", reason: "scope" });
      expect(w.applied).toEqual([]);
    } finally { await w.close(); }
  });

  it("a local call-in under a server's origin is refused at A and never reaches B (F2)", async () => {
    const w = await world();
    const atA: Array<MessageOf<"cmd.result">> = [];
    w.forwarder.attach(A, (m) => { if (m.t === "cmd.result") atA.push(m); return true; });
    try {
      await w.fromWindow(1, callinCancel, { origin: A });
      await until(() => atA.length > 0, { what: "the refusal at A" });
      expect(atA[0]!.outcome).toMatchObject({ kind: "refused", reason: "scope" });
      expect((atA[0]!.outcome as { detail?: string }).detail).toContain("needs the desktop window on that machine");
      expect(w.seenAtB).toEqual([]);
      expect(w.applied).toEqual([]);
      expect(w.queued()).toBe(0);
    } finally { await w.close(); }
  });
});

describe("M7-12a: the pieces", () => {
  const slot = (origin: string): Slot => ({ origin, originEpoch: EPOCH, target: TARGET, n: 1 });
  const stamped = (scope: CmdBody["scope"]): CmdBody => ({ slot: slot(WINDOW_ORIGIN), floor: 1, inc: INC, cmd: send("x"), scope }) as CmdBody;

  it("windowForward changes only a local scope, and never for a machine-only command", () => {
    expect(windowForward(stamped("local"))).toMatchObject({ envelope: { scope: "manage" } });
    for (const scope of ["read", "reply", "approve", "manage"] as const) expect(windowForward(stamped(scope))).toEqual({ envelope: stamped(scope) });
    expect(windowForward({ ...stamped("local"), cmd: adminCmd })).toHaveProperty("refusal");
    expect(windowForward({ ...stamped("local"), cmd: machineCmd })).toHaveProperty("refusal");
    // A local command whose origin is not the window's (another local client naming a phone or a server) is not
    // stamped: B decides it as `read`, so a local token at A never borrows that origin's scope at B.
    for (const origin of [PHONE, "srv-a", "other-local"]) {
      const other = { ...stamped("local"), slot: slot(origin) };
      expect(windowForward(other)).toEqual({ envelope: other });
      // ...but a machine-only command or a call-in is still refused at A, whatever the origin.
      expect(windowForward({ ...other, cmd: adminCmd })).toHaveProperty("refusal");
      expect(windowForward({ ...other, cmd: callinCancel })).toHaveProperty("refusal");
    }
    // A forwarded phone command that states admin is not rewritten either: it stays the owner's to refuse.
    expect(windowForward({ ...stamped("admin"), cmd: adminCmd })).toEqual({ envelope: { ...stamped("admin"), cmd: adminCmd } });
  });

  it("peerScope is unchanged: local, admin and nothing are still read; a stamped manage passes through", () => {
    expect(peerScope("local")).toBe("read");
    expect(peerScope("admin")).toBe("read");
    expect(peerScope(undefined)).toBe("read");
    expect(peerScope("manage")).toBe("manage");
  });

  it("B decides manage only under the window's origin, and refuses the rest", () => {
    const check = (origin: string, cmd: Command, scope: Parameters<typeof windowOwnerCheck>[2], named = false) => windowOwnerCheck(slot(origin), cmd, scope, named);
    expect(check(WINDOW_ORIGIN, send("x"), "manage")).toEqual({ allowed: true });
    expect(check(WINDOW_ORIGIN, choose, "manage")).toEqual({ allowed: true });
    expect(check(WINDOW_ORIGIN, adminCmd, "manage")).toMatchObject({ reason: "scope" });
    expect(check(WINDOW_ORIGIN, machineCmd, "manage")).toMatchObject({ reason: "scope" });
    // Not a window decision at all: the usual checks run (and refuse an origin B does not know).
    expect(check(WINDOW_ORIGIN, send("x"), "reply")).toBeNull();
    expect(check(WINDOW_ORIGIN, send("x"), "read")).toBeNull();
    expect(check("srv-a", send("x"), "manage")).toBeNull();
    expect(check(PHONE, send("x"), "manage")).toBeNull();
    expect(check(WINDOW_ORIGIN, send("x"), "manage", true)).toBeNull();
  });

  it("through slotAuthorize: a roster device called desktop, or a window origin without manage, is refused", () => {
    const tx = null as never;
    const plain = slotAuthorize({ memberId: B, device: () => null, server: (m) => m === A });
    expect(plain(tx, { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "manage" })).toBeNull();
    expect(plain(tx, { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "reply" })).toMatchObject({ reason: "origin" });
    expect(plain(tx, { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "read" })).toMatchObject({ reason: "origin" });
    expect(plain(tx, { slot: slot(WINDOW_ORIGIN), cmd: adminCmd, scope: "manage" })).toMatchObject({ reason: "scope" });
    const named = slotAuthorize({ memberId: B, device: (m) => (m === WINDOW_ORIGIN ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null), server: () => false });
    expect(named(tx, { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "manage" })).toMatchObject({ reason: "scope" });
  });
});
