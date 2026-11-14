// Botling 3 M3 step 11: the front end for two servers. The page (web-v3) in headless Chromium and headless WebKit, paired
// with server A; server B is a peer (two real botlingd on loopback, fake engine, a pass-through fault proxy in front of
// each, the statements written into each server.db while stopped, as in M3 step 10). Per engine, one script:
//
//  1. B's bot is listed from the replicated `srv:<B>` table and opens with B's chat (through A).
//  2. A send to B's bot is delivered once.
//  3. Both proxies partitioned: B goes stale at A; a send shows "waiting for B (held at A)"; the banner and the chat's
//     notice read "<B> offline · as of <time>" over B's cached chat.
//  4. A page reload and a SIGKILL of the browser with the item held: it is resent after every catch-up and, once healed,
//     B has it once.
//  5. B backed up; a send is delivered; B restored from the backup: the page shows "delivered, then lost when <B> was
//     restored".
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/two-servers/vitest.config.mts test/acceptance/two-servers/fe-two-servers.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageOf, Slot } from "../../../src/protocol";
import { until } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { FaultProxy } from "../../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../../support/two-servers";
import { chatOf, PairCli, phone, rowsWith, say } from "../web-v3/page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const launches = new Set<string>();
const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const PEER_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const report: Record<string, unknown> = {};

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const rosterIds = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT id FROM roster").all() as Array<{ id: string }>).map((row) => String(row.id)));
/** How many user lines with this text B's chat holds. */
const userLines = (server: TestServer, botId: string, text: string) => withDb(server, (db) => (db.prepare("SELECT body FROM messages WHERE botId = ?").all(botId) as Array<{ body: string }>)
  .filter((row) => { const m = JSON.parse(row.body) as { role?: string; text?: string }; return m.role === "user" && m.text === text; }).length);

interface Diag { states: Record<string, string[]>; words: Record<string, string[]>; servers: string[]; banners: string[]; conn: string[] }
const diag = (page: Page): Promise<Diag> => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: unknown }).botling3Diagnostics)) as Diag);
const banner = (page: Page) => page.locator("[data-testid=conn-banner]");
const bannerText = async (page: Page) => (await banner(page).count()) ? (await banner(page).textContent()) ?? "" : "";
const allWords = async (page: Page) => Object.values((await diag(page)).words).flat();

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let botB: string;
let bName = "B";

beforeAll(async () => {
  for (const [name, type] of ENGINES) {
    try { await (await type.launch({ headless: true })).close(); launches.add(name); } catch { report[`${name}Skipped`] = "not installed"; }
  }
  const t0 = Date.now();
  cluster = await startServers({ name: "fe-two", count: 2, env: { A: PEER_ENV, B: PEER_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 51);
  pb = await cluster.proxy(b, "websocket", 52);
  const cl = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  const client = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Bee bot", job: "fe two servers" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text: "/say hello from B" }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}`, "chat.send on B");
  client.close();
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });
  report.setupMs = Date.now() - t0;
}, 300_000);

afterAll(async () => {
  for (const s of [a, b]) if (s) report[`log${s.name}`] = s.log.split("\n").filter((line) => /forward|peer|error/i.test(line)).slice(-30);
  await cluster?.cleanup();
  writeReport("step-11-fe-two-servers", report);
}, 60_000);

