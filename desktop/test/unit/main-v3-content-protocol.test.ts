// Botling 3's content path in main (M1 step 13, protocol v1 §9A.4, §9A.7): range answers identical to 2.x
// preview-response.ts (a shared property test), the entry as proof, a `pin: path` file never serving other bytes, the
// wrapping of Electron's protocol calls, and no `file:` load for chat media or PDFs on the v3 path. No window, no Electron.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentURL, localMediaSource } from "../../src/contract/attachment-url";
import { previewResponse } from "../../src/main/preview-response";
import {
  CHAT_MEDIA_CSP, CONTENT_SCHEME, ContentChangedError, ContentProtocol, contentUrl, FileGrants, installContentProtocol, serveContentFile,
  type ContentLink, type CustomSchemeLike, type ProtocolLike,
} from "../../src/main-v3/content-protocol";
import * as pdfV3 from "../../src/main-v3/browser-pdf-v3";
import { CONTENT_CHUNK_BYTES, type MessageOf, type StreamId } from "../../src/protocol";
import { ContentService, Hasher, statSig, type HashResult, type LineLike } from "../../src/server/content";
import { ensureStream } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";

const MiB = CONTENT_CHUNK_BYTES;
const root = join(__dirname, "../..");

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { x.copy(out, at); x = createHash("sha256").update(x).digest(); }
  return out;
}
function chunkHashes(data: Buffer): string {
  const digests: Buffer[] = [];
  for (let at = 0; at < data.length; at += MiB) digests.push(createHash("sha256").update(data.subarray(at, at + MiB)).digest());
  return Buffer.concat(digests).toString("base64");
}
/** A seeded generator (mulberry32): the same cases on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function answer(response: Response) {
  const headers: Record<string, string | null> = {};
  for (const name of ["content-type", "content-range", "content-length", "accept-ranges", "content-security-policy", "cache-control", "x-content-type-options"]) headers[name] = response.headers.get(name);
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  return { status: response.status, headers, body: body ? createHash("sha256").update(body).digest("hex") + `:${body.length}` : null };
}
/** Reads a body until it ends or fails: the bytes that arrived and the error, if any. */
async function drain(response: Response): Promise<{ bytes: Buffer; error: unknown }> {
  const parts: Buffer[] = [];
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}
const fileOf = (path: string, pin: "clone" | "copy" | "path", type: string, hashes?: string): MessageOf<"content.file"> => ({
  t: "content.file", req: "r", id: "sha256:" + "0".repeat(64), path, type, pin, sig: statSig(path), ...(hashes ? { chunkHashes: hashes } : {}),
});

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "botling-content-main-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

