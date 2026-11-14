// The owner's PDF text job (M2 step 15, protocol v1 §9A.8, D37): pdf.js in a child process (out/server/pdf-text.cjs,
// built by `npm run build`) gives the page count, the outline and the page text of a 100-page PDF made at test time;
// the job keeps it as the JSON `text` variant, announces it with `content.text{id, pages, textId}` (and its
// `content.variant`), records the page count when qpdf is not there, and serves it through `/v3/c/` under the same
// ticket checks as the original. Without the script the job says why and makes the other variants.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { contentUrlPath, type StreamId } from "../../src/protocol";
import { ContentService } from "../../src/server/content";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { ensureStream } from "../../src/server/log";
import { findTools, MediaJobs, type MediaJobsOptions } from "../../src/server/media";
import { defaultPdfTextScript } from "../../src/server/media/jobs";
import { cmapsDir } from "../../src/server/media/pdf-extract";
import { pageText, type PdfText } from "../../src/server/media/pdf-text";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { desktop } from "../helpers";
import { FIND_PAGE, FIND_WORD, makeTextPdf, pageTitle } from "../support/make-pdf";

const BOT = "pdftext";
const STREAM = `bot:${BOT}` as StreamId;
const base = process.env.BOTLING_TEST_TMP || (existsSync("/Volumes/My-SSD/botling-work") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const SCRIPT = join(desktop, "out/server/pdf-text.cjs");
const BUILT = existsSync(SCRIPT);

let root: string;
let pdf: string;
let dataDir: string;
let store: ServerStore;
let content: ContentService;
let media: MediaJobs;
const tickets = new ContentTickets();
const DEVICE = "device-a";

beforeAll(() => {
  root = mkdtempSync(join(base, "botling-pdftext-"));
  pdf = join(root, "report.pdf");
  makeTextPdf(pdf, 100, { figure: 0 });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

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
afterEach(async () => { await media?.close(); await content?.close(); await store?.close(); });

let lineNo = 0;
async function post(file: string): Promise<{ seq: number; id: string }> {
  const id = `line-${++lineNo}`;
  const text = `![doc](${pathToFileURL(file).href})`;
  const message = { id, role: "bot", text, time: "2026-11-15T00:00:00.000Z", state: "done" };
  const { entries, ready } = await content.appendLine(STREAM, BOT, { id, text }, [{ kind: "message.added", body: { botId: BOT, message } }]);
  const done = await ready;
  await media.idle();
  return { seq: entries[0]!.seq, id: (done[0]!.body as { ref: { id: string } }).ref.id };
}
const rows = (sql: string, ...params: Array<string | number>) => {
  const reader = store.openReader();
  try { return reader.prepare(sql).all(...params); } finally { reader.close(); }
};
const entriesOf = (kind: string) => rows("SELECT body FROM entries WHERE stream = ? AND kind = ? ORDER BY seq", STREAM, kind).map((row) => JSON.parse(String(row.body)) as Record<string, unknown>);

describe("pageText", () => {
  it("joins the items, an item with hasEOL ending its line", () => {
    expect(pageText([{ str: "Hello", hasEOL: false }, { str: " world", hasEOL: true }, { str: "next" }, { hasEOL: true }])).toBe("Hello world\nnext\n");
  });
});

describe("cmapsDir", () => {
  it.skipIf(!BUILT)("finds the CMaps beside the built script, else in node_modules", () => {
    expect(cmapsDir(join(desktop, "out/server"))).toBe(`${join(desktop, "out/server/pdfjs/cmaps")}/`);
    expect(cmapsDir(join(root))).toMatch(/pdfjs-dist\/cmaps\/$/);
  });
});

describe.skipIf(!BUILT)("the PDF text job (out/server/pdf-text.cjs built)", () => {
  it("finds its script from the source tree", () => {
    expect(defaultPdfTextScript()).toBe(SCRIPT);
  });

  it("page count, outline and page text as the `text` variant; content.text names it; served by ticket", async () => {
    // qpdf hidden: the page count comes from the text job.
    await open({ tools: findTools({ path: "/usr/bin:/bin:/usr/sbin:/sbin" }) });
    const t0 = Date.now();
    const { seq, id } = await post(pdf);
    const ms = Date.now() - t0;
    const text = rows("SELECT id, path, type, size, info FROM variants WHERE srcId = ? AND variant = 'text' AND state = 'ready'", id)[0];
    expect(text, JSON.stringify(media.jobs())).toBeDefined();
    expect(text!.type).toBe("application/json");
    const body = JSON.parse(readFileSync(String(text!.path), "utf8")) as PdfText;
    expect(body.v).toBe(1);
    expect(body.pages).toBe(100);
    expect(body.text).toHaveLength(100);
    expect(body.outline).toEqual([{ title: "Part one", page: 1, items: [{ title: "Chapter 50", page: 50 }] }]);
    expect(body.text[0]!.startsWith(pageTitle(1))).toBe(true);
    expect(body.text[99]).toContain("Line 40 of page 100: steady text for selection and search.");
    const hits = body.text.flatMap((page, i) => (page.includes(FIND_WORD) ? [i + 1] : []));
    expect(hits).toEqual([FIND_PAGE]);
    expect(JSON.parse(String(text!.info))).toMatchObject({ pages: 100, outline: 1 });
    // The page count is the source's meta (qpdf was not there to give it).
    expect(JSON.parse(String(rows("SELECT meta FROM content_meta WHERE id = ?", id)[0]!.meta))).toEqual({ pages: 100 });
    // Announced: content.variant (text) and content.text{id, pages, textId}; both entries reference the source.
    const variant = entriesOf("content.variant").find((e) => (e.variant as { name: string }).name === "text");
    expect(variant).toMatchObject({ id, variant: { name: "text", id: String(text!.id), type: "application/json", size: Number(text!.size) } });
    const announced = entriesOf("content.text");
    expect(announced).toEqual([{ id, pages: 100, textId: String(text!.id) }]);
    const refs = rows("SELECT seq FROM content_refs WHERE id = ? AND stream = ? ORDER BY seq", id, STREAM).map((row) => Number(row.seq));
    const textSeq = Number(rows("SELECT seq FROM entries WHERE stream = ? AND kind = 'content.text'", STREAM)[0]!.seq);
    expect(refs).toContain(textSeq);
    expect(media.jobs()).toEqual([expect.objectContaining({ kind: "pdf", state: "done" })]);
    // Served through /v3/c/ under the source's proof of reference: 200 JSON, a range 206, another id's ticket 403.
    const remote = new RemoteContent({ service: content, tickets, roster: { device: (member) => (member === DEVICE ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) } });
    const entry = { stream: STREAM, seq };
    const ticket = tickets.issue({ deviceId: DEVICE, owner: content.serverId, id, entry }).ticket;
    const path = contentUrlPath({ owner: content.serverId, id, variant: "text", entry, ticket });
    const whole = await remote.respond(path, new Request(`http://127.0.0.1${path}`));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toMatch(/^application\/json/);
    expect((JSON.parse(await whole.text()) as PdfText).pages).toBe(100);
    const part = await remote.respond(path, new Request(`http://127.0.0.1${path}`, { headers: { range: "bytes=0-9" } }));
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('{"v":1,"pa');
    const wrong = await remote.respond(contentUrlPath({ owner: content.serverId, id, variant: "text", entry, ticket: tickets.issue({ deviceId: DEVICE, owner: content.serverId, id: String(text!.id), entry }).ticket }), new Request("http://127.0.0.1/"));
    expect(wrong.status).toBe(403);
    console.log(`pdf text job: 100 pages, ${Number(text!.size)} bytes of JSON, line to done ${ms} ms`);
  }, 60_000);

  it("without the script: no text variant, the note says why, the other variants are made", async () => {
    await open({ pdfTextScript: null });
    const { id } = await post(pdf);
    expect(rows("SELECT variant FROM variants WHERE srcId = ? AND variant = 'text'", id)).toEqual([]);
    expect(entriesOf("content.text")).toEqual([]);
    expect(media.jobs()[0]!.note).toMatch(/text: no PDF text: the text script is not built/);
  }, 60_000);

  it("a file pdf.js cannot read: no text variant, the note says why, no retry", async () => {
    const bad = join(root, "bad.pdf");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bad, "%PDF-1.7\nnot really a pdf\n");
    // No Quick Look or sips (Quick Look waits out its limit on a broken file): only the text step runs.
    await open({ tools: findTools({ path: "/usr/bin:/bin:/usr/sbin:/sbin", platform: "linux" }) });
    const { id } = await post(bad);
    await media.idle();
    expect(rows("SELECT variant FROM variants WHERE srcId = ? AND variant = 'text'", id)).toEqual([]);
    expect(entriesOf("content.text")).toEqual([]);
    expect(media.jobs()[0]).toMatchObject({ kind: "pdf", state: "done", tries: 1 });
    expect(media.jobs()[0]!.note).toMatch(/text: no PDF text: .*failed \(exit 1\)/);
  }, 60_000);
});
