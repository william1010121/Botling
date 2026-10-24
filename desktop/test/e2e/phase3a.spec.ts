// Phase 3a in the real app: unread replies fold into a Catch-up summary when you open the chat (the
// fake Codex CLI's `codex exec` writes it), and the header's Routines panel lists a schedule and
// pauses it. Saves screenshots to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";
import { launch, MAIN, post } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};
const at = (minutes: number) => (Date.now() - Date.UTC(2001, 0, 1)) / 1000 - 3600 + minutes * 60;

test("unread replies fold into a Catch-up summary with its bullets", async () => {
  const dataDir = tempDir("e2e-catchup");
  const chat = [
    { id: "C1000000-0000-4000-8000-000000000001", role: "user", text: "Ship the release", date: at(0) },
    { id: "C1000000-0000-4000-8000-000000000002", role: "bot", text: "Tests passed: 214 of 214.", date: at(1), engine: "claude" },
    { id: "C1000000-0000-4000-8000-000000000003", role: "bot", text: "Built the installer.", date: at(2), engine: "claude" },
    { id: "C1000000-0000-4000-8000-000000000004", role: "bot", text: "Uploading to the store (step 2 of 3).", date: at(3), engine: "claude" },
    { id: "C1000000-0000-4000-8000-000000000005", role: "bot", text: "Should I publish now or wait for review?", date: at(4), engine: "claude" },
  ];
  mkdirSync(join(dataDir, "core", "main"), { recursive: true });
  writeFileSync(join(dataDir, "core", "main", "bot.json"), JSON.stringify({ unread: 4 }));
  const { app, page, chat: frame } = await launch({ dataDir, chat });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    const head = frame.locator(".catchup-head");
    await expect(head).toBeVisible({ timeout: 10_000 });
    await expect(head).toContainText("Main bot · Claude: Built the installer.", { timeout: 10_000 });
    await expect(frame.locator(".row.catchup-folded")).toHaveCount(4);
    await shot(page, "catchup");
    const cached = await until(() => { try { return JSON.parse(readFileSync(join(dataDir, "core", "catchup-summaries.json"), "utf8")); } catch { return null; } });
    expect(Object.values(cached)[0]).toMatchObject({ model: "gpt-6-luna", bullets: expect.arrayContaining([expect.stringContaining("[[source:C1000000-0000-4000-8000-00000000000")]) });
  } finally {
    await app.close();
  }
});

test("the Routines panel lists a schedule and pauses it", async () => {
  const dataDir = tempDir("e2e-routines");
  const { app, page } = await launch({ dataDir, env: { BOTLING_ROUTINE_TICK_MS: "0" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    const made = await post(page, { v: 6, id: "r1", cmd: { type: "routines.change", botId: MAIN, operation: "create", kind: "recurring", cron: "0 9 * * 1-5", timezone: "Asia/Taipei", task: "Standup: check the board", requestId: "standup" } });
    expect(made.ok).toBe(true);
    await page.getByRole("button", { name: "Routines" }).click();
    const panel = page.getByRole("dialog", { name: "Routines" });
    await expect(panel.locator("li", { hasText: "Standup" })).toContainText("Weekdays 09:00 · Asia/Taipei · pending");
    await expect(panel.locator("li", { hasText: "Daily summary" })).toContainText("Every day 08:15");
    await shot(page, "routines");
    await panel.locator("li", { hasText: "Standup" }).getByRole("button", { name: "Pause" }).click();
    await expect(panel.locator("li", { hasText: "Standup" })).toContainText("paused");
    const saved = JSON.parse(readFileSync(join(dataDir, "core", "main", "scheduled-routines.json"), "utf8"));
    expect(saved.routines[0]).toMatchObject({ state: "paused", timezone: "Asia/Taipei", cron: "0 9 * * 1-5" });
  } finally {
    await app.close();
  }
});
