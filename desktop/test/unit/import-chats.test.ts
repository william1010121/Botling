import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messageView } from "../../src/core/bot";
import { HISTORY_LIMIT, MAIN_BOT_ID, toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { DbBotStores } from "../../src/server/botstore";
import { BODY_BYTES_LIMIT } from "../../src/server/effects/fit";
import { TxScope } from "../../src/server/effects/scope";
import { EventTap } from "../../src/server/effects/tap";
import { read2x, readChat } from "../../src/server/import";
import { importBotMetaKey, importChats } from "../../src/server/import/chats";
import { mapIds } from "../../src/server/import/id-map";
import { readEntries, readStream, verifyStream } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { make2xFolder } from "../support/fixture-2x";

interface FileSnapshot {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

function collectFiles(root: string, dir = root, out: FileSnapshot[] = []): FileSnapshot[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
    } else if (entry.isFile()) {
      const stat = statSync(full);
      const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
      out.push({ rel: relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    }
  }
  return out;
}

function setModeRecursive(dir: string, dirMode: number, fileMode: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      setModeRecursive(full, dirMode, fileMode);
      chmodSync(full, dirMode);
    } else {
      chmodSync(full, fileMode);
    }
  }
  chmodSync(dir, dirMode);
}

function makeUuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const dirs: string[] = [];
const stores: ServerStore[] = [];
const botStoresList: DbBotStores[] = [];

