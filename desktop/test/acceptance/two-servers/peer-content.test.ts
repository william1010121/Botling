// Botling 3 M3 step 10 (m3-brief §4 row 10): content owned by server B, played through server A, in headless Chromium
// and headless WebKit against two real botlingd on loopback (fake engine; peer session through a fault proxy each, the
// statements written into each server.db while stopped, as in steps 3–9). A phone is paired at A (its Add reaches B
// by gossip); B's bot line shows a video, a 100-page PDF, a file B corrupts (the test hook) and a file nobody reads
// before B goes away. The phone asks A for each (`content.locate` on its tailnet session); A asks B; the browser reads
// A's ticketed `/v3/c/<B>/…` URLs from a page on A's origin.
//
// Per engine:
//   1. the video plays from A (`loadeddata` = first frame, then `playing`) and seeks without a second read from byte 0;
//   2. the PDF's ranges (head, trailer by suffix, a middle range) are the file's bytes; head + trailer timed (page 1);
//   3. the corrupted file is refused (502 `refused; reason=chunk-hash`, the <video> errors), never its bytes;
//   4. B stopped: the video (read whole before) still plays and seeks from A's cache; the unread file answers 503.
// Media are made at test time with ffmpeg (small), under the work volume's tmp, and deleted afterwards.
//
//   npm run build
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/two-servers/vitest.config.mts test/acceptance/two-servers/peer-content.test.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentUrlPath, type Message, type MessageOf, type Slot } from "../../../src/protocol";
import { until } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { FaultProxy } from "../../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../../support/two-servers";
import { pairPhone, PhoneSession, type DeviceKeys } from "../../support/ws-device";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
/** Engines that launch here (installed browsers only; the others are skipped, and the report says so). */
const launches = new Set<string>();
const MiB = 1 << 20;
const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const PEER_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","), BOTLING_SERVER_PEER_CACHE: `bytes=${256 * MiB}` };
const report: Record<string, unknown> = {};

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}
/** A ~6 MiB 480p H.264 + AAC clip, 24 s, keyframe every 2 s, faststart: several 1 MiB chunks, small enough to cache. */
function makeVideo(file: string, seconds = 24, hz = 440): void {
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=854x480:rate=30`, "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=44100`,
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2M", "-maxrate", "2M", "-bufsize", "4M", "-g", "60",
    "-c:a", "aac", "-b:a", "64k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
}
/** A valid PDF of `pages` pages (text and some fill per page), xref offsets computed here. */
function makePdf(file: string, pages: number): void {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 24 Tf 72 720 Td (Botling 3 page ${i + 1}) Tj ET ${"q 0.9 g 72 100 400 500 re f Q ".repeat(400)}`;
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
const sha = (file: string) => "sha256:" + createHash("sha256").update(readFileSync(file)).digest("hex");

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const rosterIds = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT id FROM roster").all() as Array<{ id: string }>).map((row) => String(row.id)));

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let clusterId: string;
let media: string;
let files: { video: string; pdf: string; bad: string; unread: string; video2: string };
let botB: string;
let lineB: string;
let keys: DeviceKeys;
let phoneA: PhoneSession;

const server = (k: MemberKeysInfo) => ({ memberId: k.memberId, dh: k.dh });
let reqN = 0;
async function locate(file: string): Promise<{ url: string; id: string }> {
  return until(async () => {
    const req = `loc${++reqN}`;
    phoneA.send({ t: "content.locate", req, botId: botB, line: lineB, url: pathToFileURL(file).href } as Message);
    const answer = await until(() => phoneA.got.find((m): m is MessageOf<"content.located"> => m.t === "content.located" && m.req === req) ?? null, { timeout: 15_000, what: `located ${req}` });
    if (!answer.ref || !answer.ticket) { await new Promise((resolve) => setTimeout(resolve, 200)); return null; }
    expect(answer.ref.owner).toBe(kb.memberId);
    return { url: contentUrlPath({ owner: answer.ref.owner, id: answer.ref.id, variant: "original", entry: answer.ref.entry, ticket: answer.ticket }), id: answer.ref.id };
  }, { timeout: 60_000, what: `a ticket for ${file.slice(-12)}` });
}

beforeAll(async () => {
  for (const [name, type] of ENGINES) {
    try { await (await type.launch({ headless: true })).close(); launches.add(name); } catch { report[`${name}Skipped`] = "not installed"; }
  }
  media = mkdtempSync(join(TMP, "peer-content-"));
  const t0 = Date.now();
  files = { video: join(media, "clip.mp4"), pdf: join(media, "doc.pdf"), bad: join(media, "bad.mp4"), unread: join(media, "later.mp4"), video2: join(media, "clip2.mp4") };
  makeVideo(files.video);
  makeVideo(files.bad, 6, 660);
  makeVideo(files.unread, 4, 880);
  makePdf(files.pdf, 100);
  report.media = { videoBytes: statSync(files.video).size, pdfBytes: statSync(files.pdf).size, pdfPages: 100, badBytes: statSync(files.bad).size, madeMs: Date.now() - t0 };
  cluster = await startServers({ name: "peer-content", count: 2, env: { A: PEER_ENV, B: { ...PEER_ENV, BOTLING_SERVER_TEST_CORRUPT_CONTENT: sha(files.bad) } } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 31);
  pb = await cluster.proxy(b, "websocket", 32);
  const made = await makeCluster([ka, kb]);
  clusterId = made.clusterId;
  writeStatements(a.dataDir, clusterId, [...made.statements, await profile(clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, clusterId, [...made.statements, await profile(clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  // B's bot and one line showing every file (the fake engine's /say).
  const client = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Renderer", job: "peer content test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  const text = `/say Rendered: ![clip](${pathToFileURL(files.video).href}) ![doc](${pathToFileURL(files.pdf).href}) ![bad](${pathToFileURL(files.bad).href}) ![later](${pathToFileURL(files.unread).href})`;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}`, "chat.send on B");
  lineB = await until(() => withDb(b, (db) => (db.prepare("SELECT msgId, body FROM messages WHERE botId = ? ORDER BY seq").all(botB) as Array<{ msgId: string; body: string }>).find((row) => { const m = JSON.parse(row.body) as { role?: string; text?: string }; return m.role !== "user" && String(m.text ?? "").includes("![later]"); })?.msgId ?? null), { timeout: 30_000, what: "the bot's line on B" });
  client.close();
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });

  // A phone paired at A; B learns it by gossip.
  const clientA = await a.client("pairing", "a".repeat(32));
  const paired = await pairPhone(clientA, a.port);
  keys = paired.keys;
  clientA.close();
  await until(() => rosterIds(b).includes(paired.addId), { timeout: 30_000, what: "the phone's Add at B" });
  phoneA = await PhoneSession.open(keys, a.port, server(ka), clusterId);
  await until(() => phoneA.welcomed, { what: "the phone welcomed at A" });
  report.setupMs = Date.now() - t0;
}, 300_000);

