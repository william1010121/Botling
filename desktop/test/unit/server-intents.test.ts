// M1 step 6: the core set's intent handlers, the effect outbox, recovery, legacy apply, the event tap and oversized
// entries, over the real server.db (in memory), the real log and slot engine, and a fake engine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "../../src/contract";
import { ENTRY_BYTES_LIMIT, readSnap } from "../../src/server/log";
import { cutNote, effectCheckpointSink, fitBody, readFullText } from "../../src/server/effects";
import { COMMAND_ROUTES, legacyTable } from "../../src/server/intents";
import type { StreamId } from "../../src/protocol";
import { cursorAt, effectRows, entriesOf, harness, kinds, outcomeOf, type Harness } from "./server-intents-harness";

let open: Harness[] = [];
async function start(...args: Parameters<typeof harness>): Promise<Harness> {
  const h = await harness(...args);
  open.push(h);
  return h;
}
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

const B1 = "bot:B1";

describe("chat.send: intent, effect row, turn", () => {
  it("commits the user line, turn.queued and the row first; the worker starts the turn once", async () => {
    const h = await start();
    const status = await h.send({ type: "chat.send", botId: "B1", text: "  hi there " });
    const outcome = outcomeOf(status);
    expect(outcome.kind).toBe("applied");
    const result = outcome.result as { messageId: string; turnId: string };
    expect(result.turnId).toMatch(/^t-/);
    const first = entriesOf(h.db, B1);
    expect(first.slice(0, 3).map((entry) => entry.kind)).toEqual(["message.added", "turn.queued", "cmd.applied"]);
    expect((first[0].body.message as { text: string }).text).toBe("hi there");
    expect(first[1].body).toMatchObject({ turnId: result.turnId, messageId: result.messageId });

    await h.settle();
    expect(h.engine.spawns).toEqual([result.turnId]);
    expect(h.engine.starts[0]).toMatchObject({ botId: "B1", turnId: result.turnId, replyId: result.messageId, send: { text: "  hi there " } });
    const all = kinds(h.db, B1);
    expect(all).toContain("turn.started");
    expect(all.filter((kind) => kind === "turn.finished")).toHaveLength(1);
    expect(all).not.toContain("turn.delta");
    const finished = entriesOf(h.db, B1).find((entry) => entry.kind === "turn.finished")!;
    expect(finished.body).toMatchObject({ turnId: result.turnId, status: "done", text: "Hello, world." });
    expect(effectRows(h.db)).toEqual([expect.objectContaining({ turnId: result.turnId, state: "finished", kind: "turn" })]);
    expect(h.db.prepare("SELECT liveTurnId FROM bots WHERE botId = 'B1'").get()!.liveTurnId).toBeNull();
  });

  it("a re-sent copy gets the stored outcome and starts nothing again", async () => {
    const h = await start();
    const first = await h.send({ type: "chat.send", botId: "B1", text: "once" }, { n: 1 });
    const again = await h.send({ type: "chat.send", botId: "B1", text: "once" }, { n: 1 });
    expect(again.status === "result" && again.fresh).toBe(false);
    expect(outcomeOf(again)).toEqual(outcomeOf(first));
    await h.settle();
    expect(h.engine.spawns).toHaveLength(1);
    expect(effectRows(h.db)).toHaveLength(1);
  });

  it("the core's own copy of the user line is stored only as an update when it differs", async () => {
    const h = await start();
    await h.send({ type: "chat.send", botId: "B1", text: "line" });
    await h.settle();
    const all = kinds(h.db, B1);
    expect(all.filter((kind) => kind === "message.added")).toHaveLength(1);
    expect(all.filter((kind) => kind === "message.updated").length).toBeLessThanOrEqual(1);
  });

  it("refuses an unknown bot and an empty message, storing the refusal", async () => {
    const h = await start();
    expect(outcomeOf(await h.send({ type: "chat.send", botId: "NOPE", text: "x" }))).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "   " }))).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(effectRows(h.db)).toHaveLength(0);
  });

  it("a turn the engine refused ends with turn.finished{failed}", async () => {
    const h = await start();
    h.engine.failNext = new Error("no head");
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x" })).result as { turnId: string };
    await h.settle();
    const finished = entriesOf(h.db, B1).filter((entry) => entry.kind === "turn.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0].body).toMatchObject({ turnId, status: "failed", error: "no head" });
    expect(effectRows(h.db)[0].state).toBe("finished");
  });

  it("a turn another turn read in ends when that turn ends", async () => {
    const h = await start({ hold: true });
    const running = h.engine.coreTurn("B1");
    h.engine.absorbInto = running.turnId;
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "steer" })).result as { turnId: string };
    await h.runtime.idle();
    await h.runtime.scope.submit(() => undefined);
    expect(effectRows(h.db).find((row) => row.turnId === turnId)!.state).toBe("started");
    h.engine.finish(running.turnId!, "done");
    await h.settle();
    const finished = entriesOf(h.db, B1).filter((entry) => entry.kind === "turn.finished").map((entry) => entry.body.turnId);
    expect(finished).toEqual([running.turnId, turnId]);
    expect(effectRows(h.db).every((row) => row.state === "finished")).toBe(true);
  });
});

