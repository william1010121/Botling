// 2.x -> 3.x chat and lists import (protocol v1 §14.4, §7.3; M6-01c, M6-02a).
//
// Runs while botlingd is stopped (M6-01d holds the data-folder lock). Each 2.x bot gets:
// 1. A `bot:<newId>` log stream whose first entries are `message.added` items with `{botId: newId, message:
//    messageView(record)}` — identical to what EventTap writes — appended in batches of 500 lines per writer
//    transaction. A crash mid-bot leaves the bot marked "unfinished" in `meta` so a retry resets its partial log and
//    redoes it from empty; only after all batches and the core copy commit is it marked "done". If the target bot
//    already has Botling 3 history before any import meta mark exists, importing that bot is refused without modifying
//    or deleting any existing rows (Q-M6-C1).
// 2. The core's own 2.x-shaped copy via `DbBotStore`: `bot.json` settings and newest HISTORY_LIMIT chat lines, plus
//    `importLists(botStore, bot)` for `pins.json`, `specs.json`, `tasks.json`, and subagent index + steps.
//    `DbBotStores` owns its own writer backend and does not accept an external `tx`, so the core copy runs right after
//    the log batches commit (before the bot is marked "done").
//
// 3. M6-05: when `options.content` is given, each appended line is indexed with `content.noteLine` in the SAME writer
//    transaction as its entry, and once the bot's lines are all committed `content.afterCommit` pins and hashes the
//    files (a failure there is counted, never undoes a line). `options.attachmentMap` (old `file:` URL -> the copy under
//    `<dataDir>/imported/`, from `copyMedia`) is applied to every record first, so the line, its entry and the core copy
//    point at the copy and the content store pins the copy, never the 2.x path.
//
// `head.json` (the engine session) is never imported, and 2.x bot ids mentioned inside message text are kept verbatim.
import { messageView } from "../../core/bot";
import type { ChatRecord } from "../../core/store/records";
import type { ContentService, NotedLine } from "../content/service";
import { DbBotStores, type DbBotStore } from "../botstore";
import { fitBody } from "../effects/fit";
import { botStream, ensureBot } from "../effects/log-ops";
import { appendEntries } from "../log";
import type { Db, ServerStore } from "../store";
import type { IdMapKind, IdMapRow } from "./id-map";
import { remapAttachments } from "./media";
import { readChat, type Read2xBot, type Read2xChat, type Read2xSubagent } from "./reader-2x";

export const CHAT_IMPORT_BATCH_SIZE = 500;

export function importBotMetaKey(source: string, oldId: string): string {
  return `import:${source}:bot:${oldId}`;
}

export interface ImportedBotLists {
  pins: number;
  missingPinLines: number;
  specs: number;
  tasks: number;
  subagents: number;
  subagentSteps: number;
  problems: string[];
}

export interface ImportListsOptions {
  /** Pre-read 2.x chat bundle (used by `importBotChat` to avoid reading the source twice). */
  chatData?: Read2xChat;
  /** Imported chat line ids for this bot (case-insensitive check for pins pointing at lines). */
  knownMessageIds?: ReadonlySet<string>;
}

export interface ImportedBotChat {
  oldId: string;
  newId: string;
  kind: IdMapKind;
  name: string;
  lines: number;
  skipped: number;
  batches: number;
  alreadyDone: boolean;
  lists: ImportedBotLists;
  /** M6-05: files the content store pinned and hashed for this bot's lines, and files it could not. */
  content: { ready: number; failed: number };
  problems: string[];
}

export interface ImportChatsResult {
  bots: ImportedBotChat[];
  totalLines: number;
  totalSkipped: number;
  totalPins: number;
  totalMissingPinLines: number;
  totalSpecs: number;
  totalTasks: number;
  totalSubagents: number;
  totalSubagentSteps: number;
}

