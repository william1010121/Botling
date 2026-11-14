// Acceptance check 9 helper (M1 brief §5): the content path through the real botlingd and the main-v3 content
// protocol, no window. A ~100 MB H.264 video (ffmpeg testsrc2, 1280×720, 60 s, faststart) is named by a bot's reply
// through the built botlingd (fake engine). Botling 3's window main, headless (main-v3 ServerClient on the socket),
// answers the renderer's own URL for it (`botling-chat://chat/attachment/<bot>/<file URL>?line=<id>`, built with
// contract/attachment-url.ts) through ContentProtocol.chatAttachment: content.find + content.open over the socket,
// then the byte ranges a <video> asks for. Timed: request → first body byte, and → 1 MiB read, for the opening range,
// a seek to the middle and one near the end (median of 7, first run separately), plus the very first request.
//
// Two placements: (clone) the video on the same APFS volume as the data folder (the line's pin is an APFS clone);
// (path) the video on the internal disk, the data folder on the external one (> 64 MiB, no clone: `pin: path` with
// chunk hashes). Then the file is rewritten in place: the old line must answer its own bytes (clone) or `changed`
// (path), never the new bytes; a new line naming the rewritten file serves the new bytes.
//
//   V3_ACCEPT_VIDEO (reuse an existing .mp4 instead of encoding one), V3_ACCEPT_RUNTIME=electron, V3_ACCEPT_REPORT_DIR
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentURL } from "../../src/contract/attachment-url";
import { ContentProtocol } from "../../src/main-v3/content-protocol";
import type { MessageOf, Slot } from "../../src/protocol";
import { until } from "../helpers";
import { Daemon, LoadSampler, MAIN, openWindow, removeTree, runtimeOf, ScriptClient, testRoot, writeReport } from "./m1-accept";

const MiB = 1 << 20;

function makeVideo(file: string): { ms: number; how: string } {
  const given = process.env.V3_ACCEPT_VIDEO;
  const t0 = Date.now();
  if (given) { copyFileSync(given, file); return { ms: Date.now() - t0, how: "copied from V3_ACCEPT_VIDEO" }; }
  const run = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "60",
    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "4", "-b:v", "13M", "-maxrate", "13M", "-bufsize", "26M", "-g", "60",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", file,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  return { ms: Date.now() - t0, how: "ffmpeg testsrc2 1280x720 60 s H.264 13 Mbit/s GOP 2 s faststart" };
}

function readRange(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, "r");
  try { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, start); return buf.subarray(0, n); } finally { closeSync(fd); }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };

