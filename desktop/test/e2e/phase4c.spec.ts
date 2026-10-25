// Phase 4c in the real app: a bot called in with @ answers in the main bot's chat under its own name
// and face (the @ menu offers it), a bot's @ calls another in. Screenshots go to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch, say } from "./launch";

const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";
const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

test("@ calls a bot into this chat: its line under its own name and face; a bot's @ does too", async () => {
  const dataDir = tempDir("e2e-4c-callin");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    // The @ menu offers Maintainer (the main bot and Maintainer are offered first, as 1.x).
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.page().keyboard.type("@Mai");
    await expect(chat.locator(".mention-list")).toContainText("Maintainer");
    for (let i = 0; i < 4; i++) await box.page().keyboard.press("Backspace");
    await say(chat, "@Maintainer is the weather card yours?");
    const guest = chat.locator(".row.bot[data-id]", { hasText: "Maintainer here: @Maintainer is the weather card yours?" });
    await expect(guest).toBeVisible();
    await expect(guest).toContainText("Maintainer");
    // The main bot answered your line too.
    await expect(chat.locator(".row.bot[data-id]", { hasText: "You said: @Maintainer is the weather card yours?" })).toBeVisible();
    // A bot's own @ calls one in: as a fellow bot's question.
    await say(chat, "/mention Maintainer which components are yours?");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "Maintainer here: which components are yours?" })).toBeVisible();
    await shot(page, "phase4c-callin");
    // Maintainer's own chat keeps both exchanges.
    await page.locator(`.bot-row[data-bot="${MAINTAINER}"]`).click();
    await expect(chat.locator(".row.notice", { hasText: "Called into Main bot's chat with @: @Maintainer is the weather card yours?" })).toBeVisible();
    await expect(chat.locator(".row.notice", { hasText: "Called into Main bot's chat with @: @Maintainer which components are yours?" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the right panel's Tasks: the open card, waiting on you, just done; the count beside the bot's name", async () => {
  const dataDir = tempDir("e2e-4c-tasks");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    const tasks = page.locator(".tasks-section");
    await expect(tasks.locator(".task-none")).toHaveText("Nothing under way");
    await say(chat, "/task");
    const card = tasks.locator(".task-card");
    await expect(card.locator(".task-name")).toHaveText("Docs");
    await expect(card.locator(".task-field")).toHaveText(["Nowwriting the intro", "Nextexamples", "Blocked—"]);
    await expect(card.locator(".task-owner")).toHaveText("Claude");
    await expect(page.locator(`.bot-row[data-bot="6A0B0000-0000-4000-8000-000000000002"] .task-count`)).toHaveText("1 task");
    await say(chat, '/say Which colour?\n<task name="Theme" state="waiting" blocked="your pick of colour"/>');
    const waiting = page.locator(".waiting-task", { hasText: "Theme" });
    await expect(waiting).toContainText("your pick of colour");
    await expect(page.locator(`.bot-row[data-bot="6A0B0000-0000-4000-8000-000000000002"] .task-count`)).toHaveText("2 tasks");
    // The running one stays open; the waiting one is a row that opens when pressed.
    await expect(tasks.locator(".task-row", { hasText: "Theme" })).toContainText("Waiting on you: your pick of colour");
    await say(chat, '/say Shipped.\n<task name="Release" state="done"/>');
    await expect(page.locator(".done-section .done-task", { hasText: "Release" })).toContainText("✓");
    await waiting.click();
    await expect(tasks.locator(".task-card .task-name")).toHaveText("Theme");
    await expect(tasks.locator(".task-card .task-field-value.waiting")).toHaveText("your pick of colour");
    await shot(page, "phase4c-tasks");
    // Pressed again, it closes (the latest running one is open again).
    await tasks.locator(".task-card-head").click();
    await expect(tasks.locator(".task-card .task-name")).toHaveText("Docs");
  } finally {
    await app.close();
  }
});

test("the left column: pin a bot to the top, search it (⌘K), fold it into a strip of faces", async () => {
  const dataDir = tempDir("e2e-4c-rail");
  const { app, page } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    for (const [name, job] of [["Weather", "The weather at 07:00."], ["Garden", "Water the plants."]]) {
      await page.getByRole("button", { name: "New bot" }).click();
      const form = page.getByRole("form", { name: "New bot" });
      await form.getByRole("textbox", { name: "Name" }).fill(name);
      await form.getByRole("textbox", { name: "Its job" }).fill(job);
      await form.getByRole("button", { name: "Create" }).click();
      await expect(form).toHaveCount(0);
    }
    const rows = page.locator(".bots .bot-row .bot-name");
    await expect(rows).toHaveText(["Main bot", "Weather", "Garden", "Maintainer"]);
    // Pin "Garden" with the glyph on its row: it goes under "Pinned", first after the main bot.
    const garden = page.locator(".bot-row-wrap", { has: page.locator(".bot-name", { hasText: "Garden" }) });
    await garden.hover();
    await garden.getByRole("button", { name: "Pin Garden" }).click();
    await expect(page.locator(".rail-section")).toHaveText("Pinned");
    await expect(rows).toHaveText(["Main bot", "Garden", "Weather", "Maintainer"]);
    const gardenId = await page.locator(".bot-row", { hasText: "Garden" }).getAttribute("data-bot");
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8")).pinnedBots).toEqual([gardenId]);
    await shot(page, "phase4c-pinned");
    // Unpin from the row's menu.
    await page.locator(".bot-row", { hasText: "Garden" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await expect(page.locator(".rail-section")).toHaveCount(0);
    // ⌘K: the search field; only matching rows; nothing: "No bots match"; Esc empties it.
    await page.keyboard.press("Meta+K");
    const search = page.getByRole("searchbox", { name: "Search bots" });
    await expect(search).toBeFocused();
    await page.keyboard.type("wea");
    await expect(rows).toHaveText(["Weather"]);
    await page.keyboard.type("zz");
    await expect(page.locator(".rail-empty")).toHaveText("No bots match");
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(4);
    // Fold it (⌃⌘S or the button): faces only, kept in settings.json; hover a face for its name.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const strip = page.locator(".rail-strip");
    await expect(strip.locator(".strip-bot")).toHaveCount(4);
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8")).railCollapsed).toBe(true);
    await strip.locator(".strip-bot").nth(1).hover();
    await expect(page.locator(".rail-tip-title")).toHaveText("Weather");
    await shot(page, "phase4c-strip");
    await page.keyboard.press("Control+Meta+S");
    await expect(page.locator(".rail .bots")).toBeVisible();
  } finally {
    await app.close();
  }
});
