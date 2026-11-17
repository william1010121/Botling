// Slots and receipts (protocol v1 §11.3, D12, D49, D50): one test per branch of the owner's apply rule, plus the
// §11.5 basis checks, the apply-step seam and durability across a restart. Branch names in the test titles follow
// the §11.3 pseudocode: [inc], [floor], [dup], [conflict], [hold], [cancels], [scope], [basis], [apply], [cancel].
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmdResult, CmdRetry, type CmdBody } from "../../src/protocol";
import { openServerStore, type Db, type Writer } from "../../src/server/store";
import {
  admit, cmdHash, HELD_LIMIT, readNext, SlotEngine, SlotRefusal, type ApplyFn, type AuditEvent, type BasisReader, type SlotEngineOptions, type SlotReply,
} from "../../src/server/slots";
import { effectBasisReader } from "../../src/server/intents";
import { EPOCH_B, entries, FakeLog, memoryStore, react, slot } from "./server-slots-harness";

const dbs: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  db: Db;
  writer: Writer;
  log: FakeLog;
  engine: SlotEngine;
  applied: number[];
  audits: AuditEvent[];
  replies: SlotReply[];
  send(body: CmdBody): ReturnType<SlotEngine["receive"]>;
}

const defaultApply = (applied: number[]): ApplyFn => ({ tx, slot: s, log }) => {
  log.appendEntry(tx, s.target, "test.intent", { n: s.n }, s);
  applied.push(s.n);
  return { result: { n: s.n } };
};

function harness(over: Partial<SlotEngineOptions> & { writerOptions?: Parameters<typeof memoryStore>[0] } = {}): Harness {
  const { db, writer } = memoryStore(over.writerOptions);
  dbs.push(db);
  const log = new FakeLog();
  const applied: number[] = [];
  const audits: AuditEvent[] = [];
  const replies: SlotReply[] = [];
  const engine = new SlotEngine({ submit: (command) => writer.submit(command), log, apply: defaultApply(applied), audit: (_tx, event) => audits.push(event), ...over });
  return { db, writer, log, engine, applied, audits, replies, send: (body) => engine.receive(body, { scope: "local", reply: (m) => replies.push(m) }) };
}

const receiptCount = (db: Db) => Number(db.prepare("SELECT COUNT(*) AS c FROM receipts").get()!.c);
const nextOf = (db: Db, over = {}) => readNext(db, slot(1, over));
const outcomes = (db: Db) => entries(db).filter((e) => e.kind.startsWith("cmd."));

function expectValidReplies(replies: SlotReply[]) {
  for (const reply of replies) expect((reply.t === "cmd.result" ? CmdResult : CmdRetry).safeParse(reply).success, JSON.stringify(reply)).toBe(true);
}