describe("turn.stop", () => {
  it("stops the running turn", async () => {
    const h = await start({ hold: true });
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x" })).result as { turnId: string };
    await h.runtime.idle();
    const stopped = outcomeOf(await h.send({ type: "turn.stop", botId: "B1", turnId }));
    expect(stopped).toMatchObject({ kind: "applied", result: { stopped: true } });
    await h.settle();
    expect(h.engine.stops).toEqual([turnId]);
    expect(entriesOf(h.db, B1).find((entry) => entry.kind === "turn.finished")!.body).toMatchObject({ turnId, status: "stopped" });
  });

  it("refuses an old turnId with `changed` and never stops the newer turn", async () => {
    const h = await start({ chunks: ["a"] });
    const old = (outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "1" })).result as { turnId: string }).turnId;
    await h.settle();
    const h2 = await h.restart({ hold: true });
    open.push(h2);
    const newer = (outcomeOf(await h2.send({ type: "chat.send", botId: "B1", text: "2" })).result as { turnId: string }).turnId;
    await h2.runtime.idle();
    const refused = outcomeOf(await h2.send({ type: "turn.stop", botId: "B1", turnId: old }));
    expect(refused).toMatchObject({ kind: "refused", reason: "changed" });
    expect(outcomeOf(await h2.send({ type: "turn.stop", botId: "B1", turnId: "t-unknown" }))).toMatchObject({ kind: "refused", reason: "changed" });
    expect(h2.engine.stops).toEqual([]);
    expect(effectRows(h2.db).find((row) => row.turnId === newer)!.state).toBe("started");
  });

  it("cancels a turn still queued: turn.cancelled, the engine never starts it", async () => {
    const h = await start();
    h.runtime.worker.close();
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x" })).result as { turnId: string };
    expect(effectRows(h.db)[0].state).toBe("queued");
    expect(outcomeOf(await h.send({ type: "turn.stop", botId: "B1", turnId }))).toMatchObject({ kind: "applied" });
    expect(effectRows(h.db)[0].state).toBe("cancelled");
    expect(kinds(h.db, B1)).toContain("turn.cancelled");
    expect(h.engine.discarded).toEqual([turnId]);
    // A restart does not start it either.
    const h2 = await h.restart();
    open.push(h2);
    await h2.settle();
    expect(h2.engine.spawns).toEqual([]);
  });
});

