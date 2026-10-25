// Phase 4a in the real app: the chat page on its own origin (botling-chat://chat) with a plugin's web
// part running in it (a markdown hook, its stylesheet served by the chat origin, a call to its program
// part, ccb.notify) and still no way to the app page; attachments (the + picker, a pasted picture, a
// message with only files), pictures inline and to the head; files the chat does not name are refused.
// Screenshots go to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { desktop, tempDir, until } from "../helpers";
import { chatFrame, launch, MAIN, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

/** A 4×4 red PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");

function writeWebPlugin(core: string) {
  const folder = join(core, "plugins", "shouty");
  mkdirSync(join(folder, "dist", "fonts"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name: "shouty", displayName: "Shouty", version: "1.0.0", engines: { ccb: "^2.0.0" },
    ccb: { web: "dist/web.js", host: "dist/host.mjs", styles: ["dist/web.css"], contributes: { settings: { loud: { type: "boolean", default: true, title: "Loud" } } } },
  }));
  writeFileSync(join(folder, "dist", "web.css"), `.row[data-shouty="1"] .markdown { outline: 3px solid rgb(255, 0, 255); }`);
  writeFileSync(join(folder, "dist", "secret.txt"), "not for the page");
  writeFileSync(join(folder, "dist", "host.mjs"), `export function activate(ccb) { ccb.web.handle("shout", (params) => String(params.text).toUpperCase()); }`);
  writeFileSync(join(folder, "dist", "web.js"), `export function activate(ccb) {
    ccb.messages.afterRender((element, message) => {
      if (message.role !== "bot") return;
      element.dataset.shouty = ccb.settings.get("loud") ? "1" : "0";
    });
    const probe = {};
    try { probe.parentDocument = !!parent.document; } catch { probe.parentDocument = "blocked"; }
    try { probe.parentBridge = typeof parent.botling; } catch { probe.parentBridge = "blocked"; }
    probe.bridge = typeof window.botling;
    probe.origin = location.origin;
    window.__shouty = probe;
    ccb.host.call("shout", { text: "hello" }).then((value) => { window.__shouty.call = value; ccb.notify("said " + value); });
  }`);
}

test("a plugin's web part runs in the chat page, which has its own origin and no way to the app page", async () => {
  const dataDir = tempDir("e2e-4a-plugins");
  writeWebPlugin(join(dataDir, "core"));
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_COMPONENT_SCAN_MS: "200" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    const frame = await chatFrame(page);
    expect(frame.url()).toBe("botling-chat://chat/chat.html");
    const probe = await until(() => frame.evaluate(() => { const p = (window as any).__shouty; return p?.call ? p : null; }), { what: "the plugin to load", timeout: 15_000 });
    expect(probe).toEqual({ parentDocument: "blocked", parentBridge: "blocked", bridge: "undefined", origin: "botling-chat://chat", call: "HELLO" });
    // Its notify is a line in the main bot's chat (this one).
    await expect(chat.locator(".row.notice").last()).toContainText("Shouty: said HELLO");
    // Its markdown hook and its stylesheet (served by the chat origin).
    await say(chat, "hi there");
    const reply = chat.locator(".row.bot[data-id]").last().locator(".markdown");
    await expect(reply).toHaveText("You said: hi there");
    await expect(chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-shouty", "1");
    await expect.poll(() => reply.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(255, 0, 255)");
    // The chat page cannot fetch anything (connect-src 'none'), not even its own origin.
    expect(await frame.evaluate(() => fetch("botling-chat://chat/chat.css").then(() => "fetched", () => "blocked"))).toBe("blocked");
    // What the chat origin serves (asked from main): the stylesheet, but nothing else of the plugin's
    // folder, no file the chat does not name, and none of the app page's files; the app origin no
    // longer serves the chat page.
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    const urls = {
      style: "botling-chat://chat/plugin-files/shouty/dist/web.css",
      secret: "botling-chat://chat/plugin-files/shouty/dist/secret.txt",
      source: "botling-chat://chat/plugin-files/shouty/dist/web.js",
      manifest: "botling-chat://chat/plugin-files/shouty/package.json",
      escape: "botling-chat://chat/plugin-files/shouty/dist/..%2F..%2F..%2Fplugins.json",
      passwd: `botling-chat://chat/attachment/${MAIN}/${encode("file:///etc/passwd")}`,
      appFile: "botling-chat://chat/renderer.js",
      chatOnApp: "app://botling/chat.html",
      chatPage: "botling-chat://chat/chat.html",
    };
    const served = await app.evaluate(async ({ net }, urls) => {
      const out: Record<string, number | string> = {};
      for (const [key, url] of Object.entries(urls)) out[key] = await net.fetch(url).then((response) => response.status, () => "failed");
      return out;
    }, urls);
    expect(served).toEqual({ style: 200, secret: 404, source: 404, manifest: 404, escape: 404, passwd: 404, appFile: 404, chatOnApp: 404, chatPage: 200 });
    await shot(page, "plugin-web-part");
  } finally {
    await app.close();
  }
});

test("attachments: picked files and a pasted picture go with the message, kept in the bot's folder, shown inline and given to the head", async () => {
  const dataDir = tempDir("e2e-4a-files");
  const outside = tempDir("e2e-4a-outside");
  writeFileSync(join(outside, "red.png"), PNG);
  writeFileSync(join(outside, "notes.txt"), "some notes");
  const input = join(dataDir, "claude-input.jsonl");
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_TEST_PICK: JSON.stringify([join(outside, "red.png"), join(outside, "notes.txt")]), FAKE_CLAUDE_INPUT: input } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await chat.locator(".composer button.plus").click();
    await expect(chat.locator(".pending-files .pending")).toHaveCount(2);
    await expect(chat.locator(".pending-files img")).toHaveJSProperty("naturalWidth", 4);
    await shot(page, "attachments-pending");
    await say(chat, "look at these");
    await expect(chat.locator(".pending-files .pending")).toHaveCount(0);
    const mine = chat.locator(".row.user").last();
    await expect(mine.locator(".attachments img")).toHaveJSProperty("naturalWidth", 4);
    await expect(mine).toContainText("notes.txt");
    // Kept in the main bot's attachments folder as 1.x names them.
    const folder = join(dataDir, "core", "main", "attachments");
    const kept = await until(() => (existsSync(folder) && readdirSync(folder).length === 2 ? readdirSync(folder).sort() : null));
    expect(kept[0]).toMatch(/^\d{8}-\d{6}-notes\.txt$/);
    expect(kept[1]).toMatch(/^\d{8}-\d{6}-red\.png$/);
    // The head was told where they are and saw the picture.
    const lines = await until(() => (existsSync(input) ? readFileSync(input, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.text.includes("look at these")) : []).at(-1) ?? null);
    expect(lines.text).toContain(`look at these\n\n(Attachments:\n- ${join(folder, kept[1]!)}\n- ${join(folder, kept[0]!)})`);
    expect(lines.images).toEqual(["image/png"]);
    // In chat.json as 1.x writes attachments.
    const saved = JSON.parse(readFileSync(join(dataDir, "core", "main", "chat.json"), "utf8")) as { text: string; attachments?: { url: string; kind: string }[] }[];
    const line = saved.find((record) => record.text === "look at these")!;
    expect(line.attachments!.map((file) => file.kind).sort()).toEqual(["file", "image"]);
    expect(line.attachments!.every((file) => file.url.startsWith(pathToFileURL(folder).href))).toBe(true);
    // A pasted picture (the page reads it and hands it over), sent with no words.
    const frame = await chatFrame(page);
    await frame.evaluate((base64) => (window as any).webkit.messageHandlers.ccb.postMessage({ type: "addFileData", name: "Pasted image.png", base64 }), PNG.toString("base64"));
    await expect(chat.locator(".pending-files .pending")).toHaveCount(1);
    await chat.locator(".composer button.send").first().click();
    await expect(chat.locator(".row.user").last().locator(".attachments img")).toHaveJSProperty("naturalWidth", 4);
    await expect.poll(() => readdirSync(folder).filter((name) => name.endsWith("Pasted image.png")).length).toBe(1);
    // The pasted copy waiting in core/incoming is gone once kept.
    await expect.poll(() => (existsSync(join(dataDir, "core", "incoming")) ? readdirSync(join(dataDir, "core", "incoming")) : [])).toEqual([]);
    await shot(page, "attachments-sent");
  } finally {
    await app.close();
  }
});

test("Settings: language, bot look and avatar size reach the chat page; a summary setting and this bot's model are saved", async () => {
  const dataDir = tempDir("e2e-4a-settings");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await page.getByRole("button", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await expect(sheet.getByRole("heading", { name: "General" })).toBeVisible();
    // 1.x's default look is Cute: the rail shows characters; Original brings the shapes back.
    const avatar = page.locator(".bot-row").first().locator("img");
    const cute = await avatar.getAttribute("src");
    await sheet.getByRole("radiogroup", { name: "Bot look" }).getByRole("radio", { name: "Original" }).click();
    await expect.poll(() => avatar.getAttribute("src")).not.toBe(cute);
    await sheet.getByLabel("Chat avatar size").fill("80");
    await expect.poll(() => chat.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--chat-avatar-size").trim())).toBe("80px");
    // (Switches show what the core saved: they change once it answers.)
    await sheet.getByRole("switch", { name: "Summarize between your messages" }).click();
    await expect(sheet.getByRole("switch", { name: "Summarize between your messages" })).toBeChecked();
    await shot(page, "settings-general");
    await sheet.getByLabel("App language").selectOption("ja");
    // The page's own words follow (its input box is no longer called "Message").
    await expect(chat.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    const settings = JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8"));
    expect(settings).toMatchObject({ botLookChoice: "original", chatAvatarSizeChoice: 80, intervalSummaryEnabledChoice: true, languageChoice: "ja" });
    await sheet.getByLabel("App language").selectOption("");
    await expect(chat.getByRole("textbox", { name: "Message" })).toHaveCount(1);
    // Engines and subagents; this bot.
    await sheet.getByRole("button", { name: /Engines and subagents/ }).click();
    await sheet.getByRole("switch", { name: "Follow Codex config file" }).click();
    await expect(sheet.getByRole("switch", { name: "Follow Codex config file" })).not.toBeChecked();
    await sheet.getByRole("radiogroup", { name: "Workers' reasoning effort" }).getByRole("radio", { name: "High", exact: true }).click();
    await shot(page, "settings-engines");
    await sheet.getByRole("button", { name: "This bot" }).click();
    await sheet.getByRole("radiogroup", { name: "Claude's model" }).getByRole("radio", { name: "Opus" }).click();
    await expect(sheet.getByRole("radiogroup", { name: "Claude's model" }).getByRole("radio", { name: "Opus" })).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(readFileSync(join(dataDir, "core", "main", "bot.json"), "utf8")).model).toBe("opus");
    expect(JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8"))).toMatchObject({ codexWorkersFollow: false, codexWorkerChoice: { effort: "high" } });
    await shot(page, "settings-bot");
    // Phase 5c: 1.x's "Engines in this bot". The only head cannot go; with both, turning off the one it runs on
    // runs it on the other (asleep here: "Switched to Codex", the next wake is a Codex head).
    await expect(sheet.getByRole("switch", { name: "Claude", exact: true })).toBeDisabled();
    await sheet.getByRole("switch", { name: "Codex", exact: true }).click();
    await expect(sheet.getByRole("switch", { name: "Codex", exact: true })).toBeChecked();
    await expect(sheet.getByRole("switch", { name: "Claude", exact: true })).toBeEnabled();
    await sheet.getByRole("switch", { name: "Claude", exact: true }).click();
    await expect(sheet.getByRole("switch", { name: "Claude", exact: true })).not.toBeChecked();
    await expect(sheet.getByRole("switch", { name: "Codex", exact: true })).toBeDisabled();
    await expect(chat.getByText("Switched to Codex")).toBeVisible();
    expect(JSON.parse(readFileSync(join(dataDir, "core", "main", "bot.json"), "utf8"))).toMatchObject({ engine: "codex", heads: { engines: ["codex"] } });
    await shot(page, "phase5c-engines");
    // The plugin library is a section too; Done closes.
    await sheet.getByRole("button", { name: "Plugins" }).click();
    await expect(sheet.getByRole("region", { name: "Plugins" })).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("projects: Add project picks a folder and shows its chat; the right panel gathers what waits on you", async () => {
  const dataDir = tempDir("e2e-4a-projects");
  const folder = join(tempDir("e2e-4a-folder"), "Garden");
  mkdirSync(folder, { recursive: true });
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_TEST_PICK_FOLDER: folder, BOTLING_WAITING_SCAN_MS: "200" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    const panel = page.locator(".detail-panel");
    await expect(panel.locator(".detail-name")).toHaveText("Main bot");
    await page.getByRole("button", { name: "Add project" }).click();
    // The new project is in the column (under the main bot and Maintainer) and its chat is on screen.
    const row = page.locator(".bot-row", { hasText: "Garden" });
    await expect(row).toHaveAttribute("aria-current", "page");
    const names = await page.locator(".bot-row .bot-name").allTextContents();
    expect(names.slice(0, 2)).toEqual(["Main bot", "Maintainer"]);
    expect(names).toContain("Garden");
    await expect(panel.locator(".detail-name")).toHaveText("Garden");
    expect(JSON.parse(readFileSync(join(dataDir, "core", "projects.json"), "utf8"))[0]).toMatchObject({ name: "Garden", folder: pathToFileURL(folder).href + "/" });
    // Picking it again finds the same project.
    await page.locator(".bot-row", { hasText: "Main bot" }).click();
    await page.getByRole("button", { name: "Add project" }).click();
    await expect(row).toHaveAttribute("aria-current", "page");
    expect(await page.locator(".bot-row", { hasText: "Garden" }).count()).toBe(1);
    // Its memory says what it is doing and what waits on you.
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\nok\n## In progress\n- planting tulips\n## Waiting on you\n- Which colour of tulips?\n## Decided\n");
    await expect(panel.locator(".now-doing")).toHaveText("planting tulips");
    await expect(row.locator(".bot-dot.waiting")).toBeVisible();
    await page.locator(".bot-row", { hasText: "Main bot" }).click();
    const item = panel.locator(".waiting-item");
    await expect(item).toHaveText(/Which colour of tulips\?/);
    await shot(page, "waiting-on-you");
    // Opening it shows that bot's chat; ignoring it takes it off the list and the dot away.
    await item.locator(".waiting-open").click();
    await expect(row).toHaveAttribute("aria-current", "page");
    await page.locator(".bot-row", { hasText: "Main bot" }).click();
    await panel.getByRole("button", { name: "Ignore" }).click();
    await expect(item).toHaveCount(0);
    await expect(row.locator(".bot-dot.waiting")).toHaveCount(0);
    expect(JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8")).ignoredWaiting).toHaveLength(1);
    await expect(chat.locator(".composer")).toBeVisible();
  } finally {
    await app.close();
  }
});
