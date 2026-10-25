// The first-launch import from a Botling 1.x folder: what comes over, what is left, and that the
// source is only read (made read-only for the test, and compared byte for byte and by mtime).
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { IDS, writeSwiftFixture } from "../fixtures/swift-data";
import { importFrom1x, listFiles, needsImport } from "../../src/core/store/importer";
import { BotStore } from "../../src/core/store/bot-store";
import { fromSwiftDate, isChatRecord, toSwiftDate } from "../../src/core/store/records";

function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of listFiles(dir).sort()) {
    const path = join(dir, file);
    out[file] = `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${statSync(path).mtimeMs}`;
  }
  return out;
}

function setWritable(dir: string, writable: boolean) {
  for (const file of listFiles(dir)) chmodSync(join(dir, file), writable ? 0o644 : 0o444);
  const dirs = new Set<string>([dir]);
  for (const file of listFiles(dir)) {
    let parts = file.split("/").slice(0, -1);
    while (parts.length) { dirs.add(join(dir, ...parts)); parts = parts.slice(0, -1); }
  }
  for (const folder of dirs) chmodSync(folder, writable ? 0o755 : 0o555);
}

const sources: string[] = [];
const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const source of sources.splice(0)) setWritable(source, true);
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGKILL");
});

describe("Swift formats", () => {
  it("dates are seconds since 2001, as Swift's JSONEncoder writes them", () => {
    expect(toSwiftDate(Date.UTC(2001, 0, 1))).toBe(0);
    expect(fromSwiftDate(toSwiftDate(Date.UTC(2026, 9, 25, 12)))).toBe(Date.UTC(2026, 9, 25, 12));
    expect(isChatRecord({ id: "A0000000-0000-4000-8000-000000000001", role: "user", text: "x", date: 1 })).toBe(true);
    expect(isChatRecord({ id: "m-1", role: "user", text: "x", date: 1 })).toBe(false); // Not a UUID: 1.x could not decode it.
    expect(isChatRecord({ id: "A0000000-0000-4000-8000-000000000001", role: "user", text: "x", date: "today" })).toBe(false);
  });

  it("a chat saved by 2.0 keeps every key it does not know", () => {
    const dir = tempDir("store");
    const { source } = writeSwiftFixture(dir);
    const copy = new BotStore(join(dir, "copy"));
    const { records, dropped } = new BotStore(join(source, "main")).loadMessages();
    expect(dropped).toBe(1);
    copy.saveMessages(records);
    const again = copy.loadMessages().records;
    expect(again.find((record) => record.id.endsWith("3"))).toMatchObject({ futureKey: { kept: true }, seenBy: ["claude"], reactions: [], session: "5E551011-0000-4000-8000-000000000001" });
    copy.saveSetting("unread", 0);
    copy.saveSetting("alwaysAllowed", ["WebFetch"]);
    expect(JSON.parse(readFileSync(join(dir, "copy", "bot.json"), "utf8"))).toEqual({ unread: 0, alwaysAllowed: ["WebFetch"] });
  });
});