describe("cards: chat.choose / chat.answer / chat.ignoreQuestion", () => {
  it("cards.rev is the seq of the entry that last changed the card; cardId is the line id", async () => {
    const h = await start();
    const card = h.engine.addCard("B1");
    await h.runtime.scope.submit(() => undefined);
    const added = entriesOf(h.db, B1).find((entry) => entry.kind === "message.added")!;
    expect(h.db.prepare("SELECT cardId, rev, state FROM cards WHERE botId = 'B1'").get()).toEqual({ cardId: card.id, rev: added.seq, state: "open" });
    await h.send({ type: "chat.react", botId: "B1", messageId: card.id, emoji: "👍", present: true });
    const updated = entriesOf(h.db, B1).filter((entry) => entry.kind === "message.updated").at(-1)!;
    expect(Number(h.db.prepare("SELECT rev FROM cards WHERE botId = 'B1'").get()!.rev)).toBe(updated.seq);
    const snap = readSnap(h.db, B1 as StreamId)!;
    expect((snap.frame.view as { cards: Array<{ cardId: string }> }).cards.map((c) => c.cardId)).toEqual([card.id]);
  });

  it("an answer applies in the command's transaction; its turn is queued there and released after the commit", async () => {
    const h = await start();
    const card = h.engine.addCard("B1");
    await h.runtime.scope.submit(() => undefined);
    const before = cursorAt(h.db, B1);
    const outcome = outcomeOf(await h.send({ type: "chat.choose", botId: "B1", messageId: card.id, index: 1 }, { basis: before }));
    expect(outcome).toMatchObject({ kind: "applied", result: { accepted: true } });
    const after = entriesOf(h.db, B1).filter((entry) => entry.seq > before.seq).map((entry) => entry.kind);
    expect(after.slice(0, 4)).toEqual(["message.updated", "message.added", "turn.queued", "cmd.applied"]);
    expect(h.db.prepare("SELECT state FROM cards WHERE cardId = ?").get(card.id)!.state).toBe("closed");
    await h.settle();
    expect(h.engine.spawns).toHaveLength(1);
    expect(h.engine.starts).toHaveLength(0); // released, not started again from the row
    expect(effectRows(h.db)).toEqual([expect.objectContaining({ state: "finished", payload: expect.objectContaining({ origin: "command", words: "B" }) })]);
  });

  it("refuses a closed card and a card changed after the basis with `changed`", async () => {
    const h = await start();
    const card = h.engine.addCard("B1");
    await h.runtime.scope.submit(() => undefined);
    const stale = cursorAt(h.db, B1);
    await h.send({ type: "chat.react", botId: "B1", messageId: card.id, emoji: "👀", present: true });
    expect(outcomeOf(await h.send({ type: "chat.choose", botId: "B1", messageId: card.id, index: 0 }, { basis: stale }))).toMatchObject({ kind: "refused", reason: "changed" });
    expect(outcomeOf(await h.send({ type: "chat.ignoreQuestion", botId: "B1", messageId: card.id }))).toMatchObject({ kind: "applied" });
    expect(outcomeOf(await h.send({ type: "chat.answer", botId: "B1", messageId: card.id, text: "late" }))).toMatchObject({ kind: "refused", reason: "changed" });
    expect(h.engine.spawns).toHaveLength(0);
  });

  it("an engine refusal of an in-transaction command is stored as `invalid` with nothing else", async () => {
    const h = await start();
    const status = await h.send({ type: "chat.react", botId: "B1", messageId: "NO-SUCH", emoji: "👍", present: true });
    expect(outcomeOf(status)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(kinds(h.db, B1)).toEqual(["cmd.refused"]);
  });
});

describe("bots and settings", () => {
  it("bots.create applies now; the new bot gets its stream from its first event", async () => {
    const h = await start();
    const outcome = outcomeOf(await h.send({ type: "bots.create", name: "Helper", job: "help" }));
    expect(outcome).toMatchObject({ kind: "applied", result: { botId: "HELPER", created: true } });
    expect(kinds(h.db, "bot:HELPER")).toEqual(["message.added"]);
    expect(kinds(h.db, h.serverStream)).toContain("cmd.applied");
  });

  it("settings.set applies now", async () => {
    const h = await start();
    expect(outcomeOf(await h.send({ type: "settings.set", change: { key: "language", value: "en" } } as never))).toMatchObject({ kind: "applied", result: { changed: "language" } });
  });

  it("bots.remove: refusals first; then a remove row the worker runs after the commit", async () => {
    const h = await start();
    expect(outcomeOf(await h.send({ type: "bots.remove", botId: "MAIN" }))).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(outcomeOf(await h.send({ type: "bots.remove", botId: "B1" }))).toMatchObject({ kind: "applied", result: { removed: true } });
    await h.settle();
    expect(h.engine.removed).toEqual(["B1"]);
    expect(kinds(h.db, B1)).toContain("bot.removed");
    expect(effectRows(h.db)).toEqual([expect.objectContaining({ kind: "remove", state: "finished" })]);
    expect(h.db.prepare("SELECT 1 FROM bots WHERE botId = 'B1'").get()).toBeUndefined();
  });
});

describe("routines and the core's own turns", () => {
  it("a routine's run is recorded (turn.queued + row) before it starts, and starts once", async () => {
    const h = await start();
    const turnId = h.engine.routine("B1");
    expect(h.engine.spawns).toEqual([]);
    await h.settle();
    expect(h.engine.spawns).toEqual([turnId]);
    expect(kinds(h.db, B1).slice(0, 2)).toEqual(["turn.queued", "turn.started"]);
    expect(effectRows(h.db)).toEqual([expect.objectContaining({ turnId, state: "finished", payload: expect.objectContaining({ origin: "routine" }) })]);
  });

  it("a turn the core begins by itself gets a started row with its turn.started", async () => {
    const h = await start({ hold: true });
    const running = h.engine.coreTurn("B1");
    await h.runtime.scope.submit(() => undefined);
    expect(effectRows(h.db)).toEqual([expect.objectContaining({ turnId: running.turnId, state: "started", payload: expect.objectContaining({ origin: "core" }) })]);
    expect(h.db.prepare("SELECT liveTurnId FROM bots WHERE botId = 'B1'").get()!.liveTurnId).toBe(running.turnId);
  });
});

describe("recovery at start", () => {
  it("a started turn becomes exactly one turn.interrupted with the checkpoint text, and is never started again", async () => {
    const h = await start({ hold: true, chunks: ["partial ", "text"] });
    const { turnId, messageId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x" })).result as { turnId: string; messageId: string };
    await h.runtime.idle();
    await h.runtime.scope.submit(() => undefined);
    await effectCheckpointSink(h.writer).write({ botId: "B1", turnId, text: "partial ", at: 1 });
    // The crash: nothing more from this engine; a new runtime and engine start on the same server.db.
    const h2 = await h.restart({ hold: true });
    open.push(h2);
    await h2.settle();
    const interrupted = entriesOf(h2.db, B1).filter((entry) => entry.kind === "turn.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].body).toEqual({ botId: "B1", turnId, messageId, text: "partial " });
    expect(h2.engine.spawns).toEqual([]);
    expect(effectRows(h2.db)[0].state).toBe("interrupted");
    expect(h2.db.prepare("SELECT liveTurnId FROM bots WHERE botId = 'B1'").get()!.liveTurnId).toBeNull();
    // turn.stop of the interrupted turn is refused.
    expect(outcomeOf(await h2.send({ type: "turn.stop", botId: "B1", turnId }))).toMatchObject({ kind: "refused", reason: "changed" });
    // A second start adds nothing.
    const h3 = await h2.restart();
    open.push(h3);
    await h3.settle();
    expect(entriesOf(h3.db, B1).filter((entry) => entry.kind === "turn.interrupted")).toHaveLength(1);
  });

  it("a queued row (intent committed, never started) runs once after the restart", async () => {
    const h = await start();
    h.runtime.worker.close();
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "later" })).result as { turnId: string };
    const h2 = await h.restart();
    open.push(h2);
    await h2.settle();
    expect(h2.engine.spawns).toEqual([turnId]);
    expect(h2.engine.starts[0].send).toEqual({ text: "later" });
  });

  it("a kept turn queued before the crash starts from its recorded words", async () => {
    const h = await start();
    h.runtime.worker.close();
    const card = h.engine.addCard("B1");
    await h.runtime.scope.submit(() => undefined);
    await h.send({ type: "chat.answer", botId: "B1", messageId: card.id, text: "do it" });
    const h2 = await h.restart();
    open.push(h2);
    await h2.settle();
    expect(h2.engine.starts).toHaveLength(1);
    expect(h2.engine.starts[0]).toMatchObject({ words: "do it", origin: "user" });
    expect(h2.engine.spawns).toHaveLength(1);
  });

  it("a stale checkpoint with no row is interrupted too; a remove row started at the crash runs again", async () => {
    const h = await start();
    await h.writer.submit((tx) => {
      tx.prepare("UPDATE bots SET liveTurnId = 't-lost', liveText = 'gone', liveAt = 1 WHERE botId = 'B1'").run();
      tx.prepare("INSERT INTO effects (effectId, stream, botId, turnId, kind, payload, state, seq, startedAt) VALUES ('e1', 'bot:B1', 'B1', NULL, 'remove', '{\"kind\":\"remove\"}', 'started', 0, 1)").run();
    });
    const h2 = await h.restart();
    open.push(h2);
    await h2.settle();
    expect(entriesOf(h2.db, B1).find((entry) => entry.kind === "turn.interrupted")!.body).toEqual({ botId: "B1", turnId: "t-lost", text: "gone" });
    expect(h2.engine.removed).toEqual(["B1"]);
  });
});

