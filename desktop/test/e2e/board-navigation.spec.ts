import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { desktop, swiftLine } from "../helpers";
import { launch, MAIN, post, say } from "./launch";

test("Chat and Board stay centered and directly available with no pins, across updates and bot navigation", async () => {
  const { app, page, chat } = await launch({ chat: [swiftLine({
    id: "B0000000-0000-4000-8000-000000000001", role: "user", text: "Synthetic navigation check",
  })] });
  try {
    // The existing launch helper uses show:false and prohibited native activation.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()))).toBe(true);
    const control = page.getByRole("group", { name: "Chat or Board", exact: true });
    await expect(control).toBeVisible();
    const chatButton = control.getByRole("button", { name: "Chat", exact: true });
    const boardButton = control.getByRole("button", { name: "Board", exact: true });
    await expect(chatButton).toHaveAttribute("aria-pressed", "true");
    await expect(boardButton).toHaveAttribute("aria-pressed", "false");
    for (const width of [1120, 800]) {
      await page.setViewportSize({ width, height: 820 });
      const switchBox = (await control.boundingBox())!;
      const column = (await page.locator(".chat-column").boundingBox())!;
      const header = (await page.locator(".chat-column > .chat-header").boundingBox())!;
      const frame = (await page.locator("#chat-frame").boundingBox())!;
      expect(Math.abs(switchBox.x + switchBox.width / 2 - column.x - column.width / 2)).toBeLessThanOrEqual(1);
      expect(switchBox.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(switchBox.y + switchBox.height).toBeLessThanOrEqual(frame.y);
    }
    await boardButton.click();
    await expect(boardButton).toHaveAttribute("aria-pressed", "true");
    await expect(chat.locator("body")).toHaveClass(/\bboard\b/);
    // A live snapshot of this chat must retain its selected surface.
    expect(await post(page, { v: 10, id: "navigation-refresh", cmd: { type: "settings.set", change: { key: "botLook", value: "original" } } })).toMatchObject({ ok: true });
    await page.locator(`.bot-row[data-bot="${MAIN}"]`).click();
    await expect(boardButton).toHaveAttribute("aria-pressed", "true");
    await expect(chat.locator("body")).toHaveClass(/\bboard\b/);
    // Segments select their named surface; pressing Board twice does not return to Chat.
    await boardButton.click();
    await expect(boardButton).toHaveAttribute("aria-pressed", "true");
    await chatButton.click();
    await expect(chat.locator("body")).not.toHaveClass(/\bboard\b/);
    await boardButton.click();
    await page.locator(".bot-row", { hasText: "Maintainer" }).click();
    await expect(chatButton).toHaveAttribute("aria-pressed", "true");
    await expect(chat.locator("body")).not.toHaveClass(/\bboard\b/);
    await page.locator(`.bot-row[data-bot="${MAIN}"]`).click();
    await expect(chatButton).toHaveAttribute("aria-pressed", "true");
    const screens = join(desktop, ".cache", "board-navigation");
    mkdirSync(screens, { recursive: true });
    await page.setViewportSize({ width: 1120, height: 820 });
    await page.screenshot({ path: join(screens, "centered-chat.png") });
    await boardButton.click();
    await expect(chat.locator("body")).toHaveClass(/\bboard\b/);
    await page.screenshot({ path: join(screens, "centered-board.png") });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()))).toBe(true);
  } finally { await app.close(); }
});

test("watching a subagent hides the switch and returning restores the selected Board", async () => {
  const { app, page, chat } = await launch({ env: { FAKE_CLAUDE_BG_DELAY_MS: "200" } });
  try {
    const control = page.getByRole("group", { name: "Chat or Board", exact: true });
    await say(chat, "/bgagent");
    const row = page.locator(".subagent-row").first();
    await expect(row).toBeVisible();
    await control.getByRole("button", { name: "Board", exact: true }).click();
    await row.click();
    await expect(chat.locator("#subagent-bar")).toBeVisible();
    await expect(control).toBeHidden();
    await chat.locator("#subagent-bar .back").click();
    await expect(control).toBeVisible();
    await expect(control.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(chat.locator("body")).toHaveClass(/\bboard\b/);
  } finally { await app.close(); }
});