describe("§11.3 apply at the owner, branch by branch", () => {
  it("[inc] i ≠ my srv: logId → cmd.retry{slot, inc}: no receipt, no outcome, next unchanged; the re-send with the new inc applies once", async () => {
    const h = harness();
    const status = await h.send(react(1, { inc: "inc-old00000" }));
    expect(status).toEqual({ status: "retry", message: { t: "cmd.retry", slot: slot(1), inc: "inc-00000001" } });
    expect(h.replies).toEqual([status.status === "retry" && status.message]);
    expect(receiptCount(h.db)).toBe(0);
    expect(entries(h.db)).toEqual([]);
    expect(nextOf(h.db)).toBe(1);
    expect(h.applied).toEqual([]);
    const again = await h.send(react(1));
    expect(again).toMatchObject({ status: "result", fresh: true, message: { outcome: { kind: "applied", result: { n: 1 } }, seq: 2 } });
    expect(h.applied).toEqual([1]);
    expectValidReplies(h.replies);
  });

  it("[inc] the inc check comes before the duplicate check: an applied slot's old copy with the old inc gets cmd.retry, not its outcome (D49)", async () => {
    const h = harness();
    await h.send(react(1));
    h.log.restore();
    const old = await h.send(react(1, { inc: "inc-00000001" }));
    expect(old.status).toBe("retry");
    const resent = await h.send(react(1, { inc: h.log.inc }));
    expect(resent).toMatchObject({ status: "result", fresh: false, message: { outcome: { kind: "applied" }, logId: "log-botb1-2" } });
    expect(h.applied).toEqual([1]);
  });

  it("[floor] f > next → cmd.skipped{origin, originEpoch, target, from: next, to: f-1}; next = f; audit; then the slot itself applies", async () => {
    const h = harness();
    await h.send(react(1));
    const status = await h.send(react(5, { floor: 4 }));
    // floor 4 skips 2…3, then n = 5 > next = 4 is held.
    expect(status).toEqual({ status: "held" });
    expect(outcomes(h.db).map((e) => [e.kind, e.body])).toEqual([
      ["cmd.applied", { slot: slot(1), result: { n: 1 } }],
      ["cmd.skipped", { origin: "desktop", originEpoch: "a".repeat(32), target: "bot:b1", from: 2, to: 3 }],
    ]);
    expect(nextOf(h.db)).toBe(4);
    expect(h.audits).toContainEqual({ kind: "skipped", slot: { origin: "desktop", originEpoch: "a".repeat(32), target: "bot:b1" }, from: 2, to: 3 });
    const four = await h.send(react(4, { floor: 4 }));
    expect(four).toMatchObject({ status: "result", fresh: true });
    expect(h.applied).toEqual([1, 4, 5]);
    expect(nextOf(h.db)).toBe(6);
  });

  it("[floor] a copy of a skipped slot gets {kind: skipped} with the cmd.skipped entry's seq, whatever its hash; a skip drops cancels in its range", async () => {
    const h = harness();
    await h.engine.cancel(slot(2));
    await h.send(react(3, { floor: 3 }));
    const skippedSeq = outcomes(h.db).find((e) => e.kind === "cmd.skipped")!.seq;
    for (const n of [1, 2]) {
      const copy = await h.send(react(n, { emoji: n === 2 ? "🎉" : "👍" }));
      expect(copy).toMatchObject({ status: "result", fresh: false, message: { outcome: { kind: "skipped" }, seq: skippedSeq } });
    }
    expect(Number(h.db.prepare("SELECT COUNT(*) AS c FROM cancels").get()!.c)).toBe(0);
    expect(h.applied).toEqual([3]);
    expectValidReplies(h.replies);
  });

  it("[dup] n < next and receipt(n).cmdHash = h → the stored outcome again; the apply step does not run again and nothing is appended", async () => {
    const h = harness();
    const first = await h.send(react(1));
    const before = entries(h.db).length;
    const dup = await h.send(react(1, { floor: 1 }));
    expect(dup).toMatchObject({ status: "result", fresh: false });
    expect(dup.status === "result" && dup.message).toEqual(first.status === "result" && first.message);
    expect(entries(h.db).length).toBe(before);
    expect(h.applied).toEqual([1]);
    expect(receiptCount(h.db)).toBe(1);
  });

  it("[dup] the hash covers cmd, scope and basis, not floor or inc", () => {
    const body = react(3);
    const base = cmdHash({ cmd: body.cmd, scope: "local" });
    expect(cmdHash({ cmd: { ...body.cmd }, scope: "local" })).toBe(base);
    expect(cmdHash({ cmd: body.cmd, scope: "reply" })).not.toBe(base);
    expect(cmdHash({ cmd: body.cmd, scope: "local", basis: { logId: "log-aaaaaaa1", seq: 3 } })).not.toBe(base);
    expect(cmdHash({ cmd: { ...body.cmd, emoji: "🎉" } as typeof body.cmd, scope: "local" })).not.toBe(base);
  });

  it("[dup] a copy with another floor is still the same command (floor is not hashed)", async () => {
    const h = harness();
    await h.send(react(1));
    await h.send(react(2, { floor: 1 }));
    const copy = await h.send(react(2, { floor: 2 }));
    expect(copy).toMatchObject({ status: "result", fresh: false, message: { outcome: { kind: "applied" } } });
  });

  it("[conflict] n < next and another hash → refused{slot conflict} with seq null; nothing stored; audit", async () => {
    const h = harness();
    await h.send(react(1));
    const before = { entries: entries(h.db).length, receipts: receiptCount(h.db) };
    const clone = await h.send(react(1, { emoji: "🎉" }));
    expect(clone).toEqual({ status: "result", fresh: false, message: { t: "cmd.result", slot: slot(1), outcome: { kind: "refused", reason: "slot conflict" }, logId: "log-botb1-1", seq: null } });
    expect({ entries: entries(h.db).length, receipts: receiptCount(h.db) }).toEqual(before);
    expect(h.audits).toContainEqual({ kind: "slot conflict", slot: slot(1) });
    // The stored outcome is untouched: the original command still gets it.
    expect(await h.send(react(1))).toMatchObject({ message: { outcome: { kind: "applied" } } });
    expectValidReplies(h.replies);
  });

  it("[hold] n > next → held in memory and nothing written; once the gap closes, held slots apply in order and each reply reaches its own sender", async () => {
    const h = harness();
    const sinks: Record<number, SlotReply[]> = { 2: [], 3: [] };
    expect(await h.engine.receive(react(3, { floor: 1 }), { scope: "local", reply: (m) => sinks[3].push(m) })).toEqual({ status: "held" });
    expect(await h.engine.receive(react(2, { floor: 1 }), { scope: "local", reply: (m) => sinks[2].push(m) })).toEqual({ status: "held" });
    expect(receiptCount(h.db)).toBe(0);
    expect(entries(h.db)).toEqual([]);
    expect(h.engine.heldCount()).toBe(2);
    await h.send(react(1));
    expect(h.applied).toEqual([1, 2, 3]);
    expect(h.engine.heldCount()).toBe(0);
    expect(sinks[2]).toMatchObject([{ t: "cmd.result", slot: slot(2), outcome: { kind: "applied", result: { n: 2 } } }]);
    expect(sinks[3]).toMatchObject([{ t: "cmd.result", slot: slot(3), outcome: { kind: "applied", result: { n: 3 } } }]);
    expect(nextOf(h.db)).toBe(4);
  });

  it(`[hold] the held buffer keeps at most ${HELD_LIMIT} slots per queue, the nearest ones; other queues have their own`, async () => {
    const h = harness();
    for (let n = 3; n < 3 + HELD_LIMIT; n++) expect(await h.send(react(n, { floor: 1 }))).toEqual({ status: "held" });
    expect(await h.send(react(3 + HELD_LIMIT, { floor: 1 }))).toEqual({ status: "dropped" });
    // A nearer slot evicts the farthest one.
    expect(await h.send(react(2, { floor: 1 }))).toEqual({ status: "held" });
    expect(h.engine.heldCount(slot(1))).toBe(HELD_LIMIT);
    expect(h.audits.filter((a) => a.kind === "held dropped").map((a) => (a as { slot: { n: number } }).slot.n)).toEqual([3 + HELD_LIMIT, 2 + HELD_LIMIT]);
    expect(await h.send(react(5, { floor: 1, over: { originEpoch: EPOCH_B } }))).toEqual({ status: "held" });
    expect(h.engine.heldCount(slot(1, { originEpoch: EPOCH_B }))).toBe(1);
    await h.send(react(1));
    expect(h.applied).toEqual(Array.from({ length: HELD_LIMIT + 1 }, (_, i) => i + 1));
    expect(nextOf(h.db)).toBe(HELD_LIMIT + 2);
  });

  it("[hold] a held copy is re-checked when it runs: a held copy that a skip passed gets the skipped outcome", async () => {
    const h = harness();
    const sink: SlotReply[] = [];
    await h.engine.receive(react(2, { floor: 1 }), { scope: "local", reply: (m) => sink.push(m) });
    await h.send(react(4, { floor: 3 })); // skips 1…2, holds 4
    expect(sink).toMatchObject([{ outcome: { kind: "skipped" } }]);
    expect(h.applied).toEqual([]);
  });

  it("[cancels] n ∈ cancels → cmd.cancelled; the apply step never runs; the cancel row is removed", async () => {
    const h = harness();
    expect(await h.engine.cancel(slot(1))).toEqual({ status: "cancelled ahead" });
    const status = await h.send(react(1));
    expect(status).toMatchObject({ status: "result", fresh: true, message: { outcome: { kind: "cancelled" } } });
    expect(outcomes(h.db).map((e) => e.kind)).toEqual(["cmd.cancelled"]);
    expect(h.applied).toEqual([]);
    expect(Number(h.db.prepare("SELECT COUNT(*) AS c FROM cancels").get()!.c)).toBe(0);
  });

  it("[cancel] cancel(n) with n < next → too late, with the stored outcome", async () => {
    const h = harness();
    const applied = await h.send(react(1));
    const late = await h.engine.cancel(slot(1));
    expect(late).toEqual({ status: "too late", message: applied.status === "result" && applied.message });
    expect(h.applied).toEqual([1]);
  });

  it("[cancel] cancel(n) with n ≥ next is committed: a later engine (after a restart) still cancels the slot", async () => {
    const h = harness();
    await h.engine.cancel(slot(2));
    const restarted = new SlotEngine({ submit: (c) => h.writer.submit(c), log: h.log, apply: defaultApply(h.applied) });
    await restarted.receive(react(1), { scope: "local" });
    expect(await restarted.receive(react(2), { scope: "local" })).toMatchObject({ message: { outcome: { kind: "cancelled" } } });
  });

  it("[scope] origin invalid or scope forbids → cmd.refused{scope | origin}, stored and re-sent for duplicates", async () => {
    const h = harness();
    const refusedScope = await h.engine.receive(react(1), { scope: "read" });
    expect(refusedScope).toMatchObject({ status: "result", fresh: true, message: { outcome: { kind: "refused", reason: "scope" } } });
    const origins = harness({ authorize: (_tx, { slot: s }) => (s.origin === "revoked" ? { reason: "origin", detail: "revoked device" } : null) });
    const refusedOrigin = await origins.send(react(1, { over: { origin: "revoked" } }));
    expect(refusedOrigin).toMatchObject({ message: { outcome: { kind: "refused", reason: "origin", detail: "revoked device" } } });
    expect(await origins.send(react(1, { over: { origin: "revoked" } }))).toMatchObject({ fresh: false, message: { outcome: { reason: "origin" } } });
    expect(origins.applied).toEqual([]);
    expect(outcomes(origins.db).map((e) => [e.kind, e.body.reason])).toEqual([["cmd.refused", "origin"]]);
  });

  it("[basis] a command for another bot than its target → refused{invalid}", async () => {
    const h = harness();
    const body = react(1);
    const status = await h.send({ ...body, cmd: { ...body.cmd, botId: "other" } as CmdBody["cmd"] });
    expect(status).toMatchObject({ message: { outcome: { kind: "refused", reason: "invalid" } } });
    expect(h.applied).toEqual([]);
  });

  describe("[basis] §11.5 commands name what the user saw", () => {
    const reader = (state: { turn?: string; card?: { open: boolean; rev: number } | null }): BasisReader => ({
      turnRunning: (_tx, _bot, turnId) => state.turn === turnId,
      card: () => state.card ?? null,
    });
    const stop = (n: number, turnId: string): CmdBody => ({ slot: slot(n), floor: n, inc: "inc-00000001", cmd: { type: "turn.stop", botId: "b1", turnId } } as CmdBody);
    const choose = (n: number, basis?: { logId: string; seq: number }): CmdBody =>
      ({ slot: slot(n), floor: n, inc: "inc-00000001", cmd: { type: "chat.choose", botId: "b1", messageId: "q1", index: 0 }, ...(basis ? { basis } : {}) } as CmdBody);

    it("turn.stop{turnId} of an ended turn → refused{changed}; a later turn is not stopped", async () => {
      const state = { turn: "t2" };
      const h = harness({ basis: reader(state) });
      expect(await h.send(stop(1, "t1"))).toMatchObject({ message: { outcome: { kind: "refused", reason: "changed", detail: "turn t1 already ended" } } });
      expect(await h.send(stop(2, "t2"))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      expect(h.applied).toEqual([2]);
    });

    it("card answer to a closed or missing card → refused{changed}; to a newer revision than its basis → refused{changed}; an open card → applied", async () => {
      const state: { card: { open: boolean; rev: number } | null } = { card: null };
      const h = harness({ basis: reader(state) });
      expect(await h.send(choose(1))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      state.card = { open: false, rev: 3 };
      expect(await h.send(choose(2))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      state.card = { open: true, rev: 7 };
      expect(await h.send(choose(3, { logId: "log-botb1-1", seq: 6 }))).toMatchObject({ message: { outcome: { reason: "changed", detail: "card q1 has a newer revision" } } });
      expect(await h.send(choose(4, { logId: "log-botb1-1", seq: 7 }))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      expect(await h.send(choose(5))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      expect(h.applied).toEqual([4, 5]);
    });

    it("the default reader reads bots.liveTurnId and cards (state 'open', rev)", async () => {
      const h = harness();
      h.db.exec("INSERT INTO bots (botId, liveTurnId) VALUES ('b1', 't9')");
      h.db.exec("INSERT INTO cards (botId, cardId, rev, state, body) VALUES ('b1', 'q1', 4, 'open', '{}')");
      expect(await h.send(stop(1, "t8"))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      expect(await h.send(stop(2, "t9"))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      expect(await h.send(choose(3, { logId: "log-botb1-1", seq: 4 }))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      h.db.exec("UPDATE cards SET state = 'closed'");
      expect(await h.send(choose(4))).toMatchObject({ message: { outcome: { reason: "changed" } } });
    });

    // A component card (`<show name=… command=…>`) is a plain line, not a `cards` row (only buttons, questions and approvals are);
    // its "Allow and run" sends component.approve with the line's id, which used to be refused as "card … is closed" (eeg, 2026-11-18).
    describe("component.approve on a component card (a line with no `cards` row)", () => {
      const approve = (n: number, messageId: string, basis?: { logId: string; seq: number }): CmdBody =>
        ({ slot: slot(n), floor: n, inc: "inc-00000001", cmd: { type: "component.approve", botId: "b1", messageId, index: 0, command: "python3 s.py", folder: "/p" }, ...(basis ? { basis } : {}) } as CmdBody);
      const line = (h: Harness, id: string) => h.db.exec(`INSERT INTO messages (botId, msgId, rev, seq, body) VALUES ('b1', '${id}', 1, 1, '{}')`);

      it("a line that exists (no card row) is approved; with a basis too, since there is no revision to compare", async () => {
        const h = harness();
        line(h, "c1");
        expect(await h.send(approve(1, "c1"))).toMatchObject({ message: { outcome: { kind: "applied" } } });
        expect(await h.send(approve(2, "c1", { logId: "log-botb1-1", seq: 3 }))).toMatchObject({ message: { outcome: { kind: "applied" } } });
        expect(h.applied).toEqual([1, 2]);
      });

      it("a card a worker drew (`<line id>:card-<n>`) is approved through its line", async () => {
        const h = harness();
        line(h, "c1");
        expect(await h.send(approve(1, "c1:card-0"))).toMatchObject({ message: { outcome: { kind: "applied" } } });
        expect(await h.send(approve(2, "c9:card-0"))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      });

      it("a line that does not exist is still refused{changed}; so is one whose card row is closed or newer than the basis", async () => {
        const h = harness();
        expect(await h.send(approve(1, "gone"))).toMatchObject({ message: { outcome: { reason: "changed", detail: "card gone is closed" } } });
        line(h, "q1");
        h.db.exec("INSERT INTO cards (botId, cardId, rev, state, body) VALUES ('b1', 'q1', 7, 'closed', '{}')");
        expect(await h.send(approve(2, "q1"))).toMatchObject({ message: { outcome: { reason: "changed" } } });
        h.db.exec("UPDATE cards SET state = 'open'");
        expect(await h.send(approve(3, "q1", { logId: "log-botb1-1", seq: 6 }))).toMatchObject({ message: { outcome: { reason: "changed", detail: "card q1 has a newer revision" } } });
        expect(await h.send(approve(4, "q1", { logId: "log-botb1-1", seq: 7 }))).toMatchObject({ message: { outcome: { kind: "applied" } } });
      });

      it("only component.approve gets this: an answer (chat.choose) to a line with no card row is still refused", async () => {
        const h = harness();
        line(h, "q1");
        expect(await h.send(choose(1))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      });

      it("the reader the server runs with (effectBasisReader) tells a line too, not only the default one", async () => {
        const h = harness({ basis: effectBasisReader });
        line(h, "c1");
        expect(await h.send(approve(1, "c1"))).toMatchObject({ message: { outcome: { kind: "applied" } } });
        expect(await h.send(approve(2, "nope:card-1"))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      });

      it("a reader that cannot tell whether the line exists refuses (fail closed)", async () => {
        const h = harness({ basis: reader({ card: null }) });
        expect(await h.send(approve(1, "c1"))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      });
    });

    it("any other command with a basis of a retired logId → refused{changed}; the current logId → applied", async () => {
      const h = harness();
      expect(await h.send(react(1, { basis: { logId: "log-botb1-0", seq: 1 } }))).toMatchObject({ message: { outcome: { reason: "changed" } } });
      expect(await h.send(react(2, { basis: { logId: "log-botb1-1", seq: 1 } }))).toMatchObject({ message: { outcome: { kind: "applied" } } });
    });
  });

  it("[apply] else → the apply step's intent entries + cmd.applied{slot, result}, receipt(n, h, outcome) and next++ in one transaction", async () => {
    const batches: number[] = [];
    const h = harness({ writerOptions: { onBatch: (info) => batches.push(info.size) } });
    const status = await h.send(react(1));
    expect(batches).toEqual([1]);
    expect(entries(h.db).map((e) => [e.seq, e.kind, e.slot?.n])).toEqual([[1, "test.intent", 1], [2, "cmd.applied", 1]]);
    expect(status).toEqual({ status: "result", fresh: true, message: { t: "cmd.result", slot: slot(1), outcome: { kind: "applied", result: { n: 1 } }, logId: "log-botb1-1", seq: 2 } });
    const row = h.db.prepare("SELECT cmdHash, outcome, seq FROM receipts").get()!;
    expect(row).toEqual({ cmdHash: cmdHash({ cmd: react(1).cmd, scope: "local" }), outcome: JSON.stringify({ kind: "applied", result: { n: 1 } }), seq: 2 });
    expect(nextOf(h.db)).toBe(2);
  });

  it("[apply] SlotRefusal from the apply step → cmd.refused{reason, detail}; the step's own writes are rolled back", async () => {
    const h = harness({ apply: ({ tx, slot: s, log }) => { log.appendEntry(tx, s.target, "test.intent", {}); throw new SlotRefusal("invalid", "no such message"); } });
    const status = await h.send(react(1));
    expect(status).toMatchObject({ fresh: true, message: { outcome: { kind: "refused", reason: "invalid", detail: "no such message" }, seq: 1 } });
    expect(entries(h.db).map((e) => e.kind)).toEqual(["cmd.refused"]);
  });

  it("[apply] any other error fails the command: nothing stored, next unchanged, and the re-send applies once", async () => {
    let fail = true;
    const applied: number[] = [];
    const h = harness({ apply: (ctx) => { if (fail) { ctx.log.appendEntry(ctx.tx, ctx.slot.target, "test.intent", {}); throw new Error("disk full"); } return defaultApply(applied)(ctx); } });
    await expect(h.send(react(1))).rejects.toThrow("disk full");
    expect({ receipts: receiptCount(h.db), entries: entries(h.db).length, next: nextOf(h.db) }).toEqual({ receipts: 0, entries: 0, next: 1 });
    fail = false;
    expect(await h.send(react(1))).toMatchObject({ fresh: true, message: { outcome: { kind: "applied" } } });
    expect(applied).toEqual([1]);
  });

  it("[apply] an apply step that returns a promise fails the command (commands are synchronous)", async () => {
    const h = harness({ apply: (async () => ({ result: 1 })) as unknown as ApplyFn });
    await expect(h.send(react(1))).rejects.toThrow("synchronous");
    expect(receiptCount(h.db)).toBe(0);
  });

  it("[apply] a failed COMMIT keeps nothing of the slot; the re-send applies it once", async () => {
    let failNext = true;
    const h = harness({ writerOptions: { beforeCommit: () => { if (failNext) { failNext = false; throw new Error("I/O error"); } } } });
    await expect(h.send(react(1))).rejects.toThrow("commit failed");
    expect({ receipts: receiptCount(h.db), entries: entries(h.db).length, next: nextOf(h.db) }).toEqual({ receipts: 0, entries: 0, next: 1 });
    expect(await h.send(react(1))).toMatchObject({ fresh: true });
    // The apply step ran twice, but the first run's writes went with the failed commit: one applied slot in the store.
    expect(h.applied).toEqual([1, 1]);
    expect(outcomes(h.db).map((e) => e.kind)).toEqual(["cmd.applied"]);
    expect(entries(h.db).filter((e) => e.kind === "test.intent")).toHaveLength(1);
  });

  it("copies of one batch: slot 2 then slot 1 in the same transaction both apply, in order", async () => {
    const batches: number[] = [];
    const h = harness({ writerOptions: { onBatch: (info) => batches.push(info.size) } });
    const [two, one] = await Promise.all([h.send(react(2, { floor: 1 })), h.send(react(1))]);
    expect(two).toEqual({ status: "held" });
    expect(one).toMatchObject({ fresh: true });
    expect(batches[0]).toBe(2);
    expect(h.applied).toEqual([1, 2]);
  });

  it("admit() answers read-only (the seam a legacy-apply path asks before it runs the core handler)", async () => {
    const h = harness();
    const input = (n: number, extra: Partial<Parameters<typeof admit>[2]> = {}) => {
      const body = react(n, { floor: 1 });
      return { slot: body.slot, floor: body.floor, inc: body.inc, cmd: body.cmd, scope: "local" as const, hash: cmdHash({ cmd: body.cmd, scope: "local" }), ...extra };
    };
    await h.send(react(1));
    const ask = (i: ReturnType<typeof input>) => h.writer.submit((tx) => admit(tx, h.log, i));
    expect(await ask(input(1, { floor: 1 }))).toMatchObject({ kind: "duplicate", outcome: { kind: "applied" } });
    expect(await ask(input(1, { hash: "0".repeat(64) }))).toMatchObject({ kind: "conflict" });
    expect(await ask(input(2))).toEqual({ kind: "ready", cancelled: false, skip: null });
    expect(await ask(input(3))).toEqual({ kind: "hold", skip: null });
    expect(await ask(input(4, { floor: 4 }))).toEqual({ kind: "ready", cancelled: false, skip: { from: 2, to: 3 } });
    expect(await ask(input(2, { inc: "inc-other0000" }))).toEqual({ kind: "retry", inc: "inc-00000001" });
    expect(receiptCount(h.db)).toBe(1);
    expect(nextOf(h.db)).toBe(2);
  });

  it("refuses a command with no stated scope", async () => {
    const h = harness();
    await expect(h.engine.receive(react(1), {} as never)).rejects.toThrow("scope");
    await expect(h.engine.receive({ ...react(1), scope: "local" }, {} as never)).rejects.toThrow("scope"); // the frame's own scope is not the caller's
    expect(receiptCount(h.db)).toBe(0);
  });
});

describe("durability: receipts and next come back from server.db after a restart (§11.3)", () => {
  it("a new engine on the reopened file re-sends the stored outcome, keeps next and applies nothing twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-slots-"));
    dirs.push(dir);
    const log = new FakeLog();
    const applied: number[] = [];
    let store = await openServerStore(dir);
    let engine = new SlotEngine({ submit: (c) => store.submit(c), log, apply: defaultApply(applied) });
    const first = await engine.receive(react(1), { scope: "local" });
    await engine.receive(react(2), { scope: "local" });
    await engine.receive(react(4, { floor: 3 }), { scope: "local" }); // held only in memory
    await store.close();

    store = await openServerStore(dir);
    engine = new SlotEngine({ submit: (c) => store.submit(c), log, apply: defaultApply(applied) });
    expect(engine.heldCount()).toBe(0);
    const dup = await engine.receive(react(1), { scope: "local" });
    expect(dup.status === "result" && dup.message).toEqual(first.status === "result" && first.message);
    expect(await engine.receive(react(4, { floor: 3 }), { scope: "local" })).toEqual({ status: "held" });
    expect(await engine.receive(react(3), { scope: "local" })).toMatchObject({ fresh: true });
    expect(applied).toEqual([1, 2, 3, 4]);
    const reader = store.openReader();
    expect(readNext(reader, slot(1))).toBe(5);
    reader.close();
    await store.close();
  });
});
