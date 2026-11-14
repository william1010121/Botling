// M2 step 8: the Botling 3 page (web-v3/) in headless Chromium and headless WebKit against a real botlingd (temp data
// folder on the work disk, fake engine, listener on 127.0.0.1 only). Per engine, one script:
//
//  1. pair by pasted link + code: the page shows the same 6-digit code as `botlingd pair`, which confirms it;
//  2. send → the reply streams; live frames at the page ≤ 10/s;
//  3. reload mid-reply → the chat comes back from the stored state with no duplicate line, the reply ends once;
//  4. `context.setOffline(true)` → a send shows "waiting" (never "not sent"/failed), back online → delivered once;
//  5. botlingd stopped → "connecting…" at once, "offline · as of <time>" after 45 s, the cached chat still readable;
//     restart → the message sent meanwhile is delivered once;
//  6. botlingd SIGKILLed with a message in flight + restart → no loss, no double.
// Then the build check: the bundle has no `node:` import, no 2.x `/api/mobile` endpoint, IndexedDB names start with
// `botling3-`. Phone-width screenshots go to V3_SHOT_DIR (the evidence folder) when set.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/page.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import { chatOf, diag, freePort, PairCli, phone, rowsWith, say, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const dist = join(desktop, "web-v3", "dist");
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-8-page", report); });

