// The app end to end: React shell ⇄ preload ⇄ main ⇄ core ⇄ the bot's long-lived head (fake CLI),
// with the chat drawn by the reused Web/src chat page in its frame.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {pathToFileURL} from "node:url";
import { alive, pidsIn, sleep, tempDir, until, desktop, fakeCli } from "../helpers";
import { audit, chatFrame, launch, post, say, waitForWelcome } from "./launch";

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

test("no Stop button while it writes (Send stays); Escape ends the reply; a head that ignores it has its process tree ended; nothing arrives after", async () => {
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
    // Sending while it writes never stops it, so there is no Stop button: Send stays where it is.
    await expect(chat.locator(".composer .send.stop")).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "Send" })).toBeVisible();
    await chat.locator("body").press("Escape");
    await expect(reply).toHaveAttribute("data-state", "stopped");
    // Its words so far stay, with no "Interrupted" under them.
    await expect(reply.locator(".interrupted-note")).toBeHidden();
    const textAtStop = await reply.locator(".markdown").textContent();
    await sleep(800);
    expect(await reply.locator(".markdown").textContent()).toBe(textAtStop);
    await until(() => pids.every((pid) => !alive(pid)), { what: "CLI tree ended", timeout: 15_000 });
    await expect(chat.getByRole("button", { name: "Send" })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

for(const startup of [0,5500])test(`reloading the window preserves the running turn (head startup ${startup}ms)`, async () => {
  const dataDir=tempDir('reload-startup'),marker=join(dataDir,'startup.json'),wrapper=join(dataDir,'fake-head.mjs');
  writeFileSync(wrapper,`import {writeFileSync} from 'node:fs'; const start=Date.now();writeFileSync(${JSON.stringify(marker)},JSON.stringify({start,ready:false}));await new Promise(r=>setTimeout(r,${startup}));writeFileSync(${JSON.stringify(marker)},JSON.stringify({start,ready:true,at:Date.now()}));await import(${JSON.stringify(pathToFileURL(fakeCli).href)});`);
  const { app, page, chat } = await launch({dataDir, env: { FAKE_CLAUDE_MODE: "slow",BOTLING_FAKE_CLI:wrapper } });
  let stderr='';app.process().stderr?.on('data',b=>{stderr=(stderr+b).slice(-65536);});
  try {
    await say(chat, "keep going");
    // A shell-ready window is not a ready CLI. Bound initial head startup separately from reload.
    await expect(chat.locator(".row.bot[data-id]").last().locator(".markdown")).toContainText("word3",{timeout:20_000});
    expect(JSON.parse(readFileSync(marker,"utf8")).ready).toBe(true);
    const before = await chat.locator(".row.bot[data-id]").count();
    await page.reload();
    await page.waitForSelector('.shell[data-ready="1"]');
    await chat.locator('html[data-chat]').waitFor({state:'attached'});await waitForWelcome(chat);
    const reply = chat.locator(".row.bot[data-id]").last();
    await expect(reply).toHaveAttribute("data-state", "streaming");
    await expect(chat.locator(".row.bot[data-id]")).toHaveCount(before); // No second turn was started.
    const length = (await reply.locator(".markdown").textContent())!.length;
    await expect.poll(async () => (await reply.locator(".markdown").textContent())!.length).toBeGreaterThan(length);
    await chat.locator("body").press("Escape");
    await expect(reply).toHaveAttribute("data-state", "stopped");
  } catch(error){
    const folder=join(desktop,'.cache/evidence/review-d');mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,`reload-startup-${startup}-failure.json`),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:null,stderr,marker:existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):null,head:existsSync(join(dataDir,'core/main/head.json'))?JSON.parse(readFileSync(join(dataDir,'core/main/head.json'),'utf8')):null},null,2));throw error;
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
    expect(await post(page, { v: 10, id: "a", cmd: { type: "card.html", botId: bot, messageId: "0B07E11C-0000-4000-8000-00000000C0DE", cardId: "c-counter" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await post(page, { v: 10, id: "b", cmd: { type: "shell.run", command: "id" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 11, id: "c", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(await post(page, { v: 10, id: "d", cmd: { type: "site.open", accountId: "work", url: "file:///etc/passwd" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await post(page, { v: 10, id: "e", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: true });
    expect((await audit(app)).some((entry) => entry.includes("refused renderer command card.html"))).toBe(true);
  } finally {
    await app.close();
  }
});
