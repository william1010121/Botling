// Headless renderer regression: actual App/Settings and disk settings; no native windows.
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsChange } from "../../src/contract";
import { applySetting, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { desktop, tempDir } from "../helpers";

let browser: Browser;
let script: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: [join(desktop, "test/fixtures/sidebar-settings-app.tsx")], bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic", define: { __CHARACTERS__: "{}", "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.BOTLING_TEST_CHROMIUM ? { executablePath: process.env.BOTLING_TEST_CHROMIUM } : {}) });
});
test.afterAll(async () => { await browser?.close(); });

async function launch(collapsed = false, failSave = false) {
  const file = join(tempDir("sidebar-settings"), "settings.json");
  writeFileSync(file, JSON.stringify({ railCollapsed: collapsed, developerProjectID: "ABCDEF00-0000-4000-8000-000000000001", futureSetting: "keep" }));
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const commands: string[] = [];
  await page.exposeFunction("sidebarRequest", async (cmd: any) => {
    commands.push(cmd.type);
    if (cmd.type === "settings.set" && failSave) throw new Error("Settings could not be saved");
    if (cmd.type === "settings.set") writeSettings(file, applySetting(readSettings(file), SettingsChange.parse(cmd.change)));
    if (cmd.type === "settings.set" || cmd.type === "settings.get") return settingsView(readSettings(file));
    if (cmd.type === "usage.view") return null;
    throw new Error(`Unexpected command: ${cmd.type}`);
  });
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://sidebar.test/") return route.fulfill({ contentType: "text/html", body: `<html><head><style>${readFileSync(join(desktop, "src/renderer/styles.css"), "utf8")}</style></head><body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>` });
    return route.abort();
  });
  await page.goto("http://sidebar.test/");
  await page.locator('.shell[data-ready="1"]').waitFor();
  return { page, file, commands };
}
const quick = (page: Page) => page.getByRole("dialog", { name: "Quick settings", exact: true });
const gear = (page: Page) => page.getByRole("button", { name: "Quick settings", exact: true });

test("sidebar gear exposes developer control, saves it, and preserves the source and unrelated settings", async () => {
  const { page, file, commands } = await launch();
  try {
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await gear(page).click({ timeout: 3000 });
    const toggle = quick(page).getByRole("switch", { name: "Develop Botling itself" });
    await toggle.click();
    await expect.poll(() => readSettings(file).developerMode).toBe(true);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect.poll(() => readSettings(file).developerMode).toBe(false);
    await expect(toggle).not.toBeChecked();
    expect(readSettings(file)).toMatchObject({ developerProjectID: "ABCDEF00-0000-4000-8000-000000000001", futureSetting: "keep" });
    await page.reload();
    await gear(page).click();
    await expect(quick(page).getByRole("switch", { name: "Develop Botling itself" })).not.toBeChecked();
    expect(commands.every(type => ["settings.get", "settings.set"].includes(type))).toBe(true);
  } finally { await page.close(); }
});

test("quick links open their Settings section, while the full entrance and keyboard shortcut still work", async () => {
  const { page } = await launch();
  try {
    for (const [link, heading] of [["Plugins", "Plugins"], ["Usage by bot", "Usage"], ["Developer settings…", "Developer"], ["All settings…", "General"]]) {
      await gear(page).click({ timeout: 3000 });
      await quick(page).getByRole("button", { name: link, exact: true }).click();
      await expect(quick(page)).toHaveCount(0);
      const sheet = page.getByRole("dialog", { name: "Settings", exact: true });
      await expect(sheet.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Done", exact: true }).click();
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("folded sidebar keeps the gear, dismisses with Escape or outside click, and fits a short window", async () => {
  const { page } = await launch(true);
  try {
    await page.setViewportSize({ width: 720, height: 420 });
    await gear(page).click({ timeout: 3000 });
    await expect(quick(page).getByRole("button", { name: "All settings…", exact: true })).toBeVisible();
    const box = await quick(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(720);
    expect(box!.y + box!.height).toBeLessThanOrEqual(420);
    await page.keyboard.press("Escape");
    await expect(quick(page)).toHaveCount(0);
    await expect(gear(page)).toBeFocused();
    await gear(page).click();
    await page.locator(".chat-header").click({ position: { x: 400, y: 20 } });
    await expect(quick(page)).toHaveCount(0);
    await page.locator("#chat-frame").evaluate((frame) => { (frame as HTMLIFrameElement).srcdoc = '<button style="margin:80px 450px">Chat area</button>'; });
    await gear(page).click();
    await page.frameLocator("#chat-frame").getByRole("button", { name: "Chat area" }).click();
    await expect(quick(page)).toHaveCount(0);
  } finally { await page.close(); }
});

test("failed saves show an error and keep the saved state; permission policy has no writable control", async () => {
  const { page, file, commands } = await launch(false, true);
  try {
    await gear(page).click();
    const toggle = quick(page).getByRole("switch", { name: "Develop Botling itself" });
    await toggle.click();
    await expect(quick(page).getByRole("alert")).toContainText("Settings could not be saved");
    await expect(toggle).not.toBeChecked();
    expect(readSettings(file).developerMode).toBeUndefined();
    await expect(quick(page)).toContainText("Auto-approve safe actions follows the current engine's permission rules");
    await expect(quick(page).getByRole("switch")).toHaveCount(1);
    expect(commands).toContain("settings.set");
    await page.screenshot({ path: join(desktop, ".cache/sidebar-settings-error.png") });
  } finally { await page.close(); }
});
