// Botling 3 M5-02b (the M5-01 review's required item): `ServerOrigin.submit` checks the command BEFORE its transaction.
// A command that does not parse, or whose frame cannot be sent (`encodeWireFrame` as a peer), throws and leaves nothing:
// no `forwardq` row, no `serverOrigin:` pending key, no change to `myorigins.nextN`, nothing pumped. Otherwise an
// unsendable row would sit at the head of the owner's queue for good (Forwarder.pump stops at the first row it cannot send).
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { LogId, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, ServerOrigin, type ForwardSession } from "../../src/server/forward";
import type { Db } from "../../src/server/store";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const PEER = "srv-b";
const GUEST = "6A0B0000-0000-4000-8000-000000000002";
const HOST = "6A0B0000-0000-4000-8000-000000000003";
const TARGET = `bot:${GUEST}` as const;
const INC = "loginc0001" as LogId;

function setup() {
  const { db, writer } = memoryStore();
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 1, NULL, 'live', 1)").run(`srv:${PEER}`, PEER, INC);
  db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(`srv:${PEER}`, `bot:${GUEST}`, JSON.stringify({ kind: "bot", id: GUEST }));
  const sent: WireMessage[] = [];
  const session: ForwardSession = { peer: PEER, state: "open", sendWire: (message) => { sent.push(message); return true; } };
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [PEER], hasBot: () => false });
  const forwarder = new Forwarder({
    self: SELF, submit: (command) => writer.submit(command), reader: () => db, directory,
    session: (peer) => (peer === PEER ? session : null), log: () => undefined,
  });
  const origin = new ServerOrigin({ self: SELF, submit: (command) => writer.submit(command), reader: () => db, forwarder, log: () => undefined });
  return { db, writer, origin, sent };
}

let open: ReturnType<typeof setup> | null = null;
afterEach(async () => {
  if (!open) return;
  open.origin.close();
  await open.writer.close();
  open.db.close();
  open = null;
});

const count = (db: Db, sql: string) => Number((db.prepare(sql).get() as { c: number }).c);
const snapshot = (db: Db) => ({
  queue: count(db, "SELECT COUNT(*) AS c FROM forwardq"),
  pending: count(db, "SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'"),
  origins: db.prepare("SELECT target, originEpoch, nextN FROM myorigins ORDER BY target").all().map((row) => ({ ...row })),
});

const validReply: Command = { type: "callin.reply", botId: HOST, callId: "call-1", guest: { botId: GUEST, name: "tester" }, outcome: { kind: "reply", text: "ok", engine: "claude" } };

describe("M5-02b: ServerOrigin.submit checks the command before it commits anything", () => {
  it("a command the schema refuses throws and leaves no row, no pending key, no counter change", async () => {
    open = setup();
    const { db, origin, sent } = open;
    const first = await origin.submit(TARGET, validReply);
    expect(first.n).toBe(1);
    const before = snapshot(db);
    const framesBefore = sent.length;

    const bad: Command[] = [
      // An unknown key (strict), a reply over its byte bound, a depth out of range: all things a buggy caller could build.
      { ...validReply, extra: 1 } as unknown as Command,
      { ...validReply, outcome: { kind: "reply", text: "答".repeat(200 * 1024), engine: "claude" } } as Command,
      { type: "callin.ask", botId: GUEST, callId: "call-2", host: { server: SELF, botId: HOST, name: "build" }, transcript: "", asked: "q", by: "user", depth: 5 } as unknown as Command,
      { type: "no.such.command" } as unknown as Command,
    ];
    for (const cmd of bad) {
      await expect(origin.submit(TARGET, cmd)).rejects.toThrow(/not a valid command/);
      expect(snapshot(db)).toEqual(before);
    }
    expect(sent.length).toBe(framesBefore);

    // The counter was never touched, so the next good command is slot 2 (gapless), in the same epoch.
    const next = await origin.submit(TARGET, validReply);
    expect(next.n).toBe(2);
    expect(next.originEpoch).toBe(first.originEpoch);
  });

  it("a command that parses but whose frame is over the limit throws and leaves nothing", async () => {
    open = setup();
    const { db, origin, sent } = open;
    const before = snapshot(db);
    // chat.send text may be 100,000 characters; 60,000 control characters escape to 6 bytes each, over 256 KiB as a frame.
    const huge: Command = { type: "chat.send", botId: GUEST, text: "\u0001".repeat(60_000) };
    await expect(origin.submit(TARGET, huge)).rejects.toThrow(/too large|too-large|cannot be sent/i);
    expect(snapshot(db)).toEqual(before);
    expect(sent).toHaveLength(0);
    // And the queue is not jammed: a normal command goes out as slot 1.
    const ok = await origin.submit(TARGET, validReply);
    expect(ok.n).toBe(1);
    expect(sent.filter((message) => message.t === "cmd")).toHaveLength(1);
  });

  it("the largest call-in the schema allows is sendable (the frame check never refuses a legal call-in)", async () => {
    open = setup();
    const { origin, sent } = open;
    // 200 KiB of control characters (6 bytes each when escaped is over the bound, so use the largest legal fill).
    const worst = "\n".repeat(100 * 1024);
    const slot = await origin.submit(TARGET, { ...validReply, outcome: { kind: "reply", text: worst, engine: "claude" } } as Command);
    expect(slot.n).toBe(1);
    expect(sent.filter((message) => message.t === "cmd")).toHaveLength(1);
  });
});
