// Several bots, kept over a restart, and imported from a (synthetic) Botling 1.x folder.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { IDS, writeSwiftFixture } from "../fixtures/swift-data";
import { launch, say } from "./launch";

test("a restart keeps the chat, and the head resumes its claude session", async () => {
  const first = await launch();
  await say(first.chat, "remember me");
  await expect(first.chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-state", "done");
  await first.app.close();
  const again = await launch({ dataDir: first.dataDir });
  try {
    await expect(again.chat.locator(".row.user").last()).toContainText("remember me");
    await expect(again.chat.locator(".row.bot[data-id]").last().locator(".markdown")).toHaveText("You said: remember me");
    await say(again.chat, "/resume");
    await expect(again.chat.locator(".row.bot[data-id]").last().locator(".markdown")).toHaveText(/resumed=true/);
  } finally {
    await again.app.close();
  }
});

test("bots imported from Botling 1.x show in the left column with their chats, and each runs in its own folder", async () => {
  const dir = tempDir("e2e-import");
  const { source, projectFolder } = writeSwiftFixture(dir);
  const log = join(dir, "starts.log");
  const { app, page, chat } = await launch({ dataDir: join(dir, "botling2"), importFrom: source, env: { FAKE_CLAUDE_LOG: log } });
  try {
    await expect(page.locator(".bot-row .bot-name")).toHaveText(["Main bot", "blog", "News", "Broken"]);
    await expect(page.locator(".rail-note")).toContainText("Imported 4 bots and 6 messages");
    await expect(chat.locator(".row.bot[data-id]").last().locator(".markdown")).toContainText("40 posts, 3 drafts");
    await expect(chat.locator(".row.bot", { hasText: "Wants to use" })).toContainText("Allow once"); // Answered, folded.
    await page.locator(".bot-row", { hasText: "blog" }).click();
    await expect(page.locator(".chat-title")).toHaveText("blog");
    await expect(chat.locator(".row.bot[data-id]").last().locator(".markdown")).toHaveText("Done: 40 covers added.");
    await say(chat, "status?");
    await expect(chat.locator(".row.bot[data-id]").last().locator(".markdown")).toHaveText("You said: status?");
    const starts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(starts.at(-1).cwd).toBe(projectFolder);
    // A bot whose chat could not be imported has an empty chat, not a broken one.
    await page.locator(".bot-row", { hasText: "Broken" }).click();
    await expect(page.locator(".chat-title")).toHaveText("Broken");
    await expect(chat.locator(".row")).toHaveCount(0);
    await page.locator(".bot-row", { hasText: "News" }).click();
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("Today: rain later.");
    expect(IDS.standalone).toBeTruthy();
  } finally {
    await app.close();
  }
});
