// Phase 5c in the real app: Settings → Usage (1.x's usage page) shows today's cost and tokens from the bots'
// turns, Claude's and Codex's subscription limits as they last reported them, and the bots by use.
// Screenshots go to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");

test("Settings → Usage: today's cost and tokens, by bot, the earlier days, Claude's and Codex's limits", async () => {
  const dataDir = tempDir("e2e-5c-usage");
  const core = join(dataDir, "core");
  mkdirSync(core, { recursive: true });
  // Codex's limits as it last reported them (an hour ago: "as of 1 h ago"), and a day before today (1.x's files).
  const swiftNow = Date.now() / 1000 - 978_307_200;
  writeFileSync(join(core, "codex-rate-limits.json"), JSON.stringify({ week: { used: 0.31, resetsAt: swiftNow + 5 * 86400, seen: swiftNow - 3600 } }));
  writeFileSync(join(core, "spending.json"), JSON.stringify({ day: "2026-01-01", spent: 1.25, byBot: { Shop: 1.25 }, tokens: { input: 1000, output: 2000, cacheWrite: 0, cacheRead: 30000 }, tokensByBot: {}, history: [] }));
  const { app, page, chat } = await launch({ dataDir, env: { FAKE_CLAUDE_USAGE: "1" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await say(chat, "hello");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "hello" })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await sheet.getByRole("button", { name: "Usage" }).click();
    const today = sheet.getByRole("region", { name: "Usage today" });
    await expect(today).toContainText("$0.01");
    await expect(today).toContainText("6.0K");
    await expect(today).toContainText("In 1.2K · out 300 · cache write 500 · cache read 4.0K");
    const limits = sheet.getByRole("region", { name: "Subscription limits" });
    await expect(limits.getByLabel("Claude limits")).toContainText(/5 hours 42% · in 2h 1[23]m/);
    await expect(limits.getByLabel("Claude limits")).toContainText("Week 18%");
    await expect(limits.getByLabel("Codex limits")).toContainText("Week 31%");
    await expect(limits.getByLabel("Codex limits")).toContainText("as of 1 h ago");
    await expect(sheet.getByRole("region", { name: "By bot" })).toContainText(/Main bot\s*6\.0K tokens\s*\$0\.01/);
    await expect(sheet.getByRole("region", { name: "Earlier days" })).toContainText(/2026-01-01\s*33\.0K tokens\s*\$1\.25/);
    mkdirSync(screens, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(screens, "phase5c-usage.png") });
  } finally {
    await app.close();
  }
});