async function shot(page: Page, engine: string, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${engine}-${name}.png`) }).catch(() => undefined);
}

/** Opens B's bot from the drawer (phone width). */
async function openB(page: Page) {
  await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
  const row = page.locator(`.bot-row[data-bot='${botB}']`);
  if (!(await row.isVisible())) await page.getByRole("button", { name: "Bots" }).click();
  await row.click({ timeout: 30_000 });
  await expect.poll(() => rowsWith(page, "hello from B"), { timeout: 30_000 }).toBeGreaterThan(0);
}

function killHard(profileDir: string): number {
  const found = spawnSync("pgrep", ["-f", profileDir], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((pid) => pid > 0);
  for (const pid of found) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return found.length;
}

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `fe-two-${engine}-`));
  const profileDir = join(root, "profile");
  const result: Record<string, unknown> = {};
  report[engine] = result;
  let browser: { context: BrowserContext; page: Page } | null = null;
  try {
    browser = await phone(type, profileDir);
    let { page } = browser;
    const errors: string[] = [];
    const watch = (p: Page) => p.on("pageerror", (error) => errors.push(String(error)));
    watch(page);

    // Pair with A (link + code, `botlingd pair` confirms).
    const before = rosterIds(b).length;
    const cli = new PairCli(a.dataDir);
    const link = await cli.link();
    await page.goto(`http://127.0.0.1:${a.port}/v3/`);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    await cli.line((l) => l.startsWith("Code: "), "the code");
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    expect(await cli.closed).toBe(0);
    await until(() => rosterIds(b).length > before, { timeout: 30_000, what: "the page's Add at B" });

    // 1. B's bot listed from the replicated table; its chat through A.
    const tList = Date.now();
    await openB(page);
    result.listedAndOpenedMs = Date.now() - tList;
    const servers = (await diag(page)).servers;
    bName = servers.map((line) => line.replace(/ (live|stale|gone)$/, "")).find((name) => name !== "A" && servers.includes(`${name} live`)) ?? bName;
    result.serversSeen = servers;
    await shot(page, engine, "1-b-bot");

    // 2. A send to B's bot: delivered once.
    const live = `live ${engine}`;
    await say(page, live);
    await expect.poll(() => userLines(b, botB, live), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => rowsWith(page, `You said: ${live}`), { timeout: 30_000 }).toBe(1);

    // 3. Partition: B stale at A; held at A, waiting for B; the banner and the notice say B is offline.
    pa.partition(); pb.partition();
    pa.cut(); pb.cut();
    const tStale = Date.now();
    await expect.poll(async () => (await diag(page)).servers.at(-1) ?? "", { timeout: 30_000 }).toMatch(/ (stale|gone)$/);
    result.staleAfterPartitionMs = Date.now() - tStale;
    const held = `held ${engine}`;
    await say(page, held);
    await expect.poll(async () => (await allWords(page)).join(" | "), { timeout: 20_000 }).toMatch(/waiting for .+ \(held at .+\)/);
    await expect.poll(() => bannerText(page), { timeout: 20_000 }).toMatch(/offline · as of \d{1,2}:\d{2}/);
    const offline = await bannerText(page);
    result.banner = offline;
    expect(offline).toContain("waiting");
    const notice = await page.locator("body").innerText();
    result.noticeOnPage = /offline · as of/.test(notice);
    expect(await rowsWith(page, "hello from B")).toBeGreaterThan(0);
    await shot(page, engine, "2-b-offline");
    await page.waitForTimeout(1_000);
    expect(userLines(b, botB, held)).toBe(0);

    // 4a. Reload with the item held: still waiting, resent after catch-up.
    await page.reload();
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await expect.poll(() => bannerText(page), { timeout: 20_000 }).toMatch(/offline · as of/);
    await expect.poll(async () => (await allWords(page)).join(" | "), { timeout: 20_000 }).toMatch(/waiting for/);
    result.afterReload = await bannerText(page);

    // 4b. SIGKILL the browser with the item held; a new browser on the same profile.
    result.killed = killHard(profileDir);
    await browser.context.close().catch(() => undefined);
    browser = await phone(type, profileDir);
    page = browser.page;
    watch(page);
    await page.goto(`http://127.0.0.1:${a.port}/v3/`);
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await allWords(page)).join(" | "), { timeout: 30_000 }).toMatch(/waiting for|held at/);
    result.afterKill = { banner: await bannerText(page), words: await allWords(page) };

    // Heal: delivered once at B.
    const tHeal = Date.now();
    pa.heal(); pb.heal();
    await expect.poll(() => userLines(b, botB, held), { timeout: 60_000 }).toBe(1);
    result.deliveredAfterHealMs = Date.now() - tHeal;
    await expect.poll(() => bannerText(page), { timeout: 30_000 }).toBe("");
    await page.waitForTimeout(1_500);
    expect(userLines(b, botB, held)).toBe(1);
    await openB(page);
    await expect.poll(() => rowsWith(page, `You said: ${held}`), { timeout: 30_000 }).toBe(1);

    // 5. B restored from a backup taken before a delivered send: "delivered, then lost when B was restored".
    const backup = b.backup();
    const lost = `lost ${engine}`;
    await say(page, lost);
    await expect.poll(() => userLines(b, botB, lost), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => rowsWith(page, `You said: ${lost}`), { timeout: 30_000 }).toBe(1);
    const tRestore = Date.now();
    await b.restore(backup);
    await expect.poll(async () => (await allWords(page)).join(" | "), { timeout: 60_000 }).toMatch(/delivered, then lost when .+ was restored/);
    result.lostShownAfterRestoreMs = Date.now() - tRestore;
    expect(userLines(b, botB, lost)).toBe(0);
    await shot(page, engine, "3-lost");
    result.words = (await diag(page)).words;
    result.banners = (await diag(page)).banners;
    // B's restore is B's: never "this machine's history was restored" at A.
    expect(result.banners as string[]).not.toContainEqual(expect.stringMatching(/history was restored/));
    result.pageErrors = errors;
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    killHard(profileDir);
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(ENGINES.length === 0)("M3 step 11: the page at A for B's bot (headless, two real botlingd)", () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: B's bot listed, held at A while partitioned, waiting/offline words, resent after reload and kill, lost after restore`, async (ctx) => {
      if (!launches.has(engine)) ctx.skip();
      await run(engine, type);
    }, 600_000);
  }
});