export interface ImportChatsOptions {
  /** Import source key used for per-bot resume markers (`import:<source>:bot:<oldId>`). */
  source?: string;
  /** Number of lines appended per writer transaction (defaults to 500). */
  batchSize?: number;
  /** Clock for HLC timestamps (defaults to `Date.now`). */
  now?: () => number;
  log?: (line: string) => void;
  /** M6-05: the content service that indexes each line's files in the line's own transaction. */
  content?: Pick<ContentService, "noteLine" | "afterCommit">;
  /** M6-05: old attachment URL -> URL of its copy under `<dataDir>/imported/` (`copyMedia`). */
  attachmentMap?: ReadonlyMap<string, string>;
  /** Hook called before each batch transaction (useful for progress or crash injection in tests). */
  onBatch?: (info: { oldId: string; newId: string; batch: number; totalBatches: number }) => void;
}

export interface PreparedLine {
  body: Record<string, unknown>;
  full: string | null;
  msgId: string;
  /** The line as the content indexer reads it (id, text, attachments). */
  view: ReturnType<typeof messageView>;
}

const EMPTY_LISTS: ImportedBotLists = {
  pins: 0,
  missingPinLines: 0,
  specs: 0,
  tasks: 0,
  subagents: 0,
  subagentSteps: 0,
  problems: [],
};

const SQL = {
  getMeta: "SELECT value FROM meta WHERE key = ?",
  setMeta: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  putFulltext:
    "INSERT INTO fulltext (stream, key, seq, text) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (stream, key) DO UPDATE SET seq = excluded.seq, text = excluded.text",
} as const;

function historyProblem(name: string): string {
  return `${name} already has Botling 3 history; import it into an empty server`;
}

function hasBotling3History(db: Db, botId: string): boolean {
  const stream = botStream(botId);
  const streamRow = db.prepare("SELECT head, tail FROM streams WHERE stream = ?").get(stream);
  if (streamRow && (Number(streamRow.head) > 0 || Number(streamRow.tail) > 0)) return true;
  if (db.prepare("SELECT 1 FROM entries WHERE stream = ? LIMIT 1").get(stream)) return true;
  if (db.prepare("SELECT 1 FROM fulltext WHERE stream = ? LIMIT 1").get(stream)) return true;
  if (db.prepare("SELECT 1 FROM retired WHERE stream = ? LIMIT 1").get(stream)) return true;
  if (db.prepare("SELECT 1 FROM messages WHERE botId = ? LIMIT 1").get(botId)) return true;
  if (db.prepare("SELECT 1 FROM cards WHERE botId = ? LIMIT 1").get(botId)) return true;
  if (db.prepare("SELECT 1 FROM rows WHERE stream = ? AND deleted = 0 LIMIT 1").get(`chat:${botId}`)) return true;
  if (db.prepare("SELECT 1 FROM bots WHERE botId = ? AND (head > 0 OR liveTurnId IS NOT NULL) LIMIT 1").get(botId)) {
    return true;
  }
  return false;
}

