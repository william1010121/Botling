// Botling 3 M2 step 15 (m2-brief §4 row 15, "also for a PDF owned by another server"): the PDF viewer on A's page
// opens a 100-page PDF that server B owns, in headless Chromium and headless WebKit against two real botlingd on
// loopback (fake engine; peer session through a pass-through proxy each, the statements written into each server.db
// while stopped, as in M3 step 10). B's bot line shows the PDF; B's owner job makes its `text` variant (page count,
// outline, page text). A phone paired at A asks A for it (`content.locate`); A asks B. The browser opens A's
// `/v3/pdf.html` with A's ticketed `/v3/c/<B>/…` URLs, under the page's own CSP (no bypass).
//
// Per engine: page 1 within 2 s, by range requests only (< 1 MiB read before page 1); find a word of page 77 from B's
// text variant; no CSP violation, nothing from another origin.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/two-servers/vitest.config.mts test/acceptance/two-servers/pdf-peer.test.ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type Frame } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentUrlPath, type Message, type MessageOf, type Slot } from "../../../src/protocol";
import { until } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { FaultProxy } from "../../support/fault-proxy";
import { FIND_PAGE, FIND_WORD, makeTextPdf, type MadePdf } from "../../support/make-pdf";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../../support/two-servers";
import { pairPhone, PhoneSession } from "../../support/ws-device";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const launches = new Set<string>();
const MiB = 1 << 20;
const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const PEER_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","), BOTLING_SERVER_PEER_CACHE: `bytes=${256 * MiB}` };
const report: Record<string, unknown> = {};

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const rosterIds = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT id FROM roster").all() as Array<{ id: string }>).map((row) => String(row.id)));

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let media: string;
let pdfFile: string;
let made: MadePdf;
let botB: string;
let lineB: string;
let phoneA: PhoneSession;

let reqN = 0;
/**
 * A's ticket for B's PDF: the original's and the text variant's `/v3/c/<B>/…` paths (one ticket names the reference,
 * any variant). A's `content.located` lists no variants for a file another server owns (it describes only its own
 * files); the page learns B's variants from the `content.variant` entries of the line's bot stream.
 */
async function locate(): Promise<{ url: string; textUrl: string; variants: string[] }> {
  return until(async () => {
    const req = `loc${++reqN}`;
    phoneA.send({ t: "content.locate", req, botId: botB, line: lineB, url: pathToFileURL(pdfFile).href } as Message);
    const answer = await until(() => phoneA.got.find((m): m is MessageOf<"content.located"> => m.t === "content.located" && m.req === req) ?? null, { timeout: 15_000, what: `located ${req}` });
    const names = (answer.variants ?? []).map((v) => v.name);
    if (!answer.ref || !answer.ticket) { await new Promise((resolve) => setTimeout(resolve, 300)); return null; }
    expect(answer.ref.owner).toBe(kb.memberId);
    const path = (variant: string) => contentUrlPath({ owner: answer.ref!.owner, id: answer.ref!.id, variant, entry: answer.ref!.entry, ticket: answer.ticket! });
    return { url: path("original"), textUrl: path("text"), variants: names.sort() };
  }, { timeout: 90_000, what: "A's tickets for B's PDF with its text variant" });
}

