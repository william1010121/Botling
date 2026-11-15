// Backfill of the 2.x Main bot's and Maintainer's history into a Botling 3 folder that already has lines for them
// (the import refuses those two bots: `hasBotling3History` in server/import/chats.ts counts any entry of the bot's
// stream, and Botling 3 writes one, a `chat.pluginData`, the first time it opens empty). Fixture folders only.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messageView } from "../../src/core/bot";
import { DataDirLock } from "../../src/core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID, toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { DbBotStores } from "../../src/server/botstore";
import { ensureBot } from "../../src/server/effects/log-ops";
import { TxScope } from "../../src/server/effects/scope";
import { EventTap } from "../../src/server/effects/tap";
import { read2x } from "../../src/server/import";
import { backfillHistory, backfillMetaKey, mergeByTime, runBackfill } from "../../src/server/import/backfill";
import { importBotMetaKey, importChats } from "../../src/server/import/chats";
import { mapIds } from "../../src/server/import/id-map";
import { appendEntries, verifyStream } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { make2xFolder } from "../support/fixture-2x";

const dirs: string[] = [];
const stores: ServerStore[] = [];
const hosts: DbBotStores[] = [];

function tempDir(prefix = "botling-backfill-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MAIN = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const MAINT = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (ms: number) => toSwiftDate(ms);
const id = (prefix: number, n: number) => `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Kind, content hash and link target of every item (L-016). */
function snapshotTree(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isSymbolicLink()) out.push(`link ${rel} -> ${readlinkSync(full)}`);
    else if (entry.isDirectory()) {
      out.push(`dir ${rel}`);
      snapshotTree(root, full, out);
    } else out.push(`file ${rel} ${statSync(full).size} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
  }
  return out;
}

function botState(store: ServerStore, botId: string) {
  const reader = store.openReader();
  try {
    const stream = `bot:${botId}`;
    return {
      entries: reader.prepare("SELECT seq, kind, body, hash FROM entries WHERE stream = ? ORDER BY seq").all(stream),
      messages: reader.prepare("SELECT msgId, seq, body FROM messages WHERE botId = ? ORDER BY seq").all(botId)
        .map((row) => ({ msgId: String(row.msgId), seq: Number(row.seq), body: String(row.body) })),
      fulltext: reader.prepare("SELECT key, seq FROM fulltext WHERE stream = ? ORDER BY key").all(stream),
      cards: reader.prepare("SELECT cardId, rev, state FROM cards WHERE botId = ? ORDER BY cardId").all(botId),
      bot: reader.prepare("SELECT settings FROM bots WHERE botId = ?").get(botId),
      lists: reader.prepare("SELECT name, body FROM lists WHERE botId = ? ORDER BY name").all(botId),
      rows: reader.prepare("SELECT stream, key, body FROM rows WHERE stream LIKE ? ORDER BY stream, key").all(`%${botId}%`),
    };
  } finally {
    reader.close();
  }
}

interface Fixture {
  src: string;
  dataDir: string;
  /** 2.x lines, in their chat.json order. */
  mainOld: ChatRecord[];
  maintOld: ChatRecord[];
  /** Botling 3 lines, in the order Botling 3 shows them. */
  mainNew: ChatRecord[];
  maintNew: ChatRecord[];
  unrelatedId: string;
}

