// fu-callin-outbox: `ServerOrigin.submitIn(tx, …)` queues a command inside the CALLER's writer transaction, so the caller's own
// writes (a guest marking its call-in answered) and the queue row commit or roll back together. In-memory store, the real
// `Forwarder` and `ServerOrigin`; a fake session records what goes out.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../src/contract";
import { slotKey, type LogId, type MessageOf, type Outcome, type WireMessage } from "../../src/protocol";
import { Directory, Forwarder, ServerOrigin, type ForwardSession } from "../../src/server/forward";
import type { Db } from "../../src/server/store";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const PEER = "srv-b";
const BOT_B1 = "6A0B0000-0000-4000-8000-000000000002";
const TARGET = `bot:${BOT_B1}` as const;
const INC = "loginc0001" as LogId;
const CMD: Command = { type: "waiting.ignore", botId: BOT_B1, text: "from the caller's transaction" };

function fixture(options: { revoked?: boolean } = {}) {
  const { db, writer } = memoryStore();
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 1, NULL, 'live', 1)").run(`srv:${PEER}`, PEER, INC);
  db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(`srv:${PEER}`, TARGET, JSON.stringify({ kind: "bot", id: BOT_B1 }));
  const sent: WireMessage[] = [];
  const session: ForwardSession = { peer: PEER, state: "open", sendWire: (message) => { sent.push(message); return true; } };
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [PEER], hasBot: () => false });
  const isRevoked = (owner: string) => !!options.revoked && owner === PEER;
  const forwarder = new Forwarder({ self: SELF, submit: (command) => writer.submit(command), reader: () => db, directory, session: (peer) => (peer === PEER ? session : null), isRevoked, log: () => undefined });
  const origin = new ServerOrigin({ self: SELF, submit: (command) => writer.submit(command), reader: () => db, forwarder, isRevoked, log: () => undefined });
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const pendingKeys = () => db.prepare("SELECT key FROM meta WHERE key LIKE 'serverOrigin:%'").all().length;
  const cmdFrames = () => sent.filter((message): message is MessageOf<"cmd"> => message.t === "cmd");
  return { db, writer, forwarder, origin, session, count, pendingKeys, cmdFrames, close: async () => { origin.close(); await writer.close(); db.close(); } };
}

let open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); open = []; });
const make = (options: Parameters<typeof fixture>[0] = {}) => { const f = fixture(options); open.push(f.close); return f; };
const callerRow = (db: Db) => Number((db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'caller-write'").get() as { n: number }).n);
const callerWrite = (tx: Db) => tx.prepare("INSERT INTO meta (key, value) VALUES ('caller-write', '1')").run();

describe("fu-callin-outbox: ServerOrigin.submitIn", () => {
  it("1. the caller's write, the slot counter, the pending key and the queue row commit together; done() sends it", async () => {
    const h = make();
    const staged = await h.writer.submit((tx) => { callerWrite(tx); return h.origin.submitIn(tx, TARGET, CMD); });
    expect(callerRow(h.db)).toBe(1);
    expect(h.count("forwardq")).toBe(1);
    expect(h.pendingKeys()).toBe(1);
    expect(h.db.prepare("SELECT nextN FROM myorigins WHERE target = ?").get(TARGET)).toMatchObject({ nextN: 2 });
    expect(staged.slot).toMatchObject({ origin: SELF, target: TARGET, n: 1 });
    // Not sent, not tracked, until the caller says its transaction committed.
    expect(h.cmdFrames()).toHaveLength(0);
    staged.done();
    h.forwarder.pump(PEER);
    expect(h.cmdFrames().map((frame) => frame.slot)).toEqual([staged.slot]);
    // The next plain submit continues the same epoch.
    const next = await h.origin.submit(TARGET, CMD);
    expect(next).toMatchObject({ originEpoch: staged.slot.originEpoch, n: 2 });
  });

  it("2. a caller that fails after submitIn leaves nothing: no queue row, no pending key, no slot counter, and its own write is gone", async () => {
    const h = make();
    await expect(h.writer.submit((tx) => { callerWrite(tx); h.origin.submitIn(tx, TARGET, CMD); throw new Error("the caller failed"); })).rejects.toThrow("the caller failed");
    expect(callerRow(h.db)).toBe(0);
    expect(h.count("forwardq")).toBe(0);
    expect(h.pendingKeys()).toBe(0);
    expect(h.count("myorigins")).toBe(0);
    // Memory kept nothing either: the next submit is slot 1 and the outcome of the rolled-back slot is unknown.
    const slot = await h.origin.submit(TARGET, CMD);
    expect(slot.n).toBe(1);
    expect(h.origin.outcome(slot)).toBeNull();
  });

  it("3. a command that does not parse, or a target no peer owns, throws before anything is written", async () => {
    const h = make();
    const bad = { type: "callin.reply", botId: BOT_B1 } as unknown as Command;
    await expect(h.writer.submit((tx) => { callerWrite(tx); return h.origin.submitIn(tx, TARGET, bad); })).rejects.toThrow(/not a valid command/);
    await expect(h.writer.submit((tx) => { callerWrite(tx); return h.origin.submitIn(tx, "bot:6A0B0000-0000-4000-8000-0000000000FF", CMD); })).rejects.toThrow(/cannot submit/);
    expect(h.count("forwardq") + h.count("myorigins") + h.pendingKeys() + callerRow(h.db)).toBe(0);
  });

  it("4. the slot is tracked after done(): the owner's outcome reaches the listener; a revoked owner ends it refused at once, queueing nothing", async () => {
    const h = make();
    const heard: Array<[string, Outcome]> = [];
    h.origin.on((slot, outcome) => heard.push([slotKey(slot), outcome]));
    const staged = await h.writer.submit((tx) => h.origin.submitIn(tx, TARGET, CMD));
    staged.done();
    h.forwarder.pump(PEER);
    await h.forwarder.onMessage(h.session, { t: "cmd.result", slot: staged.slot, outcome: { kind: "applied" }, logId: INC, seq: 1 } as WireMessage);
    await vi.waitFor(() => { if (heard.length === 0) throw new Error("not heard yet"); });
    expect(heard.map(([key]) => key)).toEqual([slotKey(staged.slot)]);
    expect(h.pendingKeys()).toBe(0);

    const r = make({ revoked: true });
    const revoked = await r.writer.submit((tx) => { callerWrite(tx); return r.origin.submitIn(tx, TARGET, CMD); });
    expect(r.count("forwardq")).toBe(0);
    revoked.done();
    expect(r.origin.outcome(revoked.slot)).toMatchObject({ kind: "refused", reason: "revoked" });
    expect(callerRow(r.db)).toBe(1);
  });
});
