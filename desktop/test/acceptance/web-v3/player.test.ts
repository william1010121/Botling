// M2 step 11: the page's content cache and player rules, in headless Chromium and headless WebKit against a real
// botlingd (fake engine, loopback listener, the built page web-v3/dist). The page is reached through a small TCP proxy
// in this file, which can throttle what the server sends (both engines; Playwright's own throttling is Chromium-only)
// and counts the `/v3/c/` requests it forwards. Per engine, one script:
//
//  1. pair by pasted link + code (as step 8); the page's cache cap is lowered (`botling3ContentCapBytes`);
//  2. "preparing": a 4 GiB (sparse) "video" takes seconds to hash; its line shows "<name> · preparing" until
//     `content.ready`; its bytes (zeros) do not play: one more try, then a note (two loads: Chromium 1 request each,
//     WebKit 3); a recorder in the chat frame checks that no media element is ever shown broken (visible with a
//     placeholder or no source) in the whole run;
//  3. a 4 Mbit/s 720p video: the poster (cached by hash) with its duration and size; the original plays by the 1.5×
//     rule; with the proxy throttled to 2 Mbit/s it switches to the preview at the same position, with a note: in
//     Chromium after two stalls, in WebKit (which holds the start instead of stalling) by the slow-start rule;
//     the same video in a new line then starts on the preview (the rule, on the measured rate);
//  4. small images by hash: after a reload the poster and the image come from the cache (no request); above the
//     lowered cap the least recently used go;
//  5. a 410: a > 64 MiB clip (pin: path) is rewritten while it plays; after a seek the server refuses; at most 3
//     requests reach it, and the line says the file changed;
//  6. the cache is deleted on sign-out ("This device" › Forget) and on unpairing / a revocation notice from the
//     computer (`revoke-device` while connected: `bye{revoked}`).
// Test media are made at test time (ffmpeg) under the work disk's tmp (the > 64 MiB clip on the internal disk, as in
// step 9) and deleted afterwards. Phone-width screenshots go to V3_SHOT_DIR when set.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/player.test.ts
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer, connect, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium, webkit, type BrowserType, type Frame, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { botlingdCommand } from "../../botlingd-harness";
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
afterAll(() => { writeReport("step-11-player", report); });

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** 30 s 720p H.264 at a constant ~4 Mbit/s + AAC (faststart, keyframe every 2 s): the §9A.5 rule makes a preview. */
function makeVideo(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30,noise=alls=12:allf=t", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4M", "-minrate", "4M", "-maxrate", "4M", "-bufsize", "2M", "-x264-params", "nal-hrd=cbr",
    "-g", "60", "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}

/** A ~70 MiB clip as in step 9: above the 64 MiB copy limit, so `pin: path`, and rewritable under its line. */
function makeBigVideo(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "40", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "14M", "-maxrate", "14M", "-bufsize", "28M", "-g", "60",
    "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}

/** A PNG of noise (does not compress): about `side`² × 3 bytes. */
function makeImage(file: string, side: number, seed: number): void {
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x${(0x305070 + seed * 0x101010).toString(16)}:s=${side}x${side},noise=alls=100:allf=u+t:all_seed=${seed}`, "-frames:v", "1", file]);
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// --- a throttling, counting proxy -------------------------------------------------------------------------------

class Bucket {
  bps = 0;
  private tokens = 0;
  private last = Date.now();
  async take(n: number): Promise<number> {
    for (;;) {
      if (!this.bps) return n;
      const now = Date.now();
      this.tokens = Math.min(this.bps / 8 / 10, this.tokens + ((now - this.last) * this.bps) / 8000);
      this.last = now;
      if (this.tokens >= 1024 || this.tokens >= n) { const grant = Math.min(n, Math.floor(this.tokens)); this.tokens -= grant; return grant; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

class Proxy {
  readonly bucket = new Bucket();
  readonly requests: Array<{ at: number; line: string }> = [];
  private server: NetServer | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  constructor(private readonly target: number) {}

  async start(port: number): Promise<void> {
    this.port = port;
    this.server = createServer((client) => {
      const upstream = connect(this.target, "127.0.0.1");
      this.sockets.add(client); this.sockets.add(upstream);
      const end = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      // The server closing (after its last frame, e.g. `bye`) ends the page's side once what is queued went out:
      // destroying it at once would drop that last frame.
      let upstreamDone = false;
      client.on("error", end); upstream.on("error", end); client.on("close", end);
      upstream.on("close", () => { upstreamDone = true; if (!pumping) client.end(); });
      client.on("data", (chunk: Buffer) => {
        // Request heads: count `/v3/c/` reads, and make the page's origin the server's (its WebSocket origin check).
        const text = chunk.subarray(0, Math.min(chunk.length, 8192)).toString("latin1");
        if (/^(GET|HEAD|POST) \//.test(text)) {
          for (const match of text.matchAll(/^(GET|HEAD) (\/v3\/c\/[^ ]+) HTTP/gm)) this.requests.push({ at: Date.now(), line: match[2]!.replace(/([?&]t=)[^&\s]*/, "$1<ticket>") });
          chunk = Buffer.from(chunk.toString("latin1").split(`127.0.0.1:${this.port}`).join(`127.0.0.1:${this.target}`), "latin1");
        }
        upstream.write(chunk);
      });
      // Server → page, through the bucket.
      let queue: Buffer[] = [];
      let pumping = false;
      const pump = async () => {
        if (pumping) return;
        pumping = true;
        while (queue.length) {
          let chunk = queue.shift()!;
          while (chunk.length) {
            const n = await this.bucket.take(chunk.length);
            if (client.destroyed) { queue = []; break; }
            client.write(chunk.subarray(0, n));
            chunk = chunk.subarray(n);
          }
        }
        pumping = false;
        if (upstreamDone) client.end(); else upstream.resume();
      };
      upstream.on("data", (chunk: Buffer) => {
        if (!this.bucket.bps && !queue.length) { if (!client.write(chunk)) { upstream.pause(); client.once("drain", () => upstream.resume()); } return; }
        queue.push(chunk);
        upstream.pause();
        void pump();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

// --- the frame's recorder ---------------------------------------------------------------------------------------

/** Installs (again after a reload) a recorder of broken media elements and "preparing" boxes in the chat frame. */
async function record(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const w = window as unknown as { __rec?: { broken: string[]; preparing: string[]; timer: number } };
    if (w.__rec) return;
    const rec = { broken: [] as string[], preparing: [] as string[], timer: 0 };
    w.__rec = rec;
    const check = () => {
      for (const el of document.querySelectorAll<HTMLElement>("#messages video.media, #messages img.media")) {
        const shown = !el.hidden && getComputedStyle(el).display !== "none" && el.isConnected;
        const src = el.getAttribute("src") ?? "";
        const brokenImg = el instanceof HTMLImageElement && src && el.complete && el.naturalWidth === 0 && !src.startsWith("data:,");
        if (shown && (!src || src.startsWith("data:,botling3") || brokenImg)) {
          const what = `${el.tagName.toLowerCase()} ${src.slice(0, 40)}`;
          if (!rec.broken.includes(what)) rec.broken.push(what);
        }
      }
      for (const el of document.querySelectorAll("[data-testid=media-preparing]")) {
        const text = el.textContent ?? "";
        if (!rec.preparing.includes(text)) rec.preparing.push(text);
      }
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    rec.timer = window.setInterval(check, 50);
  });
}
const recorded = (frame: Frame) => frame.evaluate(() => { const r = (window as unknown as { __rec: { broken: string[]; preparing: string[] } }).__rec; return { broken: [...r.broken], preparing: [...r.preparing] }; });

async function chatFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/chat.html")), { timeout: 30_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/v3/chat.html"))!;
}

interface MediaDiag { state: string; src?: string; variant?: string; badge?: string; reason?: string; poster?: string; durationMs?: number }
interface PlayerDiag { path: string; rateBps: number; measured: boolean; samples: number; switches: number; switchedBy: string[]; choice: string; cache: { hits: number; fetched: number; kept: number; cleared: string[] } }
const media = (page: Page) => page.evaluate(() => (globalThis as { botling3Diagnostics?: { media: Record<string, MediaDiag> } }).botling3Diagnostics?.media ?? {});
const player = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: { player: PlayerDiag } }).botling3Diagnostics?.player ?? null)) as PlayerDiag);
/** The media diagnostics of the newest line naming `name`. */
async function mediaOf(page: Page, name: string): Promise<[string, MediaDiag] | undefined> {
  return Object.entries(await media(page)).filter(([key]) => key.endsWith(`/${name}`)).pop();
}
const cacheKeys = (page: Page) => page.evaluate(async () => {
  if (!(await caches.keys()).includes("botling3-content")) return null;
  const cache = await caches.open("botling3-content");
  return (await cache.keys()).map((request) => request.url.split("/").pop()!).filter((name) => /^[0-9a-f]{64}$/.test(name));
});

async function pairPage(page: Page, dataDir: string, origin: string): Promise<string> {
  const cli = new PairCli(dataDir);
  const link = await cli.link();
  await page.goto(`${origin}/v3/`);
  await page.getByLabel("Pairing link").fill(link);
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
  cli.type("y");
  const paired = await cli.line((l) => l.startsWith("Paired: "), "paired");
  await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
  return /^Paired: (\S+)/.exec(paired)![1]!;
}

/** "This device" › "Forget this device…" › "Forget" (from the phone drawer). */
async function forget(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Bots" }).click();
  await page.getByRole("button", { name: "This device" }).click();
  await page.getByRole("button", { name: "Forget this device…" }).click();
  await page.getByRole("button", { name: "Forget", exact: true }).click();
}

/** The newest `video.media` of the frame, as data. */
const newestVideo = (frame: Frame) => frame.evaluate(() => {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("#messages video.media")];
  const v = videos[videos.length - 1];
  if (!v) return null;
  const chipHost = v.previousElementSibling as HTMLElement | null;
  return {
    src: v.getAttribute("src") ?? "", poster: (v.getAttribute("poster") ?? "").slice(0, 22), variant: v.dataset.botling3Variant ?? "",
    chip: chipHost?.dataset.botling3Box === "chip" ? chipHost.textContent ?? "" : "", time: v.currentTime, paused: v.paused, count: videos.length,
    note: (v.parentElement?.querySelector("[data-testid=media-switched]")?.textContent) ?? "",
    quality: (v.parentElement?.querySelector("[data-testid=media-quality]")?.textContent) ?? "",
  };
});

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `player-${engine}-`));
  const bigDir = mkdtempSync(join(tmpdir(), `botling3-player-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const video = join(root, "talk.mp4");
  const big = join(bigDir, "render.mp4");
  const sparse = join(bigDir, "recording.mp4");
  const pics = [1, 2, 3].map((n) => join(root, `pic${n}.png`));
  const t0 = Date.now();
  makeVideo(video);
  makeBigVideo(big);
  pics.forEach((file, i) => makeImage(file, 300, i + 1));
  // 4 GiB of holes named .mp4: no disk used, hashing it takes seconds (the "preparing" line), and it does not play.
  const fd = openSync(sparse, "w"); ftruncateSync(fd, 4096 * MiB); writeSync(fd, Buffer.from("botling"), 0, 7, 4096 * MiB - 7); closeSync(fd);
  const picSize = statSync(pics[0]!).size;
  // Lowered cap: room for two of the images and a poster, not three.
  const cap = Math.floor(picSize * 2.5);
  result.media = { videoBytes: statSync(video).size, bigBytes: statSync(big).size, picBytes: pics.map((p) => statSync(p).size), cap, madeMs: Date.now() - t0 };
  expect(statSync(big).size).toBeGreaterThan(64 * MiB);

  const server = new Server(dataDir, await freePort());
  const proxy = new Proxy(server.port);
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    await server.ready();
    await proxy.start(await freePort());
    const origin = `http://127.0.0.1:${proxy.port}`;
    browser = await phone(type, join(root, "profile"));
    const { page, context } = browser;
    await context.addInitScript((value) => { (globalThis as { botling3ContentCapBytes?: number }).botling3ContentCapBytes = value; }, cap);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const statuses: Array<{ at: number; url: string; status: number; botlingStatus: string | null }> = [];
    context.on("response", (response) => {
      if (!response.url().includes("/v3/c/")) return;
      void response.headerValue("x-botling-status").then((value) => statuses.push({ at: Date.now(), url: response.url().replace(/([?&]t=)[^&]*/, "$1<ticket>"), status: response.status(), botlingStatus: value }), () => undefined);
    });
    const mask = () => [chatOf(page).locator("#messages .row").filter({ hasText: "/say" })];

    // 1. Pair (through the proxy).
    const deviceId = await pairPage(page, dataDir, origin);
    let frame = await chatFrame(page);
    await record(frame);
    expect((await player(page)).path).toBe("local");

    // 2. "preparing" until content.ready, never a broken element.
    await say(page, `/say The recording: ![recording](${pathToFileURL(sparse).href})`);
    const sayAt = Date.now();
    const box = chatOf(page).getByTestId("media-preparing").filter({ hasText: "recording.mp4 · preparing" });
    await box.waitFor({ timeout: 30_000 });
    const prepShownAt = Date.now();
    if (SHOTS && engine === "chromium") {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, "preparing.png"), mask: mask() });
    }
    // The frame shows the box before the shell's first answer; the answer then says "preparing" (still hashing).
    await expect.poll(async () => (await mediaOf(page, "recording.mp4"))?.[1].state, { timeout: 10_000 }).toBeDefined();
    const stillPreparing = (await mediaOf(page, "recording.mp4"))?.[1].state;
    // Hashed: its bytes (zeros) are no video, so the element fails; it is tried once more, then a note says so —
    // never a broken element, never a retry loop.
    await expect.poll(() => frame.evaluate(() => [...document.querySelectorAll("[data-testid=media-failed]")].map((n) => n.textContent).pop() ?? ""), { timeout: 120_000 }).toBe("This file could not be loaded here.");
    await page.waitForTimeout(2_000);
    const failedReads = proxy.requests.filter((r) => r.at >= sayAt).length;
    result.preparing = { requestsPerLoad: engine === "webkit" ? 3 : 1, stateWhileShown: stillPreparing, boxAfterMs: prepShownAt - sayAt, failedAfterMs: Date.now() - sayAt, requests: failedReads };
    // Two loads (the first and one retry): Chromium reads once per load, WebKit's loader three times (a 2-byte
    // probe, then two ranges). A storm would be thousands.
    const perLoad = engine === "webkit" ? 3 : 1;
    expect(failedReads, "requests for a file that cannot play").toBeLessThanOrEqual(2 * perLoad + 1);
    expect(stillPreparing).toBe("preparing");

    // 3. The video: poster + duration, the original by the 1.5× rule, two stalls → the preview.
    // Throttled to 2 Mbit/s from the start (half the original's bitrate, more than the ~1.2 Mbit/s preview): WebKit
    // reads a whole short clip ahead as soon as it has a source, so a throttle set only at "play" would come too late.
    // The page's path is local (no first-guess limit), so the rule still starts on the original.
    proxy.bucket.bps = 2e6;
    await say(page, `/say Here is the talk: ![talk](${pathToFileURL(video).href})`);
    await expect.poll(async () => (await newestVideo(frame))?.src ?? "", { timeout: 60_000 }).toMatch(/^\/v3\/c\/.+\/original\?/);
    // The preview is made by the owner after the poster: the quality button shows once it is there.
    await expect.poll(async () => { const v = await newestVideo(frame); return v ? `${v.poster}|${v.quality}` : ""; }, { timeout: 90_000 }).toMatch(/^data:image\/jpeg;base64\|Quality: auto \(original\)$/);
    const first = (await newestVideo(frame))!;
    expect(first.chip).toMatch(/^0:30 · \d+(\.\d)? MB$/);
    expect(first.variant).toBe("original");
    const talk = (await mediaOf(page, "talk.mp4"))!;
    expect(talk[1]).toMatchObject({ state: "ready", variant: "original" });
    expect(["fetched", "memory"]).toContain(talk[1].poster);
    expect((await player(page)).cache.fetched).toBeGreaterThanOrEqual(1);
    expect(Math.abs(talk[1].durationMs! - 30_000)).toBeLessThan(300);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await chatOf(page).locator("#messages video.media").last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `poster-duration-${engine}.png`), mask: mask() });
    }
    // Play under the throttle.
    const playStart = Date.now();
    await frame.evaluate(() => { const videos = document.querySelectorAll<HTMLVideoElement>("#messages video.media"); const v = videos[videos.length - 1]!; v.muted = true; void v.play().catch(() => undefined); });
    // The path's words show when the tapped video has no frame to show after 1 s (here it usually has: the metadata
    // and the first second were read ahead); recorded, not required.
    const pathShown = frame.waitForSelector("[data-testid=media-path]", { timeout: 10_000 }).then((el) => el.textContent(), () => null);
    await expect.poll(async () => (await newestVideo(frame))?.variant, { timeout: 120_000, interval: 250 }).toBe("preview");
    const switched = (await newestVideo(frame))!;
    expect(switched.src).toMatch(/\/preview\?/);
    expect(switched.note).toBe("Switched to the preview: the connection was too slow for the original.");
    const switchMs = Date.now() - playStart;
    const pathWords = await pathShown;
    if (pathWords !== null) expect(pathWords).toBe("loading · on this computer");
    // It plays on from about the same position.
    await expect.poll(async () => { const v = await newestVideo(frame); return v ? !v.paused && v.time > 0 : false; }, { timeout: 30_000 }).toBe(true);
    const afterSwitch = await player(page);
    expect(afterSwitch.switches).toBe(1);
    // Chromium starts at once and stalls (two stalls in 30 s); WebKit holds the start until it can play through, so
    // the slow-start rule switches it (player.ts).
    expect(afterSwitch.switchedBy).toEqual([engine === "webkit" ? "slow-start" : "stalls"]);
    result.switch = { by: afterSwitch.switchedBy[0], pathWords, switchMs, positionAfter: (await newestVideo(frame))!.time, rateBps: afterSwitch.rateBps, samples: afterSwitch.samples };
    // The same video in a new line starts on the preview: the session's rate is now short of 1.5 × 4 Mbit/s.
    await say(page, `/say Again: ![talk](${pathToFileURL(video).href})`);
    await expect.poll(async () => { const v = await newestVideo(frame); return v && v.count >= 3 ? v.src : ""; }, { timeout: 60_000 }).toMatch(/\/preview\?/);
    const again = (await newestVideo(frame))!;
    expect(again.variant).toBe("preview");
    expect(again.chip).toMatch(/^0:30 · \d+(\.\d)? MB · preview$/);
    expect((await mediaOf(page, "talk.mp4"))![1]).toMatchObject({ variant: "preview", reason: "rate", badge: "preview", poster: "memory" });
    result.restart = { chip: again.chip, rateBps: (await player(page)).rateBps };
    await frame.evaluate(() => { for (const v of document.querySelectorAll<HTMLVideoElement>("video")) v.pause(); });
    proxy.bucket.bps = 0;

    // 4. Small images by hash; a reload reads the poster and the image from the cache.
    await say(page, `/say A picture: ![pic1](${pathToFileURL(pics[0]!).href})`);
    await expect.poll(async () => (await mediaOf(page, "pic1.png"))?.[1].src ?? "", { timeout: 60_000 }).toBe("data:");
    const posterHex = (await cacheKeys(page))!.find((hex) => hex !== sha(pics[0]!));
    expect(await cacheKeys(page)).toEqual(expect.arrayContaining([sha(pics[0]!)]));
    expect(posterHex).toBeTruthy();
    // The player menu's choice is kept for this device (IndexedDB beside its record): "original" survives the reload.
    const qualityButton = () => chatOf(page).getByTestId("media-quality").last();
    await qualityButton().click();
    await expect.poll(async () => (await player(page)).choice, { timeout: 10_000 }).toBe("original");
    await page.reload();
    frame = await chatFrame(page);
    await record(frame);
    const reloadAt = Date.now();
    await expect.poll(async () => (await player(page))?.choice, { timeout: 10_000 }).toBe("original");
    await expect.poll(() => qualityButton().textContent(), { timeout: 30_000 }).toBe("Quality: original");
    // Back to auto (original → preview → auto).
    await qualityButton().click();
    await expect.poll(async () => (await player(page)).choice, { timeout: 10_000 }).toBe("preview");
    await qualityButton().click();
    await expect.poll(async () => (await player(page)).choice, { timeout: 10_000 }).toBe("auto");
    await expect.poll(async () => (await mediaOf(page, "pic1.png"))?.[1], { timeout: 60_000 }).toMatchObject({ state: "ready", src: "data:", poster: "cache" });
    // Both talk lines show the poster: the first read comes from Cache Storage, the second from the page's memory.
    await expect.poll(async () => (await mediaOf(page, "talk.mp4"))?.[1].poster, { timeout: 60_000 }).toMatch(/^(cache|memory)$/);
    expect((await player(page)).cache).toMatchObject({ hits: 2, fetched: 0 });
    await expect.poll(() => frame.evaluate(() => (document.querySelector("#messages img.media[src^='data:image']") as HTMLImageElement | null)?.naturalWidth ?? 0), { timeout: 10_000 }).toBe(300);
    const afterReload = proxy.requests.filter((r) => r.at >= reloadAt);
    expect(afterReload.filter((r) => /\/(poster|thumb)\?/.test(r.line) || r.line.includes(sha(pics[0]!))), JSON.stringify(afterReload)).toEqual([]);
    // Above the lowered cap the least recently used go: two more images push out the poster and the first image.
    await say(page, `/say Two more: ![pic2](${pathToFileURL(pics[1]!).href}) ![pic3](${pathToFileURL(pics[2]!).href})`);
    await expect.poll(async () => (await mediaOf(page, "pic3.png"))?.[1].src ?? "", { timeout: 60_000 }).toBe("data:");
    await expect.poll(async () => (await mediaOf(page, "pic2.png"))?.[1].src ?? "", { timeout: 60_000 }).toBe("data:");
    await expect.poll(async () => (await cacheKeys(page))?.sort().join(","), { timeout: 10_000 }).toBe([sha(pics[1]!), sha(pics[2]!)].sort().join(","));
    const usage = await page.evaluate(async () => { const cache = await caches.open("botling3-content"); const index = await (await cache.match(new URL("__content/index.json", location.href).href))!.json() as Record<string, { size: number }>; return Object.values(index).reduce((s, i) => s + i.size, 0); });
    expect(usage).toBeLessThanOrEqual(cap);
    result.cache = { afterReloadRequests: afterReload.map((r) => r.line), keptAfterCap: 2, usage, cap, player: await player(page) };

    // 5. A 410 reaches the server at most 3 times.
    const videosBefore = (await newestVideo(frame))?.count ?? 0;
    await say(page, `/say The render: ![render](${pathToFileURL(big).href})`);
    await expect.poll(async () => { const v = await newestVideo(frame); return v && v.count > videosBefore ? v.src : ""; }, { timeout: 90_000 }).toMatch(/^\/v3\/c\/.+\/(original|preview)\?/);
    // Its preview is made too (the rate is capped since the switch, so the preview plays); wait for it, then play.
    await expect.poll(async () => (await newestVideo(frame))?.quality ?? "", { timeout: 90_000 }).toMatch(/^Quality: /);
    const renderSrc = (await newestVideo(frame))!.src;
    const renderPath = renderSrc.split("?")[0]!.replace(/\/(original|preview)$/, "");
    // Play the newest element, and again if the line was drawn anew (a renewed ticket gives a new element).
    const playNewest = () => frame.evaluate(() => { const videos = document.querySelectorAll<HTMLVideoElement>("#messages video.media"); const v = videos[videos.length - 1]!; if (v.paused) { v.muted = true; void v.play().catch(() => undefined); } return v.currentTime; });
    await expect.poll(playNewest, { timeout: 30_000 }).toBeGreaterThan(0.3);
    const fd2 = openSync(big, "r+");
    const bigSize = statSync(big).size;
    writeSync(fd2, Buffer.alloc(MiB, 0x5a), 0, MiB, 0);
    writeSync(fd2, Buffer.alloc(MiB, 0x5a), 0, MiB, Math.floor(bigSize * 0.8));
    closeSync(fd2);
    const rewrittenAt = Date.now();
    const target = await frame.evaluate(() => {
      const videos = document.querySelectorAll<HTMLVideoElement>("#messages video.media");
      const v = videos[videos.length - 1]!;
      const buffered = (t: number) => { for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true; return false; };
      for (let t = v.duration - 2; t > 1; t -= 0.5) if (!buffered(t)) { v.currentTime = t; return t; }
      return null;
    });
    await expect.poll(() => frame.evaluate(() => [...document.querySelectorAll("[data-testid=media-changed]")].map((n) => n.textContent).pop() ?? ""), { timeout: 60_000 }).toBe("This file changed after this message.");
    await page.waitForTimeout(3_000);
    const refusedReads = proxy.requests.filter((r) => r.at >= rewrittenAt && r.line.startsWith(renderPath.replace(/([?&]t=)[^&]*/, "$1<ticket>")));
    const refusedStatuses = statuses.filter((s) => s.at >= rewrittenAt && (s.status >= 400 || s.botlingStatus));
    result.refusal = { file: renderPath.split("%3A").pop()!.slice(0, 12), seekTo: target, requestsAfterRewrite: refusedReads.length, statuses: refusedStatuses.map((s) => ({ status: s.status, botlingStatus: s.botlingStatus })) };
    expect(target, "a part of the clip that was not buffered").not.toBeNull();
    expect(refusedReads.length, JSON.stringify(result.refusal)).toBeLessThanOrEqual(3);

    // The whole run so far: "preparing" boxes, never a broken element.
    const rec = await recorded(frame);
    expect(rec.broken, JSON.stringify(rec)).toEqual([]);
    result.recorder = rec;

    // 6a. Sign-out clears the cache.
    expect((await cacheKeys(page))?.length ?? 0).toBeGreaterThan(0);
    await forget(page);
    await expect.poll(() => cacheKeys(page), { timeout: 15_000 }).toBeNull();
    expect((await player(page)).cache.cleared).toContain("sign-out");

    // 6b. Paired again, the cache refills; a revocation while connected (bye{revoked}) clears it.
    const second = await pairPage(page, dataDir, origin);
    frame = await chatFrame(page);
    await say(page, `/say Picture again: ![pic3](${pathToFileURL(pics[2]!).href})`);
    await expect.poll(async () => (await cacheKeys(page))?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
    const revoke = botlingdCommand(dataDir, ["revoke-device", second, "--reason", "test"]);
    expect(revoke.stdout).toMatch(/^Revoked /m);
    await expect.poll(async () => (await player(page)).cache.cleared, { timeout: 30_000 }).toContain("revoked (bye)");
    expect(await cacheKeys(page)).toBeNull();

    result.cleared = { first: deviceId.slice(0, 6), signOut: true, byeRevoked: true };

    result.pageErrors = errors;
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await proxy.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
    rmSync(bigDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(dist) || spawnSync("ffmpeg", ["-version"]).status !== 0)("M2 step 11: content cache and player rules (headless)", () => {
  for (const [engine, type] of ENGINES) it(`${engine}: preparing, poster + duration, the 1.5× rule and the two-stalls switch, the cache, ≤ 3 requests for a 410, cache cleared`, () => run(engine, type), 900_000);
});
