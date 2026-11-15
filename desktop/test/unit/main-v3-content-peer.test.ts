// M4-01b: ContentProtocol.chatAttachment serving a peer server's file over the local socket (`content.get` /
// `content.meta` / `content.chunk` / `content.credit` / `content.cancel` / `content.gone`), matching local
// `serveContentFile` status, headers, and byte ranges. Plain Requests and a fake ContentLink; no Electron, no socket.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentURL } from "../../src/contract/attachment-url";
import {
  CHAT_MEDIA_CSP, ContentProtocol, serveContentFile, type ContentAnswer, type ContentLink,
} from "../../src/main-v3/content-protocol";
import type { ContentReadMessage } from "../../src/fe-link";
import { CONTENT_CHUNK_BYTES, type MessageOf, type StreamId } from "../../src/protocol";
import { statSig } from "../../src/server/content";

const MiB = CONTENT_CHUNK_BYTES;
const PEER_CHUNK = 64 * 1024;
const LOCAL_SERVER = "srvaaaaaaaaaaaaaaaaaaaaaaa";
const PEER_SERVER = "srvbbbbbbbbbbbbbbbbbbbbbbb";
const BOT = "bot-peer";
const STREAM = `bot:${BOT}` as StreamId;

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) {
    x.copy(out, at);
    x = createHash("sha256").update(x).digest();
  }
  return out;
}

function sha256Id(data: Buffer): MessageOf<"content.get">["id"] {
  return `sha256:${createHash("sha256").update(data).digest("hex")}` as MessageOf<"content.get">["id"];
}

async function answer(response: Response) {
  const headers: Record<string, string | null> = {};
  for (const name of [
    "content-type", "content-range", "content-length", "accept-ranges",
    "content-security-policy", "cache-control", "x-content-type-options",
  ]) {
    headers[name] = response.headers.get(name);
  }
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  return {
    status: response.status,
    headers,
    body: body ? createHash("sha256").update(body).digest("hex") + `:${body.length}` : null,
  };
}

interface FakePeerOptions {
  owner?: string;
  data: Buffer;
  type?: string;
  state?: "preparing" | "ready" | "changed" | "gone";
  detached?: boolean;
  localFile?: MessageOf<"content.file">;
  onGet?: (
    message: MessageOf<"content.get">,
    emit: (frame: ContentReadMessage | null) => void,
    isCancelled: () => boolean,
  ) => void | Promise<void>;
}

function makeFakeLink(options: FakePeerOptions) {
  const id = sha256Id(options.data);
  const type = options.type ?? "video/mp4";
  const owner = options.owner ?? PEER_SERVER;
  const entry = { stream: STREAM, seq: 1 };
  let reqSeq = 0;

  const listeners = new Map<string, (message: ContentReadMessage | null) => void>();
  const cancelled = new Set<string>();
  const asked: string[] = [];
  const gets: MessageOf<"content.get">[] = [];
  const credits: MessageOf<"content.credit">[] = [];
  const cancels: MessageOf<"content.cancel">[] = [];

  const emit = (req: string, frame: ContentReadMessage | null) => {
    listeners.get(req)?.(frame);
  };

  const defaultServe = async (message: MessageOf<"content.get">) => {
    await Promise.resolve();
    if (cancelled.has(message.req)) return;
    emit(message.req, {
      t: "content.meta", req: message.req, id, size: options.data.length, type, chunkSize: CONTENT_CHUNK_BYTES, variants: [],
    });
    const end = Math.min(options.data.length, message.offset + message.length);
    for (let pos = message.offset; pos < end; pos += PEER_CHUNK) {
      await Promise.resolve();
      if (cancelled.has(message.req)) return;
      const slice = options.data.subarray(pos, Math.min(end, pos + PEER_CHUNK));
      emit(message.req, { t: "content.chunk", req: message.req, offset: pos, bytes: new Uint8Array(slice) });
    }
  };

  const link: ContentLink = {
    async content(message): Promise<ContentAnswer> {
      asked.push(message.t);
      if (message.t === "content.find") {
        return {
          t: "content.found",
          req: `r${++reqSeq}`,
          ref: { owner, id, type, state: options.state ?? "ready", entry },
        };
      }
      if (options.localFile) return options.localFile;
      return { t: "content.gone", req: `r${++reqSeq}`, id, reason: "denied" };
    },
    postContent(message) {
      if (options.detached) return false;
      if (message.t === "content.get") {
        gets.push(message);
        if (options.onGet) {
          void options.onGet(message, (frame) => emit(message.req, frame), () => cancelled.has(message.req));
        } else {
          void defaultServe(message);
        }
        return true;
      }
      if (message.t === "content.credit") {
        credits.push(message);
        return true;
      }
      if (message.t === "content.cancel") {
        cancels.push(message);
        cancelled.add(message.req);
        return true;
      }
      return false;
    },
    onContent(req, listener) {
      listeners.set(req, listener);
      return () => {
        if (listeners.get(req) === listener) listeners.delete(req);
      };
    },
    newReq() {
      return `r${++reqSeq}`;
    },
    attachedServerId() {
      return options.detached ? null : LOCAL_SERVER;
    },
  };

  return { link, id, entry, asked, gets, credits, cancels, emit };
}

