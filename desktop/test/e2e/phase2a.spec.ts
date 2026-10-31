// Phase 2a in the real app (Electron, the reused Web/src chat page, the fake CLI): a bot's
// question answered with its buttons, a task card's chip, a subagent's card and its own view, a
// message added while a reply runs, tidying before sleep.
// Saves screenshots to desktop/.tmp/screens/ for a person to look at.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";
import { launch, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

test("a bot's question: its buttons answer it, as a reply to it; the task chip and the reply follow", async () => {
  const { app, page, chat } = await launch();
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await say(chat, "/choices");
    const question = chat.locator(".row.bot[data-id]", { hasText: "Which way?" });
    await expect(question.getByRole("button", { name: /Fast/ })).toBeVisible();
    await expect(question).not.toContainText("<choices>");
    await shot(page, "choices");
    await question.getByRole("button", { name: /Fast/ }).click();
    await expect(chat.locator(".row.user").last()).toContainText("Fast");
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("You said: Fast");
    await say(chat, "/task");
    const reply = chat.locator(".row.bot[data-id]", { hasText: "Working on the docs." });
    await expect(reply.locator(".task-card-chip")).toContainText("Docs");
    await expect(reply.locator(".task-card-chip")).toContainText("writing the intro");
    await expect(reply).not.toContainText("<task");
    await shot(page, "task-chip");
  } finally {
    await app.close();
  }
});

test("a subagent shows as a card under its reply; clicking it opens its own conversation, and back", async () => {
  const { app, page, chat } = await launch({ env: { FAKE_CLAUDE_BG_DELAY_MS: "1500" } });
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await say(chat, "/bgagent");
    const card = chat.locator(".subagent-card").last();
    await expect(card).toContainText("Research the API");
    await expect(card).toHaveClass(/running/);
    await expect(page.locator(".chat-status")).toContainText(/subagent at work|Awake/);
    await shot(page, "subagent-running");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "The background research finished" })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".subagent-card").first()).toHaveClass(/completed/);
    await chat.locator(".subagent-card").first().click();
    await expect(chat.locator("#subagent-bar")).toContainText("Research the API");
    await expect(chat.locator(".row.sub-from")).toContainText("Look up the API and report");
    await expect(chat.locator(".row.sub-work").last()).toContainText("Found 3 things");
    await shot(page, "subagent-view");
    await chat.locator("#subagent-bar .back").click();
    await expect(chat.locator("#subagent-bar")).toHaveCount(0);
    await expect(chat.locator(".composer")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a message while a reply runs joins it: the reply so far stays cut off, and one reply answers both", async () => {
  const { app, page, chat } = await launch();
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await say(chat, "/slow");
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText("word5");
    await say(chat, "and also this");
    await expect(chat.locator(".row.bot[data-id]").last()).toContainText(/You said: \/slow\s*and also this/);
    const rows = chat.locator(".row[data-id]");
    await expect(rows.nth(-4)).toContainText("/slow");
    await expect(rows.nth(-3)).toHaveAttribute("data-state", "stopped");
    await expect(rows.nth(-2)).toContainText("and also this");
    await shot(page, "steering");
  } finally {
    await app.close();
  }
});

test("an idle bot tidies its notes before it sleeps, and says so in the header", async () => {
  const { app, page, chat, dataDir } = await launch({ env: { BOTLING_IDLE_MS: "400", BOTLING_TIDY_TIMEOUT_MS: "20000", FAKE_CLAUDE_SLOW_TIDY_MS: "1500" } });
  try {
    await say(chat, "hello");
    await expect(page.locator(".chat-status")).toHaveText("Tidying its notes…", { timeout: 10_000 });
    await shot(page, "tidying");
    await expect(page.locator(".chat-status")).toHaveText("Asleep", { timeout: 10_000 });
    const memory = await until(() => { try { return readFileSync(join(dataDir, "core", "main", "memory.md"), "utf8"); } catch { return null; } });
    expect(memory).toMatch(/Tidied by the fake CLI/);
  } finally {
    await app.close();
  }
});
