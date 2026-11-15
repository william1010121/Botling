import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_BOT_ID, type StepRecord } from "../../src/core/store/records";
import { encodeLine, INDEX_FORMAT, subagentFileName } from "../../src/core/store/subagent-store";
import { DbBotStores, readCommittedBot } from "../../src/server/botstore";
import { read2x } from "../../src/server/import";
import { importChats, importLists } from "../../src/server/import/chats";
import { mapIds } from "../../src/server/import/id-map";
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

const dirs: string[] = [];
const stores: ServerStore[] = [];
const botStoresList: DbBotStores[] = [];

function tempDir(prefix = "botling-import-lists-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function openStore(dir = tempDir("botling-import-lists-db-")): Promise<ServerStore> {
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

describe("2.x lists and subagents import (M6-02a)", () => {
  it("copies pins, specs, and tasks through DbBotStore so they read back equal and pins keep line ids", async () => {
    const src = join(tempDir(), "v2");
    const fx = make2xFolder(src);
    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const store = await openStore();
    const result = await importChats(store, data.bots, idMap, { source: "sha256:lists-1" });

    const mainResult = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;
    expect(mainResult.lists).toMatchObject({
      pins: fx.mainPins.length,
      missingPinLines: 0,
      specs: fx.mainSpecs.length,
      tasks: fx.mainTasks.length,
      subagents: 1,
      subagentSteps: 1,
    });
    expect(result.totalPins).toBe(fx.mainPins.length);
    expect(result.totalMissingPinLines).toBe(0);
    expect(result.totalSpecs).toBe(fx.mainSpecs.length);
    expect(result.totalTasks).toBe(fx.mainTasks.length);
    expect(result.totalSubagents).toBe(1);

    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);
    const mainDbStore = storesView.open(TARGET_MAIN_ID, "");

    expect(mainDbStore.loadList("pins.json")).toEqual(fx.mainPins);
    expect(mainDbStore.loadList("specs.json")).toEqual(fx.mainSpecs);
    expect(mainDbStore.loadList("tasks.json")).toEqual(fx.mainTasks);

    // Pin kept its exact messageId from 2.x, matching the imported chat line id
    const pin = mainDbStore.loadList("pins.json")[0] as { messageId: string };
    expect(pin.messageId).toBe(fx.mainMessages[1]!.id);
    expect(mainDbStore.loadMessages().records.some((r) => r.id === pin.messageId)).toBe(true);

    // Committed server.db snapshot matches
    const reader = store.openReader();
    try {
      const committed = readCommittedBot(reader, TARGET_MAIN_ID);
      expect(committed.lists["pins.json"]).toEqual(fx.mainPins);
      expect(committed.lists["specs.json"]).toEqual(fx.mainSpecs);
      expect(committed.lists["tasks.json"]).toEqual(fx.mainTasks);
    } finally {
      reader.close();
    }
  });

  it("imports a subagent with 3 steps (plus earlier run boundary and patch) so index and steps read back equal", async () => {
    const src = join(tempDir(), "v2-subagents");
    make2xFolder(src, { projectCount: 0, standaloneCount: 0 });
    const mainDir = join(src, "main");
    mkdirSync(join(mainDir, "subagents"), { recursive: true });

    const sub1Index = {
      id: "sub-3-steps",
      name: "Analyst",
      status: "done",
      startedAt: Date.UTC(2026, 0, 1, 13, 0, 0),
      endedAt: Date.UTC(2026, 0, 1, 13, 5, 0),
      prompt: "Analyze codebase",
      result: "Done",
      runs: 1,
    };
    const sub2Index = {
      id: "sub-empty",
      name: "Watcher",
      status: "done",
      startedAt: Date.UTC(2026, 0, 1, 14, 0, 0),
    };
    const earlierStep: StepRecord = {
      id: "prev-1",
      kind: "tool",
      tool: "Grep",
      title: "Search old",
      failed: false,
      done: true,
    };
    const steps: StepRecord[] = [
      { id: "step-1", kind: "tool", tool: "Read", title: "Read file A", failed: false, done: false },
      { id: "step-2", kind: "text", title: "Thinking", detail: "Checking edges", failed: false, done: true },
      { id: "step-3", kind: "tool", tool: "Bash", title: "Run check", failed: false, done: true, output: "ok" },
    ];

    writeFileSync(
      join(mainDir, "subagents.json"),
      JSON.stringify({ format: INDEX_FORMAT, subagents: [sub1Index, sub2Index] }),
    );
    writeFileSync(
      join(mainDir, "subagents", subagentFileName("sub-3-steps")),
      [
        encodeLine({ k: "step", step: earlierStep }),
        encodeLine({ k: "run", run: { prompt: "Initial pass", status: "done", startedAt: 100, endedAt: 200 } }),
        encodeLine({ k: "step", step: steps[0]! }),
        encodeLine({ k: "patch", id: "step-1", set: { done: true, output: "file A body" } }),
        encodeLine({ k: "step", step: steps[1]! }),
        encodeLine({ k: "step", step: steps[2]! }),
      ].join("\n") + "\n",
    );

    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const store = await openStore();
    const result = await importChats(store, data.bots, idMap, { source: "sha256:lists-sub" });
    const mainResult = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;
    expect(mainResult.lists.subagents).toBe(2);
    expect(mainResult.lists.subagentSteps).toBe(4);

    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);
    const mainDbStore = storesView.open(TARGET_MAIN_ID, "");

    expect(mainDbStore.loadList("subagents.json")).toEqual([sub1Index, sub2Index]);
    const history = mainDbStore.readSubagentSteps("sub-3-steps");
    expect(history.runs).toEqual([
      {
        run: { prompt: "Initial pass", status: "done", startedAt: 100, endedAt: 200 },
        steps: [earlierStep],
      },
    ]);
    expect(history.steps).toEqual([
      { ...steps[0]!, done: true, output: "file A body" },
      steps[1]!,
      steps[2]!,
    ]);
    expect(mainDbStore.readSubagentSteps("sub-empty")).toEqual({ runs: [], steps: [] });
  });

  it("keeps and counts pins whose chat line is missing (outside the history limit)", async () => {
    const src = join(tempDir(), "v2-missing-pin");
    const fx = make2xFolder(src, { projectCount: 0, standaloneCount: 0 });
    const missingId1 = "99999999-0000-4000-8000-000000000001";
    const missingId2 = "99999999-0000-4000-8000-000000000002";

    const pins = [
      fx.mainPins[0]!,
      { id: "99999999-0000-4000-8000-000000000011", messageId: missingId1, name: "old-card-1", data: "{\"a\":1}", size: "2x2" },
      { id: "99999999-0000-4000-8000-000000000012", messageID: missingId2, name: "old-card-2", data: "{\"b\":2}", size: "1x1" },
      { id: "99999999-0000-4000-8000-000000000013", name: "picker-card", data: "null", size: "2x2" },
    ];
    writeFileSync(join(src, "main", "pins.json"), JSON.stringify(pins, null, 2));

    const data = read2x(src);
    const idMap = mapIds(data.bots, {
      mainId: TARGET_MAIN_ID,
      maintainerId: TARGET_MAINTAINER_ID,
      designated: true,
    });

    const store = await openStore();
    const result = await importChats(store, data.bots, idMap, { source: "sha256:lists-missing" });
    const mainResult = result.bots.find((b) => b.oldId === MAIN_BOT_ID)!;

    expect(mainResult.lists.pins).toBe(4);
    expect(mainResult.lists.missingPinLines).toBe(2);
    expect(result.totalPins).toBe(4);
    expect(result.totalMissingPinLines).toBe(2);

    const storesView = new DbBotStores(store);
    botStoresList.push(storesView);
    const mainDbStore = storesView.open(TARGET_MAIN_ID, "");
    expect(mainDbStore.loadList("pins.json")).toEqual(pins);

    // Direct importLists call also keeps and counts missing pin lines
    const directStore = await openStore();
    const directStoresView = new DbBotStores(directStore);
    botStoresList.push(directStoresView);
    const directBotStore = directStoresView.open(TARGET_MAIN_ID, "");
    const direct = await importLists(directBotStore, data.bots[0]!);
    expect(direct.pins).toBe(4);
    expect(direct.missingPinLines).toBe(2);
    expect(directBotStore.loadList("pins.json")).toEqual(pins);
  });

  it("never writes or touches the source folder even when permissions are read-only", async () => {
    const src = join(tempDir(), "v2-ro");
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
      await importChats(store, data.bots, idMap, { source: "sha256:lists-ro" });
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    expect(collectFiles(src)).toEqual(before);
  });
});
