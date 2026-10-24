// Library components in the real app: a <show> card drawn by Web/src's component frame (sandboxed,
// served from botling-card://page/ under its own CSP), ccb.save kept in the chat file, a command
// card that runs only after Allow and run (and its runDetail), pinning to the Board, and the pin's
// chip set by ccb.setStatus. Saves screenshots to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";
import { writeLibrary } from "../fixtures/components";
import { audit, launch, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

test("a <show> card is a sandboxed component frame; ccb.save is kept; Done answers the bot", async () => {
  const dataDir = tempDir("e2e-components");
  writeLibrary(join(dataDir, "core"));
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_PLAIN_SHELL: "1" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await say(chat, `/say Your list: <show name="todo">{"items":["milk"]}</show>`);
    const frame = chat.locator(".row.bot iframe.component-frame").first();
    await expect(frame).toHaveAttribute("src", /^botling-card:\/\/page\/[0-9a-f]{36}$/, { timeout: 10_000 });
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const card = chat.frameLocator(".row.bot iframe.component-frame").first();
    await expect(card.locator("#items li")).toHaveText(["milk"]);
    await card.getByRole("button", { name: "Add one" }).click();
    await expect(card.locator("#items li")).toHaveText(["milk", "item 2"]);
    await until(() => {
      const lines = JSON.parse(readFileSync(join(dataDir, "core", "main", "chat.json"), "utf8"));
      return lines.find((m: any) => m.displays?.[0]?.data === `{"items":["milk","item 2"]}`);
    }, { what: "the saved card data in chat.json" });
    await shot(page, "component-card");
    // The frame is opaque and reaches nothing: no app bridge, no parent document.
    const probe = await page.frames().find((f) => f.url().startsWith("botling-card://page/"))!.evaluate(() => {
      const out: Record<string, unknown> = { botling: typeof (window as any).botling, origin: self.origin };
      try { void (parent as any).document.title; out.parent = "readable"; } catch { out.parent = "blocked"; }
      try { void localStorage.length; out.storage = "readable"; } catch { out.storage = "blocked"; }
      return out;
    });
    expect(probe).toEqual({ botling: "undefined", origin: "null", parent: "blocked", storage: "blocked" });
    await card.getByRole("button", { name: "Done" }).click();
    await expect(chat.locator(".row.user").last()).toContainText("All done: milk, item 2");
    expect((await audit(app)).filter((entry) => entry.includes("blocked a frame"))).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a command card asks first, runs after Allow and run, and its runDetail answers; pinned, it shows on the Board with its chip", async () => {
  const dataDir = tempDir("e2e-components");
  writeLibrary(join(dataDir, "core"));
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_PLAIN_SHELL: "1" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await say(chat, `/say Here: <show name="gitlog"></show>`);
    const allow = chat.getByRole("button", { name: "Allow and run" });
    await expect(allow).toBeVisible({ timeout: 10_000 });
    await shot(page, "component-command-ask");
    await allow.click();
    const card = chat.frameLocator(".row.bot iframe.component-frame").first();
    await expect(card.locator("#count")).toHaveText("Commits: 3", { timeout: 10_000 });
    await card.getByRole("button", { name: "More" }).click();
    await expect(card.locator("#detail")).toHaveText("Detail: detail-abc123");
    await shot(page, "component-command-ran");
    // Pin the todo card (no command): it keeps what it shows; its chip says what ccb.setStatus set.
    await say(chat, `/say <show name="todo">{"items":["milk","tea"]}</show>`);
    const holder = chat.locator('.row.bot .pin-holder:has(iframe[aria-label="todo"])').last();
    await expect(holder).toBeVisible({ timeout: 10_000 });
    await holder.hover();
    // The bar shows over the card on hover (the frame tells the page it is hovered); clicked as the page would get it.
    await holder.getByRole("button", { name: "Pin to this bot" }).dispatchEvent("click");
    await chat.getByRole("button", { name: "Pin", exact: true }).click();
    await until(() => {
      try { return JSON.parse(readFileSync(join(dataDir, "core", "main", "pins.json"), "utf8")).length === 1; } catch { return false; }
    }, { what: "pins.json" });
    await page.getByRole("button", { name: "Board" }).click();
    await expect(chat.locator("#board .board-card")).toHaveCount(1);
    const tile = chat.frameLocator(".board-card iframe.component-frame").first();
    await expect(tile.locator("#items li")).toHaveText(["milk", "tea"], { timeout: 10_000 });
    await until(() => {
      const pins = JSON.parse(readFileSync(join(dataDir, "core", "main", "pins.json"), "utf8"));
      return pins[0]?.status?.text === "2 open" && pins[0].status.tone === "good";
    }, { what: "the chip status set by ccb.setStatus" });
    await shot(page, "component-board");
    await page.getByRole("button", { name: "Board" }).click();
    await expect(chat.locator(".pin-chip, .pin-area button").first()).toBeVisible();
    await shot(page, "component-pin-chip");
  } finally {
    await app.close();
  }
});