describe("legacy apply", () => {
  it("runs the core handler once, then stores its events and the receipt together", async () => {
    const h = await start();
    await h.runtime.idle(); // the worker's first look at the outbox
    const submit = vi.spyOn(h.runtime.scope, "submit");
    const outcome = outcomeOf(await h.send({ type: "chat.read", botId: "B1" } as never, { n: 1 }));
    expect(outcome).toMatchObject({ kind: "applied", result: {} });
    expect(kinds(h.db, B1)).toEqual(["chat.decorations", "cmd.applied"]);
    // The handler's event rode in the receipt's command: the check (admit) and the slot's command, nothing of the tap's own.
    expect(submit).toHaveBeenCalledTimes(2);
    await h.send({ type: "chat.read", botId: "B1" } as never, { n: 1 });
    expect(h.engine.runs).toHaveLength(1);
  });

  it("stores a handler's refusal; a copy ahead of `next` is dropped without running", async () => {
    const h = await start();
    expect(outcomeOf(await h.send({ type: "files.remove", botId: "B1", id: "f1" } as never, { n: 1 }))).toMatchObject({ kind: "refused", reason: "invalid" });
    const ahead = await h.send({ type: "chat.read", botId: "B1" } as never, { n: 5 });
    expect(ahead.status).toBe("dropped");
    expect(h.engine.runs).toHaveLength(1);
  });

  it("every contract command is classified; the legacy table lists each legacy command", () => {
    const types = Command.options.map((option) => option.shape.type.value as string).sort();
    expect(Object.keys(COMMAND_ROUTES).sort()).toEqual(types);
    const table = legacyTable();
    for (const [type, route] of Object.entries(COMMAND_ROUTES)) {
      if (route.kind === "legacy") expect(table).toContain(`\`${type}\``);
    }
    const counts = Object.values(COMMAND_ROUTES).reduce<Record<string, number>>((all, route) => ({ ...all, [route.kind]: (all[route.kind] ?? 0) + 1 }), {});
    expect(counts.intent).toBe(10);
  });
});

