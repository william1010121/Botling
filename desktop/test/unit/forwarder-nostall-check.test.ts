// Independent check of the forwarder-nostall review fix (opus).
//
// R4: a front-end row that already went to the owner (raised floor 2, one digit) must never be refused by the forwarder
//     later. After the rows between the dead slot and it are answered and the session is replaced, its floor is raised
//     to 10 (two digits): one byte more. The encoder here is a pure byte-size limit set to the frame as first sent.
// R5: the extra ServerOrigin pump (F1) sends no duplicate and keeps slot order once everything has settled.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, LogId, Message, MessageOf, Outcome, Slot, WireMessage } from "../../src/protocol";
import { Directory, Forwarder, ServerOrigin, type ForwardSession } from "../../src/server/forward";
import { commitRow } from "../../src/server/forward/forward-queue";
import { cmdHash } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { until } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const SELF = "srv-a";
const PEER = "srv-b";
const BOT_B1 = "6A0B0000-0000-4000-8000-000000000002";
const INC = "loginc0001" as LogId;
const EPOCH = "c".repeat(32);

function seedPeerStream(db: Db): void {
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 1, NULL, 'live', 1)").run(`srv:${PEER}`, PEER, INC);
  db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(`srv:${PEER}`, `bot:${BOT_B1}`, JSON.stringify({ kind: "bot", id: BOT_B1 }));
}

const bytes = (m: WireMessage) => Buffer.byteLength(JSON.stringify(m), "utf8");

describe("forwarder-nostall independent check", () => {
  it("R4: a row already sent with a raised floor is never refused later when the floor gains a digit", async () => {
    const { db, writer } = memoryStore();
    seedPeerStream(db);
    const target = `bot:${BOT_B1}`;
    const env = (n: number, text: string): CmdBody => ({ slot: { origin: "desktop", originEpoch: EPOCH, target, n } as Slot, floor: 1, inc: INC, cmd: { type: "waiting.ignore", botId: BOT_B1, text }, scope: "reply" }) as CmdBody;
    const big = env(10, "x".repeat(400));
    const limit = bytes({ t: "cmd", ...big, floor: 2 } as WireMessage);
    const encode = (m: WireMessage) => {
      if (m.t === "cmd" && m.slot.n === 1) return { ok: false as const, reason: "malformed" };
      return bytes(m) <= limit ? { ok: true as const } : { ok: false as const, reason: "too-large" };
    };
    const sent: Array<[number, WireMessage]> = [];
    let current: ForwardSession | null = null;
    const makeSession = (id: number): ForwardSession => ({
      peer: PEER, state: "open",
      sendWire: (m) => { if (!encode(m).ok) return false; sent.push([id, m]); return true; },
    });
    const directory = new Directory({ self: SELF, reader: () => db, peers: () => [PEER], hasBot: () => false });
    const forwarder = new Forwarder({ self: SELF, submit: (c) => writer.submit(c), reader: () => db, directory, session: () => current, log: () => undefined, encode });
    const relayed: Message[] = [];
    forwarder.attach("desktop", (m) => { relayed.push(m); return true; });
    const cmds = (id?: number) => sent.filter(([s, m]) => (id === undefined || s === id) && m.t === "cmd").map(([, m]) => m as MessageOf<"cmd">);
    try {
      const put = (e: CmdBody) => writer.submit((tx) => commitRow(tx, e, cmdHash({ cmd: e.cmd, scope: e.scope! }), PEER, 1));
      for (let n = 1; n <= 9; n++) await put(env(n, `t${n}`));
      await put(big);
      const s1 = makeSession(1);
      current = s1;
      forwarder.opened(s1);
      await until(() => cmds(1).some((c) => c.slot.n === 10) || Number(db.prepare("SELECT COUNT(*) AS n FROM forwarddead").get()!.n) >= 2, { timeout: 2_000 });
      const sentFirst = cmds(1).some((c) => c.slot.n === 10);
      // The owner answers 2..9; its answer for 10 (already applied) is lost with the session.
      for (let n = 2; n <= 9; n++) {
        await forwarder.onMessage(s1, { t: "cmd.result", slot: env(n, "").slot, outcome: { kind: "applied" }, logId: INC, seq: n } as WireMessage);
      }
      forwarder.closed(s1);
      const s2 = makeSession(2);
      current = s2;
      forwarder.opened(s2);
      await new Promise((r) => setTimeout(r, 200));
      const refused10 = relayed.some((m) => m.t === "cmd.result" && m.slot.n === 10 && m.outcome.kind === "refused");
      if (sentFirst) {
        // It reached the owner: the forwarder must not refuse it, and must carry it again on the new session.
        expect(refused10).toBe(false);
        expect(cmds(2).map((c) => c.slot.n)).toContain(10);
      } else {
        // Refused before it ever went: fine, as long as it is refused and never sent.
        expect(refused10).toBe(true);
        expect(cmds().map((c) => c.slot.n)).not.toContain(10);
      }
    } finally {
      await writer.close();
      db.close();
    }
  });

  it("R5: the ServerOrigin pump after a result sends no duplicate and keeps slot order", async () => {
    const { db, writer } = memoryStore();
    seedPeerStream(db);
    const sent: WireMessage[] = [];
    const session: ForwardSession = { peer: PEER, state: "open", sendWire: (m) => { sent.push(m); return true; } };
    const directory = new Directory({ self: SELF, reader: () => db, peers: () => [PEER], hasBot: () => false });
    const encode = (m: WireMessage) => (m.t === "cmd" && m.slot.n === 2 ? { ok: false as const, reason: "too-large" } : { ok: true as const });
    const forwarder = new Forwarder({ self: SELF, submit: (c) => writer.submit(c), reader: () => db, directory, session: () => session, log: () => undefined, encode });
    const origin = new ServerOrigin({ self: SELF, submit: (c) => writer.submit(c), reader: () => db, forwarder });
    const heard: Array<[number, Outcome]> = [];
    origin.on((slot, outcome) => heard.push([slot.n, outcome]));
    const cmds = () => sent.filter((m): m is MessageOf<"cmd"> => m.t === "cmd");
    try {
      const cmd = (text: string): Command => ({ type: "waiting.ignore", botId: BOT_B1, text });
      const slots: Slot[] = [];
      for (const t of ["one", "two", "three", "four", "five"]) slots.push(await origin.submit(`bot:${BOT_B1}`, cmd(t)));
      await until(() => heard.some(([n]) => n === 2));
      expect(cmds().map((c) => c.slot.n)).toEqual([1]);
      await forwarder.onMessage(session, { t: "cmd.result", slot: slots[0]!, outcome: { kind: "applied" }, logId: INC, seq: 1 } as WireMessage);
      await until(() => cmds().length === 4, { timeout: 2_000 });
      await forwarder.onMessage(session, { t: "cmd.result", slot: slots[2]!, outcome: { kind: "applied" }, logId: INC, seq: 2 } as WireMessage);
      await until(() => heard.some(([n]) => n === 3));
      await new Promise((r) => setTimeout(r, 200));
      expect(cmds().map((c) => [c.slot.n, c.floor])).toEqual([[1, 1], [3, 3], [4, 3], [5, 3]]);
      origin.close();
      await forwarder.onMessage(session, { t: "cmd.result", slot: slots[3]!, outcome: { kind: "applied" }, logId: INC, seq: 3 } as WireMessage);
      await new Promise((r) => setTimeout(r, 100));
      expect(cmds()).toHaveLength(4);
    } finally {
      origin.close();
      await writer.close();
      db.close();
    }
  });
});