function resetUnfinishedBot(tx: Db, botId: string): void {
  const stream = botStream(botId);
  const substepsPrefix = `substeps:[${JSON.stringify(botId)},`;
  // M6-05: the content rows the first run noted for this stream's lines go too (a retry notes them again); rows another
  // stream still references stay. Pin files no row names are swept at the next start (`ContentService.recover`).
  const doomed = tx
    .prepare("SELECT DISTINCT id FROM content_refs WHERE stream = ? AND id NOT IN (SELECT id FROM content_refs WHERE stream <> ?)")
    .all(stream, stream)
    .map((row) => String(row.id));
  tx.prepare("DELETE FROM content_names WHERE stream = ?").run(stream);
  tx.prepare("DELETE FROM content_refs WHERE stream = ?").run(stream);
  for (const id of doomed) {
    tx.prepare("DELETE FROM content WHERE id = ?").run(id);
    tx.prepare("DELETE FROM content_meta WHERE id = ?").run(id);
    tx.prepare("DELETE FROM content_aliases WHERE pending = ? OR id = ?").run(id, id);
  }
  tx.prepare("DELETE FROM entries WHERE stream = ?").run(stream);
  tx.prepare("DELETE FROM fulltext WHERE stream = ?").run(stream);
  tx.prepare("DELETE FROM messages WHERE botId = ?").run(botId);
  tx.prepare("DELETE FROM cards WHERE botId = ?").run(botId);
  tx.prepare("DELETE FROM streams WHERE stream = ?").run(stream);
  tx.prepare("DELETE FROM rows WHERE stream = ?").run(`chat:${botId}`);
  tx.prepare("DELETE FROM rows WHERE stream = ?").run(`subagents:${botId}`);
  tx.prepare("DELETE FROM rows WHERE substr(stream, 1, ?) = ?").run(substepsPrefix.length, substepsPrefix);
  tx.prepare("DELETE FROM lists WHERE botId = ?").run(botId);
  tx.prepare("DELETE FROM bots WHERE botId = ?").run(botId);
}

function pinLineId(pin: unknown): string | null {
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) return null;
  const record = pin as Record<string, unknown>;
  if (typeof record.messageId === "string" && record.messageId.length > 0) return record.messageId;
  if (typeof record.messageID === "string" && record.messageID.length > 0) return record.messageID;
  return null;
}

/** Stages each subagent's 2.x steps and runs (in their order) for the next `commitSubagents`; returns the step count. */
export function stageSubagents(botStore: DbBotStore, subagents: readonly Read2xSubagent[]): number {
  let steps = 0;
  for (const sub of subagents) {
    const subId = String(sub.index.id);
    for (const earlier of sub.history.runs) {
      for (const step of earlier.steps) {
        botStore.stageSubagentLine(subId, { k: "step", step });
        steps += 1;
      }
      botStore.stageSubagentLine(subId, { k: "run", run: earlier.run });
    }
    for (const step of sub.history.steps) {
      botStore.stageSubagentLine(subId, { k: "step", step });
      steps += 1;
    }
  }
  return steps;
}

/** Copies a bot's 2.x lists (`pins.json`, `specs.json`, `tasks.json`) and subagent index + steps via `DbBotStore`. */
export async function importLists(
  botStore: DbBotStore,
  bot: Read2xBot,
  options: ImportListsOptions = {},
): Promise<ImportedBotLists> {
  const chatData = options.chatData ?? readChat(bot);

  const knownUpper = new Set<string>();
  if (options.knownMessageIds) {
    for (const id of options.knownMessageIds) knownUpper.add(id.toUpperCase());
  } else {
    const stored = botStore.loadMessages().records;
    const source = stored.length > 0 ? stored : chatData.chat;
    for (const record of source) knownUpper.add(record.id.toUpperCase());
  }

  botStore.saveList("pins.json", chatData.pins);
  botStore.saveList("specs.json", chatData.specs);
  botStore.saveList("tasks.json", chatData.tasks);

  let missingPinLines = 0;
  for (const pin of chatData.pins) {
    const lineId = pinLineId(pin);
    if (lineId !== null && !knownUpper.has(lineId.toUpperCase())) {
      missingPinLines += 1;
    }
  }

  const subagentSteps = stageSubagents(botStore, chatData.subagents);
  botStore.commitSubagents(chatData.subagents.map((s) => s.index));
  await botStore.durable();

  return {
    pins: chatData.pins.length,
    missingPinLines,
    specs: chatData.specs.length,
    tasks: chatData.tasks.length,
    subagents: chatData.subagents.length,
    subagentSteps,
    problems: chatData.problems,
  };
}

