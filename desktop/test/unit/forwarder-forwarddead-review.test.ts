// Review probes for the forwarddead cleanup (fu-forwarddead): the prune decision is made again inside the writer's
// transaction (a row committed between the read and the prune keeps the dead row), and a ServerOrigin submit whose dead
// row a prune could otherwise reach still ends as `refused invalid` after a restart. In-memory server.db behind the real
// writer; no network, no windows.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, LogId, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, type ForwardSession } from "../../src/server/forward";
import { commitRow } from "../../src/server/forward/forward-queue";
import { cmdHash } from "../../src/server/slots";
import { until } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const OWNER = "srv-b";
const BOT_B = "6A0B0000-0000-4000-8000-000000000002";
const INC = "loginc0001" as LogId;
const EPOCH = "c".repeat(32);
const NOW = 1_700_000_000_000;

const slotOf = (n: number): Slot => ({ origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT_B}`, n }) as Slot;
const command = (text: string): Command => ({ type: "waiting.ignore", botId: BOT_B, text });
const envelopeOf = (n: number, over: Partial<CmdBody> = {}): CmdBody =>
  ({ slot: slotOf(n), floor: 1, inc: INC, cmd: command(`text ${n}`), scope: "reply", ...over }) as CmdBody;
const hashOf = (envelope: CmdBody) => cmdHash({ cmd: envelope.cmd, scope: envelope.scope!, basis: envelope.basis, via: envelope.via });

function harness() {
  const { db, writer } = memoryStore();
  const sent: WireMessage[] = [];
  const session: ForwardSession = { peer: OWNER, state: "open", sendWire: (message) => { sent.push(message); return true; } };
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [OWNER], hasBot: () => false });
  const forwarder = new Forwarder({
    self: SELF, submit: (c) => writer.submit(c), reader: () => db, directory,
    session: (peer) => (peer === OWNER ? session : null), log: () => {}, now: () => NOW, encode: () => ({ ok: true }),
  });
  const insertDead = (n: number) => writer.submit((tx) => {
    tx.prepare("INSERT INTO forwarddead (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt, failedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("desktop", EPOCH, `bot:${BOT_B}`, n, OWNER, "h", JSON.stringify(envelopeOf(n)), NOW - 1, NOW, "too-large");
  });
  const dead = () => db.prepare("SELECT n FROM forwarddead ORDER BY n").all().map((r) => Number(r.n));
  return { db, writer, forwarder, sent, insertDead, dead, close: async () => { await writer.close(); db.close(); } };
}

describe("forwarddead cleanup review probes", () => {
  it("P1: a row with a floor at or below the dead slot, committed between the prune's read and its commit, keeps the dead rows", async () => {
    const h = harness();
    try {
      await h.insertDead(1);
      await h.insertDead(2);
      // Queued in the writer, not committed yet: the prune's read below does not see it, the prune's transaction does.
      const pending = h.writer.submit((tx) => { const e = envelopeOf(3, { floor: 1 }); return commitRow(tx, e, hashOf(e), OWNER, NOW); });
      h.forwarder.pump(OWNER);
      await pending;
      await h.writer.idle();
      // Row 3 goes with floor 1 unless the dead slots stay to raise it: both must still be there.
      expect(h.dead()).toEqual([1, 2]);
      h.forwarder.pump(OWNER);
      await until(() => h.sent.some((m) => m.t === "cmd"));
      expect(h.sent.filter((m) => m.t === "cmd").map((m) => [(m as { slot: Slot }).slot.n, (m as { floor: number }).floor])).toEqual([[3, 3]]);
    } finally {
      await h.close();
    }
  });
});