afterAll(async () => {
  phoneA?.close();
  for (const s of [a, b]) if (s) report[`log${s.name}`] = s.log.split("\n").filter((line) => /peer content|content:/.test(line)).slice(-40);
  await cluster?.cleanup();
  if (media) rmSync(media, { recursive: true, force: true });
  writeReport("step-10-peer-content", report);
}, 60_000);

interface Logged { at: number; url: string; range: string | null; status?: number }

async function open(type: BrowserType): Promise<{ browser: Browser; page: Page; log: Logged[] }> {
  const browser = await type.launch({ headless: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOTLING_"))) as Record<string, string> });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, bypassCSP: true });
  const page = await context.newPage();
  const log: Logged[] = [];
  context.on("request", (request) => {
    if (!request.url().includes("/v3/c/")) return;
    const entry: Logged = { at: Date.now(), url: request.url().replace(/([?&]t=)[^&]*/, "$1<ticket>"), range: null };
    log.push(entry);
    void request.headerValue("range").then((range) => { entry.range = range; }, () => undefined);
    void request.response().then((response) => { if (response) entry.status = response.status(); }, () => undefined);
  });
  // A page on A's origin (the listener's own 404 is enough): the ticketed URLs are same-origin there.
  await page.goto(`http://127.0.0.1:${a.port}/v3/peer-content-test`);
  return { browser, page, log };
}

type Played = { loadeddataMs: number; playingMs: number; width: number; error?: string };
const play = (page: Page, src: string) => page.evaluate((src) => new Promise<Played>((resolve) => {
  document.querySelector("video")?.remove();
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto";
  document.body.append(v);
  const start = performance.now();
  const out: Played = { loadeddataMs: -1, playingMs: -1, width: 0 };
  const done = () => { if (out.loadeddataMs >= 0 && out.playingMs >= 0) { out.width = v.videoWidth; resolve(out); } };
  v.addEventListener("loadeddata", () => { out.loadeddataMs = performance.now() - start; done(); });
  v.addEventListener("playing", () => { out.playingMs = performance.now() - start; done(); });
  v.addEventListener("error", () => resolve({ ...out, error: `media error ${v.error?.code}` }));
  v.src = src;
  void v.play().catch(() => undefined);
  setTimeout(() => resolve({ ...out, error: "timeout" }), 30_000);
}), src);
const seek = (page: Page, to: number) => page.evaluate((to) => new Promise<{ seekedMs: number; time: number; error?: string }>((resolve) => {
  const v = document.querySelector("video") as HTMLVideoElement;
  const start = performance.now();
  v.addEventListener("seeked", () => resolve({ seekedMs: performance.now() - start, time: v.currentTime }), { once: true });
  v.currentTime = to;
  setTimeout(() => resolve({ seekedMs: -1, time: v.currentTime, error: "timeout" }), 30_000);
}), to);
const ranged = (page: Page, src: string, ranges: Array<string | null>) => page.evaluate(async ({ src, ranges }) => Promise.all(ranges.map(async (range) => {
  const start = performance.now();
  const response = await fetch(src, { headers: range ? { range } : {}, cache: "no-store" });
  const body = new Uint8Array(await response.arrayBuffer());
  return { range, status: response.status, ms: performance.now() - start, why: response.headers.get("x-botling-content"), type: response.headers.get("content-type"), contentRange: response.headers.get("content-range"), hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body))).map((x) => x.toString(16).padStart(2, "0")).join(""), length: body.length };
})), { src, ranges });
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const ready = ENGINES.length > 0 && spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!ready)("M3 step 10: B's content through A (headless, two real botlingd)", () => {
  let video: { url: string; id: string };
  let pdf: { url: string; id: string };
  let bad: { url: string; id: string };
  let unread: { url: string; id: string };

  it("the phone at A gets A's tickets for B's files (A asks B)", async () => {
    const t = Date.now();
    video = await locate(files.video);
    pdf = await locate(files.pdf);
    bad = await locate(files.bad);
    unread = await locate(files.unread);
    expect(video.id).toBe(sha(files.video));
    expect(bad.id).toBe(sha(files.bad));
    report.locateMs = Date.now() - t;
    for (const s of [a, b]) s.assertLoopbackOnly({ expectListener: true });
  }, 120_000);

  for (const [engine, type] of ENGINES) {
    it(`${engine}: the video plays from A and seeks without a read from 0; the PDF's ranges load; a corrupted chunk is refused`, async (ctx) => {
      if (!launches.has(engine)) ctx.skip();
      const result: Record<string, unknown> = {};
      report[engine] = result;
      const { browser, page, log } = await open(type);
      try {
        const size = statSync(files.video).size;
        const played = await play(page, video.url);
        expect(played.error, JSON.stringify(played)).toBeUndefined();
        expect(played.width).toBe(854);
        await page.waitForTimeout(800);
        const before = log.length;
        const sought = await seek(page, 18);
        expect(sought.error, JSON.stringify(sought)).toBeUndefined();
        expect(sought.time).toBeGreaterThan(17);
        await page.waitForTimeout(800);
        const after = log.slice(before);
        const fromZero = (e: Logged) => e.range === null || /^bytes=0-/.test(e.range);
        expect(after.filter(fromZero), JSON.stringify(after)).toEqual([]);
        expect(log.every((e) => e.status === undefined || e.status === 200 || e.status === 206), JSON.stringify(log)).toBe(true);
        result.video = { bytes: size, played, seek: sought, requests: log.map(({ range, status }) => ({ range, status })) };

        // The PDF: head and trailer (what a viewer reads for page 1), then a middle range; the file's own bytes.
        const bytes = readFileSync(files.pdf);
        const mid = Math.floor(bytes.length / 2);
        const t = performance.now();
        const first = await ranged(page, pdf.url, ["bytes=0-65535", "bytes=-65536"]);
        const pageOneMs = performance.now() - t;
        const more = await ranged(page, pdf.url, [`bytes=${mid}-${mid + 262_143}`, null]);
        const expected = [bytes.subarray(0, 65_536), bytes.subarray(bytes.length - 65_536), bytes.subarray(mid, mid + 262_144), bytes];
        [...first, ...more].forEach((answer, i) => {
          expect(answer.status, String(answer.range)).toBe(answer.range ? 206 : 200);
          expect(answer.type).toBe("application/pdf");
          expect(answer.hash, String(answer.range)).toBe(hashOf(expected[i]!));
        });
        expect(pageOneMs).toBeLessThan(2_000);
        result.pdf = { bytes: bytes.length, pages: 100, pageOneMs: Math.round(pageOneMs), answers: [...first, ...more].map(({ range, status, ms, length }) => ({ range, status, ms: Math.round(ms), length })) };

        // The corrupted file: refused, never its bytes, in a fetch and in a <video>.
        const badBytes = readFileSync(files.bad);
        const refused = await ranged(page, bad.url, [null, "bytes=0-", `bytes=${MiB}-`]);
        for (const answer of refused) {
          expect(answer.status, String(answer.range)).toBe(502);
          expect(answer.why).toBe("refused; reason=chunk-hash");
          expect(answer.hash).not.toBe(hashOf(badBytes));
          expect(answer.length).toBeLessThan(200);
        }
        const badPlay = await play(page, bad.url);
        expect(badPlay.error, JSON.stringify(badPlay)).toMatch(/media error/);
        expect(badPlay.loadeddataMs).toBe(-1);
        result.corrupt = { answers: refused.map(({ range, status, why }) => ({ range, status, why })), video: badPlay };
      } finally {
        await browser.close();
      }
    }, 300_000);
  }

  it("B stopped: the video read before still plays and seeks from A's cache; the file never read answers 503", async () => {
    // Read the whole clip once through A (cached: it is below 1/4 of A's budget).
    const warm = await fetch(`http://127.0.0.1:${a.port}${video.url}`);
    expect(Buffer.from(await warm.arrayBuffer()).equals(readFileSync(files.video))).toBe(true);
    await until(() => withDb(a, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM chunk_cache WHERE id = ?").get(video.id) as { n: number }).n) >= Math.ceil(statSync(files.video).size / MiB) || null), { timeout: 15_000, what: "the clip's chunks in A's cache" });
    const cachedChunks = withDb(a, (db) => (db.prepare("SELECT COUNT(*) AS n FROM chunk_cache").get() as { n: number }).n);
    const badChunks = withDb(a, (db) => (db.prepare("SELECT COUNT(*) AS n FROM chunk_cache WHERE id = ?").get(bad.id) as { n: number }).n);
    expect(badChunks).toBe(0);
    await b.stop();
    await until(() => /peer \S+: (session ended|closed|unreachable|dead)/.test(a.log) || null, { timeout: 15_000, what: "A sees B gone" }).catch(() => undefined);
    const offline: Record<string, unknown> = { cachedChunks };
    report.offline = offline;
    for (const [engine, type] of ENGINES) {
      if (!launches.has(engine)) continue;
      const { browser, page } = await open(type);
      try {
        const played = await play(page, video.url);
        expect(played.error, `${engine}: ${JSON.stringify(played)}`).toBeUndefined();
        const sought = await seek(page, 20);
        expect(sought.error, `${engine}: ${JSON.stringify(sought)}`).toBeUndefined();
        const missing = await ranged(page, unread.url, [null, "bytes=0-"]);
        for (const answer of missing) expect(`${answer.status} ${answer.why}`).toBe("503 gone; reason=offline");
        const unreadPlay = await play(page, unread.url);
        expect(unreadPlay.error).toMatch(/media error/);
        offline[engine] = { played, seek: sought, unread: missing.map(({ range, status, why }) => ({ range, status, why })), unreadVideo: unreadPlay.error };
      } finally {
        await browser.close();
      }
    }
    expect(a.log).not.toMatch(/peer content: .*cached chunk .* no longer matches/);
    expect(b.log).toMatch(/content|peer/);
    expect(a.log).toMatch(/does not match its hash; refused/);
  }, 300_000);
});
