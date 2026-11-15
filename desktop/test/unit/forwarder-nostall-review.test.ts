// Review probes for forwarder-nostall (opus protocol review).
//
// R1: a ServerOrigin queue with a dead slot: once the row below the dead slot is answered, the row above it goes out
//     without any further trigger (the pending meta of the answered slot is deleted after the forwarder's own pump).
// R2: the frame actually sent (with the raised floor) is the one checked: a row whose stamped frame can never be sent
//     moves out instead of making `sendWire` fail for good and holding back every other queue of the owner.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, LogId, MessageOf, Outcome, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, ServerOrigin, type ForwardSession } from "../../src/server/forward";
import { commitRow } from "../../src/server/forward/forward-queue";
import { cmdHash } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { until } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const PEER = "srv-b";
const BOT_B1 = "6A0B0000-0000-4000-8000-000000000002";
const BOT_B2 = "6A0B0000-0000-4000-8000-000000000003";
const INC = "loginc0001" as LogId;
const EPOCH = "c".repeat(32);

function seedPeerStream(db: Db): void {
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 1, NULL, 'live', 1)").run(`srv:${PEER}`, PEER, INC);
  [BOT_B1, BOT_B2].forEach((id, i) => db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0)")
    .run(`srv:${PEER}`, `bot:${id}`, i + 1, JSON.stringify({ kind: "bot", id })));
}

function harness(encode: (m: WireMessage) => { ok: true } | { ok: false; reason: string }, sessionChecks = false) {
  const { db, writer } = memoryStore();
  seedPeerStream(db);
  const sent: WireMessage[] = [];
  const session: ForwardSession = {
    peer: PEER, state: "open",
    // Like PeerSession.send: a frame the encoder refuses is not sent (false).
    sendWire: (m) => { if (sessionChecks && !encode(m).ok) return false; sent.push(m); return true; },
  };
  const directory = new Directory({ self: SELF, reader: () => db, peers: () => [PEER], hasBot: () => false });
  const forwarder = new Forwarder({ self: SELF, submit: (c) => writer.submit(c), reader: () => db, directory, session: () => session, log: () => undefined, encode });
  const cmds = () => sent.filter((m): m is MessageOf<"cmd"> => m.t === "cmd");
  return { db, writer, forwarder, session, cmds, close: async () => { await writer.close(); db.close(); } };
}

describe("forwarder-nostall review probes", () => {
  it("R1: a ServerOrigin row above a dead slot goes out once the row below is answered, with no other trigger", async () => {
    const h = harness((m) => (m.t === "cmd" && m.slot.origin === SELF && m.slot.n === 2 ? { ok: false, reason: "too-large" } : { ok: true }));
    const origin = new ServerOrigin({ self: SELF, submit: (c) => h.writer.submit(c), reader: () => h.db, forwarder: h.forwarder });
    const heard: Array<[number, Outcome]> = [];
    origin.on((slot, outcome) => heard.push([slot.n, outcome]));
    try {
      const cmd = (text: string): Command => ({ type: "waiting.ignore", botId: BOT_B1, text });
      const s1 = await origin.submit(`bot:${BOT_B1}`, cmd("one"));
      await origin.submit(`bot:${BOT_B1}`, cmd("two"));
      await origin.submit(`bot:${BOT_B1}`, cmd("three"));
      await until(() => heard.some(([n]) => n === 2));
      expect(h.cmds().map((c) => c.slot.n)).toEqual([1]);
      await h.forwarder.onMessage(h.session, { t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC, seq: 1 } as WireMessage);
      await until(() => heard.some(([n]) => n === 1));
      await until(() => h.cmds().length === 2, { timeout: 2_000 });
      expect(h.cmds().map((c) => [c.slot.n, c.floor])).toEqual([[1, 1], [3, 3]]);
    } finally {
      origin.close();
      await h.close();
    }
  });

  it("R2: a row whose frame with the raised floor cannot be sent moves out; another queue of the owner still goes", async () => {
    // Slot 3's frame fits with its own floor (1) but not with the raised one: the encoder refuses floor > 1 for it.
    const h = harness((m) => {
      if (m.t !== "cmd") return { ok: true };
      if (m.slot.target === `bot:${BOT_B1}` && m.slot.n === 2) return { ok: false, reason: "malformed" };
      if (m.slot.target === `bot:${BOT_B1}` && m.slot.n === 3 && m.floor > 1) return { ok: false, reason: "too-large" };
      return { ok: true };
    }, true);
    try {
      const env = (n: number, target: string): CmdBody => ({ slot: { origin: "desktop", originEpoch: EPOCH, target, n } as Slot, floor: 1, inc: INC, cmd: { type: "waiting.ignore", botId: target.slice(4), text: `t${n}` }, scope: "reply" }) as CmdBody;
      const put = (e: CmdBody) => h.writer.submit((tx) => commitRow(tx, e, cmdHash({ cmd: e.cmd, scope: e.scope! }), PEER, 1));
      for (const n of [2, 3]) await put(env(n, `bot:${BOT_B1}`));
      h.forwarder.pump(PEER);
      await until(() => Number(h.db.prepare("SELECT COUNT(*) AS n FROM forwarddead").get()!.n) >= 1);
      // A command for another bot of the same owner comes in after the dead row moved out.
      await h.forwarder.commit(env(1, `bot:${BOT_B2}`), PEER);
      await until(() => h.cmds().some((c) => c.slot.target === `bot:${BOT_B2}`), { timeout: 2_000 });
      await until(() => Number(h.db.prepare("SELECT COUNT(*) AS n FROM forwarddead").get()!.n) === 2, { timeout: 2_000 });
    } finally {
      await h.close();
    }
  });

  it("R3: after a restart, a ServerOrigin submit whose row is in forwarddead ends as a refusal and is not committed again", async () => {
    const h = harness(() => ({ ok: true }));
    const slot = { origin: SELF, originEpoch: EPOCH, target: `bot:${BOT_B1}`, n: 1 } as Slot;
    const cmd: Command = { type: "waiting.ignore", botId: BOT_B1, text: "one" };
    h.db.prepare("INSERT INTO myorigins (target, originEpoch, nextN) VALUES (?, ?, 2)").run(slot.target, EPOCH);
    h.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`serverOrigin:${EPOCH}:${slot.target}:1`, JSON.stringify({ slot, owner: PEER, cmd, scope: "reply" }));
    h.db.prepare("INSERT INTO forwarddead (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt, failedAt, reason) VALUES (?, ?, ?, 1, ?, 'h', '{}', 1, 2, 'too-large')")
      .run(SELF, EPOCH, slot.target, PEER);
    const origin = new ServerOrigin({ self: SELF, submit: (c) => h.writer.submit(c), reader: () => h.db, forwarder: h.forwarder });
    const heard: Outcome[] = [];
    origin.on((_slot, outcome) => heard.push(outcome));
    try {
      await until(() => heard.length === 1);
      expect(heard[0]).toMatchObject({ kind: "refused", reason: "invalid" });
      expect(h.cmds()).toEqual([]);
      expect(Number(h.db.prepare("SELECT COUNT(*) AS n FROM forwardq").get()!.n)).toBe(0);
      expect(h.db.prepare("SELECT 1 AS x FROM meta WHERE key LIKE 'serverOrigin:%'").get()).toBeUndefined();
    } finally {
      origin.close();
      await h.close();
    }
  });
});
