// M2 step 9: content over the tailnet, in headless Chromium and headless WebKit against a real botlingd (fake engine,
// loopback listener on 127.0.0.1 only, the built page web-v3/dist). Per engine, one script:
//
//  1. pair by pasted link + code (as step 8);
//  2. the bot's line shows a video (`![clip](file:///…/clip.mp4)`, > 64 MiB on another volume than the data folder, so
//     its pin is `pin: path` with chunk hashes): the chat frame's <video> gets a ticketed `/v3/c/…` URL, plays (the
//     `loadeddata` first-frame event, then `playing`), and seeks (`seeked`), with the request log showing no second
//     download from byte 0;
//  3. a PDF the line shows: its `/v3/c/…` URL answers byte ranges (head, the trailer by suffix, a middle range) with
//     the file's own bytes, as pdf.js will ask for them;
//  4. the video file is rewritten in place: the old line shows "This file changed after this message.", and no
//     `/v3/c/` answer after the rewrite is a 2xx (never the new bytes).
// Test media are made at test time (ffmpeg) and deleted afterwards. A phone-width screenshot of the playing video goes
// to V3_SHOT_DIR when set.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/content.test.ts
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type BrowserType, type Frame, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import { chatOf, PairCli, phone, say, Server, freePort } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const dist = join(desktop, "web-v3", "dist");
const MiB = 1 << 20;
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-9-content", report); });

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** A ~70 MiB 720p H.264 + AAC clip (faststart, keyframe every 2 s): above the 64 MiB copy limit, so `pin: path`. */
function makeVideo(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "40", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "14M", "-maxrate", "14M", "-bufsize", "28M", "-g", "60",
    "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}

/** A small valid PDF of a few pages (text only), written by hand: xref offsets computed here. */
function makePdf(file: string, pages = 12): void {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 24 Tf 72 720 Td (Botling 3 test page ${i + 1}) Tj ET ${"q 0.9 g 72 100 400 500 re f Q ".repeat(200)}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(file, out, "latin1");
}

async function chatFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/chat.html")), { timeout: 30_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/v3/chat.html"))!;
}

