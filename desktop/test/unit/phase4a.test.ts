// Phase 4a in the core: attachments (1.x's names and folders, files waiting in the input box, a
// message with only files, pictures to claude as base64 blocks and to Codex as localImage, a
// component's pictures with its answer, which files the chat origin may serve) and plugins' web
// parts for the chat page (specs, the last version that worked, which of their files are served).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { answerLabel, attachmentKind, attachmentList, attachmentsFolder, imageMediaType, keep, PendingFiles, safeName, stamp } from "../../src/core/attachments";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), FAKE_CODEX_INPUT: join(dir, "codex-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const logged = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

describe("attachments (Models.swift Attachment, Bot.keep)", () => {
  it("kinds, media types, the list the bot reads, folders and names as 1.x", () => {
    expect(["a.PNG", "b.jpeg", "c.heic", "d.mov", "e.webm", "f.pdf", "g"].map(attachmentKind)).toEqual(["image", "image", "image", "video", "video", "file", "file"]);
    expect(["a.png", "a.JPG", "a.gif", "a.webp", "a.heic"].map(imageMediaType)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", null]);
    expect(attachmentList(["/x/a.png", "/x/b.txt"])).toBe("(Attachments:\n- /x/a.png\n- /x/b.txt)");
    expect(attachmentsFolder({ role: "main", folder: "/m" })).toBe("/m/attachments");
    expect(attachmentsFolder({ role: "manager", folder: "/p" })).toBe("/p/.bot/attachments");
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    expect(safeName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeName(".hidden")).toBe("hidden");
    expect(answerLabel("  ", 1)).toBe("(picture)");
    expect(answerLabel("", 3)).toBe("(3 pictures)");
    expect(answerLabel("words", 3)).toBe("words");
    const dir = tempDir("keep");
    writeFileSync(join(dir, "a.png"), PNG);
    const at = new Date(2026, 4, 6, 7, 8, 9);
    const first = keep(join(dir, "a.png"), join(dir, "kept"), at)!;
    const second = keep(join(dir, "a.png"), join(dir, "kept"), at)!;
    const third = keep(join(dir, "a.png"), join(dir, "kept"), at)!;
    expect([first.path, second.path, third.path].map((path) => path.split("/").pop())).toEqual(["20260506-070809-a.png", "20260506-070809-2-a.png", "20260506-070809-3-a.png"]);
    expect(first.url).toBe(pathToFileURL(first.path).href);
    expect(first.kind).toBe("image");
    expect(keep(join(dir, "missing.png"), join(dir, "kept"))).toBeNull();
  });

  it("files wait per bot; pasted ones live in incoming/ until sent or removed", () => {
    const dir = tempDir("pending");
    writeFileSync(join(dir, "doc.txt"), "x");
    const changes: string[] = [];
    const pending = new PendingFiles(join(dir, "incoming"), (botId, files) => changes.push(`${botId}:${files.length}`));
    expect(pending.addPaths("A", [join(dir, "doc.txt"), join(dir, "nope.txt"), dir]).map((file) => file.name)).toEqual(["doc.txt"]);
    const [pasted] = pending.addData("A", "a/b.png", PNG.toString("base64")).slice(1);
    expect(pasted!.name).toBe("a-b.png");
    expect(readdirSync(join(dir, "incoming"))).toHaveLength(1);
    expect(pending.views("B")).toEqual([]);
    const taken = pending.take("A");
    expect(taken).toHaveLength(2);
    expect(pending.views("A")).toEqual([]);
    pending.restore("A", taken);
    expect(pending.views("A")).toHaveLength(2);
    pending.remove("A", pasted!.id);
    expect(readdirSync(join(dir, "incoming"))).toEqual([]);
    pending.done(pending.take("A"));
    expect(existsSync(join(dir, "doc.txt"))).toBe(true);
    expect(changes).toEqual(["A:1", "A:2", "A:0", "A:2", "A:1", "A:0"]);
  });

  it("a message with files: kept, listed, the picture given to claude; files only; what the chat may serve", async () => {
    const dir = tempDir("attach-core");
    const outside = tempDir("attach-outside");
    writeFileSync(join(outside, "shot.png"), PNG);
    writeFileSync(join(outside, "notes.md"), "# notes");
    const c = core(dir);
    const added = await c.call({ type: "files.add", botId: MAIN, paths: [join(outside, "shot.png"), join(outside, "notes.md")] });
    expect(added.files.map((file: any) => [file.name, file.kind])).toEqual([["shot.png", "image"], ["notes.md", "file"]]);
    expect((await c.chat()).pendingFiles).toHaveLength(2);
    // A waiting file can be served (by its pending id); a file nobody named cannot.
    expect(await c.call({ type: "attachment.file", botId: MAIN, ref: `pending:${added.files[0].id}` })).toEqual({ path: join(outside, "shot.png"), type: "image/png" });
    await expect(c.call({ type: "attachment.file", botId: MAIN, ref: pathToFileURL(join(outside, "notes.md")).href })).rejects.toThrow("not_found");
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "see" });
    await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
    const folder = join(dir, "main", "attachments");
    const kept = readdirSync(folder).sort();
    expect(kept.map((name) => name.replace(/^\d{8}-\d{6}-/, ""))).toEqual(["notes.md", "shot.png"]);
    const input = logged(join(dir, "claude-input.log")).at(-1);
    expect(input.text.endsWith(`see\n\n(Attachments:\n- ${join(folder, kept[1]!)}\n- ${join(folder, kept[0]!)})`)).toBe(true);
    expect(input.images).toEqual(["image/png"]);
    const chat = await c.chat();
    const mine = chat.messages.find((message: any) => message.role === "user");
    expect(mine.attachments.map((file: any) => file.kind)).toEqual(["image", "file"]);
    expect(chat.pendingFiles).toEqual([]);
    expect(c.of("files.updated").at(-1)!.event).toMatchObject({ botId: MAIN, files: [] });
    // Now the kept file is the chat's, so it may be served; the original is not.
    expect((await c.call({ type: "attachment.file", botId: MAIN, ref: mine.attachments[1].url })).path).toBe(join(folder, kept[0]!));
    await expect(c.call({ type: "attachment.file", botId: MAIN, ref: pathToFileURL(join(outside, "shot.png")).href })).rejects.toThrow("not_found");
    // Only a file, no words.
    await c.call({ type: "files.data", botId: MAIN, name: "Pasted image.png", base64: PNG.toString("base64") });
    const second = await c.call({ type: "chat.send", botId: MAIN, text: "" });
    await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === second.turnId));
    const filesOnly: string = logged(join(dir, "claude-input.log")).at(-1).text;
    expect(filesOnly.startsWith("(Attachments:\n- ")).toBe(true);
    expect(filesOnly).toMatch(/-Pasted image\.png\)(\n\n\(App: message_id of this message: [0-9A-F-]+\))?$/);
    expect(readdirSync(join(dir, "incoming"))).toEqual([]);
    // Nothing at all to send is refused.
    await expect(c.call({ type: "chat.send", botId: MAIN, text: "  " })).rejects.toThrow("bad_request");
  });

  it("a Codex head gets pictures as localImage items", async () => {
    const dir = tempDir("attach-codex");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex" }));
    const c = core(dir);
    await c.call({ type: "files.data", botId: MAIN, name: "diagram.png", base64: PNG.toString("base64") });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "what is this" });
    await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
    const images = logged(join(dir, "codex-input.log")).filter((line) => line.kind === "images");
    expect(images).toHaveLength(1);
    expect(images[0].text).toMatch(/main\/attachments\/\d{8}-\d{6}-[0-9A-F]{6}-diagram\.png$/);
  });

  it("a component's answer with pictures goes to the bot as attachments", async () => {
    const dir = tempDir("attach-answer");
    const c = core(dir);
    const id = "D15B1A00-0000-4000-8000-000000000001";
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "chat.json"), JSON.stringify([{ id, role: "bot", text: "Pick one", date: 800_000_000, displays: [{ name: "picker", data: "{}" }] }]));
    await c.kill("SIGKILL");
    const again = core(dir);
    expect(await again.call({ type: "chat.answer", botId: MAIN, messageId: id, text: "", images: [{ name: "sketch.png", base64: PNG.toString("base64") }] })).toEqual({ accepted: true });
    const input = await until(() => logged(join(dir, "claude-input.log")).find((line) => line.text.includes("sketch.png")));
    expect(input.images).toEqual(["image/png"]);
    expect(readdirSync(join(dir, "incoming"))).toEqual([]);
  });
});

