// M6-02c: import 2.x folders.json, approved-commands.json, and check alwaysAllowed (bot.json -> bots.settings).
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../src/core/store/records";
import { DbBotStores } from "../../src/server/botstore";
import { importApprovals, remapApprovalPath } from "../../src/server/import/approvals";
import type { IdMapRow } from "../../src/server/import/id-map";
import { openServerStore, type ServerStore } from "../../src/server/store";

const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "22222222-2222-4222-8222-222222222222";
const MAPPED_MAIN = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const MAPPED_MAINTAINER = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const REMAPPED_BOT_A = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";

const dirs: string[] = [];
const roSources: string[] = [];
const cores: Core[] = [];
const stores: ServerStore[] = [];

function tempDir(prefix = "botling-approvals-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [relative(base, full)];
  });
}

function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of listFiles(dir).sort()) {
    const full = join(dir, file);
    const stat = statSync(full);
    const sha = createHash("sha256").update(readFileSync(full)).digest("hex");
    out[file] = `${stat.size}:${stat.mtimeMs}:${sha}`;
  }
  return out;
}

function setWritable(dir: string, writable: boolean): void {
  if (!existsSync(dir)) return;
  const files = listFiles(dir);
  const subdirs = new Set<string>([dir]);
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    while (parts.length > 0) {
      subdirs.add(join(dir, ...parts));
      parts.pop();
    }
  }
  if (writable) {
    for (const folder of [...subdirs].sort((a, b) => a.length - b.length)) chmodSync(folder, 0o755);
    for (const file of files) chmodSync(join(dir, file), 0o644);
  } else {
    for (const file of files) chmodSync(join(dir, file), 0o444);
    for (const folder of [...subdirs].sort((a, b) => b.length - a.length)) chmodSync(folder, 0o555);
  }
}

function openCore(dataDir: string): Core {
  const core = new Core({
    dataDir,
    headConfig() {
      throw new Error("No agent allowed");
    },
    emit() {},
    deferStartup: true,
    routineTickMs: 0,
    componentScanMs: 0,
    waitingScanMs: 0,
    watchMs: 0,
    quitTidyMs: 0,
  });
  cores.push(core);
  return core;
}

function installDummyFramePlugin(dataDir: string, name = "test-panel"): void {
  const pluginDir = join(dataDir, "plugins", name);
  mkdirSync(join(pluginDir, "dist"), { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name,
      displayName: "Test Panel",
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: {
        web: "dist/web.js",
        permissions: ["messages"],
      },
    }),
  );
  writeFileSync(join(pluginDir, "dist", "web.js"), "export function activate() {}");
}