interface Logged { at: number; url: string; range: string | null; status?: number; contentRange?: string | null; bytes?: number; botlingStatus?: string | null }

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `content-${engine}-`));
  // The media on the internal disk, the data folder on the work disk: no APFS clone, and the video is above the copy
  // limit, so its pin is `pin: path` (M1 content.test.ts does the same).
  const mediaDir = mkdtempSync(join(tmpdir(), `botling3-media-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const video = join(mediaDir, "clip.mp4");
  const pdf = join(mediaDir, "doc.pdf");
  const t0 = Date.now();
  makeVideo(video);
  makePdf(pdf);
  const size = statSync(video).size;
  result.media = { videoBytes: size, pdfBytes: statSync(pdf).size, madeMs: Date.now() - t0 };
  expect(size).toBeGreaterThan(64 * MiB);
  const server = new Server(dataDir, await freePort());
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    await server.ready();
    browser = await phone(type, join(root, "profile"));
    const { page, context } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const log: Logged[] = [];
    context.on("request", (request) => {
      if (!request.url().includes("/v3/c/")) return;
      const entry: Logged = { at: Date.now(), url: request.url().replace(/([?&]t=)[^&]*/, "$1<ticket>"), range: null };
      log.push(entry);
      void request.headerValue("range").then((range) => { entry.range = range; }, () => undefined);
      void request.response().then(async (response) => {
        if (!response) return;
        entry.status = response.status();
        entry.contentRange = await response.headerValue("content-range").catch(() => null);
        entry.botlingStatus = await response.headerValue("x-botling-status").catch(() => null);
      }, () => undefined);
    });
    context.on("requestfinished", (request) => {
      const entry = [...log].reverse().find((e) => e.url === request.url().replace(/([?&]t=)[^&]*/, "$1<ticket>") && e.bytes === undefined);
      if (entry) void request.sizes().then((sizes) => { entry.bytes = sizes.responseBodySize; }, () => undefined);
    });

    // 1. Pair.
    const cli = new PairCli(dataDir);
    const link = await cli.link();
    await page.goto(server.page);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });

    // 2. A line with the video: it plays and seeks.
    const videoUrl = pathToFileURL(video).href;
    await say(page, `/say Here is the clip: ![clip](${videoUrl})`);
    const frame = await chatFrame(page);
    const tAsk = Date.now();
    await expect.poll(() => frame.evaluate(() => document.querySelector("video.media")?.getAttribute("src") ?? ""), { timeout: 60_000 }).toMatch(/^\/v3\/c\//);
    const src = await frame.evaluate(() => document.querySelector("video.media")!.getAttribute("src")!);
    expect(src).toMatch(/^\/v3\/c\/[^/]+\/sha256%3A[0-9a-f]{64}\/original\?e=bot%3A[^&]+\.[0-9]+&t=[A-Za-z0-9_-]{43}$/);
    const urlMs = Date.now() - tAsk;
    const play = await frame.evaluate(() => new Promise<{ loadeddataMs: number; playingMs: number; width: number; error?: string }>((resolve) => {
      const v = document.querySelector("video.media") as HTMLVideoElement;
      const start = performance.now();
      const out = { loadeddataMs: -1, playingMs: -1, width: 0 } as { loadeddataMs: number; playingMs: number; width: number; error?: string };
      const done = () => { if (out.loadeddataMs >= 0 && out.playingMs >= 0) { out.width = v.videoWidth; resolve(out); } };
      if (v.readyState >= 2) out.loadeddataMs = 0;
      v.addEventListener("loadeddata", () => { out.loadeddataMs = performance.now() - start; done(); });
      v.addEventListener("playing", () => { out.playingMs = performance.now() - start; done(); });
      v.addEventListener("error", () => resolve({ ...out, error: String(v.error?.code) }));
      v.muted = true;
      void v.play().catch((error) => resolve({ ...out, error: String(error) }));
      setTimeout(() => resolve({ ...out, error: "timeout" }), 30_000);
    }));
    expect(play.error, JSON.stringify(play)).toBeUndefined();
    expect(play.width).toBe(1280);
    await page.waitForTimeout(1_500);
    if (SHOTS && engine === "chromium") {
      mkdirSync(SHOTS, { recursive: true });
      await chatOf(page).locator("video.media").scrollIntoViewIfNeeded();
      // The user's line shows the clip's temp path: masked (no machine paths in evidence).
      await page.screenshot({ path: join(SHOTS, "video-playing.png"), mask: [chatOf(page).locator("#messages .row").filter({ hasText: "/say" })] });
    }
    const beforeSeek = log.length;
    const seek = await frame.evaluate(() => new Promise<{ seekedMs: number; time: number; error?: string }>((resolve) => {
      const v = document.querySelector("video.media") as HTMLVideoElement;
      const start = performance.now();
      v.addEventListener("seeked", () => resolve({ seekedMs: performance.now() - start, time: v.currentTime }), { once: true });
      v.currentTime = 30;
      setTimeout(() => resolve({ seekedMs: -1, time: v.currentTime, error: "timeout" }), 30_000);
    }));
    expect(seek.error, JSON.stringify(seek)).toBeUndefined();
    expect(seek.time).toBeGreaterThan(29);
    await page.waitForTimeout(1_000);
    const afterSeek = log.slice(beforeSeek);
    const fromZero = (e: Logged) => e.range === null || /^bytes=0-/.test(e.range);
    // The seek reads from the target onwards, never the whole file again.
    expect(afterSeek.length, JSON.stringify(log)).toBeGreaterThan(0);
    expect(afterSeek.filter(fromZero), JSON.stringify(afterSeek)).toEqual([]);
    expect(afterSeek.some((e) => Number(/^bytes=(\d+)-/.exec(e.range ?? "")?.[1] ?? 0) > size / 2), JSON.stringify(afterSeek)).toBe(true);
    expect(log.every((e) => e.status === undefined || e.status === 206 || e.status === 200), JSON.stringify(log)).toBe(true);
    result.video = { urlMs, play, seek, requests: log.map(({ range, status, contentRange, bytes }) => ({ range, status, contentRange, bytes })) };

    // 3. A PDF's byte ranges, through its ticketed URL (what pdf.js will read).
    await say(page, `/say The report: ![doc](${pathToFileURL(pdf).href})`);
    // The line itself shows the page-1 thumbnail (step 11); the file's own ticketed URL is the answer's `url`.
    const diagMedia = () => page.evaluate(() => (globalThis as { botling3Diagnostics?: { media: Record<string, { state: string; url?: string }> } }).botling3Diagnostics?.media ?? {});
    await expect.poll(async () => Object.entries(await diagMedia()).find(([key, v]) => key.endsWith("doc.pdf") && v.state === "ready")?.[1].url ?? "", { timeout: 60_000 }).toMatch(/^\/v3\/c\//);
    const pdfSrc = Object.entries(await diagMedia()).find(([key]) => key.endsWith("doc.pdf"))![1].url!;
    const pdfBytes = readFileSync(pdf);
    const ranges = [`bytes=0-1023`, `bytes=-1024`, `bytes=${Math.floor(pdfBytes.length / 2)}-${Math.floor(pdfBytes.length / 2) + 65_535}`];
    const pdfAnswers = await page.evaluate(async ({ url, ranges }) => Promise.all(ranges.map(async (range) => {
      const response = await fetch(url, { headers: { range } });
      const body = new Uint8Array(await response.arrayBuffer());
      return { range, status: response.status, contentRange: response.headers.get("content-range"), type: response.headers.get("content-type"), bytes: Array.from(body) };
    })), { url: pdfSrc, ranges });
    const expected = [pdfBytes.subarray(0, 1024), pdfBytes.subarray(pdfBytes.length - 1024), pdfBytes.subarray(Math.floor(pdfBytes.length / 2), Math.floor(pdfBytes.length / 2) + 65_536)];
    pdfAnswers.forEach((answer, i) => {
      expect(answer.status, answer.range).toBe(206);
      expect(answer.type).toBe("application/pdf");
      expect(Buffer.from(answer.bytes).equals(expected[i]!), answer.range).toBe(true);
    });
    result.pdf = pdfAnswers.map(({ range, status, contentRange, bytes }) => ({ range, status, contentRange, bytes: bytes.length }));

    // 4. The video is rewritten in place (a bot rendering it again): the old line says it changed, never new bytes.
    const fd = openSync(video, "r+");
    writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, 0);
    writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, Math.floor(size * 0.8));
    closeSync(fd);
    const rewrittenAt = Date.now();
    // The player reads again where it has nothing buffered: a seek there (or, when it holds the whole clip, a reload).
    const target = await frame.evaluate(() => {
      const v = document.querySelector("video.media") as HTMLVideoElement | null;
      if (!v) return null;
      const buffered = (t: number) => { for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true; return false; };
      for (let t = 1; t < v.duration - 1; t += 0.5) if (!buffered(t)) { v.currentTime = t; return t; }
      return null;
    });
    let changedFrame = frame;
    if (target === null) { await page.reload(); changedFrame = await chatFrame(page); }
    await expect.poll(() => changedFrame.evaluate(() => document.querySelector("[data-testid=media-changed]")?.textContent ?? "").catch(() => ""), { timeout: 60_000 }).toBe("This file changed after this message.");
    await page.waitForTimeout(500);
    // The video's reads (the shell may fetch the PDF's page-1 thumbnail meanwhile, step 11).
    const videoPath = src.split("?")[0]!;
    const afterRewrite = log.filter((e) => e.at >= rewrittenAt && new URL(e.url).pathname === videoPath);
    // A refusal of WebKit's media loader is an empty 200 that says the real status (step 11: a 4xx makes it retry in a
    // loop); never bytes.
    expect(afterRewrite.filter((e) => e.status !== undefined && e.status >= 200 && e.status < 300 && !(e.botlingStatus && e.contentRange === null)), JSON.stringify(afterRewrite)).toEqual([]);
    const hidden = await changedFrame.evaluate(() => { const v = document.querySelector("video.media") as HTMLVideoElement | null; return { hidden: !!v && v.hidden && getComputedStyle(v).display === "none", src: v?.getAttribute("src") ?? null }; });
    expect(hidden).toEqual({ hidden: true, src: null });
    result.changed = { how: target === null ? "reload (the whole clip was buffered)" : `seek to ${target} s (not buffered)`, msAfterRewrite: Date.now() - rewrittenAt, requestsAfter: afterRewrite.map(({ range, status, botlingStatus }) => ({ range, status, ...(botlingStatus ? { botlingStatus } : {}) })) };
    if (SHOTS && engine === "chromium") await page.screenshot({ path: join(SHOTS, "video-changed.png"), mask: [chatOf(page).locator("#messages .row").filter({ hasText: "/say" })] });
    result.pageErrors = errors;
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    rmSync(mediaDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(dist) || spawnSync("ffmpeg", ["-version"]).status !== 0)("M2 step 9: content over the tailnet (headless)", () => {
  for (const [engine, type] of ENGINES) it(`${engine}: a line's video plays and seeks, a PDF's ranges load, a rewritten file shows changed`, () => run(engine, type), 600_000);
});
