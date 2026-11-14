// Botling 3: the user's line of an acknowledged chat.send is part of the bot's own chat (the 2.x core's DbBotStore rows,
// which chat.json and the engine's history come from) from its intent on, not only once its turn starts:
// - the intent puts it into the core's chat in its transaction, so a reaction on it applies while its turn waits;
// - a crash after the intent committed and before the core's rows did is mended at recovery (the turn is interrupted,
//   the line stays in the core's chat);
// - the turn's own send later finds the line by id and does not add a second copy.
// The real 2.x core on DbBotStore and the real intent runtime, on a temp server.db; no agent, no turn ever starts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import type { CmdBody, LogId } from "../../src/protocol";
import { DbBotStores } from "../../src/server/botstore";
import { CoreEngine, IntentRuntime } from "../../src/server/intents";
import { openServerStore, type ServerStore } from "../../src/server/store";

const EPOCH = "c".repeat(32);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** botlingd's key of the store kept in `directory` (botlingd.ts `storeKeyOf`). */
function storeKey(dataDir: string, directory: string): string {
  const rel = relative(dataDir, directory).split(sep).join("/");
  if (rel === "main") return MAIN_BOT_ID;
  if (rel.startsWith("main/")) return `${MAIN_BOT_ID}/${rel.slice(5)}`;
  if (rel.startsWith("projects/")) return rel.slice("projects/".length);
  return rel || MAIN_BOT_ID;
}

interface Life { server: ServerStore; stores: DbBotStores; core: Core; runtime: IntentRuntime; inc: LogId; n: number }

/** One life of the server on `dataDir`, wired as botlingd wires it. `worker: false`: nothing starts a turn. */
async function open(dataDir: string, { worker = true } = {}): Promise<Life> {
  const server = await openServerStore(dataDir);
  const stores = new DbBotStores(server);
  const engine = new CoreEngine();
  const { emit, deferTurn } = engine.coreOptions();
  const core = new Core({
    dataDir, emit, deferTurn, botStore: (directory) => stores.open(storeKey(dataDir, directory), directory),
    headConfig() { throw new Error("No agent allowed"); }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
  });
  (core as unknown as { activated: boolean }).activated = true;
  engine.bind(core);
  const runtime = new IntentRuntime({ store: server, engine });
  if (!worker) runtime.worker.close();
  await runtime.start();
  const reader = server.openReader();
  const serverId = String(reader.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value);
  const inc = String(reader.prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId) as LogId;
  reader.close();
  return { server, stores, core, runtime, inc, n: 0 };
}

