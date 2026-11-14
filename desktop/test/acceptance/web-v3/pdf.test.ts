// M2 step 15 (m2-brief §4 row 15, tailnet path): the pdf.js viewer and the owner's PDF text job, in headless Chromium and
// headless WebKit (installed browsers only) against a real botlingd (fake engine, loopback listener on 127.0.0.1 only,
// the built page web-v3/dist). Per engine, one script:
//
//  1. pair (as step 8); a bot line shows a 100-page PDF made at test time (not linearized, ≈ 4 MB);
//  2. the owner's text job: `content.text{id, pages: 100, textId}` in the bot's log, and the page's answer carries the
//     text variant's URL;
//  3. a tap on the PDF in the chat opens the viewer over the page: page 1 is drawn in < 2 s, with range requests only
//     (every read of the file has a Range header, none is a whole-file 200) and < 1 MiB read before page 1;
//  4. the viewer ran under the page's CSP (`script-src 'self'`, pdf.js's worker from /v3/): no CSP violation, no request
//     to any other origin;
//  5. the text layer selects (a mouse drag over a line gives its text) and finds (a word only page 77 holds: the hit is
//     marked on page 77, from the owner's prepared text); the contents list jumps to its chapter;
//  6. ✕ closes the viewer.
// Phone-width screenshots (page 1, the find hit) go to V3_SHOT_DIR when set. The PDF is deleted afterwards.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/pdf.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type BrowserType, type Frame, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { writeReport } from "../m1-accept";
import { FIND_PAGE, FIND_WORD, makeTextPdf } from "../../support/make-pdf";
import { chatOf, freePort, PairCli, phone, say, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const MiB = 1 << 20;
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-15-pdf", report); });

interface Logged { url: string; range: string | null; status?: number; bytes?: number }
interface PdfDiag {
  state: string; error?: string; size?: number; pages?: number; chunk: number; reads: Array<{ start: number; end: number; bytes: number; ms: number; at: number }>; bytes: number;
  firstPageMs?: number; bytesBeforeFirstPage?: number; readsBeforeFirstPage?: number; rendered: number[]; textLayers: number[];
  find?: { query: string; hits: number; source: string; at?: { page: number; nth: number }; marked: number }; outline?: number; fullRequests: number; zoom?: number;
}

async function viewerFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/pdf.html")), { timeout: 15_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/v3/pdf.html"))!;
}
const pdfDiag = (frame: Frame) => frame.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Pdf?: unknown }).botling3Pdf ?? null)) as PdfDiag | null);

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `pdf-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pdf = join(root, "report.pdf");
  const made = makeTextPdf(pdf, 100);
  result.pdf = { bytes: made.bytes, pages: made.pages };
  expect(made.bytes).toBeGreaterThan(2 * MiB);
  const server = new Server(dataDir, await freePort());
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    await server.ready();
    browser = await phone(type, join(root, "profile"));
    const { page, context } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // Every frame records CSP violations (the viewer must have none).
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const list = ((globalThis as { botling3Csp?: string[] }).botling3Csp ??= []);
        list.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const foreign: string[] = [];
    const log: Logged[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(server.origin) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:")) foreign.push(url);
      if (!url.includes("/v3/c/") || !url.includes("/original?")) return;
      const entry: Logged = { url: url.replace(/([?&]t=)[^&]*/, "$1<ticket>"), range: null };
      log.push(entry);
      void request.headerValue("range").then((range) => { entry.range = range; }, () => undefined);
      void request.response().then((response) => { if (response) entry.status = response.status(); }, () => undefined);
    });
    context.on("requestfinished", (request) => {
      if (!request.url().includes("/original?")) return;
      const key = request.url().replace(/([?&]t=)[^&]*/, "$1<ticket>");
      const entry = log.find((e) => e.url === key && e.bytes === undefined);
      if (entry) void request.sizes().then((sizes) => { entry.bytes = sizes.responseBodySize; }, () => undefined);
    });

    // 1. Pair, then the bot's line with the PDF.
    const cli = new PairCli(dataDir);
    const link = await cli.link();
    await page.goto(server.page);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    const tLine = Date.now();
    await say(page, `/say The report: ![report](${pathToFileURL(pdf).href})`);

    // 2. The owner's text job: the page's answer gets the text variant's URL; the log has content.text.
    const diagMedia = () => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: { media?: unknown } }).botling3Diagnostics?.media ?? {})) as Record<string, { state: string; url?: string; textUrl?: string; opened?: number }>);
    const mine = async () => Object.entries(await diagMedia()).find(([key]) => key.endsWith("report.pdf"))?.[1];
    await expect.poll(async () => (await mine())?.textUrl ?? "", { timeout: 90_000 }).toMatch(/^\/v3\/c\/.+\/text\?/);
    result.textReadyMs = Date.now() - tLine;
    const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      const rows = db.prepare("SELECT body FROM entries WHERE kind = 'content.text'").all() as Array<{ body: string }>;
      expect(rows).toHaveLength(1);
      const body = JSON.parse(rows[0]!.body) as { id: string; pages: number; textId: string };
      expect(body.pages).toBe(100);
      expect(body.textId).toMatch(/^sha256:[0-9a-f]{64}$/);
      result.contentText = { pages: body.pages, textId: `${body.textId.slice(0, 15)}…` };
    } finally { db.close(); }
    expect(log, "the file is not read before the viewer opens").toEqual([]);

    // 3. Tap the PDF in the chat: the viewer opens over the page; page 1 within 2 s, by ranges only.
    const opener = chatOf(page).locator("[data-botling3-open]").first();
    await opener.waitFor({ timeout: 30_000 });
    result.opener = await opener.evaluate((el) => (el.tagName === "IMG" ? "thumbnail" : "card"));
    const tTap = Date.now();
    await opener.click();
    const frame = await viewerFrame(page);
    await expect.poll(async () => { const d = await pdfDiag(frame); if (d?.state === "error") throw new Error(d.error); return d?.firstPageMs ?? -1; }, { timeout: 10_000, interval: 25 }).toBeGreaterThan(0);
    const tapToPage1 = Date.now() - tTap;
    const first = (await pdfDiag(frame))!;
    result.page1 = {
      tapToPage1Ms: tapToPage1, viewerNavToPage1Ms: first.firstPageMs, bytesBeforePage1: first.bytesBeforeFirstPage, readsBeforePage1: first.readsBeforeFirstPage,
      size: first.size, chunk: first.chunk, readsBefore: first.reads.slice(0, first.readsBeforeFirstPage).map((r) => `${r.start}-${r.end} (${r.ms} ms)`),
    };
    expect(first.size).toBe(made.bytes);
    expect(first.pages).toBe(100);
    expect(tapToPage1).toBeLessThan(2_000);
    expect(first.bytesBeforeFirstPage!).toBeLessThan(MiB);
    expect(first.fullRequests).toBe(0);
    await page.waitForTimeout(800);
    // Range requests only: every read of the file (as the network saw it) had a Range header and got a 206.
    expect(log.length).toBeGreaterThan(0);
    expect(log.filter((e) => !e.range), JSON.stringify(log)).toEqual([]);
    expect(log.filter((e) => e.status !== undefined && e.status !== 206), JSON.stringify(log)).toEqual([]);
    const netBefore = log.slice(0, first.readsBeforeFirstPage).reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    result.network = { requests: log.length, bytesBeforePage1: netBefore, ranges: log.map((e) => e.range) };
    expect(netBefore).toBeLessThan(MiB);
    await frame.locator(".page[data-page='1'] .textLayer span").first().waitFor({ timeout: 10_000 });
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `page1-${engine}.png`) });
    }

    // 4. Under the page's CSP: the header, no violation, nothing from another origin.
    const csp = await page.evaluate(async () => (await fetch("./pdf.html", { cache: "no-store" })).headers.get("content-security-policy"));
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval/);
    result.csp = csp;
    expect(await frame.evaluate(() => (globalThis as { botling3Csp?: string[] }).botling3Csp ?? [])).toEqual([]);
    expect(foreign).toEqual([]);

    // 5a. Zoom in (at the phone's width a Letter page's body text is ≈ 6 px; Chromium's mouse selection misses on text
    // that small, see the step 15 evidence), then the text layer selects: a mouse drag over the third line of page 1.
    await frame.getByRole("button", { name: "Zoom in" }).click();
    await frame.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => (await pdfDiag(frame))?.zoom).toBe(2);
    const line = frame.locator(".page[data-page='1'] .textLayer span", { hasText: "Line 3 of page 1:" }).first();
    await line.waitFor({ timeout: 10_000 });
    await line.scrollIntoViewIfNeeded();
    const box = (await line.boundingBox())!;
    const fontPx = await line.evaluate((el) => el.getBoundingClientRect().height);
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(Math.min(box.x + box.width - 2, 385), box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const selected = await frame.evaluate(() => String(getSelection()));
    result.selected = { text: selected, zoom: 2, lineHeightPx: Number(fontPx.toFixed(1)) };
    expect(selected).toContain("Line 3 of page");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `select-${engine}.png`) });
    await frame.getByRole("button", { name: "Zoom out" }).click();
    await frame.getByRole("button", { name: "Zoom out" }).click();
    await expect.poll(async () => (await pdfDiag(frame))?.zoom).toBe(1);

    // 5b. Find: a word only page 77 holds (from the owner's prepared text), marked in page 77's text layer.
    const bytesBeforeFind = (await pdfDiag(frame))!.bytes;
    await frame.getByRole("button", { name: "Find" }).click();
    await frame.getByLabel("Find in this PDF").fill(FIND_WORD);
    const tFind = Date.now();
    await frame.getByLabel("Find in this PDF").press("Enter");
    await expect.poll(async () => (await pdfDiag(frame))?.find?.marked ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    const found = (await pdfDiag(frame))!;
    expect(found.find).toMatchObject({ query: FIND_WORD, hits: 1, source: "text", at: { page: FIND_PAGE, nth: 0 } });
    const mark = frame.locator(`.page[data-page='${FIND_PAGE}'] mark.hit`);
    expect(await mark.textContent()).toBe(FIND_WORD);
    await expect.poll(() => mark.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    expect(await frame.locator("#find-count").textContent()).toBe("1 / 1");
    result.find = { ms: Date.now() - tFind, source: found.find!.source, page: found.find!.at!.page, bytesReadForFind: found.bytes - bytesBeforeFind };
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `find-${engine}.png`) });

    // 5c. The contents list (the owner's outline) jumps to its chapter.
    await frame.getByRole("button", { name: "Contents" }).click();
    await frame.getByRole("button", { name: "Chapter 50" }).click();
    await expect.poll(() => frame.locator("#page-no").textContent(), { timeout: 10_000 }).toMatch(/^(49|50|51) \/ 100$/);
    await expect.poll(async () => (await pdfDiag(frame))?.rendered.includes(50) ?? false, { timeout: 10_000 }).toBe(true);
    const end = (await pdfDiag(frame))!;
    result.outline = { items: end.outline, pageNo: await frame.locator("#page-no").textContent() };
    result.totalRead = { bytes: end.bytes, ofFile: Number((end.bytes / made.bytes).toFixed(3)), reads: end.reads.length, rendered: end.rendered.length };
    expect(end.bytes).toBeLessThan(made.bytes);

    // 6. ✕ closes the viewer.
    await frame.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => page.locator("iframe[data-testid='pdf-viewer']").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M2 step 15: the PDF viewer and the PDF text job (tailnet path)", () => {
  for (const [engine, type] of ENGINES) it(`${engine}: page 1 by ranges in < 2 s, text layer selects and finds, the owner's text`, () => run(engine, type), 600_000);
});