export function prepareLines(
  records: readonly ChatRecord[],
  newId: string,
  log?: (line: string) => void,
  attachmentMap?: ReadonlyMap<string, string>,
): { prepared: PreparedLine[]; skipped: number } {
  const prepared: PreparedLine[] = [];
  let skipped = 0;
  const stream = botStream(newId);
  for (const record of records) {
    let view: ReturnType<typeof messageView>;
    try {
      view = messageView(record);
      // The copy's file name has a `<n>-` prefix; the line keeps showing the file's own name.
      if (attachmentMap?.size && record.attachments?.length) {
        const remapped = messageView(remapAttachments(record, attachmentMap));
        const names = view.attachments?.map((file) => file.name);
        view = remapped;
        if (names && view.attachments && names.length === view.attachments.length) {
          view.attachments.forEach((file, i) => { file.name = names[i]!; });
        }
      }
    } catch (error) {
      skipped += 1;
      log?.(`${stream}: skipped line ${String((record as { id?: unknown })?.id ?? "?")} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const fitted = fitBody("message.added", { botId: newId, message: view });
    if (fitted.dropped) {
      skipped += 1;
      log?.(`${stream}: skipped oversized message.added line ${view.id}`);
      continue;
    }
    prepared.push({ body: fitted.body, full: fitted.full, msgId: view.id, view });
  }
  return { prepared, skipped };
}

function appendPreparedBatch(
  tx: Db,
  stream: ReturnType<typeof botStream>,
  batch: readonly PreparedLine[],
  now: (() => number) | undefined,
  log?: (line: string) => void,
  content?: Pick<ContentService, "noteLine">,
  newId?: string,
): { imported: number; skipped: number; importedIds: string[]; noted: NotedLine[] } {
  const noted: NotedLine[] = [];
  // M6-05: indexed inside the transaction that appended the entry (`noteLine` never throws for one file).
  const note = (item: PreparedLine, entry: { stream: typeof stream; seq: number }) => {
    const found = content && newId ? content.noteLine(tx, newId, item.view, entry) : null;
    if (found) noted.push(found);
  };
  if (!batch.length) return { imported: 0, skipped: 0, importedIds: [], noted };
  const putFulltext = tx.prepare(SQL.putFulltext);
  const appendOpts = now ? { now: now() } : {};

  tx.exec("SAVEPOINT import_chat_batch");
  try {
    const entries = appendEntries(
      tx,
      stream,
      batch.map((item) => ({ kind: "message.added", body: item.body })),
      appendOpts,
    );
    for (let i = 0; i < entries.length; i++) {
      const item = batch[i]!;
      if (item.full !== null) {
        putFulltext.run(stream, item.msgId, entries[i]!.seq, item.full);
      }
      note(item, entries[i]!);
    }
    tx.exec("RELEASE import_chat_batch");
    return { imported: entries.length, skipped: 0, importedIds: batch.map((item) => item.msgId), noted };
  } catch (error) {
    if (!tx.inTransaction) throw error;
    tx.exec("ROLLBACK TO import_chat_batch");
    tx.exec("RELEASE import_chat_batch");
    log?.(`${stream}: batch append failed (${error instanceof Error ? error.message : String(error)}); retrying line by line`);
    noted.length = 0;
  }

  let imported = 0;
  let skipped = 0;
  const importedIds: string[] = [];
  for (const item of batch) {
    const notedBefore = noted.length;
    tx.exec("SAVEPOINT import_chat_item");
    try {
      const [entry] = appendEntries(tx, stream, [{ kind: "message.added", body: item.body }], appendOpts);
      if (item.full !== null) {
        putFulltext.run(stream, item.msgId, entry!.seq, item.full);
      }
      note(item, entry!);
      tx.exec("RELEASE import_chat_item");
      imported += 1;
      importedIds.push(item.msgId);
    } catch (error) {
      if (!tx.inTransaction) throw error;
      tx.exec("ROLLBACK TO import_chat_item");
      tx.exec("RELEASE import_chat_item");
      noted.length = notedBefore;
      skipped += 1;
      log?.(`${stream}: skipped line ${item.msgId} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { imported, skipped, importedIds, noted };
}

export async function importBotChat(
  store: Pick<ServerStore, "submit" | "openReader" | "meta">,
  stores: DbBotStores,
  bot: Read2xBot,
  mapped: IdMapRow,
  options: ImportChatsOptions = {},
): Promise<ImportedBotChat> {
  const source = options.source ?? "default";
  const metaKey = importBotMetaKey(source, bot.id);
  const currentMeta = store.meta(metaKey);
  if (currentMeta === "done") {
    return {
      oldId: bot.id,
      newId: mapped.newId,
      kind: mapped.kind,
      name: mapped.name,
      lines: 0,
      skipped: 0,
      batches: 0,
      alreadyDone: true,
      lists: { ...EMPTY_LISTS, problems: [] },
      content: { ready: 0, failed: 0 },
      problems: [],
    };
  }

  const stream = botStream(mapped.newId);
  if (currentMeta !== "unfinished") {
    const reader = store.openReader();
    let hasHistory = false;
    try {
      hasHistory = hasBotling3History(reader, mapped.newId);
    } finally {
      reader.close();
    }
    if (hasHistory) {
      const problem = historyProblem(mapped.name);
      options.log?.(`${stream}: refused import (${problem})`);
      return {
        oldId: bot.id,
        newId: mapped.newId,
        kind: mapped.kind,
        name: mapped.name,
        lines: 0,
        skipped: 0,
        batches: 0,
        alreadyDone: false,
        lists: { ...EMPTY_LISTS, problems: [] },
        content: { ready: 0, failed: 0 },
        problems: [problem],
      };
    }
  }

  // Strictly read-only read of chat.json, lists, subagents, and bot.json (head.json is intentionally never imported).
  const chatData = readChat(bot);
  const { prepared, skipped: prepSkipped } = prepareLines(chatData.chat, mapped.newId, options.log, options.attachmentMap);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? CHAT_IMPORT_BATCH_SIZE));
  const batches: PreparedLine[][] = [];
  for (let i = 0; i < prepared.length; i += batchSize) {
    batches.push(prepared.slice(i, i + batchSize));
  }
  if (batches.length === 0) batches.push([]);

  let importedLines = 0;
  let appendSkipped = 0;
  let batchCount = 0;
  let rejected = false;
  const importedMsgIds = new Set<string>();
  const noted: NotedLine[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    options.onBatch?.({
      oldId: bot.id,
      newId: mapped.newId,
      batch: i + 1,
      totalBatches: batches.length,
    });
    const outcome = await store.submit((tx) => {
      if (i === 0) {
        const prev = tx.prepare(SQL.getMeta).get(metaKey);
        if (prev?.value === "unfinished") {
          resetUnfinishedBot(tx, mapped.newId);
        } else if (prev?.value === "done") {
          return { imported: 0, skipped: 0, importedIds: [] as string[], noted: [] as NotedLine[], rejected: false, alreadyDone: true };
        } else if (hasBotling3History(tx, mapped.newId)) {
          return { imported: 0, skipped: 0, importedIds: [] as string[], noted: [] as NotedLine[], rejected: true, alreadyDone: false };
        }
        ensureBot(tx, mapped.newId);
        tx.prepare(SQL.setMeta).run(metaKey, "unfinished");
      }
      return {
        ...appendPreparedBatch(tx, stream, batch, options.now, options.log, options.content, mapped.newId),
        rejected: false,
        alreadyDone: false,
      };
    });
    if (outcome.alreadyDone) {
      return {
        oldId: bot.id,
        newId: mapped.newId,
        kind: mapped.kind,
        name: mapped.name,
        lines: 0,
        skipped: 0,
        batches: 0,
        alreadyDone: true,
        lists: { ...EMPTY_LISTS, problems: [] },
        content: { ready: 0, failed: 0 },
        problems: [],
      };
    }
    if (outcome.rejected) {
      rejected = true;
      break;
    }
    importedLines += outcome.imported;
    appendSkipped += outcome.skipped;
    for (const id of outcome.importedIds) importedMsgIds.add(id);
    noted.push(...outcome.noted);
    batchCount += 1;
  }

  if (rejected) {
    const problem = historyProblem(mapped.name);
    options.log?.(`${stream}: refused import (${problem})`);
    return {
      oldId: bot.id,
      newId: mapped.newId,
      kind: mapped.kind,
      name: mapped.name,
      lines: 0,
      skipped: 0,
      batches: 0,
      alreadyDone: false,
      lists: { ...EMPTY_LISTS, problems: [] },
      content: { ready: 0, failed: 0 },
      problems: [problem],
    };
  }

  // M6-05: the lines are committed; pin and hash their files in order. A failure is counted, never undoes a line.
  const contentResult = { ready: 0, failed: 0 };
  if (options.content) {
    for (const item of noted) {
      try {
        const readyEntries = await options.content.afterCommit(item);
        contentResult.ready += readyEntries.length;
        contentResult.failed += Math.max(0, item.files.length - readyEntries.length);
      } catch (error) {
        contentResult.failed += item.files.length;
        options.log?.(`${stream}: content for line ${item.lineId} failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  // Core's 2.x-shaped copy via DbBotStore (bot.json settings + newest HISTORY_LIMIT lines + lists/subagents).
  const botStore = stores.open(mapped.newId, "");
  for (const [key, value] of Object.entries(chatData.settings)) {
    if (value !== undefined) botStore.saveSetting(key, value);
  }
  botStore.saveMessages(options.attachmentMap?.size ? chatData.chat.map((record) => remapAttachments(record, options.attachmentMap!)) : chatData.chat);
  const lists = await importLists(botStore, bot, {
    chatData,
    knownMessageIds: importedMsgIds,
  });

  await store.submit((tx) => {
    tx.prepare(SQL.setMeta).run(metaKey, "done");
  });

  return {
    oldId: bot.id,
    newId: mapped.newId,
    kind: mapped.kind,
    name: mapped.name,
    lines: importedLines,
    skipped: prepSkipped + appendSkipped,
    batches: batchCount,
    alreadyDone: false,
    lists,
    content: contentResult,
    problems: chatData.problems,
  };
}

export async function importChats(
  store: Pick<ServerStore, "submit" | "openReader" | "meta">,
  bots: readonly Read2xBot[],
  idMap: readonly IdMapRow[],
  options: ImportChatsOptions = {},
): Promise<ImportChatsResult> {
  const mapByOldId = new Map<string, IdMapRow>();
  for (const row of idMap) mapByOldId.set(row.oldId, row);

  const stores = new DbBotStores(store);
  const results: ImportedBotChat[] = [];
  try {
    for (const bot of bots) {
      const mapped = mapByOldId.get(bot.id);
      if (!mapped) {
        throw new Error(`Missing id mapping for 2.x bot ${bot.id}`);
      }
      results.push(await importBotChat(store, stores, bot, mapped, options));
    }
    await stores.durable();
  } finally {
    await stores.close();
  }

  return {
    bots: results,
    totalLines: results.reduce((sum, r) => sum + r.lines, 0),
    totalSkipped: results.reduce((sum, r) => sum + r.skipped, 0),
    totalPins: results.reduce((sum, r) => sum + r.lists.pins, 0),
    totalMissingPinLines: results.reduce((sum, r) => sum + r.lists.missingPinLines, 0),
    totalSpecs: results.reduce((sum, r) => sum + r.lists.specs, 0),
    totalTasks: results.reduce((sum, r) => sum + r.lists.tasks, 0),
    totalSubagents: results.reduce((sum, r) => sum + r.lists.subagents, 0),
    totalSubagentSteps: results.reduce((sum, r) => sum + r.lists.subagentSteps, 0),
  };
}
