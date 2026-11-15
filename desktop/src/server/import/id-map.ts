// 2.x -> 3.x bot id mapping table (protocol v1 §14.3 D26, §14.4; M6-01b).
//
// 2.x uses fixed ids for the main bot (MAIN_BOT_ID) and the Maintainer (MAINTAINER_ID), while project bots and
// standalone bots already have random UUIDs. On import:
// - the designated server maps the 2.x main bot to this server's minted mainId;
// - any other server turns its 2.x main bot into an ordinary bot named "Main (old)" with a fresh UUIDv4 (D26);
// - the 2.x Maintainer maps to this server's minted maintainerId;
// - every other bot keeps its own id unless it clashes with a live bot on this server, in which case a fresh UUIDv4
//   is minted and the clash is flagged for the import report.
//
// Once M6-01a (`reader-2x.ts`) is merged, `Bot2xRef` can be replaced by `Read2x["bots"][number]`; the structural shape
// here is already compatible with it.
import { randomUUID } from "node:crypto";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../core/store/records";
import type { Db } from "../store/sqlite";

export interface Bot2xRef {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  folder?: string;
  chatDir?: string;
  standalone?: boolean;
}

export type IdMapKind = "main" | "maintainer" | "main-as-bot" | "bot";

export interface IdMapTarget {
  mainId: string;
  maintainerId: string;
  designated: boolean;
  /** Existing bot ids already live on this server (e.g. from `liveBotIds(db)`). */
  existingIds?: ReadonlySet<string> | Iterable<string>;
}

export interface IdMapRow {
  oldId: string;
  newId: string;
  kind: IdMapKind;
  name: string;
  /** Set when `oldId` already existed as a live bot (or collided) and had to be re-minted. */
  clash?: boolean;
}

export interface StoredIdMapRow {
  oldId: string;
  newId: string;
  kind: IdMapKind;
  source: string;
}

function freshUuid(reservedUpper: Set<string>): string {
  while (true) {
    const id = randomUUID().toUpperCase();
    if (!reservedUpper.has(id)) {
      reservedUpper.add(id);
      return id;
    }
  }
}

export function mapIds(bots: readonly Bot2xRef[], target: IdMapTarget): IdMapRow[] {
  const seenOld = new Set<string>();
  for (const bot of bots) {
    const key = bot.id.toUpperCase();
    if (seenOld.has(key)) {
      throw new Error(`Duplicate 2.x bot id in import input: ${bot.id}`);
    }
    seenOld.add(key);
  }

  // Reserve existing live bots and this server's own target main/maintainer ids so no ordinary bot or main-as-bot can
  // collide with them. Designated main -> target.mainId and Maintainer -> target.maintainerId are intentional targets,
  // never clashes.
  const usedUpper = new Set<string>();
  if (target.existingIds) {
    for (const id of target.existingIds) usedUpper.add(id.toUpperCase());
  }
  usedUpper.add(target.mainId.toUpperCase());
  usedUpper.add(target.maintainerId.toUpperCase());

  const reservedForFresh = new Set<string>(usedUpper);
  for (const bot of bots) reservedForFresh.add(bot.id.toUpperCase());

  const rows: IdMapRow[] = [];
  for (const bot of bots) {
    const upper = bot.id.toUpperCase();
    if (bot.role === "main" || upper === MAIN_BOT_ID) {
      if (target.designated) {
        rows.push({
          oldId: bot.id,
          newId: target.mainId,
          kind: "main",
          name: bot.name,
        });
      } else {
        const newId = freshUuid(reservedForFresh);
        usedUpper.add(newId.toUpperCase());
        rows.push({
          oldId: bot.id,
          newId,
          kind: "main-as-bot",
          name: "Main (old)",
        });
      }
      continue;
    }

    if (upper === MAINTAINER_ID) {
      rows.push({
        oldId: bot.id,
        newId: target.maintainerId,
        kind: "maintainer",
        name: bot.name,
      });
      continue;
    }

    if (usedUpper.has(upper)) {
      const newId = freshUuid(reservedForFresh);
      usedUpper.add(newId.toUpperCase());
      rows.push({
        oldId: bot.id,
        newId,
        kind: "bot",
        name: bot.name,
        clash: true,
      });
    } else {
      usedUpper.add(upper);
      rows.push({
        oldId: bot.id,
        newId: bot.id,
        kind: "bot",
        name: bot.name,
      });
    }
  }

  return rows;
}

export function idMapClashes(rows: readonly IdMapRow[]): IdMapRow[] {
  return rows.filter((row) => row.clash === true);
}

/** Collects existing bot ids already present in server.db (`bots` table and `bot:*` streams). */
export function liveBotIds(db: Db): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare("SELECT botId FROM bots").all()) {
    if (typeof row.botId === "string" && row.botId) ids.add(row.botId);
  }
  for (const row of db.prepare("SELECT substr(stream, 5) AS botId FROM streams WHERE stream LIKE 'bot:%'").all()) {
    if (typeof row.botId === "string" && row.botId) ids.add(row.botId);
  }
  return ids;
}

/**
 * Persists the id mapping for `source` inside `tx`.
 * Throws if `source` already has any mapped rows (an import runs at most once per source, Q-M6-C1) or on PK conflict.
 */
export function saveIdMap(
  tx: Db,
  source: string,
  rows: readonly Pick<IdMapRow, "oldId" | "newId" | "kind">[],
): void {
  const existing = tx.prepare("SELECT 1 FROM import_ids WHERE source = ? LIMIT 1").get(source);
  if (existing) {
    throw new Error(`import id map already recorded for source: ${source}`);
  }
  const insert = tx.prepare("INSERT INTO import_ids (oldId, newId, kind, source) VALUES (?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(row.oldId, row.newId, row.kind, source);
  }
}

export function readIdMap(db: Db, source: string): StoredIdMapRow[] {
  const rows = db
    .prepare("SELECT oldId, newId, kind, source FROM import_ids WHERE source = ? ORDER BY oldId")
    .all(source);
  return rows.map((row) => ({
    oldId: String(row.oldId),
    newId: String(row.newId),
    kind: String(row.kind) as IdMapKind,
    source: String(row.source),
  }));
}