describe("plugins' web parts in the chat page", () => {
  function library(dir: string) {
    const folder = join(dir, "plugins", "glow");
    mkdirSync(join(folder, "dist", "fonts"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({
      name: "glow", version: "1.0.0", engines: { ccb: "^2.0.0" },
      ccb: { web: "dist/web.js", styles: ["dist/glow.css"], contributes: { commands: [{ id: "glow.on", title: "Glow", key: "cmd+g" }], settings: { level: { type: "number", default: 2, title: "Level" }, token: { type: "string", title: "Token", secret: true } } } },
    }));
    writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
    writeFileSync(join(folder, "dist", "glow.css"), ".x{}");
    writeFileSync(join(folder, "dist", "fonts", "a.woff2"), "font");
    writeFileSync(join(folder, "dist", "notes.txt"), "no");
    return folder;
  }

  it("specs with settings (never secrets) and commands; a broken new version falls back to the last that loaded", async () => {
    const dir = tempDir("webparts");
    const folder = library(dir);
    const secrets = new MemorySecretStore();
    await secrets.set("glow", "token", "s3cret");
    const notices: string[] = [];
    const registry = new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), secrets);
    registry.onNotice = (text) => notices.push(text);
    const [spec] = registry.webSpecs();
    expect(spec).toEqual({ name: "glow", version: "1.0.0", source: "export function activate() {}", styles: ["dist/glow.css"], settings: { level: 2 }, commands: [{ id: "glow.on", title: "Glow", key: "cmd+g" }] });
    expect(JSON.stringify(registry.webSpecs())).not.toContain("s3cret");
    // The page loaded it; then a new version breaks in the page: the old one keeps running.
    registry.markLoaded("glow");
    writeFileSync(join(folder, "dist", "web.js"), "export function activate() { throw new Error('boom') }");
    writeFileSync(join(folder, "package.json"), readFileSync(join(folder, "package.json"), "utf8").replace('"1.0.0"', '"1.1.0"'));
    registry.rescan();
    expect(registry.webSpecs()[0]!.version).toBe("1.1.0");
    registry.markFailed("glow", "boom");
    expect(registry.webSpecs()[0]).toMatchObject({ version: "1.0.0", source: "export function activate() {}" });
    expect(notices.at(-1)).toBe('Plugin "glow": the new version failed; using the previous version and handed it to Maintainer: boom');
    // Turned off by you: nothing runs.
    registry.setEnabled("glow", false);
    expect(registry.webSpecs()).toEqual([]);
  });

  it("serves only the stylesheets a manifest names and fonts or pictures beside them", () => {
    const dir = tempDir("webfiles");
    const folder = library(dir);
    const registry = new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), new MemorySecretStore());
    expect(registry.webFile("glow", "dist/glow.css")).toMatchObject({ type: "text/css; charset=utf-8" });
    expect(registry.webFile("glow", "dist/fonts/a.woff2")).toMatchObject({ type: "font/woff2" });
    for (const path of ["dist/web.js", "dist/notes.txt", "package.json", "../glow/dist/glow.css", "dist/../package.json", "/etc/passwd", "dist/other.css"]) {
      expect(registry.webFile("glow", path), path).toBeNull();
    }
    expect(registry.webFile("nope", "dist/glow.css")).toBeNull();
    writeFileSync(join(folder, "dist", ".secret.png"), "x");
    expect(registry.webFile("glow", "dist/.secret.png")).toBeNull();
  });

  it("through the core: plugins.web gives styles as chat-origin URLs; a web part's failure turns it off; notify is a line", async () => {
    const dir = tempDir("webparts-core");
    library(dir);
    const c = core(dir);
    const { specs } = await c.call({ type: "plugins.web" });
    expect(specs.map((spec: any) => [spec.name, spec.styles])).toEqual([["glow", ["botling-chat://chat/plugin-files/glow/dist/glow.css"]]]);
    expect(await c.call({ type: "plugins.file", name: "glow", path: "dist/glow.css" })).toMatchObject({ path: expect.stringContaining("glow.css") });
    await expect(c.call({ type: "plugins.file", name: "glow", path: "dist/web.js" })).rejects.toThrow("not_found");
    await c.call({ type: "plugins.notice", name: "glow", text: "hello" });
    await until(async () => (await c.chat()).messages.some((message: any) => message.text === "glow: hello"));
    await c.call({ type: "plugins.failed", name: "glow", message: "it threw" });
    expect((await c.call({ type: "plugins.web" })).specs).toEqual([]);
    expect((await c.call({ type: "plugins.list" })).plugins.find((plugin: any) => plugin.name === "glow")).toMatchObject({ enabled: false, failure: "it threw" });
  });
});

