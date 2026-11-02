// The plugin host through the built core, with the real Node host (Web/host/src/host.ts bundled to
// out/host/host.mjs) and plugins in a temp library (PluginHostTests.swift, ported): beforeSend changes
// or stops your message, afterReply and bots.onReply see replies, notify/routines/storage, a plugin
// that fails to load is turned off and said so, commands run, a killed host comes back, secrets reach
// only the program part (sealed on disk), and creating bots or talking to them needs the permission.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { saveProjectRow } from "../../src/core/projects";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { BOTLING_TEST_SEAL_KEY: "test-key", BOTLING_COMPONENT_SCAN_MS: "200", FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGTERM");
});

/** A plugin with only a program part (`ccb.host`). */
function hostPlugin(dir: string, name: string, source: string, ccb: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  const folder = join(dir, "plugins", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ...top, ccb: { host: "dist/host.mjs", ...ccb } }));
  writeFileSync(join(folder, "dist", "host.mjs"), source);
}

const notices = async (c: CoreHarness): Promise<string[]> => (await c.chat()).messages.filter((m: any) => m.role === "notice").map((m: any) => m.text as string);
const pluginsView = async (c: CoreHarness) => c.call({ type: "plugins.list" });

describe("the plugin host", () => {
  it("beforeSend changes what you send and can stop it", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "tidy", `export function activate(ccb) {
      ccb.hooks.beforeSend((m) => m.text.includes("password") ? false : m.text.replaceAll("\\\\(", "$").replaceAll("\\\\)", "$"));
    }`);
    const c = core(dir);
    await until(async () => (await pluginsView(c)).host.running, { timeout: 15_000 });
    const sent = await c.call({ type: "chat.send", botId: MAIN, text: "Compute \\(x^2\\)" });
    expect(sent.turnId).toBeTruthy();
    const user = (await c.chat()).messages.find((m: any) => m.role === "user");
    expect(user.text).toBe("Compute $x^2$");
    await c.call({ type: "files.data", botId: MAIN, name: "retained.txt", base64: Buffer.from("original attachment").toString("base64") });
    const stopped = await c.call({ type: "chat.send", botId: MAIN, text: "My password is 1234" });
    expect(stopped).toMatchObject({ turnId: null, stoppedBy: "tidy" });
    const chat = await c.chat();
    expect(chat.messages.some((m: any) => m.role === "user" && m.text.includes("1234"))).toBe(false);
    // Not "the last message": the first message's reply may still be arriving after the notice.
    expect(chat.messages.filter((m: any) => m.role === "notice").at(-1)).toMatchObject({ text: 'Plugin "tidy" stopped this message: My password is 1234' });
    expect(chat.pendingFiles).toEqual([expect.objectContaining({ name: "retained.txt" })]);
    await c.call({ type: "chat.send", botId: MAIN, text: "Retry without the secret" });
    expect((await c.chat()).pendingFiles).toEqual([]);
  });

  it("afterReply, bots.onReply, notify, storage and routines.add; a plugin's own env has no core variables", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "helper", `export function activate(ccb) {
      ccb.hooks.afterReply((m) => m.text + " (checked)");
      ccb.bots.onReply(async (bot, reply) => {
        const bots = await ccb.bots.list();
        ccb.notify(bot.name + " replied, " + bots.length + " bots in all: " + bots.map((b) => b.id + "/" + b.role).join(","));
        ccb.storage.set("last", reply);
      });
      ccb.routines.add("main", "0 9 * * 1", "Monday backup: Push the plugin library to the backup folder");
      ccb.notify("env " + Object.keys(process.env).filter((k) => /^(BOTLING|FAKE|ELECTRON)/.test(k)).join(",") + "|");
    }`);
    const c = core(dir);
    await until(async () => (await notices(c)).some((text) => text.startsWith("helper: env")), { timeout: 15_000 });
    expect((await notices(c)).find((text) => text.startsWith("helper: env"))).toBe("helper: env |");
    await until(() => readFileSync(join(dir, "main", "routines.cron"), "utf8").includes("0 9 * * 1 Monday backup"));
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "Hi" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === turnId));
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "bot" && m.text === "You said: Hi (checked)"));
    await until(async () => (await notices(c)).some((text) => text.includes("Main bot replied, 2 bots in all: main/main,DEC0DE00-0000-4000-8000-00000000DEC0/manager")));
    await until(() => existsSync(join(dir, "plugin-data", "helper", "storage.json")) && readFileSync(join(dir, "plugin-data", "helper", "storage.json"), "utf8").includes("You said: Hi (checked)"));
    // A guest's line (called in with @) is a reply too: bots.onReply hears it as that bot's (1.x's `replyObserver`).
    await until(async () => !(await c.chat()).running);
    await c.call({ type: "chat.send", botId: MAIN, text: "@Maintainer hello" });
    await until(async () => (await notices(c)).some((text) => text.startsWith("helper: Maintainer replied")), { timeout: 15_000 });
    // A second start adds the same routine once.
    expect(readFileSync(join(dir, "main", "routines.cron"), "utf8").match(/Monday backup/g)).toHaveLength(1);
  });

  it("a plugin that fails to load is turned off and said so; commands run; a killed host comes back", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "broken", "export function activate() { throw new Error('kaput'); }");
    hostPlugin(dir, "calc", `export function activate(ccb) {
      ccb.commands.register("calc.double", (n) => (n ?? 21) * 2);
      ccb.commands.register("calc.pid", () => process.pid);
    }`, { contributes: { commands: [{ id: "calc.double", title: "Double" }] } });
    const c = core(dir);
    await until(async () => (await pluginsView(c)).plugins.find((p: any) => p.name === "broken")?.failure?.includes("kaput"), { timeout: 15_000 });
    expect((await notices(c)).some((text) => text.includes('Plugin "broken" failed and was disabled for now: The program part failed to load: kaput'))).toBe(true);
    // Maintainer is asked to fix it.
    await until(async () => (await c.chat("DEC0DE00-0000-4000-8000-00000000DEC0")).messages.some((m: any) => m.role === "relay" && m.text.includes('The plugin "broken" is broken')));
    await until(async () => (await pluginsView(c)).plugins.find((p: any) => p.name === "calc")?.commands[0]?.registered);
    expect(await c.call({ type: "plugins.command", id: "calc.double" })).toEqual({ result: 42 });
    await expect(c.call({ type: "plugins.command", id: "calc.nothing" })).rejects.toThrow(/not_found/);
    const pid = (await c.call({ type: "plugins.command", id: "calc.pid" })).result as number;
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    await until(async () => { try { const next = (await c.call({ type: "plugins.command", id: "calc.pid" })).result; return next !== pid ? next : null; } catch { return null; } }, { timeout: 10_000 });
    // An unexplained exit is not blamed on a plugin.
    expect((await pluginsView(c)).plugins.find((p: any) => p.name === "calc").enabled).toBe(true);
    // Quitting ends the host too.
    const last = (await c.call({ type: "plugins.command", id: "calc.pid" })).result as number;
    await c.kill("SIGTERM");
    await until(() => !alive(last), { timeout: 5_000 });
  });

  it("a web part's call made before the host has loaded its program part waits for the load (the Phase 4a e2e flake)", async () => {
    const dir = tempDir("plugin-host");
    // A program part that takes 2.5 s to load, as on a busy computer; its web part calls at once.
    hostPlugin(dir, "slow", `await new Promise((resolve) => setTimeout(resolve, 2500));
      export function activate(ccb) { ccb.web.handle("shout", (params) => String(params.text).toUpperCase()); }`, { web: "dist/web.js" });
    writeFileSync(join(dir, "plugins", "slow", "dist", "web.js"), "export function activate() {}");
    const c = core(dir);
    await until(async () => (await c.call({ type: "plugins.web" })).specs.some((spec: any) => spec.name === "slow"), { timeout: 15_000 });
    expect((await pluginsView(c)).host.running).toBe(false);
    expect(await c.call({ type: "plugins.call", name: "slow", method: "shout", params: { text: "hello" }, from: "chat" })).toEqual({ result: "HELLO" });
    // A method it does not handle still fails, at once once it is loaded.
    await expect(c.call({ type: "plugins.call", name: "slow", method: "whisper", params: null, from: "chat" })).rejects.toThrow(/does not handle/);
  });

  it("frames and the chat page call only what a plugin exposes, and run only commands they may (plan M2, G3)", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "teller", `export function activate(ccb) {
        ccb.ui.expose("balance", () => 42);
        ccb.commands.register("teller.run", () => "ran");
      }`, { web: "dist/web.js" });
    writeFileSync(join(dir, "plugins", "teller", "dist", "web.js"), "export function activate() {}");
    // No web part: nothing in the chat page or a frame speaks for it.
    hostPlugin(dir, "vault", `export function activate(ccb) {
        ccb.web.handle("open", () => "opened");
        ccb.commands.register("vault.open", () => "opened");
      }`);
    const c = core(dir);
    await until(() => c.call({ type: "plugins.command", id: "vault.open" }).then(() => true, () => false), { timeout: 15_000 });
    expect(await c.call({ type: "plugins.call", name: "teller", method: "balance", params: null, from: "frame" })).toEqual({ result: 42 });
    expect(await c.call({ type: "plugins.call", name: "teller", method: "balance", params: null, from: "chat" })).toEqual({ result: 42 });
    await expect(c.call({ type: "plugins.call", name: "vault", method: "open", params: null, from: "chat" })).rejects.toThrow(/not on/);
    // A frame runs its own plugin's commands only; the chat page only those of plugins it runs.
    expect(await c.call({ type: "plugins.command", id: "teller.run", from: "frame", name: "teller" })).toEqual({ result: "ran" });
    await expect(c.call({ type: "plugins.command", id: "vault.open", from: "frame", name: "teller" })).rejects.toThrow(/forbidden/);
    await expect(c.call({ type: "plugins.command", id: "teller.run", from: "frame" })).rejects.toThrow(/forbidden|bad_request/);
    expect(await c.call({ type: "plugins.command", id: "teller.run", from: "chat" })).toEqual({ result: "ran" });
    await expect(c.call({ type: "plugins.command", id: "vault.open", from: "chat" })).rejects.toThrow(/forbidden/);
    // The app page itself (the Plugins page's buttons) still runs any.
    expect(await c.call({ type: "plugins.command", id: "vault.open" })).toEqual({ result: "opened" });
  });

  it("secrets: sealed on disk, given only to the program part, never shown; bots.create needs the bots permission; bots.send is open to any plugin (as 1.x)", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "news", `export function activate(ccb) {
      ccb.commands.register("news.token", () => ccb.settings.get("token"));
      ccb.commands.register("news.make", async () => { try { const bot = await ccb.bots.create({ name: "Morning news", job: "x" }); return bot.name + "/" + bot.role + "/" + bot.created; } catch (e) { return e.message; } });
      ccb.commands.register("news.say", () => { ccb.bots.send("main", "hello from a plugin"); return "sent"; });
    }`, { permissions: ["bots"], contributes: { settings: { token: { type: "string", title: "Token", secret: true }, greeting: { type: "string", title: "Greeting", default: "hi" } } } });
    hostPlugin(dir, "quiet", `export function activate(ccb) {
      ccb.commands.register("quiet.make", async () => { try { await ccb.bots.create({ name: "Sneaky", job: "x" }); return "made"; } catch (e) { return e.message; } });
      ccb.commands.register("quiet.say", () => { ccb.bots.send("main", "sneaky message"); return "sent"; });
    }`);
    const c = core(dir);
    await until(async () => (await pluginsView(c)).host.running, { timeout: 15_000 });
    const view = await c.call({ type: "plugins.secret", name: "news", key: "token", value: "tok-123-plain" });
    expect(view.plugins.find((p: any) => p.name === "news").settings).toEqual([
      { key: "token", type: "string", title: "Token", options: [], value: null, secret: true, set: true },
      { key: "greeting", type: "string", title: "Greeting", options: [], value: "hi", secret: false, set: true },
    ]);
    expect(JSON.stringify(view)).not.toContain("tok-123");
    expect(readFileSync(join(dir, "plugin-secrets.json"), "utf8")).not.toContain("tok-123");
    expect(existsSync(join(dir, "plugins.json")) ? readFileSync(join(dir, "plugins.json"), "utf8") : "").not.toContain("tok-123");
    await until(async () => (await c.call({ type: "plugins.command", id: "news.token" })).result === "tok-123-plain", { timeout: 10_000 });
    await expect(c.call({ type: "plugins.setting", name: "news", key: "token", value: "x" })).rejects.toThrow(/plugins\.secret/);
    await expect(c.call({ type: "plugins.setting", name: "news", key: "greeting", value: 5 })).rejects.toThrow(/not a string/);
    // Since Phase 4b a plugin with the bots permission makes a bot of its own (1.x's makeBot with the plugin's
    // name); asking again gives the same bot back; one you removed is not made again (removed-bots.json).
    expect((await c.call({ type: "plugins.command", id: "news.make" })).result).toBe("Morning news/bot/true");
    expect((await c.call({ type: "plugins.command", id: "news.make" })).result).toBe("Morning news/bot/false");
    const made = (await c.call({ type: "chat.snapshot" })).bots.find((b: any) => b.name === "Morning news");
    expect(JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"))[0]).toMatchObject({ name: "Morning news", job: "x", plugin: "news" });
    await c.call({ type: "bots.remove", botId: made.id });
    expect((await c.call({ type: "plugins.command", id: "news.make" })).result).toBe('The user removed the bot "Morning news"; it is not made again.');
    expect(JSON.parse(readFileSync(join(dir, "removed-bots.json"), "utf8"))).toEqual(["news/morning news"]);
    expect((await c.call({ type: "plugins.command", id: "quiet.make" })).result).toBe('Creating bots needs the "bots" permission in package.json.');
    await c.call({ type: "plugins.command", id: "quiet.say" });
    await c.call({ type: "plugins.command", id: "news.say" });
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "user" && m.text === "hello from a plugin"));
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "user" && m.text === "sneaky message"));
    // After a restart the sealed secret is opened again.
    await c.kill("SIGTERM");
    const again = core(dir);
    await until(async () => { try { return (await again.call({ type: "plugins.command", id: "news.token" })).result === "tok-123-plain"; } catch { return false; } }, { timeout: 15_000 });
    // Turning a plugin off stops its program part.
    await again.call({ type: "plugins.enable", name: "news", enabled: false });
    await until(async () => { try { await again.call({ type: "plugins.command", id: "news.token" }); return false; } catch { return true; } }, { timeout: 10_000 });
  });

  it("Host API v3 (plan M5): a plugin's message shows as its own, events reach it, it reads the app's settings and asks in the chat", async () => {
    const dir = tempDir("plugin-host");
    hostPlugin(dir, "watch", `export function activate(api) {
      api.events.on("messagePosted", (m) => { if (m.role === "bot") api.notify("posted " + m.botId + " " + m.text); });
      api.events.on("turnFinished", (t) => api.notify("finished " + t.botId + " " + t.ok));
      api.commands.register("watch.say", () => api.bots.send("main", "ping from watch").then((r) => typeof r.messageId));
      api.commands.register("watch.lang", () => api.settings.app("language"));
      api.commands.register("watch.pick", () => api.ui.quickPick([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], { title: "Which?" }));
      api.commands.register("watch.stop", () => api.bots.interrupt("main").then(() => "stopped", (e) => e.message));
    }`, {}, { displayName: "Watcher" });
    const c = core(dir);
    await until(() => c.call({ type: "plugins.command", id: "watch.lang" }).then((r) => r.result, () => null), { timeout: 15_000 });
    expect((await c.call({ type: "plugins.command", id: "watch.lang" })).result).toMatch(/^(en|zh-Hant)$/);
    expect((await c.call({ type: "plugins.command", id: "watch.say" })).result).toBe("string");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "user" && m.text === "ping from watch"));
    expect((await c.chat()).messages.find((m: any) => m.role === "user" && m.text === "ping from watch").via).toBe("Watcher");
    await until(async () => (await notices(c)).includes("Watcher: posted main You said: ping from watch"));
    await until(async () => (await notices(c)).includes("Watcher: finished main true"));
    expect((await c.call({ type: "plugins.command", id: "watch.stop" })).result).toBe('Stopping bots needs the "bots" permission in package.json.');
    // The question waits in the main bot's chat; a pick there answers the plugin.
    const picking = c.call({ type: "plugins.command", id: "watch.pick" });
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "Watcher: Which?"));
    const question = (await c.chat()).messages.find((m: any) => m.role === "notice" && m.text === "Watcher: Which?");
    expect(question.choices.map((choice: any) => choice.label)).toEqual(["Alpha", "Beta", "Cancel"]);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 1 });
    expect((await picking).result).toBe("b");
  });

  it("workspace (plan W1): a plugin reads what the whiteboard reads and hears when a bot's memory changes", async () => {
    const dir = tempDir("plugin-host");
    const PROJECT = "B0000000-0000-4000-8000-000000000A11";
    const folder = join(tempDir("plugin-host-proj"), "Site");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- The theme is live.\n");
    saveProjectRow(dir, { id: PROJECT, name: "Site", folder, avatar: "triangle" });
    hostPlugin(dir, "board", `export function activate(api) {
      api.workspace.onChange((change) => {
        if (change.kinds.includes("memory")) api.workspace.memory(change.botIds.find((id) => id !== "main")).then((m) => api.notify("memory " + change.botIds.join(",") + " " + m.currentStatus.join("|")));
      });
      api.commands.register("board.read", async () => {
        const bots = await api.workspace.bots();
        const site = bots.find((bot) => bot.name === "Site");
        const memory = await api.workspace.memory(site.id);
        const days = await api.workspace.taskHistory(site.id, 7);
        const face = await api.workspace.face("main", "original");
        return { roles: bots.map((bot) => bot.id === "main" ? "main" : bot.role), folder: site.folder, status: memory.currentStatus, days: days.length, face: face.startsWith("data:image/svg+xml;base64,") };
      });
    }`, {}, { displayName: "Board" });
    const c = core(dir, { BOTLING_WAITING_SCAN_MS: "200" });
    const read = await until(() => c.call({ type: "plugins.command", id: "board.read" }).then((r) => r.result, () => null), { timeout: 15_000 });
    expect(read).toMatchObject({ folder: "Site", status: ["The theme is live."], days: 7, face: true });
    expect(read.roles).toContain("main");
    expect(read.roles).toContain("manager");
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- The theme is back up.\n");
    await until(async () => (await notices(c)).includes(`Board: memory ${PROJECT} The theme is back up.`), { timeout: 15_000 });
  });
});
