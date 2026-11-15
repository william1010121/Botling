// M2 step 14 (m2-brief §4 row 14): the page's service-worker content bridge on the relay path, in headless Chromium and
// headless WebKit (installed browsers only), against a real botlingd (fake engine, 127.0.0.1 only) whose device sessions
// ride a **locally started relay** (relay/src/main.ts on loopback, ALLOWED_ORIGINS = the page's origin; as step 13).
//
// The page is loaded through a loopback HTTP gate in front of botlingd that serves the page's own files and **refuses
// every `/v3/c/` request** (403, counted): the page's only way to the content is the relay session, as for a phone that
// reaches botlingd only through the relay. Per engine:
//
//  1. pair from the link with `?via=relay`; the shell registers /v3/sw.js (scope /v3/) and the worker takes the page;
//  2. a bot line shows a video (made with ffmpeg at test time): the chat frame shows its poster card; a tap opens the
//     page's player; the worker answers its range requests with `content.get` over the session → first frame (ms);
//  3. a seek past what is buffered: `seeked` (ms); the worker cancels the old read, the server logs `content.cancel`,
//     the next read starts at the seek point (no second download from 0);
//  4. a bot line shows a 100-page PDF (made at test time): a tap opens the viewer, page 1 in < 2 s by 256 KiB ranges
//     through the worker; bytes read before page 1 recorded;
//  5. the worker's scope is /v3/, Cache Storage holds no conversation content (only the shell's poster/thumbnail cache,
//     by hash: no `/v3/c/` response, no original or preview bytes), the worker script uses no storage;
//  6. no HTTP `/v3/c/` request reached the gate; `/mobile/` is not under the worker (404 from botlingd, no registration
//     covers it).
// Phone-width screenshots (video playing via relay, PDF page 1 via relay) go to V3_SHOT_DIR when set. Media are deleted.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/sw.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type BrowserType, type Frame, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { until } from "../../helpers";
import { LocalRelay, RelayMeter } from "../../support/local-relay";
import { makeTextPdf } from "../../support/make-pdf";
import { writeReport } from "../m1-accept";
import { chatOf, freePort, PairCli, phone, say, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const MiB = 1 << 20;
const dist = join(__dirname, "../../../web-v3/dist/sw.js");
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-14-sw", report); });

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** 40 s 720p H.264 at ~2 Mbit/s + AAC, index first, a keyframe every 2 s (≈ 10 MB): the original fits the relay's first guess. */
function makeVideo(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30,noise=alls=10:allf=t", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "40", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2M", "-minrate", "2M", "-maxrate", "2M", "-bufsize", "1M", "-x264-params", "nal-hrd=cbr",
    "-g", "60", "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}

/** The page's origin: botlingd's page files pass, every `/v3/c/` request is refused and counted. */
class Gate {
  readonly refused: string[] = [];
  private server: HttpServer | null = null;
  port = 0;
  constructor(private readonly upstream: number) {}
  get origin(): string { return `http://127.0.0.1:${this.port}`; }
  async start(port: number): Promise<this> {
    this.server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/v3/c/") || path === "/v3/c") {
        this.refused.push(`${req.method} ${path.replace(/([?&]t=)[^&]*/, "$1<ticket>")} ${req.headers.range ?? ""}`);
        res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("content goes through the relay session in this test\n");
        return;
      }
      const upstream = httpRequest({ host: "127.0.0.1", port: this.upstream, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${this.upstream}` } }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    this.server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

interface BridgeRead { variant: string; offset: number; length: number; bytes: number; ms: number; end: string; reason?: string }
interface PageDiag {
  player: { path: string };
  bridge: { state: string; scope?: string; error?: string; gets: number; cancels: number; bytes: number; gone: number; reads: BridgeRead[] };
  video: { opened: number; variant?: string; firstFrameMs?: number; seeks: Array<{ to: number; ms: number }>; switches: string[]; errors: number };
  media: Record<string, { state: string; url?: string; src?: string; variant?: string; poster?: string }>;
}
const pageDiag = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: unknown }).botling3Diagnostics)) as PageDiag);
interface PdfDiag { state: string; error?: string; size?: number; pages?: number; chunk: number; firstPageMs?: number; bytesBeforeFirstPage?: number; readsBeforeFirstPage?: number; reads: Array<{ start: number; end: number; bytes: number; ms: number }> }
const pdfDiag = (frame: Frame) => frame.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Pdf?: unknown }).botling3Pdf ?? null)) as PdfDiag | null);

async function startAll(root: string) {
  const relayPort = await freePort();
  const gatePort = await freePort();
  const gateOrigin = `http://127.0.0.1:${gatePort}`;
  // The relay checks the page's Origin: the gate's (where the page is loaded from).
  const relay = await new LocalRelay({ ALLOWED_ORIGINS: gateOrigin }, relayPort).ready();
  const meter = await new RelayMeter(() => relay.url).start();
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const server = new Server(dataDir, await freePort(), { BOTLING_SERVER_RELAY_URL: meter.url, BOTLING_SERVER_RELAY_BACKOFF_MS: "100,1000" });
  await server.ready();
  await until(() => server.daemon.log.includes("relay: room open"), { timeout: 20_000, what: "botlingd's room on the relay" });
  const gate = await new Gate(server.port).start(gatePort);
  return {
    relay, meter, server, dataDir, gate,
    async stop() {
      await gate.stop().catch(() => undefined);
      await server.stop().catch(() => undefined);
      await meter.stop().catch(() => undefined);
      await relay.stop().catch(() => undefined);
    },
  };
}

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `sw-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const video = join(root, "clip.mp4");
  makeVideo(video);
  const pdf = join(root, "report.pdf");
  const made = makeTextPdf(pdf, 100);
  result.media = { videoBytes: statSync(video).size, pdfBytes: made.bytes, pdfPages: made.pages };
  const all = await startAll(root);
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    browser = await phone(type, join(root, "profile"));
    const { page } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));

    // 1. Pair through the relay; the worker takes the page.
    const cli = new PairCli(all.dataDir);
    const link = await cli.link();
    await page.goto(`${all.gate.origin}/v3/?via=relay`);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await pageDiag(page)).bridge.state, { timeout: 15_000 }).toBe("ready");
    const registration = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return { scopes: regs.map((r) => new URL(r.scope).pathname), controller: navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : null };
    });
    expect(registration.scopes).toEqual(["/v3/"]);
    expect(registration.controller).toBe("/v3/sw.js");
    expect((await pageDiag(page)).player.path).toBe("relay");
    result.worker = { ...registration, scope: (await pageDiag(page)).bridge.scope };

    // 2. The video: poster card in the chat, a tap opens the page's player, first frame through the worker.
    await say(page, `/say The clip: ![clip](${pathToFileURL(video).href})`);
    const card = chatOf(page).locator("[data-testid='media-poster']").first();
    await card.waitFor({ timeout: 60_000 });
    await expect.poll(async () => Object.values((await pageDiag(page)).media).find((m) => m.state === "ready" && m.src?.includes("sw=1"))?.poster ?? "", { timeout: 30_000 }).not.toBe("");
    const before = (await pageDiag(page)).bridge.gets;
    const tTap = Date.now();
    await card.click();
    const player = page.locator("[data-testid='video-player'] video");
    await player.waitFor({ timeout: 10_000 });
    await expect.poll(async () => (await pageDiag(page)).video.firstFrameMs ?? -1, { timeout: 20_000, interval: 25 }).toBeGreaterThan(0);
    const tapToFirstFrame = Date.now() - tTap;
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
    const playing = await player.evaluate((v: HTMLVideoElement) => ({ paused: v.paused, width: v.videoWidth, src: v.getAttribute("src")?.replace(/([?&]t=)[^&]*/, "$1<ticket>") ?? "", buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 }));
    expect(playing.paused).toBe(false);
    expect(playing.width).toBe(1280);
    expect(playing.src).toMatch(/^\/v3\/c\/.+&sw=1$/);
    const d1 = await pageDiag(page);
    result.video = { tapToFirstFrameMs: tapToFirstFrame, playerFirstFrameMs: d1.video.firstFrameMs, variant: d1.video.variant, bufferedAtCheckS: Number(playing.buffered.toFixed(1)) };
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `video-relay-${engine}.png`) }); }

    // 3. Seek past what is buffered: the old read is cancelled (the server logs it), the next starts near the seek point.
    const readsBeforeSeek = d1.bridge.reads.length;
    const cancelLinesBefore = all.server.daemon.log.split("content: cancel").length - 1;
    const target = 34;
    const buffered = await player.evaluate((v: HTMLVideoElement) => (v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0));
    result.seek = { bufferedBeforeSeekS: Number(buffered.toFixed(1)), to: target };
    await player.evaluate((v: HTMLVideoElement, to: number) => { v.currentTime = to; }, target);
    await expect.poll(async () => (await pageDiag(page)).video.seeks.length, { timeout: 20_000, interval: 25 }).toBeGreaterThan(0);
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(target + 0.3);
    await until(() => all.server.daemon.log.split("content: cancel").length - 1 > cancelLinesBefore || null, { timeout: 15_000, what: "content.cancel in the server's log" });
    const d2 = await pageDiag(page);
    const afterSeek = d2.bridge.reads.slice(readsBeforeSeek).filter((r) => r.variant === "original" || r.variant === "preview");
    const cancelLines = all.server.daemon.log.split("\n").filter((l) => l.includes("content: cancel")).map((l) => l.replace(/^\S+\s+/, "").replace(/ from \S+/, " from <device>"));
    result.seek = {
      ...(result.seek as object), seekedMs: d2.video.seeks[0]!.ms, cancelsAtWorker: d2.bridge.cancels, serverCancelLines: cancelLines.length, serverCancelSample: cancelLines.slice(0, 3),
      readsAfterSeek: afterSeek.slice(0, 6).map((r) => `${r.variant} ${r.offset}+${r.length === Number.MAX_SAFE_INTEGER ? "end" : r.length} → ${r.bytes} B, ${r.end}`),
    };
    expect(cancelLines.length).toBeGreaterThan(0);
    expect(afterSeek.length).toBeGreaterThan(0);
    // No second download from 0: every read after the seek starts past the first MiB (the index sits at the start, read once).
    expect(afterSeek.every((r) => r.offset > MiB), JSON.stringify(afterSeek.map((r) => r.offset))).toBe(true);
    expect(d2.video.errors).toBe(0);
    result.videoReads = { total: d2.bridge.reads.length - before, bytes: d2.bridge.bytes };
    await page.locator("[data-testid='video-player'] .v3-video-close").click();
    await expect.poll(() => page.locator("[data-testid='video-player']").count()).toBe(0);

    // 4. The PDF: page 1 in < 2 s by 256 KiB ranges, through the worker.
    await say(page, `/say The report: ![report](${pathToFileURL(pdf).href})`);
    const opener = chatOf(page).locator("img[data-botling3-open], [data-testid='media-card'][data-botling3-open]").last();
    await opener.waitFor({ timeout: 60_000 });
    const pdfReadsFrom = (await pageDiag(page)).bridge.reads.length;
    const tPdf = Date.now();
    await opener.click();
    await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/pdf.html")), { timeout: 15_000 }).toBe(true);
    const viewer = page.frames().find((f) => f.url().includes("/v3/pdf.html"))!;
    await expect.poll(async () => { const d = await pdfDiag(viewer); if (d?.state === "error") throw new Error(d.error); return d?.firstPageMs ?? -1; }, { timeout: 15_000, interval: 25 }).toBeGreaterThan(0);
    const tapToPage1 = Date.now() - tPdf;
    const first = (await pdfDiag(viewer))!;
    const viewerControlled = await viewer.evaluate(() => !!navigator.serviceWorker?.controller);
    const pdfReads = (await pageDiag(page)).bridge.reads.slice(pdfReadsFrom).filter((r) => r.variant === "original");
    result.pdf = {
      tapToPage1Ms: tapToPage1, viewerNavToPage1Ms: first.firstPageMs, bytesBeforePage1: first.bytesBeforeFirstPage, readsBeforePage1: first.readsBeforeFirstPage,
      chunk: first.chunk, pages: first.pages, size: first.size, viewerControlled, workerReads: pdfReads.length, workerReadLengths: [...new Set(pdfReads.map((r) => r.length))],
    };
    expect(first.size).toBe(made.bytes);
    expect(first.pages).toBe(100);
    expect(first.chunk).toBe(256 * 1024);
    expect(viewerControlled).toBe(true);
    expect(pdfReads.length).toBeGreaterThan(0);
    expect(tapToPage1).toBeLessThan(2_000);
    expect(first.bytesBeforeFirstPage!).toBeLessThan(2 * MiB);
    if (SHOTS) {
      await expect.poll(async () => (await pdfDiag(viewer))?.state ?? "", { timeout: 5_000 }).not.toBe("loading");
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(SHOTS, `pdf-relay-${engine}.png`) });
    }

    // 5. No conversation content cached: Cache Storage holds only the shell's poster/thumbnail cache, by hash.
    const cached = await page.evaluate(async () => {
      const out: Record<string, Array<{ url: string; bytes: number }>> = {};
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        out[name] = [];
        for (const request of await cache.keys()) { const r = await cache.match(request); out[name].push({ url: new URL(request.url).pathname, bytes: r ? (await r.arrayBuffer()).byteLength : 0 }); }
      }
      return out;
    });
    const sw = await page.evaluate(() => new Promise<unknown>((resolve) => {
      const channel = (event: MessageEvent) => { if ((event.data as { botling3?: string })?.botling3 === "sw.pong") { navigator.serviceWorker.removeEventListener("message", channel); resolve(event.data); } };
      navigator.serviceWorker.addEventListener("message", channel);
      navigator.serviceWorker.controller!.postMessage({ botling3: "sw.ping" });
      setTimeout(() => resolve(null), 3_000);
    }));
    result.cacheStorage = Object.fromEntries(Object.entries(cached).map(([name, items]) => [name, { items: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) }]));
    result.workerCounts = (sw as { counts?: unknown } | null)?.counts ?? null;
    expect(Object.keys(cached).every((name) => name === "botling3-content")).toBe(true);
    const items = Object.values(cached).flat();
    expect(items.some((i) => i.url.includes("/v3/c/"))).toBe(false);
    // Posters and thumbnails only (each ≤ 2 MB), never the clip or the PDF.
    expect(items.every((i) => i.bytes <= 2 * MiB)).toBe(true);
    expect(items.reduce((n, i) => n + i.bytes, 0)).toBeLessThan(1 * MiB);

    // 5b. A refusal through the worker: the clip's URL naming an entry that does not reference it (seq 1). The server
    // refuses the read (`denied`); the worker answers 404 as the server would, and WebKit's media loader (its requests
    // carry X-Playback-Session-Id + Range) gets the empty 200 with X-Botling-Status (step 11).
    const clipSrc = Object.values((await pageDiag(page)).media).find((m) => m.src?.includes("sw=1") && m.variant)!.src!;
    const wrong = clipSrc.replace(/([?&]e=[^&]*\.)\d+/, "$11");
    expect(wrong).not.toBe(clipSrc);
    const refusals = await page.evaluate(async (url) => {
      const plain = await fetch(url, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
      const loader = await fetch(url, { headers: { Range: "bytes=0-1", "X-Playback-Session-Id": "TEST" }, cache: "no-store" });
      return {
        plain: { status: plain.status, why: plain.headers.get("x-botling-content") },
        loader: { status: loader.status, botlingStatus: loader.headers.get("x-botling-status"), bytes: (await loader.arrayBuffer()).byteLength },
      };
    }, wrong);
    result.refusals = refusals;
    expect(refusals.plain).toEqual({ status: 404, why: "gone; reason=denied" });
    expect(refusals.loader).toEqual({ status: 200, botlingStatus: "404", bytes: 0 });

    // 6. Nothing reached botlingd over HTTP for content; /mobile/ is not under the worker.
    result.httpContentRequests = all.gate.refused.length;
    expect(all.gate.refused).toEqual([]);
    expect(sockets.filter((url) => url.includes("/v3/ws"))).toEqual([]);
    const mobile = await page.evaluate(async () => {
      const response = await fetch("/mobile/", { cache: "no-store" });
      const reg = await navigator.serviceWorker.getRegistration("/mobile/");
      return { status: response.status, registration: reg ? new URL(reg.scope).pathname : null };
    });
    result.mobile = mobile;
    expect(mobile.registration).toBeNull();
    expect(mobile.status).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await all.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(dist) || spawnSync("ffmpeg", ["-version"]).status !== 0)("M2 step 14: the service-worker content bridge (local relay)", () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: video plays and seeks, a 100-page PDF opens at page 1, through the worker and the relay session only`, () => run(engine, type), 300_000);
  }
});