/** A 2.x folder and a Botling 3 folder in the state of the real one after the refused import. */
async function makeFixture(): Promise<Fixture & { store: ServerStore }> {
  const root = tempDir();
  const src = join(root, "v2");
  const dataDir = join(root, "v3");
  const fx = make2xFolder(src, { projectCount: 1, standaloneCount: 0 });
  const mainOld = fx.mainMessages;
  const maintOld: ChatRecord[] = [
    { id: id(510, 1), role: "user", text: "old maintainer 1", date: at(T0 + 60_000) },
    { id: id(510, 2), role: "bot", text: "old maintainer 2", date: at(T0 + 120_000), state: "done" },
    { id: id(510, 3), role: "user", text: "old maintainer 3", date: at(T0 + 180_000) },
  ];
  writeFileSync(join(src, "projects", MAINTAINER_ID, "chat.json"), JSON.stringify(maintOld));
  // 2.x tasks for the Maintainer; Botling 3 has one of its own (kept) and one the same as 2.x (not doubled).
  writeFileSync(join(src, "projects", MAINTAINER_ID, "tasks.json"), JSON.stringify([
    { id: id(520, 1), title: "old task", done: false },
    { id: id(520, 2), title: "shared task", done: true },
  ]));

  const longText = "長".repeat(200_000); // cut to fit one entry: its whole text lives in `fulltext`
  const mainNew: ChatRecord[] = [
    { id: id(900, 1), role: "user", text: "new main question", date: at(T0 + 86_400_000) },
    { id: id(900, 2), role: "bot", text: longText, date: at(T0 + 86_400_000 + 5_000), state: "done" },
    {
      id: id(900, 3), role: "bot", text: "pick one", date: at(T0 + 86_400_000 + 9_000), state: "done",
      choices: [{ label: "a", recommended: true }, { label: "b", recommended: false }],
    },
  ];
  const maintNew: ChatRecord[] = [
    { id: id(910, 1), role: "user", text: "new maintainer before all 2.x", date: at(T0 - 60_000) },
    { id: id(910, 2), role: "bot", text: "new maintainer between", date: at(T0 + 150_000), state: "done" },
  ];

  const store = await openServerStore(dataDir);
  stores.push(store);
  const unrelatedId = fx.projectIds[0]!;
  await store.submit((tx) => {
    const put = tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    put.run("ids.main", MAIN);
    put.run("ids.maintainer", MAINT);
    for (const [botId, lines] of [[MAIN, mainNew], [MAINT, maintNew]] as const) {
      const stream = ensureBot(tx, botId);
      // What Botling 3 writes when it first opens empty: the stream then counts as "history" for the import.
      appendEntries(tx, stream, [{ kind: "chat.pluginData", body: { botId, plugin: "botling.note", data: {} } }]);
    }
  });
  // The Botling 3 lines as the event tap writes them (cut to fit, whole text in fulltext), and the core's copy.
  const scope = new TxScope(store);
  const tap = new EventTap({ scope });
  for (const [botId, lines] of [[MAIN, mainNew], [MAINT, maintNew]] as const) {
    for (const record of lines) tap.event({ type: "message.added", botId, message: messageView(record) });
  }
  await scope.submit(() => undefined);
  const host = new DbBotStores(store);
  hosts.push(host);
  for (const [botId, lines] of [[MAIN, mainNew], [MAINT, maintNew]] as const) {
    const botStore = host.open(botId, "");
    botStore.saveSetting("model", "opus");
    botStore.saveMessages([...lines]);
    if (botId === MAINT) botStore.saveList("tasks.json", [{ id: id(520, 2), title: "shared task", done: true }, { id: id(930, 1), title: "new task", done: false }]);
  }
  await host.durable();
  return { src, dataDir, mainOld, maintOld, mainNew, maintNew, unrelatedId, store };
}

function idsBySeq(store: ServerStore, botId: string): string[] {
  return botState(store, botId).messages.map((row) => row.msgId);
}