describe("settings (AppSettings.swift's keys)", () => {
  it("reads 1.x's keys with their defaults, keeps keys it does not know, and writes changes as 1.x's setters", async () => {
    const { settingsView, applySetting, appliedCodexWorkers, seedEngineDefaults } = await import("../../src/core/settings");
    const empty = settingsView({});
    expect(empty).toMatchObject({
      language: null, effectiveLanguage: "en", botLook: "cute", chatAvatarSize: null, catchUpEnabled: true, intervalSummaryEnabled: false,
      thresholdsCustomized: false, catchUpThreshold: 3, intervalSummaryThreshold: 3, catchUpModel: "gpt-6-luna", summaryPrompt: null,
      completionVerification: false, completionVerificationModel: "gpt-6-luna", subagentModel: null, subagentHourCache: false,
      codexWorkersFollow: true, codexWorkers: { model: null, effort: null, fast: null }, componentEditorModel: "sonnet",
      resultPublishing: "artifactUnlessSensitive", stallReminderMinutes: 15,
    });
    // A bad value falls back to its own default only; a threshold not 3 counts as customized.
    expect(settingsView({ languageChoice: "xx", botLookChoice: "original", catchUpThresholdChoice: 99, codexWorkerChoice: { model: "m", effort: "turbo", fast: true } }, "ja"))
      .toMatchObject({ language: null, effectiveLanguage: "ja", botLook: "original", catchUpThreshold: 50, thresholdsCustomized: true, codexWorkers: { model: "m", effort: null, fast: true } });
    let raw: Record<string, unknown> = { dailyBudget: 3, languageChoice: "en" };
    raw = applySetting(raw, { key: "catchUpThreshold", value: 7 });
    expect(raw).toEqual({ dailyBudget: 3, languageChoice: "en", catchUpThresholdChoice: 7, summaryThresholdsCustomizedChoice: true });
    raw = applySetting(raw, { key: "thresholdsCustomized", value: false });
    expect(raw).toEqual({ dailyBudget: 3, languageChoice: "en", summaryThresholdsCustomizedChoice: false });
    raw = applySetting(raw, { key: "language", value: null });
    expect(raw.languageChoice).toBeUndefined();
    raw = applySetting(raw, { key: "summaryPrompt", value: "   " });
    expect(raw.summaryPromptChoice).toBeUndefined();
    raw = applySetting(raw, { key: "codexWorkers", value: { model: "gpt-x", effort: "high", fast: null } });
    expect(raw.codexWorkerChoice).toEqual({ model: "gpt-x", effort: "high" });
    expect(appliedCodexWorkers(raw)).toEqual({ model: null, effort: null, fast: null });
    const seeded = (settings: Record<string, unknown>) => { const out: Record<string, unknown> = {}; seedEngineDefaults(settings, (key, value) => { out[key] = value; }); return out; };
    expect(seeded(raw)).toEqual({});
    raw = applySetting(raw, { key: "codexWorkersFollow", value: false });
    expect(appliedCodexWorkers(raw)).toEqual({ model: "gpt-x", effort: "high", fast: null });
    // A new bot starts on the app's defaults (`seedEngineDefaults`), in bot.json's keys.
    expect(seeded({ ...raw, subagentModelDefault: "haiku" })).toEqual({ subagentModel: "haiku", codexWorkers: { model: "gpt-x", effort: "high" } });
  });

  it("through the core: settings.set saves and tells; a bot's model, effort and the subagents' choices reach a new claude head", async () => {
    const dir = tempDir("settings-core");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ languageChoice: "ja", someFutureKey: { kept: true } }));
    const args = join(dir, "claude-args.log");
    const c = core(dir, { FAKE_CLAUDE_ARGS: args, BOTLING_LANGUAGES: "en-US" });
    expect((await c.call({ type: "chat.snapshot", botId: MAIN })).settings).toMatchObject({ language: "ja", effectiveLanguage: "ja" });
    const view = await c.call({ type: "settings.set", change: { key: "subagentModel", value: "haiku" } });
    expect(view.subagentModel).toBe("haiku");
    await c.call({ type: "settings.set", change: { key: "subagentHourCache", value: true } });
    await c.call({ type: "settings.set", change: { key: "language", value: null } });
    expect(c.of("settings.updated").at(-1)!.event).toMatchObject({ settings: { language: null, effectiveLanguage: "en", subagentHourCache: true } });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ someFutureKey: { kept: true }, subagentModelDefault: "haiku", subagentHourCacheChoice: true });
    expect(await c.call({ type: "bot.configure", botId: MAIN, model: "opus", effort: "high" })).toMatchObject({ botId: MAIN, engines: ["claude"], model: "opus", effort: "high", subagentModel: "haiku", codexModel: null });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8"))).toMatchObject({ model: "opus", effort: "high" });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "hi" });
    await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
    const started = logged(args).at(-1);
    expect(started.args.join(" ")).toContain("--model opus");
    expect(started.args.join(" ")).toContain("--effort high");
    expect(started).toMatchObject({ subagentModel: "haiku", subagentCache: "1h" });
    // Back to the defaults: no flags.
    expect(await c.call({ type: "bot.configure", botId: MAIN, model: null, effort: null })).toMatchObject({ model: null, effort: null });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).model).toBeUndefined();
    await expect(c.call({ type: "settings.set", change: { key: "chatAvatarSize", value: 200 } })).rejects.toThrow("bad_request");
  });

  it("engine defaults (1.x's Workspace+EngineDefaults): a change goes to every bot; new projects and bots start on them", async () => {
    const dir = tempDir("engine-defaults");
    mkdirSync(dir, { recursive: true });
    const folder = tempDir("engine-defaults-project");
    mkdirSync(folder, { recursive: true });
    const c = core(dir);
    await c.call({ type: "chat.snapshot", botId: MAIN });
    const botJSON = (id: string | null) => JSON.parse(readFileSync(id ? join(dir, "projects", id, "bot.json") : join(dir, "main", "bot.json"), "utf8"));
    await c.call({ type: "settings.set", change: { key: "subagentModel", value: "haiku" } });
    await c.call({ type: "settings.set", change: { key: "codexWorkers", value: { model: "gpt-x", effort: "high", fast: true } } });
    // Following Codex's config: the choice is kept in settings.json but no bot gets it yet.
    expect(botJSON(null)).toMatchObject({ subagentModel: "haiku" });
    expect(botJSON(null).codexWorkers).toBeUndefined();
    await c.call({ type: "settings.set", change: { key: "codexWorkersFollow", value: false } });
    expect(botJSON(null)).toMatchObject({ subagentModel: "haiku", codexWorkers: { model: "gpt-x", effort: "high", fast: true } });
    const project = await c.call({ type: "projects.add", folder });
    expect(botJSON(project.botId)).toMatchObject({ subagentModel: "haiku", codexWorkers: { model: "gpt-x", effort: "high", fast: true } });
    const made = await c.call({ type: "bots.create", name: "Scout", job: "Watch the weather." });
    expect(botJSON(made.botId)).toMatchObject({ subagentModel: "haiku", codexWorkers: { model: "gpt-x", effort: "high", fast: true } });
    // A bot's own change stays its own; the next app-wide change sets it again (1.x: one batch for all).
    await c.call({ type: "bot.configure", botId: project.botId, subagentModel: "opus" });
    expect(botJSON(project.botId).subagentModel).toBe("opus");
    await c.call({ type: "settings.set", change: { key: "subagentModel", value: null } });
    await c.call({ type: "settings.set", change: { key: "codexWorkersFollow", value: true } });
    for (const id of [null, project.botId, made.botId]) {
      expect(botJSON(id).subagentModel).toBeUndefined();
      expect(botJSON(id).codexWorkers).toBeUndefined();
    }
  });
});
