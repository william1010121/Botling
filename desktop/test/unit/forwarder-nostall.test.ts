// Forwarder.pump must not stall on a row that can never be sent (follow-up of the M5-01 review).
//
// A queued row that fails for good (its envelope is not JSON, does not parse, its frame is too large, the encoder
// throws) moves into `forwarddead` with its reason in one transaction (its cancel goes with it), the origin hears
// `cmd.result{refused invalid}`, and the rest of its queue and every other queue go on. A refused `sendWire` (the link)
// is not a failure of the row: it stays and the next pump sends it. Rows above a dead slot go out with a `floor` above
// it (checked against the owner's `admit`) and only after the rows below the dead slot were answered. In-memory
// server.db behind the real writer; no network, no windows.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, LogId, Message, MessageOf, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, type ForwardSession } from "../../src/server/forward";
import { commitCancel, commitRow } from "../../src/server/forward/forward-queue";
import { admit, cmdHash } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { until } from "../helpers";
import { FakeLog, memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const OWNER = "srv-b";
const OTHER_OWNER = "srv-c";
const BOT_B = "6A0B0000-0000-4000-8000-000000000002";
const BOT_B2 = "6A0B0000-0000-4000-8000-000000000003";
const BOT_C = "6A0B0000-0000-4000-8000-000000000005";
const INC = "loginc0001" as LogId;
const EPOCH = "c".repeat(32);
const NOW = 1_700_000_000_000;

const slotOf = (n: number, over: Partial<Slot> = {}): Slot => ({ origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT_B}`, n, ...over }) as Slot;
const command = (text: string, botId = BOT_B): Command => ({ type: "waiting.ignore", botId, text });
const envelopeOf = (n: number, over: Partial<CmdBody> = {}, slotOver: Partial<Slot> = {}): CmdBody =>
  ({ slot: slotOf(n, slotOver), floor: 1, inc: INC, cmd: command(`text ${n}`), scope: "reply", ...over }) as CmdBody;
const hashOf = (envelope: CmdBody) => cmdHash({ cmd: envelope.cmd, scope: envelope.scope!, basis: envelope.basis, via: envelope.via });

function harness(options: { encode?: (message: WireMessage) => { ok: true } | { ok: false; reason: string }; failSubmit?: () => boolean } = {}) {
  const { db, writer } = memoryStore();
  const sent: WireMessage[] = [];
  const state = { sendOk: true };
  const session = (peer: string): ForwardSession => ({ peer, state: "open", sendWire: (message) => { if (!state.sendOk) return false; sent.push(message); return true; } });
  const sessions = new Map<string, ForwardSession>([[OWNER, session(OWNER)], [OTHER_OWNER, session(OTHER_OWNER)]]);
  const logs: string[] = [];
  const relayed: Message[] = [];
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [OWNER, OTHER_OWNER], hasBot: () => false });
  const make = () => {
    const forwarder = new Forwarder({
      self: SELF,
      submit: (command) => { if (options.failSubmit?.()) return Promise.reject(new Error("simulated commit failure")); return writer.submit(command); },
      reader: () => db,
      directory,
      session: (peer) => sessions.get(peer) ?? null,
      log: (line) => logs.push(line),
      now: () => NOW,
      ...(options.encode ? { encode: options.encode } : {}),
    });
    forwarder.attach("desktop", (message) => { relayed.push(message); return true; });
    return forwarder;
  };
  const insert = (envelope: CmdBody | string, owner = OWNER, slot = envelope && typeof envelope === "object" ? envelope.slot : slotOf(1)) =>
    writer.submit((tx) => {
      const text = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
      tx.prepare("INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(slot.origin, slot.originEpoch, slot.target, slot.n, owner, typeof envelope === "string" ? "badhash" : hashOf(envelope), text, NOW - 1);
    });
  const cmds = (): Array<MessageOf<"cmd">> => sent.filter((m): m is MessageOf<"cmd"> => m.t === "cmd");
  const queued = () => db.prepare("SELECT n FROM forwardq ORDER BY n").all().map((r) => Number(r.n));
  const dead = () => db.prepare("SELECT n, reason, envelope, heldAt, failedAt FROM forwarddead ORDER BY n").all();
  const results = () => relayed.filter((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result");
  return { db, writer, sent, state, logs, relayed, make, insert, cmds, queued, dead, results, sessions, close: async () => { await writer.close(); db.close(); } };
}

const SCHEMA_BAD = { ...envelopeOf(1), cmd: { type: "no.such.command" } } as unknown as CmdBody;

describe("Forwarder.pump does not stall on a row that can never be sent", () => {
  const poisons: Array<{ name: string; reason: string; encode?: (m: WireMessage) => { ok: true } | { ok: false; reason: string }; row: () => CmdBody | string }> = [
    { name: "it does not parse as a command", reason: "malformed", row: () => SCHEMA_BAD },
    { name: "its stored text is not JSON", reason: "unreadable", row: () => "{not json" },
    { name: "its stored text is JSON but not an object", reason: "unreadable", row: () => "null" },
    {
      name: "its frame is over the size limit", reason: "too-large", row: () => envelopeOf(1),
      encode: (m) => (m.t === "cmd" && m.slot.n === 1 ? { ok: false, reason: "too-large" } : { ok: true }),
    },
    {
      name: "the encoder throws", reason: "encoder error", row: () => envelopeOf(1),
      encode: (m) => { if (m.t === "cmd" && m.slot.n === 1) throw new Error("boom: secret-token-123"); return { ok: true }; },
    },
  ];

  for (const poison of poisons) {
    it(`${poison.name}: the row moves out with its reason, its origin hears a refusal, the next row is delivered`, async () => {
      const h = harness(poison.encode ? { encode: poison.encode } : {});
      try {
        const forwarder = h.make();
        const row = poison.row();
        await h.insert(row, OWNER, slotOf(1));
        await forwarder.commit(envelopeOf(2), OWNER);
        await until(() => h.dead().length === 1 && h.cmds().length === 1);

        expect(h.cmds().map((c) => c.slot.n)).toEqual([2]);
        expect(h.queued()).toEqual([2]);
        const dead = h.dead()[0]!;
        expect(Number(dead.n)).toBe(1);
        expect(String(dead.reason)).toBe(poison.reason);
        expect(String(dead.envelope)).toBe(typeof row === "string" ? row : JSON.stringify(row));
        expect(Number(dead.heldAt)).toBe(NOW - 1);
        expect(Number(dead.failedAt)).toBe(NOW);
        // The waiter: one refused result for slot 1, with no entry (seq null), nothing about the error's own text.
        const refusal = h.results().filter((r) => r.slot.n === 1);
        expect(refusal).toHaveLength(1);
        expect(refusal[0]).toMatchObject({ outcome: { kind: "refused", reason: "invalid" }, seq: null });
        expect(JSON.stringify(h.relayed)).not.toContain("secret-token-123");
        expect(h.logs.join("\n")).not.toContain("secret-token-123");
        // Slot 2 goes out with a floor above the dead slot (the owner never waits for slot 1).
        expect(h.cmds()[0]!.floor).toBe(2);
      } finally {
        await h.close();
      }
    });
  }

  it("the dead row's cancel goes with it in the same commit, and the cancel is never sent", async () => {
    const h = harness();
    try {
      const forwarder = h.make();
      await h.insert(SCHEMA_BAD, OWNER, slotOf(1));
      await h.writer.submit((tx) => commitCancel(tx, slotOf(1), OWNER, NOW));
      await forwarder.commit(envelopeOf(2), OWNER);
      await until(() => h.dead().length === 1 && h.cmds().length === 1);
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM fwdcancels").get()!.n).toBe(0);
      expect(h.sent.filter((m) => m.t === "cancel")).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("other queues and other owners go on while one queue has a dead row", async () => {
    const h = harness();
    try {
      const forwarder = h.make();
      await h.insert(SCHEMA_BAD, OWNER, slotOf(1));
      await forwarder.commit(envelopeOf(1, {}, { target: `bot:${BOT_B2}` }), OWNER);
      await forwarder.commit(envelopeOf(1, { cmd: command("c", BOT_C) }, { target: `bot:${BOT_C}` }), OTHER_OWNER);
      await until(() => h.dead().length === 1 && h.cmds().length === 2);
      expect(h.cmds().map((c) => c.slot.target).sort()).toEqual([`bot:${BOT_B2}`, `bot:${BOT_C}`].sort());
    } finally {
      await h.close();
    }
  });

  it("another queue of the same owner is sent in the same pump even while the dead row cannot be moved out yet", async () => {
    const h = harness({ failSubmit: () => true });
    try {
      const forwarder = h.make();
      await h.writer.submit((tx) => commitRow(tx, envelopeOf(1, {}, { target: `bot:${BOT_B2}` }), hashOf(envelopeOf(1, {}, { target: `bot:${BOT_B2}` })), OWNER, NOW));
      await h.writer.submit((tx) => tx.prepare("INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES (?, ?, ?, 1, ?, 'x', ?, ?)")
        .run("desktop", "a".repeat(32), `bot:${BOT_B}`, OWNER, JSON.stringify(SCHEMA_BAD), NOW));
      forwarder.pump(OWNER);
      expect(h.cmds().map((c) => c.slot.target)).toEqual([`bot:${BOT_B2}`]);
      expect(h.dead()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("a restart with a dead row in the queue (written by older code) does not stall", async () => {
    const h = harness();
    try {
      // Written before this change: a row that cannot be sent in the middle of a queue, no session yet.
      await h.insert(envelopeOf(1), OWNER, slotOf(1));
      await h.insert(SCHEMA_BAD, OWNER, slotOf(2));
      await h.insert(envelopeOf(3), OWNER, slotOf(3));
      const forwarder = h.make();
      forwarder.opened(h.sessions.get(OWNER)!);
      await until(() => h.dead().length === 1 && h.cmds().length === 1);
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1]);
      // The row below is answered; the row above goes out.
      await forwarder.onMessage(h.sessions.get(OWNER)!, { t: "cmd.result", slot: slotOf(1), outcome: { kind: "applied" }, logId: INC, seq: 1 } as WireMessage);
      await until(() => h.cmds().length === 2);
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1, 3]);
      expect(h.queued()).toEqual([3]);
      // A second restart: the dead row stays dead (kept for audit), nothing re-sent for it, row 3 goes again.
      const again = h.make();
      again.opened(h.sessions.get(OWNER)!);
      await until(() => h.cmds().length === 3);
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1, 3, 3]);
      expect(h.dead()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("a refused send (the link) is not a failure of the row: it stays, nothing is moved out, the next pump sends it", async () => {
    const h = harness();
    try {
      const forwarder = h.make();
      h.state.sendOk = false;
      await forwarder.commit(envelopeOf(1), OWNER);
      await forwarder.commit(envelopeOf(2), OWNER);
      expect(h.cmds()).toEqual([]);
      expect(h.queued()).toEqual([1, 2]);
      expect(h.dead()).toEqual([]);
      expect(h.results()).toEqual([]);
      h.state.sendOk = true;
      forwarder.pump(OWNER);
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1, 2]);
      expect(h.dead()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("a failed commit of the move leaves the row in the queue and tries again with a wait", async () => {
    let failures = 2;
    const h = harness({ failSubmit: () => failures-- > 0 });
    try {
      const forwarder = h.make();
      await h.insert(SCHEMA_BAD, OWNER, slotOf(1));
      await h.writer.submit((tx) => commitRow(tx, envelopeOf(2), hashOf(envelopeOf(2)), OWNER, NOW));
      forwarder.pump(OWNER);
      await until(() => h.logs.some((l) => l.includes("failed: simulated commit failure")));
      expect(h.dead()).toEqual([]);
      expect(h.queued()).toEqual([1, 2]);
      expect(h.cmds()).toEqual([]);
      await until(() => h.dead().length === 1 && h.cmds().length === 1, { timeout: 10_000 });
      expect(h.results().filter((r) => r.slot.n === 1)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("rows above a dead slot wait for the rows below it to be answered, then go out in order with a floor above it", async () => {
    const h = harness({ encode: (m) => (m.t === "cmd" && m.slot.n === 2 ? { ok: false, reason: "too-large" } : { ok: true }) });
    try {
      const forwarder = h.make();
      for (const n of [1, 2, 3, 4]) await h.writer.submit((tx) => commitRow(tx, envelopeOf(n), hashOf(envelopeOf(n)), OWNER, NOW));
      forwarder.pump(OWNER);
      await until(() => h.dead().length === 1);
      // Row 1 went; rows 3 and 4 hold back (a floor above slot 2 would also skip slot 1 at the owner).
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1]);
      expect(h.cmds()[0]!.floor).toBe(1);
      await forwarder.onMessage(h.sessions.get(OWNER)!, { t: "cmd.result", slot: slotOf(1), outcome: { kind: "applied" }, logId: INC, seq: 1 } as WireMessage);
      await until(() => h.cmds().length === 3);
      expect(h.cmds().map((c) => [c.slot.n, c.floor])).toEqual([[1, 1], [3, 3], [4, 3]]);

      // The owner (admit at slot 1 applied: next = 2): row 3 skips the dead slot and is ready, row 4 follows.
      const owner = memoryStore();
      const log = new FakeLog(INC);
      try {
        owner.db.prepare("INSERT INTO slots (origin, originEpoch, target, next) VALUES ('desktop', ?, ?, 2)").run(EPOCH, `bot:${BOT_B}`);
        const input = (c: MessageOf<"cmd">) => ({ slot: c.slot, floor: c.floor, inc: c.inc, cmd: c.cmd, scope: c.scope!, hash: cmdHash({ cmd: c.cmd, scope: c.scope! }) });
        expect(admit(owner.db as Db, log, input(h.cmds()[1]!))).toMatchObject({ kind: "ready", skip: { from: 2, to: 2 } });
        owner.db.prepare("UPDATE slots SET next = 4").run();
        expect(admit(owner.db as Db, log, input(h.cmds()[2]!))).toMatchObject({ kind: "ready" });
        // The old floor would have left the owner holding row 3 for slot 2.
        owner.db.prepare("UPDATE slots SET next = 2").run();
        expect(admit(owner.db as Db, log, input({ ...h.cmds()[1]!, floor: 1 }))).toMatchObject({ kind: "hold" });
      } finally {
        await owner.writer.close();
        owner.db.close();
      }
    } finally {
      await h.close();
    }
  });

  it("with no row below the dead slot, the next row goes at once with a floor above it", async () => {
    const h = harness();
    try {
      const forwarder = h.make();
      await h.insert(SCHEMA_BAD, OWNER, slotOf(1));
      await forwarder.commit(envelopeOf(2), OWNER);
      await forwarder.commit(envelopeOf(3), OWNER);
      await until(() => h.cmds().length === 2);
      expect(h.cmds().map((c) => [c.slot.n, c.floor])).toEqual([[2, 2], [3, 2]]);
    } finally {
      await h.close();
    }
  });

  it("a row that was replaced by a re-send between the read and the move is not moved out", async () => {
    const h = harness();
    try {
      await h.insert(SCHEMA_BAD, OWNER, slotOf(1));
      const read = h.db.prepare("SELECT cmdHash, envelope FROM forwardq WHERE n = 1").get()!;
      await h.writer.submit((tx) => commitRow(tx, envelopeOf(1), hashOf(envelopeOf(1)), OWNER, NOW));
      const { failRow } = await import("../../src/server/forward/forward-queue");
      const moved = await h.writer.submit((tx) => failRow(tx, { slot: slotOf(1), owner: OWNER, cmdHash: String(read.cmdHash), raw: String(read.envelope) }, "malformed", NOW));
      expect(moved).toBe(false);
      expect(h.queued()).toEqual([1]);
      expect(h.dead()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