/** One ranged request through the content protocol: status, ms to the first body byte, ms to `want` bytes, the bytes. */
async function timed(protocol: ContentProtocol, url: string, range: string, want: number) {
  const t0 = performance.now();
  const response = await protocol.chatAttachment(new URL(url), new Request(url, { headers: { range } }));
  if (!response) return { status: 0, first: NaN, until: NaN, bytes: Buffer.alloc(0), headers: {} };
  const reader = response.body?.getReader();
  const chunks: Buffer[] = [];
  let got = 0;
  let first = NaN;
  try {
    while (reader && got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      if (Number.isNaN(first)) first = performance.now() - t0;
      chunks.push(Buffer.from(value));
      got += value.byteLength;
    }
  } catch (error) {
    return { status: response.status, first, until: NaN, bytes: Buffer.concat(chunks), error: String((error as Error)?.message ?? error), headers: Object.fromEntries(response.headers) };
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  return { status: response.status, first: +first.toFixed(3), until: +(performance.now() - t0).toFixed(3), bytes: Buffer.concat(chunks).subarray(0, want), headers: Object.fromEntries(response.headers) };
}

async function scenario(label: "clone" | "path", root: string, videoDir: string, master: string) {
  const dataDir = join(root, `data-${label}`);
  mkdirSync(videoDir, { recursive: true });
  const video = join(videoDir, `clip-${label}.mp4`);
  copyFileSync(master, video);
  const size = statSync(video).size;
  const fileUrl = pathToFileURL(video).href;
  const daemon = new Daemon(dataDir);
  await daemon.ready();
  const client = new ScriptClient("accept");
  await client.connect(daemon.socket, daemon.token);
  await client.sub(client.srv);
  const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  const stream = `bot:${MAIN}`;
  await client.sub(stream);
  await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, "bot snap");
  let n = 0;
  const say = async (text: string) => {
    const slot: Slot = { origin: "accept", originEpoch: client.originEpoch, target: stream as Slot["target"], n: ++n };
    client.cmd(slot, { type: "chat.send", botId: MAIN, text }, srvSnap.logId);
    const result = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n, `result ${slot.n}`);
    const turnId = (result.outcome as { result?: { turnId?: string } }).result?.turnId;
    const finished = await until(() => client.entriesOf(stream).find((e) => e.kind === "turn.finished" && (e.body as { turnId: string }).turnId === turnId) ?? null, { timeout: 60_000, what: "turn" });
    return { line: (finished.body as { messageId: string }).messageId, at: performance.now() };
  };

  const window = await openWindow(dataDir, join(root, `app-${label}`));
  const protocol = new ContentProtocol({ link: () => window.client });
  const original = { head: readRange(video, 0, MiB), middle: readRange(video, Math.floor(size / 2), MiB), tail: readRange(video, size - MiB, MiB) };
  const old = await say(`/say Here is the clip: [clip](${fileUrl})`);
  const url = attachmentURL(MAIN, fileUrl, old.line);
  // The very first request, right after the line finished (the file may still be hashing).
  const veryFirst = await timed(protocol, url, "bytes=0-", 64 * 1024);
  const msAfterLine = +(performance.now() - old.at).toFixed(1);
  // Wait until the reference is ready (hashed), then time the ranges a <video> asks for.
  const ready = await until(async () => {
    const found = await client.content({ t: "content.find", botId: MAIN, line: old.line, url: fileUrl });
    return found.t === "content.found" && found.ref?.state === "ready" ? found : null;
  }, { timeout: 60_000, every: 50, what: "reference ready" }) as MessageOf<"content.found">;
  const opened = await client.content({ t: "content.open", owner: ready.ref!.owner, id: ready.ref!.id, variant: "original", entry: ready.ref!.entry }) as MessageOf<"content.file">;
  const ranges = {
    open64k: { range: "bytes=0-", want: 64 * 1024, expect: original.head.subarray(0, 64 * 1024) },
    open1m: { range: "bytes=0-", want: MiB, expect: original.head },
    seekMiddle: { range: `bytes=${Math.floor(size / 2)}-`, want: MiB, expect: original.middle },
    seekEnd: { range: `bytes=${size - MiB}-`, want: MiB, expect: original.tail },
  };
  const timings: Record<string, unknown> = {};
  for (const [name, r] of Object.entries(ranges)) {
    const runs = [];
    for (let i = 0; i < 8; i++) runs.push(await timed(protocol, url, r.range, r.want));
    const rest = runs.slice(1);
    timings[name] = {
      status: runs[0].status, bytesMatch: runs.every((x) => x.bytes.equals(r.expect)),
      firstRun: { firstByteMs: runs[0].first, untilMs: runs[0].until },
      median7: { firstByteMs: median(rest.map((x) => x.first)), untilMs: median(rest.map((x) => x.until)) },
      max7: { firstByteMs: Math.max(...rest.map((x) => x.first)), untilMs: Math.max(...rest.map((x) => x.until)) },
    };
  }
  const contentRange = (await timed(protocol, url, `bytes=${size - 10}-`, 10)).headers;

  // Rewrite the file in place: the first and middle MiB change, same size (a bot rendering the video again).
  const fd = openSync(video, "r+");
  writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, 0);
  writeSync(fd, Buffer.alloc(MiB, 0x5a), 0, MiB, Math.floor(size / 2));
  closeSync(fd);
  const oldHead = await timed(protocol, url, "bytes=0-", MiB);
  const oldMiddle = await timed(protocol, url, `bytes=${Math.floor(size / 2)}-`, MiB);
  const newBytes = Buffer.alloc(MiB, 0x5a);
  const fresh = await say(`/say Rendered again: [clip](${fileUrl})`);
  const freshUrl = attachmentURL(MAIN, fileUrl, fresh.line);
  await until(async () => {
    const found = await client.content({ t: "content.find", botId: MAIN, line: fresh.line, url: fileUrl });
    return found.t === "content.found" && found.ref?.state === "ready" ? found : null;
  }, { timeout: 60_000, every: 50, what: "new reference ready" });
  const newHead = await timed(protocol, freshUrl, "bytes=0-", MiB);
  const oldAgain = await timed(protocol, url, "bytes=0-", MiB);
  await window.client.stop();
  client.close();
  expect((await daemon.stop()).code).toBe(0);
  const verdict = (r: Awaited<ReturnType<typeof timed>>, expectOld: Buffer) =>
    r.status === 410 ? "changed (410)" : r.bytes.equals(expectOld) ? "old bytes" : r.bytes.subarray(0, 64).equals(newBytes.subarray(0, 64)) ? "NEW BYTES" : `other (${r.status}${r.error ? `, ${r.error}` : ""}, ${r.bytes.length} B)`;
  return {
    label, videoBytes: size, pin: opened.pin, contentType: opened.type, veryFirstRequest: { status: veryFirst.status, firstByteMs: veryFirst.first, msAfterLineFinished: msAfterLine },
    ranges: timings, tailHeaders: { status: contentRange["content-range"] ?? null, acceptRanges: contentRange["accept-ranges"] ?? null },
    afterRewrite: { oldLineHead: verdict(oldHead, original.head), oldLineMiddle: verdict(oldMiddle, original.middle), oldLineAfterNewLine: verdict(oldAgain, original.head), newLineServesNewBytes: newHead.bytes.equals(newBytes) },
  };
}

