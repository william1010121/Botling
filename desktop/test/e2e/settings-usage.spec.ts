// Headless Chromium only. Bundles the Settings component, never builds/launches the shared app.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { join } from "node:path";
import { desktop } from "../helpers";

let browser: Browser, script: string;
const now = new Date(2026, 9, 26, 12).getTime();
const fixture = () => ({
  spendingStatus: "available", day: "2026-10-26", spent: 1.25,
  tokens: { input: 100, output: 200, cacheWrite: 300, cacheRead: 400 },
  byBot: [{ name: "Claude", spent: 1.25, tokens: 800 }, { name: "Codex", spent: 0, tokens: 200 }],
  history: [{ day: "2026-10-24", spent: 2, tokens: 2000 }, { day: "2026-10-25", spent: 3, tokens: 3000 }],
  claude: { fiveHour: { used: .42, seen: now - 3600000, resetsAt: now + 3600000 }, week: null },
  codex: { fiveHour: null, week: { used: .31, seen: now - 3600000, resetsAt: now - 1000 } },
});
test.beforeAll(async () => {
  script = (await build({ entryPoints: [join(desktop, "test/fixtures/settings-usage.tsx")], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.BOTLING_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.BOTLING_TEST_CHROMIUM_EXECUTABLE } : {}) });
});
test.afterAll(async () => { await browser?.close(); });
async function open(page: Page, options: { failure?: boolean; pending?: boolean; usage?: unknown } = {}) {
  await page.clock.install({ time: now });
  await page.setViewportSize({ width: 1120, height: 820 });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ path: join(desktop, "src/renderer/styles.css") });
  await page.evaluate(({ usage, failure, pending }) => {
    window.usageFixture = usage; window.usageFailure = !!failure; window.usagePending = !!pending; window.usageRequests = 0;
  }, { usage: options.usage ?? fixture(), failure: options.failure, pending: options.pending });
  await page.addScriptTag({ content: script });
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await sheet.getByRole("button", { name: "Usage", exact: true }).click();
  return sheet;
}

test("Usage is discoverable in Settings and shows loading instead of a blank pane", async () => {
  const page = await browser.newPage();
  try {
    const sheet = await open(page, { pending: true });
    await expect(sheet.getByRole("status")).toHaveText("Loading usage…");
  } finally { await page.close(); }
});

test("failed usage reads show safe unavailable text and Retry recovers the actual totals", async () => {
  const page = await browser.newPage();
  try {
    const sheet = await open(page, { failure: true });
    await expect(sheet.getByRole("alert")).toContainText("Usage is unavailable.");
    await expect(sheet).not.toContainText("/private/raw.log");
    await page.evaluate(() => { window.usageFailure = false; });
    await sheet.getByRole("button", { name: "Retry" }).click();
    await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).toContainText("1.0K");
    await expect(sheet.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});

test("available usage shows the recorded local day, all four token categories, bot rows, history and honest limit windows", async () => {
  const page = await browser.newPage();
  try {
    const sheet = await open(page);
    const today = sheet.getByRole("region", { name: "Usage today", exact: true });
    await expect(today).toContainText("$1.25");
    await expect(today).toContainText("1.0K");
    await expect(today).toContainText("In 100 · out 200 · cache write 300 · cache read 400");
    await expect(today).toContainText("2026-10-26");
    await expect(sheet.getByRole("region", { name: "By bot", exact: true })).toContainText(/Claude\s*800 tokens\s*\$1.25/);
    await expect(sheet.getByRole("region", { name: "Earlier days", exact: true })).toContainText(/2026-10-25[\s\S]*2026-10-24/);
    const limits = sheet.getByRole("region", { name: "Subscription limits", exact: true });
    await expect(limits.getByLabel("Claude limits")).toContainText("5 hours 42% · in 1h 0m");
    await expect(limits.getByLabel("Codex limits")).toContainText("Week – · reset");
    await expect(limits).toContainText("as of 1 h ago");
    await expect(sheet).toContainText("Claude-reported cost");
    await page.screenshot({ path: join(desktop, ".tmp/screens/settings-usage-available.png") });
  } finally { await page.close(); }
});

test("absent or unreadable spending is unavailable, and both subscriptions remain discoverable with no data", async () => {
  const page = await browser.newPage();
  try {
    for (const status of ["missing", "unreadable"]) {
      await page.reload();
      const usage = { ...fixture(), spendingStatus: status, spent: 0, byBot: [], history: [], claude: { fiveHour: null, week: null }, codex: { fiveHour: null, week: null } };
      const sheet = await open(page, { usage });
      await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).toContainText("Recorded usage is unavailable.");
      await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).not.toContainText("$0.00");
      const limits = sheet.getByRole("region", { name: "Subscription limits", exact: true });
      await expect(limits.getByLabel("Claude limits")).toContainText("no data");
      await expect(limits.getByLabel("Codex limits")).toContainText("no data");
      await expect(sheet).not.toContainText("No bot has used anything today.");
      if (status === "missing") await page.screenshot({ path: join(desktop, ".tmp/screens/settings-usage-unavailable.png") });
    }
  } finally { await page.close(); }
});

test("a failed refresh marks retained totals stale and a later local day refresh replaces them", async () => {
  const page = await browser.newPage();
  try {
    const sheet = await open(page);
    await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).toContainText("$1.25");
    await page.evaluate(() => { window.usageFailure = true; window.usageRefresh?.(); });
    await expect(sheet.getByRole("alert")).toContainText("Showing the last successful reading.");
    await page.evaluate(() => {
      window.usageFailure = false;
      window.usageFixture = { ...(window.usageFixture as object), day: "2026-10-27", spent: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byBot: [] };
      window.usageRefresh?.();
    });
    await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).toContainText("2026-10-27");
    await expect(sheet.getByRole("region", { name: "Usage today", exact: true })).toContainText("$0.00");
    await expect(sheet.getByRole("alert")).toHaveCount(0);
  } finally { await page.close(); }
});
