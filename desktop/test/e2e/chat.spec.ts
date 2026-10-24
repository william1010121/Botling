// The app end to end: React shell ⇄ preload ⇄ main ⇄ core ⇄ the bot's long-lived head (fake CLI),
// with the chat drawn by the reused Web/src chat page in its frame.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { alive, pidsIn, sleep, tempDir, until } from "../helpers";
import { audit, chatFrame, launch, post, say } from "./launch";

test("sends a message and streams the reply into the chat", async () => {
  const { app, page, chat } = await launch();
  try {
    await expect(chat.locator(".row.notice").first()).toContainText("Botling 2.0");
    await expect(page.locator(".bot-row.selected")).toContainText("Main bot");
    await say(chat, "hello from the test");
    await expect(chat.locator(".row.user").last()).toContainText("hello from the test");
    const reply = chat.locator(".row.bot[data-id]").last();
    await expect(reply).toHaveAttribute("data-state", "done");
    await expect(reply.locator(".markdown")).toHaveText("You said: hello from the test");
    await expect(chat.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(chat.getByRole("button", { name: "Stop" })).toBeHidden();
  } finally {
    await app.close();
  }
});

test("Stop ends the reply; a head that ignores it has its process tree ended; nothing arrives after", async () => {
  const dataDir = tempDir("e2e");
  const pidsFile = join(dataDir, "pids");
  const second = await launch({ dataDir, env: { FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PIDS: pidsFile } });
  try {
    const { page, chat } = second;
    await say(chat, "count forever");
    const reply = chat.locator(".row.bot[data-id]").last();
    await expect(reply.locator(".markdown")).toContainText("word5");
    await expect(page.locator(".chat-status")).toHaveText("Writing…");
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    await chat.getByRole("button", { name: "Stop" }).click();
    await expect(reply).toHaveAttribute("data-state", "stopped");
    await expect(reply.locator(".interrupted-note")).toBeVisible();
    const textAtStop = await reply.locator(".markdown").textContent();
    await sleep(800);
    expect(await reply.locator(".markdown").textContent()).toBe(textAtStop);
    await until(() => pids.every((pid) => !alive(pid)), { what: "CLI tree ended", timeout: 15_000 });
    await expect(chat.getByRole("button", { name: "Send" })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("reloading the window does not stop or restart the running turn", async () => {
  const { app, page, chat } = await launch({ env: { FAKE_CLAUDE_MODE: "slow" } });
  try {
    await say(chat, "keep going");
    await expect(chat.locator(".row.bot[data-id]").last().locator(".markdown")).toContainText("word3");
    const before = await chat.locator(".row.bot[data-id]").count();
    await page.reload();
    await page.waitForSelector('.shell[data-ready="1"]');
    const reply = chat.locator(".row.bot[data-id]").last();
    await expect(reply).toHaveAttribute("data-state", "streaming");
    await expect(chat.locator(".row.bot[data-id]")).toHaveCount(before); // No second turn was started.
    const length = (await reply.locator(".markdown").textContent())!.length;
    await expect.poll(async () => (await reply.locator(".markdown").textContent())!.length).toBeGreaterThan(length);
    await chat.getByRole("button", { name: "Stop" }).click();
    await expect(reply).toHaveAttribute("data-state", "stopped");
  } finally {
    await app.close();
  }
});

test("main refuses what the page may not ask for; the chat frame has no bridge of its own", async () => {
  const { app, page } = await launch();
  try {
    expect(await page.evaluate(() => [typeof (window as any).require, typeof (window as any).process, typeof (window as any).ipcRenderer])).toEqual(["undefined", "undefined", "undefined"]);
    expect(Object.keys(await page.evaluate(() => (window as any).botling)).sort()).toEqual(["platform", "post", "protocol", "subscribe"]);
    const frame = await chatFrame(page);
    expect(await frame.evaluate(() => [typeof (window as any).botling, typeof (window as any).require, typeof (window as any).process])).toEqual(["undefined", "undefined", "undefined"]);
    const bot = "6A0B0000-0000-4000-8000-000000000002";
    expect(await post(page, { v: 4, id: "a", cmd: { type: "card.html", botId: bot, messageId: "0B07E11C-0000-4000-8000-00000000C0DE", cardId: "c-counter" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await post(page, { v: 4, id: "b", cmd: { type: "shell.run", command: "id" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 7, id: "c", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(await post(page, { v: 4, id: "d", cmd: { type: "site.open", accountId: "work", url: "file:///etc/passwd" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 4, id: "e", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: true });
    expect((await audit(app)).some((entry) => entry.includes("refused renderer command card.html"))).toBe(true);
  } finally {
    await app.close();
  }
});
