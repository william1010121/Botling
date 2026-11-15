// Backfill of the 2.x Main bot's and Maintainer's history into a Botling 3 folder whose import refused them.
//
// Why it is needed: `importBotChat` (chats.ts) refuses a bot that already has Botling 3 history (Q-M6-C1), and its
// check (`hasBotling3History`) counts any entry of the bot's stream. Botling 3 writes a `chat.pluginData` entry for its
// own Main bot and Maintainer the first time it opens, before any import, so when the import runs on a folder that was
// opened once, those two bots are refused even with no chat line at all, and later Botling 3 lines make a plain retry
// impossible. Every other bot is new to the folder and imports normally.
//
// What it does, per bot (only the `main` and `maintainer` rows of the id map; a bot the import brought over is left
// alone), inside one writer command, so a bot is either backfilled whole or not at all:
//   - the 2.x lines whose id is not in Botling 3 yet are merged with the bot's Botling 3 lines by time (each side keeps
//     its own order; a tie puts the 2.x line first, as the older source);
//   - the Botling 3 lines older than the first added 2.x line stay where they are; every later Botling 3 line is moved
//     below with `message.removed` + `message.added` of its stored view, unchanged (what the core does when it moves a
//     reply below a new line, core/bot.ts `joinTurn`), and the 2.x lines are appended between them in time order. The
//     log stays append only: no entry is rewritten, the hash chain goes on, and a window following the stream sees the
//     same entries it would see live. Its `fulltext` row follows a moved line to its new entry;
//   - `backfill:<source>:bot:<oldId>` in `meta` marks it ("lines", then "done" once the core's copy and lists are in).
// Then the core's own copy (`DbBotStore`: the newest HISTORY_LIMIT lines) gets the same merge, and the 2.x pins, specs,
// tasks and subagents are added in front of Botling 3's (by id: nothing replaced, nothing doubled). 2.x bot settings and
// `head.json` are not brought over: Botling 3's stay.
//
// Strictly read-only on the 2.x folder (same guards as run.ts: real paths, dev:ino, a write guard on every write). The
// real run holds botlingd's data-folder lock and takes a `manual` backup of server.db first; the dry run only reads
// (a read-only connection) and may run while botlingd is up.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../core/durable/atomic";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock } from "../../core/store/data-dir-lock";
import { fromSwiftDate, MAIN_BOT_ID, MAINTAINER_ID, type ChatRecord } from "../../core/store/records";
import { canonicalJson } from "../../protocol";
import { DbBotStores, type DbBotStore } from "../botstore";
import { BOTLINGD_VERSION } from "../botlingd";
import { ContentService } from "../content";
import type { NotedLine } from "../content/service";
import { fitBody } from "../effects/fit";
import { ensureBot } from "../effects/log-ops";
import { appendEntries, type AppendItem } from "../log";
import { refuse2xData } from "../session/paths";
import { openServerStore, takeBackup, type Db, type ServerStore } from "../store";
import { openReaderDb } from "../store/connection";
import { importBotMetaKey, prepareLines, stageSubagents, type PreparedLine } from "./chats";
import { readIdMap, type IdMapKind, type IdMapRow } from "./id-map";
import { copyMedia, mediaDryRunReport, mediaReport, planMedia, remapAttachments } from "./media";
import { looksLike2x, read2x, readChat, type Read2xBot, type Read2xChat } from "./reader-2x";
import { cleanName, fmtCount } from "./report";
import {
  guardTargetTop,
  holderPid,
  ImportError,
  makeWriteGuard,
  realPath,
  realPathOrNearest,
  sameOrNested,
  sha256Text,
} from "./run";

/** The id-map kinds the backfill handles: the two bots every Botling 3 folder has before any import. */
export const BACKFILL_KINDS: ReadonlySet<IdMapKind> = new Set<IdMapKind>(["main", "maintainer"]);

export function backfillMetaKey(source: string, oldId: string): string {
  return `backfill:${source}:bot:${oldId}`;
}

export type BackfillState =
  /** 2.x lines were (or, in a dry run, would be) added. */
  | "added"
  /** Every 2.x line is in Botling 3 already. */
  | "nothing"
  /** An earlier backfill of this source finished this bot. */
  | "already"
  /** The import itself brought this bot over. */
  | "imported";