// -------------------------------------------------------------------------------------------------
describe("byte ranges: the content path answers exactly as preview-response.ts (shared property test)", () => {
  function ranges(size: number, next: () => number): Array<string | null> {
    const n = (max: number) => Math.floor(next() * (max + 1));
    const out: Array<string | null> = [null, "bytes=0-", "bytes=0-0", `bytes=${size}-`, `bytes=${Math.max(0, size - 1)}-`, "bytes=-1", `bytes=-${size + 10}`, "bytes=-0", "bytes=-", "bytes=5-2",
      `bytes=0-${size + 1000}`, "bytes=0-1,4-5", "items=0-1", "bytes= 0-1", "bytes=99999999999999999999-", `bytes=${MiB - 1}-${MiB}`, `bytes=${MiB}-`];
    for (let i = 0; i < 18; i++) {
      const a = n(size + 2);
      const b = n(size + 2);
      const pick = n(4);
      out.push(pick === 0 ? `bytes=${Math.min(a, b)}-${Math.max(a, b)}` : pick === 1 ? `bytes=${a}-` : pick === 2 ? `bytes=-${b}` : pick === 3 ? `bytes=${Math.max(a, b)}-${Math.min(a, b)}` : `bytes=${a}-${a + n(3 * MiB)}`);
    }
    return out;
  }

  it("status, headers and bytes match for clones/copies, hashed `pin: path` files and unhashed ones (GET and HEAD)", async () => {
    const next = random(13);
    const sizes = [0, 1, 2, 31, MiB - 1, MiB, MiB + 1, 3 * MiB + 12_345, 1 + Math.floor(next() * 2 * MiB)];
    let compared = 0;
    const statuses = new Set<number>();
    for (const size of sizes) {
      const path = join(scratch, `f-${size}.mp4`);
      const data = bytes(`s${size}`, size);
      writeFileSync(path, data);
      const files = [fileOf(path, "copy", "video/mp4"), fileOf(path, "path", "video/mp4", size ? chunkHashes(data) : undefined), fileOf(path, "path", "video/mp4")];
      for (const range of ranges(size, next)) {
        for (const method of ["GET", "HEAD"]) {
          const request = () => new Request("botling-chat://chat/attachment/x", { method, headers: range ? { range } : {} });
          const expected = await answer(await previewResponse(path, request(), { type: "video/mp4", follow: false, csp: CHAT_MEDIA_CSP }));
          expect([200, 206, 416], `${size} ${range}`).toContain(expected.status);
          statuses.add(expected.status);
          for (const file of files) {
            const got = await answer(await serveContentFile(file, request(), { csp: CHAT_MEDIA_CSP }));
            expect(got, `size ${size}, ${method} ${range ?? "(no range)"}, pin ${file.pin}${file.chunkHashes ? " hashed" : ""}`).toEqual(expected);
            compared += 1;
          }
        }
      }
    }
    expect([...statuses].sort()).toEqual([200, 206, 416]);
    expect(compared).toBeGreaterThan(sizes.length * 60);
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
describe("a `pin: path` file never serves other bytes", () => {
  it("a file replaced after its pin answers 410 changed (and calls onChanged)", async () => {
    const path = join(scratch, "a.mp4");
    writeFileSync(path, bytes("old", 2 * MiB));
    const file = fileOf(path, "path", "video/mp4");
    writeFileSync(path, bytes("new", 2 * MiB));
    let changed = 0;
    const response = await serveContentFile(file, new Request("x:", { headers: { range: "bytes=0-" } }), { onChanged: () => { changed += 1; } });
    expect(response.status).toBe(410);
    expect(response.headers.get("x-botling-content")).toBe("gone; reason=changed");
    expect(changed).toBe(1);
  });

  it("bytes rewritten in place while streaming end the response with an error at the changed chunk, hashed or not", async () => {
    for (const hashed of [true, false]) {
      const path = join(scratch, `b-${hashed}.mp4`);
      const old = bytes("old", 3 * MiB);
      writeFileSync(path, old);
      const file = fileOf(path, "path", "video/mp4", hashed ? chunkHashes(old) : undefined);
      let changed = 0;
      const response = await serveContentFile(file, new Request("x:"), { onChanged: () => { changed += 1; } });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!).equals(old.subarray(0, MiB))).toBe(true);
      // Same size, same inode: only the chunk hash (or the new mtime) can tell.
      const fd = openSync(path, "r+");
      writeSync(fd, Buffer.alloc(16, 0x42), 0, 16, 2 * MiB + 5);
      closeSync(fd);
      const rest: Buffer[] = [];
      let error: unknown = null;
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; rest.push(Buffer.from(value)); }
      } catch (caught) { error = caught; }
      expect(error, `hashed=${hashed}`).toBeInstanceOf(ContentChangedError);
      const sent = Buffer.concat([Buffer.from(first.value!), ...rest]);
      expect(sent.equals(old.subarray(0, sent.length)), "every byte sent is the pinned version").toBe(true);
      expect(sent.length).toBeLessThan(old.length);
      expect(changed).toBe(1);
    }
  });

  it("a wrong chunk hash fails the range that reads it, before any of its bytes", async () => {
    const path = join(scratch, "c.pdf");
    const data = bytes("pdf", 2 * MiB + 100);
    writeFileSync(path, data);
    const hashes = Buffer.from(chunkHashes(data), "base64");
    hashes[40] ^= 0xff; // chunk 1
    const file = fileOf(path, "path", "application/pdf", hashes.toString("base64"));
    const ok = await drain(await serveContentFile(file, new Request("x:", { headers: { range: "bytes=10-20" } })));
    expect(ok.error).toBeNull();
    expect(ok.bytes.equals(data.subarray(10, 21))).toBe(true);
    const bad = await drain(await serveContentFile(file, new Request("x:", { headers: { range: `bytes=${MiB + 3}-${MiB + 9}` } })));
    expect(bad.error).toBeInstanceOf(ContentChangedError);
    expect(bad.bytes.length).toBe(0);
  });

  it("a clone or copy whose signature no longer matches answers 410 deleted", async () => {
    const path = join(scratch, "d.png");
    writeFileSync(path, bytes("p", 1000));
    const file = fileOf(path, "copy", "image/png");
    writeFileSync(path, bytes("q", 1001));
    expect((await serveContentFile(file, new Request("x:"))).status).toBe(410);
    rmSync(path);
    expect((await serveContentFile(file, new Request("x:"))).status).toBe(410);
  });
});

