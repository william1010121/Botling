// M2 step 12: uploads from the phone page, in headless Chromium and headless WebKit against a real botlingd (fake
// engine, loopback listener, the built page web-v3/dist). The page is reached through a small TCP proxy in this file
// that limits what the page sends (so a 50 MB upload takes seconds on loopback) and can cut every connection.
// Per engine, one script:
//
//  1. pair by pasted link + code (as step 8);
//  2. a 50 MB file picked with the composer's `+` (the page's own file input) and a message sent at once: the
//     `chat.send` is `held` on the server while the bytes come in (the server's chat has no such line while the part
//     is incomplete), then applied once;
//  3. meanwhile, with 20 MB in, every connection is cut: the page reconnects and goes on from what the server has
//     (a resume point > 0, the upload's second `content.put`), never from 0;
//  4. the bot sees the file where 2.x attachments go: the user line lists it under "(Attachments:" with a path in an
//     `attachments` folder, whose bytes hash to the upload's id;
//  5. a file whose bytes change after hashing (the page's reads patched for that one file) is refused by the server
//     (`content.gone{changed}`), the message naming it is not sent, and nothing of it is kept;
//  6. a 501 MB (sparse) file is refused on the page before anything is sent (no `content.put`).
// Test files are made at test time under the work disk's tmp and deleted afterwards.
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/upload.test.ts
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer, connect, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import { chatOf, PairCli, phone, say, Server, freePort } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const dist = join(desktop, "web-v3", "dist");
const MiB = 1 << 20;
/** Page → server through the proxy, bytes per second. */
const UP_RATE = 12 * MiB;
const report: Record<string, unknown> = {};
afterAll(() => { writeReport("step-12-upload", report); });

/** A TCP proxy in front of botlingd: page → server limited to `rate`; `cut()` drops every connection. */
class Proxy {
  private server: NetServer | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  upBytes = 0;
  constructor(private readonly target: number, private readonly rate: number) {}

  async start(port: number): Promise<void> {
    this.port = port;
    this.server = createServer((client) => {
      const upstream = connect(this.target, "127.0.0.1");
      this.sockets.add(client); this.sockets.add(upstream);
      const end = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", () => client.end());
      upstream.on("data", (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
      let queue: Buffer[] = [];
      let pumping = false;
      const pump = async () => {
        if (pumping) return;
        pumping = true;
        while (queue.length && !upstream.destroyed) {
          const chunk = queue.shift()!;
          for (let at = 0; at < chunk.length; at += 64 * 1024) {
            const piece = chunk.subarray(at, at + 64 * 1024);
            if (upstream.destroyed) { queue = []; break; }
            upstream.write(piece);
            this.upBytes += piece.length;
            await new Promise((resolve) => setTimeout(resolve, (piece.length / this.rate) * 1000));
          }
          if (queue.length < 8) client.resume();
        }
        pumping = false;
      };
      client.on("data", (chunk: Buffer) => {
        // Request heads: make the page's origin the server's (its WebSocket origin check).
        const text = chunk.subarray(0, Math.min(chunk.length, 8192)).toString("latin1");
        if (/^(GET|HEAD|POST) \//.test(text)) chunk = Buffer.from(chunk.toString("latin1").split(`127.0.0.1:${this.port}`).join(`127.0.0.1:${this.target}`), "latin1");
        queue.push(chunk);
        if (queue.length >= 8) client.pause();
        void pump();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
  }

  cut(): void { for (const socket of [...this.sockets]) socket.destroy(); this.sockets.clear(); }

  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
}

async function pairPage(page: Page, dataDir: string, origin: string): Promise<void> {
  const cli = new PairCli(dataDir);
  const link = await cli.link();
  await page.goto(`${origin}/v3/`);
  await page.getByLabel("Pairing link").fill(link);
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
  cli.type("y");
  await cli.line((l) => l.startsWith("Paired: "), "paired");
  await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
}

/** The composer's `+`, then the file chooser it opens (the page's own file input). */
async function pick(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
  await chatOf(page).locator(".composer button.plus").click();
  await (await chooser).setFiles(file);
}

interface UploadDiag { name: string; state: string; sent: number; size: number; id: string | null; puts: number; resumedAt: number[]; error?: string }
const uploadsOf = (page: Page): Promise<UploadDiag[]> => page.evaluate(() => Object.values(JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: { uploads?: unknown } }).botling3Diagnostics?.uploads ?? {}))) as UploadDiag[]);
const uploadNamed = async (page: Page, name: string) => (await uploadsOf(page)).find((u) => u.name === name);
const statesOf = (page: Page): Promise<Record<string, string[]>> => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: { states?: unknown } }).botling3Diagnostics?.states ?? {})) as Record<string, string[]>);

