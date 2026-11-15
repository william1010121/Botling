// M5-04g: botlingd mints the main bot's and Maintainer's ids once per server.db.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_BOT_ID, MAINTAINER_ID, newId, toSwiftDate } from "../../src/core/store/records";
import { Botlingd, storeKeyOf } from "../../src/server/botlingd";
import { DbBotStores } from "../../src/server/botstore";
import { fixedIds, readFixedIds } from "../../src/server/fixed-ids";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { restoreBackup } from "../../src/server/restore";
import { openReaderDb, openServerStore } from "../../src/server/store";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop } from "../helpers";

const UUID_V4_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
const LEGACY_LOG_LINE = "ids: this data folder keeps the 2.x ids for its main bot and Maintainer (made before Botling 3 M5); a new folder gets its own.";
const PARTIAL_ERROR = "server.db has only one of ids.main / ids.maintainer; restore it from a backup";

describe("M5-04g: botlingd fixed ids", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  function makeDataDir(tag: string): string {
    const root = testRoot(`fixed-ids-${tag}`);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  async function startBotlingd(dataDir: string, logs: string[] = []): Promise<Botlingd> {
    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir: join(desktop, "out"),
      log: (line) => logs.push(line),
    });
    cleanups.push(() => daemon.stop());
    return daemon;
  }

  it("mints two distinct upper-case UUIDs on a fresh folder, passes them to Core, and keeps them on restart", async () => {
    const dataDir = makeDataDir("fresh");
    const logs1: string[] = [];
    const first = await startBotlingd(dataDir, logs1);

    const main1 = first.store.meta("ids.main");
    const maintainer1 = first.store.meta("ids.maintainer");
    expect(main1).toMatch(UUID_V4_UPPER);
    expect(maintainer1).toMatch(UUID_V4_UPPER);
    expect(main1).not.toBe(maintainer1);
    expect(main1).not.toBe(MAIN_BOT_ID);
    expect(maintainer1).not.toBe(MAINTAINER_ID);
    expect(logs1).not.toContain(LEGACY_LOG_LINE);

    const bots1 = first.core.snapshot().bots;
    expect(bots1.find((b) => b.id === main1)?.role).toBe("main");
    expect(bots1.find((b) => b.id === maintainer1)?.role).toBe("manager");
    expect(bots1.some((b) => b.id === MAIN_BOT_ID)).toBe(false);
    expect(bots1.some((b) => b.id === MAINTAINER_ID)).toBe(false);
    expect(first.core.mainBotId).toBe(main1);
    expect(first.core.maintainerId).toBe(maintainer1);
    const worldBots = (first.core as unknown as { plugins: { options: { world: { bots(): Array<{ id: string }> } } } }).plugins.options.world.bots();
    expect(worldBots.map((b) => b.id)).toContain("main");
    expect(worldBots.map((b) => b.id)).toContain(maintainer1);
    expect(worldBots.map((b) => b.id)).not.toContain(MAIN_BOT_ID);
    expect(worldBots.map((b) => b.id)).not.toContain(MAINTAINER_ID);

    await first.stop();

    const logs2: string[] = [];
    const second = await startBotlingd(dataDir, logs2);
    expect(second.store.meta("ids.main")).toBe(main1);
    expect(second.store.meta("ids.maintainer")).toBe(maintainer1);
    expect(second.core.mainBotId).toBe(main1);
    expect(second.core.maintainerId).toBe(maintainer1);
    expect(logs2).not.toContain(LEGACY_LOG_LINE);

    const db = openReaderDb(join(dataDir, "server.db"));
    try {
      expect(readFixedIds(db)).toEqual({ main: main1, maintainer: maintainer1 });
    } finally {
      db.close();
    }
  });

  it("keeps 2.x constants and existing chats on a pre-M5 folder, logging the notice once", async () => {
    const dataDir = makeDataDir("pre-m5");
    const identity = await loadOrCreateServerIdentity(dataDir, { create: true });
    const seedStore = await openServerStore(dataDir);
    await seedStore.submit((tx) => bindServerIdentity(tx, identity));
    const stores = new DbBotStores(seedStore);
    stores.open(MAIN_BOT_ID, join(dataDir, "main")).saveMessages([
      { id: newId(), role: "user", text: "history before M5-04g", date: toSwiftDate() },
    ]);
    stores.open(MAINTAINER_ID, join(dataDir, "projects", MAINTAINER_ID)).saveMessages([
      { id: newId(), role: "user", text: "maintainer before M5-04g", date: toSwiftDate() },
    ]);
    await stores.durable();
    await stores.close();
    await seedStore.close();

    const logs1: string[] = [];
    const first = await startBotlingd(dataDir, logs1);
    expect(first.store.meta("ids.main")).toBe(MAIN_BOT_ID);
    expect(first.store.meta("ids.maintainer")).toBe(MAINTAINER_ID);
    expect(logs1.filter((line) => line === LEGACY_LOG_LINE)).toHaveLength(1);
    expect(first.core.snapshot().bots.find((b) => b.id === MAIN_BOT_ID)?.role).toBe("main");
    expect(first.core.snapshot().bots.find((b) => b.id === MAINTAINER_ID)?.role).toBe("manager");
    expect(first.core.mainBot()?.lines().map((l) => l.text)).toContain("history before M5-04g");
    const maintBot = (first.core as unknown as { bot(id: string): { lines(): readonly { text: string }[] } | undefined }).bot(MAINTAINER_ID);
    expect(maintBot?.lines().map((l) => l.text)).toContain("maintainer before M5-04g");
    await first.stop();

    const logs2: string[] = [];
    const second = await startBotlingd(dataDir, logs2);
    expect(second.store.meta("ids.main")).toBe(MAIN_BOT_ID);
    expect(second.store.meta("ids.maintainer")).toBe(MAINTAINER_ID);
    expect(logs2).not.toContain(LEGACY_LOG_LINE);
    expect(second.core.mainBot()?.lines().map((l) => l.text)).toContain("history before M5-04g");
  });

  it("keys main and main/partner-* stores with the passed mainId", () => {
    const mainId = "11111111-1111-4111-8111-111111111111";
    expect(storeKeyOf("/d", "/d/main", mainId)).toBe(mainId);
    expect(storeKeyOf("/d", "/d/main/partner-codex", mainId)).toBe(`${mainId}/partner-codex`);
    expect(storeKeyOf("/d", "/d/projects/B1", mainId)).toBe("B1");
    expect(storeKeyOf("/d", "/d/projects/B1/partner-codex", mainId)).toBe("B1/partner-codex");
  });

  it("fails startup when only ids.main (or only ids.maintainer) is present", async () => {
    const dataDir = makeDataDir("partial-start");
    const identity = await loadOrCreateServerIdentity(dataDir, { create: true });
    const seedStore = await openServerStore(dataDir);
    await seedStore.submit((tx) => {
      bindServerIdentity(tx, identity);
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("ids.main", "22222222-2222-4222-8222-222222222222");
    });
    await seedStore.close();

    await expect(startBotlingd(dataDir)).rejects.toThrow(PARTIAL_ERROR);

    const onlyMaintDir = makeDataDir("partial-unit");
    const store2 = await openServerStore(onlyMaintDir);
    cleanups.push(() => store2.close());
    await store2.submit((tx) => {
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("ids.maintainer", "33333333-3333-4333-8333-333333333333");
    });
    await expect(store2.submit((tx) => fixedIds(tx, { created: false }))).rejects.toThrow(PARTIAL_ERROR);
    const reader = store2.openReader();
    try {
      expect(() => readFixedIds(reader)).toThrow(PARTIAL_ERROR);
    } finally {
      reader.close();
    }
  });

  it("leaves ids.* unchanged across backup and restore", async () => {
    const dataDir = makeDataDir("backup-restore");
    const first = await startBotlingd(dataDir);
    const mainId = first.store.meta("ids.main")!;
    const maintainerId = first.store.meta("ids.maintainer")!;
    const backupPath = await first.store.backup("manual");
    await first.stop();

    await restoreBackup(dataDir, backupPath);

    const db = openReaderDb(join(dataDir, "server.db"));
    try {
      expect(readFixedIds(db)).toEqual({ main: mainId, maintainer: maintainerId });
    } finally {
      db.close();
    }

    const restarted = await startBotlingd(dataDir);
    expect(restarted.store.meta("ids.main")).toBe(mainId);
    expect(restarted.store.meta("ids.maintainer")).toBe(maintainerId);
    expect(restarted.core.mainBotId).toBe(mainId);
    expect(restarted.core.maintainerId).toBe(maintainerId);
  });
});