afterEach(async () => {
  for (const source of roSources.splice(0)) setWritable(source, true);
  for (const core of cores.splice(0)) await core.shutdown();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M6-02c: importApprovals", () => {
  it("keeps folders outside the 2.x data folder unchanged and filters invalid entries", () => {
    const source = tempDir("src-outside-");
    const target = tempDir("tgt-outside-");
    const outsideTools = "/opt/shared/tools";
    const outsideRepo = "/var/tmp/external-repo";
    // Sibling folder sharing a string prefix with `source` is NOT inside `source`.
    const siblingPrefix = `${source}-sibling/work`;

    writeFileSync(
      join(source, "folders.json"),
      JSON.stringify([outsideTools, siblingPrefix, "relative/folder", 42, outsideTools]),
    );
    writeFileSync(
      join(source, "approved-commands.json"),
      JSON.stringify({
        [outsideRepo]: ["git status --short", "", "npm test"],
        [siblingPrefix]: ["ls -la"],
        "relative/path": ["should-be-dropped"],
        [outsideTools]: [],
      }),
    );

    const report = importApprovals({ sourceDir: source, targetDir: target });

    expect(report.problems).toEqual([]);
    expect(report.folders).toEqual([outsideTools, siblingPrefix]);
    expect(report.movedFolders).toEqual([]);
    expect(report.approvedCommands).toEqual({
      [outsideRepo]: ["git status --short", "npm test"],
      [siblingPrefix]: ["ls -la"],
    });
    expect(report.movedCommandFolders).toEqual([]);

    expect(JSON.parse(readFileSync(join(target, "folders.json"), "utf8"))).toEqual([
      outsideTools,
      siblingPrefix,
    ]);
    expect(JSON.parse(readFileSync(join(target, "approved-commands.json"), "utf8"))).toEqual({
      [outsideRepo]: ["git status --short", "npm test"],
      [siblingPrefix]: ["ls -la"],
    });
  });

  it("moves the main bot's folder and standalone bot folders inside 2.x to their new places", () => {
    const source = tempDir("src-move-");
    const target = tempDir("tgt-move-");
    const sourceMain = join(source, "main");
    const sourceMainSub = join(source, "main", "notes");
    const sourceStandalone = join(source, "bots", BOT_A);
    mkdirSync(sourceMainSub, { recursive: true });
    mkdirSync(sourceStandalone, { recursive: true });

    writeFileSync(
      join(source, "folders.json"),
      JSON.stringify([`${sourceMain}/`, sourceStandalone, "/opt/outside"]),
    );
    writeFileSync(
      join(source, "approved-commands.json"),
      JSON.stringify({
        [sourceMain]: ["python3 cpu.py"],
        [sourceMainSub]: ["cat summary.txt"],
        [sourceStandalone]: ["echo hi"],
      }),
    );

    // Designated server: main stays `<target>/main`, un-clashed standalone stays `<target>/bots/<BOT_A>`.
    const designatedMap: IdMapRow[] = [
      { oldId: MAIN_BOT_ID, newId: MAPPED_MAIN, kind: "main", name: "Main bot" },
      { oldId: MAINTAINER_ID, newId: MAPPED_MAINTAINER, kind: "maintainer", name: "Maintainer" },
      { oldId: BOT_A, newId: BOT_A, kind: "bot", name: "Standalone A" },
    ];

    const report = importApprovals({
      sourceDir: source,
      targetDir: target,
      idMap: designatedMap,
    });

    const targetMain = join(target, "main");
    const targetMainSub = join(target, "main", "notes");
    const targetStandalone = join(target, "bots", BOT_A);

    expect(report.folders).toEqual([targetMain, targetStandalone, "/opt/outside"]);
    expect(report.movedFolders).toEqual([
      { from: sourceMain, to: targetMain },
      { from: sourceStandalone, to: targetStandalone },
    ]);
    expect(report.approvedCommands).toEqual({
      [targetMain]: ["python3 cpu.py"],
      [targetMainSub]: ["cat summary.txt"],
      [targetStandalone]: ["echo hi"],
    });

    // Non-designated server (`main-as-bot`) and clashed standalone bot (`BOT_A -> REMAPPED_BOT_A`).
    const nonDesignatedTarget = tempDir("tgt-nondesignated-");
    const nonDesignatedMap: IdMapRow[] = [
      { oldId: MAIN_BOT_ID, newId: MAPPED_MAIN, kind: "main-as-bot", name: "Main (old)" },
      { oldId: MAINTAINER_ID, newId: MAPPED_MAINTAINER, kind: "maintainer", name: "Maintainer" },
      { oldId: BOT_A, newId: REMAPPED_BOT_A, kind: "bot", name: "Standalone A", clash: true },
    ];

    const report2 = importApprovals({
      sourceDir: source,
      targetDir: nonDesignatedTarget,
      idMap: nonDesignatedMap,
    });

    expect(report2.folders).toEqual([
      join(nonDesignatedTarget, "bots", MAPPED_MAIN),
      join(nonDesignatedTarget, "bots", REMAPPED_BOT_A),
      "/opt/outside",
    ]);
    expect(report2.approvedCommands).toEqual({
      [join(nonDesignatedTarget, "bots", MAPPED_MAIN)]: ["python3 cpu.py"],
      [join(nonDesignatedTarget, "bots", MAPPED_MAIN, "notes")]: ["cat summary.txt"],
      [join(nonDesignatedTarget, "bots", REMAPPED_BOT_A)]: ["echo hi"],
    });
  });

  it("keeps approved commands approved when queried through Core (commandApproval) and approved folders in Maintainer", () => {
    const source = tempDir("src-core-");
    const target = tempDir("tgt-core-");
    const sourceMain = join(source, "main");
    mkdirSync(sourceMain, { recursive: true });

    writeFileSync(join(source, "folders.json"), JSON.stringify(["/opt/docs", sourceMain]));
    writeFileSync(
      join(source, "approved-commands.json"),
      JSON.stringify({
        [sourceMain]: ["git diff --stat", "Detail command: git show {hash}"],
      }),
    );

    importApprovals({ sourceDir: source, targetDir: target });
    installDummyFramePlugin(target, "test-panel");

    const core = openCore(target);
    const targetMain = join(target, "main");

    // Maintainer reads imported folders.json.
    expect(core.maintainer.approvedFolders()).toEqual(["/opt/docs", targetMain]);

    // Core's PluginWorld.commandApproval (via Plugins.approvalAsk) sees the moved main command as approved.
    expect(core.plugins.approvalAsk("test-panel", MAIN_BOT_ID, "git diff --stat", targetMain)).toEqual({
      needsApproval: null,
    });
    // Nothing is approved that 2.x did not approve.
    expect(core.plugins.approvalAsk("test-panel", MAIN_BOT_ID, "rm -rf /tmp/nope", targetMain)).toEqual({
      needsApproval: {
        command: "rm -rf /tmp/nope",
        folder: targetMain,
        detail: null,
        card: "Test Panel",
      },
    });
  });

  it("leaves the 2.x source folder completely unchanged (files, sizes, mtimes, sha256 under read-only perms)", () => {
    const source = tempDir("src-ro-");
    const target = tempDir("tgt-ro-");
    const sourceMain = join(source, "main");
    mkdirSync(sourceMain, { recursive: true });

    writeFileSync(join(source, "folders.json"), JSON.stringify(["/opt/read-me", sourceMain]));
    writeFileSync(
      join(source, "approved-commands.json"),
      JSON.stringify({
        [sourceMain]: ["git status"],
      }),
    );
    writeFileSync(join(sourceMain, "bot.json"), JSON.stringify({ alwaysAllowed: ["WebFetch"] }));

    const before = fingerprint(source);
    setWritable(source, false);
    roSources.push(source);

    const report = importApprovals({
      sourceDir: source,
      targetDir: target,
      bots: [{ oldId: MAIN_BOT_ID, newId: MAPPED_MAIN, name: "Main bot", chatDir: sourceMain }],
    });

    setWritable(source, true);
    expect(fingerprint(source)).toEqual(before);
    expect(listFiles(source).sort()).toEqual(Object.keys(before));
    setWritable(source, false);

    expect(report.problems).toEqual([]);
    expect(report.alwaysAllowedCount).toBe(1);
  });

  it("verifies bot.json alwaysAllowed entries in server.db and reports missing files or broken JSON without crashing", async () => {
    const source = tempDir("src-always-");
    const target = tempDir("tgt-always-");
    const sourceMain = join(source, "main");
    const sourceBotB = join(source, "projects", BOT_B);
    mkdirSync(sourceMain, { recursive: true });
    mkdirSync(sourceBotB, { recursive: true });

    writeFileSync(
      join(sourceMain, "bot.json"),
      JSON.stringify({ model: "sonnet", alwaysAllowed: ["WebFetch", "Bash(npm test)"] }),
    );
    writeFileSync(
      join(sourceBotB, "bot.json"),
      JSON.stringify({ model: "opus", alwaysAllowed: ["Edit(//opt/work/notes.md)"] }),
    );

    const store = await openServerStore(target);
    stores.push(store);
    const botStores = new DbBotStores(store);
    const mainDbStore = botStores.open(MAPPED_MAIN, join(target, "main"));
    mainDbStore.saveSetting("alwaysAllowed", ["WebFetch", "Bash(npm test)"]);
    // Intentionally omit alwaysAllowed for BOT_B to verify detection of missing entries.
    const botBDbStore = botStores.open(BOT_B, join(target, "projects", BOT_B));
    botBDbStore.saveSetting("model", "opus");
    await botStores.durable();

    const db = store.openReader();
    try {
      const report = importApprovals({
        sourceDir: source,
        targetDir: target,
        db,
        bots: [
          { oldId: MAIN_BOT_ID, newId: MAPPED_MAIN, name: "Main bot", chatDir: sourceMain },
          { oldId: BOT_B, newId: BOT_B, name: "Bot B", chatDir: sourceBotB },
        ],
      });

      expect(report.alwaysAllowed).toEqual([
        {
          oldId: MAIN_BOT_ID,
          newId: MAPPED_MAIN,
          name: "Main bot",
          expected: ["WebFetch", "Bash(npm test)"],
          present: ["WebFetch", "Bash(npm test)"],
          missing: [],
        },
        {
          oldId: BOT_B,
          newId: BOT_B,
          name: "Bot B",
          expected: ["Edit(//opt/work/notes.md)"],
          present: [],
          missing: ["Edit(//opt/work/notes.md)"],
        },
      ]);
      expect(report.alwaysAllowedCount).toBe(3);
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toContain("Bot B");
      expect(report.problems[0]).toContain("alwaysAllowed");
    } finally {
      db.close();
    }

    // Broken JSON files are reported in problems and never crash or write invalid files.
    const brokenSrc = tempDir("src-broken-");
    const brokenTgt = tempDir("tgt-broken-");
    writeFileSync(join(brokenSrc, "folders.json"), "{not valid json");
    writeFileSync(join(brokenSrc, "approved-commands.json"), "[1, 2, 3]");

    const brokenReport = importApprovals({ sourceDir: brokenSrc, targetDir: brokenTgt });
    expect(brokenReport.problems).toHaveLength(2);
    expect(existsSync(join(brokenTgt, "folders.json"))).toBe(false);
    expect(existsSync(join(brokenTgt, "approved-commands.json"))).toBe(false);

    // Overlapping source/target folders are refused.
    expect(() => importApprovals({ sourceDir: source, targetDir: join(source, "nested") })).toThrow(
      /separate/,
    );
    expect(remapApprovalPath("/opt/x", source, target)).toBe("/opt/x");
  });
});