describe("acceptance check 9 (helper): video through botlingd + main-v3 content protocol", () => {
  it("first ranges and seeks of a ~100 MB local video; a rewritten file's old line serves its own bytes or changed", async () => {
    const root = testRoot("v3-accept-content");
    const internal = mkdtempSync(join(tmpdir(), "v3-accept-content-"));
    const load = new LoadSampler().start();
    const report: Record<string, unknown> = { runtime: runtimeOf() };
    try {
      const master = join(root, "master.mp4");
      report.video = { ...makeVideo(master), bytes: statSync(master).size };
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_name,width,height", "-of", "json", master], { encoding: "utf8" });
      if (probe.status === 0) report.ffprobe = JSON.parse(probe.stdout);
      report.clone = await scenario("clone", root, join(root, "videos"), master);
      report.path = await scenario("path", root, internal, master);
    } finally {
      report.load = load.stop();
      console.log(`report: ${writeReport(`content-${runtimeOf()}`, report)}`);
      removeTree(root);
      removeTree(internal);
      expect(existsSync(internal)).toBe(false);
    }
    const clone = report.clone as Awaited<ReturnType<typeof scenario>>;
    const path = report.path as Awaited<ReturnType<typeof scenario>>;
    expect(clone.pin).toBe("clone");
    expect(path.pin).toBe("path");
    for (const s of [clone, path]) {
      for (const r of Object.values(s.ranges) as Array<{ status: number; bytesMatch: boolean; median7: { untilMs: number } }>) {
        expect(r.status).toBe(206);
        expect(r.bytesMatch).toBe(true);
        expect(r.median7.untilMs).toBeLessThan(300);
      }
      expect(s.afterRewrite.newLineServesNewBytes).toBe(true);
      for (const v of [s.afterRewrite.oldLineHead, s.afterRewrite.oldLineMiddle, s.afterRewrite.oldLineAfterNewLine]) expect(v).not.toBe("NEW BYTES");
    }
    expect(clone.afterRewrite.oldLineHead).toBe("old bytes");
  });
});
