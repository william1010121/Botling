// Follow-up of the forwarder-nostall reviews (N2, N3, point 3): the dead rows (`forwarddead`) are pruned once nothing can
// need them, a cancel for a dead slot is not kept, and a stored envelope that is not JSON never throws in `dropOwner` or
// `commitRow`. In-memory server.db behind the real writer; no network, no windows.
//
// What keeps a dead row (docs in forward-queue.ts `deadToPrune`): a row above it with a floor at or below it, an
// unanswered slot below it, a ServerOrigin submit at or below it. What lets it go: a row above it with a floor above it
// (the origin heard the refusal), or a higher dead slot in the same queue.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, LogId, Message, MessageOf, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, type ForwardSession } from "../../src/server/forward";
import { commitCancel, commitRow, deadToPrune, dropOwner, pruneDead } from "../../src/server/forward/forward-queue";
import { cmdHash } from "../../src/server/slots";
import { until } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const OWNER = "srv-b";
const BOT_B = "6A0B0000-0000-4000-8000-000000000002";
const INC = "loginc0001" as LogId;
const EPOCH = "c".repeat(32);
const NOW = 1_700_000_000_000;

const slotOf = (n: number, over: Partial<Slot> = {}): Slot => ({ origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT_B}`, n, ...over }) as Slot;
const command = (text: string): Command => ({ type: "waiting.ignore", botId: BOT_B, text });
const envelopeOf = (n: number, over: Partial<CmdBody> = {}): CmdBody =>
  ({ slot: slotOf(n), floor: 1, inc: INC, cmd: command(`text ${n}`), scope: "reply", ...over }) as CmdBody;
const hashOf = (envelope: CmdBody) => cmdHash({ cmd: envelope.cmd, scope: envelope.scope!, basis: envelope.basis, via: envelope.via });
/** Slots in `dead` can never be sent (the encoder refuses them); everything else is fine. */
const deadSlots = (...dead: number[]) => (m: WireMessage) => (m.t === "cmd" && dead.includes(m.slot.n) ? { ok: false as const, reason: "too-large" } : { ok: true as const });

function harness(encode: (message: WireMessage) => { ok: true } | { ok: false; reason: string } = deadSlots()) {
  const { db, writer } = memoryStore();
  const sent: WireMessage[] = [];
  const logs: string[] = [];
  const relayed: Message[] = [];
  const lookups = { session: 0 };
  const session: ForwardSession = { peer: OWNER, state: "open", sendWire: (message) => { sent.push(message); return true; } };
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [OWNER], hasBot: () => false });
  const forwarder = new Forwarder({
    self: SELF, submit: (command) => writer.submit(command), reader: () => db, directory,
    session: (peer) => { lookups.session += 1; return peer === OWNER ? session : null; },
    log: (line) => logs.push(line), now: () => NOW, encode,
  });
  forwarder.attach("desktop", (message) => { relayed.push(message); return true; });
  const row = (n: number, over: Partial<CmdBody> = {}) => writer.submit((tx) => { const e = envelopeOf(n, over); return commitRow(tx, e, hashOf(e), OWNER, NOW); });
  const insertRaw = (n: number, raw: string, owner = OWNER) => writer.submit((tx) => {
    tx.prepare("INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("desktop", EPOCH, `bot:${BOT_B}`, n, owner, "badhash", raw, NOW - 1);
  });
  const insertDead = (n: number, owner = OWNER, epoch = EPOCH) => writer.submit((tx) => {
    tx.prepare("INSERT INTO forwarddead (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt, failedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("desktop", epoch, `bot:${BOT_B}`, n, owner, "h", JSON.stringify(envelopeOf(n)), NOW - 1, NOW, "too-large");
  });
  const setMeta = (n: number) => writer.submit((tx) => { tx.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`serverOrigin:${EPOCH}:bot:${BOT_B}:${n}`, "{}"); });
  const clearMeta = (n: number) => writer.submit((tx) => { tx.prepare("DELETE FROM meta WHERE key = ?").run(`serverOrigin:${EPOCH}:bot:${BOT_B}:${n}`); });
  const cmds = (): Array<MessageOf<"cmd">> => sent.filter((m): m is MessageOf<"cmd"> => m.t === "cmd");
  const dead = () => db.prepare("SELECT n FROM forwarddead ORDER BY n").all().map((r) => Number(r.n));
  const queued = () => db.prepare("SELECT n FROM forwardq ORDER BY n").all().map((r) => Number(r.n));
  const cancels = () => Number(db.prepare("SELECT COUNT(*) AS n FROM fwdcancels").get()!.n);
  const answer = (n: number) => forwarder.onMessage(session, { t: "cmd.result", slot: slotOf(n), outcome: { kind: "applied" }, logId: INC, seq: n } as WireMessage);
  return { db, writer, forwarder, sent, logs, relayed, lookups, session, row, insertRaw, insertDead, setMeta, clearMeta, cmds, dead, queued, cancels, answer, close: async () => { await writer.close(); db.close(); } };
}

describe("a dead row is pruned once nothing can need it", () => {
  it("stays while a row above it carries a floor at or below it, goes when a row above carries a floor above it", async () => {
    const h = harness(deadSlots(1));
    try {
      await h.row(1);
      await h.row(2);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1 && h.cmds().length === 1);
      expect(h.cmds()[0]).toMatchObject({ slot: { n: 2 }, floor: 2 });
      // Row 2 still carries floor 1: its re-send after a restart needs slot 1 as a hole. Not pruned, however often it pumps.
      h.forwarder.pump(OWNER);
      h.forwarder.pump(OWNER);
      await h.writer.submit(() => undefined);
      expect(h.dead()).toEqual([1]);

      // The owner answers slot 2; slot 1 has nothing above it. It stays (the origin may not have heard the refusal) ...
      await h.answer(2);
      h.forwarder.pump(OWNER);
      await h.writer.submit(() => undefined);
      expect(h.dead()).toEqual([1]);
      // ... until a row arrives with a floor above it: the origin resolved slot 1.
      await h.row(3, { floor: 3 });
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 0);
      expect(h.cmds().map((c) => [c.slot.n, c.floor])).toEqual([[2, 2], [3, 3]]);
      expect(h.queued()).toEqual([3]);
    } finally {
      await h.close();
    }
  });

  it("a row that arrives right after a dead slot still gets the floor over it (the dead row is not dropped at once)", async () => {
    const h = harness(deadSlots(1));
    try {
      await h.row(1);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1);
      // Nothing is above slot 1 now. The origin has not heard the refusal: its next row still carries floor 1.
      await h.forwarder.commit(envelopeOf(2), OWNER);
      await until(() => h.cmds().length === 1);
      expect(h.cmds()[0]).toMatchObject({ slot: { n: 2 }, floor: 2 });
      expect(h.dead()).toEqual([1]);
    } finally {
      await h.close();
    }
  });

  it("an unanswered row below a dead slot keeps it", async () => {
    const h = harness(deadSlots(2));
    try {
      await h.row(1);
      await h.row(2);
      await h.row(3, { floor: 3 });
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1);
      h.forwarder.pump(OWNER);
      await h.writer.submit(() => undefined);
      // Row 1 is unanswered: a later row's floor can still reach back to it, so slot 2 is still a hole for it.
      expect(h.dead()).toEqual([2]);
      expect(deadToPrune(h.db, OWNER)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("a pending ServerOrigin submit at or below the dead slot keeps it; once resolved it goes", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      await h.insertDead(2);
      await h.setMeta(1);
      h.forwarder.pump(OWNER);
      await h.writer.submit(() => undefined);
      // Slot 1's pending submit is ended from its dead row after a restart; slot 2 is above it: not needed by a row, but slot 1 is below it.
      expect(h.dead()).toEqual([1, 2]);
      await h.clearMeta(1);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1);
      expect(h.dead()).toEqual([2]);
    } finally {
      await h.close();
    }
  });

  it("bounds growth: a long run of dead rows leaves one", async () => {
    const h = harness((m) => (m.t === "cmd" ? { ok: false, reason: "too-large" } : { ok: true }));
    try {
      for (let n = 1; n <= 20; n++) await h.row(n);
      h.forwarder.pump(OWNER);
      await until(() => h.queued().length === 0 && h.dead().length === 1, { timeout: 10_000 });
      expect(h.dead()).toEqual([20]);
      expect(h.cmds()).toEqual([]);
      // Every origin still heard its refusal.
      expect(h.relayed.filter((m) => m.t === "cmd.result")).toHaveLength(20);
    } finally {
      await h.close();
    }
  });

  it("a re-send of a pruned slot is refused again, never sent", async () => {
    const h = harness(deadSlots(1));
    try {
      await h.insertDead(1);
      await h.insertDead(2);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1);
      await h.forwarder.commit(envelopeOf(1), OWNER);
      await until(() => h.relayed.some((m) => m.t === "cmd.result" && m.slot.n === 1));
      expect(h.cmds()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("another owner's dead rows and another queue's rows are not touched", async () => {
    const h = harness();
    try {
      await h.insertDead(1, "srv-c", "e".repeat(32));
      await h.insertDead(2, "srv-c", "e".repeat(32));
      await h.insertDead(1);
      await h.insertDead(2);
      await h.writer.submit((tx) => { const e = envelopeOf(1, { slot: slotOf(1, { originEpoch: "d".repeat(32) }) }); commitRow(tx, e, hashOf(e), OWNER, NOW); });
      expect(await h.writer.submit((tx) => pruneDead(tx, OWNER))).toBe(1);
      expect(h.db.prepare("SELECT owner, n FROM forwarddead ORDER BY owner, n").all().map((r) => `${r.owner}:${r.n}`)).toEqual(["srv-b:2", "srv-c:1", "srv-c:2"]);
    } finally {
      await h.close();
    }
  });

  it("an answer pumps only when a dead slot has a row above it (not for good after one dead row)", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      const before = h.lookups.session;
      await h.answer(9);
      expect(h.lookups.session).toBe(before);
      await h.insertRaw(5, JSON.stringify(envelopeOf(5)));
      await h.answer(9);
      expect(h.lookups.session).toBeGreaterThan(before);
    } finally {
      await h.close();
    }
  });
});

describe("a cancel for a dead slot does not linger (N3)", () => {
  it("commitCancel keeps no cancel for a slot in forwarddead; other slots still get theirs", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      expect(await h.writer.submit((tx) => commitCancel(tx, slotOf(1), OWNER, NOW))).toBe(false);
      expect(h.cancels()).toBe(0);
      expect(await h.writer.submit((tx) => commitCancel(tx, slotOf(2), OWNER, NOW))).toBe(true);
      expect(h.cancels()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("through the forwarder: the cancel is neither kept nor sent", async () => {
    const h = harness(deadSlots(1));
    try {
      await h.row(1);
      await h.row(2);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1 && h.cmds().length === 1);
      await h.forwarder.cancel(slotOf(1), OWNER);
      expect(h.cancels()).toBe(0);
      expect(h.sent.filter((m) => m.t === "cancel")).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("pruning a dead row also removes a cancel an older build left for it", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      await h.insertDead(2);
      await h.writer.submit((tx) => { tx.prepare("INSERT INTO fwdcancels (origin, originEpoch, target, n, owner, at) VALUES ('desktop', ?, ?, 1, ?, ?)").run(EPOCH, `bot:${BOT_B}`, OWNER, NOW); });
      expect(h.cancels()).toBe(1);
      h.forwarder.pump(OWNER);
      await until(() => h.dead().length === 1 && h.cancels() === 0);
    } finally {
      await h.close();
    }
  });
});

describe("a stored envelope that is not JSON never throws (point 3)", () => {
  it("dropOwner drops every row, the corrupt ones included, and the dead rows and cancels of that owner", async () => {
    const h = harness();
    try {
      await h.row(1);
      await h.insertRaw(2, "{not json");
      await h.insertRaw(3, "null");
      await h.row(4);
      await h.insertDead(7);
      await h.writer.submit((tx) => commitCancel(tx, slotOf(4), OWNER, NOW));
      const dropped = await h.writer.submit((tx) => dropOwner(tx, OWNER));
      expect(dropped.map((r) => [r.slot.n, r.envelope === null ? null : r.envelope.inc])).toEqual([[1, INC], [2, null], [3, null], [4, INC]]);
      expect(h.queued()).toEqual([]);
      expect(h.dead()).toEqual([]);
      expect(h.cancels()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("revoked(): every origin hears a refusal for each dropped row, a corrupt one with the unknown incarnation", async () => {
    const h = harness();
    try {
      await h.row(1);
      await h.insertRaw(2, "{not json");
      await h.row(3);
      await h.forwarder.revoked([OWNER]);
      const refusals = h.relayed.filter((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result");
      expect(refusals.map((m) => [m.slot.n, m.outcome.kind === "refused" ? m.outcome.reason : "?", m.logId])).toEqual([[1, "revoked", INC], [2, "revoked", "unknown0"], [3, "revoked", INC]]);
      expect(h.queued()).toEqual([]);
      expect(h.logs.join("\n")).not.toContain("failed");
    } finally {
      await h.close();
    }
  });

  for (const raw of ["{not json", "null", "[]", "42"]) {
    it(`commitRow over a stored row that is ${JSON.stringify(raw)} replaces it instead of throwing`, async () => {
      const h = harness();
      try {
        const e = envelopeOf(1);
        await h.writer.submit((tx) => {
          tx.prepare("INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("desktop", EPOCH, `bot:${BOT_B}`, 1, OWNER, hashOf(e), raw, NOW - 1);
        });
        expect(await h.writer.submit((tx) => commitRow(tx, e, hashOf(e), OWNER, NOW))).toBe(true);
        expect(String(h.db.prepare("SELECT envelope FROM forwardq WHERE n = 1").get()!.envelope)).toBe(JSON.stringify(e));
        // The same row again is a no-op, as before.
        expect(await h.writer.submit((tx) => commitRow(tx, e, hashOf(e), OWNER, NOW))).toBe(false);
      } finally {
        await h.close();
      }
    });
  }

  it("a corrupt row in the middle of a queue does not stop the pruning of the dead rows around it", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      await h.insertDead(2);
      await h.insertRaw(3, "{not json");
      // The corrupt row's floor is unknown: it keeps both dead rows (fail closed) until it is moved out too.
      expect(deadToPrune(h.db, OWNER)).toEqual([]);
      h.forwarder.pump(OWNER);
      await until(() => h.queued().length === 0);
      await until(() => h.dead().length === 1);
      expect(h.dead()).toEqual([3]);
    } finally {
      await h.close();
    }
  });
});
