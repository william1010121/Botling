// M6-01b: id mapping table for 2.x -> 3.x import (protocol v1 §14.3 D26, §14.4).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../src/core/store/records";
import {
  idMapClashes,
  liveBotIds,
  mapIds,
  readIdMap,
  saveIdMap,
  type Bot2xRef,
} from "../../src/server/import/id-map";
import { LATEST_SCHEMA_VERSION, openServerStore, schemaVersion, type ServerStore } from "../../src/server/store";

const UUID_V4_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

const dirs: string[] = [];
const stores: ServerStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "botling-id-map-"));
  dirs.push(dir);
  return dir;
}

async function openStore(): Promise<ServerStore> {
  const store = await openServerStore(tempDir());
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleBots(): Bot2xRef[] {
  return [
    { id: MAIN_BOT_ID, name: "Main bot", role: "main" },
    { id: MAINTAINER_ID, name: "Maintainer", role: "manager" },
    { id: "11111111-1111-4111-8111-111111111111", name: "Project Alpha", role: "manager" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Helper Bot", role: "bot" },
  ];
}

describe("mapIds (M6-01b)", () => {
  const mainId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const maintainerId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

  it("maps designated main -> mainId, Maintainer -> maintainerId, and keeps project/standalone bot ids", () => {
    const bots = sampleBots();
    const rows = mapIds(bots, { mainId, maintainerId, designated: true });

    expect(rows).toEqual([
      { oldId: MAIN_BOT_ID, newId: mainId, kind: "main", name: "Main bot" },
      { oldId: MAINTAINER_ID, newId: maintainerId, kind: "maintainer", name: "Maintainer" },
      { oldId: "11111111-1111-4111-8111-111111111111", newId: "11111111-1111-4111-8111-111111111111", kind: "bot", name: "Project Alpha" },
      { oldId: "22222222-2222-4222-8222-222222222222", newId: "22222222-2222-4222-8222-222222222222", kind: "bot", name: "Helper Bot" },
    ]);
    expect(idMapClashes(rows)).toEqual([]);
  });

  it("maps non-designated main to a fresh UUIDv4 with kind main-as-bot and name Main (old)", () => {
    const bots = sampleBots();
    const rows = mapIds(bots, { mainId, maintainerId, designated: false });

    expect(rows).toHaveLength(bots.length);
    const mainRow = rows.find((r) => r.oldId === MAIN_BOT_ID)!;
    expect(mainRow.kind).toBe("main-as-bot");
    expect(mainRow.name).toBe("Main (old)");
    expect(mainRow.newId).toMatch(UUID_V4_RE);
    expect(mainRow.newId).not.toBe(MAIN_BOT_ID);
    expect(mainRow.newId).not.toBe(mainId);
    expect(mainRow.clash).toBeUndefined();

    expect(rows.find((r) => r.oldId === MAINTAINER_ID)).toEqual({
      oldId: MAINTAINER_ID,
      newId: maintainerId,
      kind: "maintainer",
      name: "Maintainer",
    });
    expect(rows.find((r) => r.oldId === "11111111-1111-4111-8111-111111111111")?.newId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("re-mints a new UUIDv4 and reports a clash when a bot id already exists on this server", () => {
    const bots = sampleBots();
    const existingIds = new Set([
      mainId,
      maintainerId,
      "11111111-1111-4111-8111-111111111111",
    ]);

    const rows = mapIds(bots, { mainId, maintainerId, designated: true, existingIds });

    // Designated main and maintainer map to the server's own mainId/maintainerId without a clash.
    expect(rows.find((r) => r.oldId === MAIN_BOT_ID)?.clash).toBeUndefined();
    expect(rows.find((r) => r.oldId === MAINTAINER_ID)?.clash).toBeUndefined();

    const clashed = rows.find((r) => r.oldId === "11111111-1111-4111-8111-111111111111")!;
    expect(clashed.kind).toBe("bot");
    expect(clashed.name).toBe("Project Alpha");
    expect(clashed.newId).toMatch(UUID_V4_RE);
    expect(clashed.newId).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(clashed.clash).toBe(true);

    const nonClashed = rows.find((r) => r.oldId === "22222222-2222-4222-8222-222222222222")!;
    expect(nonClashed.newId).toBe("22222222-2222-4222-8222-222222222222");
    expect(nonClashed.clash).toBeUndefined();

    expect(idMapClashes(rows)).toEqual([clashed]);
  });

  it("also treats a bot colliding with target mainId/maintainerId or differing only by case as a clash", () => {
    const bots: Bot2xRef[] = [
      { id: MAIN_BOT_ID, name: "Main bot", role: "main" },
      { id: MAINTAINER_ID, name: "Maintainer", role: "manager" },
      { id: mainId.toLowerCase(), name: "Colliding Bot", role: "bot" },
      { id: "33333333-3333-4333-8333-333333333333", name: "Case Clash", role: "bot" },
    ];
    const rows = mapIds(bots, {
      mainId,
      maintainerId,
      designated: true,
      existingIds: ["33333333-3333-4333-8333-333333333333".toLowerCase()],
    });

    const clashes = idMapClashes(rows);
    expect(clashes.map((r) => r.oldId)).toEqual([
      mainId.toLowerCase(),
      "33333333-3333-4333-8333-333333333333",
    ]);
    for (const row of clashes) {
      expect(row.newId).toMatch(UUID_V4_RE);
      expect(row.newId.toUpperCase()).not.toBe(row.oldId.toUpperCase());
    }
  });

  it("produces a total mapping with unique newIds and rejects duplicate oldIds", () => {
    const bots = sampleBots();
    const rows = mapIds(bots, { mainId, maintainerId, designated: false });
    expect(rows.map((r) => r.oldId)).toEqual(bots.map((b) => b.id));
    expect(new Set(rows.map((r) => r.newId.toUpperCase())).size).toBe(rows.length);

    expect(() =>
      mapIds(
        [
          { id: "11111111-1111-4111-8111-111111111111", name: "A", role: "bot" },
          { id: "11111111-1111-4111-8111-111111111111", name: "B", role: "bot" },
        ],
        { mainId, maintainerId, designated: true },
      ),
    ).toThrow(/duplicate/i);
  });
});

describe("import_ids persistence (M6-01b)", () => {
  const mainId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const maintainerId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

  it("saves and reads back inside one transaction, and rejects a second save for the same source", async () => {
    const store = await openStore();
    const source = "sha256:source-a";
    const rows = mapIds(sampleBots(), { mainId, maintainerId, designated: true });

    const readInTx = await store.submit((tx) => {
      expect(schemaVersion(tx)).toBe(LATEST_SCHEMA_VERSION);
      saveIdMap(tx, source, rows);
      return readIdMap(tx, source);
    });

    expect(readInTx).toHaveLength(rows.length);
    for (const row of rows) {
      expect(readInTx).toContainEqual({
        oldId: row.oldId,
        newId: row.newId,
        kind: row.kind,
        source,
      });
    }

    // A second save for the same source must throw and leave the original rows untouched.
    await expect(store.submit((tx) => saveIdMap(tx, source, rows))).rejects.toThrow();

    // Even with a disjoint oldId, a second save for the same source must throw (once per source).
    await expect(
      store.submit((tx) =>
        saveIdMap(tx, source, [
          { oldId: "99999999-9999-4999-8999-999999999999", newId: "99999999-9999-4999-8999-999999999999", kind: "bot" },
        ]),
      ),
    ).rejects.toThrow();

    // Another source can be saved independently and read back without mixing sources.
    const otherSource = "sha256:source-b";
    const otherRows = mapIds(sampleBots(), {
      mainId,
      maintainerId,
      designated: false,
      existingIds: rows.map((r) => r.newId),
    });
    await store.submit((tx) => saveIdMap(tx, otherSource, otherRows));

    const reader = store.openReader();
    try {
      expect(readIdMap(reader, source)).toEqual(readInTx);
      const readOther = readIdMap(reader, otherSource);
      expect(readOther).toHaveLength(otherRows.length);
      expect(readOther.find((r) => r.oldId === MAIN_BOT_ID)?.kind).toBe("main-as-bot");
    } finally {
      reader.close();
    }
  });

  it("collects existing bot ids from server.db bots and bot:* streams", async () => {
    const store = await openStore();
    await store.submit((tx) => {
      tx.prepare("INSERT INTO bots (botId) VALUES (?)").run("11111111-1111-4111-8111-111111111111");
      tx.prepare("INSERT INTO streams (stream, owner, logId, head, state) VALUES (?, 'srv', 'log', 0, 'active')").run(
        "bot:22222222-2222-4222-8222-222222222222",
      );
      tx.prepare("INSERT INTO streams (stream, owner, logId, head, state) VALUES (?, 'srv', 'log', 0, 'active')").run(
        "srv:local",
      );
    });

    const reader = store.openReader();
    try {
      const existing = liveBotIds(reader);
      expect([...existing].sort()).toEqual([
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
    } finally {
      reader.close();
    }
  });
});
