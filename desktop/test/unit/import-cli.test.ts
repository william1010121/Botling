import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, unlinkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_EXIT_DATA_DIR_IN_USE, readLockHolder } from "../../src/core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID, toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { Layout } from "../../src/core/store/workspace";
import type { MessageOf } from "../../src/protocol";
import { runImport } from "../../src/server/import/run";
import { readEntries, verifyStream } from "../../src/server/log";
import { openServerStore, type Db } from "../../src/server/store";
import { openReaderDb } from "../../src/server/store/connection";
import { BotlingdProcess, botlingdCommand, ScriptClient, testRoot } from "../botlingd-harness";
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
    if (entry.isSymbolicLink()) continue; // chmod would follow it
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

function streamEntries(db: Db, stream: string) {
  return readEntries(db, stream, 1, { maxEntries: 5_000, maxBytes: 64 * 1024 * 1024 }).entries;
}

const roots: string[] = [];
const daemons: BotlingdProcess[] = [];

function makeRoot(name = "import-cli"): string {
  const dir = testRoot(name);
  roots.push(dir);
  return dir;
}

/** A temp folder on the boot volume (case-insensitive on a default Mac), or null when that volume is case-sensitive. */
function caseInsensitiveRoot(name: string): string | null {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `${name}-`)));
  roots.push(dir);
  mkdirSync(join(dir, "CaseProbe"));
  return existsSync(join(dir, "caseprobe")) ? dir : null;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop("SIGKILL").catch(() => undefined);
  }
  for (const dir of roots.splice(0)) {
    try {
      setModeRecursive(dir, 0o755, 0o644);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("botlingd import CLI & run.ts (M6-01d)", () => {
  it("1. imports a full 2.x fixture via the CLI, writes the report, and botlingd starts with every bot and its lines in snapshot", async () => {
    const root = makeRoot("cli-full");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    const fx = make2xFolder(src);

    const res = botlingdCommand(dataDir, ["import", src]);
    expect(res.code, res.stderr).toBe(0);

    const lines = res.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Imported from Botling 2 (read only; Botling 2's folder was not changed).");
    expect(lines[1]).toMatch(/^Bots: 5 · lines: 7 · pins: 1 · plugins: \d+ \(\d+ read only until you approve them\)$/);
    expect(lines[2]).toBe(`Report: ${join(dataDir, "import-report.md")}`);

    const reportFile = join(dataDir, "import-report.md");
    expect(existsSync(reportFile)).toBe(true);
    const reportBody = readFileSync(reportFile, "utf8");
    expect(reportBody).toBe(res.stdout);
    expect(reportBody).toContain("Plugins");
    expect(reportBody).toContain(fx.pluginName);
    expect(reportBody).toContain("Media");
    expect(reportBody).toContain("Secrets");

    // Start botlingd on the imported data folder and verify snapshot lists every bot with its lines.
    const daemon = new BotlingdProcess(dataDir);
    daemons.push(daemon);
    await daemon.ready();

    const client = new ScriptClient("import-cli-test");
    try {
      await client.connect(daemon.socket, daemon.token);
      await client.sub(client.srv);
      await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");

      const mainSnap = await client.req({ type: "chat.snapshot" });
      if (!mainSnap.ok) throw new Error(mainSnap.error.message);
      const mainResult = mainSnap.result as {
        bots: Array<{ id: string; name: string }>;
        chat: { messages: Array<{ id: string; text: string }> } | null;
      };
      const expectedBotIds = [MAIN_BOT_ID, MAINTAINER_ID, ...fx.projectIds, ...fx.standaloneIds];
      for (const botId of expectedBotIds) {
        expect(mainResult.bots.some((b) => b.id === botId)).toBe(true);
      }
      expect(mainResult.bots).toHaveLength(5);
      expect(mainResult.chat?.messages.map((m) => m.text)).toEqual(fx.mainMessages.map((m) => m.text));

      for (const [botId, expectedText] of [
        [MAINTAINER_ID, "Check plugins"],
        [fx.projectIds[0]!, "Work on project 1"],
        [fx.projectIds[1]!, "Work on project 2"],
        [fx.standaloneIds[0]!, "Standalone 1 ready"],
      ] as const) {
        const snap = await client.req({ type: "chat.snapshot", botId });
        if (!snap.ok) throw new Error(snap.error.message);
        const chat = (snap.result as { chat: { messages: Array<{ text: string }> } | null }).chat;
        expect(chat?.messages.map((m) => m.text)).toContain(expectedText);
      }
    } finally {
      client.close();
      await daemon.stop();
    }
  }, 120_000);

  it("2. --dry-run prints the report and leaves server.db absent or unchanged", async () => {
    const root = makeRoot("dry-run");
    const src = join(root, "v2");
    const emptyDataDir = join(root, "v3-absent");
    make2xFolder(src);

    // (a) Absent target dataDir: server.db and dataDir remain absent.
    const dryCli = botlingdCommand(emptyDataDir, ["import", src, "--dry-run"]);
    expect(dryCli.code, dryCli.stderr).toBe(0);
    expect(dryCli.stdout).toContain("Bots: 5 · lines: 7 · pins: 1");
    expect(dryCli.stdout).toContain("Plugins");
    expect(existsSync(join(emptyDataDir, "server.db"))).toBe(false);
    expect(existsSync(join(emptyDataDir, "import-report.md"))).toBe(false);

    // (b) Existing server.db: bytes, size, and SHA-256 remain identical.
    const existingDataDir = join(root, "v3-existing");
    const store = await openServerStore(existingDataDir);
    await store.close();
    const dbFile = join(existingDataDir, "server.db");
    const beforeStat = statSync(dbFile);
    const beforeHash = createHash("sha256").update(readFileSync(dbFile)).digest("hex");

    const result = await runImport({ sourceDir: src, targetDir: existingDataDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.reportText).toContain("Bots: 5 · lines: 7 · pins: 1");

    const afterStat = statSync(dbFile);
    const afterHash = createHash("sha256").update(readFileSync(dbFile)).digest("hex");
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterHash).toBe(beforeHash);
    expect(existsSync(join(existingDataDir, "import-report.md"))).toBe(false);
  }, 90_000);

  it("3. refuses when botlingd is running on the data folder", async () => {
    const root = makeRoot("running-lock");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);

    const daemon = new BotlingdProcess(dataDir);
    daemons.push(daemon);
    await daemon.ready();

    const cliRes = botlingdCommand(dataDir, ["import", src]);
    expect(cliRes.code).toBe(CORE_EXIT_DATA_DIR_IN_USE);
    expect(cliRes.stderr).toContain("botlingd is running; stop it first (botlingd stop).");

    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(
      "botlingd is running; stop it first (botlingd stop).",
    );

    await daemon.stop();
  }, 90_000);

  it("4. refuses a second import of the same source and leaves everything unchanged", async () => {
    const root = makeRoot("second-run");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);

    const first = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(first.dryRun).toBe(false);

    const reportPath = join(dataDir, "import-report.md");
    const reportBefore = readFileSync(reportPath, "utf8");
    const dbReaderBefore = openReaderDb(join(dataDir, "server.db"));
    const entriesBefore = Number(dbReaderBefore.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n ?? 0);
    const idMapBefore = dbReaderBefore.prepare("SELECT COUNT(*) AS n FROM import_ids").get()?.n;
    dbReaderBefore.close();

    // Second run via CLI
    const secondCli = botlingdCommand(dataDir, ["import", src]);
    expect(secondCli.code).not.toBe(0);
    expect(secondCli.stderr).toMatch(/This folder was imported on .+\. Nothing was changed\./);

    // Second run via runImport
    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(
      /This folder was imported on .+\. Nothing was changed\./,
    );

    expect(readFileSync(reportPath, "utf8")).toBe(reportBefore);
    const dbReaderAfter = openReaderDb(join(dataDir, "server.db"));
    const entriesAfter = Number(dbReaderAfter.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n ?? 0);
    const idMapAfter = dbReaderAfter.prepare("SELECT COUNT(*) AS n FROM import_ids").get()?.n;
    dbReaderAfter.close();

    expect(entriesAfter).toBe(entriesBefore);
    expect(idMapAfter).toBe(idMapBefore);
  }, 90_000);

  it("5. resumes cleanly after a crash after the second bot with no doubled lines", async () => {
    const root = makeRoot("crash-resume");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    const baseDate = toSwiftDate(Date.UTC(2026, 0, 1, 13, 0, 0));
    const fx = make2xFolder(src);
    const extraMainMessages: ChatRecord[] = [];
    for (let i = 0; i < 600; i++) {
      extraMainMessages.push({
        id: makeUuid(1500, i + 1),
        role: i % 2 === 0 ? "user" : "bot",
        text: `Main bulk line ${i + 1}`,
        date: baseDate + i,
        ...(i % 2 === 1 ? { state: "done" as const } : {}),
      });
    }
    // Write 603 messages directly to chat.json (FileBotStore.saveMessages caps at HISTORY_LIMIT = 500).
    writeFileSync(
      join(Layout.mainBot(src), "chat.json"),
      JSON.stringify([...fx.mainMessages, ...extraMainMessages]),
    );

    // Crash right after bot #2 (index 1: Maintainer) finishes, leaving projects and standalone bots unimported.
    await expect(
      runImport({
        sourceDir: src,
        targetDir: dataDir,
        onBotDone: ({ index }) => {
          if (index === 1) throw new Error("injected crash after second bot");
        },
      }),
    ).rejects.toThrow("injected crash after second bot");

    // Verify source meta key is NOT set yet and bots 2..4 have no entries yet.
    const midDb = openReaderDb(join(dataDir, "server.db"));
    const importMetaRows = midDb.prepare("SELECT key FROM meta WHERE key LIKE 'import:%' AND key NOT LIKE '%:bot:%'").all();
    expect(importMetaRows).toHaveLength(0);
    expect(streamEntries(midDb, `bot:${MAIN_BOT_ID}`)).toHaveLength(603);
    expect(streamEntries(midDb, `bot:${MAINTAINER_ID}`)).toHaveLength(1);
    expect(streamEntries(midDb, `bot:${fx.projectIds[0]!}`)).toHaveLength(0);
    midDb.close();

    // Resume: finishes the remaining bots and never doubles Main bot or Maintainer lines.
    const resumed = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(resumed.bots).toHaveLength(5);
    expect(resumed.totalLines).toBe(607);

    const endDb = openReaderDb(join(dataDir, "server.db"));
    try {
      expect(streamEntries(endDb, `bot:${MAIN_BOT_ID}`)).toHaveLength(603);
      expect(streamEntries(endDb, `bot:${MAINTAINER_ID}`)).toHaveLength(1);
      expect(streamEntries(endDb, `bot:${fx.projectIds[0]!}`)).toHaveLength(1);
      expect(streamEntries(endDb, `bot:${fx.projectIds[1]!}`)).toHaveLength(1);
      expect(streamEntries(endDb, `bot:${fx.standaloneIds[0]!}`)).toHaveLength(1);

      for (const botId of [MAIN_BOT_ID, MAINTAINER_ID, ...fx.projectIds, ...fx.standaloneIds]) {
        expect(verifyStream(endDb, `bot:${botId}`).ok).toBe(true);
      }
      const finalMeta = endDb.prepare("SELECT key FROM meta WHERE key LIKE 'import:%' AND key NOT LIKE '%:bot:%'").all();
      expect(finalMeta).toHaveLength(1);
    } finally {
      endDb.close();
    }

    // A subsequent run after completion is refused.
    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(
      /This folder was imported on .+\. Nothing was changed\./,
    );
  }, 90_000);

  it("6. leaves a read-only 2.x source folder completely unchanged and refuses non-2.x folders", async () => {
    const root = makeRoot("source-unchanged");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    const not2x = join(root, "empty-dir");
    mkdirSync(not2x, { recursive: true });
    make2xFolder(src);

    // Refuse non-2.x folder without creating server.db.
    const badCli = botlingdCommand(dataDir, ["import", not2x]);
    expect(badCli.code).not.toBe(0);
    expect(badCli.stderr).toContain("does not look like a Botling 2 data folder.");
    expect(existsSync(join(dataDir, "server.db"))).toBe(false);

    const before = collectFiles(src);
    setModeRecursive(src, 0o555, 0o444);
    try {
      await runImport({ sourceDir: src, targetDir: dataDir });
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }
    const after = collectFiles(src);
    expect(after).toEqual(before);
  }, 90_000);

  it("7. refuses a target that is a 2.x folder, or that sits inside the source (also through a symlink), writing nothing", async () => {
    const root = makeRoot("refuse-targets");
    const src = join(root, "v2");
    make2xFolder(src);
    const otherV2 = join(root, "other-v2");
    make2xFolder(otherV2);
    const before = collectFiles(src);
    const otherBefore = collectFiles(otherV2);

    await expect(runImport({ sourceDir: src, targetDir: otherV2 })).rejects.toThrow(/looks like a Botling 2\.x data folder/);
    await expect(runImport({ sourceDir: src, targetDir: join(src, "v3") })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    symlinkSync(src, join(root, "alias"));
    await expect(runImport({ sourceDir: src, targetDir: join(root, "alias", "v3") })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    await expect(runImport({ sourceDir: join(root, "alias"), targetDir: join(src, "v3"), dryRun: true })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );

    expect(collectFiles(src)).toEqual(before);
    expect(collectFiles(otherV2)).toEqual(otherBefore);
  }, 60_000);

  it("8. --dry-run refuses an already imported source, and a live run holds the data-folder lock until it ends", async () => {
    const root = makeRoot("dry-refused-lock");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);

    const holders: (number | undefined)[] = [];
    await runImport({ sourceDir: src, targetDir: dataDir, onBotDone: () => holders.push(readLockHolder(dataDir)?.pid) });
    expect(holders).toHaveLength(5);
    expect(holders.every((pid) => pid === process.pid)).toBe(true);
    expect(readLockHolder(dataDir)).toBeNull();

    const dryCli = botlingdCommand(dataDir, ["import", src, "--dry-run"]);
    expect(dryCli.code).toBe(2);
    expect(dryCli.stderr).toMatch(/This folder was imported on .+\. Nothing was changed\./);
  }, 60_000);

  it("9. a bot whose folder is the 2.x folder itself gets an empty folder; the 2.x folder and plugin-secrets.json are not copied", async () => {
    const root = makeRoot("root-project");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);
    const projects = JSON.parse(readFileSync(Layout.projectsFile(src), "utf8")) as Array<Record<string, unknown>>;
    projects[0]!.folder = pathToFileURL(src + sep).toString();
    writeFileSync(Layout.projectsFile(src), JSON.stringify(projects));

    const result = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(existsSync(join(dataDir, "plugin-secrets.json"))).toBe(false);
    const ownDir = Layout.standalone(dataDir, String(projects[0]!.id));
    expect(readdirSync(ownDir)).toEqual([]);
    expect(result.problems.some((p) => p.includes("its folder was the Botling 2 data folder"))).toBe(true);
  }, 60_000);

  it("10. a resume after 2.x gained a bot finishes the known bots and names the new one in problems", async () => {
    const root = makeRoot("source-gained-bot");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);
    await expect(
      runImport({ sourceDir: src, targetDir: dataDir, onBotDone: ({ index }) => { if (index === 0) throw new Error("crash"); } }),
    ).rejects.toThrow("crash");

    const spare = join(root, "spare");
    const spareFx = make2xFolder(spare, { standaloneCount: 2 });
    const extraId = spareFx.standaloneIds[1]!;
    cpSync(Layout.standalone(spare, extraId), Layout.standalone(src, extraId), { recursive: true });
    const spareProjects = JSON.parse(readFileSync(Layout.projectsFile(spare), "utf8")) as Array<Record<string, unknown>>;
    const added = spareProjects.find((p) => p.id === extraId)!;
    const projects = JSON.parse(readFileSync(Layout.projectsFile(src), "utf8")) as unknown[];
    projects.push({ ...added, folder: pathToFileURL(Layout.standalone(src, extraId) + sep).toString() });
    writeFileSync(Layout.projectsFile(src), JSON.stringify(projects));

    const resumed = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(resumed.bots).toHaveLength(5);
    expect(resumed.problems.some((p) => p.includes(extraId) && p.includes("not imported"))).toBe(true);
  }, 60_000);

  it("11. a broken plugin-secrets.json is named in problems without quoting its contents", async () => {
    const root = makeRoot("secret-snippet");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);
    writeFileSync(join(src, "plugin-secrets.json"), '{"sample-plugin": {"apiToken": SEALED-SECRET-BYTES}}');

    const dry = await runImport({ sourceDir: src, targetDir: dataDir, dryRun: true });
    expect(dry.reportText).toContain("plugin-secrets.json: could not be read");
    expect(dry.reportText).not.toContain("SEALED");
    const live = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(live.reportText).not.toContain("SEALED");
    expect(readFileSync(join(dataDir, "import-report.md"), "utf8")).not.toContain("SEALED");
  }, 60_000);

  it("12. when the report file cannot be written the source is not marked imported, and a second run finishes", async () => {
    const root = makeRoot("report-fails");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);
    mkdirSync(join(dataDir, "import-report.md", "blocker"), { recursive: true });

    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow();
    const db = openReaderDb(join(dataDir, "server.db"));
    const marks = db.prepare("SELECT key FROM meta WHERE key LIKE 'import:%' AND key NOT LIKE '%:bot:%'").all();
    db.close();
    expect(marks).toHaveLength(0);

    rmSync(join(dataDir, "import-report.md"), { recursive: true, force: true });
    const second = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(second.bots).toHaveLength(5);
    expect(existsSync(join(dataDir, "import-report.md"))).toBe(true);
  }, 60_000);

  it("13. a resumed run still counts the lines skipped by the run that finished a bot", async () => {
    const root = makeRoot("resume-skipped");
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    const fx = make2xFolder(src);
    // A line messageView throws on (out-of-range date): skipped and counted by the import.
    const broken: ChatRecord = { id: makeUuid(1600, 1), role: "user", text: "Out-of-range date", date: 1e20 };
    writeFileSync(join(Layout.mainBot(src), "chat.json"), JSON.stringify([...fx.mainMessages, broken]));

    await expect(
      runImport({ sourceDir: src, targetDir: dataDir, onBotDone: ({ index }) => { if (index === 0) throw new Error("crash"); } }),
    ).rejects.toThrow("crash");

    const resumed = await runImport({ sourceDir: src, targetDir: dataDir });
    const main = resumed.bots.find((b) => b.newId === MAIN_BOT_ID)!;
    expect(main.lines).toBe(fx.mainMessages.length);
    expect(main.skipped).toBe(1);
    expect(resumed.totalSkipped).toBe(1);
    expect(resumed.reportText.split("\n")[1]).toContain("(1 skipped)");
  }, 60_000);

  const ciRoot = (() => {
    try {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "import-cli-ci-check-")));
      mkdirSync(join(dir, "CaseProbe"));
      const insensitive = existsSync(join(dir, "caseprobe"));
      rmSync(dir, { recursive: true, force: true });
      return insensitive;
    } catch {
      return false;
    }
  })();

  it.skipIf(!ciRoot)("14. on a case-insensitive volume a target spelled with other case is refused, and the source keeps one identity", async () => {
    const root = caseInsensitiveRoot("import-cli-case")!;
    const src = join(root, "v2");
    make2xFolder(src);
    const before = collectFiles(src);

    // The target inside the 2.x folder, reached through other case: refused, nothing written there.
    await expect(runImport({ sourceDir: src, targetDir: join(root, "V2", "v3") })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    await expect(runImport({ sourceDir: join(root, "V2"), targetDir: join(src, "v3"), dryRun: true })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    expect(collectFiles(src)).toEqual(before);

    // The same folder spelled with other case is the same source: a second import is refused.
    const dataDir = join(root, "v3");
    const first = await runImport({ sourceDir: join(root, "V2"), targetDir: dataDir });
    expect(first.sourceRealPath).toBe(src);
    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(
      /This folder was imported on .+\. Nothing was changed\./,
    );
    expect(collectFiles(src)).toEqual(before);
  }, 60_000);

  const firmlinkTmp = (() => {
    const real = realpathSync.native(tmpdir());
    const data = `/System/Volumes/Data${real}`;
    try {
      return process.platform === "darwin" && existsSync(data) && realpathSync.native(data) !== real ? data : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(!firmlinkTmp)("15. a target reached through a path no realpath folds (a macOS firmlink) is refused by inode", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "import-cli-firmlink-")));
    roots.push(dir);
    const src = join(dir, "v2");
    make2xFolder(src);
    const before = collectFiles(src);
    const aliasOfSrc = `/System/Volumes/Data${src}`;
    expect(existsSync(aliasOfSrc)).toBe(true);

    await expect(runImport({ sourceDir: src, targetDir: join(aliasOfSrc, "v3") })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    await expect(runImport({ sourceDir: aliasOfSrc, targetDir: join(src, "v3"), dryRun: true })).rejects.toThrow(
      "The import's source and target must be separate folders.",
    );
    expect(collectFiles(src)).toEqual(before);
    void firmlinkTmp;
  }, 60_000);

  it.skipIf(!firmlinkTmp)("16. the source spelled through a macOS firmlink keeps one identity: a second import is refused", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "import-cli-firmlink-id-")));
    roots.push(dir);
    const src = join(dir, "v2");
    make2xFolder(src);
    const dataDir = join(dir, "v3");
    const first = await runImport({ sourceDir: `/System/Volumes/Data${src}`, targetDir: dataDir });
    expect(first.sourceRealPath).toBe(src);
    const projectsBefore = readFileSync(Layout.projectsFile(dataDir), "utf8");
    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(
      /This folder was imported on .+\. Nothing was changed\./,
    );
    expect(readFileSync(Layout.projectsFile(dataDir), "utf8")).toBe(projectsBefore);
  }, 60_000);

  it("17. a bot folder 2.x stored through another spelling of its data folder (a symlink) is copied, never kept pointing into 2.x", async () => {
    const root = makeRoot("spelled-folders");
    const src = join(root, "v2");
    const fx = make2xFolder(src);
    symlinkSync(src, join(root, "link2x"));
    // 2.x ran with its data folder given through the symlink, so it stored the folders with that spelling.
    const projects = JSON.parse(readFileSync(Layout.projectsFile(src), "utf8")) as Array<{ id: string; folder: string }>;
    for (const project of projects) {
      const folder = fileURLToPath(project.folder);
      if (folder.startsWith(src + sep)) {
        project.folder = pathToFileURL(join(root, "link2x", relative(src, folder)) + sep).toString();
      }
    }
    writeFileSync(Layout.projectsFile(src), JSON.stringify(projects));
    const before = collectFiles(src);

    const dataDir = join(root, "v3");
    await runImport({ sourceDir: src, targetDir: dataDir });
    const imported = JSON.parse(readFileSync(Layout.projectsFile(dataDir), "utf8")) as Array<{ id: string; folder: string }>;
    const srcReal = realpathSync.native(src);
    for (const project of imported) {
      const folder = realpathSync.native(fileURLToPath(project.folder));
      expect(folder === srcReal || folder.startsWith(srcReal + sep), `${project.id} -> ${folder}`).toBe(false);
    }
    const ownDir = Layout.standalone(dataDir, fx.standaloneIds[0]!);
    expect(existsSync(join(ownDir, ".bot", "memory.md"))).toBe(true);
    expect(collectFiles(src)).toEqual(before);
  }, 60_000);

  it("18. a link at the top of botlingd's folder into the 2.x folder is refused before anything is written", async () => {
    const root = makeRoot("top-link");
    const src = join(root, "v2");
    make2xFolder(src);
    const before = collectFiles(src);
    const dataDir = join(root, "v3");
    mkdirSync(dataDir);
    symlinkSync(join(src, "bots"), join(dataDir, "bots"));

    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(/leads into the Botling 2 folder/);
    expect(collectFiles(src)).toEqual(before);
    expect(readdirSync(dataDir)).toEqual(["bots"]); // no lock, no server.db, no identity
  }, 60_000);

  it("19. a link deeper in botlingd's folder (a bot folder, a plugin folder) stops the import before it writes through it; a rerun finishes", async () => {
    const root = makeRoot("deep-link");
    const src = join(root, "v2");
    const fx = make2xFolder(src);
    const before = collectFiles(src);
    const dataDir = join(root, "v3");
    const standaloneId = fx.standaloneIds[0]!;
    mkdirSync(join(dataDir, "bots"), { recursive: true });
    symlinkSync(Layout.standalone(src, standaloneId), Layout.standalone(dataDir, standaloneId));

    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(/leads into the Botling 2 folder/);
    expect(collectFiles(src)).toEqual(before);
    expect(readLockHolder(dataDir)).toBeNull();

    unlinkSync(Layout.standalone(dataDir, standaloneId));
    mkdirSync(join(dataDir, "plugins"), { recursive: true });
    symlinkSync(join(src, "plugins", fx.pluginName), join(dataDir, "plugins", fx.pluginName));
    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(/leads into the Botling 2 folder/);
    expect(collectFiles(src)).toEqual(before);

    unlinkSync(join(dataDir, "plugins", fx.pluginName));
    const done = await runImport({ sourceDir: src, targetDir: dataDir });
    expect(done.bots).toHaveLength(5);
    expect(existsSync(join(Layout.standalone(dataDir, standaloneId), ".bot", "memory.md"))).toBe(true);
    expect(collectFiles(src)).toEqual(before);
  }, 90_000);

  it("20. a broken link where the import writes a file is refused, so nothing is created at its target in the 2.x folder", async () => {
    const root = makeRoot("broken-link");
    const src = join(root, "v2");
    const fx = make2xFolder(src);
    const before = collectFiles(src);
    const dataDir = join(root, "v3");
    const dstPlugin = join(dataDir, "plugins", fx.pluginName);
    mkdirSync(dstPlugin, { recursive: true });
    // writeFileSync would follow this link and create the file it names inside the 2.x plugin folder.
    symlinkSync(join(src, "plugins", fx.pluginName, "created-by-import.js"), join(dstPlugin, "web.js"));

    await expect(runImport({ sourceDir: src, targetDir: dataDir })).rejects.toThrow(/broken symbolic link/);
    expect(existsSync(join(src, "plugins", fx.pluginName, "created-by-import.js"))).toBe(false);
    expect(collectFiles(src)).toEqual(before);
  }, 60_000);

  it("21. a hard link to plugin-secrets.json in a bot folder or a plugin folder is not copied", async () => {
    const root = makeRoot("secrets-hardlink");
    const src = join(root, "v2");
    const fx = make2xFolder(src);
    linkSync(join(src, "plugin-secrets.json"), join(fx.standaloneDirs[0]!, "notes.json"));
    linkSync(join(src, "plugin-secrets.json"), join(src, "plugins", fx.pluginName, "config.json"));
    const dataDir = join(root, "v3");

    await runImport({ sourceDir: src, targetDir: dataDir });
    const ownDir = Layout.standalone(dataDir, fx.standaloneIds[0]!);
    expect(existsSync(join(ownDir, ".bot", "memory.md"))).toBe(true);
    expect(existsSync(join(ownDir, "notes.json"))).toBe(false);
    expect(existsSync(join(dataDir, "plugins", fx.pluginName, "web.js"))).toBe(true);
    expect(existsSync(join(dataDir, "plugins", fx.pluginName, "config.json"))).toBe(false);
  }, 60_000);
});
