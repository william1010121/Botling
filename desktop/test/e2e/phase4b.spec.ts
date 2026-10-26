// Phase 4b in the real app: New bot (the form, the bot set up and shown), a bot's subagent rows in
// the left column (open, settle into the right panel's Settled, bring back), Results / "Just done"
// (opened by main, only links of that chat), the right panel folded into its strip (icons with
// counts, a section beside the strip, kept in settings.json), a temporary team in the main bot's Now
// card and its reply in the chat, and removing a bot (its folder stays). Screenshots go to
// desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch, MAIN, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

test("New bot, subagent rows and Settled, Results, the folded strip, removing a bot", async () => {
  const dataDir = tempDir("e2e-4b");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    // New bot: the form under the column, Create only with a name and a job.
    await page.getByRole("button", { name: "New bot" }).click();
    const form = page.getByRole("form", { name: "New bot" });
    await expect(form.getByRole("button", { name: "Create" })).toBeDisabled();
    await form.getByRole("textbox", { name: "Name" }).fill("Morning news");
    await form.getByRole("textbox", { name: "Its job" }).fill("Every day at 08:00, the top 5 tech stories");
    await form.getByRole("button", { name: "Create" }).click();
    await expect(form).toHaveCount(0);
    const row = page.locator(".bot-row", { hasText: "Morning news" });
    await expect(row).toHaveClass(/selected/);
    // It was handed its job and answered (the fake: "On it.").
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("On it.");
    const botId = await row.getAttribute("data-bot");
    expect(JSON.parse(readFileSync(join(dataDir, "core", "projects.json"), "utf8"))).toEqual([expect.objectContaining({ id: botId, name: "Morning news", job: "Every day at 08:00, the top 5 tech stories" })]);

    // A subagent of the main bot: its row under the main bot, with its end mark.
    await page.locator(`.bot-row[data-bot="${MAIN}"]`).click();
    await say(chat, "/agent");
    const sub = page.locator(`.subagent-rows[data-bot="${MAIN}"] .subagent-row`);
    await expect(sub).toHaveCount(1);
    await expect(sub.locator(".subagent-title")).toHaveText("Research the API");
    await expect(sub).not.toHaveClass(/running/);
    // Opening it shows its own conversation in the chat's place.
    await sub.locator(".subagent-open").click();
    await expect(sub).toHaveClass(/selected/);
    await expect(page.locator(`.bot-row[data-bot="${MAIN}"]`)).not.toHaveClass(/selected/);
    // Results: a link the main bot hands over is listed; main opens it (only this chat's links).
    await page.locator(`.bot-row[data-bot="${MAIN}"]`).click();
    await say(chat, "/say Here it is: [Weekly report](https://example.com/report) and [Notes](https://example.com/notes)");
    const results = page.locator(".results-section");
    // Its finished tasks are in the task list's Done group, so the links are "Results" (1.x: "Just done" only without them).
    await expect(page.locator('.task-group[data-group="done"] h3')).toHaveText("Done");
    await expect(results.locator("h3")).toHaveText("Results");
    await expect(results.locator(".result-row")).toHaveText(["Weekly report", "Notes"]);
    await results.locator(".result-row", { hasText: "Weekly report" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedResults.slice())).toEqual(["https://example.com/report"]);
    // The main bot's subagent row in the column and its "Just done" (looked at).
    await shot(page, "phase4b-rows");
    // Settling: the row leaves the column for Settled in the right panel.
    await sub.hover();
    await sub.locator(".subagent-settle").click();
    await expect(sub).toHaveCount(0);
    const settled = page.locator(".settled-section .settled-row");
    await expect(settled).toHaveCount(1);
    await expect(settled.locator(".settled-title")).toHaveText("Research the API");
    // The column with the new bot, the Results and Settled sections (looked at).
    await page.getByRole("button", { name: "New bot" }).click();
    await page.getByRole("form", { name: "New bot" }).getByRole("textbox", { name: "Name" }).fill("Reading coach");
    await shot(page, "phase4b-panel");
    await page.getByRole("form", { name: "New bot" }).getByRole("button", { name: "Cancel" }).click();
    await settled.locator(".settled-back").click();
    await expect(sub).toHaveCount(1);
    await expect(page.locator(".settled-section")).toHaveCount(0);

    // The right panel folded (the button at the top right): the face, the Results icon with its count.
    await page.getByRole("button", { name: "Hide right panel" }).click();
    const strip = page.locator(".right-strip");
    await expect(strip).toBeVisible();
    await expect(page.locator(".detail-panel")).toHaveCount(0);
    const resultsIcon = strip.locator('.strip-icon[data-section="results"]');
    await expect(resultsIcon.locator(".strip-badge")).toHaveText("2");
    await resultsIcon.click();
    const flyout = strip.locator(".strip-flyout");
    await expect(flyout).toContainText("Just done");
    await expect(flyout.locator(".result-row")).toHaveText(["Weekly report", "Notes"]);
    await strip.locator(".strip-face").hover();
    await expect(strip.locator(".strip-tip")).toContainText("Main bot");
    await shot(page, "phase4b-strip");
    await page.keyboard.press("Escape");
    await expect(flyout).toHaveCount(0);
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "core", "settings.json"), "utf8")).rightPanelCollapsed).toBe(true);
    await page.getByRole("button", { name: "Show right panel" }).click();
    await expect(page.locator(".detail-panel")).toBeVisible();

    // Removing a bot: its menu, a confirmation, then it is gone; its folder stays.
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove bot…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText('Remove "Morning news"?');
    await expect(dialog).toContainText(`Its notes stay in ${join(dataDir, "core", "bots", botId!)}.`);
    await dialog.getByRole("button", { name: "Remove bot" }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator(`.bot-row[data-bot="${MAIN}"]`)).toHaveClass(/selected/);
    await expect(chat.locator(".row.notice").last()).toContainText('Removed the bot "Morning news".');
    expect(existsSync(join(dataDir, "core", "bots", botId!, ".bot"))).toBe(true);
    // The main bot has no menu.
    await page.locator(`.bot-row[data-bot="${MAIN}"]`).click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a temporary team: in the main bot's Now card while it works, its reply in the chat", async () => {
  const { app, page, chat } = await launch({ env: { FAKE_CLAUDE_LINGER_MS: "2500" } });
  try {
    await page.setViewportSize({ width: 1180, height: 800 });
    await say(chat, "/say Handed to the Research team.\n<team name=\"research\">/linger compare three note apps</team>");
    const team = page.locator(".now-card .team-run");
    await expect(team).toHaveCount(1);
    await expect(team.locator(".team-title")).toHaveText("Research team");
    await expect(team).toHaveAttribute("title", "/linger compare three note apps");
    await expect(chat.locator(".row.notice").last()).toContainText("Research team: Thinking it over.", { timeout: 15_000 });
    await expect(team).toHaveCount(0);
  } finally {
    await app.close();
  }
});
