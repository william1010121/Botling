// Two heads in the real app (Electron, the reused Web/src chat page, the fake claude and the fake
// Codex app-server): each head's replies labelled "Main bot · Claude/Codex", seen marks, the
// composer's Both/Claude/Codex switch (saved), a message for one head, a hand-off with its divider,
// and a Codex worker's card. Saves screenshots to desktop/.tmp/screens/ for a person to look at.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

function twoHeads(heads: Record<string, unknown> = {}) {
  const dataDir = tempDir("e2e-heads");
  mkdirSync(join(dataDir, "core", "main"), { recursive: true });
  writeFileSync(join(dataDir, "core", "main", "bot.json"), JSON.stringify({ engine: "claude", heads: { engines: ["claude", "codex"], answerWith: "both", ...heads } }));
  return dataDir;
}

test("Claude and Codex in one chat: both answer, each labelled, with seen marks; the switch picks who answers", async () => {
  const dataDir = twoHeads();
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1120, height: 780 });
    await expect(page.locator(".chat-heads")).toHaveText("Claude & Codex");
    const answer = chat.locator(".answer-with");
    await expect(answer).toBeVisible();
    await expect(answer.getByRole("button")).toHaveText(["Both", "Claude", "Codex"]);
    await say(chat, "hello");
    const claude = chat.locator(".row.bot[data-id]", { hasText: "You said: hello" });
    const codex = chat.locator(".row.bot[data-id]", { hasText: "Codex says: hello" });
    await expect(claude.locator(".speaker")).toHaveText("Main bot · Claude");
    await expect(codex.locator(".speaker")).toHaveText("Main bot · Codex", { timeout: 10_000 });
    await expect(chat.locator(".row.user").last().locator(".seen-mark.on")).toHaveCount(2);
    await shot(page, "heads-both");
    // Codex only: the line says who it was for, and only Codex answers.
    await answer.getByRole("button", { name: "Codex" }).click();
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, "core", "main", "bot.json"), "utf8")).heads.answerWith).toBe("codex");
    await say(chat, "just you");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "Codex says: just you" })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row.user").last()).toContainText("to Codex");
    await page.waitForTimeout(500);
    await expect(chat.locator(".row.bot[data-id]", { hasText: "You said: just you" })).toHaveCount(0);
    await shot(page, "heads-codex-only");
  } finally {
    await app.close();
  }
});

test("a hand-off: the divider, the other head's reply and the hand-back; a Codex worker's card", async () => {
  const dataDir = twoHeads({ answerWith: "claude" });
  // The worker reports only once the test has seen it at work: a 1.5 s timer raced the card's
  // "running" check under load. Quitting does not tidy (that is not what this checks, and both
  // heads tidying made closing slow under load).
  const gate = join(dataDir, "worker-gate");
  const { app, page, chat } = await launch({ dataDir, env: { FAKE_CODEX_WORKER_GATE: gate, BOTLING_QUIT_TIDY_MS: "0" } });
  try {
    await page.setViewportSize({ width: 1120, height: 780 });
    await say(chat, `/say Made it faster. <handoff to="codex" kind="review">Check the diff</handoff>`);
    await expect(chat.locator(".row.bot[data-id]", { hasText: "Done: Did it: Check the diff" })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row", { hasText: "Claude → Codex: Check the diff" })).toBeVisible();
    await expect(chat.locator(".row.bot[data-id]", { hasText: "Made it faster." })).not.toContainText("<handoff");
    await shot(page, "heads-handoff");
    await chat.locator(".answer-with").getByRole("button", { name: "Codex" }).click();
    await say(chat, "/worker Build the parser");
    const card = chat.locator(".subagent-card").last();
    await expect(card).toContainText("Build the parser", { timeout: 10_000 });
    await expect(card).toHaveClass(/running/);
    await shot(page, "codex-worker-running");
    writeFileSync(gate, "go");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "The worker finished: Worker did: Build the parser" })).toBeVisible({ timeout: 15_000 });
    await shot(page, "codex-worker-report");
  } finally {
    await app.close();
  }
});
