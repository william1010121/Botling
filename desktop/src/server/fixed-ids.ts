// Fixed bot ids (M5-04g, D74 Q-C2): each new server.db mints its own upper-case UUIDv4 for the main bot and the
// Maintainer (`meta` keys `ids.main`, `ids.maintainer`) once at folder creation. Pre-M5 dev folders keep the 2.x
// constants so their chats stay reachable.
import { randomUUID } from "node:crypto";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../core/store/records";
import type { Db } from "./store/sqlite";

const MAIN_KEY = "ids.main";
const MAINTAINER_KEY = "ids.maintainer";
const PARTIAL_ERROR = "server.db has only one of ids.main / ids.maintainer; restore it from a backup";

export interface FixedIds {
  main: string;
  maintainer: string;
}

export interface FixedIdsResult extends FixedIds {
  minted: boolean;
}

function readMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : undefined;
}

/** Reads the server's main bot and Maintainer ids from `server.db`, or `undefined` when neither key is written yet. */
export function readFixedIds(db: Db): FixedIds | undefined {
  const main = readMeta(db, MAIN_KEY);
  const maintainer = readMeta(db, MAINTAINER_KEY);
  if (main !== undefined && maintainer !== undefined) return { main, maintainer };
  if (main === undefined && maintainer === undefined) return undefined;
  throw new Error(PARTIAL_ERROR);
}

/**
 * Returns this folder's main bot and Maintainer ids, writing them into `meta` on the first start:
 * - both keys present -> keeps them;
 * - neither present and `created` -> mints two upper-case UUIDv4s (`minted: true`);
 * - neither present and not `created` -> persists the 2.x constants (`minted: false`);
 * - only one present -> throws so a partial db is never silently re-minted.
 */
export function fixedIds(tx: Db, options: { created: boolean }): FixedIdsResult {
  const existing = readFixedIds(tx);
  if (existing) {
    return {
      ...existing,
      minted: existing.main !== MAIN_BOT_ID || existing.maintainer !== MAINTAINER_ID,
    };
  }
  const put = tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  if (options.created) {
    const main = randomUUID().toUpperCase();
    let maintainer = randomUUID().toUpperCase();
    while (maintainer === main) maintainer = randomUUID().toUpperCase();
    put.run(MAIN_KEY, main);
    put.run(MAINTAINER_KEY, maintainer);
    return { main, maintainer, minted: true };
  }
  put.run(MAIN_KEY, MAIN_BOT_ID);
  put.run(MAINTAINER_KEY, MAINTAINER_ID);
  return { main: MAIN_BOT_ID, maintainer: MAINTAINER_ID, minted: false };
}
