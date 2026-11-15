import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_EXIT_DATA_DIR_IN_USE } from "../../src/core/store/data-dir-lock";
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
});