/** The server's upload folder: finished files and parts with their sizes. */
function uploadDir(dataDir: string): Record<string, number> {
  const dir = join(dataDir, "uploads");
  try { return Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).size])); } catch { return {}; }
}

/** Files under `dir` whose path matches. */
function findFiles(dir: string, test: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(path, test));
    else if (test.test(path)) out.push(path);
  }
  return out;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** A random file of `bytes` (written in 4 MiB pieces). */
function randomFile(file: string, bytes: number): void {
  const fd = openSync(file, "w");
  try { for (let at = 0; at < bytes; at += 4 * MiB) writeSync(fd, randomBytes(Math.min(4 * MiB, bytes - at))); } finally { closeSync(fd); }
}

async function run(engine: string, type: BrowserType) {
  const root = mkdtempSync(join(TMP, `upload-${engine}-`));
  const result: Record<string, unknown> = {};
  report[engine] = result;
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const big = join(root, "talk-50mb.mp4");
  const tampered = join(root, "tampered.pdf");
  const huge = join(root, "huge-501mb.mov");
  randomFile(big, 50 * 1_000_000);
  randomFile(tampered, 3 * MiB);
  // 501 MB of holes: no disk used.
  const fd = openSync(huge, "w"); ftruncateSync(fd, 501_000_000); closeSync(fd);
  const bigHex = sha256File(big);

  const server = new Server(dataDir, await freePort());
  const proxy = new Proxy(server.port, UP_RATE);
  let browser: Awaited<ReturnType<typeof phone>> | null = null;
  try {
    await server.ready();
    await proxy.start(await freePort());
    const origin = `http://127.0.0.1:${proxy.port}`;
    browser = await phone(type, join(root, "profile"));
    const { page, context } = browser;
    // Step 5's file: after its bytes were read once for hashing, the page reads its first MiB with one byte changed.
    await context.addInitScript(() => {
      const origin = new WeakMap<Blob, { name: string; start: number }>();
      const slice = Blob.prototype.slice;
      Blob.prototype.slice = function (this: Blob, start?: number, end?: number, contentType?: string) {
        const out = slice.call(this, start, end, contentType);
        if (this instanceof File && this.name === "tampered.pdf") origin.set(out, { name: this.name, start: start ?? 0 });
        return out;
      };
      const arrayBuffer = Blob.prototype.arrayBuffer;
      let firstReads = 0;
      Blob.prototype.arrayBuffer = async function (this: Blob) {
        const buffer = await arrayBuffer.call(this);
        const from = origin.get(this);
        if (from && from.start === 0 && ++firstReads > 1) new Uint8Array(buffer)[0] ^= 0xff;
        return buffer;
      };
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    // 1. Pair (through the proxy).
    await pairPage(page, dataDir, origin);

    // 2 + 3. 50 MB, the message sent at once; a cut at 20 MB.
    const t0 = Date.now();
    await pick(page, big);
    const text = `The talk ${engine} ${Date.now().toString(36)}`;
    await expect.poll(async () => (await uploadNamed(page, "talk-50mb.mp4"))?.state, { timeout: 30_000 }).toMatch(/waiting|uploading|done/);
    await say(page, text);
    const heldSeen: Array<{ at: number; part: number }> = [];
    let cutAt = 0;
    let earlyLine = false;
    for (;;) {
      // Held: no line of it on the server while its bytes are not all in (read the chat first, then the folder: a
      // file still incomplete after a line was there means the line came first).
      const lineThere = (await server.messages()).some((m) => m.text.includes(text));
      const files = uploadDir(dataDir);
      const done = files[bigHex] !== undefined;
      const part = files[`${bigHex}-${50_000_000}.part`] ?? 0;
      if (done) break;
      if (lineThere) earlyLine = true;
      heldSeen.push({ at: Date.now() - t0, part });
      if (!cutAt && part >= 20 * MiB) { cutAt = part; proxy.cut(); }
      if (Date.now() - t0 > 180_000) throw new Error(`the upload did not finish: ${JSON.stringify(files)} ${JSON.stringify(await uploadsOf(page))}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const uploadedMs = Date.now() - t0;
    expect(earlyLine).toBe(false);
    expect(cutAt).toBeGreaterThan(0);
    const states = await statesOf(page);
    const sendStates = Object.values(states).find((list) => list.includes("held"));
    await expect.poll(async () => (await server.messages()).filter((m) => m.role === "user" && m.text.includes(text)).length, { timeout: 60_000 }).toBe(1);
    const view = (await uploadNamed(page, "talk-50mb.mp4"))!;
    await expect.poll(async () => (await uploadNamed(page, "talk-50mb.mp4"))?.state, { timeout: 30_000 }).toBe("done");
    const finalView = (await uploadNamed(page, "talk-50mb.mp4"))!;
    expect(finalView.id).toBe(`sha256:${bigHex}`);
    expect(finalView.puts).toBeGreaterThanOrEqual(2);
    expect(finalView.resumedAt.length).toBeGreaterThanOrEqual(1);
    expect(finalView.resumedAt[0]).toBeGreaterThan(0);
    // Applied once (and still once a while later: the outbox does not send it again).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const lines = (await server.messages()).filter((m) => m.role === "user" && m.text.includes(text));
    expect(lines).toHaveLength(1);
    expect(sendStates ?? Object.values(await statesOf(page)).find((list) => list.includes("held"))).toBeDefined();
    result.big = {
      bytes: 50_000_000, uploadedMs, cutAtPart: cutAt, puts: finalView.puts, resumedAt: finalView.resumedAt, proxyUpBytes: proxy.upBytes,
      sendStates: sendStates ?? null, heldPolls: heldSeen.length, lineBeforeComplete: earlyLine, appliedLines: lines.length, viewAtLine: view.state,
    };

    // 4. The bot sees the file where 2.x attachments go.
    // The line shows it as an attachment; the bot's message lists its path ("(Attachments:\n- path)", 2.x keep()):
    // a copy named yyyyMMdd-HHmmss-<name> in the bot's attachments folder (the main bot: <its folder>/attachments).
    const line = lines[0]!;
    expect(line.attachments?.map((a) => a.name)).toEqual([expect.stringMatching(/talk-50mb\.mp4$/)]);
    const kept = findFiles(dataDir, /[/\\]attachments[/\\]\d{8}-\d{6}-talk-50mb\.mp4$/);
    expect(kept).toHaveLength(1);
    const path = kept[0]!;
    expect(statSync(path).size).toBe(50_000_000);
    expect(sha256File(path)).toBe(bigHex);
    result.attachment = { folder: path.split(/[/\\]/).slice(-2, -1)[0], name: path.split(/[/\\]/).pop(), sha256Matches: true, shown: line.attachments, lineText: line.text };
    // The incoming hard links are gone after the turn took them.
    await expect.poll(() => { try { return readdirSync(join(dataDir, "incoming")).length; } catch { return 0; } }, { timeout: 30_000 }).toBe(0);

    // 5. Bytes that do not match their hash: refused, nothing kept, the message is not sent.
    const before = (await server.messages()).length;
    await pick(page, tampered);
    await expect.poll(async () => (await uploadNamed(page, "tampered.pdf"))?.state, { timeout: 60_000 }).toBe("failed");
    const refused = (await uploadNamed(page, "tampered.pdf"))!;
    expect(refused.error).toMatch(/did not match their hash/);
    const tamperedHex = sha256File(tampered);
    expect(Object.keys(uploadDir(dataDir)).filter((name) => name.startsWith(tamperedHex))).toEqual([]);
    const line5 = chatOf(page).getByTestId("uploads");
    await expect.poll(async () => (await line5.textContent()) ?? "", { timeout: 10_000 }).toContain("tampered.pdf: The server refused this file");
    await say(page, "With the changed file");
    // The send is refused on the page (the 2.x composer shows why); the text stays in the box.
    await expect.poll(async () => `${await chatOf(page).locator("body").innerText()}\n${await page.locator("body").innerText()}`, { timeout: 10_000 }).toMatch(/tampered\.pdf cannot be sent/);
    expect((await server.messages()).length).toBe(before);
    result.mismatch = { refused: true, error: refused.error, kept: Object.keys(uploadDir(dataDir)).filter((name) => name.startsWith(tamperedHex)), messageSent: false };

    // 6. Above 500 MB: refused before anything is sent.
    const upBefore = proxy.upBytes;
    await pick(page, huge);
    await expect.poll(async () => (await uploadNamed(page, "huge-501mb.mov"))?.state, { timeout: 15_000 }).toBe("failed");
    const tooLarge = (await uploadNamed(page, "huge-501mb.mov"))!;
    expect(tooLarge.error).toMatch(/larger than 500 MB/);
    expect(tooLarge.puts).toBe(0);
    expect(tooLarge.id).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Nothing of its size went out (the session's own small frames may).
    expect(proxy.upBytes - upBefore).toBeLessThan(64 * 1024);
    result.tooLarge = { refused: true, error: tooLarge.error, puts: tooLarge.puts, bytesSentAfter: proxy.upBytes - upBefore };

    result.serverUploads = Object.keys(uploadDir(dataDir)).map((name) => name.slice(0, 12));
    result.pageErrors = errors;
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => undefined);
    await proxy.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(dist))("M2 step 12: uploads from the page (headless)", () => {
  for (const [engine, type] of ENGINES) it(`${engine}: 50 MB held then applied once, resume after a cut, hash mismatch refused, > 500 MB refused before sending, the bot's attachments folder`, () => run(engine, type), 600_000);
});
