// Botling 3 M5-04a: a server sends commands as its own origin (`ServerOrigin`, protocol v1 §11.1–§11.4, D30, D49, D58).
//
// - Unit tests (in-memory store): gapless n per (originEpoch, target), atomic commit with forwardq, floor = lowest
//   unresolved n, owning-server target throws TypeError, `slot conflict` deletes myorigins for a new epoch (D30),
//   `cmd.retry` re-commits only after the local copy of the owner's `srv:` stream reaches the retry's inc (D49).
// - Two-server tests (`startServers`, loopback only): A submits `waiting.ignore` for a bot owned by B (authorized by
//   M5-04b), applied once at B and heard by A's listener — including across SIGKILL + restart of A and across a
//   backup restore of B (`cmd.retry`). Requires `npm run build` (out/server/main.cjs).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { slotKey, type LogId, type MessageOf, type Outcome, type Slot, type WireMessage } from "../../src/protocol";
import { authorizeRoster, Botlingd, originTestHookEnabled } from "../../src/server/botlingd";
import { Directory, Forwarder, ServerOrigin, type ForwardSession } from "../../src/server/forward";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { TableFeeds } from "../../src/server/replica";
import { RosterStore } from "../../src/server/roster";
import { slotAuthorize } from "../../src/server/session";
import { openServerStore, type Db } from "../../src/server/store";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { memoryStore } from "./server-slots-harness";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, sign, strangerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const SELF = "srv-a";
const PEER = "srv-b";
const BOT_B1 = "6A0B0000-0000-4000-8000-000000000002";
const BOT_B2 = "6A0B0000-0000-4000-8000-000000000003";
const BOT_OWN = "6A0B0000-0000-4000-8000-000000000004";
const TARGET_B1 = `bot:${BOT_B1}` as const;
const TARGET_B2 = `bot:${BOT_B2}` as const;
const TARGET_OWN = `bot:${BOT_OWN}` as const;
const INC_1 = "loginc0001" as LogId;
const INC_2 = "loginc0002" as LogId;

function seedPeerStream(db: Db, owner: string, logId: LogId, bots: string[]): void {
  const stream = `srv:${owner}`;
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 1, NULL, 'live', 1) ON CONFLICT (stream) DO UPDATE SET logId = excluded.logId").run(stream, owner, logId);
  for (let i = 0; i < bots.length; i++) {
    db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = 0")
      .run(stream, `bot:${bots[i]}`, i + 1, JSON.stringify({ kind: "bot", id: bots[i] }));
  }
}

function makeInMemoryHarness(opts: { failCommit?: () => boolean; withFeeds?: boolean; isRevoked?: (owner: string) => boolean } = {}) {
  let shouldFail = false;
  const { db, writer } = memoryStore({
    beforeCommit: () => {
      if (opts.failCommit?.() || shouldFail) throw new Error("simulated commit failure");
    },
  });
  seedPeerStream(db, PEER, INC_1, [BOT_B1, BOT_B2]);
  const sent: WireMessage[] = [];
  const fakeSession: ForwardSession = {
    peer: PEER,
    state: "open",
    sendWire: (msg) => { sent.push(msg); return true; },
  };
  const directory = new Directory({
    self: SELF,
    reader: () => db,
    peers: () => [PEER],
    hasBot: (id) => id === BOT_OWN,
  });
  const forwarder = new Forwarder({
    self: SELF,
    submit: (cmd) => writer.submit(cmd),
    reader: () => db,
    directory,
    session: (peer) => (peer === PEER ? fakeSession : null),
    ...(opts.isRevoked ? { isRevoked: opts.isRevoked } : {}),
    log: () => undefined,
  });
  const feeds = opts.withFeeds ? new TableFeeds({ reader: () => db, ownStream: `srv:${SELF}`, log: () => undefined }) : null;
  const logs: string[] = [];
  const origin = new ServerOrigin({
    self: SELF,
    submit: (cmd) => writer.submit(cmd),
    reader: () => db,
    forwarder,
    ...(opts.isRevoked ? { isRevoked: opts.isRevoked } : {}),
    ...(feeds ? { subscribeTable: (stream, sink) => feeds.subscribe(stream, null, sink) } : {}),
    log: (line) => logs.push(line),
  });
  const deliverFromOwner = async (message: WireMessage) => {
    await forwarder.onMessage(fakeSession, message);
  };
  const cmdFrames = () => sent.filter((m): m is MessageOf<"cmd"> => m.t === "cmd");
  const setFailCommit = (v: boolean) => { shouldFail = v; };
  const close = async () => {
    origin.close();
    feeds?.close();
    await writer.close();
    db.close();
  };
  return { db, writer, forwarder, feeds, origin, sent, cmdFrames, fakeSession, logs, deliverFromOwner, setFailCommit, close };
}

