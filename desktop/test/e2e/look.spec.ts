// Screenshots of the app for a person to look at (not assertions about pixels). Saved under
// desktop/.tmp/screens/ (ignored by git).
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { desktop, tempDir } from "../helpers";
import { writeSwiftFixture } from "../fixtures/swift-data";
import { launch, say } from "./launch";

const dir = join(desktop, ".tmp", "screens");

test("screenshots: streaming, an approval, a stopped reply", async () => {
  mkdirSync(dir, { recursive: true });
  const { app, page, chat } = await launch({ env: { BOTLING_APPROVAL_TIMEOUT_MS: "60000" } });
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await say(chat, "Hello! What is $\\int_0^1 x^2\\,dx$?");
    await expect(chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-state", "done");
    await say(chat, "/tool ls -la ~/Documents");
    await chat.locator(".choices").last().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, "approval.png") });
    await chat.locator(".choices").last().getByRole("button", { name: /Allow once/ }).click();
    await expect(chat.locator(".row.bot[data-id]", { hasText: "Allowed" })).toHaveAttribute("data-state", "done");
    await say(chat, "/slow");
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("word12");
    await page.screenshot({ path: join(dir, "streaming.png") });
    await chat.locator("body").press("Escape");
    await expect(chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-state", "stopped");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, "stopped.png") });
  } finally {
    await app.close();
  }
});

test("screenshots: bots imported from 1.x", async () => {
  mkdirSync(dir, { recursive: true });
  const root = tempDir("look-import");
  const { source } = writeSwiftFixture(root);
  const { app, page, chat } = await launch({ dataDir: join(root, "botling2"), importFrom: source });
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("40 posts");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, "imported-main.png") });
    await page.locator(".bot-row", { hasText: "blog" }).click();
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("40 covers");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, "imported-blog.png") });
  } finally {
    await app.close();
  }
});