function chatRequest(ref: string, line = "m1", method = "GET", range?: string) {
  const raw = attachmentURL(BOT, ref, line);
  return {
    url: new URL(raw),
    request: new Request(raw, { method, headers: range ? { range } : {} }),
  };
}

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "botling-content-peer-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("ContentProtocol.chatAttachment for peer-owned files (M4-01b)", () => {
  it("1. Range: bytes=0-99 returns 206, Content-Range, and the first 100 bytes", async () => {
    const data = bytes("clip", 200_000);
    const fake = makeFakeLink({ data, type: "video/mp4" });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/clip.mp4", "m1", "GET", "bytes=0-99");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-99/${data.length}`);
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("content-security-policy")).toBe(CHAT_MEDIA_CSP);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(data.subarray(0, 100))).toBe(true);
  });

  it("2. No Range returns 200 with whole file; HEAD returns 200 with Content-Length and no content.get beyond probe", async () => {
    const data = bytes("head-and-full", 150_000);
    const fake = makeFakeLink({ data, type: "video/mp4" });
    const protocol = new ContentProtocol({ link: () => fake.link });

    const head = chatRequest("file:///peer/video.mp4", "m1", "HEAD");
    const headRes = (await protocol.chatAttachment(head.url, head.request))!;
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).toBe(String(data.length));
    expect(headRes.body).toBeNull();
    expect(fake.gets).toHaveLength(1);
    expect(fake.gets[0]!.offset).toBe(0);
    expect(fake.gets[0]!.length).toBe(65_536);

    const full = chatRequest("file:///peer/video.mp4", "m1", "GET");
    const fullRes = (await protocol.chatAttachment(full.url, full.request))!;
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get("content-length")).toBe(String(data.length));
    expect(Buffer.from(await fullRes.arrayBuffer()).equals(data)).toBe(true);
    // Probe was cached by the HEAD request, so GET only issued the stream content.get.
    expect(fake.gets).toHaveLength(2);
    expect(fake.gets[1]!.offset).toBe(0);
    expect(fake.gets[1]!.length).toBe(data.length);
  });

  it("3. Range: bytes=<size>- returns 416 with Content-Range: bytes */<size>", async () => {
    const data = bytes("eof", 10_000);
    const fake = makeFakeLink({ data, type: "image/png" });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/img.png", "m1", "GET", `bytes=${data.length}-`);
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${data.length}`);
    expect(response.headers.get("content-length")).toBe("0");
    expect(fake.gets).toHaveLength(1); // probe only
  });

  it("4. Same as local: 4 sizes (0, 1, 65536, 3 MiB) x 8 Range headers match serveContentFile", async () => {
    const sizes = [0, 1, 65_536, 3 * MiB];
    for (const size of sizes) {
      const data = bytes(`same-${size}`, size);
      const localPath = join(scratch, `f-${size}.mp4`);
      writeFileSync(localPath, data);
      const localFile: MessageOf<"content.file"> = {
        t: "content.file", req: "r0", id: sha256Id(data), path: localPath, type: "video/mp4", pin: "copy", sig: statSig(localPath),
      };
      const fake = makeFakeLink({ data, type: "video/mp4" });
      const protocol = new ContentProtocol({ link: () => fake.link });
      const ranges: Array<string | undefined> = [
        undefined,
        "bytes=0-",
        "bytes=0-0",
        "bytes=10-20",
        "bytes=-1",
        `bytes=-${size + 10}`,
        `bytes=${size}-`,
        "bytes=5-2",
      ];
      for (const range of ranges) {
        const { url, request } = chatRequest(`file:///peer/f-${size}.mp4`, "m1", "GET", range);
        const expected = await answer(await serveContentFile(localFile, new Request(url, { headers: range ? { range } : {} }), { csp: CHAT_MEDIA_CSP }));
        const got = await answer((await protocol.chatAttachment(url, request))!);
        expect(got, `size ${size}, range ${range ?? "(none)"}`).toEqual(expected);
      }
    }
  });

  it("5. content.gone{denied} on probe returns 404 goneResponse with no body bytes", async () => {
    const data = bytes("secret", 4096);
    const fake = makeFakeLink({
      data,
      onGet: async (message, emit) => {
        await Promise.resolve();
        emit({ t: "content.gone", req: message.req, id: message.id, reason: "denied" });
      },
    });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/secret.png", "m1");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(404);
    expect(response.headers.get("x-botling-content")).toBe("gone; reason=denied");
    expect(await response.text()).toBe("This file is not part of that message.");
    expect(fake.asked).toEqual(["content.find"]);
    expect(fake.gets).toHaveLength(1);
  });

  it("6. content.gone{offline} mid-stream rejects the body after delivering earlier bytes", async () => {
    const data = bytes("half", 300_000);
    let failStream!: () => void;
    const readyToFail = new Promise<void>((resolve) => { failStream = resolve; });
    const fake = makeFakeLink({
      data,
      onGet: async (message, emit) => {
        await Promise.resolve();
        emit({ t: "content.meta", req: message.req, id: message.id, size: data.length, type: "video/mp4", chunkSize: MiB, variants: [] });
        if (message.length <= 65_536) {
          emit({ t: "content.chunk", req: message.req, offset: 0, bytes: new Uint8Array(data.subarray(0, 65_536)) });
          return;
        }
        const half = 2 * PEER_CHUNK;
        for (let pos = message.offset; pos < half; pos += PEER_CHUNK) {
          await Promise.resolve();
          emit({ t: "content.chunk", req: message.req, offset: pos, bytes: new Uint8Array(data.subarray(pos, pos + PEER_CHUNK)) });
        }
        await readyToFail;
        emit({ t: "content.gone", req: message.req, id: message.id, reason: "offline" });
      },
    });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/half.mp4", "m1");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const got: Buffer[] = [];
    let total = 0;
    while (total < 2 * PEER_CHUNK) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      got.push(Buffer.from(value!));
      total += value!.byteLength;
    }
    failStream();
    let caught: unknown = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got.push(Buffer.from(value));
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("offline");
    const received = Buffer.concat(got);
    expect(received.length).toBe(2 * PEER_CHUNK);
    expect(received.equals(data.subarray(0, 2 * PEER_CHUNK))).toBe(true);
  });

  it("7. Cancelling the body mid-way sends content.cancel for the stream req", async () => {
    const data = bytes("cancel", 512_000);
    let streamReq: string | null = null;
    const fake = makeFakeLink({
      data,
      onGet: async (message, emit, isCancelled) => {
        await Promise.resolve();
        emit({ t: "content.meta", req: message.req, id: message.id, size: data.length, type: "video/mp4", chunkSize: MiB, variants: [] });
        if (message.length <= 65_536) {
          emit({ t: "content.chunk", req: message.req, offset: 0, bytes: new Uint8Array(data.subarray(0, 65_536)) });
          return;
        }
        streamReq = message.req;
        emit({ t: "content.chunk", req: message.req, offset: message.offset, bytes: new Uint8Array(data.subarray(message.offset, message.offset + PEER_CHUNK)) });
        await new Promise((r) => setTimeout(r, 30));
        if (!isCancelled()) {
          emit({ t: "content.chunk", req: message.req, offset: message.offset + PEER_CHUNK, bytes: new Uint8Array(data.subarray(message.offset + PEER_CHUNK, message.offset + 2 * PEER_CHUNK)) });
        }
      },
    });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/cancel.mp4", "m1");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("user seeked");

    expect(streamReq).not.toBeNull();
    expect(fake.cancels.map((c) => c.req)).toContain(streamReq);
  });

  it("8. A local ref (owner === attachedServerId()) calls content.open, never content.get", async () => {
    const data = bytes("local", 4096);
    const localPath = join(scratch, "local.png");
    writeFileSync(localPath, data);
    const localFile: MessageOf<"content.file"> = {
      t: "content.file", req: "r0", id: sha256Id(data), path: localPath, type: "image/png", pin: "copy", sig: statSig(localPath),
    };
    const fake = makeFakeLink({ owner: LOCAL_SERVER, data, type: "image/png", localFile });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest(`file://${localPath}`, "m1");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(data)).toBe(true);
    expect(fake.asked).toEqual(["content.find", "content.open"]);
    expect(fake.gets).toHaveLength(0);
  });

  it("9. Detached (postContent returns false) answers 503 offline", async () => {
    const data = bytes("offline", 1024);
    const fake = makeFakeLink({ data, detached: true });
    const protocol = new ContentProtocol({ link: () => fake.link });
    const req = chatRequest("file:///peer/offline.png", "m1");
    const response = (await protocol.chatAttachment(req.url, req.request))!;

    expect(response.status).toBe(503);
    expect(response.headers.get("x-botling-content")).toBe("gone; reason=offline");
  });

  it("sends content.credit per 1 MiB pulled on large reads, and caches probe metadata for seeks including text sniffing", async () => {
    const data = bytes("big", 3 * MiB + 123);
    const fake = makeFakeLink({ data, type: "video/mp4" });
    const protocol = new ContentProtocol({ link: () => fake.link });

    const r1 = chatRequest("file:///peer/big.mp4", "m1", "GET", "bytes=0-");
    const res1 = (await protocol.chatAttachment(r1.url, r1.request))!;
    expect(Buffer.from(await res1.arrayBuffer()).equals(data)).toBe(true);
    const totalCredit = fake.credits.reduce((sum, c) => sum + c.bytes, 0);
    expect(totalCredit).toBeGreaterThanOrEqual(2 * MiB);

    // Seek uses cached metadata without another probe.
    const getsBefore = fake.gets.length;
    const r2 = chatRequest("file:///peer/big.mp4", "m1", "GET", `bytes=${MiB}-${MiB + 99}`);
    const res2 = (await protocol.chatAttachment(r2.url, r2.request))!;
    expect(res2.status).toBe(206);
    expect(Buffer.from(await res2.arrayBuffer()).equals(data.subarray(MiB, MiB + 100))).toBe(true);
    expect(fake.gets.length - getsBefore).toBe(1);
    expect(fake.gets[fake.gets.length - 1]!.offset).toBe(MiB);

    // Non-UTF-8 text file: probe sniffs no charset=utf-8, and seek preserves exact Content-Type.
    const badText = Buffer.alloc(100, 0xff);
    const textFake = makeFakeLink({ data: badText, type: "text/plain" });
    const textProto = new ContentProtocol({ link: () => textFake.link });
    const t1 = chatRequest("file:///peer/raw.txt", "m1", "GET", "bytes=0-9");
    const t1Res = (await textProto.chatAttachment(t1.url, t1.request))!;
    expect(t1Res.headers.get("content-type")).toBe("text/plain");
    const t2 = chatRequest("file:///peer/raw.txt", "m1", "GET", "bytes=10-19");
    const t2Res = (await textProto.chatAttachment(t2.url, t2.request))!;
    expect(t2Res.headers.get("content-type")).toBe("text/plain");
    expect(textFake.gets).toHaveLength(3); // 1 probe + 2 range streams
  });

  it("handles preparing/changed/gone states and probe timeout", async () => {
    const data = bytes("states", 1024);
    for (const [state, status, reason] of [
      ["preparing", 503, "offline"],
      ["changed", 410, "changed"],
      ["gone", 410, "deleted"],
    ] as const) {
      const fake = makeFakeLink({ data, state });
      const protocol = new ContentProtocol({ link: () => fake.link });
      const req = chatRequest("file:///peer/s.png", "m1");
      const res = (await protocol.chatAttachment(req.url, req.request))!;
      expect(res.status).toBe(status);
      expect(res.headers.get("x-botling-content")).toBe(`gone; reason=${reason}`);
      expect(fake.gets).toHaveLength(0);
    }

    const silent = makeFakeLink({ data, onGet: () => {} });
    const timeoutProto = new ContentProtocol({ link: () => silent.link, timeoutMs: 25 });
    const req = chatRequest("file:///peer/hang.png", "m1");
    const res = (await timeoutProto.chatAttachment(req.url, req.request))!;
    expect(res.status).toBe(503);
    expect(res.headers.get("x-botling-content")).toBe("gone; reason=offline");
    expect(silent.cancels).toHaveLength(1);
  });
  it("credit-gated streaming past the 4 MiB initial window completes a 5 MiB read", async () => {
    const data = bytes("five-mib", 5 * MiB + 7);
    let credit = 4 * MiB;
    let wake: (() => void) | null = null;
    const base = makeFakeLink({
      data,
      onGet: async (message, emit, isCancelled) => {
        await Promise.resolve();
        emit({ t: "content.meta", req: message.req, id: message.id, size: data.length, type: "video/mp4", chunkSize: MiB, variants: [] });
        const end = Math.min(data.length, message.offset + message.length);
        let pos = message.offset;
        while (pos < end && !isCancelled()) {
          const piece = Math.min(PEER_CHUNK, end - pos);
          while (credit < piece && !isCancelled()) {
            await new Promise<void>((resolve) => { wake = resolve; });
          }
          if (isCancelled()) return;
          credit -= piece;
          emit({ t: "content.chunk", req: message.req, offset: pos, bytes: new Uint8Array(data.subarray(pos, pos + piece)) });
          pos += piece;
          await Promise.resolve();
        }
      },
    });
    const gatedLink: ContentLink = {
      ...base.link,
      postContent(message) {
        const ok = base.link.postContent(message);
        if (ok && message.t === "content.credit") {
          credit += message.bytes;
          const w = wake;
          wake = null;
          w?.();
        }
        return ok;
      },
    };
    const protocol = new ContentProtocol({ link: () => gatedLink });
    const req = chatRequest("file:///peer/five.mp4", "m1");
    const res = (await protocol.chatAttachment(req.url, req.request))!;
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(data)).toBe(true);
    expect(base.credits.length).toBeGreaterThanOrEqual(1);
  });
});