export interface BackfillListCounts {
  pins: number;
  specs: number;
  tasks: number;
  subagents: number;
  subagentSteps: number;
}

export interface BackfillBotResult {
  oldId: string;
  newId: string;
  kind: IdMapKind;
  name: string;
  state: BackfillState;
  /** 2.x lines added (would be added). */
  add: number;
  /** 2.x lines whose id Botling 3 has already. */
  duplicates: number;
  /** 2.x lines that could not be made into a line (unreadable or too large), as the import skips them. */
  skipped: number;
  botling3Lines: number;
  /** Botling 3 lines older than every added 2.x line: they stay where they are. */
  kept: number;
  /** Botling 3 lines moved below the 2.x lines they are newer than (view unchanged). */
  moved: number;
  firstAdded: string | null;
  lastAdded: string | null;
  /** Items added to the bot's lists (Botling 3's own items are all kept). */
  lists: BackfillListCounts;
  content: { ready: number; failed: number };
  problems: string[];
}

export interface BackfillOptions {
  /** The 2.x source key (`sha256(real source path)`, as the import's markers use). */
  source?: string;
  now?: () => number;
  log?: (line: string) => void;
  content?: Pick<ContentService, "noteLine" | "afterCommit">;
  /** Old attachment URL -> URL of its copy under `<dataDir>/imported/` (`copyMedia`). */
  attachmentMap?: ReadonlyMap<string, string>;
}

export interface BackfillResult {
  bots: BackfillBotResult[];
}

type Merged<A, B> = { from: "2x"; item: A } | { from: "3"; item: B };

/** A time for every item: one without a usable time takes the time of the item before it on its own side. */
function carriedTimes<T>(items: readonly T[], timeOf: (item: T) => number): number[] {
  let last = Number.NEGATIVE_INFINITY;
  return items.map((item) => {
    const time = timeOf(item);
    if (Number.isFinite(time)) last = time;
    return last;
  });
}

/**
 * Merges the 2.x items into the Botling 3 items by time. Each side keeps its own order (a chat's order is not always
 * its time order: a reply moves below a line sent while it ran); at a tie the 2.x item comes first.
 */
export function mergeByTime<A, B>(
  incoming: readonly A[],
  existing: readonly B[],
  timeOfIncoming: (item: A) => number,
  timeOfExisting: (item: B) => number,
): Merged<A, B>[] {
  const a = carriedTimes(incoming, timeOfIncoming);
  const b = carriedTimes(existing, timeOfExisting);
  const out: Merged<A, B>[] = [];
  let i = 0;
  let j = 0;
  while (i < incoming.length && j < existing.length) {
    if (a[i]! <= b[j]!) out.push({ from: "2x", item: incoming[i++]! });
    else out.push({ from: "3", item: existing[j++]! });
  }
  while (i < incoming.length) out.push({ from: "2x", item: incoming[i++]! });
  while (j < existing.length) out.push({ from: "3", item: existing[j++]! });
  return out;
}

interface ExistingLine {
  msgId: string;
  seq: number;
  body: string;
  time: number;
}

function timeOfView(view: unknown): number {
  const time = (view as { time?: unknown } | null)?.time;
  return typeof time === "string" ? Date.parse(time) : Number.NaN;
}

