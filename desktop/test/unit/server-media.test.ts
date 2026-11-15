// Media jobs on the owner (M2 step 10, protocol v1 §9A.5, §9A.8, §9A.9, D42). Integration with real tools: the clips are
// made by ffmpeg at test time in a temp folder (on the external SSD when present) and deleted afterwards.
// - video: meta, a poster ≤ 640 px, a preview only when the §9A.5 rule says (≤ 720p, keyframe ≈ 2 s, fragmented: ffprobe
//   checks), `content.variant` entries, variants served through `/v3/c/` with the same ticket checks as the original;
// - images and PDFs: thumbnails, the page count, a linearized copy (threshold lowered in the test);
// - SIGKILL during a job: the job runs again at the next start, the leftover tool is stopped, exactly one row and one
//   `content.variant` entry per variant;
// - ffmpeg hidden from PATH: no preview, the original still plays, the job note and the status note say why;
// - LRU above the cap (cap lowered): the least recently used variants are evicted; asking for one makes it again.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentUrlPath, type StreamId } from "../../src/protocol";
import { ContentService } from "../../src/server/content";
import { mediaLoaderRefusal, RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { ensureStream } from "../../src/server/log";
import { findOnPath, findTools, MediaJobs, previewReason, type MediaJobsOptions } from "../../src/server/media";
import { mp4Meta } from "../../src/server/media/mp4";
import { serverNotes } from "../../src/server/notes";
import { openReaderDb, openServerStore, type ServerStore } from "../../src/server/store";

const BOT = "media";
const STREAM = `bot:${BOT}` as StreamId;
const FFMPEG = findOnPath("ffmpeg", process.env.PATH);
const FFPROBE = findOnPath("ffprobe", process.env.PATH);
const HAVE = !!FFMPEG && !!FFPROBE;
const base = process.env.BOTLING_TEST_TMP || (existsSync("/Volumes/My-SSD/botling-work") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());

let root: string;
let clips: string;
const clip = { hi: "", lo: "", image: "", pdf: "" };

function ff(args: string[]): void {
  const run = spawnSync(FFMPEG!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", timeout: 120_000 });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${run.stderr}`);
}
function probe(file: string, args: string[]): string {
  const run = spawnSync(FFPROBE!, ["-v", "error", ...args, file], { encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) throw new Error(`ffprobe: ${run.stderr}`);
  return run.stdout;
}
function streams(file: string): Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> {
  return (JSON.parse(probe(file, ["-print_format", "json", "-show_streams"])) as { streams: never[] }).streams;
}

/** A small valid PDF with `pages` text pages and a correct cross-reference table. */
function makePdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

beforeAll(() => {
  if (!HAVE) return;
  root = mkdtempSync(join(base, "botling-media-"));
  clips = join(root, "clips");
  mkdirSync(clips);
  clip.hi = join(clips, "hi.mp4");
  clip.lo = join(clips, "lo.mp4");
  clip.image = join(clips, "photo.png");
  clip.pdf = join(clips, "doc.pdf");
  // 12 s 720p H.264 + AAC at ~3 Mbit/s with keyframes every 10 s: the §9A.5 rule asks for a preview (bitrate).
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3M", "-maxrate", "3M", "-bufsize", "6M", "-g", "300", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", clip.hi]);
  // 12 s 320×240 H.264 + AAC at ~0.3 Mbit/s: plays everywhere, no preview.
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=12", "-f", "lavfi", "-i", "sine=frequency=330:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "250k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-shortest", clip.lo]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1600x1000:rate=1:duration=1", "-frames:v", "1", clip.image]);
  writeFileSync(clip.pdf, makePdf(12));
}, 120_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let dataDir: string;
let store: ServerStore;
let content: ContentService;
let media: MediaJobs;
const tickets = new ContentTickets();
const DEVICE = "device-a";
const remote = () => new RemoteContent({ service: content, tickets, roster: { device: (member) => (member === DEVICE ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) } });

async function open(options: Partial<MediaJobsOptions> = {}): Promise<void> {
  dataDir = mkdtempSync(join(root, "data-"));
  store = await openServerStore(dataDir);
  await store.submit((db) => ensureStream(db, STREAM));
  content = new ContentService({ store, dataDir, serverId: store.meta("serverId")! });
  media = new MediaJobs({ store, dataDir, ...options });
  content.attachMedia(media);
  await content.recover();
  await media.start();
}

async function closeAll(): Promise<void> {
  await media?.close();
  await content?.close();
  await store?.close();
}

let lineNo = 0;
/** Posts a finished line naming `files`; resolves when their hashes are ready and the media queue is empty. */
async function post(...files: string[]): Promise<{ seq: number; ids: string[] }> {
  const id = `line-${++lineNo}`;
  const text = files.map((file) => `![f](${pathToFileURL(file).href})`).join(" ");
  const message = { id, role: "bot", text, time: "2026-11-15T00:00:00.000Z", state: "done" };
  const { entries, ready } = await content.appendLine(STREAM, BOT, { id, text }, [{ kind: "message.added", body: { botId: BOT, message } }]);
  const done = await ready;
  await media.idle();
  return { seq: entries[0]!.seq, ids: done.map((entry) => (entry.body as { ref: { id: string } }).ref.id) };
}

const rows = (sql: string, ...params: Array<string | number>) => {
  const reader = store.openReader();
  try { return reader.prepare(sql).all(...params); } finally { reader.close(); }
};
const variantRows = (srcId: string) => rows("SELECT variant, id, state, path, size, type, info FROM variants WHERE srcId = ? ORDER BY variant", srcId);
const variantEntries = () => rows("SELECT body FROM entries WHERE stream = ? AND kind = 'content.variant' ORDER BY seq", STREAM)
  .map((row) => JSON.parse(String(row.body)) as { id: string; variant: { name: string; id: string; size: number; type: string; bitrate?: number; height?: number; durationMs?: number } });

/** GET a variant through `/v3/c/` with a ticket for (device, owner, src id, entry). */
async function fetchVariant(srcId: string, seq: number, variant: string, range?: string, ticket?: string) {
  const owner = content.serverId;
  const entry = { stream: STREAM, seq };
  const t = ticket ?? tickets.issue({ deviceId: DEVICE, owner, id: srcId, entry }).ticket;
  const path = contentUrlPath({ owner, id: srcId, variant, entry, ticket: t });
  return remote().respond(path, new Request(`http://127.0.0.1${path}`, { headers: range ? { range } : {} }));
}

describe.skipIf(!HAVE)("media jobs (ffmpeg found)", () => {
  beforeEach(async () => { await open(); });
  afterEach(async () => { await closeAll(); });

  it("video: meta, poster ≤ 640 px, a preview only when the §9A.5 rule says (≤ 720p, keyframe ≈ 2 s, fragmented)", async () => {
    const { seq, ids } = await post(clip.hi, clip.lo);
    const [hi, lo] = ids as [string, string];
    expect(media.jobs().map((job) => [job.kind, job.state])).toEqual([["video", "done"], ["video", "done"]]);

    // The poster of each: a JPEG frame ≤ 640 px.
    for (const id of [hi, lo]) {
      const poster = variantRows(id).find((row) => row.variant === "poster")!;
      expect(poster).toMatchObject({ state: "ready", type: "image/jpeg" });
      const [video] = streams(String(poster.path));
      expect(Math.max(video!.width!, video!.height!)).toBeLessThanOrEqual(640);
      expect(Number(poster.size)).toBeLessThan(200_000);
    }

    // The rule: hi (3 Mbit/s) gets a preview, lo (0.3 Mbit/s, H.264 + AAC) does not.
    expect(variantRows(lo).map((row) => row.variant)).toEqual(["poster"]);
    const preview = variantRows(hi).find((row) => row.variant === "preview")!;
    expect(preview).toMatchObject({ state: "ready", type: "video/mp4" });
    const file = String(preview.path);
    const kinds = streams(file);
    const v = kinds.find((s) => s.codec_type === "video")!;
    expect(v.codec_name).toBe("h264");
    expect(v.height).toBeLessThanOrEqual(720);
    expect(kinds.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
    // Keyframes every ≈ 2 s (ffprobe, key frames only).
    const keys = probe(file, ["-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0"])
      .trim().split("\n").map((text) => Number.parseFloat(text)).filter(Number.isFinite);
    const gaps = keys.slice(1).map((t, i) => t - keys[i]!);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const gap of gaps.slice(0, -1)) expect(Math.abs(gap - 2)).toBeLessThanOrEqual(0.15);
    // Fragmented: ffprobe's trace shows movie fragments (moof) and an empty moov (frag_keyframe+empty_moov).
    const trace = spawnSync(FFPROBE!, ["-v", "trace", "-i", file], { encoding: "utf8" }).stderr;
    expect(trace).toMatch(/type:'moof'/);
    expect(trace).toMatch(/type:'mvex'/);
    const info = JSON.parse(String(preview.info)) as { encoder: string; bitrate: number };
    expect(info.bitrate).toBeLessThan(1_600_000);

    // content.variant entries: the original (bitrate, height for the FE's 1.5× rule), each poster, the one preview.
    const announced = variantEntries().map((e) => `${e.id === hi ? "hi" : "lo"}:${e.variant.name}`).sort();
    expect(announced).toEqual(["hi:original", "hi:poster", "hi:preview", "lo:original", "lo:poster"]);
    const original = variantEntries().find((e) => e.id === hi && e.variant.name === "original")!.variant;
    expect(original.bitrate).toBeGreaterThan(1_500_000);
    expect(original.height).toBe(720);
    // Step 11: the duration rides on the original variant (additive `durationMs`), for the poster.
    expect(Math.abs(original.durationMs! - 12_000)).toBeLessThan(200);
    // …and `content.located` lists the variants the owner holds now, with the size (a page that missed the entries).
    const described = content.describe(hi)!;
    expect(described.size).toBe(statSync(clip.hi).size);
    expect(described.variants.map((v) => v.name)).toEqual(["original", "poster", "preview"]);
    expect(described.variants[0]).toMatchObject({ bitrate: original.bitrate, height: 720, durationMs: original.durationMs });
    expect(content.describe(lo)!.variants.map((v) => v.name)).toEqual(["original", "poster"]);
    expect(previewReason({ bitrate: 300_000, container: "mov,mp4", videoCodec: "h264", audioCodec: "aac" }, 1e6, "video/mp4")).toBeNull();
    expect(previewReason({ bitrate: 300_000, container: "matroska,webm", videoCodec: "vp9", audioCodec: "opus" }, 1e6, "video/webm")).toMatch(/not MP4/);
    expect(previewReason({ bitrate: 300_000, container: "mov,mp4", videoCodec: "hevc", audioCodec: "aac" }, 1e6, "video/mp4")).toMatch(/not H.264/);
    expect(previewReason(null, 60e6, "video/mp4")).toMatch(/50 MB/);
    // Without ffprobe the MP4 index read in JavaScript gives the same facts.
    expect(mp4Meta(clip.hi)).toMatchObject({ container: "mov,mp4", videoCodec: "h264", audioCodec: "aac", width: 1280, height: 720 });
    expect(Math.abs(mp4Meta(clip.hi)!.duration! - 12)).toBeLessThan(0.2);
    expect(mp4Meta(clip.pdf)).toBeNull();

    // Served through /v3/c/ with the same ticket checks as the original.
    const bytes = readFileSync(file);
    const ranged = await fetchVariant(hi, seq, "preview", "bytes=0-1023");
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-1023/${bytes.length}`);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(0, 1024))).toBe(true);
    const poster = await fetchVariant(hi, seq, "poster");
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
    expect((await fetchVariant(lo, seq, "preview")).status).toBe(410); // not made: the FE plays the original
    // Step 11: the same refusal to WebKit's media loader (X-Playback-Session-Id + Range) is an empty 200 that keeps the
    // reason, which ends its retry loop; anyone else still gets the 410.
    const loader = mediaLoaderRefusal(await fetchVariant(lo, seq, "preview", "bytes=5000-"), { "x-playback-session-id": "S", range: "bytes=5000-" });
    expect(loader.status).toBe(200);
    expect(loader.headers.get("x-botling-status")).toBe("410");
    expect(loader.headers.get("content-range")).toBeNull();
    expect((await loader.arrayBuffer()).byteLength).toBe(0);
    expect(mediaLoaderRefusal(await fetchVariant(lo, seq, "preview", "bytes=5000-"), { range: "bytes=5000-" }).status).toBe(410);
    expect(mediaLoaderRefusal(await fetchVariant(hi, seq, "preview", "bytes=0-9"), { "x-playback-session-id": "S", range: "bytes=0-9" }).status).toBe(206);
    // The loader's opening probe keeps the real status: WebKit then fires the element's error at once, with no storm.
    const opening = mediaLoaderRefusal(await fetchVariant(lo, seq, "preview", "bytes=0-1"), { "x-playback-session-id": "S", range: "bytes=0-1" });
    expect(opening.status).toBe(410);
    expect((await fetchVariant(hi, seq, "preview", undefined, "x".repeat(43))).status).toBe(403); // unknown ticket
    // A ticket for lo does not open hi's preview (binding), and an entry that does not reference hi is refused.
    const loTicket = tickets.issue({ deviceId: DEVICE, owner: content.serverId, id: lo, entry: { stream: STREAM, seq } }).ticket;
    expect((await fetchVariant(hi, seq, "preview", undefined, loTicket)).status).toBe(403);
    expect((await fetchVariant(hi, 999, "preview")).status).toBe(404);
  }, 120_000);

  it("image and PDF: thumbnails ≤ 512 px, the page count, a linearized copy above the (lowered) threshold", async () => {
    await closeAll();
    await open({ linearizeAboveBytes: 1_000 });
    const { ids } = await post(clip.image, clip.pdf);
    const [image, pdf] = ids as [string, string];
    const thumb = variantRows(image).find((row) => row.variant === "thumb")!;
    expect(thumb).toMatchObject({ state: "ready", type: "image/jpeg" });
    const [s] = streams(String(thumb.path));
    expect(Math.max(s!.width!, s!.height!)).toBeLessThanOrEqual(512);
    const pdfVariants = variantRows(pdf);
    expect(pdfVariants.map((row) => row.variant)).toEqual(["linearized", "text", "thumb"]);
    const [p] = streams(String(pdfVariants.find((row) => row.variant === "thumb")!.path));
    expect(Math.max(p!.width!, p!.height!)).toBeLessThanOrEqual(512);
    const meta = rows("SELECT meta FROM content_meta WHERE id = ?", pdf)[0];
    if (media.tools.paths.qpdf) {
      expect(JSON.parse(String(meta!.meta))).toEqual({ pages: 12 });
      const linear = String(pdfVariants.find((row) => row.variant === "linearized")!.path);
      expect(spawnSync(media.tools.paths.qpdf, ["--check-linearization", linear], { encoding: "utf8" }).stdout).toMatch(/no linearization errors/);
    }
  }, 60_000);

  it("LRU: above the cap the least recently used variants are evicted; asking for one makes it again", async () => {
    await closeAll();
    await open({ capBytes: 60_000 });
    const { seq, ids } = await post(clip.lo);
    const lo = ids[0]!;
    const loPoster = variantRows(lo)[0]!;
    expect(loPoster.state).toBe("ready");
    const { ids: [hi] } = await post(clip.hi);
    // hi's poster then its preview (MBs) were made: the cap keeps only the newest; lo's poster and hi's poster went.
    const ready = rows("SELECT srcId, variant, size FROM variants WHERE state = 'ready'");
    expect(ready.map((row) => `${row.srcId === hi ? "hi" : "lo"}:${row.variant}`)).toEqual(["hi:preview"]);
    const evicted = rows("SELECT srcId, variant, path FROM variants WHERE state = 'evicted' ORDER BY variant, srcId");
    expect(evicted.map((row) => `${row.srcId === hi ? "hi" : "lo"}:${row.variant}`).sort()).toEqual(["hi:poster", "lo:poster"]);
    expect(evicted.every((row) => row.path === null)).toBe(true);
    expect(existsSync(String(loPoster.path))).toBe(false);
    // One row per variant still; asking for lo's poster answers "not there" and queues its job again.
    expect((await fetchVariant(lo, seq, "poster")).status).toBe(410);
    await media.idle();
    expect(variantRows(lo).map((row) => [row.variant, row.state])).toEqual([["poster", "ready"]]);
    expect((await fetchVariant(lo, seq, "poster")).status).toBe(200);
    const total = rows("SELECT SUM(size) AS n FROM variants WHERE state = 'ready'")[0]!.n;
    expect(Number(total)).toBeLessThanOrEqual(60_000 + Number(statSync(String(variantRows(lo)[0]!.path)).size));
  }, 120_000);
});

describe.skipIf(!HAVE)("media jobs without ffmpeg on PATH", () => {
  afterEach(async () => { await closeAll(); });

  it("makes no preview; the original plays; the job and the status say why", async () => {
    const tools = findTools({ path: "/usr/bin:/bin:/usr/sbin:/sbin" });
    expect(tools.paths.ffmpeg).toBeNull();
    await open({ tools });
    const { seq, ids } = await post(clip.hi);
    const hi = ids[0]!;
    expect(variantRows(hi).some((row) => row.variant === "preview")).toBe(false);
    const job = media.jobs()[0]!;
    expect(job.state).toBe("done");
    expect(job.note).toMatch(/no preview \(the original is above 1\.5 Mbit\/s.*ffmpeg is not on botlingd's PATH, so the original plays/);
    // The original still plays (206), the preview is "not there" (the FE keeps the original).
    expect((await fetchVariant(hi, seq, "original", "bytes=0-99")).status).toBe(206);
    expect((await fetchVariant(hi, seq, "preview")).status).toBe(410);
    // Status (botlingd status reads server.db): the media note.
    const reader = openReaderDb(join(dataDir, "server.db"));
    try {
      const notes = serverNotes(dataDir, reader).filter((note) => note.id === "media-tools");
      expect(notes.map((note) => note.text).join("\n")).toMatch(/ffmpeg is not on botlingd's PATH: videos get no preview, so the original plays/);
    } finally { reader.close(); }
  }, 120_000);
});

describe.skipIf(!HAVE)("SIGKILL during a media job", () => {
  const script = () => {
    const out = join(root, "child.cjs");
    if (!existsSync(out)) {
      buildSync({ entryPoints: [join(__dirname, "../fixtures/server-media-crash-child.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["better-sqlite3"], logLevel: "silent" });
    }
    return out;
  };

  function child(dataDir: string, killAt: string | null) {
    return new Promise<{ steps: string[]; signal: string | null; stderr: string; idle: boolean }>((resolve, reject) => {
      const proc = spawn(process.execPath, ["--no-warnings", script(), dataDir, clip.hi], { stdio: ["ignore", "pipe", "pipe"], cwd: join(__dirname, "../..") });
      const steps: string[] = [];
      let idle = false;
      let buffer = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("step ")) {
            steps.push(line.slice(5));
            // Kill while the step's tool runs: once its pid file is written (the tool started), 100 ms later.
            if (line.slice(5) === killAt) {
              const pidFile = join(dataDir, "variants", ".tmp", "tool.pid");
              const poll = setInterval(() => {
                if (!existsSync(pidFile)) return;
                clearInterval(poll);
                setTimeout(() => proc.kill("SIGKILL"), 100);
              }, 10);
              proc.once("close", () => clearInterval(poll));
            }
          }
          if (line === "idle") idle = true;
        }
      });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      proc.on("error", reject);
      proc.on("close", (_code, signal) => resolve({ steps, signal, stderr, idle }));
    });
  }

  it("the job runs again at the next start and leaves exactly one row and one entry per variant", async () => {
    const dir = mkdtempSync(join(root, "crash-"));
    const first = await child(dir, "video:preview");
    expect(first.stderr).toBe("");
    expect(first.signal).toBe("SIGKILL");
    expect(first.steps).toEqual(["video:meta", "video:poster", "video:preview"]);
    // The killed server left its ffmpeg (SIGKILL does not reach children) and a pid file naming it.
    const pidFile = join(dir, "variants", ".tmp", "tool.pid");
    const leftover = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").split(" ")[0]) : null;
    {
      const db = openReaderDb(join(dir, "server.db"));
      try {
        expect(db.prepare("SELECT state FROM media_jobs").all().map((row) => row.state)).toEqual(["running"]);
        expect(db.prepare("SELECT variant FROM variants WHERE state = 'ready'").all().map((row) => row.variant)).toEqual(["poster"]);
      } finally { db.close(); }
    }
    const second = await child(dir, null);
    expect(second.stderr).toBe("");
    expect(second.idle).toBe(true);
    // Meta and the poster were kept: only the preview ran again.
    expect(second.steps).toEqual(["video:preview"]);
    if (leftover) expect(() => process.kill(leftover, 0)).toThrow();
    const db = openReaderDb(join(dir, "server.db"));
    try {
      expect(db.prepare("SELECT state, tries FROM media_jobs").all()).toEqual([{ state: "done", tries: 2 }]);
      const variants = db.prepare("SELECT variant, state, path FROM variants ORDER BY variant").all();
      expect(variants.map((row) => [row.variant, row.state])).toEqual([["poster", "ready"], ["preview", "ready"]]);
      for (const row of variants) expect(existsSync(String(row.path))).toBe(true);
      const names = db.prepare("SELECT body FROM entries WHERE kind = 'content.variant'").all().map((row) => (JSON.parse(String(row.body)) as { variant: { name: string } }).variant.name);
      expect(names.sort()).toEqual(["original", "poster", "preview"]);
      // No temp file and no file outside the rows.
      expect(readdirSync(join(dir, "variants", ".tmp"))).toEqual([]);
      const src = String(db.prepare("SELECT srcId FROM variants LIMIT 1").get()!.srcId).slice(7);
      expect(readdirSync(join(dir, "variants", src)).sort()).toEqual(["poster.jpg", "preview.mp4"]);
    } finally { db.close(); }
  }, 180_000);
});