describe("import from 1.x", () => {
  it("copies chats, settings and notes, rewrites only bots' own folders, and never writes to the source", () => {
    const dir = tempDir("import");
    const { source, projectFolder } = writeSwiftFixture(dir);
    const before = fingerprint(source);
    setWritable(source, false);
    sources.push(source);
    const target = join(dir, "botling2");
    expect(needsImport(target)).toBe(true);

    const report = importFrom1x(source, target);

    setWritable(source, true);
    expect(fingerprint(source)).toEqual(before); // Same files, same bytes, same mtimes.
    expect(listFiles(source).sort()).toEqual(Object.keys(before));
    setWritable(source, false);

    expect(report.bots.map((bot) => bot.name)).toEqual(["Main bot", "blog", "News", "Broken", "Maintainer"]);
    expect(report.messages).toBe(3 + 2 + 1 + 1);
    expect(report.skipped.join("\n")).toMatch(/1 line\(s\) 1.x itself would not read/);
    expect(report.skipped.join("\n")).toMatch(/Broken|33333333.*not valid JSON/);
    expect(report.skipped.join("\n")).toMatch(/secret settings .*keychain/);
    // The web AIs' saved conversations come over (Phase 4a, item 5).
    expect(existsSync(join(target, "web", "gemini", "conversations.json"))).toBe(true);
    // The main bot's files, as they were (so 1.x and 2.0 read the same thing).
    expect(readFileSync(join(target, "main", "chat.json"), "utf8")).toBe(readFileSync(join(source, "main", "chat.json"), "utf8"));
    expect(readFileSync(join(target, "main", "memory.md"), "utf8")).toMatch(/short answers/);
    expect(existsSync(join(target, "main", "routines.cron"))).toBe(true);
    expect(existsSync(join(target, "main", "tasks.json"))).toBe(true);
    expect(existsSync(join(target, "main", "attachments"))).toBe(false); // Attachments stay where they are.
    expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toMatchObject({ language: "en", unknownSetting: 1 });
    // A manager keeps its project folder; a bot of its own moves into 2.0's folder with its notes.
    const projects = JSON.parse(readFileSync(join(target, "projects.json"), "utf8"));
    expect(projects.map((project: { id: string }) => project.id)).toEqual([IDS.manager, IDS.standalone, IDS.broken]);
    expect(fileURLToPath(projects[0].folder)).toBe(projectFolder + "/");
    expect(fileURLToPath(projects[1].folder)).toBe(join(target, "bots", IDS.standalone) + "/");
    expect(projects[1].job).toBe("Morning news, in three lines.");
    expect(readFileSync(join(target, "bots", IDS.standalone, ".bot", "memory.md"), "utf8")).toMatch(/three papers/);
    expect(existsSync(join(target, "projects", IDS.broken, "chat.json"))).toBe(false); // Unreadable: left out.
    // Maintainer's chat, and its notes in the plugin library.
    expect(JSON.parse(readFileSync(join(target, "projects", IDS.maintainer, "chat.json"), "utf8"))).toHaveLength(1);
    expect(readFileSync(join(target, "plugins", ".bot", "memory.md"), "utf8")).toMatch(/library is tidy/);
    // The plugin library comes over, text files only: components and plugins' own files.
    expect(report.components).toBe(2);
    expect(report.plugins).toBe(1);
    expect(readFileSync(join(target, "plugins", "helper", "dist", "host.mjs"), "utf8")).toMatch(/helper loaded/);
    expect(existsSync(join(target, "plugins", "helper", "node_modules"))).toBe(false);
    // plugins.json without the secret setting (and no old failures); the secret itself was never in it to read.
    const state = JSON.parse(readFileSync(join(target, "plugins.json"), "utf8"));
    expect(state).toEqual({ disabled: ["weather"], settings: { helper: { greeting: "hello" } }, failures: {}, installed: {} });
    expect(JSON.stringify(listFiles(target).map((file) => readFileSync(join(target, file), "utf8")))).not.toContain("should-never-be-here");
    expect(readFileSync(join(target, "plugins", "ccb-components", "components", "status", "about.md"), "utf8")).toMatch(/Command: \.\/scan\.sh/);
    expect(existsSync(join(target, "plugins", "ccb-components", "components", "status", "scan.sh"))).toBe(true);
    expect(existsSync(join(target, "plugins", "ccb-components", "components", "status", "icon.png"))).toBe(false);
    expect(existsSync(join(target, "plugins", "weather", "components", "forecast", "template.html"))).toBe(true);
    expect(existsSync(join(target, "plugins", "weather", "plugin.json"))).toBe(true);
    expect(existsSync(join(target, "plugins", "ccb-components", ".git"))).toBe(false);
    expect(report.skipped.join("\n")).toMatch(/icon\.png: not a text file/);
    expect(needsImport(target)).toBe(false);
    expect(() => importFrom1x(source, join(source, "inside"))).toThrow(/separate/);
  });

  it("the core imports on its first start only, and shows the imported bots and chats", async () => {
    const dir = tempDir("import");
    const { source, projectFolder } = writeSwiftFixture(dir);
    setWritable(source, false);
    sources.push(source);
    const target = join(dir, "botling2");
    const first = new CoreHarness(target, { BOTLING_IMPORT_FROM: source });
    harnesses.push(first);
    const snapshot = await first.call({ type: "chat.snapshot" });
    expect(snapshot.imported).toMatchObject({ source, bots: 5, messages: 7 });
    expect(snapshot.bots.map((bot: { name: string }) => bot.name)).toEqual(["Main bot", "blog", "News", "Broken", "Maintainer"]);
    const [main, blog, news] = snapshot.bots;
    expect(main).toMatchObject({ id: MAIN, role: "main", avatar: "circle", unread: 2 });
    expect(blog).toMatchObject({ id: IDS.manager, role: "manager", avatar: "square", folder: projectFolder });
    expect(news).toMatchObject({ role: "bot", avatar: "star" });
    // The main bot's chat: no welcome lines; the old tool question is answered; steps come along.
    expect(snapshot.chat.messages.map((m: { text: string }) => m.text)).toEqual([
      "How is the blog going?", "Wants to use `Bash`:\n\n~~~\nls\n~~~", "**Blog**: 40 posts, 3 drafts.",
    ]);
    expect(snapshot.chat.messages[1]).toMatchObject({ chosen: 0, approval: { tool: "Bash", expires: null }, choices: [{ action: "allowOnce" }, { action: "deny" }] });
    expect(snapshot.chat.messages[2].steps[0]).toMatchObject({ tool: "Bash", title: "Run ls", done: true });
    expect(snapshot.chat.messages[0].time).toBe("2026-10-20T08:00:00.000Z");
    const blogChat = await first.chat(IDS.manager);
    expect(blogChat.messages.at(-1).text).toBe("Done: 40 covers added.");
    await first.kill("SIGTERM");

    // A second start does not import again (the folder is 2.0's now).
    const second = new CoreHarness(target, { BOTLING_IMPORT_FROM: source });
    harnesses.push(second);
    await second.call({ type: "chat.snapshot" });
    await until(() => second.stderr.includes("started epoch"));
    expect(second.stderr).not.toMatch(/imported/);
  });
});
