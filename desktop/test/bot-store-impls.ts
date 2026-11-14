// Both BotStore implementations for parameterised store tests: 2.x's files and Botling 3's server.db rows.
// `useBotStores()` registers the hooks that open a fresh server.db per test (and close it after); `open(folder)` then
// gives the store of the bot kept in that folder. For the db store, opening the same folder again is a new store on
// the same bot (as `new BotStore(folder)` is a new store on the same files); `reopen()` closes server.db and opens it
// again, so only what was committed is left.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { BotStore, type BotStore as BotStoreApi } from "../src/core/store/bot-store";
import { DbBotStores } from "../src/server/botstore";
import { openServerStore, type ServerStore } from "../src/server/store";

export interface BotStoreImpl {
  readonly name: "file" | "db";
  open(folder: string): BotStoreApi;
  /** Waits until every write is durable, then drops every cache (db: closes and reopens server.db). */
  reopen(): Promise<void>;
}

let dataDir: string | undefined;
let server: ServerStore | undefined;
let hosts: DbBotStores | undefined;

async function closeDb() {
  if (hosts) { await hosts.durable(); await hosts.close(); hosts = undefined; }
  if (server) { await server.close(); server = undefined; }
}

async function openDb() {
  server = await openServerStore(dataDir!);
  hosts = new DbBotStores(server);
}

export const BOT_STORES: readonly BotStoreImpl[] = [
  { name: "file", open: (folder) => new BotStore(folder), reopen: async () => {} },
  {
    name: "db",
    open(folder) {
      if (!hosts) throw new Error("call useBotStores() in this test file");
      return hosts.open(folder, folder);
    },
    async reopen() { await closeDb(); await openDb(); },
  },
];

/** Opens a fresh server.db before each test and closes it after (the file store needs nothing). */
export function useBotStores(): void {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "botling-botstore-"));
    await openDb();
  });
  afterEach(async () => {
    try { await closeDb(); } finally {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });
}