describe("2.x history backfill for the Main bot and the Maintainer", () => {
  it("cause: the import refuses a bot whose stream holds only the entry Botling 3 writes when it first opens", async () => {
    const fx = await makeFixture();
    const data = read2x(fx.src);
    const idMap = mapIds(data.bots, { mainId: MAIN, maintainerId: MAINT, designated: true });
    const result = await importChats(fx.store, data.bots.filter((bot) => bot.id === MAIN_BOT_ID), idMap, { source: "s" });
    expect(result.bots[0]!.problems).toContain("Main bot already has Botling 3 history; import it into an empty server");
    expect(result.bots[0]!.lines).toBe(0);
  });

  it("merge keeps each side's own order and puts a 2.x line before a Botling 3 line of the same time", () => {
    const merged = mergeByTime(
      [{ k: "a", t: 1 }, { k: "b", t: 5 }, { k: "c", t: 3 }, { k: "d", t: Number.NaN }],
      [{ k: "X", t: 0 }, { k: "Y", t: 5 }, { k: "Z", t: 4 }],
      (item) => item.t,
      (item) => item.t,
    ).map((item) => item.item.k);
    // X (0) is older than every 2.x line; b (5) ties with Y (5) and goes first; c stays after b (2.x order), d (no time)
    // stays with the 2.x line before it.
    expect(merged).toEqual(["X", "a", "b", "c", "d", "Y", "Z"]);
  });

  it("adds the 2.x lines by time, keeps every Botling 3 line and its body, and leaves the chain and other bots intact", async () => {
    const fx = await makeFixture();
    const data = read2x(fx.src);
    const idMap = mapIds(data.bots, { mainId: MAIN, maintainerId: MAINT, designated: true });
    const mainBefore = botState(fx.store, MAIN);
    const maintBefore = botState(fx.store, MAINT);
    const unrelatedBefore = botState(fx.store, fx.unrelatedId);

    const result = await backfillHistory(fx.store, data.bots, idMap, { source: "src-hash" });

    const main = result.bots.find((bot) => bot.oldId === MAIN_BOT_ID)!;
    const maint = result.bots.find((bot) => bot.oldId === MAINTAINER_ID)!;
    expect(result.bots).toHaveLength(2); // only the two refused bots, never a project bot
    expect(main).toMatchObject({ newId: MAIN, state: "added", add: fx.mainOld.length, duplicates: 0, kept: 0, moved: 3, botling3Lines: 3 });
    expect(maint).toMatchObject({ newId: MAINT, state: "added", add: 3, duplicates: 0, kept: 1, moved: 1, botling3Lines: 2 });

    // The window shows lines by `messages.seq`: 2.x lines first (older), then the Botling 3 lines, each once.
    expect(idsBySeq(fx.store, MAIN)).toEqual([...fx.mainOld.map((r) => r.id), ...fx.mainNew.map((r) => r.id)]);
    // Interleaved by time: a Botling 3 line older than all 2.x lines stays first, the one in between goes between.
    expect(idsBySeq(fx.store, MAINT)).toEqual([id(910, 1), id(510, 1), id(510, 2), id(910, 2), id(510, 3)]);

    // Botling 3 lines are unchanged: same bodies (a cut line keeps its cut body; its whole text follows its new seq).
    const mainAfter = botState(fx.store, MAIN);
    for (const before of mainBefore.messages) {
      const after = mainAfter.messages.find((row) => row.msgId === before.msgId)!;
      expect(after.body).toBe(before.body);
    }
    const cut = mainAfter.messages.find((row) => row.msgId === id(900, 2))!;
    expect(mainAfter.fulltext).toEqual([{ key: id(900, 2), seq: cut.seq }]);
    expect(mainAfter.cards).toEqual([{ cardId: id(900, 3), rev: mainAfter.messages.find((row) => row.msgId === id(900, 3))!.seq, state: "open" }]);
    // 2.x lines are the views the import writes.
    const firstOld = mainAfter.messages.find((row) => row.msgId === fx.mainOld[0]!.id)!;
    expect(JSON.parse(firstOld.body)).toEqual(JSON.parse(JSON.stringify(messageView(fx.mainOld[0]!))));

    // Append only: every entry before the backfill is still there, unchanged, and the chain verifies.
    expect(mainAfter.entries.slice(0, mainBefore.entries.length)).toEqual(mainBefore.entries);
    expect(botState(fx.store, MAINT).entries.slice(0, maintBefore.entries.length)).toEqual(maintBefore.entries);
    const reader = fx.store.openReader();
    try {
      expect(verifyStream(reader, `bot:${MAIN}`).ok).toBe(true);
      expect(verifyStream(reader, `bot:${MAINT}`).ok).toBe(true);
    } finally {
      reader.close();
    }

    // Botling 3 settings stay; 2.x settings and head.json are not brought over.
    expect(botState(fx.store, MAIN).bot).toEqual(mainBefore.bot);
    expect(botState(fx.store, MAINT).bot).toEqual(maintBefore.bot);
    expect(botState(fx.store, MAIN).lists.some((row) => row.name === "head.json")).toBe(false);
    expect(botState(fx.store, fx.unrelatedId)).toEqual(unrelatedBefore);

    // The core's own copy has the same lines in the same order.
    const host = new DbBotStores(fx.store);
    hosts.push(host);
    expect(host.open(MAIN, "").loadMessages().records.map((r) => r.id)).toEqual(idsBySeq(fx.store, MAIN));
    expect(host.open(MAINT, "").loadMessages().records.map((r) => r.id)).toEqual(idsBySeq(fx.store, MAINT));
    // Lists: 2.x items added before Botling 3's, nothing replaced or doubled; 2.x subagents added.
    expect(host.open(MAINT, "").loadList("tasks.json").map((t) => (t as { id: string }).id)).toEqual([id(520, 1), id(520, 2), id(930, 1)]);
    expect(host.open(MAIN, "").loadList("pins.json")).toHaveLength(1);
    expect(host.open(MAIN, "").loadList("subagents.json")).toHaveLength(1);
    expect(main.lists).toMatchObject({ pins: 1, specs: 1, tasks: 1, subagents: 1, subagentSteps: 1 });
    expect(maint.lists).toMatchObject({ tasks: 1 });
    expect(fx.store.meta(backfillMetaKey("src-hash", MAIN_BOT_ID))).toBe("done");
  });

  it("a second run adds nothing and changes nothing", async () => {
    const fx = await makeFixture();
    const data = read2x(fx.src);
    const idMap = mapIds(data.bots, { mainId: MAIN, maintainerId: MAINT, designated: true });
    await backfillHistory(fx.store, data.bots, idMap, { source: "src-hash" });
    const mainOnce = botState(fx.store, MAIN);
    const maintOnce = botState(fx.store, MAINT);
    const again = await backfillHistory(fx.store, data.bots, idMap, { source: "src-hash" });
    expect(again.bots.map((bot) => bot.state)).toEqual(["already", "already"]);
    expect(botState(fx.store, MAIN)).toEqual(mainOnce);
    expect(botState(fx.store, MAINT)).toEqual(maintOnce);
    // Without the marker (another source spelling) the lines are found by id: still nothing is added or moved.
    const other = await backfillHistory(fx.store, data.bots, idMap, { source: "other-hash" });
    expect(other.bots.map((bot) => [bot.state, bot.add, bot.duplicates])).toEqual([["nothing", 0, fx.mainOld.length], ["nothing", 0, 3]]);
    expect(botState(fx.store, MAIN).entries).toEqual(mainOnce.entries);
    expect(botState(fx.store, MAINT).entries).toEqual(maintOnce.entries);
  });

  it("leaves a bot the import already brought over alone", async () => {
    const fx = await makeFixture();
    const data = read2x(fx.src);
    const idMap = mapIds(data.bots, { mainId: MAIN, maintainerId: MAINT, designated: true });
    await fx.store.submit((tx) => {
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, 'done')").run(importBotMetaKey("src-hash", MAINTAINER_ID));
    });
    const before = botState(fx.store, MAINT);
    const result = await backfillHistory(fx.store, data.bots, idMap, { source: "src-hash" });
    expect(result.bots.find((bot) => bot.oldId === MAINTAINER_ID)!.state).toBe("imported");
    expect(botState(fx.store, MAINT)).toEqual(before);
  });
});

