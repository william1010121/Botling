// Phase 5a in the real app: the / menu offers components; "Make into component" on a reply has Maintainer
// build it, the chip says Building…, then the component shows under the reply; Edit spec opens the spec
// panel in the right panel; a group's question waits on you there. Screenshots go to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch, say } from "./launch";

const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";
const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};
function component(dataDir: string, name: string, template: string, about: string) {
  const folder = join(dataDir, "core", "plugins", "ccb-components", "components", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "template.html"), template);
  writeFileSync(join(folder, "about.md"), about);
}

test("the / menu, Make into component, the component under its reply, and its spec in the right panel", async () => {
  const dataDir = tempDir("e2e-5a-specs");
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_COMPONENT_SCAN_MS: "200" } });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    // The / menu: the app's /design, then the library.
    const box = chat.getByRole("textbox", { name: "Message" });
    await box.click();
    await box.page().keyboard.type("/");
    await expect(chat.locator(".mention-list")).toContainText("design");
    await box.page().keyboard.press("Backspace");
    await say(chat, "/say Your 3 tests: 2 passed, 1 failed (the cart total).");
    const row = chat.locator(".row.bot[data-id]", { hasText: "Your 3 tests: 2 passed" });
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Make into component" }).click();
    // Building…: Maintainer got the first build.
    await expect(row.locator(".spec-chip.building")).toContainText("your-tests");
    await page.locator(`.bot-row[data-bot="${MAINTAINER}"]`).click();
    await expect(chat.locator(".row", { hasText: "action: build-first" }).first()).toBeVisible();
    const relay = await chat.locator(".row", { hasText: "action: build-first" }).first().innerText();
    const specId = /Component spec ([0-9A-F-]{36})/.exec(relay)![1];
    // Maintainer says what it built, and it lands in the library.
    await say(chat, `/say Built the test board. <component-spec id="${specId}">{"name": "test-board", "about": "Tests at a glance", "fields": [{"name": "filled", "type": "bool"}]}</component-spec>`);
    component(dataDir, "test-board",
      `<div class="board" style="padding:12px;font:14px system-ui;color:#e8e8e8"><b>Tests</b> <span id="v"></span></div><script>document.getElementById("v").textContent = ccb.data && ccb.data.filled ? "✓ 2 passed · ✗ 1 failed" : "…";</script>`,
      "Tests at a glance.\nData: {\"filled\": true}");
    await page.locator('.bot-row[data-bot="6A0B0000-0000-4000-8000-000000000002"]').click();
    const built = chat.locator(".row.bot[data-id]", { hasText: "Your 3 tests: 2 passed" }).locator(".spec-built");
    await expect(built).toBeVisible({ timeout: 15_000 });
    await expect(chat.locator(".row.notice", { hasText: "test-board added to Main bot." })).toBeVisible();
    await shot(page, "phase5a-built");
    // Edit spec: the spec panel in the right panel.
    await built.getByRole("button", { name: "Edit spec" }).click();
    const panel = page.locator(".spec-panel");
    await expect(panel).toBeVisible();
    const spec = page.frameLocator(".spec-frame");
    await expect(spec.locator("body")).toContainText("test-board");
    await expect(spec.locator("body")).toContainText("Filled by Main bot");
    await shot(page, "phase5a-spec-panel");
  } finally {
    await app.close();
  }
});

test("a group's question waits on you in the group's right panel", async () => {
  const dataDir = tempDir("e2e-5a-group");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.getByRole("button", { name: "New group" }).click();
    const form = page.getByRole("form", { name: "New group" });
    await form.getByRole("textbox", { name: "Group name" }).fill("Desk");
    await form.getByRole("checkbox", { name: "Main bot" }).check();
    await form.getByRole("checkbox", { name: "Maintainer" }).check();
    await form.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".group-row")).toHaveClass(/selected/);
    await say(chat, "@Maintainer /guestsay Which colour?\\n<choices>\\n- Red\\n- Blue\\n</choices>");
    await expect(chat.locator(".row.bot", { hasText: "Which colour?" })).toBeVisible();
    const waiting = page.locator(".detail-panel .waiting-item", { hasText: "Which colour?" });
    await expect(waiting).toBeVisible();
    await shot(page, "phase5a-group-waiting");
  } finally {
    await app.close();
  }
});

test("a suggested component's chip", async () => {
  const dataDir = tempDir("e2e-5a-judge");
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1280, height: 820 });
    await say(chat, `/say All 12 tests pass. <suggest-component name="test-status">the test results at a glance, from npm test</suggest-component>`);
    const row = chat.locator(".row.bot[data-id]", { hasText: "All 12 tests pass." });
    await expect(row.locator(".spec-chip.suggested")).toContainText("test-status");
    await shot(page, "phase5a-verified-suggested");
  } finally {
    await app.close();
  }
});