async function shot(page: Page, engine: string, name: string) {
  if (!SHOTS || engine !== "chromium") return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const banner = (page: Page) => page.locator("[data-testid=conn-banner]");
const bannerText = async (page: Page) => (await banner(page).count()) ? (await banner(page).textContent()) ?? "" : "";

/** Every delivery state an item went through, from the page's diagnostics. */
async function statesSeen(page: Page): Promise<string[][]> { return Object.values((await diag(page)).states); }

async function waitRow(page: Page, text: string, ms = 30_000) {
  await expect.poll(() => rowsWith(page, text), { timeout: ms }).toBeGreaterThan(0);
}

function countUser(messages: { role: string; text: string }[], text: string) { return messages.filter((m) => m.role === "user" && m.text === text).length; }
function countReply(messages: { role: string; text: string }[], text: string) { return messages.filter((m) => m.role === "bot" && m.text.includes(`You said: ${text}`)).length; }

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `page-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const server = new Server(dataDir, await freePort());
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  let failShot = async () => undefined as void;
  try {
    await server.ready();
    browser = await phone(type, join(root, "profile"));
    let { page } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const consoleLines: string[] = [];
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 500)); });
    result.console = consoleLines;
    failShot = async () => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `fail-${engine}.png`) }).catch(() => undefined); } };

    // 1. Pair by pasted link + code.
    const cli = new PairCli(dataDir);
    const link = await cli.link();
    await page.goto(server.page);
    await page.getByLabel("Pairing link").fill(link);
    await shot(page, engine, "1-pair-link");
    await page.getByRole("button", { name: "Pair" }).click();
    const pageCode = (await page.getByTestId("pair-code").textContent({ timeout: 30_000 }))!.replace(/\s/g, "");
    const cliCode = (await cli.line((l) => l.startsWith("Code: "), "the code")).slice(6).replace(/\s/g, "");
    expect(pageCode).toMatch(/^[0-9]{6}$/);
    expect(pageCode).toBe(cliCode);
    await shot(page, engine, "2-pair-code");
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    expect(await cli.closed).toBe(0);
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await expect.poll(() => bannerText(page), { timeout: 20_000 }).toBe("");
    result.paired = { codeMatched: true };

    // 2. Send; the reply streams. A long message makes the fake engine stream ~150 words (15 ms each).
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
    const first = `first ${words}`;
    const liveBefore = (await diag(page)).live.length;
    await say(page, first);
    await waitRow(page, "You said: first");
    await expect.poll(async () => (await server.messages()).some((m) => m.role === "bot" && m.text.endsWith("w119") && countReply([m], first) === 1), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => rowsWith(page, "w119"), { timeout: 20_000 }).toBe(2);
    const live = (await diag(page)).live.slice(liveBefore);
    let maxWindow = 0;
    for (let i = 0; i < live.length; i++) { let n = 0; for (let j = i; j < live.length && live[j]! - live[i]! < 1000; j++) n++; maxWindow = Math.max(maxWindow, n); }
    const span = live.length > 1 ? (live[live.length - 1]! - live[0]!) / 1000 : 0;
    const meanPerSecond = span > 0 ? (live.length - 1) / span : 0;
    result.streaming = { liveFrames: live.length, spanSeconds: Number(span.toFixed(2)), maxPerSecond: maxWindow, meanPerSecond: Number(meanPerSecond.toFixed(2)) };
    expect(live.length).toBeGreaterThan(3);
    // The server sends at most one live frame per 100 ms (live-gate.ts); measured at arrival, one late frame followed by
    // an on-time one can put 11 inside a 1 s window, so the sliding window allows that one frame of jitter and the mean
    // rate over the whole reply must stay within 10/s.
    expect(meanPerSecond).toBeLessThanOrEqual(10);
    expect(maxWindow).toBeLessThanOrEqual(11);
    await shot(page, engine, "3-chat");

    // 3. Reload mid-reply: no duplicate line; the reply finishes once.
    const second = `second ${words}`;
    await say(page, second);
    await waitRow(page, "You said: second");
    await page.reload();
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await expect.poll(async () => countReply(await server.messages(), second), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => rowsWith(page, "w119"), { timeout: 30_000 }).toBe(4);
    expect(await rowsWith(page, first)).toBe(2);
    expect(countUser(await server.messages(), second)).toBe(1);
    result.reload = { duplicates: 0 };

    // 4. Offline: waiting, never failed; online → delivered once.
    const offlineText = `offline message ${engine}`;
    await browser.context.setOffline(true);
    await expect.poll(() => bannerText(page), { timeout: 60_000 }).toMatch(/^connecting…|^offline/);
    await say(page, offlineText);
    await expect.poll(() => bannerText(page), { timeout: 10_000 }).toContain("1 waiting");
    await waitRow(page, offlineText);
    await page.waitForTimeout(2_000);
    expect(countUser(await server.messages(), offlineText)).toBe(0);
    await shot(page, engine, "4-offline-waiting");
    await browser.context.setOffline(false);
    await expect.poll(async () => countUser(await server.messages(), offlineText), { timeout: 60_000 }).toBe(1);
    await expect.poll(() => bannerText(page), { timeout: 30_000 }).toBe("");
    await expect.poll(() => rowsWith(page, `You said: ${offlineText}`), { timeout: 30_000 }).toBe(1);
    expect(await rowsWith(page, offlineText)).toBe(2);
    result.offline = { deliveredOnce: true };

    // 5. Server stopped: connecting… at once, offline · as of <time> after 45 s, the chat still readable.
    await server.stop("SIGTERM");
    const stoppedAt = Date.now();
    await expect.poll(() => bannerText(page), { timeout: 10_000 }).toMatch(/^connecting…/);
    const connectingAfter = Date.now() - stoppedAt;
    const downText = `while stopped ${engine}`;
    await say(page, downText);
    await expect.poll(() => bannerText(page), { timeout: 70_000, interval: 1_000 }).toMatch(/^offline · as of [0-9]{2}:[0-9]{2}/);
    const offlineAfter = Date.now() - stoppedAt;
    expect(offlineAfter).toBeGreaterThanOrEqual(44_000);
    expect(await rowsWith(page, first)).toBe(2);
    expect(await rowsWith(page, downText)).toBe(1);
    result.serverStopped = { connectingAfterMs: connectingAfter, offlineAfterMs: offlineAfter, banner: await bannerText(page) };
    await shot(page, engine, "5-offline");
    await server.restart();
    await expect.poll(async () => countUser(await server.messages(), downText), { timeout: 60_000 }).toBe(1);
    await expect.poll(() => bannerText(page), { timeout: 30_000 }).toBe("");

    // 6. SIGKILL with a message in flight, then restart: no loss, no double.
    const killText = `kill ${engine} ${words}`;
    await say(page, killText);
    await page.waitForTimeout(150);
    await server.stop("SIGKILL");
    await server.restart();
    await expect.poll(async () => countUser(await server.messages(), killText), { timeout: 60_000 }).toBe(1);
    await expect.poll(() => bannerText(page), { timeout: 30_000 }).toBe("");
    await page.waitForTimeout(3_000);
    const after = await server.messages();
    expect(countUser(after, killText)).toBe(1);
    expect(await rowsWith(page, `kill ${engine}`)).toBeGreaterThanOrEqual(1);
    for (const text of [first, second, offlineText, downText]) expect(countUser(after, text)).toBe(1);
    result.sigkill = { userLines: countUser(after, killText) };

    // Never shown as failed while the outcome was unknown.
    const seen = await statesSeen(page);
    expect(seen.flat()).not.toContain("not sent");
    result.deliveryStates = [...new Set(seen.map((s) => s.join(">")))];
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
    result.indexedDB = databases;
    expect(databases.length).toBeGreaterThan(0);
    for (const name of databases) expect(name.startsWith("botling3-"), name).toBe(true);
    result.pageErrors = errors;
    expect(errors).toEqual([]);
  } catch (error) {
    await failShot();
    result.failure = String(error).slice(0, 2_000);
    result.storage = await browser?.page.evaluate(async () => {
      const names = await indexedDB.databases?.().then((list) => list.map((d) => d.name), (e: unknown) => String(e));
      const keys = await new Promise((resolve) => {
        const q = indexedDB.open("botling3-device");
        q.onsuccess = () => { try { const g = q.result.transaction("device").objectStore("device").getAllKeys(); g.onsuccess = () => { resolve(g.result); q.result.close(); }; g.onerror = () => resolve(String(g.error)); } catch (e) { resolve(String(e)); } };
        q.onerror = () => resolve(String(q.error)); q.onblocked = () => resolve("blocked");
      });
      return { names, keys, href: location.href, busy: document.querySelector("main")?.getAttribute("aria-busy"), text: document.body.innerText.slice(0, 120) };
    }).catch((e: unknown) => String(e));
    result.serverLog = server.daemon.log.slice(-3_000);
    throw error;
  } finally {
    await browser?.context.close().catch(() => undefined);
    await server.stop("SIGTERM").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M2 step 8: the Botling 3 page against a real botlingd", () => {
  for (const [name, type] of ENGINES) it(`headless ${name}`, () => run(name, type), 600_000);

  it("build check: no node: import, no 2.x /api/mobile endpoint, IndexedDB names start with botling3-", () => {
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    const inputs = JSON.parse(readFileSync(`${dist}.inputs.json`, "utf8")) as { inputs: string[] };
    expect(inputs.inputs.filter((input) => input.startsWith("node:"))).toEqual([]);
    // No module of the 2.x phone page's HTTPS bridge client (mobile/transport, web-bridge, WebApp, relay client…).
    const banned = inputs.inputs.filter((input) => /(^|\/)mobile\/(transport|web-bridge|WebApp|relay-client|relay-session|session|routes|events|pair)\.tsx?$/.test(input) || /src\/mobile-relay\//.test(input));
    expect(banned).toEqual([]);
    const js = readdirSync(dist).filter((name) => name.endsWith(".js"));
    for (const name of js) {
      const text = readFileSync(join(dist, name), "utf8");
      expect(text, name).not.toMatch(/require\(\s*["']node:|from\s*["']node:|import\(\s*["']node:/);
      expect(text, name).not.toContain("/api/mobile");
      for (const match of text.matchAll(/indexedDB\.(?:open|deleteDatabase)\(\s*["'`]([^"'`]+)/g)) expect(match[1]!.startsWith("botling3-"), `${name}: ${match[1]}`).toBe(true);
    }
    const web = readFileSync(join(dist, "web.js"), "utf8");
    // The names are built from one prefix constant (src/fe-link/idb-storage.ts IDB_PREFIX): `${prefix}fe`, `${prefix}device`.
    const prefixVars = [...web.matchAll(/(?:var|let|const|,)\s*([\w$]+)="botling3-"/g)].map((m) => m[1]!);
    const named = (suffix: string) => web.includes(`"botling3-${suffix}"`) || prefixVars.some((v) => web.includes(`\`\${${v}}${suffix}\``) || web.includes(`${v}+"${suffix}"`));
    expect(prefixVars.length > 0 || web.includes("botling3-fe"), "the botling3- prefix").toBe(true);
    expect(named("fe"), "botling3-fe").toBe(true);
    expect(named("device"), "botling3-device").toBe(true);
    expect(web).toContain("/v3/chat.html");
    expect(web).not.toContain("/mobile/chat.html");
    report.build = { inputs: inputs.inputs.length, js };
  });
});