describe("runBackfill (botlingd backfill-history)", () => {
  it("dry run reports what it would add per bot and changes neither folder", async () => {
    const fx = await makeFixture();
    await fx.store.close();
    stores.splice(stores.indexOf(fx.store), 1);
    const srcBefore = snapshotTree(fx.src);
    const dataBefore = snapshotTree(fx.dataDir);

    const result = await runBackfill({ sourceDir: fx.src, targetDir: fx.dataDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.bots.map((bot) => [bot.name, bot.add, bot.kept, bot.moved])).toEqual([["Main bot", 3, 0, 3], ["Maintainer", 3, 1, 1]]);
    expect(result.reportText).toContain("Dry run");
    expect(result.reportText).toMatch(/Main bot[^\n]*\n\s+add 3 lines from Botling 2/);
    expect(result.reportText).toMatch(/Maintainer[^\n]*\n\s+add 3 lines from Botling 2/);
    expect(snapshotTree(fx.src)).toEqual(srcBefore);
    // server.db-shm is SQLite's shared-memory index of the WAL: every reader, a read-only one too, writes its read mark
    // there. It holds no data; server.db and server.db-wal (the data) must be byte for byte the same.
    const data = (list: string[]) => list.filter((item) => !item.startsWith("file server.db-shm "));
    expect(data(snapshotTree(fx.dataDir))).toEqual(data(dataBefore));
    expect(data(dataBefore).some((item) => item.startsWith("file server.db "))).toBe(true);
  });

  it("applies with a backup first, never writes the 2.x folder, and refuses while botlingd holds the folder", async () => {
    const fx = await makeFixture();
    await fx.store.close();
    stores.splice(stores.indexOf(fx.store), 1);
    const srcBefore = snapshotTree(fx.src);

    const lock = new DataDirLock(fx.dataDir, { version: "test", app: "botlingd" });
    expect(lock.claim().ok).toBe(true);
    await expect(runBackfill({ sourceDir: fx.src, targetDir: fx.dataDir })).rejects.toThrow(/botlingd is running/);
    lock.release();

    const result = await runBackfill({ sourceDir: fx.src, targetDir: fx.dataDir });
    expect(result.dryRun).toBe(false);
    expect(result.backupPath).toBeTruthy();
    expect(statSync(result.backupPath!).isFile()).toBe(true);
    expect(result.bots.map((bot) => [bot.state, bot.add])).toEqual([["added", 3], ["added", 3]]);
    expect(snapshotTree(fx.src)).toEqual(srcBefore);

    const store = await openServerStore(fx.dataDir);
    stores.push(store);
    expect(idsBySeq(store, MAIN)).toEqual([...fx.mainOld.map((r) => r.id), ...fx.mainNew.map((r) => r.id)]);
    expect(idsBySeq(store, MAINT)).toEqual([id(910, 1), id(510, 1), id(510, 2), id(910, 2), id(510, 3)]);
    // The 2.x attachment was copied into Botling 3's folder and the line points at the copy.
    const withFile = JSON.parse(botState(store, MAIN).messages.find((row) => row.msgId === fx.mainOld[2]!.id)!.body) as { attachments?: { url: string }[] };
    expect(withFile.attachments?.[0]?.url).toContain(`${relative("/", fx.dataDir)}/imported/`);

    mkdirSync(join(fx.dataDir, "x"), { recursive: true }); // unrelated change: the second run still finds nothing to do
    const again = await runBackfill({ sourceDir: fx.src, targetDir: fx.dataDir, dryRun: true });
    expect(again.bots.map((bot) => bot.state)).toEqual(["already", "already"]);
  });
});