// -------------------------------------------------------------------------------------------------
describe("chat media through the server's references (ContentProtocol + ContentService)", () => {
  const BOT = "bot-a";
  const STREAM = `bot:${BOT}` as StreamId;
  let store: ServerStore;
  let service: ContentService;
  let reqs = 0;
  const asked: string[] = [];
  const link: ContentLink = {
    content: (message) => { asked.push(message.t); return service.handle({ ...message, req: `r${++reqs}` } as never); },
    postContent: () => false,
    onContent: () => () => {},
    newReq: () => `r${++reqs}`,
    attachedServerId: () => store.meta("serverId")!,
  };

  async function open(options: Partial<ConstructorParameters<typeof ContentService>[0]> = {}) {
    store = await openServerStore(join(scratch, "data"));
    await store.submit((db) => ensureStream(db, STREAM));
    service = new ContentService({ store, dataDir: join(scratch, "data"), serverId: store.meta("serverId")!, ...options });
  }
  async function post(l: LineLike) {
    const message = { id: l.id, role: "bot", text: l.text, time: "2026-11-14T00:00:00.000Z", state: "done" };
    const { entries, ready } = await service.appendLine(STREAM, BOT, l, [{ kind: "message.added", body: { botId: BOT, message } }]);
    return { entry: entries[0]!, ready };
  }
  const chatRequest = (ref: string, line?: string, range?: string) => {
    const url = attachmentURL(BOT, ref, line);
    return { url: new URL(url), request: new Request(url, { headers: range ? { range } : {} }) };
  };
  afterEach(async () => { await service?.close(); await store?.close(); asked.length = 0; });

  it("a finished line's video, picture and PDF are served from their pins; other requests are left to 2.x", async () => {
    await open();
    const media = join(scratch, "media");
    mkdirSync(media);
    const video = join(media, "render one.mp4"), picture = join(media, "plot.png"), pdf = join(media, "report.pdf");
    const data = { video: bytes("v", 3 * MiB + 7), picture: bytes("p", 20_000), pdf: Buffer.concat([Buffer.from("%PDF-1.7\n"), bytes("d", 300_000)]) };
    writeFileSync(video, data.video); writeFileSync(picture, data.picture); writeFileSync(pdf, data.pdf);
    const { ready } = await post({ id: "m1", text: `![v](${pathToFileURL(video).href}) ![p](${picture}) [r](${pathToFileURL(pdf).href})` });
    const protocol = new ContentProtocol({ link: () => link, grants: new FileGrants() });

    // While hashing may still run (pending id) and after it (content id): the same bytes.
    for (const phase of ["posted", "hashed"]) {
      if (phase === "hashed") await ready;
      const v = chatRequest(pathToFileURL(video).href, "m1", `bytes=${MiB}-${MiB + 99}`);
      const response = (await protocol.chatAttachment(v.url, v.request))!;
      expect(response.status, phase).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${MiB}-${MiB + 99}/${data.video.length}`);
      expect(response.headers.get("content-security-policy")).toBe(CHAT_MEDIA_CSP);
      expect(Buffer.from(await response.arrayBuffer()).equals(data.video.subarray(MiB, MiB + 100))).toBe(true);
      // The renderer maps an absolute path to `file://<path>` (localMediaSource), unescaped.
      const p = chatRequest(`file://${picture}`, "m1");
      expect(Buffer.from(await (await protocol.chatAttachment(p.url, p.request))!.arrayBuffer()).equals(data.picture)).toBe(true);
      const d = chatRequest(pathToFileURL(pdf).href, "m1");
      const pdfResponse = (await protocol.chatAttachment(d.url, d.request))!;
      expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await pdfResponse.arrayBuffer()).equals(data.pdf)).toBe(true);
    }
    // The source rewritten: the line still shows what it was posted with (an APFS clone here, a copy elsewhere).
    writeFileSync(video, bytes("newer", 1000));
    const again = chatRequest(pathToFileURL(video).href, "m1", "bytes=0-9");
    expect(Buffer.from(await (await protocol.chatAttachment(again.url, again.request))!.arrayBuffer()).equals(data.video.subarray(0, 10))).toBe(true);

    // Left to the 2.x handler (null): no line, another line, a file the line did not name, not a file URL, no server.
    for (const [ref, line] of [[pathToFileURL(video).href, undefined], [pathToFileURL(video).href, "m2"], [pathToFileURL(join(media, "other.mp4")).href, "m1"], ["pending-file-1", "m1"]] as const) {
      const r = chatRequest(ref, line);
      expect(await protocol.chatAttachment(r.url, r.request), `${ref} ${line}`).toBeNull();
    }
    const offline = new ContentProtocol({ link: () => null });
    const o = chatRequest(pathToFileURL(video).href, "m1");
    expect(await offline.chatAttachment(o.url, o.request)).toBeNull();
  });

  it("refuses a request whose entry does not reference the id (§9A.7)", async () => {
    await open();
    const a = join(scratch, "a.png"), b = join(scratch, "b.png");
    writeFileSync(a, bytes("a", 5000)); writeFileSync(b, bytes("b", 6000));
    const one = await post({ id: "m1", text: `![a](${a})` });
    const two = await post({ id: "m2", text: `![b](${b})` });
    await Promise.all([one.ready, two.ready]);
    const owner = store.meta("serverId")!;
    const found = await link.content({ t: "content.find", botId: BOT, line: "m1", url: `file://${a}` });
    expect(found.t === "content.found" && found.ref?.id.startsWith("sha256:")).toBe(true);
    const id = (found as MessageOf<"content.found">).ref!.id;
    const protocol = new ContentProtocol({ link: () => link, grants: new FileGrants() });
    const ask = (url: string) => protocol.handle(new Request(url));
    const good = await ask(contentUrl(owner, id, (found as MessageOf<"content.found">).ref!.entry));
    expect(good.status).toBe(200);
    expect(Buffer.from(await good.arrayBuffer()).equals(readFileSync(a))).toBe(true);
    // Line two's entry, an entry that does not exist, another stream: refused, no bytes.
    for (const entry of [two.entry, { stream: STREAM, seq: 999 }, { stream: "bot:other" as StreamId, seq: one.entry.seq }]) {
      const refused = await ask(contentUrl(owner, id, entry));
      expect(refused.status, JSON.stringify(entry)).toBe(404);
      expect(refused.headers.get("x-botling-content")).toBe("gone; reason=denied");
    }
    expect((await ask(contentUrl("another-server", id, one.entry))).status).toBe(503);
    expect((await ask(contentUrl(owner, id, one.entry, "poster"))).status).toBe(410);
    expect((await ask(`${CONTENT_SCHEME}://c/${owner}/${id}/original`)).status).toBe(404); // no proof
    // The browser pane's session never serves references (web pages share it).
    expect((await protocol.handle(new Request(contentUrl(owner, id, one.entry)), "pane")).status).toBe(404);
  });

  /** A line whose hash waits for `release`, and a link that delivers the first open of its pending id just after the hash moved it. */
  async function racingLine(name: string, refusePending: boolean) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class SlowHasher extends Hasher {
      override async hash(path: string): Promise<HashResult> { await gate; return super.hash(path); }
    }
    const hasher = new SlowHasher();
    await open({ hasher });
    const file = join(scratch, name);
    writeFileSync(file, bytes(name, 100_000));
    const { ready } = await post({ id: "m1", text: `![v](${file})` });
    const racing: ContentLink = {
      postContent: link.postContent,
      onContent: link.onContent,
      newReq: link.newReq,
      attachedServerId: link.attachedServerId,
      content: async (message) => {
        if (message.t === "content.open" && message.id.startsWith("pending:")) {
          release(); await ready;
          // A server without the pending → content id alias (an older one, another owner) refuses the old pending id.
          if (refusePending) { asked.push(message.t); return { t: "content.gone", req: "r0", id: message.id, reason: "denied" }; }
        }
        return link.content(message);
      },
    };
    return { file, hasher, protocol: new ContentProtocol({ link: () => racing, grants: new FileGrants() }) };
  }

  it("the hash became ready between find and open: the server still opens the pending id", async () => {
    const { file, hasher, protocol } = await racingLine("v.mp4", false);
    const r = chatRequest(`file://${file}`, "m1");
    const response = (await protocol.chatAttachment(r.url, r.request))!;
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(file))).toBe(true);
    expect(asked).toEqual(["content.find", "content.open"]);
    await hasher.close();
  });

  it("asks again when a server refuses the pending id the hash replaced between find and open", async () => {
    const { file, hasher, protocol } = await racingLine("w.mp4", true);
    const r = chatRequest(`file://${file}`, "m1");
    const response = (await protocol.chatAttachment(r.url, r.request))!;
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(file))).toBe(true);
    expect(asked).toEqual(["content.find", "content.open", "content.find", "content.open"]);
    await hasher.close();
  });

  it("forced `pin: path`: after the file is rewritten the old line answers gone(changed), never the new bytes", async () => {
    await open({ pin: { force: "path" } });
    const v = join(scratch, "big.mp4");
    const old = bytes("old", 2 * MiB + 3);
    writeFileSync(v, old);
    const { ready } = await post({ id: "m1", text: `![v](${pathToFileURL(v).href})` });
    await ready;
    const protocol = new ContentProtocol({ link: () => link, grants: new FileGrants() });
    const before = chatRequest(pathToFileURL(v).href, "m1", "bytes=0-");
    expect(Buffer.from(await (await protocol.chatAttachment(before.url, before.request))!.arrayBuffer()).equals(old)).toBe(true);
    const newer = bytes("new", 2 * MiB + 3);
    writeFileSync(v, newer);
    for (const range of ["bytes=0-", "bytes=0-1", undefined]) {
      const r = chatRequest(pathToFileURL(v).href, "m1", range);
      const response = (await protocol.chatAttachment(r.url, r.request))!;
      expect(response.status).toBe(410);
      expect(response.headers.get("x-botling-content")).toBe("gone; reason=changed");
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.includes(newer.subarray(0, 64))).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe("installContentProtocol wraps the 2.x main's protocol calls", () => {
  it("adds the scheme, answers indexed chat media first and serves only granted PDFs on the pane session", async () => {
    const registered: CustomSchemeLike[][] = [];
    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    const paneHandlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    const protocol: ProtocolLike = { registerSchemesAsPrivileged: (schemes) => { registered.push(schemes); }, handle: (scheme, handler) => { handlers.set(scheme, handler); } };
    let ready!: () => void;
    const whenReady = new Promise<void>((resolve) => { ready = resolve; });
    const grants = new FileGrants();
    const served: string[] = [];
    const content = new ContentProtocol({ link: () => null, grants });
    content.chatAttachment = async (url) => { served.push(url.pathname); return url.searchParams.get("line") === "m1" ? new Response("from the server") : null; };
    installContentProtocol({ protocol, whenReady: () => whenReady, paneProtocol: () => ({ handle: (scheme, handler) => { paneHandlers.set(scheme, handler); } }), content });

    // What 2.x main does at load.
    protocol.registerSchemesAsPrivileged([{ scheme: "botling-chat", privileges: { standard: true } }]);
    protocol.handle("botling-chat", () => new Response("from 2.x"));
    protocol.handle("botling-preview", () => new Response("preview"));
    expect(registered).toEqual([[{ scheme: "botling-chat", privileges: { standard: true } }, { scheme: CONTENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]]);
    const chat = handlers.get("botling-chat")!;
    expect(await (await chat(new Request("botling-chat://chat/attachment/bot-a/x?line=m1"))).text()).toBe("from the server");
    expect(await (await chat(new Request("botling-chat://chat/attachment/bot-a/x"))).text()).toBe("from 2.x");
    expect(await (await chat(new Request("botling-chat://chat/index.html"))).text()).toBe("from 2.x");
    expect(await (await handlers.get("botling-preview")!(new Request("botling-preview://x"))).text()).toBe("preview");
    expect(handlers.has(CONTENT_SCHEME)).toBe(false);

    ready();
    await whenReady;
    await Promise.resolve();
    expect(handlers.has(CONTENT_SCHEME)).toBe(true);
    const pane = paneHandlers.get(CONTENT_SCHEME)!;
    const pdf = join(scratch, "paper.pdf");
    const data = Buffer.concat([Buffer.from("%PDF-1.4\n"), bytes("pdf", 50_000)]);
    writeFileSync(pdf, data);
    const url = grants.grant(pdf);
    expect(url).toMatch(/^botling-content:\/\/file\/[0-9a-f]{32}\/paper\.pdf$/);
    expect(grants.grant(pdf)).toBe(url);
    const response = await pane(new Request(url, { headers: { range: "bytes=0-8" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.text()).toBe("%PDF-1.4\n");
    expect((await pane(new Request(`botling-content://file/${"0".repeat(32)}/paper.pdf`))).status).toBe(404);
    expect((await pane(new Request("botling-content://c/o/sha256:x/original?e=bot:a.1"))).status).toBe(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe("the v3 path loads no `file:` URL for chat media or PDFs", () => {
  it("the v3 main bundle resolves the 2.x main's `../browser-pdf` to browser-pdf-v3.ts; the 2.x bundle does not", async () => {
    const { browserPdfToContent, coreClientToServerClient } = await import("../../build.mjs" as string) as Record<string, (root: string) => import("esbuild").Plugin>;
    const meta = async (entry: string, plugins: import("esbuild").Plugin[]) => (await build({
      absWorkingDir: root, preserveSymlinks: true, bundle: true, platform: "node", format: "cjs", target: "node22",
      entryPoints: [join(root, entry)], outfile: join(root, "out/unused.cjs"), write: false, metafile: true, external: ["electron", "original-fs"], logLevel: "silent", plugins,
    })).metafile!;
    const v3 = await meta("src/main-v3/main.ts", [coreClientToServerClient!(root), browserPdfToContent!(root)]);
    for (const importer of ["src/main/browser-host.ts", "src/main/main.ts"]) {
      const imports = v3.inputs[importer]!.imports.filter((item) => item.original === "../browser-pdf");
      expect(imports.map((item) => item.path), importer).toEqual(["src/main-v3/browser-pdf-v3.ts"]);
    }
    expect(Object.keys(v3.inputs)).toContain("src/main-v3/content-install.ts");
    const x2 = await meta("src/main/main.ts", []);
    expect(x2.inputs["src/main/browser-host.ts"]!.imports.filter((item) => item.original === "../browser-pdf").map((item) => item.path)).toEqual(["src/browser-pdf.ts"]);
    expect(Object.keys(x2.inputs).filter((file) => file.startsWith("src/main-v3/"))).toEqual([]);
  }, 60_000);

  it("a v3 PDF tab loads a content URL; dropped and linked PDFs keep the 2.x rules", () => {
    const path = join(scratch, "x.pdf");
    const url = pdfV3.pdfFileUrl(path);
    expect(url.startsWith(`${CONTENT_SCHEME}://file/`)).toBe(true);
    expect(pdfV3.localPdfPath(url)).toBe(path);
    expect(pdfV3.fileLabel(url)).toBe("x.pdf");
    // A file dropped onto a PDF tab (now a content page) opens nothing; onto a web page it opens as in 2.x.
    expect(pdfV3.fileNavigation(pathToFileURL(path).href, url, false)).toBe("refuse");
    expect(pdfV3.fileNavigation(pathToFileURL(path).href, "https://example.com/", false)).toBe("open");
  });

  it("chat media maps to the chat origin, never to `file:`", () => {
    const next = random(7);
    const names = ["a.png", "clip one.mp4", "r%20x.pdf", "ü.webm", "#hash.png", "q?.mp4"];
    for (let i = 0; i < 200; i++) {
      const name = names[Math.floor(next() * names.length)]!;
      const dir = `/work/${Math.floor(next() * 1e6)}`;
      const raw = next() < 0.5 ? `${dir}/${name}` : pathToFileURL(`${dir}/${name}`).href;
      const mapped = localMediaSource("bot-a", raw, next() < 0.5 ? `m${i}` : undefined);
      expect(mapped.startsWith("botling-chat://chat/attachment/bot-a/"), raw).toBe(true);
    }
  });

  it("no renderer or Web source loads a `file:` URL (every mention is a known mapping, policy or check)", () => {
    // Each mention in code (comments, prose and `file: File` parameters aside), by file and line text: none loads.
    const allowed: Array<[string, RegExp]> = [
      ["src/renderer/payload.ts", /file\.url\.startsWith\("file:"\) \? attachmentURL\(/], // maps an attachment to the chat origin
      ["src/renderer/plugin-commands.ts", /return text\.startsWith\("file:"\) \? text : null/], // a link's file URL, for matching
      ["Web/src/link-menu.ts", /startsWith\("file:"\) \? text : null|\/\^\(https\?\|file\):\/i\.test\(text\)/], // link matching
      ["Web/src/lightbox.ts", /url\.startsWith\("file:"\) \|\||\/\^file:\\\/\\\/\/i\.test\(url\)\) return url/], // "show in Finder" / drag-out checks
      ["Web/src/components.ts", /if \(\/\^file:\/i\.test\(value\)\)/], // a card's file URL to its path
      ["Web/src/source-snapshot.ts", /csp\.content = /], // the snapshot page's policy
      ["Web/src/chat.html", /Content-Security-Policy/], // the 1.x Swift app's page (desktop serves src/renderer/chat-frame/chat.html)
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "vendor" && name !== "locales") walk(full); }
        else if (/\.(ts|tsx|js|html)$/.test(name) && !/\.test\./.test(name)) files.push(full);
      }
    };
    walk(join(root, "src/renderer"));
    walk(join(root, "../Web/src"));
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(root, file).replace(/^\.\.\//, "");
      readFileSync(file, "utf8").split("\n").forEach((text, index) => {
        const code = text.replace(/\bfile:\s*(File|string|RunFile)\b/g, "");
        if (!/(?<![A-Za-z0-9_$])file:/i.test(code) || /^\s*(\/\/|\*|\/\*)/.test(code)) return;
        if (!allowed.some(([name, pattern]) => rel === name && pattern.test(code))) hits.push(`${rel}:${index + 1}: ${code.trim().slice(0, 160)}`);
      });
    }
    expect(hits).toEqual([]);
    // And the desktop chat page's own policy allows no file: picture, video or frame at all.
    const main = readFileSync(join(root, "src/main/main.ts"), "utf8");
    const policy = /const CHAT_CSP = \[([\s\S]*?)\]\.join/.exec(main)![1]!;
    expect(policy).toMatch(/img-src 'self'/);
    expect(policy).not.toMatch(/file:/);
    expect(readFileSync(join(root, "src/renderer/chat-frame/chat.html"), "utf8")).not.toMatch(/file:/);
  });
});