describe("M5-04a: ServerOrigin unit tests", () => {
  it("1. two submits to the same target get n = 1, 2 in one epoch; a submit to another target starts at 1", async () => {
    const h = makeInMemoryHarness();
    try {
      const cmd1: Command = { type: "waiting.ignore", botId: BOT_B1, text: "first" };
      const cmd2: Command = { type: "waiting.ignore", botId: BOT_B1, text: "second" };
      const cmdOther: Command = { type: "waiting.ignore", botId: BOT_B2, text: "other" };

      const s1 = await h.origin.submit(TARGET_B1, cmd1);
      const s2 = await h.origin.submit(TARGET_B1, cmd2);
      const sOther = await h.origin.submit(TARGET_B2, cmdOther);

      expect(s1.origin).toBe(SELF);
      expect(s1.target).toBe(TARGET_B1);
      expect(s1.n).toBe(1);
      expect(s1.originEpoch).toMatch(/^[0-9a-f]{32}$/);
      expect(s2.originEpoch).toBe(s1.originEpoch);
      expect(s2.n).toBe(2);

      expect(sOther.target).toBe(TARGET_B2);
      expect(sOther.n).toBe(1);
      expect(sOther.originEpoch).toMatch(/^[0-9a-f]{32}$/);

      const rows = h.db.prepare("SELECT target, originEpoch, nextN FROM myorigins ORDER BY target").all() as Array<{ target: string; originEpoch: string; nextN: number }>;
      expect(rows).toEqual([
        { target: TARGET_B1, originEpoch: s1.originEpoch, nextN: 3 },
        { target: TARGET_B2, originEpoch: sOther.originEpoch, nextN: 2 },
      ]);
      expect(h.cmdFrames().map((f) => ({ slot: f.slot, scope: f.scope, inc: f.inc }))).toEqual([
        { slot: s1, scope: "reply", inc: INC_1 },
        { slot: s2, scope: "reply", inc: INC_1 },
        { slot: sOther, scope: "reply", inc: INC_1 },
      ]);
    } finally {
      await h.close();
    }
  });

  it("2. the counter and the forward row commit together: a store that fails the commit leaves nextN unchanged", async () => {
    const h = makeInMemoryHarness();
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "ok" });
      expect(s1.n).toBe(1);

      h.setFailCommit(true);
      await expect(h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "fail" })).rejects.toThrow();
      h.setFailCommit(false);

      const myorigin = h.db.prepare("SELECT originEpoch, nextN FROM myorigins WHERE target = ?").get(TARGET_B1) as { originEpoch: string; nextN: number };
      expect(myorigin.originEpoch).toBe(s1.originEpoch);
      expect(myorigin.nextN).toBe(2);
      const fqCount = (h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c;
      expect(fqCount).toBe(1);

      // Subsequent submit after failure still gets n = 2 (gapless).
      const s2 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "after-fail" });
      expect(s2.n).toBe(2);
      expect(s2.originEpoch).toBe(s1.originEpoch);
    } finally {
      await h.close();
    }
  });

  it("3. floor is the lowest unresolved n (resolve slot 1, submit 3: floor 2)", async () => {
    const h = makeInMemoryHarness();
    try {
      const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
      const off = h.origin.on((slot, outcome) => heard.push({ slot, outcome }));

      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "one" });
      const s2 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "two" });

      expect(h.origin.outcome(s1)).toBeNull();
      expect(h.cmdFrames()[0]!.floor).toBe(1);
      expect(h.cmdFrames()[1]!.floor).toBe(1);

      await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
      await until(() => heard.length === 1, { what: "listener heard slot 1" });
      expect(h.origin.outcome(s1)).toEqual({ kind: "applied" });
      expect(heard[0]).toEqual({ slot: s1, outcome: { kind: "applied" } });

      // Duplicate cmd.result does not notify twice.
      await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
      expect(heard).toHaveLength(1);

      const s3 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "three" });
      const frame3 = h.cmdFrames().find((f) => f.slot.n === 3);
      expect(frame3?.floor).toBe(2);
      expect(s3.n).toBe(3);

      off();
      await h.deliverFromOwner({ t: "cmd.result", slot: s2, outcome: { kind: "applied" }, logId: INC_1, seq: 2 });
      await until(() => h.origin.outcome(s2) !== null, { what: "outcome stored after off()" });
      expect(heard).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("4. a target this server owns throws TypeError", async () => {
    const h = makeInMemoryHarness();
    try {
      await expect(h.origin.submit(TARGET_OWN, { type: "waiting.ignore", botId: BOT_OWN, text: "own" })).rejects.toThrow(TypeError);
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM myorigins").get() as { c: number }).c).toBe(0);
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("6. slot conflict creates a new originEpoch and re-sends the item under it (§11.4)", async () => {
    const h = makeInMemoryHarness();
    try {
      const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
      h.origin.on((slot, outcome) => heard.push({ slot, outcome }));

      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "conflict" });
      expect(h.cmdFrames()).toHaveLength(1);

      await h.deliverFromOwner({
        t: "cmd.result",
        slot: s1,
        outcome: { kind: "refused", reason: "slot conflict", detail: "epoch reset" },
        logId: INC_1,
        seq: null,
      });

      await until(() => h.cmdFrames().length >= 2, { timeout: 500, what: "re-send under new originEpoch" });
      const resent = h.cmdFrames()[1]!;
      expect(resent.slot.originEpoch).not.toBe(s1.originEpoch);
      expect(resent.slot.origin).toBe(SELF);
      expect(resent.slot.target).toBe(TARGET_B1);
      expect(resent.slot.n).toBe(1);
      expect(resent.floor).toBe(1);
      expect(resent.cmd).toEqual({ type: "waiting.ignore", botId: BOT_B1, text: "conflict" });
      expect(h.logs.some((line) => line.includes("slot conflict"))).toBe(true);
      // Not resolved for the caller until the re-sent slot gets a non-conflict outcome.
      expect(heard).toEqual([]);
      expect(h.origin.outcome(s1)).toBeNull();

      const sNext = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "new-epoch" });
      expect(sNext.originEpoch).toBe(resent.slot.originEpoch);
      expect(sNext.n).toBe(2);
      expect(h.cmdFrames()[2]!.floor).toBe(1);

      await h.deliverFromOwner({ t: "cmd.result", slot: resent.slot, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
      await h.deliverFromOwner({ t: "cmd.result", slot: sNext, outcome: { kind: "applied" }, logId: INC_1, seq: 2 });
      await until(() => heard.length === 2, { timeout: 1_000, what: "re-sent and next slots applied" });
      expect(heard.map((e) => [slotKey(e.slot), e.outcome.kind])).toEqual([
        [slotKey(s1), "applied"],
        [slotKey(sNext), "applied"],
      ]);
      expect(h.origin.outcome(s1)).toEqual({ kind: "applied" });
      expect(h.origin.outcome(resent.slot)).toEqual({ kind: "applied" });
      expect(h.origin.outcome(sNext)).toEqual({ kind: "applied" });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'").get() as { c: number }).c).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("N1. a second copy of a slot conflict after the slot moved to a new epoch is dropped: the caller hears one outcome", async () => {
    const h = makeInMemoryHarness();
    try {
      const heard: Array<[string, string]> = [];
      h.origin.on((slot, outcome) => heard.push([slotKey(slot), outcome.kind === "refused" ? `refused:${outcome.reason}` : outcome.kind]));
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "dup-conflict" });
      const conflict = { t: "cmd.result" as const, slot: s1, outcome: { kind: "refused" as const, reason: "slot conflict" as const, detail: "epoch reset" }, logId: INC_1, seq: null };
      await h.deliverFromOwner(conflict);
      await until(() => h.cmdFrames().length >= 2, { timeout: 500, what: "re-send under new originEpoch" });
      const resent = h.cmdFrames()[1]!;
      await h.deliverFromOwner(conflict);
      await h.deliverFromOwner({ t: "cmd.result", slot: resent.slot, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
      await until(() => heard.length >= 1, { timeout: 1_000, what: "re-sent slot applied" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard).toEqual([[slotKey(s1), "applied"]]);
    } finally {
      await h.close();
    }
  });

  it("6b. slot conflict wave moves both refused slots into one new epoch and survives restart before final outcome", async () => {
    const h = makeInMemoryHarness();
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "wave-1" });
      const s2 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "wave-2" });

      await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "refused", reason: "slot conflict", detail: "c1" }, logId: INC_1, seq: null });
      await h.deliverFromOwner({ t: "cmd.result", slot: s2, outcome: { kind: "refused", reason: "slot conflict", detail: "c2" }, logId: INC_1, seq: null });

      await until(() => h.cmdFrames().length >= 4, { timeout: 500, what: "both conflicted slots re-sent in new epoch" });
      const moved1 = h.cmdFrames()[2]!;
      const moved2 = h.cmdFrames()[3]!;
      expect(moved1.slot.originEpoch).not.toBe(s1.originEpoch);
      expect(moved2.slot.originEpoch).toBe(moved1.slot.originEpoch);
      expect(moved1.slot.n).toBe(1);
      expect(moved2.slot.n).toBe(2);
      expect(moved2.floor).toBe(1);

      h.origin.close();
      const restarted = new ServerOrigin({
        self: SELF,
        submit: (c) => h.writer.submit(c),
        reader: () => h.db,
        forwarder: h.forwarder,
        log: () => undefined,
      });
      try {
        const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
        restarted.on((slot, outcome) => heard.push({ slot, outcome }));

        await h.deliverFromOwner({ t: "cmd.result", slot: moved1.slot, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
        await h.deliverFromOwner({ t: "cmd.result", slot: moved2.slot, outcome: { kind: "applied" }, logId: INC_1, seq: 2 });
        await until(() => heard.length === 2, { timeout: 1_000, what: "restarted origin maps outcomes back to original slots" });
        expect(heard.map((e) => [slotKey(e.slot), e.outcome.kind])).toEqual([
          [slotKey(s1), "applied"],
          [slotKey(s2), "applied"],
        ]);
        expect(restarted.outcome(s1)).toEqual({ kind: "applied" });
        expect(restarted.outcome(s2)).toEqual({ kind: "applied" });
      } finally {
        restarted.close();
      }
    } finally {
      await h.close();
    }
  });

  it("7a. cmd.retry waits until local copy of srv:<owner> is on the retry inc before re-committing (and survives restart)", async () => {
    const h = makeInMemoryHarness({ withFeeds: true });
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "retry-1" });
      const s2 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "retry-2" });
      expect(h.cmdFrames().filter((f) => f.inc === INC_1)).toHaveLength(2);

      // Owner answers cmd.retry with INC_2 while A's copy of srv:B is still on INC_1.
      await h.deliverFromOwner({ t: "cmd.retry", slot: s1, inc: INC_2 });
      await h.origin.syncTable(PEER);

      // Forwarder dropped s1 and s2; ServerOrigin must NOT re-commit while srv:B is still on INC_1.
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
      expect(h.cmdFrames().filter((f) => f.inc === INC_2)).toHaveLength(0);

      // Submitting s3 while s1 and s2 are waiting for retry still sets floor = 1.
      const s3 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "retry-3" });
      expect(h.cmdFrames().find((f) => f.slot.n === 3)?.floor).toBe(1);

      // Simulate restart of ServerOrigin on the same store before srv:B updates to INC_2.
      h.origin.close();
      const restarted = new ServerOrigin({
        self: SELF,
        submit: (cmd) => h.writer.submit(cmd),
        reader: () => h.db,
        forwarder: h.forwarder,
        subscribeTable: (stream, sink) => h.feeds!.subscribe(stream, null, sink),
        log: () => undefined,
      });
      const heardAfterRestart: Array<{ slot: Slot; outcome: Outcome }> = [];
      restarted.on((slot, outcome) => heardAfterRestart.push({ slot, outcome }));

      // Still on INC_1 -> s1 and s2 are still NOT re-committed.
      await restarted.syncTable(PEER);
      expect(h.db.prepare("SELECT n FROM forwardq ORDER BY n").all().map((r) => Number(r.n))).toEqual([3]);

      // Now local copy of srv:B moves to INC_2 and TableFeeds notifies.
      h.db.prepare("UPDATE streams SET logId = ? WHERE stream = ?").run(INC_2, `srv:${PEER}`);
      h.feeds!.notify(`srv:${PEER}`);

      await until(
        () => h.cmdFrames().filter((f) => f.inc === INC_2).length >= 2,
        { what: "s1 and s2 re-committed and pumped under INC_2" },
      );
      const retried = h.cmdFrames().filter((f) => f.inc === INC_2);
      expect(retried.map((f) => f.slot.n)).toEqual([1, 2]);
      expect(retried[0]!.floor).toBe(1);

      await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_2, seq: 1 });
      await h.deliverFromOwner({ t: "cmd.result", slot: s2, outcome: { kind: "applied" }, logId: INC_2, seq: 2 });
      await h.deliverFromOwner({ t: "cmd.result", slot: s3, outcome: { kind: "applied" }, logId: INC_2, seq: 3 });
      await until(() => heardAfterRestart.length === 3, { what: "all outcomes heard" });
      expect(heardAfterRestart.map((x) => [x.slot.n, x.outcome.kind])).toEqual([
        [1, "applied"],
        [2, "applied"],
        [3, "applied"],
      ]);
      restarted.close();
    } finally {
      await h.close();
    }
  });

  it("R1. crash between takeRetry commit and retryInc write reconciles on restart and does not strand the slot", async () => {
    const h = makeInMemoryHarness({ withFeeds: true });
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "r1" });
      h.origin.close(); // process dies right after forwarder commits takeRetry (sink detached)
      await h.deliverFromOwner({ t: "cmd.retry", slot: s1, inc: INC_2 });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);

      const restarted = new ServerOrigin({
        self: SELF,
        submit: (c) => h.writer.submit(c),
        reader: () => h.db,
        forwarder: h.forwarder,
        subscribeTable: (stream, sink) => h.feeds!.subscribe(stream, null, sink),
        log: () => undefined,
      });
      try {
        h.db.prepare("UPDATE streams SET logId = ? WHERE stream = ?").run(INC_2, `srv:${PEER}`);
        h.feeds!.notify(`srv:${PEER}`);
        await restarted.syncTable(PEER);

        await until(() => h.cmdFrames().some((f) => f.slot.n === 1 && f.inc === INC_2), { timeout: 500, what: "s1 re-sent under INC_2" });
        expect(h.cmdFrames().filter((f) => f.slot.n === 1 && f.inc === INC_2)).toHaveLength(1);
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq WHERE n = 1").get() as { c: number }).c).toBe(1);

        const s2 = await restarted.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "r2" });
        expect(s2.n).toBe(2);
        const f2 = h.cmdFrames().find((f) => f.slot.n === 2);
        expect(f2?.floor).toBe(1);

        const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
        restarted.on((slot, outcome) => heard.push({ slot, outcome }));
        await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_2, seq: 1 });
        await h.deliverFromOwner({ t: "cmd.result", slot: s2, outcome: { kind: "applied" }, logId: INC_2, seq: 2 });
        await until(() => heard.length === 2, { timeout: 1_000, what: "r1 and r2 outcomes" });
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'").get() as { c: number }).c).toBe(0);
      } finally {
        restarted.close();
      }
    } finally {
      await h.close();
    }
  });

  it("R2. crash between takeResult commit and meta delete reconciles on restart so owner replays stored outcome and clears meta", async () => {
    const h = makeInMemoryHarness();
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "r1" });
      const sentBefore = h.cmdFrames().length;
      h.origin.close();
      await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);

      const restarted = new ServerOrigin({
        self: SELF,
        submit: (c) => h.writer.submit(c),
        reader: () => h.db,
        forwarder: h.forwarder,
        log: () => undefined,
      });
      try {
        const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
        restarted.on((slot, outcome) => heard.push({ slot, outcome }));

        await until(() => h.cmdFrames().length > sentBefore, { timeout: 500, what: "orphaned slot reconciled and pumped" });
        expect(h.cmdFrames().slice(sentBefore).map((f) => f.slot)).toEqual([s1]);
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq WHERE n = 1").get() as { c: number }).c).toBe(1);

        // Owner replays the stored outcome for the already-decided slot (§11.3).
        await h.deliverFromOwner({ t: "cmd.result", slot: s1, outcome: { kind: "applied" }, logId: INC_1, seq: 1 });
        await until(() => heard.length === 1, { timeout: 1_000, what: "restarted listener hears stored outcome" });
        expect(heard[0]).toEqual({ slot: s1, outcome: { kind: "applied" } });
        expect(restarted.outcome(s1)).toEqual({ kind: "applied" });
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'").get() as { c: number }).c).toBe(0);
        expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
      } finally {
        restarted.close();
      }
    } finally {
      await h.close();
    }
  });

  it("F1-retired. cmd.retry naming a retired logId reconciles under current tableLogId instead of stranding the slot", async () => {
    const h = makeInMemoryHarness({ withFeeds: true });
    try {
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "retired-retry" });
      expect(h.cmdFrames().filter((f) => f.inc === INC_1)).toHaveLength(1);

      h.db.prepare("INSERT INTO retired (stream, logId, n, keptSeq, reason, retiredAt) VALUES (?, ?, 1, 0, 'reset', 1)").run(`srv:${PEER}`, INC_1);
      h.db.prepare("UPDATE streams SET logId = ? WHERE stream = ?").run(INC_2, `srv:${PEER}`);

      await h.deliverFromOwner({ t: "cmd.retry", slot: s1, inc: INC_1 });

      await until(() => h.cmdFrames().some((f) => f.slot.n === 1 && f.inc === INC_2), { timeout: 500, what: "retired retry re-commits under INC_2" });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq WHERE n = 1").get() as { c: number }).c).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("R3. submit to a revoked owner does not queue or send, ends with refused{revoked}, and notifies listeners", async () => {
    const h = makeInMemoryHarness({ isRevoked: () => true });
    try {
      const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
      h.origin.on((slot, outcome) => heard.push({ slot, outcome }));

      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "x" });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'").get() as { c: number }).c).toBe(0);
      expect(h.sent).toHaveLength(0);
      expect(h.origin.outcome(s1)).toEqual({
        kind: "refused",
        reason: "revoked",
        detail: "the target server was removed from the roster",
      });
      expect(heard).toEqual([
        {
          slot: s1,
          outcome: {
            kind: "refused",
            reason: "revoked",
            detail: "the target server was removed from the roster",
          },
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it("F2-revoked. revoking an owner ends both forwardq rows and pending retryInc entries with refused{revoked}", async () => {
    let revoked = false;
    const h = makeInMemoryHarness({ withFeeds: true, isRevoked: (owner) => revoked && owner === PEER });
    try {
      const heard: Array<{ slot: Slot; outcome: Outcome }> = [];
      h.origin.on((slot, outcome) => heard.push({ slot, outcome }));

      // s1 sits in forwardq; s2 receives cmd.retry so its forwardq row is gone and only meta retryInc remains.
      const s1 = await h.origin.submit(TARGET_B1, { type: "waiting.ignore", botId: BOT_B1, text: "queued" });
      const s2 = await h.origin.submit(TARGET_B2, { type: "waiting.ignore", botId: BOT_B2, text: "retrying" });
      await h.deliverFromOwner({ t: "cmd.retry", slot: s2, inc: INC_2 });
      await h.origin.syncTable(PEER);
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(1);

      revoked = true;
      await h.forwarder.revoked([PEER]);
      await h.origin.revoked([PEER]);

      await until(() => heard.length === 2, { timeout: 500, what: "both queued and retrying slots ended with refused{revoked}" });
      expect(heard.map((e) => [e.slot.target, e.outcome.kind, e.outcome.kind === "refused" ? e.outcome.reason : null]).sort())
        .toEqual([
          [TARGET_B1, "refused", "revoked"],
          [TARGET_B2, "refused", "revoked"],
        ]);
      expect(h.origin.outcome(s1)).toMatchObject({ kind: "refused", reason: "revoked" });
      expect(h.origin.outcome(s2)).toMatchObject({ kind: "refused", reason: "revoked" });
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c).toBe(0);
      expect((h.db.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'serverOrigin:%'").get() as { c: number }).c).toBe(0);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Two-server tests (`startServers`, loopback only)

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = {
  BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","),
};

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}

function submitServerOrigin(server: TestServer, id: string, target: `bot:${string}`, cmd: Command): Promise<Slot> {
  const reqDir = join(server.dataDir, "test-server-origin-requests");
  mkdirSync(reqDir, { recursive: true });
  const tmp = join(reqDir, `${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, target, cmd }));
  renameSync(tmp, join(reqDir, `${id}.json`));
  return until(() => {
    try {
      const lines = readFileSync(join(server.dataDir, "test-server-origin-submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { id: string; slot?: Slot; error?: string };
        if (entry.id !== id) continue;
        if (entry.error) throw new Error(entry.error);
        if (entry.slot) return entry.slot;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return null;
  }, { timeout: 30_000, every: 25, what: `ServerOrigin submit ${id}` });
}

function readOriginOutcomes(server: TestServer): Array<{ slot: Slot; outcome: Outcome }> {
  try {
    return readFileSync(join(server.dataDir, "test-server-origin-outcomes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { slot: Slot; outcome: Outcome });
  } catch {
    return [];
  }
}

function outcomesAt(server: TestServer, origin: string): Array<{ seq: number; kind: string; slot: Slot }> {
  return withDb(server, (db) => (db.prepare("SELECT stream, seq, kind, slot FROM entries WHERE kind IN ('cmd.applied', 'cmd.refused', 'cmd.cancelled') AND slot IS NOT NULL ORDER BY stream, seq").all() as Array<{ seq: number; kind: string; slot: string }>)
    .map((row) => ({ seq: Number(row.seq), kind: String(row.kind), slot: JSON.parse(row.slot) as Slot }))
    .filter((entry) => entry.slot.origin === origin));
}

describe("M5-04a: ServerOrigin across two real botlingd processes", () => {
  let cluster: TestCluster;
  let a: TestServer, b: TestServer;
  let ka: MemberKeysInfo, kb: MemberKeysInfo;
  let pa: FaultProxy, pb: FaultProxy;
  let botB = "";
  const srvB = () => `srv:${kb.memberId}`;

  beforeAll(async () => {
    cluster = await startServers({
      name: "server-origin",
      count: 2,
      env: {
        A: { ...TIMERS_ENV, BOTLING_SERVER_TEST_ORIGIN_HOOK: "1", BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW: "1" },
        B: TIMERS_ENV,
      },
    });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    pa = await cluster.proxy(a, "websocket", 21);
    pb = await cluster.proxy(b, "websocket", 22);
    const made = await makeCluster([ka, kb]);
    writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, pb.port)]);
    writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, pa.port)]);
    await Promise.all([a.start(), b.start()]);

    const client = await b.client("script", "a".repeat(32));
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Origin helper", job: "server origin test" }, snap.logId);
    const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
    botB = (created.outcome as { result: { botId: string } }).result.botId;
    client.close();

    await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(srvB(), `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 180_000);

  afterAll(async () => { await cluster?.cleanup(); }, 60_000);

  /** peer-answer-guard: a peer's `waiting.ignore` is applied only for a plain item on the owner's list now, so B's bot lists them. */
  const listPlainItems = (...texts: string[]) => {
    const file = join(b.dataDir, "bots", botB, ".bot", "memory.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `## Waiting on you\n${texts.map((text) => `- ${text}`).join("\n")}\n`);
  };
  const PLAIN = ["ignore-live", "ignore-restart", "ignore-retry"];

  it("5. A submits waiting.ignore to B's bot -> applied once at B, heard by A; kill and restart A between submit and result -> still applied once and heard after restart", async () => {
    const target = `bot:${botB}` as const;
    listPlainItems(...PLAIN);

    // 5a: live send and outcome
    const slot1 = await submitServerOrigin(a, "sub-1", target, { type: "waiting.ignore", botId: botB, text: "ignore-live" });
    expect(slot1.origin).toBe(ka.memberId);
    expect(slot1.n).toBe(1);

    const out1 = await until(() => readOriginOutcomes(a).find((o) => slotKey(o.slot) === slotKey(slot1)) ?? null, { timeout: 30_000, what: "A listener hears applied for slot 1" });
    expect(out1.outcome.kind).toBe("applied");
    expect(outcomesAt(b, ka.memberId).filter((e) => slotKey(e.slot) === slotKey(slot1))).toHaveLength(1);

    // 5b: kill and restart A between submit and result
    pa.partition(); pb.partition();
    await until(() => withDb(a, (db) => (db.prepare("SELECT state FROM streams WHERE stream = ?").get(srvB()) as { state: string } | undefined)?.state === "stale"), { timeout: 20_000, what: "A sees B stale" });

    const slot2 = await submitServerOrigin(a, "sub-2", target, { type: "waiting.ignore", botId: botB, text: "ignore-restart" });
    expect(slot2.originEpoch).toBe(slot1.originEpoch);
    expect(slot2.n).toBe(2);
    expect(withDb(a, (db) => !!db.prepare("SELECT 1 FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot2.origin, slot2.originEpoch, slot2.target, slot2.n))).toBe(true);
    expect(readOriginOutcomes(a).some((o) => slotKey(o.slot) === slotKey(slot2))).toBe(false);

    await a.kill();
    pa.heal(); pb.heal();
    await a.start();

    const out2 = await until(() => readOriginOutcomes(a).find((o) => slotKey(o.slot) === slotKey(slot2)) ?? null, { timeout: 30_000, what: "A listener hears applied for slot 2 after restart" });
    expect(out2.outcome.kind).toBe("applied");

    const appliedAtB = outcomesAt(b, ka.memberId).filter((e) => slotKey(e.slot) === slotKey(slot2));
    expect(appliedAtB).toHaveLength(1);
    expect(appliedAtB[0]!.kind).toBe("cmd.applied");

    await until(() => withDb(a, (db) => (db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c === 0), { timeout: 20_000, what: "A forwardq empty" });
  }, 180_000);

  it("7b. B restored between send and decision -> cmd.retry with new inc -> A re-commits only after srv:B reaches new inc, applied once", async () => {
    const target = `bot:${botB}` as const;
    const backup = b.backup();
    const oldInc = withDb(b, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB()) as { logId: string }).logId));

    pa.partition(); pb.partition();
    await until(() => withDb(a, (db) => (db.prepare("SELECT state FROM streams WHERE stream = ?").get(srvB()) as { state: string } | undefined)?.state === "stale"), { timeout: 20_000, what: "A sees B stale" });

    const slot3 = await submitServerOrigin(a, "sub-3", target, { type: "waiting.ignore", botId: botB, text: "ignore-retry" });
    expect(withDb(a, (db) => String((db.prepare("SELECT json_extract(envelope, '$.inc') AS inc FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot3.origin, slot3.originEpoch, slot3.target, slot3.n) as { inc: string }).inc))).toBe(oldInc);

    await b.restore(backup);
    const newInc = withDb(b, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB()) as { logId: string }).logId));
    expect(newInc).not.toBe(oldInc);
    // The restore may bring back an older folder: the plain item the peer's ignore names is listed again before the slot is decided.
    listPlainItems(...PLAIN);

    pa.heal(); pb.heal();

    const out3 = await until(() => readOriginOutcomes(a).find((o) => slotKey(o.slot) === slotKey(slot3)) ?? null, { timeout: 45_000, what: "A listener hears applied after B restore" });
    expect(out3.outcome.kind).toBe("applied");

    const incAtA = withDb(a, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB()) as { logId: string }).logId));
    expect(incAtA).toBe(newInc);

    const appliedAtB = outcomesAt(b, ka.memberId).filter((e) => slotKey(e.slot) === slotKey(slot3));
    expect(appliedAtB).toHaveLength(1);
    expect(appliedAtB[0]!.kind).toBe("cmd.applied");

    await until(() => withDb(a, (db) => (db.prepare("SELECT COUNT(*) AS c FROM forwardq").get() as { c: number }).c === 0), { timeout: 20_000, what: "A forwardq empty after retry" });
  }, 180_000);
});


// ---------------------------------------------------------------------------------------------
// Real RosterStore authorization (F2) & Botlingd legacy-serverId wiring (F3)

describe("M5-04a: real RosterStore authorization and legacy serverId wiring", () => {
  const root = testRoot("server-origin-wiring");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("8. real RosterStore rejects both root-revoked servers and servers in view.servers but not view.valid", async () => {
    const dirA = join(root, "roster-a");
    const dirE = join(root, "roster-e");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirE, { recursive: true });

    const storeA = await openServerStore(dirA);
    const idA = await loadOrCreateServerIdentity(dirA, { create: true });
    await storeA.submit((tx) => bindServerIdentity(tx, idA));
    const rosterA = await RosterStore.open(storeA, idA);
    try {
      const setup = new ClusterSetup(rosterA);
      const began = await setup.begin();
      expect((await setup.confirm(began.code)).ok).toBe(true);
      const ka = await readServerKeys(dirA);
      const clusterId = rosterA.clusterId!;

      const kb = await strangerKeys();
      const kc = await strangerKeys();
      const kd = await strangerKeys();

      const addB = await sign(
        { type: "add", cluster: clusterId, member: kb.memberId, kind: "server", keys: { sign: kb.sign, dh: kb.dh }, name: "B", by: ka.memberId, at: 1_700_000_000_000, joined: false },
        ka,
      );
      const addD = await sign(
        { type: "add", cluster: clusterId, member: kd.memberId, kind: "server", keys: { sign: kd.sign, dh: kd.dh }, name: "D", by: ka.memberId, at: 1_700_000_000_001, joined: false },
        ka,
      );
      // C is added by B (with joined: false). Once A revokes B, C stays in view.servers and is not in view.revoked,
      // yet C is not in view.valid because its only voucher (B) is no longer valid.
      const addC = await sign(
        { type: "add", cluster: clusterId, member: kc.memberId, kind: "server", keys: { sign: kc.sign, dh: kc.dh }, name: "C", by: kb.memberId, at: 1_700_000_000_002, joined: false },
        kb,
      );

      expect((await rosterA.mergeGossip([addB.statement, addD.statement])).refused).toEqual([]);
      await rosterA.revokeServer(kb.memberId, false, "compromised");
      expect((await rosterA.mergeGossip([addC.statement])).refused).toEqual([]);

      const viewA = rosterA.view;
      expect(viewA.servers.has(kb.memberId)).toBe(true);
      expect(viewA.revoked.has(kb.memberId)).toBe(true);
      expect(viewA.valid.has(kb.memberId)).toBe(false);

      expect(viewA.servers.has(kc.memberId)).toBe(true);
      expect(viewA.revoked.has(kc.memberId)).toBe(false);
      expect(viewA.valid.has(kc.memberId)).toBe(false);

      expect(viewA.servers.has(kd.memberId)).toBe(true);
      expect(viewA.valid.has(kd.memberId)).toBe(true);

      const authA = slotAuthorize(authorizeRoster(rosterA, { plainWaiting: () => true }));
      const cmd: Command = { type: "waiting.ignore", botId: BOT_OWN, text: "check" };
      const tx = null as never;
      const slotFor = (origin: string, n: number): Slot => ({ origin, originEpoch: "a".repeat(32), target: TARGET_OWN, n });

      expect(authA(tx, { slot: slotFor(kd.memberId, 1), cmd, scope: "reply" })).toBeNull();
      expect(authA(tx, { slot: slotFor(kb.memberId, 1), cmd, scope: "reply" })).toEqual({
        reason: "origin",
        detail: `${kb.memberId} is not a valid device of this cluster`,
      });
      expect(authA(tx, { slot: slotFor(kc.memberId, 1), cmd, scope: "reply" })).toEqual({
        reason: "origin",
        detail: `${kc.memberId} is not a valid device of this cluster`,
      });

      // Also verify an unvouched cluster member on a second real RosterStore E (in view.servers via Root + Add, not yet
      // in view.valid until E vouches for the root).
      const storeE = await openServerStore(dirE);
      const idE = await loadOrCreateServerIdentity(dirE, { create: true });
      await storeE.submit((txE) => bindServerIdentity(txE, idE));
      const made = await makeCluster([ka, kd]);
      await storeE.close();
      writeStatements(dirE, made.clusterId, made.statements);

      const storeE2 = await openServerStore(dirE);
      try {
        const rosterE = await RosterStore.open(storeE2, idE);
        const ke = await readServerKeys(dirE);
        expect(rosterE.view.servers.has(kd.memberId)).toBe(true);
        expect(rosterE.view.revoked.has(kd.memberId)).toBe(false);
        expect(rosterE.view.valid.has(kd.memberId)).toBe(false);

        const authE = slotAuthorize(authorizeRoster(rosterE, { plainWaiting: () => true }));
        expect(authE(tx, { slot: slotFor(kd.memberId, 1), cmd, scope: "reply" })).toEqual({
          reason: "origin",
          detail: `${kd.memberId} is not a valid device of this cluster`,
        });

        // Once E adds ka, ka and kd enter view.valid and are allowed.
        const vouchA = await sign(
          { type: "add", cluster: made.clusterId, member: ka.memberId, kind: "server", keys: { sign: ka.sign, dh: ka.dh }, name: "A", by: ke.memberId, at: 1_700_000_000_003, joined: false },
          ke,
        );
        expect((await rosterE.mergeGossip([vouchA.statement])).refused).toEqual([]);
        expect(rosterE.view.valid.has(kd.memberId)).toBe(true);
        expect(authE(tx, { slot: slotFor(kd.memberId, 2), cmd, scope: "reply" })).toBeNull();
      } finally {
        await storeE2.close();
      }
    } finally {
      await storeA.close();
    }
  });

  it("9. Botlingd wires ServerOrigin with roster.memberId even when a legacy data dir keeps serverId !== memberId", async () => {
    const dir = join(root, "legacy-server");
    const peerDir = join(root, "peer-verifier");
    mkdirSync(dir, { recursive: true });
    mkdirSync(peerDir, { recursive: true });

    const peer = await strangerKeys();
    const store = await openServerStore(dir);
    const identity = await loadOrCreateServerIdentity(dir, { create: true });
    await store.submit((tx) => {
      bindServerIdentity(tx, identity);
      // Simulate an M1 data folder where streams already exist and meta.serverId differs from identity.memberId.
      tx.prepare("UPDATE meta SET value = ? WHERE key = 'serverId'").run("legacy-server-id");
      seedPeerStream(tx, "legacy-server-id", "loglegac" as LogId, []);
      seedPeerStream(tx, peer.memberId, INC_1, ["6A0B0000-0000-4000-8000-000000000099"]);
    });
    const roster = await RosterStore.open(store, identity);
    const setup = new ClusterSetup(roster);
    expect((await setup.confirm((await setup.begin()).code)).ok).toBe(true);
    const selfKeys = await readServerKeys(dir);
    const addPeer = await sign(
      { type: "add", cluster: roster.clusterId!, member: peer.memberId, kind: "server", keys: { sign: peer.sign, dh: peer.dh }, name: "Peer", by: selfKeys.memberId, at: 1_700_000_000_000, joined: false },
      selfKeys,
    );
    expect((await roster.mergeGossip([addPeer.statement])).refused).toEqual([]);
    await store.close();

    const daemon = await Botlingd.start({
      env: botlingdEnv(dir, { BOTLING_SERVER_PORT: "0", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
      outDir: join(desktop, "out"),
      log: () => undefined,
    });
    try {
      expect(daemon.serverId).toBe("legacy-server-id");
      expect(daemon.roster.memberId).toBe(identity.memberId);
      expect(daemon.serverId).not.toBe(daemon.roster.memberId);

      const peerBot = "6A0B0000-0000-4000-8000-000000000099";
      const cmd: Command = { type: "waiting.ignore", botId: peerBot, text: "legacy-origin" };
      const slot = await daemon.serverOrigin!.submit(`bot:${peerBot}`, cmd);
      expect(slot.origin).toBe(daemon.roster.memberId);
      expect(slot.origin).not.toBe(daemon.serverId);

      const row = daemon.hub.reader()
        .prepare("SELECT origin FROM forwardq WHERE originEpoch = ? AND target = ? AND n = ?")
        .get(slot.originEpoch, slot.target, slot.n) as { origin: string } | undefined;
      expect(row?.origin).toBe(daemon.roster.memberId);

      // A peer that knows this server by its roster.memberId accepts slot.origin and would refuse serverId.
      const peerStore = await openServerStore(peerDir);
      try {
        const peerId = await loadOrCreateServerIdentity(peerDir, { create: true });
        await peerStore.submit((tx) => bindServerIdentity(tx, peerId));
        const peerRoster = await RosterStore.open(peerStore, peerId);
        const peerSetup = new ClusterSetup(peerRoster);
        expect((await peerSetup.confirm((await peerSetup.begin()).code)).ok).toBe(true);
        const peerKeys = await readServerKeys(peerDir);
        const addSelf = await sign(
          { type: "add", cluster: peerRoster.clusterId!, member: selfKeys.memberId, kind: "server", keys: { sign: selfKeys.sign, dh: selfKeys.dh }, name: "A", by: peerKeys.memberId, at: 1_700_000_000_000, joined: false },
          peerKeys,
        );
        expect((await peerRoster.mergeGossip([addSelf.statement])).refused).toEqual([]);

        const peerAuth = slotAuthorize(authorizeRoster(peerRoster, { plainWaiting: () => true }));
        expect(peerAuth(null as never, { slot, cmd, scope: "reply" })).toBeNull();
        expect(peerAuth(null as never, { slot: { ...slot, origin: daemon.serverId }, cmd, scope: "reply" })).toEqual({
          reason: "origin",
          detail: `${daemon.serverId} is not a valid device of this cluster`,
        });
      } finally {
        await peerStore.close();
      }
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it("10. F4 originTestHookEnabled requires BOTLING_AGENT=fake and both test hook flags", () => {
    expect(originTestHookEnabled({})).toBe(false);
    expect(originTestHookEnabled({ BOTLING_SERVER_TEST_ORIGIN_HOOK: "1" })).toBe(false);
    expect(originTestHookEnabled({ BOTLING_AGENT: "fake", BOTLING_SERVER_TEST_ORIGIN_HOOK: "1" })).toBe(false);
    expect(originTestHookEnabled({ BOTLING_AGENT: "claude", BOTLING_SERVER_TEST_ORIGIN_HOOK: "1", BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW: "1" })).toBe(false);
    expect(originTestHookEnabled({ BOTLING_AGENT: "fake", BOTLING_SERVER_TEST_ORIGIN_HOOK: "1", BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW: "1" })).toBe(true);
  });
});
