import { expect, test, type Page, type FrameLocator } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, swiftLine } from "../helpers";
import { chatFrame, launch, post } from "./launch";

const transcript = [swiftLine({ id: "ABCD0000-0000-4000-8000-000000000001", role: "user", text: "Compare the widths using this synthetic conversation." }),
  swiftLine({ id: "ABCD0000-0000-4000-8000-000000000002", role: "bot", text: "A wider message column gives this long reply more room. ".repeat(12) + "\n\n```text\n" + "wide_content_".repeat(80) + "\n```" })];
const saved = (dir: string): number | undefined => {
  const file = join(dir, "core", "settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).messageColumnWidth : undefined;
};
async function width(chat: FrameLocator) { return chat.locator("#messages").evaluate((el) => el.getBoundingClientRect().width); }
async function aligned(chat: FrameLocator, wanted: number) {
  await expect.poll(() => width(chat)).toBe(wanted);
  const frame = await chatFrame(chat.locator("body").page());
  const rects = await frame.evaluate(() => ["messages", "composer-slot", "pin-area"].map((id) => {
    const r = document.getElementById(id)!.getBoundingClientRect(); return [r.x, r.width];
  }));
  expect(rects[1]).toEqual(rects[0]);
  expect(rects[2]).toEqual(rects[0]);
}
async function drag(page: Page, chat: FrameLocator, side: "left" | "right", delta: number, beforeRelease?: () => Promise<void>) {
  const box = await chat.locator(`.message-width-handle.${side}`).boundingBox();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await beforeRelease?.();
  await page.mouse.up();
}
async function screenshot(page: Page, name: string) {
  const folder = join(desktop, ".cache", "width-screens");
  mkdirSync(folder, { recursive: true });
  // The synthetic screenshot is accepted only after any visible images have decoded.
  for (const frame of page.frames()) await frame.evaluate(async () => {
    for (const image of Array.from(document.images).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)) { try { await image.decode(); } catch { throw new Error(`Image failed: ${image.src.slice(0, 120)}`); } if (!image.complete || image.naturalWidth === 0) throw new Error("Image failed to decode"); }
  });
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

test("both edges resize symmetrically, preview before saving, cancel, and double-click reset", async () => {
  const { app, page, chat, dataDir } = await launch({ chat: transcript });
  try {
    await page.setViewportSize({ width: 1900, height: 900 });
    await aligned(chat, 640);
    const bubble = chat.locator(".row.bot .bot-bubble").last();
    const oldBubbleWidth = (await bubble.boundingBox())!.width;
    await drag(page, chat, "right", 80, async () => {
      await aligned(chat, 800);
      expect(saved(dataDir)).toBeUndefined();
      // Settings updates rerender the shell while the pointer is still down; the drag must survive.
      expect(await post(page, { v: 10, id: "width-during-update", cmd: { type: "settings.set", change: { key: "botLook", value: "original" } } })).toMatchObject({ ok: true });
      await aligned(chat, 800);
    });
    await expect.poll(() => saved(dataDir)).toBe(800);
    expect((await bubble.boundingBox())!.width).toBeGreaterThan(oldBubbleWidth + 100);
    await drag(page, chat, "left", -30);
    await aligned(chat, 860);
    await expect.poll(() => saved(dataDir)).toBe(860);
    await drag(page, chat, "right", 40, async () => {
      await aligned(chat, 940);
      await page.keyboard.press("Escape");
    });
    await aligned(chat, 860);
    expect(saved(dataDir)).toBe(860);
    await screenshot(page, "symmetric-width-860");
    await chat.locator(".message-width-handle.left").dblclick();
    await aligned(chat, 640);
    await expect.poll(() => saved(dataDir)).toBeUndefined();
    await drag(page, chat, "left", -40);
    await aligned(chat, 720);
    await chat.locator(".message-width-handle.right").dblclick();
    await aligned(chat, 640);
    await expect.poll(() => saved(dataDir)).toBeUndefined();
  } finally { await app.close(); }
});

test("Appearance slider applies to main, another bot and group chats, and survives a full app relaunch", async () => {
  const dataDir = tempDir("width-relaunch");
  let run = await launch({ dataDir, chat: transcript });
  try {
    let { page, chat } = run;
    await page.setViewportSize({ width: 1900, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await sheet.getByRole("button", { name: "Appearance", exact: true }).click();
    await sheet.getByRole("slider", { name: "Message column width" }).fill("900");
    await expect.poll(() => saved(dataDir)).toBe(900);
    await screenshot(page, "appearance-width-900");
    await sheet.getByRole("button", { name: "Done" }).click();
    await aligned(chat, 900);
    await page.locator(".bot-row", { hasText: "Maintainer" }).click();
    await aligned(chat, 900);
    await page.getByRole("button", { name: "New group", exact: true }).click();
    const group = page.getByRole("form", { name: "New group" });
    await group.getByRole("textbox", { name: "Group name" }).fill("Width study");
    await group.getByRole("checkbox", { name: "Main bot" }).check();
    await group.getByRole("checkbox", { name: "Maintainer" }).check();
    await group.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator(".group-row")).toHaveClass(/selected/);
    await aligned(chat, 900);
    await run.app.close();
    run = await launch({ dataDir });
    ({ page, chat } = run);
    await page.setViewportSize({ width: 1900, height: 900 });
    await aligned(chat, 900);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const again = page.getByRole("dialog", { name: "Settings" });
    await again.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(again.getByRole("slider", { name: "Message column width" })).toHaveValue("900");
    await again.getByRole("button", { name: "Use default width" }).click();
    await expect.poll(() => saved(dataDir)).toBeUndefined();
    await expect(again.getByRole("slider", { name: "Message column width" })).toHaveValue("640");
    await aligned(chat, 640);
  } finally { if (run.app.process().exitCode === null) await run.app.close(); }
});

test("drag and keyboard bounds, responsive narrow windows, and saved preference restored when widened", async () => {
  const { app, page, chat, dataDir } = await launch({ chat: transcript });
  try {
    await page.setViewportSize({ width: 1900, height: 900 });
    await drag(page, chat, "right", 400);
    await aligned(chat, 1200);
    await expect.poll(() => saved(dataDir)).toBe(1200);
    await drag(page, chat, "right", -500);
    await aligned(chat, 360);
    await expect.poll(() => saved(dataDir)).toBe(360);
    // The left edge also finishes a drag released over the app's left column.
    await drag(page, chat, "left", -600);
    await aligned(chat, 1200);
    await expect.poll(() => saved(dataDir)).toBe(1200);
    const handle = chat.locator(".message-width-handle.right");
    await handle.focus();
    await page.keyboard.press("Home");
    await aligned(chat, 360);
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await aligned(chat, 380);
    await expect.poll(() => saved(dataDir)).toBe(380);
    await page.keyboard.press("End");
    await aligned(chat, 1200);
    await expect.poll(() => saved(dataDir)).toBe(1200);
    await page.setViewportSize({ width: 580, height: 780 });
    const frame = await chatFrame(page);
    const available = await frame.evaluate(() => document.documentElement.clientWidth);
    expect(available).toBeLessThan(360);
    await aligned(chat, available);
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const selector of ["#messages", "#composer-slot", ".row.bot .bot-bubble", ".composer", ".cm-editor"]) {
      expect(await chat.locator(selector).last().evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1; })).toBe(true);
    }
    expect(saved(dataDir)).toBe(1200);
    await screenshot(page, "narrow-width-fit");
    await page.setViewportSize({ width: 1900, height: 900 });
    await aligned(chat, 1200);
    await screenshot(page, "wide-width-1200");
    // A preferred wide column starts an inward drag from its actual constrained width.
    await page.setViewportSize({ width: 1200, height: 900 });
    const constrained = await frame.evaluate(() => document.documentElement.clientWidth);
    expect(constrained).toBeLessThan(1200);
    await aligned(chat, constrained);
    await drag(page, chat, "right", -40);
    await aligned(chat, constrained - 80);
    await expect.poll(() => saved(dataDir)).toBe(constrained - 80);
    await page.setViewportSize({ width: 1900, height: 900 });
    await aligned(chat, constrained - 80);
    await handle.focus();
    await page.keyboard.press("Home");
    await aligned(chat, 360);
    await page.keyboard.press("Enter");
    await aligned(chat, 640);
    await expect.poll(() => saved(dataDir)).toBeUndefined();
  } finally { await app.close(); }
});