describe("oversized lines and turns", () => {
  it("a line too big for one frame is cut with a note; the whole text goes to fulltext; the engine gets it whole", async () => {
    const h = await start();
    const text = "字".repeat(100_000); // 300,000 bytes of UTF-8
    const { turnId } = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text })).result as { turnId: string };
    const line = entriesOf(h.db, B1)[0];
    const stored = (line.body.message as { id: string; text: string });
    expect(stored.text.length).toBeLessThan(text.length);
    expect(stored.text).toMatch(/more characters are not shown here/);
    expect(text.startsWith(stored.text.slice(0, stored.text.indexOf("\n\n…")))).toBe(true);
    expect(readFullText(h.db, B1, stored.id)).toBe(text);
    const bytes = Number(h.db.prepare("SELECT length(CAST(body AS BLOB)) AS n FROM entries WHERE stream = ? AND seq = ?").get(B1, line.seq)!.n);
    expect(bytes).toBeLessThan(ENTRY_BYTES_LIMIT);
    await h.settle();
    expect(h.engine.starts[0].send!.text).toBe(text);
    expect(effectRows(h.db).find((row) => row.turnId === turnId)!.state).toBe("finished");
  });

  it("fitBody cuts a 400,000-character turn text and the oldest steps", () => {
    const text = "😀".repeat(200_000);
    const fitted = fitBody("turn.finished", { botId: "B1", turnId: "t-1", messageId: "M", status: "done", text });
    expect(fitted.full).toBe(text);
    expect(fitted.dropped).toBe(false);
    const cut = fitted.body.text as string;
    expect(cut.endsWith(cutNote(text.length - cut.indexOf("\n\n…")))).toBe(true);
    expect(cut.charCodeAt(cut.indexOf("\n\n…") - 1)).not.toBe(0xd83d); // no half surrogate pair
    const steps = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, kind: "tool", title: "x".repeat(1_000), detail: null }));
    const fittedSteps = fitBody("turn.steps", { botId: "B1", turnId: "t-1", messageId: "M", steps });
    const kept = fittedSteps.body.steps as Array<{ id: string }>;
    expect(kept.length).toBeLessThan(500);
    expect(kept.at(-1)!.id).toBe("s499");
    const small = { botId: "B1", turnId: "t", messageId: "M", status: "done", text: "ok" };
    expect(fitBody("turn.finished", small).body).toBe(small);
  });
});
