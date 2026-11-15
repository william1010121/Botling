// Botling 3 M3 step 12: media across servers, on the real page. The page (web-v3) in headless Chromium and headless
// WebKit, paired with server A; B's bot (two real botlingd on loopback, fake engine, a pass-through fault proxy in front
// of each) shows a 5-minute low-bitrate clip, a 100-page PDF and a > 64 MiB clip (`pin: path`), all made on B at test
// time and deleted afterwards. Per engine, one script:
//
//  1. B's bot opens at A; the clip shows B's poster first (with its duration), then plays (first frame) and seeks three
//     times. The §9A.5 rule asks for no preview at this bitrate, so the original plays. The requests the page sends A
//     are logged (Range, status), and so is the traffic between A and B (both proxies): the second engine plays from
//     A's cache, so it causes no second full download across servers.
//  2. The PDF opens from the chat: page 1 within 2 s, by range requests only (< 1 MiB read before page 1).
//  3. The big clip (B's preview of it made first, so the choice is the same every run) plays a moment in its original;
//     B's file is rewritten under its line; a seek to a part not read yet: the line says the
//     file changed, and A never serves the new bytes.
// Measured: poster-first time, first frame, seek times, the page's request log to A, A↔B bytes, PDF page 1 time and
// bytes. Phone-width screenshots (video playing, PDF page 1) go to V3_SHOT_DIR when set.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/two-servers/vitest.config.mts test/acceptance/two-servers/media-peer.test.ts
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type BrowserType, type Frame, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageOf, Slot } from "../../../src/protocol";
import { until } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { FaultProxy } from "../../support/fault-proxy";
import { makeTextPdf, type MadePdf } from "../../support/make-pdf";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../../support/two-servers";
import { chatOf, PairCli, phone } from "../web-v3/page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SHOTS = process.env.V3_SHOT_DIR || "";
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const launches = new Set<string>();
const MiB = 1 << 20;
const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const PEER_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","), BOTLING_SERVER_PEER_CACHE: `bytes=${256 * MiB}` };
const report: Record<string, unknown> = {};

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}
/** 5 minutes of 640×360 H.264 at ~400 kbit/s + AAC, keyframe every 2 s, faststart (§9A.5: no preview needed). */
function makeClip(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "300", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "400k", "-maxrate", "500k", "-bufsize", "1M", "-g", "48",
    "-c:a", "aac", "-b:a", "48k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}
/**
 * A ~70 MiB clip: above the 64 MiB copy limit, so its line pins the path (rewritable under it). It is long and small
 * (300 s at ~1.9 Mbit/s, constant rate) so that every player rule keeps the original with a wide margin: the 1.5× rule
 * and WebKit's slow-start switch both compare against 1.5 × its bitrate ≈ 2.9 Mbit/s, far under the tailnet first
 * guess (20 Mbit/s) and loopback reads. (A 14 Mbit/s clip sat at 21 Mbit/s, above the first guess: whether its line
 * played the original or switched to B's preview mid-test depended on the measured rate, and on a loaded machine
 * WebKit — which holds the clock while it buffers — could switch, so the test lost its element and timed out.)
 */
function makeBigClip(file: string): void {
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100",
    "-t", "300", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1850k", "-minrate", "1850k", "-maxrate", "1850k", "-bufsize", "3700k",
    "-x264-params", "nal-hrd=cbr", "-g", "48", "-c:a", "aac", "-b:a", "64k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
/** B's `content.variant` entries naming a preview (only the > 50 MB clips get one). */
const previewsOnB = () => withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'content.variant'").all() as Array<{ body: string }>).filter((row) => (JSON.parse(row.body) as { variant: { name: string } }).variant.name === "preview").length);
let bigPreviews = 0;
const rosterIds = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT id FROM roster").all() as Array<{ id: string }>).map((row) => String(row.id)));

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let media: string;
let bigDir: string;
let clip: string;
let pdf: string;
let made: MadePdf;
let botB: string;
const bigs: Record<string, string> = {};

let scriptB: Awaited<ReturnType<TestServer["client"]>>;
let inc: string;
let sentOnB = 0;
/** A line in B's bot (the fake engine's /say), sent by B's own script client. */
async function sayOnB(text: string): Promise<void> {
  const n = ++sentOnB;
  scriptB.cmd({ origin: "script", originEpoch: scriptB.originEpoch, target: `bot:${botB}`, n } as Slot, { type: "chat.send", botId: botB, text }, inc as never);
  await scriptB.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}` && m.slot.n === n, `chat.send ${n} on B`);
}
/** Bytes between A and B across both engines' video parts (the clip comes across at most about once). */
let clipPeerBytes = 0;

/** Bytes between A and B (both proxies, both directions) since `at`. */
const peerBytes = (at: number) => [pa, pb].reduce((sum, proxy) => sum + proxy.events.filter((e) => e.at >= at && e.action === "pass").reduce((s, e) => s + e.bytes, 0), 0);

beforeAll(async () => {
  for (const [name, type] of ENGINES) {
    try { await (await type.launch({ headless: true })).close(); launches.add(name); } catch { report[`${name}Skipped`] = "not installed"; }
  }
  const t0 = Date.now();
  media = mkdtempSync(join(TMP, "media-peer-"));
  // The > 64 MiB clips on the internal disk's tmp (as the step 11 player test): pinned by path, rewritten later.
  bigDir = mkdtempSync(join(tmpdir(), "botling3-media-peer-"));
  clip = join(media, "walkthrough.mp4");
  pdf = join(media, "report.pdf");
  makeClip(clip);
  made = makeTextPdf(pdf, 100);
  for (const [engine] of ENGINES) { bigs[engine] = join(bigDir, `render-${engine}.mp4`); makeBigClip(bigs[engine]!); }
  report.media = { clipBytes: statSync(clip).size, clipSeconds: 300, pdfBytes: made.bytes, pdfPages: made.pages, bigBytes: Object.values(bigs).map((f) => statSync(f).size), madeMs: Date.now() - t0 };
  for (const file of Object.values(bigs)) expect(statSync(file).size).toBeGreaterThan(64 * MiB);

  cluster = await startServers({ name: "media-peer", count: 2, env: { A: PEER_ENV, B: PEER_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 61);
  pb = await cluster.proxy(b, "websocket", 62);
  const cl = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, cl.clusterId, [...cl.statements, await profile(cl.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  // B's bot: one line per file (the fake engine's /say).
  const client = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Media bot", job: "media peer test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  inc = snap.logId;
  scriptB = client;
  await sayOnB(`/say The walkthrough: ![walkthrough](${pathToFileURL(clip).href})`);
  await sayOnB(`/say The report: ![report](${pathToFileURL(pdf).href})`);
  // B's jobs: the clip's poster and meta, the PDF's text.
  await until(() => withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'content.variant'").all() as Array<{ body: string }>).some((row) => (JSON.parse(row.body) as { variant: { name: string } }).variant.name === "poster")), { timeout: 120_000, what: "B's poster" });
  await until(() => withDb(b, (db) => !!db.prepare("SELECT 1 FROM entries WHERE kind = 'content.text'").get()), { timeout: 120_000, what: "B's PDF text" });
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });
  report.setupMs = Date.now() - t0;
}, 600_000);

afterAll(async () => {
  scriptB?.close();
  for (const s of [a, b]) if (s) report[`log${s.name}`] = s.log.split("\n").filter((line) => /peer content|content:|media|session ended|handshake ended/.test(line)).slice(-40).map((line) => line.replace(/(^|[\s(])\/[^\s)]+/g, "$1<path>"));
  await cluster?.cleanup();
  if (media) rmSync(media, { recursive: true, force: true });
  if (bigDir) rmSync(bigDir, { recursive: true, force: true });
  report.mediaDeleted = !existsSync(media ?? "") && !existsSync(bigDir ?? "");
  writeReport("step-12-media-peer", report);
}, 60_000);

interface MediaDiag { state: string; src?: string; url?: string; textUrl?: string; variant?: string; badge?: string; reason?: string; poster?: string; durationMs?: number }
const mediaDiag = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: { media?: unknown } }).botling3Diagnostics?.media ?? {})) as Record<string, MediaDiag>);
const mediaOf = async (page: Page, name: string) => Object.entries(await mediaDiag(page)).filter(([key]) => key.endsWith(`/${name}`)).pop()?.[1];

async function chatFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/chat.html")), { timeout: 30_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/v3/chat.html"))!;
}
async function viewerFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/pdf.html")), { timeout: 15_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("/v3/pdf.html"))!;
}
interface PdfDiag { state: string; error?: string; size?: number; pages?: number; bytes: number; firstPageMs?: number; bytesBeforeFirstPage?: number; readsBeforeFirstPage?: number; fullRequests: number }
const pdfDiag = (frame: Frame) => frame.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Pdf?: unknown }).botling3Pdf ?? null)) as PdfDiag | null);

/** The chat's video element whose source is `src` (the shell's answer), as data. */
const videoState = (frame: Frame, src: string) => frame.evaluate((src) => {
  const v = [...document.querySelectorAll<HTMLVideoElement>("#messages video.media")].find((el) => el.getAttribute("src") === src);
  if (!v) return null;
  return { poster: (v.getAttribute("poster") ?? "").slice(0, 22), variant: v.dataset.botling3Variant ?? "", time: v.currentTime, paused: v.paused, readyState: v.readyState, duration: v.duration,
    changed: (v.parentElement?.querySelector("[data-testid=media-changed]")?.textContent) ?? "" };
}, src);
/** Plays it muted; resolves at its first frame (`loadeddata` or already there) and at `playing`. */
const playTimed = (frame: Frame, src: string) => frame.evaluate((src) => new Promise<{ firstFrameMs: number; playingMs: number; error?: string }>((resolve) => {
  const v = [...document.querySelectorAll<HTMLVideoElement>("#messages video.media")].find((el) => el.getAttribute("src") === src)!;
  const start = performance.now();
  const out = { firstFrameMs: v.readyState >= 2 ? 0 : -1, playingMs: -1 };
  const done = () => { if (out.firstFrameMs >= 0 && out.playingMs >= 0) resolve(out); };
  v.addEventListener("loadeddata", () => { if (out.firstFrameMs < 0) out.firstFrameMs = performance.now() - start; done(); }, { once: true });
  v.addEventListener("playing", () => { out.playingMs = performance.now() - start; if (out.firstFrameMs < 0) out.firstFrameMs = out.playingMs; done(); }, { once: true });
  v.scrollIntoView({ block: "center" });
  v.muted = true;
  void v.play().catch((error) => resolve({ ...out, error: String(error) }));
  setTimeout(() => resolve({ ...out, error: "timeout" }), 30_000);
}), src);
/** Seeks it; resolves at `seeked` and when it plays on from there. */
const seekTimed = (frame: Frame, src: string, to: number) => frame.evaluate(({ src, to }) => new Promise<{ seekedMs: number; playingMs: number; time: number; error?: string }>((resolve) => {
  const v = [...document.querySelectorAll<HTMLVideoElement>("#messages video.media")].find((el) => el.getAttribute("src") === src)!;
  const start = performance.now();
  const out = { seekedMs: -1, playingMs: -1, time: 0 };
  v.addEventListener("seeked", () => {
    out.seekedMs = performance.now() - start;
    const from = v.currentTime;
    const tick = () => { if (v.currentTime > from + 0.2) { out.playingMs = performance.now() - start; out.time = v.currentTime; resolve(out); } else setTimeout(tick, 20); };
    tick();
  }, { once: true });
  v.currentTime = to;
  setTimeout(() => resolve({ ...out, time: v.currentTime, error: "timeout" }), 30_000);
}), { src, to });

interface Logged { at: number; path: string; range: string | null; status?: number; length?: number }

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `media-peer-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    browser = await phone(type, join(root, "profile"));
    const { page, context } = browser;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await context.addInitScript(() => {
      const seen: string[] = [];
      (globalThis as { botling3Csp?: string[] }).botling3Csp = seen;
      document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const origin = `http://127.0.0.1:${a.port}`;
    // The lines that name the files' folders are masked in screenshots.
    const mask = () => [chatOf(page).locator("#messages .row").filter({ hasText: "/say" })];
    const log: Logged[] = [];
    const foreign: string[] = [];
    context.on("request", (request) => {
      if (!request.url().startsWith(origin) && !/^(data|blob):/.test(request.url())) foreign.push(request.url().slice(0, 80));
      if (!request.url().includes("/v3/c/")) return;
      const url = new URL(request.url());
      const entry: Logged = { at: Date.now(), path: url.pathname.split("/").slice(-1)[0]!, range: null };
      entry.path = `${url.pathname.split("/").at(-2)!.slice(-8)}/${entry.path}`;
      log.push(entry);
      void request.headerValue("range").then((range) => { entry.range = range; }, () => undefined);
      void request.response().then(async (response) => { if (response) { entry.status = response.status(); const length = await response.headerValue("content-length").catch(() => null); if (length) entry.length = Number(length); } }, () => undefined);
    });

    // Pair with A.
    const before = rosterIds(b).length;
    const cli = new PairCli(a.dataDir);
    const link = await cli.link();
    await page.goto(`${origin}/v3/`);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
    await until(() => rosterIds(b).length > before, { timeout: 30_000, what: "the page's Add at B" });

    // 1. Open B's bot: the poster first, then play and seek.
    const tPeer = Date.now();
    const row = page.locator(`.bot-row[data-bot='${botB}']`);
    if (!(await row.isVisible())) await page.getByRole("button", { name: "Bots" }).click();
    const tOpen = Date.now();
    await row.click({ timeout: 30_000 });
    const frame = await chatFrame(page);
    await expect.poll(async () => (await mediaOf(page, "walkthrough.mp4"))?.state ?? "", { timeout: 60_000 }).toBe("ready");
    const walk = (await mediaOf(page, "walkthrough.mp4"))!;
    expect(walk.src).toMatch(new RegExp(`^/v3/c/${kb.memberId}/.+/original\\?`));
    await expect.poll(async () => (await videoState(frame, walk.src!))?.poster ?? "", { timeout: 30_000 }).toBe("data:image/jpeg;base64");
    const posterMs = Date.now() - tOpen;
    const shown = (await videoState(frame, walk.src!))!;
    // Poster first: shown before the clip played or read past its start.
    expect(shown.paused).toBe(true);
    expect(shown.time).toBe(0);
    expect(walk.variant).toBe("original");
    expect(walk.badge ?? "").toBe("");
    expect(Math.abs((walk.durationMs ?? 0) - 300_000)).toBeLessThan(1_000);
    const played = await playTimed(frame, walk.src!);
    expect(played.error, JSON.stringify(played)).toBeUndefined();
    const seeks = [];
    for (const to of [60, 150, 280]) {
      const s = await seekTimed(frame, walk.src!, to);
      expect(s.error, JSON.stringify(s)).toBeUndefined();
      expect(Math.abs(s.time - to)).toBeLessThan(3);
      seeks.push({ to, seekedMs: Math.round(s.seekedMs), playsOnMs: Math.round(s.playingMs) });
    }
    await page.waitForTimeout(500);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${engine}-video-playing.png`), mask: mask() });
    }
    await frame.evaluate(() => { for (const v of document.querySelectorAll<HTMLVideoElement>("video")) v.pause(); });
    const clipBytes = statSync(clip).size;
    const tail = (src: string) => `${new URL(src, origin).pathname.split("/").at(-2)!.slice(-8)}/original`;
    const clipLog = log.filter((e) => e.path === tail(walk.src!) && e.at >= tOpen);
    const peer = peerBytes(tPeer);
    // No second full download: every read after the first starts past byte 0 (a 2-byte probe is no download), and
    // across servers the clip came at most about once (the second engine from A's cache).
    const fromZero = clipLog.filter((e) => /^bytes=0-(\d*)$/.test(e.range ?? "") && !/^bytes=0-[01]$/.test(e.range ?? ""));
    result.video = {
      posterFirstMs: posterMs, posterFrom: walk.poster, firstFrameMs: Math.round(played.firstFrameMs), playingMs: Math.round(played.playingMs), seeks,
      requestsToA: clipLog.map((e) => `${e.range ?? "(no range)"} → ${e.status ?? "?"}`), fullReadsFromZero: fromZero.length,
      bytesBetweenAandB: peer, clipBytes, ofClip: Number((peer / clipBytes).toFixed(3)),
    };
    expect(clipLog.filter((e) => e.range === null && e.status === 200), JSON.stringify(clipLog)).toEqual([]);
    expect(fromZero.length, JSON.stringify(clipLog)).toBeLessThanOrEqual(1);
    // Across servers the clip comes at most about once over both engines (the second plays from A's cache).
    clipPeerBytes += peer;
    result.video = { ...(result.video as object), bytesBetweenAandBSoFar: clipPeerBytes };
    expect(clipPeerBytes).toBeLessThan(clipBytes * 1.3);

    // 2. The PDF from the chat: page 1 in ≤ 2 s by ranges only.
    await expect.poll(async () => (await mediaOf(page, "report.pdf"))?.textUrl ?? "", { timeout: 60_000 }).toMatch(/\/text\?/);
    const opener = chatOf(page).locator("[data-botling3-open]").first();
    await opener.scrollIntoViewIfNeeded();
    const tTap = Date.now();
    const pdfLogFrom = log.length;
    await opener.click();
    const viewer = await viewerFrame(page);
    await expect.poll(async () => { const d = await pdfDiag(viewer); if (d?.state === "error") throw new Error(d.error); return d?.firstPageMs ?? -1; }, { timeout: 15_000, interval: 25 }).toBeGreaterThan(0);
    const tapToPage1 = Date.now() - tTap;
    const first = (await pdfDiag(viewer))!;
    await page.waitForTimeout(800);
    const pdfLog = log.slice(pdfLogFrom).filter((e) => e.path.endsWith("/original"));
    result.pdf = { tapToPage1Ms: tapToPage1, viewerMs: first.firstPageMs, bytesBeforePage1: first.bytesBeforeFirstPage, readsBeforePage1: first.readsBeforeFirstPage, size: first.size, pages: first.pages, ranges: pdfLog.map((e) => `${e.range ?? "(no range)"} → ${e.status ?? "?"}`) };
    expect(first.size).toBe(made.bytes);
    expect(first.pages).toBe(100);
    expect(tapToPage1).toBeLessThan(2_000);
    expect(first.bytesBeforeFirstPage!).toBeLessThan(MiB);
    expect(first.fullRequests).toBe(0);
    expect(pdfLog.length).toBeGreaterThan(0);
    expect(pdfLog.filter((e) => !e.range), JSON.stringify(pdfLog)).toEqual([]);
    expect(pdfLog.filter((e) => e.status !== undefined && e.status !== 206), JSON.stringify(pdfLog)).toEqual([]);
    expect(await viewer.evaluate(() => (globalThis as { botling3Csp?: string[] }).botling3Csp ?? [])).toEqual([]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${engine}-pdf-page1.png`), mask: mask() });
    await viewer.getByRole("button", { name: /close/i }).first().click().catch(async () => { await page.keyboard.press("Escape"); });
    await expect.poll(() => page.frames().some((f) => f.url().includes("/v3/pdf.html")), { timeout: 10_000 }).toBe(false);

    // 3. The big clip (pin: path) rewritten on B: "changed" at A, never the new bytes.
    const name = `render-${engine}.mp4`;
    await sayOnB(`/say The render ${engine}: ![render-${engine}](${pathToFileURL(bigs[engine]!).href})`);
    await expect.poll(async () => (await mediaOf(page, name))?.state ?? "", { timeout: 120_000 }).toBe("ready");
    // B's preview of this clip (> 50 MB, so §9A.5 always makes one) exists before it plays: the page's choice is then
    // made with the preview known, every run, instead of racing B's ffmpeg job (a preview arriving while the original
    // plays used to retarget the element mid-test, more often in WebKit on a loaded machine).
    const previews = ++bigPreviews;
    await until(() => previewsOnB() >= previews, { timeout: 180_000, what: `B's preview of ${name}` });
    // B's entry reaches A's page a moment later (replication); until then the page decides with the original only
    // (`only-original`). Once it knows the preview, the rate rule keeps the original.
    await expect.poll(async () => { const m = await mediaOf(page, name); return `${m?.variant}/${m?.reason}`; }, { timeout: 60_000 }).toBe("original/rate");
    const big = (await mediaOf(page, name))!;
    result.big = { variant: big.variant, reason: big.reason, badge: big.badge ?? "" };
    const bigPlay = await playTimed(frame, big.src!);
    expect(bigPlay.error, JSON.stringify(bigPlay)).toBeUndefined();
    await expect.poll(async () => (await videoState(frame, big.src!))?.time ?? 0, { timeout: 30_000 }).toBeGreaterThan(0.3);
    const file = bigs[engine]!;
    const size = statSync(file).size;
    const fd = openSync(file, "r+");
    writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, 0);
    writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, Math.floor(size * 0.8));
    closeSync(fd);
    const rewrittenAt = Date.now();
    const seekTo = await frame.evaluate((src) => {
      const v = [...document.querySelectorAll<HTMLVideoElement>("#messages video.media")].find((el) => el.getAttribute("src") === src)!;
      const buffered = (t: number) => { for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true; return false; };
      for (let t = v.duration - 2; t > 1; t -= 0.5) if (!buffered(t)) { v.currentTime = t; return t; }
      return null;
    }, big.src!);
    expect(seekTo, "a part of the clip that was not read").not.toBeNull();
    await expect.poll(() => frame.evaluate(() => [...document.querySelectorAll("[data-testid=media-changed]")].map((n) => n.textContent).pop() ?? ""), { timeout: 60_000 }).toBe("This file changed after this message.");
    // The shell's answer turns `changed` too (WebKit's element may report the refusal first); the note stays.
    await expect.poll(async () => (await mediaOf(page, name))?.state, { timeout: 15_000 }).toBe("changed");
    await page.waitForTimeout(2_000);
    expect(await frame.evaluate(() => [...document.querySelectorAll("[data-testid=media-changed]")].map((n) => n.textContent).pop() ?? "")).toBe("This file changed after this message.");
    expect((await mediaOf(page, name))?.state).toBe("changed");
    // What A answers now for the rewritten part (read from the page, with its ticket): never the new bytes.
    const probe = await page.evaluate(async ({ url, start }) => {
      const response = await fetch(url, { headers: { range: `bytes=${start}-${start + 4095}` }, cache: "no-store" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, newBytes: bytes.length > 0 && bytes.every((x) => x === 0x5a) };
    }, { url: big.src!, start: Math.floor(size * 0.8) });
    const afterRewrite = log.filter((e) => e.at >= rewrittenAt && e.path === tail(big.src!));
    result.changed = { seekTo, shownAfterMs: Date.now() - rewrittenAt, probe, requestsAfterRewrite: afterRewrite.map((e) => `${e.range ?? "(no range)"} → ${e.status ?? "?"}`) };
    expect(probe.newBytes).toBe(false);
    expect(probe.status).not.toBe(206);

    // The viewer ran under the page's CSP with no violation (as step 15 checks it); the shell's own reports are recorded.
    result.cspShell = await page.evaluate(() => (globalThis as { botling3Csp?: string[] }).botling3Csp ?? []);
    result.foreign = foreign;
    result.pageErrors = errors;
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(ENGINES.length === 0 || spawnSync("ffmpeg", ["-version"]).status !== 0)("M3 step 12: B's media on the page at A (headless, two real botlingd)", () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: B's poster first, plays and seeks with no second full download, PDF page 1 by ranges in ≤ 2 s, a rewritten pinned file shows changed`, async (ctx) => {
      if (!launches.has(engine)) ctx.skip();
      await run(engine, type);
    }, 600_000);
  }
});