beforeAll(async () => {
  for (const [name, type] of ENGINES) {
    try { await (await type.launch({ headless: true })).close(); launches.add(name); } catch { report[`${name}Skipped`] = "not installed"; }
  }
  media = mkdtempSync(join(TMP, "pdf-peer-"));
  pdfFile = join(media, "report.pdf");
  made = makeTextPdf(pdfFile, 100);
  report.pdf = { bytes: made.bytes, pages: made.pages };
  const t0 = Date.now();
  cluster = await startServers({ name: "pdf-peer", count: 2, env: { A: PEER_ENV, B: PEER_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 41);
  pb = await cluster.proxy(b, "websocket", 42);
  const cl = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  // B's bot and a line showing the PDF (the fake engine's /say).
  const client = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Reports", job: "pdf peer test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text: `/say The report: ![report](${pathToFileURL(pdfFile).href})` }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}`, "chat.send on B");
  lineB = await until(() => withDb(b, (db) => (db.prepare("SELECT msgId, body FROM messages WHERE botId = ? ORDER BY seq").all(botB) as Array<{ msgId: string; body: string }>).find((row) => { const m = JSON.parse(row.body) as { role?: string; text?: string }; return m.role !== "user" && String(m.text ?? "").includes("![report]"); })?.msgId ?? null), { timeout: 30_000, what: "the bot's line on B" });
  client.close();
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });

  const clientA = await a.client("pairing", "a".repeat(32));
  const paired = await pairPhone(clientA, a.port);
  clientA.close();
  await until(() => rosterIds(b).includes(paired.addId), { timeout: 30_000, what: "the phone's Add at B" });
  phoneA = await PhoneSession.open(paired.keys, a.port, { memberId: ka.memberId, dh: ka.dh }, cl.clusterId);
  await until(() => phoneA.welcomed, { what: "the phone welcomed at A" });
  report.setupMs = Date.now() - t0;
}, 300_000);

afterAll(async () => {
  phoneA?.close();
  for (const s of [a, b]) if (s) report[`log${s.name}`] = s.log.split("\n").filter((line) => /peer content|content:|media/.test(line)).slice(-20);
  await cluster?.cleanup();
  if (media) rmSync(media, { recursive: true, force: true });
  writeReport("step-15-pdf-peer", report);
}, 60_000);

interface PdfDiag {
  state: string; error?: string; size?: number; pages?: number; bytes: number; reads: unknown[];
  firstPageMs?: number; bytesBeforeFirstPage?: number; readsBeforeFirstPage?: number; fullRequests: number;
  find?: { query: string; hits: number; source: string; at?: { page: number; nth: number }; marked: number };
}
const pdfDiag = (frame: Frame) => frame.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Pdf?: unknown }).botling3Pdf ?? null)) as PdfDiag | null);

describe.skipIf(ENGINES.length === 0)("M2 step 15: the PDF viewer on A for a PDF B owns (headless, two real botlingd)", () => {
  let tickets: { url: string; textUrl: string; variants: string[] };

  it("B's text job announces content.text; the phone at A gets A's ticket for B's PDF", async () => {
    const t = Date.now();
    // B's owner job: page count, outline and page text as the `text` variant, announced on B's bot stream.
    const text = await until(() => withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'content.text'").get() as { body: string } | undefined)?.body ?? null), { timeout: 90_000, what: "content.text on B" });
    const body = JSON.parse(text) as { id: string; pages: number; textId: string };
    expect(body.pages).toBe(100);
    const variantsOnB = withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'content.variant'").all() as Array<{ body: string }>).map((row) => (JSON.parse(row.body) as { variant: { name: string } }).variant.name).sort());
    expect(variantsOnB).toContain("text");
    tickets = await locate();
    report.locate = { textJobMs: Date.now() - t, contentText: { pages: body.pages }, variantsOnB, locatedVariantsAtA: tickets.variants };
    for (const s of [a, b]) s.assertLoopbackOnly({ expectListener: true });
  }, 180_000);

  for (const [engine, type] of ENGINES) {
    it(`${engine}: A's viewer shows page 1 of B's PDF by ranges in < 2 s and finds from B's text, under the page's CSP`, async (ctx) => {
      if (!launches.has(engine)) ctx.skip();
      const result: Record<string, unknown> = {};
      report[engine] = result;
      const browser = await type.launch({ headless: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOTLING_"))) as Record<string, string> });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" });
        await context.addInitScript(() => {
          const seen: string[] = [];
          (globalThis as { botling3Csp?: string[] }).botling3Csp = seen;
          document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
        });
        const origin = `http://127.0.0.1:${a.port}`;
        const foreign: string[] = [];
        const log: Array<{ range: string | null; status?: number }> = [];
        context.on("request", (request) => {
          if (!request.url().startsWith(origin)) foreign.push(request.url());
          if (!request.url().includes("/original?")) return;
          const entry: { range: string | null; status?: number } = { range: null };
          log.push(entry);
          void request.headerValue("range").then((range) => { entry.range = range; }, () => undefined);
          void request.response().then((response) => { if (response) entry.status = response.status(); }, () => undefined);
        });
        const page = await context.newPage();
        const hash = `src=${encodeURIComponent(tickets.url)}&text=${encodeURIComponent(tickets.textUrl)}&name=report.pdf&size=${made.bytes}`;
        const t0 = Date.now();
        await page.goto(`${origin}/v3/pdf.html#${hash}`);
        const frame = page.mainFrame();
        await expect.poll(async () => { const d = await pdfDiag(frame); if (d?.state === "error") throw new Error(d.error); return d?.firstPageMs ?? -1; }, { timeout: 15_000, interval: 25 }).toBeGreaterThan(0);
        const navToPage1 = Date.now() - t0;
        const first = (await pdfDiag(frame))!;
        result.page1 = { navToPage1Ms: navToPage1, viewerMs: first.firstPageMs, bytesBeforePage1: first.bytesBeforeFirstPage, readsBeforePage1: first.readsBeforeFirstPage, size: first.size };
        expect(first.size).toBe(made.bytes);
        expect(first.pages).toBe(100);
        expect(navToPage1).toBeLessThan(2_000);
        expect(first.bytesBeforeFirstPage!).toBeLessThan(MiB);
        expect(first.fullRequests).toBe(0);
        await page.waitForTimeout(500);
        expect(log.length).toBeGreaterThan(0);
        expect(log.filter((e) => !e.range), JSON.stringify(log)).toEqual([]);
        expect(log.filter((e) => e.status !== undefined && e.status !== 206), JSON.stringify(log)).toEqual([]);
        result.ranges = log.map((e) => e.range);

        // Find a word of page 77 from B's text variant (through A).
        await frame.getByRole("button", { name: "Find" }).click();
        await frame.getByLabel("Find in this PDF").fill(FIND_WORD);
        const tFind = Date.now();
        await frame.getByLabel("Find in this PDF").press("Enter");
        await expect.poll(async () => (await pdfDiag(frame))?.find?.marked ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
        const found = (await pdfDiag(frame))!;
        expect(found.find).toMatchObject({ query: FIND_WORD, hits: 1, source: "text", at: { page: FIND_PAGE, nth: 0 } });
        expect(await frame.locator(`.page[data-page='${FIND_PAGE}'] mark.hit`).textContent()).toBe(FIND_WORD);
        result.find = { ms: Date.now() - tFind, source: found.find!.source, page: found.find!.at!.page };

        const csp = (await page.evaluate(async () => (await fetch("./pdf.html", { cache: "no-store" })).headers.get("content-security-policy"))) ?? "";
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toMatch(/unsafe-eval/);
        expect(await page.evaluate(() => (globalThis as { botling3Csp?: string[] }).botling3Csp ?? [])).toEqual([]);
        expect(foreign).toEqual([]);
        result.totalRead = { bytes: found.bytes, ofFile: Number((found.bytes / made.bytes).toFixed(3)) };
      } finally {
        await browser.close();
      }
    }, 120_000);
  }
});