function parseView(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface BotPlan {
  state: BackfillState;
  /** The meta marker as found ("lines": the log part of an earlier run committed; the rest is redone). */
  marker: string | undefined;
  incoming: PreparedLine[];
  duplicates: number;
  skipped: number;
  existing: ExistingLine[];
  /** The merged order from the first added 2.x line on (what is appended). */
  tail: Merged<PreparedLine, ExistingLine>[];
  kept: number;
  moved: ExistingLine[];
}

const metaOf = (db: Db, key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : undefined;
};

/** What a backfill of `chat` into `mapped.newId` does, read from `db` (a reader, or the writer command itself). */
function planBot(db: Db, chat: readonly ChatRecord[], bot: Read2xBot, mapped: IdMapRow, options: BackfillOptions): BotPlan {
  const source = options.source ?? "default";
  const empty = (state: BackfillState, marker?: string): BotPlan => ({
    state, marker, incoming: [], duplicates: 0, skipped: 0, existing: [], tail: [], kept: 0, moved: [],
  });
  if (metaOf(db, importBotMetaKey(source, bot.id)) === "done") return empty("imported");
  const marker = metaOf(db, backfillMetaKey(source, bot.id));
  if (marker === "done") return empty("already", marker);

  const existing: ExistingLine[] = db
    .prepare("SELECT msgId, seq, body FROM messages WHERE botId = ? ORDER BY seq")
    .all(mapped.newId)
    .map((row) => {
      const body = String(row.body);
      return { msgId: String(row.msgId), seq: Number(row.seq), body, time: timeOfView(parseView(body)) };
    });
  const known = new Set(existing.map((line) => line.msgId.toUpperCase()));

  const { prepared, skipped } = prepareLines(chat, mapped.newId, options.log, options.attachmentMap);
  const incoming: PreparedLine[] = [];
  let duplicates = 0;
  if (marker !== "lines") {
    for (const line of prepared) {
      const key = line.msgId.toUpperCase();
      if (known.has(key)) {
        duplicates += 1;
        continue;
      }
      known.add(key); // a line 2.x has twice is added once
      incoming.push(line);
    }
  }
  const merged = mergeByTime(incoming, existing, (line) => timeOfView(line.view), (line) => line.time);
  const first = merged.findIndex((item) => item.from === "2x");
  const tail = first < 0 ? [] : merged.slice(first);
  const moved = tail.flatMap((item) => (item.from === "3" ? [item.item] : []));
  return {
    state: incoming.length ? "added" : "nothing",
    marker,
    incoming,
    duplicates,
    skipped,
    existing,
    tail,
    kept: first < 0 ? existing.length : first,
    moved,
  };
}

interface Written {
  plan: BotPlan;
  added: PreparedLine[];
  skipped: number;
  noted: NotedLine[];
}

/** Appends the plan's entries in one writer command (`tx`): the moves first, then the merged tail in order. */
function writeLines(tx: Db, plan: BotPlan, newId: string, options: BackfillOptions): Written {
  const stream = ensureBot(tx, newId);
  const appendOpts = options.now ? { now: options.now() } : {};
  const noted: NotedLine[] = [];
  const added: PreparedLine[] = [];
  let skipped = 0;
  if (!plan.tail.length) return { plan, added, skipped, noted };

  if (plan.moved.length) {
    appendEntries(tx, stream, plan.moved.map((line) => ({ kind: "message.removed", body: { botId: newId, messageId: line.msgId } })), appendOpts);
  }
  const putFulltext = tx.prepare(
    "INSERT INTO fulltext (stream, key, seq, text) VALUES (?, ?, ?, ?) ON CONFLICT (stream, key) DO UPDATE SET seq = excluded.seq, text = excluded.text",
  );
  const moveFulltext = tx.prepare("UPDATE fulltext SET seq = ? WHERE stream = ? AND key = ?");
  for (const item of plan.tail) {
    let entryItem: AppendItem;
    let view: { id: string; text?: string; attachments?: ReadonlyArray<{ url: string; name?: string }> };
    if (item.from === "2x") {
      entryItem = { kind: "message.added", body: item.item.body };
      view = item.item.view;
    } else {
      const message = parseView(item.item.body);
      if (!message) throw new Error(`Botling 3 line ${item.item.msgId} of ${stream} has an unreadable body; nothing was changed`);
      // The stored view already fits one entry (it was cut when it was first written): it comes back unchanged.
      const fitted = fitBody("message.added", { botId: newId, message });
      if (fitted.dropped || canonicalJson((fitted.body as { message: unknown }).message) !== item.item.body) {
        throw new Error(`Botling 3 line ${item.item.msgId} of ${stream} would change when moved; nothing was changed`);
      }
      entryItem = { kind: "message.added", body: fitted.body };
      view = message as unknown as typeof view;
    }
    tx.exec("SAVEPOINT backfill_line");
    try {
      const [entry] = appendEntries(tx, stream, [entryItem], appendOpts);
      if (item.from === "2x") {
        if (item.item.full !== null) putFulltext.run(stream, item.item.msgId, entry!.seq, item.item.full);
      } else {
        moveFulltext.run(entry!.seq, stream, item.item.msgId);
      }
      const found = options.content ? options.content.noteLine(tx, newId, view, entry!) : null;
      tx.exec("RELEASE backfill_line");
      if (found) noted.push(found);
      if (item.from === "2x") added.push(item.item);
    } catch (error) {
      if (!tx.inTransaction) throw error;
      tx.exec("ROLLBACK TO backfill_line");
      tx.exec("RELEASE backfill_line");
      // A Botling 3 line must never be lost: it was removed above, so the whole command rolls back.
      if (item.from === "3") throw error;
      skipped += 1;
      options.log?.(`${stream}: skipped 2.x line ${item.item.msgId} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { plan, added, skipped, noted };
}

/** The key that tells two list items apart: their id when they have one, else their whole JSON. */
function itemKey(item: unknown): string {
  const idValue = item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "id") ? (item as { id: unknown }).id : undefined;
  return typeof idValue === "string" ? `id:${idValue.toUpperCase()}` : `json:${canonicalJson(item)}`;
}

/** The 2.x items Botling 3 does not have, in front of Botling 3's (all kept, in their order). */
function mergeItems(older: readonly unknown[], current: readonly unknown[]): { list: unknown[]; added: number } {
  const have = new Set(current.map(itemKey));
  const add: unknown[] = [];
  for (const item of older) {
    const key = itemKey(item);
    if (have.has(key)) continue;
    have.add(key);
    add.push(item);
  }
  return { list: [...add, ...current], added: add.length };
}

const LIST_NAMES = ["pins.json", "specs.json", "tasks.json"] as const;

interface CurrentLists {
  lists: Record<(typeof LIST_NAMES)[number], unknown[]>;
  subagentIds: Set<string>;
}

function readCurrentLists(db: Db, botId: string): CurrentLists {
  const read = (name: string): unknown[] => {
    const row = db.prepare("SELECT body FROM lists WHERE botId = ? AND name = ?").get(botId, name);
    if (!row) return [];
    try {
      const value = JSON.parse(String(row.body)) as unknown;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const subagentIds = new Set(
    db.prepare("SELECT key FROM rows WHERE stream = ? AND deleted = 0").all(`subagents:${botId}`).map((row) => String(row.key)),
  );
  return { lists: { "pins.json": read("pins.json"), "specs.json": read("specs.json"), "tasks.json": read("tasks.json") }, subagentIds };
}

function listCounts(chatData: Read2xChat, current: CurrentLists): BackfillListCounts {
  const newSubs = chatData.subagents.filter((sub) => !current.subagentIds.has(String(sub.index.id)));
  let subagentSteps = 0;
  for (const sub of newSubs) subagentSteps += sub.history.runs.reduce((n, run) => n + run.steps.length, 0) + sub.history.steps.length;
  return {
    pins: mergeItems(chatData.pins, current.lists["pins.json"]).added,
    specs: mergeItems(chatData.specs, current.lists["specs.json"]).added,
    tasks: mergeItems(chatData.tasks, current.lists["tasks.json"]).added,
    subagents: newSubs.length,
    subagentSteps,
  };
}

/** Adds the 2.x lists and subagents Botling 3 does not have, through the core's store. */
function writeLists(botStore: DbBotStore, chatData: Read2xChat): BackfillListCounts {
  const counts: BackfillListCounts = { pins: 0, specs: 0, tasks: 0, subagents: 0, subagentSteps: 0 };
  const older = { "pins.json": chatData.pins, "specs.json": chatData.specs, "tasks.json": chatData.tasks };
  for (const name of LIST_NAMES) {
    const merged = mergeItems(older[name], botStore.loadList(name));
    if (merged.added) botStore.saveList(name, merged.list);
    counts[name.replace(".json", "") as "pins" | "specs" | "tasks"] = merged.added;
  }
  const current = botStore.loadList("subagents.json");
  const have = new Set(current.map((item) => String((item as { id?: unknown }).id)));
  const newSubs = chatData.subagents.filter((sub) => !have.has(String(sub.index.id)));
  if (newSubs.length) {
    counts.subagentSteps = stageSubagents(botStore, newSubs);
    botStore.commitSubagents([...newSubs.map((sub) => sub.index), ...current]);
    counts.subagents = newSubs.length;
  }
  return counts;
}

/** The core's copy (newest HISTORY_LIMIT lines) gets the 2.x lines that are in the log now, merged the same way. */
function writeCoreCopy(botStore: DbBotStore, chat: readonly ChatRecord[], inLog: ReadonlySet<string>, attachmentMap?: ReadonlyMap<string, string>): void {
  const records = botStore.loadMessages().records;
  const have = new Set(records.map((record) => record.id.toUpperCase()));
  const older: ChatRecord[] = [];
  for (const record of chat) {
    const key = record.id.toUpperCase();
    if (have.has(key) || !inLog.has(key)) continue;
    have.add(key);
    older.push(attachmentMap?.size ? remapAttachments(record, attachmentMap) : record);
  }
  if (!older.length) return;
  const timeOf = (record: ChatRecord) => fromSwiftDate(record.date);
  botStore.saveMessages(mergeByTime(older, records, timeOf, timeOf).map((item) => item.item));
}

function isoRange(lines: readonly PreparedLine[]): { first: string | null; last: string | null } {
  const times = lines.map((line) => timeOfView(line.view)).filter(Number.isFinite);
  if (!times.length) return { first: null, last: null };
  return { first: new Date(Math.min(...times)).toISOString(), last: new Date(Math.max(...times)).toISOString() };
}

function resultOf(bot: Read2xBot, mapped: IdMapRow, plan: BotPlan, extra: Partial<BackfillBotResult> = {}): BackfillBotResult {
  const range = isoRange(plan.incoming);
  return {
    oldId: bot.id,
    newId: mapped.newId,
    kind: mapped.kind,
    name: mapped.name,
    state: plan.state,
    add: plan.incoming.length,
    duplicates: plan.duplicates,
    skipped: plan.skipped,
    botling3Lines: plan.existing.length,
    kept: plan.kept,
    moved: plan.moved.length,
    firstAdded: range.first,
    lastAdded: range.last,
    lists: { pins: 0, specs: 0, tasks: 0, subagents: 0, subagentSteps: 0 },
    content: { ready: 0, failed: 0 },
    problems: [],
    ...extra,
  };
}

async function backfillBot(
  store: Pick<ServerStore, "submit" | "openReader" | "meta">,
  stores: DbBotStores,
  bot: Read2xBot,
  mapped: IdMapRow,
  options: BackfillOptions,
): Promise<BackfillBotResult> {
  const source = options.source ?? "default";
  const chatData = readChat(bot);
  const written = await store.submit((tx) => {
    // Planned inside the command that writes, so it sees exactly what it changes.
    const plan = planBot(tx, chatData.chat, bot, mapped, options);
    if (plan.state === "imported" || plan.state === "already") return { plan, added: [], skipped: 0, noted: [] } as Written;
    const out = writeLines(tx, plan, mapped.newId, options);
    tx.prepare("INSERT INTO meta (key, value) VALUES (?, 'lines') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(backfillMetaKey(source, bot.id));
    return out;
  });
  const { plan } = written;
  if (plan.state === "imported" || plan.state === "already") return resultOf(bot, mapped, plan);

  const content = { ready: 0, failed: 0 };
  if (options.content) {
    for (const item of written.noted) {
      try {
        const ready = await options.content.afterCommit(item);
        content.ready += ready.length;
        content.failed += Math.max(0, item.files.length - ready.length);
      } catch (error) {
        content.failed += item.files.length;
        options.log?.(`bot:${mapped.newId}: content for line ${item.lineId} failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  const reader = store.openReader();
  let inLog: Set<string>;
  try {
    inLog = new Set(reader.prepare("SELECT msgId FROM messages WHERE botId = ?").all(mapped.newId).map((row) => String(row.msgId).toUpperCase()));
  } finally {
    reader.close();
  }
  const botStore = stores.open(mapped.newId, "");
  writeCoreCopy(botStore, chatData.chat, inLog, options.attachmentMap);
  const lists = writeLists(botStore, chatData);
  await botStore.durable();
  await store.submit((tx) => {
    tx.prepare("INSERT INTO meta (key, value) VALUES (?, 'done') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(backfillMetaKey(source, bot.id));
  });

  const problems = [...chatData.problems];
  if (plan.marker === "lines") problems.push(`${mapped.name}: an earlier backfill had added the lines; its core copy and lists were finished now`);
  const result = resultOf(bot, mapped, plan, { lists, content, problems });
  result.add = written.added.length;
  result.skipped = plan.skipped + written.skipped;
  if (!written.added.length && result.state === "added") result.state = "nothing";
  return result;
}

/** Backfills each of `bots` that the id map names as the Main bot or the Maintainer; every other bot is left alone. */
export async function backfillHistory(
  store: Pick<ServerStore, "submit" | "openReader" | "meta">,
  bots: readonly Read2xBot[],
  idMap: readonly IdMapRow[],
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const byOld = new Map(idMap.map((row) => [row.oldId.toUpperCase(), row]));
  const stores = new DbBotStores(store);
  const results: BackfillBotResult[] = [];
  try {
    for (const bot of bots) {
      const mapped = byOld.get(bot.id.toUpperCase());
      if (!mapped || !BACKFILL_KINDS.has(mapped.kind)) continue;
      results.push(await backfillBot(store, stores, bot, mapped, options));
    }
    await stores.durable();
  } finally {
    await stores.close();
  }
  return { bots: results };
}

/** What a backfill would do, read from `db` only (the dry run). */
export function planBackfill(db: Db, bots: readonly Read2xBot[], idMap: readonly IdMapRow[], options: BackfillOptions = {}): BackfillResult {
  const byOld = new Map(idMap.map((row) => [row.oldId.toUpperCase(), row]));
  const results: BackfillBotResult[] = [];
  for (const bot of bots) {
    const mapped = byOld.get(bot.id.toUpperCase());
    if (!mapped || !BACKFILL_KINDS.has(mapped.kind)) continue;
    const chatData = readChat(bot);
    const plan = planBot(db, chatData.chat, bot, mapped, options);
    const lists = plan.state === "imported" || plan.state === "already"
      ? { pins: 0, specs: 0, tasks: 0, subagents: 0, subagentSteps: 0 }
      : listCounts(chatData, readCurrentLists(db, mapped.newId));
    results.push(resultOf(bot, mapped, plan, { lists, problems: [...chatData.problems] }));
  }
  return { bots: results };
}

/**
 * The Main bot's and the Maintainer's Botling 3 ids for this source: the import's own id map when it saved one for
 * this source, else this folder's fixed ids (`ids.main`, `ids.maintainer`), as a designated import maps them.
 */
function backfillIdMap(db: Db, bots: readonly Read2xBot[], sourceHash: string, problems: string[]): IdMapRow[] {
  const stored = new Map(readIdMap(db, sourceHash).map((row) => [row.oldId.toUpperCase(), row]));
  const rows: IdMapRow[] = [];
  for (const bot of bots) {
    const upper = bot.id.toUpperCase();
    const fixed = upper === MAIN_BOT_ID ? { key: "ids.main", kind: "main" as const } : upper === MAINTAINER_ID ? { key: "ids.maintainer", kind: "maintainer" as const } : null;
    if (!fixed) continue;
    const saved = stored.get(upper);
    if (saved) {
      rows.push({ oldId: bot.id, newId: saved.newId, kind: saved.kind, name: bot.name });
      continue;
    }
    const newId = metaOf(db, fixed.key);
    if (newId === undefined) {
      problems.push(`${bot.name}: this Botling 3 folder has no ${fixed.key} yet (open Botling 3 once); not backfilled`);
      continue;
    }
    rows.push({ oldId: bot.id, newId, kind: fixed.kind, name: bot.name });
  }
  return rows;
}

export interface RunBackfillOptions {
  sourceDir: string;
  targetDir: string;
  dryRun?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface RunBackfillResult {
  dryRun: boolean;
  sourceRealPath: string;
  sourceHash: string;
  reportPath: string;
  reportText: string;
  /** The copy of server.db taken before anything was written (null in a dry run). */
  backupPath: string | null;
  bots: BackfillBotResult[];
  problems: string[];
}

function formatReport(data: {
  dryRun: boolean;
  sourceReal: string;
  target: string;
  reportPath: string;
  backupPath: string | null;
  bots: readonly BackfillBotResult[];
  mediaLines: readonly string[];
  problems: readonly string[];
}): string {
  const out: string[] = [];
  const total = data.bots.reduce((n, bot) => n + bot.add, 0);
  out.push(data.dryRun
    ? "Dry run: would add Botling 2 history to the Main bot and the Maintainer (read only; nothing was changed)."
    : "Added Botling 2 history to the Main bot and the Maintainer.");
  out.push(`From: ${JSON.stringify(data.sourceReal)} (read only)`);
  out.push(`Into: ${JSON.stringify(data.target)}`);
  if (data.backupPath) out.push(`Backup of server.db taken first: ${JSON.stringify(data.backupPath)}`);
  out.push(`Report: ${JSON.stringify(data.reportPath)}${data.dryRun ? " (not written: dry run)" : ""}`);
  out.push(`Lines: ${fmtCount(total)} ${data.dryRun ? "to add" : "added"}`);
  out.push("");
  out.push("Bots");
  if (!data.bots.length) out.push("  (none)");
  for (const bot of data.bots) {
    out.push(`  ${cleanName(bot.name)} [${bot.kind}] -> ${bot.newId}`);
    if (bot.state === "already") {
      out.push("    already backfilled from this folder; nothing to add");
      continue;
    }
    if (bot.state === "imported") {
      out.push("    brought over by the import itself; nothing to add");
      continue;
    }
    const range = bot.firstAdded && bot.lastAdded ? ` (${bot.firstAdded} to ${bot.lastAdded})` : "";
    out.push(`    add ${fmtCount(bot.add)} lines from Botling 2${range}`);
    out.push(`    already in Botling 3: ${fmtCount(bot.duplicates)} · unreadable or too large: ${fmtCount(bot.skipped)}`);
    out.push(
      `    Botling 3 lines: ${fmtCount(bot.botling3Lines)} (${fmtCount(bot.kept)} stay above, ${fmtCount(bot.moved)} move below the older lines, text unchanged)`,
    );
    const l = bot.lists;
    out.push(`    lists: pins +${fmtCount(l.pins)} · specs +${fmtCount(l.specs)} · tasks +${fmtCount(l.tasks)} · subagents +${fmtCount(l.subagents)} (${fmtCount(l.subagentSteps)} steps)`);
    if (!data.dryRun && (bot.content.ready || bot.content.failed)) {
      out.push(`    attachments indexed: ${fmtCount(bot.content.ready)}${bot.content.failed ? ` · ${fmtCount(bot.content.failed)} retried when botlingd starts` : ""}`);
    }
  }
  if (data.mediaLines.length) {
    out.push("");
    out.push("Media");
    for (const line of data.mediaLines) out.push(`  ${line}`);
  }
  if (data.problems.length) {
    out.push("");
    out.push("Problems");
    for (const problem of data.problems) out.push(`  - ${cleanName(problem)}`);
  }
  return `${out.join("\n")}\n`;
}

/** `botlingd backfill-history <2.x folder> [--dry-run]`. */
export async function runBackfill(options: RunBackfillOptions): Promise<RunBackfillResult> {
  const dryRun = options.dryRun === true;
  const sourceResolved = resolve(options.sourceDir);
  const targetResolved = resolve(options.targetDir);
  refuse2xData(targetResolved);
  if (!looksLike2x(sourceResolved)) throw new ImportError(`${sourceResolved} does not look like a Botling 2 data folder.`, 2);
  const sourceReal = realPath(sourceResolved);
  if (sameOrNested(realPathOrNearest(targetResolved), sourceReal)) {
    throw new ImportError("The backfill's source and target must be separate folders.", 2);
  }
  const dbFile = join(targetResolved, "server.db");
  if (!existsSync(dbFile)) throw new ImportError(`${targetResolved} has no Botling 3 data (server.db); nothing to backfill.`, 2);
  const sourceHash = sha256Text(sourceReal);
  const reportPath = join(targetResolved, "backfill-report.md");
  const running = holderPid(targetResolved) !== null;

  const read = read2x(sourceReal);
  const problems = [...read.problems];
  const fixedBots = read.bots.filter((bot) => bot.role === "main" || bot.id.toUpperCase() === MAINTAINER_ID);

  if (dryRun) {
    if (running) problems.push("botlingd is running: the counts can change before the backfill is applied (it needs botlingd stopped)");
    const reader = openReaderDb(dbFile);
    let planned: BackfillResult;
    let idMap: IdMapRow[];
    try {
      idMap = backfillIdMap(reader, fixedBots, sourceHash, problems);
      planned = planBackfill(reader, fixedBots, idMap, { source: sourceHash });
    } finally {
      reader.close();
    }
    for (const bot of planned.bots) problems.push(...bot.problems);
    const mediaLines = planned.bots.some((bot) => bot.state === "added") ? mediaDryRunReport(planMedia(fixedBots, idMap, sourceReal)) : [];
    const reportText = formatReport({ dryRun, sourceReal, target: targetResolved, reportPath, backupPath: null, bots: planned.bots, mediaLines, problems });
    return { dryRun, sourceRealPath: sourceReal, sourceHash, reportPath, reportText, backupPath: null, bots: planned.bots, problems };
  }

  if (running) throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  const guard = makeWriteGuard(sourceReal);
  guardTargetTop(targetResolved, guard);
  const lock = new DataDirLock(targetResolved, { version: BOTLINGD_VERSION, app: "botlingd backfill-history" });
  if (!lock.claim().ok) throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  try {
    const backupsDir = join(targetResolved, "backups");
    guard(backupsDir);
    const backupPath = await takeBackup(dbFile, backupsDir, "manual");
    const store = await openServerStore(targetResolved);
    let result: BackfillResult;
    let mediaLines: string[] = [];
    try {
      const serverId = store.meta("serverId");
      if (serverId === undefined) throw new ImportError("server.db has no serverId; open Botling 3 once before the backfill.", 2);
      let idMap: IdMapRow[];
      let planned: BackfillResult;
      const reader = store.openReader();
      try {
        idMap = backfillIdMap(reader, fixedBots, sourceHash, problems);
        planned = planBackfill(reader, fixedBots, idMap, { source: sourceHash });
      } finally {
        reader.close();
      }
      // Planned for both bots in the import's order (Main bot, then Maintainer, as read2x lists them), so each copy gets
      // the name the import gave it and a copy the import already made is reused, never a second one.
      let copied: ReturnType<typeof copyMedia> = { map: new Map(), failed: [], count: 0, bytes: 0 };
      if (planned.bots.some((bot) => bot.state === "added")) {
        const mediaPlan = planMedia(fixedBots, idMap, sourceReal);
        copied = copyMedia(mediaPlan, targetResolved, sourceHash);
        mediaLines = mediaReport(mediaPlan, copied);
      }
      const content = new ContentService({ store, dataDir: targetResolved, serverId, audit: (text) => options.log?.(`content: ${text}`) });
      try {
        result = await backfillHistory(store, fixedBots, idMap, {
          source: sourceHash,
          now: options.now,
          log: options.log,
          content,
          attachmentMap: copied.map,
        });
      } finally {
        await content.close().catch(() => undefined);
      }
    } finally {
      await store.close();
    }
    for (const bot of result.bots) {
      problems.push(...bot.problems);
      if (bot.content.failed) problems.push(`${bot.name}: ${bot.content.failed} attachment(s) could not be indexed; botlingd retries them when it starts.`);
    }
    const reportText = formatReport({ dryRun, sourceReal, target: targetResolved, reportPath, backupPath, bots: result.bots, mediaLines, problems });
    guard(reportPath);
    writeFileAtomic(reportPath, reportText);
    return { dryRun, sourceRealPath: sourceReal, sourceHash, reportPath, reportText, backupPath, bots: result.bots, problems };
  } finally {
    lock.release();
  }
}
