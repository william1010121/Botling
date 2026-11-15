import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksLike2x, read2x, readChat } from "../../src/server/import";
import { refuse2xData } from "../../src/server/session";
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

describe("2.x read-only reader", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "botling-reader-2x-"));
  });

  afterEach(() => {
    try {
      setModeRecursive(root, 0o755, 0o644);
    } catch {
      // ignore if already removed or missing
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("reads every bot, chat line, list, subagent, settings, plugins, secrets flag and approvals from the fixture", () => {
    const src = join(root, "v2");
    const fx = make2xFolder(src);
    const data = read2x(src);

    expect(data.problems).toEqual([]);
    expect(data.bots).toHaveLength(5);
    expect(data.bots.map((b) => b.id)).toEqual([
      fx.mainId,
      fx.maintainerId,
      ...fx.projectIds,
      ...fx.standaloneIds,
    ]);
    expect(data.bots[0]).toMatchObject({ id: fx.mainId, role: "main", standalone: false });
    expect(data.bots[1]).toMatchObject({ id: fx.maintainerId, role: "manager", standalone: false });
    expect(data.bots[2]).toMatchObject({ id: fx.projectIds[0], role: "manager", folder: fx.projectDirs[0], standalone: false });
    expect(data.bots[4]).toMatchObject({ id: fx.standaloneIds[0], role: "bot", folder: fx.standaloneDirs[0], standalone: true });

    expect(data.settings).toMatchObject({ languageChoice: "en", appTheme: "dark", claudeWorkerLimit: 4 });
    expect(data.pluginsState).toMatchObject({ disabled: [], settings: { [fx.pluginName]: { greeting: "hello" } } });
    expect(data.pluginDirs).toEqual([{ name: fx.pluginName, dir: join(src, "plugins", fx.pluginName) }]);
    expect(data.hasSecrets).toBe(true);
    expect(data.folders).toEqual(["/tmp/shared-docs"]);
    expect(data.approvedCommands).toMatchObject({
      [join(src, "main")]: ["git status"],
      [fx.projectDirs[0]!]: ["npm test"],
    });

    const mainChat = readChat(data.bots[0]!);
    expect(mainChat.problems).toEqual([]);
    expect(mainChat.chat).toEqual(fx.mainMessages);
    expect(mainChat.chat[2]?.attachments).toHaveLength(1);
    expect(mainChat.pins).toEqual(fx.mainPins);
    expect(mainChat.specs).toEqual(fx.mainSpecs);
    expect(mainChat.tasks).toEqual(fx.mainTasks);
    expect(mainChat.settings).toMatchObject({ model: "sonnet", unread: 1, alwaysAllowed: ["Read", "Bash(git status)"] });
    expect(mainChat.subagents).toHaveLength(1);
    expect(mainChat.subagents[0]?.index).toMatchObject({ id: fx.subagentId, name: "Researcher" });
    expect(mainChat.subagents[0]?.history.steps).toHaveLength(1);
    expect(mainChat.subagents[0]?.history.steps[0]).toMatchObject({ id: "step-1", tool: "Read" });

    for (const bot of data.bots.slice(1)) {
      const chat = readChat(bot);
      expect(chat.problems).toEqual([]);
      expect(chat.chat.length).toBeGreaterThan(0);
    }
  });

  it("never writes or touches the source folder even when files and directories are read-only", () => {
    const src = join(root, "readonly-v2");
    make2xFolder(src);
    const before = collectFiles(src);

    setModeRecursive(src, 0o555, 0o444);
    try {
      const data = read2x(src);
      for (const bot of data.bots) {
        readChat(bot);
      }
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    const after = collectFiles(src);
    expect(after).toEqual(before);
  });

  it("reads pre-2.1 legacy subagents.json without migrating or writing to the source", () => {
    const src = join(root, "legacy-subagents");
    make2xFolder(src);
    rmSync(join(src, "main", "subagents"), { recursive: true, force: true });
    writeFileSync(
      join(src, "main", "subagents.json"),
      JSON.stringify([
        {
          id: "legacy-1",
          name: "Legacy worker",
          startedAt: 1_700_000_000_000,
          steps: [{ id: "s1", kind: "tool", tool: "Read", title: "Read file", failed: false, done: true }],
        },
      ]),
    );
    const before = collectFiles(src);

    setModeRecursive(src, 0o555, 0o444);
    let subagents: ReturnType<typeof readChat>["subagents"] = [];
    try {
      const data = read2x(src);
      const chat = readChat(data.bots[0]!);
      expect(chat.problems).toEqual([]);
      subagents = chat.subagents;
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    expect(subagents).toHaveLength(1);
    expect(subagents[0]?.index).toMatchObject({ id: "legacy-1", name: "Legacy worker", stepCount: 1 });
    expect(subagents[0]?.history.steps).toHaveLength(1);
    expect(collectFiles(src)).toEqual(before);
  });

  it("reports a broken pins.json in problems while still reading the other parts", () => {
    const src = join(root, "broken-pins");
    const fx = make2xFolder(src, { brokenFiles: ["main/pins.json"] });

    const data = read2x(src);
    const mainChat = readChat(data.bots[0]!);

    expect(mainChat.pins).toEqual([]);
    expect(mainChat.problems.length).toBe(1);
    expect(mainChat.problems[0]).toContain("pins.json");
    expect(mainChat.chat).toEqual(fx.mainMessages);
    expect(mainChat.specs).toEqual(fx.mainSpecs);
    expect(mainChat.tasks).toEqual(fx.mainTasks);
    expect(mainChat.subagents).toHaveLength(1);
    expect(mainChat.settings).toMatchObject({ model: "sonnet" });
  });

  it("detects 2.x folders accurately with looksLike2x and preserves refuse2xData", () => {
    const fixtureDir = join(root, "fx");
    make2xFolder(fixtureDir);
    expect(looksLike2x(fixtureDir)).toBe(true);

    const botlingdDir = join(root, "v3");
    mkdirSync(botlingdDir, { recursive: true });
    writeFileSync(join(botlingdDir, "server.db"), "");
    expect(looksLike2x(botlingdDir)).toBe(false);

    const mixedDir = join(root, "mixed");
    make2xFolder(mixedDir);
    writeFileSync(join(mixedDir, "server.db"), "");
    expect(looksLike2x(mixedDir)).toBe(false);

    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir, { recursive: true });
    expect(looksLike2x(emptyDir)).toBe(false);

    const legacyProjectsOnly = join(root, "projects-only");
    mkdirSync(join(legacyProjectsOnly, "projects"), { recursive: true });
    expect(() => refuse2xData(legacyProjectsOnly)).toThrow(/2\.x/);
    writeFileSync(join(legacyProjectsOnly, "server.db"), "");
    expect(() => refuse2xData(legacyProjectsOnly)).not.toThrow();
  });
});
