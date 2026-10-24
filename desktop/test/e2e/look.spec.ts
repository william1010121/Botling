// Screenshots of the app for a person to look at (not assertions about pixels). Saved under
// desktop/.tmp/screens/ (ignored by git).
import { test } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { desktop } from "../helpers";
import { launch, say } from "./launch";

test("screenshots: a chat with a reply, steps and an approval", async () => {
  const dir = join(desktop, ".tmp", "screens");
  mkdirSync(dir, { recursive: true });
  const { app, page, chat } = await launch({ env: { BOTLING_APPROVAL_TIMEOUT_MS: "60000" } });
  try {
    await page.setViewportSize({ width: 1120, height: 760 });
    await say(chat, "Hello! What is $\\int_0^1 x^2\\,dx$?");
    await chat.locator(".row.bot").last().waitFor();
    await page.waitForTimeout(800);
    await say(chat, "/tool ls -la ~/Documents");
    await chat.locator(".choices").last().waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(dir, "approval.png") });
  } finally {
    await app.close();
  }
});