async function send(life: Life, cmd: Command, n: number): Promise<Record<string, unknown>> {
  const body = { slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${MAIN_BOT_ID}`, n }, floor: 1, inc: life.inc, cmd } as CmdBody;
  const status = await life.runtime.receive(body, { scope: "local" });
  if (status.status !== "result") throw new Error(`expected a result, got ${status.status}`);
  return status.message.outcome as Record<string, unknown>;
}

async function close(life: Life) {
  await life.core.shutdown();
  await life.runtime.scope.submit(() => undefined);
  await life.stores.durable();
  life.runtime.close();
  await life.stores.close();
  await life.server.close();
}

const read = <T>(life: Life, run: (db: ReturnType<ServerStore["openReader"]>) => T): T => {
  const db = life.server.openReader();
  try { return run(db); } finally { db.close(); }
};
/** The core's own copy: the ids of the rows of stream chat:<main>. */
const coreRows = (life: Life) => read(life, (db) => db.prepare("SELECT key FROM rows WHERE stream = ? AND deleted = 0").all(`chat:${MAIN_BOT_ID}`).map((row) => String(row.key)));
const entries = (life: Life) => read(life, (db) => db.prepare("SELECT kind, body FROM entries WHERE stream = ? ORDER BY seq").all(`bot:${MAIN_BOT_ID}`)
  .map((row) => ({ kind: String(row.kind), body: JSON.parse(String(row.body)) as Record<string, any> })));
const userLineIds = (life: Life) => entries(life).filter((entry) => entry.kind === "message.added" && entry.body.message?.role === "user").map((entry) => String(entry.body.message.id));
const coreLine = (life: Life, id: string) => (life.core as unknown as { bot(id: string): { line(id: string): { id: string; text: string } | null; lines(): readonly { id: string }[] } }).bot(MAIN_BOT_ID).line(id);
const coreLines = (life: Life) => (life.core as unknown as { bot(id: string): { lines(): readonly { id: string; role: string }[] } }).bot(MAIN_BOT_ID).lines();

describe("an acknowledged chat.send's line is in the core's chat from its intent on", () => {
  it("is in the core's chat and rows while its turn waits, and a reaction on it applies", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "botling-userline-"));
    roots.push(dataDir);
    const life = await open(dataDir, { worker: false });
    try {
      expect(await send(life, { type: "chat.send", botId: MAIN_BOT_ID, text: "  hello there " }, 1)).toMatchObject({ kind: "applied" });
      const [userId] = userLineIds(life);
      expect(userId).toBeTruthy();
      expect(coreLine(life, userId!)).toMatchObject({ id: userId, text: "hello there" });
      await life.stores.durable();
      expect(coreRows(life).filter((key) => key === userId)).toHaveLength(1);

      expect(await send(life, { type: "chat.react", botId: MAIN_BOT_ID, messageId: userId!, emoji: "👍", present: true }, 2)).toMatchObject({ kind: "applied" });
      // One line in the log (the core's copy of it was the same line, never a second message.added).
      expect(userLineIds(life)).toEqual([userId]);
      expect(coreLines(life).filter((line) => line.role === "user").map((line) => line.id)).toEqual([userId]);
    } finally { await close(life); }
  }, 60_000);

  it("a crash after the intent and before the core's rows committed: recovery puts the line back as it interrupts the turn", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "botling-userline-"));
    roots.push(dataDir);
    const first = await open(dataDir, { worker: false });
    expect(await send(first, { type: "chat.send", botId: MAIN_BOT_ID, text: "lost on the way?" }, 1)).toMatchObject({ kind: "applied" });
    const [userId] = userLineIds(first);
    await close(first);
    // What the kill left: the intent and its row committed (the worker had marked it started), the core's row not.
    const server = await openServerStore(dataDir);
    await server.submit((tx) => {
      tx.prepare("DELETE FROM rows WHERE stream = ? AND key = ?").run(`chat:${MAIN_BOT_ID}`, userId!);
      tx.prepare("UPDATE effects SET state = 'started', startedAt = 1 WHERE kind = 'turn'").run();
    });
    await server.close();

    const second = await open(dataDir);
    try {
      expect(coreLine(second, userId!)).toMatchObject({ id: userId, text: "lost on the way?" });
      await second.runtime.scope.submit(() => undefined);
      await second.stores.durable();
      expect(coreRows(second).filter((key) => key === userId)).toHaveLength(1);
      expect(entries(second).map((entry) => entry.kind)).toContain("turn.interrupted");
      expect(userLineIds(second)).toEqual([userId]);
      expect(await send(second, { type: "chat.react", botId: MAIN_BOT_ID, messageId: userId!, emoji: "👍", present: true }, 2)).toMatchObject({ kind: "applied" });
    } finally { await close(second); }
  }, 60_000);

  it("the turn's own send finds the preset line by id: one line, brought up to date", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "botling-userline-"));
    roots.push(dataDir);
    const kept: string[] = [];
    const core = new Core({
      dataDir, emit() {}, deferTurn: (turn) => { kept.push(turn.turnId); return true; },
      headConfig() { throw new Error("No agent allowed"); }, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
    });
    try {
      const ids = { turnId: "t-preset", messageId: "R0000000-0000-4000-8000-000000000001", userId: "U0000000-0000-4000-8000-000000000001" };
      expect(core.serverUserLine(MAIN_BOT_ID, { id: ids.userId, text: "first words", time: new Date().toISOString() })).toBe(true);
      expect(core.serverUserLine(MAIN_BOT_ID, { id: ids.userId, text: "first words", time: new Date().toISOString() })).toBe(false);
      const sent = await core.serverSend(MAIN_BOT_ID, "first words", {}, ids);
      expect(sent).toMatchObject({ turnId: ids.turnId, messageId: ids.messageId });
      expect(kept).toEqual([ids.turnId]);
      const users = (core as unknown as { bot(id: string): { lines(): readonly { id: string; role: string; text: string }[] } }).bot(MAIN_BOT_ID).lines().filter((line) => line.role === "user");
      expect(users.map((line) => [line.id, line.text])).toEqual([[ids.userId, "first words"]]);
    } finally { await core.shutdown(); }
  }, 60_000);
});
