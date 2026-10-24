// Phase 1 vertical slice + spike 2 in the real app: React view ⇄ preload ⇄ main ⇄ core ⇄ CLI.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { alive, pidsIn, sleep, tempDir, until } from "../helpers";
import { audit, launch, post } from "./launch";

test("sends a message and streams the reply into the chat", async () => {
  const { app, page } = await launch();
  try {
    await expect(page.locator(".row.notice").first()).toContainText("Botling 2.0");
    await page.getByLabel("Message").fill("hello from the test");
    await page.keyboard.press("Enter");
    await expect(page.locator(".row.user").last()).toHaveText("hello from the test");
    const reply = page.locator(".row.bot").last();
    await expect(reply).toHaveAttribute("data-state", "done");
    await expect(reply.locator(".bubble")).toHaveText("You said: hello from the test");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Stop ends the reply and its process tree; nothing arrives after", async () => {
  const dataDir = tempDir("e2e");
  const pidsFile = join(dataDir, "pids");
  const second = await launch({ dataDir, env: { FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PIDS: pidsFile } });
  try {
    const page = second.page;
    await page.getByLabel("Message").fill("count forever");
    await page.keyboard.press("Enter");
    const reply = page.locator(".row.bot").last();
    await expect(reply.locator(".bubble")).toContainText("word5");
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(reply).toHaveAttribute("data-state", "stopped");
    await expect(reply.locator(".state-line")).toHaveText("Stopped");
    const textAtStop = await reply.locator(".bubble").textContent();
    await sleep(800);
    expect(await reply.locator(".bubble").textContent()).toBe(textAtStop);
    await until(() => pids.every((pid) => !alive(pid)), { what: "CLI tree ended" });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("reloading the window does not stop or restart the running turn", async () => {
  const { app, page } = await launch({ env: { FAKE_CLAUDE_MODE: "slow" } });
  try {
    await page.getByLabel("Message").fill("keep going");
    await page.keyboard.press("Enter");
    await expect(page.locator(".row.bot").last().locator(".bubble")).toContainText("word3");
    const before = await page.locator(".row.bot").count();
    await page.reload();
    await page.waitForSelector('#messages[data-ready="1"]');
    const reply = page.locator(".row.bot").last();
    await expect(reply).toHaveAttribute("data-state", "streaming");
    await expect(page.locator(".row.bot")).toHaveCount(before); // No second turn was started.
    const length = (await reply.locator(".bubble").textContent())!.length;
    await expect.poll(async () => (await reply.locator(".bubble").textContent())!.length).toBeGreaterThan(length);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(reply).toHaveAttribute("data-state", "stopped");
  } finally {
    await app.close();
  }
});

test("main refuses what the page may not ask for", async () => {
  const { app, page } = await launch();
  try {
    expect(await page.evaluate(() => [typeof (window as any).require, typeof (window as any).process, typeof (window as any).ipcRenderer])).toEqual(["undefined", "undefined", "undefined"]);
    expect(Object.keys(await page.evaluate(() => (window as any).botling)).sort()).toEqual(["platform", "post", "protocol", "subscribe"]);
    expect(await post(page, { v: 1, id: "a", cmd: { type: "card.html", messageId: "m-welcome", cardId: "c-counter" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await post(page, { v: 1, id: "b", cmd: { type: "shell.run", command: "id" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 7, id: "c", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(await post(page, { v: 1, id: "d", cmd: { type: "site.open", accountId: "work", url: "file:///etc/passwd" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 1, id: "e", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: true });
    expect((await audit(app)).some((entry) => entry.includes("refused renderer command card.html"))).toBe(true);
  } finally {
    await app.close();
  }
});
