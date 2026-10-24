// Tool approvals in the app: the card in the chat (the reused page's choice buttons), the left
// column's count, Allow once, Don't allow, and no answer in time.
import { expect, test } from "@playwright/test";
import { launch, say } from "./launch";

test("Allow once lets the tool run; the card folds to the pick and the count goes", async () => {
  const { app, page, chat } = await launch({ env: { BOTLING_APPROVAL_TIMEOUT_MS: "60000" } });
  try {
    await say(chat, "/tool echo hi");
    const card = chat.locator(".row.bot", { hasText: "Wants to use" }).last();
    await expect(card.locator("pre")).toContainText("echo hi");
    await expect(page.locator(".bot-row.selected .badge.waiting")).toHaveText("1");
    await expect(page.locator(".chat-status")).toHaveText("Waiting for your answer");
    await card.getByRole("button", { name: /Allow once/ }).click();
    const reply = chat.locator(".row.bot", { hasText: "Allowed: ran echo hi" });
    await expect(reply).toHaveAttribute("data-state", "done");
    await expect(page.locator(".bot-row.selected .badge.waiting")).toHaveCount(0);
    // Folded to one line saying what was picked.
    await expect(card.locator(".choices")).toHaveCount(0);
    await expect(card.locator(".folded-choice .picked-label")).toHaveText("Allow once");
  } finally {
    await app.close();
  }
});

test("Don't allow refuses it, and claude is told", async () => {
  const { app, chat } = await launch({ env: { BOTLING_APPROVAL_TIMEOUT_MS: "60000" } });
  try {
    await say(chat, "/tool rm -rf build");
    const card = chat.locator(".row.bot", { hasText: "Wants to use" }).last();
    await card.getByRole("button", { name: /Don't allow/ }).click();
    await expect(chat.locator(".row.bot", { hasText: "Denied: The user did not allow it." })).toHaveAttribute("data-state", "done");
  } finally {
    await app.close();
  }
});

test("no answer in time counts as no", async () => {
  const { app, chat } = await launch({ env: { BOTLING_APPROVAL_TIMEOUT_MS: "1500" } });
  try {
    await say(chat, "/tool echo late");
    await expect(chat.locator(".row.bot", { hasText: "Denied: The user did not answer in time" })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row.bot", { hasText: "Wants to use" }).last()).toContainText("No answer in time");
  } finally {
    await app.close();
  }
});
