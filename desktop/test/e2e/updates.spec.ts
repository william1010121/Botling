// Update discovery defaults on; the unconfigured trust key refuses self-installation.
// a newer Botling 2 is announced in the main bot's chat (as 1.x) and its release page opens (only noted in tests). The feed is a
// local copy of GitHub's JSON (BOTLING_TEST_UPDATE_FEED, unpackaged builds only).
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch } from "./launch";

test("on by default; a newer release is an update notice in the main bot's chat, unconfigured installation is blocked", async () => {
  const base = tempDir("e2e-updates");
  const feed = join(base, "releases.json");
  const page_ = (tag: string) => `https://github.com/william1010121/Botling/releases/tag/${tag}`;
  writeFileSync(feed, JSON.stringify([
    { tag_name: "v1.19.0", name: "Botling v1.19.0", html_url: page_("v1.19.0"), draft: false, prerelease: false, assets: [] },
    { tag_name: "v2.0.1", name: "Botling 2.0.1", html_url: page_("v2.0.1"), draft: false, prerelease: false, published_at: "2026-10-20T00:00:00Z", assets: [{ name: "Botling-2-2.0.1-mac-arm64.dmg" }, { name: "Botling-2-2.0.1-mac-arm64.zip" }] },
  ]));
  const dataDir = join(base, "data");
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_TEST_UPDATE_FEED: feed } });
  try {
    // As in 1.x, a new version is an update notice in the main bot's chat (no banner). Unconfigured trust
    // means it cannot be installed from here, so the notice offers no Install and restart.
    await expect(chat.getByText("Botling 2.0.1", { exact: false }).first()).toBeVisible();
    await expect(chat.getByText("It can't be installed from here: Update trust is not configured", { exact: false })).toBeVisible();
    await expect(chat.getByRole("button", { name: "Install and restart" })).toHaveCount(0);
    await expect(page.locator(".update-bar")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Settings", exact: true });
    await sheet.getByRole("button", { name: "Updates" }).click();
    await expect(sheet.getByRole("switch", { name: "Check for updates" })).toBeChecked();
    await expect(sheet.getByText("Botling 2.0.1 is available (Botling-2-2.0.1-mac-arm64.zip).")).toBeVisible();
    await sheet.getByRole("button", { name: "Open release page" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedReleases.slice())).toEqual([page_("v2.0.1")]);
    mkdirSync(join(desktop, ".tmp", "screens"), { recursive: true });
    await page.screenshot({ path: join(desktop, ".tmp", "screens", "phase5b-update.png") });
    expect(existsSync(join(dataDir, "updates.json"))).toBe(true);
  } finally {
    await app.close();
  }
});