function tempDir(prefix = "botling-import-chats-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function openStore(dir = tempDir("botling-import-db-")): Promise<ServerStore> {
  const store = await openServerStore(dir);
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const bs of botStoresList.splice(0)) await bs.close();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) {
    try {
      setModeRecursive(dir, 0o755, 0o644);
    } catch {
      // ignore if removed or missing
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const TARGET_MAIN_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const TARGET_MAINTAINER_ID = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

describe("2.x chats import (M6-01c)", () => {
  it("imports a bot's 3 lines into bot:<id> matching EventTap output, preserves 2.x id mentions, and skips head.json", async () => {
    const src = join(tempDir(), "v2");
    const mentionText = `Ask ${MAIN_BOT_ID} about the notes`;
    const fx = make2xFolder(src, {
      extraMainMessages: [
        {
          id: makeUuid(101, 4),
          role: "user",
          text: mentionText,
          date: toSwiftDate(Date.UTC(2026, 0, 1, 12, 1, 0)),
        },
      ],
    });
    // Trim main's chat.json back to exact 3 records where the 3rd mentions MAIN_BOT_ID
    const threeRecords: ChatRecord[] = [
      fx.mainMessages[0]!,
      fx.mainMessages[1]!,
      {
        ...fx.mainMessages[2]!,
        text: mentionText,
      },
    ];
    writeFileSync(join(src, "main", "chat.json"), JSON.stringify(threeRecords, null, 2));

    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const importStore = await openStore();
    const result = await importChats(importStore, data.bots, idMap, { source: "sha256:test-1" });

    expect(result.totalSkipped).toBe(0);
    const mainResult = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;
    expect(mainResult).toMatchObject({
      oldId: MAIN_BOT_ID,
      newId: TARGET_MAIN_ID,
      kind: "main",
      lines: 3,
      skipped: 0,
      batches: 1,
      alreadyDone: false,
    });

    // Run EventTap on the exact same records for comparison
    const tapStore = await openStore();
    const scope = new TxScope(tapStore);
    const tap = new EventTap({ scope });
    for (const record of threeRecords) {
      tap.event({ type: "message.added", botId: TARGET_MAIN_ID, message: messageView(record) });
    }
    await scope.submit(() => undefined);

    const importReader = importStore.openReader();
    const tapReader = tapStore.openReader();
    try {
      const stream = `bot:${TARGET_MAIN_ID}`;
      const imported = readEntries(importReader, stream, 1, { maxEntries: 100, maxBytes: 10_000_000 });
      const tapped = readEntries(tapReader, stream, 1, { maxEntries: 100, maxBytes: 10_000_000 });

      expect(imported.entries).toHaveLength(3);
      expect(tapped.entries).toHaveLength(3);
      expect(imported.entries.map((e) => ({ seq: e.seq, kind: e.kind, body: e.body }))).toEqual(
        tapped.entries.map((e) => ({ seq: e.seq, kind: e.kind, body: e.body })),
      );
      expect(verifyStream(importReader, stream).ok).toBe(true);

      // 2.x bot id mention is NOT rewritten
      const thirdBody = imported.entries[2]!.body as { botId: string; message: { text: string } };
      expect(thirdBody.message.text).toBe(mentionText);
      expect(thirdBody.message.text).toContain(MAIN_BOT_ID);

      // Read-model messages table matches tap
      const importMsgs = importReader
        .prepare("SELECT botId, msgId, rev, seq, body FROM messages WHERE botId = ? ORDER BY seq")
        .all(TARGET_MAIN_ID);
      const tapMsgs = tapReader
        .prepare("SELECT botId, msgId, rev, seq, body FROM messages WHERE botId = ? ORDER BY seq")
        .all(TARGET_MAIN_ID);
      expect(importMsgs).toEqual(tapMsgs);
    } finally {
      importReader.close();
      tapReader.close();
    }
  });

  it("writes the core copy through DbBotStore (chat lines and bot.json settings, without head.json)", async () => {
    const src = join(tempDir(), "v2");
    const fx = make2xFolder(src);
    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const store = await openStore();
    await importChats(store, data.bots, idMap, { source: "sha256:test-2" });

    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);

    const mainDbStore = storesView.open(TARGET_MAIN_ID, "");
    expect(mainDbStore.loadMessages()).toEqual({ records: fx.mainMessages, dropped: 0 });
    expect(mainDbStore.loadSettings()).toMatchObject({
      model: "sonnet",
      unread: 1,
      alwaysAllowed: ["Read", "Bash(git status)"],
    });
    expect(mainDbStore.loadModel()).toBe("sonnet");
    expect(mainDbStore.loadUnread()).toBe(1);
    expect(mainDbStore.loadAlwaysAllowed()).toEqual(["Read", "Bash(git status)"]);
    // head.json must never be imported
    expect(mainDbStore.loadHead()).toBeNull();

    // Standalone bot also reads back its chat and settings
    const standaloneOldId = fx.standaloneIds[0]!;
    const standaloneDbStore = storesView.open(standaloneOldId, "");
    const expectedStandalone = readChat(data.bots.find((b) => b.id === standaloneOldId)!);
    expect(standaloneDbStore.loadMessages()).toEqual({ records: expectedStandalone.chat, dropped: 0 });
    expect(standaloneDbStore.loadModel()).toBe("haiku");
  });

  it("imports a 2,000-line chat in 4 batches, verifies the stream, and resumes cleanly after a mid-bot crash", async () => {
    const src = join(tempDir(), "v2-big");
    const baseDate = toSwiftDate(Date.UTC(2026, 0, 2, 0, 0, 0));
    const extra: ChatRecord[] = [];
    // make2xFolder writes 3 base main messages, so 1997 extra gives 2,000 total
    for (let i = 0; i < 1997; i++) {
      extra.push({
        id: makeUuid(2000, i + 1),
        role: i % 2 === 0 ? "user" : "bot",
        text: `Line ${i + 4}`,
        date: baseDate + i,
        ...(i % 2 === 1 ? { state: "done" as const } : {}),
      });
    }
    const fx = make2xFolder(src, { projectCount: 0, standaloneCount: 0 });
    writeFileSync(join(src, "main", "chat.json"), JSON.stringify([...fx.mainMessages, ...extra]));

    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });
    const source = "sha256:test-big";

    // Simulate a crash before batch 3 of the main bot
    const store = await openStore();
    await expect(
      importChats(store, data.bots, idMap, {
        source,
        onBatch({ oldId, batch }) {
          if (oldId === MAIN_BOT_ID && batch === 3) {
            throw new Error("simulated crash on batch 3");
          }
        },
      }),
    ).rejects.toThrow("simulated crash on batch 3");

    // Partial run left main marked unfinished and 1,000 entries committed
    const midReader = store.openReader();
    try {
      const metaRow = midReader
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(importBotMetaKey(source, MAIN_BOT_ID));
      expect(metaRow?.value).toBe("unfinished");
      expect(readStream(midReader, `bot:${TARGET_MAIN_ID}`)?.head).toBe(1000);
    } finally {
      midReader.close();
    }

    // Re-running redoes the unfinished bot from an empty log with no doubled lines
    const resumed = await importChats(store, data.bots, idMap, { source });
    const mainResumed = resumed.bots.find((b) => b.oldId === MAIN_BOT_ID)!;
    expect(mainResumed).toMatchObject({
      oldId: MAIN_BOT_ID,
      newId: TARGET_MAIN_ID,
      lines: 2000,
      skipped: 0,
      batches: 4,
      alreadyDone: false,
    });

    const reader = store.openReader();
    try {
      const stream = `bot:${TARGET_MAIN_ID}`;
      const streamRow = readStream(reader, stream);
      expect(streamRow?.head).toBe(2000);
      expect(verifyStream(reader, stream)).toMatchObject({ ok: true });

      const all = readEntries(reader, stream, 1, { maxEntries: 5000, maxBytes: 100_000_000 });
      expect(all.entries).toHaveLength(2000);
      expect((all.entries[0]!.body as { message: { text: string } }).message.text).toBe("Hello main");
      expect((all.entries[1999]!.body as { message: { text: string } }).message.text).toBe("Line 2000");

      const doneRow = reader
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(importBotMetaKey(source, MAIN_BOT_ID));
      expect(doneRow?.value).toBe("done");
    } finally {
      reader.close();
    }

    // Core copy holds newest HISTORY_LIMIT lines
    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);
    const mainDbStore = storesView.open(TARGET_MAIN_ID, "");
    const loaded = mainDbStore.loadMessages();
    expect(loaded.records).toHaveLength(HISTORY_LIMIT);
    expect(loaded.records[loaded.records.length - 1]!.text).toBe("Line 2000");

    // Re-running once done is a no-op for already-done bots
    const third = await importChats(store, data.bots, idMap, { source });
    expect(third.bots.every((b) => b.alreadyDone)).toBe(true);
  });

  it("skips and counts lines that fail messageView or exceed the log frame limit, and imports subsequent lines", async () => {
    const src = join(tempDir(), "v2-oversized");
    const fx = make2xFolder(src, { projectCount: 0, standaloneCount: 0 });
    const baseDate = toSwiftDate(Date.UTC(2026, 0, 3, 0, 0, 0));

    // Oversized line that fitBody cannot shrink below BODY_BYTES_LIMIT:
    // 50 attachments (4,000-char URL + 400-char name) + 20 choices + 60 reactions + answer + replyPreview
    const bigAttachmentUrl = `file:///tmp/${"a".repeat(3_580)}/${"b".repeat(400)}`;
    const oversizedRecord: ChatRecord = {
      id: makeUuid(300, 1),
      role: "bot",
      text: "Too large even cut",
      date: baseDate,
      answer: "x".repeat(4_000),
      replyPreview: "y".repeat(2_000),
      choices: Array.from({ length: 20 }, (_, idx) => ({
        label: `Choice ${idx}: ${"c".repeat(380)}`,
        detail: "d".repeat(400),
        recommended: false,
      })),
      reactions: Array.from({ length: 60 }, (_, idx) => ({
        emoji: "👍",
        actor: `actor-${idx}-${"z".repeat(180)}`,
      })),
      attachments: Array.from({ length: 50 }, () => ({ url: bigAttachmentUrl, kind: "file" as const })),
    };
    expect(Buffer.byteLength(JSON.stringify({ botId: TARGET_MAIN_ID, message: messageView(oversizedRecord) }))).toBeGreaterThan(
      BODY_BYTES_LIMIT,
    );

    // Record with out-of-range Swift date so isChatRecord accepts it but messageView throws (Invalid time value)
    const throwingRecord: ChatRecord = {
      id: makeUuid(300, 2),
      role: "user",
      text: "Out-of-range date",
      date: 1e20,
    };
    const afterRecord: ChatRecord = {
      id: makeUuid(300, 3),
      role: "user",
      text: "Line after skipped",
      date: baseDate + 2,
    };

    writeFileSync(
      join(src, "main", "chat.json"),
      JSON.stringify([fx.mainMessages[0], oversizedRecord, throwingRecord, afterRecord]),
    );

    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const store = await openStore();
    const result = await importChats(store, data.bots, idMap, { source: "sha256:test-skip" });
    const mainResult = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;

    expect(mainResult.skipped).toBe(2);
    expect(mainResult.lines).toBe(2);

    const reader = store.openReader();
    try {
      const stream = `bot:${TARGET_MAIN_ID}`;
      expect(verifyStream(reader, stream).ok).toBe(true);
      const entries = readEntries(reader, stream, 1, { maxEntries: 100, maxBytes: 10_000_000 }).entries;
      expect(entries.map((e) => (e.body as { message: { text: string } }).message.text)).toEqual([
        "Hello main",
        "Line after skipped",
      ]);
    } finally {
      reader.close();
    }
  });

  it("lands a non-designated 2.x main bot under its new id with name Main (old)", async () => {
    const src = join(tempDir(), "v2-nondesig");
    const fx = make2xFolder(src);
    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: false,
    });

    const store = await openStore();
    const result = await importChats(store, data.bots, idMap, { source: "sha256:test-nondesig" });

    const mainAsBot = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;
    expect(mainAsBot.kind).toBe("main-as-bot");
    expect(mainAsBot.name).toBe("Main (old)");
    expect(mainAsBot.newId).not.toBe(MAIN_BOT_ID);
    expect(mainAsBot.newId).not.toBe(TARGET_MAIN_ID);
    expect(mainAsBot.lines).toBe(fx.mainMessages.length);

    const reader = store.openReader();
    try {
      // Old fixed id and server's designated mainId have no imported entries
      expect(readStream(reader, `bot:${MAIN_BOT_ID}`)).toBeNull();
      expect(readStream(reader, `bot:${TARGET_MAIN_ID}`)).toBeNull();

      // Main (old) has its own stream with all main lines under its newId
      const stream = `bot:${mainAsBot.newId}`;
      expect(verifyStream(reader, stream).ok).toBe(true);
      const entries = readEntries(reader, stream, 1, { maxEntries: 100, maxBytes: 10_000_000 }).entries;
      expect(entries).toHaveLength(fx.mainMessages.length);
      expect((entries[0]!.body as { botId: string }).botId).toBe(mainAsBot.newId);
    } finally {
      reader.close();
    }

    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);
    const mainOldStore = storesView.open(mainAsBot.newId, "");
    expect(mainOldStore.loadMessages().records).toEqual(fx.mainMessages);
  });

  it("never writes or touches the source folder even when permissions are read-only", async () => {
    const src = join(tempDir(), "v2-readonly");
    make2xFolder(src);
    const before = collectFiles(src);

    setModeRecursive(src, 0o555, 0o444);
    try {
      const data = read2x(src);
      const idMap = mapIds(data.bots, {
        mainId: TARGET_MAIN_ID,
        maintainerId: TARGET_MAINTAINER_ID,
        designated: true,
      });
      const store = await openStore();
      await importChats(store, data.bots, idMap, { source: "sha256:test-ro" });
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    expect(collectFiles(src)).toEqual(before);
  });
});
