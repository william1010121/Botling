// M2 step 12 (protocol v1 §9A.9, D40): uploads from a front end. The incremental SHA-256 against node's; the server's
// upload store (put, chunks within the credit, resume from `have`, a chunk out of place, a newer put taking over, the
// hash check, `whenComplete`); the front end's Uploader against that store (resume after a dropped session, > 500 MB
// refused before sending, a refused hash); a session holding a `chat.send` with files until the last chunk, then
// handing it on once; the intent handler and the 2.x core refusing what they must; the page bridge's chips and
// `chat.send` files; the contract's `files`.
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Command, PROTOCOL_VERSION, UPLOAD_LIMIT, type PendingFileView, type UploadedFile } from "../../src/contract";
import { Sha256, TOO_LARGE_TEXT, Uploader, type UploadAnswer, type UploadLink, type UploadSource } from "../../src/fe-link";
import { decodeFrame, encodeChunkFrame, encodeFrame, FrameSplitter, packFrame, type Message, type MessageOf } from "../../src/protocol";
import { Uploads, type UploadReply } from "../../src/server/content";
import { Session, type SessionHost } from "../../src/server/session/session";
import { BridgeV3, type AdapterPort } from "../../web-v3/bridge-v3";
import type { PageUploadsPort } from "../../web-v3/shell/uploads";
import { testRoot } from "../botlingd-harness";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir } from "../helpers";
import { harness, outcomeOf, type Harness } from "./server-intents-harness";

const root = testRoot("uploads");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const newDir = () => { const dir = join(root, `u${++dirs}`); mkdirSync(dir, { recursive: true }); return dir; };
const KiB = 1024;
const hexOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const idOf = (bytes: Uint8Array) => `sha256:${hexOf(bytes)}`;

describe("Sha256 (incremental)", () => {
  it("matches node's SHA-256 for every length around the block edges, fed whole or in odd pieces", () => {
    for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096 + 7]) {
      const data = randomBytes(length);
      expect(new Sha256().update(data).hex()).toBe(hexOf(data));
      const pieces = new Sha256();
      for (let at = 0; at < length; at += 13) pieces.update(data.subarray(at, Math.min(length, at + 13)));
      expect(pieces.hex()).toBe(hexOf(data));
    }
  });

  it("a 3 MiB input read 1 MiB at a time; it cannot be digested twice", () => {
    const data = randomBytes(3 * 1024 * KiB + 11);
    const hash = new Sha256();
    for (let at = 0; at < data.length; at += 1024 * KiB) hash.update(data.subarray(at, at + 1024 * KiB));
    expect(hash.hex()).toBe(hexOf(data));
    expect(() => hash.digest()).toThrow(/already/);
  });
});

const put = (req: string, bytes: Uint8Array, extra: Partial<MessageOf<"content.put">> = {}): MessageOf<"content.put"> =>
  ({ t: "content.put", req, id: idOf(bytes), size: bytes.length, type: "application/pdf", name: "a.pdf", ...extra });
const chunk = (req: string, offset: number, bytes: Uint8Array): MessageOf<"content.chunk"> => ({ t: "content.chunk", req, offset, bytes: new Uint8Array(bytes) });

describe("Uploads (the server's store)", () => {
  it("put answers what is here and a window; chunks in order fill it; the last one checks the hash and keeps the file", async () => {
    const dir = newDir();
    const uploads = new Uploads({ dir, window: 64 * KiB });
    const data = randomBytes(200 * KiB);
    expect(await uploads.put("s1", put("r1", data))).toEqual([
      { t: "content.stored", req: "r1", id: idOf(data), have: 0 }, { t: "content.credit", req: "r1", bytes: 64 * KiB },
    ]);
    const replies: UploadReply[] = [];
    for (let at = 0; at < data.length; at += 16 * KiB) replies.push(...await uploads.chunk("s1", chunk("r1", at, data.subarray(at, at + 16 * KiB))));
    // The window is topped up when half used, so the sender never stops; the last chunk answers stored(size).
    expect(replies.filter((r) => r.t === "content.credit").length).toBeGreaterThan(0);
    expect(replies.at(-1)).toEqual({ t: "content.stored", req: "r1", id: idOf(data), have: data.length });
    expect(uploads.complete(idOf(data))?.size).toBe(data.length);
    expect(readFileSync(uploads.complete(idOf(data))!.path)).toEqual(Buffer.from(data));
    expect(uploads.list()).toEqual([hexOf(data)]);
    // A put of a file already here: stored(size) at once.
    expect(await uploads.put("s2", put("r2", data))).toEqual([{ t: "content.stored", req: "r2", id: idOf(data), have: data.length }]);
  });

  it("a session that ends leaves the part; the next put goes on from it (no restart from 0)", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const data = randomBytes(100 * KiB);
    await uploads.put("s1", put("r1", data));
    await uploads.chunk("s1", chunk("r1", 0, data.subarray(0, 40 * KiB)));
    await uploads.ended("s1");
    // The old req is gone with its session.
    expect(await uploads.chunk("s1", chunk("r1", 40 * KiB, data.subarray(40 * KiB, 50 * KiB)))).toEqual([]);
    const again = await uploads.put("s2", put("r2", data));
    expect(again[0]).toEqual({ t: "content.stored", req: "r2", id: idOf(data), have: 40 * KiB });
    expect((await uploads.chunk("s2", chunk("r2", 40 * KiB, data.subarray(40 * KiB)))).at(-1)).toMatchObject({ t: "content.stored", have: data.length });
    expect(uploads.complete(idOf(data))).not.toBeNull();
  });

  it("a chunk not at `have`, or over the window, is not written: the sender is told where the server is", async () => {
    const uploads = new Uploads({ dir: newDir(), window: 32 * KiB });
    const data = randomBytes(100 * KiB);
    await uploads.put("s1", put("r1", data));
    await uploads.chunk("s1", chunk("r1", 0, data.subarray(0, 8 * KiB)));
    expect(await uploads.chunk("s1", chunk("r1", 16 * KiB, data.subarray(16 * KiB, 24 * KiB)))).toEqual([
      { t: "content.stored", req: "r1", id: idOf(data), have: 8 * KiB }, { t: "content.credit", req: "r1", bytes: 32 * KiB },
    ]);
    expect(await uploads.chunk("s1", chunk("r1", 8 * KiB, data.subarray(8 * KiB, 48 * KiB)))).toMatchObject([{ t: "content.stored", have: 8 * KiB }, { t: "content.credit" }]);
    expect(uploads.have(idOf(data), data.length)).toBe(8 * KiB);
    // Another session's chunks under this req are ignored.
    expect(await uploads.chunk("s9", chunk("r1", 8 * KiB, data.subarray(8 * KiB, 9 * KiB)))).toEqual([]);
  });

  it("a newer put of the same id takes it over: the older req's chunks are refused", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const data = randomBytes(64 * KiB);
    await uploads.put("s1", put("r1", data));
    await uploads.chunk("s1", chunk("r1", 0, data.subarray(0, 10 * KiB)));
    expect((await uploads.put("s2", put("r2", data)))[0]).toMatchObject({ have: 10 * KiB });
    expect(await uploads.chunk("s1", chunk("r1", 10 * KiB, data.subarray(10 * KiB, 20 * KiB)))).toEqual([]);
    expect((await uploads.chunk("s2", chunk("r2", 10 * KiB, data.subarray(10 * KiB)))).at(-1)).toMatchObject({ t: "content.stored", have: data.length });
  });

  it("bytes that do not hash to the id are refused (content.gone changed) and never kept; a waiting command hears it at once", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const data = randomBytes(20 * KiB);
    const id = idOf(data);
    const wrong = new Uint8Array(data);
    wrong[0]! ^= 0xff;
    await uploads.put("s1", put("r1", data));
    const waiting = uploads.whenComplete([id], new Promise(() => undefined), 60_000);
    expect(await uploads.chunk("s1", chunk("r1", 0, wrong))).toEqual([{ t: "content.gone", req: "r1", id, reason: "changed" }]);
    expect(await waiting).toBe("refused");
    expect(uploads.complete(id)).toBeNull();
    expect(uploads.refused(id)).toBe(true);
    expect(uploads.list()).toEqual([]);
    // A new put of the id clears it (the next bytes may be right).
    await uploads.put("s1", put("r2", data));
    expect(uploads.refused(id)).toBe(false);
  });

  it("refuses a malformed id or a size above the limit before writing", async () => {
    const uploads = new Uploads({ dir: newDir() });
    expect(await uploads.put("s1", { t: "content.put", req: "r1", id: "sha256:xyz", size: 10, type: "a/b", name: "x" })).toEqual([{ t: "content.gone", req: "r1", id: "sha256:xyz", reason: "too-large" }]);
    expect(await uploads.put("s1", { t: "content.put", req: "r2", id: `sha256:${"a".repeat(64)}`, size: UPLOAD_LIMIT + 1, type: "a/b", name: "x" })).toMatchObject([{ t: "content.gone", reason: "too-large" }]);
  });

  it("whenComplete: ready once every id is in, closed when the session ends first, idle after the wait without a byte", async () => {
    let now = 1_000;
    const uploads = new Uploads({ dir: newDir(), now: () => now });
    const data = randomBytes(8 * KiB);
    await uploads.put("s1", put("r1", data));
    const ready = uploads.whenComplete([idOf(data)], new Promise(() => undefined), 60_000);
    await uploads.chunk("s1", chunk("r1", 0, data));
    expect(await ready).toBe("ready");
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const other = `sha256:${"b".repeat(64)}`;
    const waiting = uploads.whenComplete([other], closed, 60_000);
    close();
    expect(await waiting).toBe("closed");
    // Idle is counted from when the command started waiting (or the last byte, if later).
    now += 120_000;
    const idle = new Uploads({ dir: newDir() });
    expect(await idle.whenComplete([other], new Promise(() => undefined), 20)).toBe("idle");
  });
});

/** An UploadLink straight into an Uploads store (no wire), whose session can be dropped and attached again. */
class StoreLink implements UploadLink {
  attached = true;
  session = 1;
  puts: Array<MessageOf<"content.put">> = [];
  chunks = 0;
  private reqs = 0;
  private readonly listeners = new Map<string, (message: UploadAnswer) => void>();
  private readonly events = new Set<(event: { type: string; attached?: boolean }) => void>();
  private chain = Promise.resolve();
  /** Drop the session after this many chunks (once). */
  dropAfter = Infinity;
  constructor(readonly store: Uploads, private readonly tamper?: (message: MessageOf<"content.chunk">) => void) {}
  newReq(): string { return `q${++this.reqs}`; }
  onUpload(req: string, listener: (message: UploadAnswer) => void): () => void { this.listeners.set(req, listener); return () => { this.listeners.delete(req); }; }
  on(listener: (event: { type: string; attached?: boolean }) => void): () => void { this.events.add(listener); return () => { this.events.delete(listener); }; }
  postUpload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): boolean {
    if (!this.attached) return false;
    const owner = `s${this.session}`;
    if (message.t === "content.put") this.puts.push(message);
    else { this.chunks += 1; this.tamper?.(message); }
    this.chain = this.chain.then(async () => {
      const replies = message.t === "content.put" ? await this.store.put(owner, message) : await this.store.chunk(owner, message);
      if (owner !== `s${this.session}`) return;
      for (const reply of replies) this.listeners.get(reply.req)?.(reply);
    });
    if (message.t === "content.chunk" && this.chunks >= this.dropAfter) { this.dropAfter = Infinity; void this.chain.then(() => this.drop()); }
    return true;
  }
  async drop(): Promise<void> {
    this.attached = false;
    await this.store.ended(`s${this.session}`);
    this.session += 1;
    for (const listener of [...this.events]) listener({ type: "attached", attached: false });
  }
  attach(): void {
    this.attached = true;
    for (const listener of [...this.events]) listener({ type: "attached", attached: true });
  }
  idle(): Promise<void> { return this.chain; }
}

const source = (data: Uint8Array): UploadSource => ({ size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) });
const settleAll = async (link: StoreLink) => { for (let i = 0; i < 50; i += 1) { await link.idle(); await new Promise((r) => setImmediate(r)); } };

describe("Uploader (the front end)", () => {
  it("hashes, puts and sends within the credit until the server has it all", async () => {
    const link = new StoreLink(new Uploads({ dir: newDir(), window: 256 * KiB }));
    const uploader = new Uploader(link, { chunkBytes: 32 * KiB });
    const data = randomBytes(1_500 * KiB);
    const view = uploader.add({ name: "talk.mp4", type: "video/mp4", source: source(data) });
    expect(await uploader.id(view.key)).toBe(idOf(data));
    await settleAll(link);
    expect(uploader.get(view.key)).toMatchObject({ state: "done", sent: data.length, puts: 1, resumedAt: [] });
    expect(link.store.complete(idOf(data))?.size).toBe(data.length);
    expect(link.puts[0]).toMatchObject({ id: idOf(data), size: data.length, type: "video/mp4", name: "talk.mp4" });
  });

  it("a dropped session: the next one puts again and goes on from what the server has", async () => {
    const link = new StoreLink(new Uploads({ dir: newDir(), window: 256 * KiB }));
    link.dropAfter = 10;
    const uploader = new Uploader(link, { chunkBytes: 32 * KiB });
    const data = randomBytes(1_000 * KiB);
    const view = uploader.add({ name: "a.pdf", type: "application/pdf", source: source(data) });
    await settleAll(link);
    expect(uploader.get(view.key)!.state).toBe("waiting");
    const before = link.chunks;
    link.attach();
    await settleAll(link);
    const done = uploader.get(view.key)!;
    expect(done).toMatchObject({ state: "done", puts: 2 });
    expect(done.resumedAt).toEqual([10 * 32 * KiB]);
    // Only the rest went the second time.
    expect((link.chunks - before) * 32 * KiB).toBeLessThanOrEqual(data.length - 10 * 32 * KiB + 32 * KiB);
    expect(link.store.complete(idOf(data))).not.toBeNull();
  });

  it("refuses above 500 MB (and an empty file) before anything is sent", async () => {
    const link = new StoreLink(new Uploads({ dir: newDir() }));
    const uploader = new Uploader(link);
    let reads = 0;
    const huge = uploader.add({ name: "huge.mov", type: "video/quicktime", source: { size: UPLOAD_LIMIT + 1, read: async () => { reads += 1; return new Uint8Array(0); } } });
    expect(huge).toMatchObject({ state: "failed", error: TOO_LARGE_TEXT, puts: 0, id: null });
    await expect(uploader.id(huge.key)).rejects.toThrow(/500 MB/);
    expect(uploader.add({ name: "empty", type: "text/plain", source: source(new Uint8Array(0)) })).toMatchObject({ state: "failed" });
    await settleAll(link);
    expect(reads).toBe(0);
    expect(link.puts).toEqual([]);
  });

  it("a server that refuses the bytes (they changed) ends the upload as failed", async () => {
    const link = new StoreLink(new Uploads({ dir: newDir() }), (message) => { if (message.offset === 0) message.bytes[0]! ^= 0xff; });
    const uploader = new Uploader(link);
    const data = randomBytes(100 * KiB);
    const view = uploader.add({ name: "x.pdf", type: "application/pdf", source: source(data) });
    await settleAll(link);
    expect(uploader.get(view.key)).toMatchObject({ state: "failed", error: expect.stringMatching(/did not match their hash/) });
    expect(link.store.complete(idOf(data))).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// A session holding a `chat.send` with files.

const TOKEN = "t".repeat(32);
const EPOCH = "0123456789abcdef0123456789abcdef";
const LOCAL = { local: true } as const;
const BOT = "6A0B0000-0000-4000-8000-000000000002";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean { this.writes.push(bytes); return true; }
  end(): void { /* the session closes itself */ }
  destroy(): void { this.destroyed = true; }
  frames(): Message[] {
    const splitter = new FrameSplitter();
    const out: Message[] = [];
    for (const bytes of this.writes) {
      const split = splitter.push(bytes);
      if (!split.ok) throw new Error(split.detail);
      for (const frame of split.frames) {
        const decoded = decodeFrame(frame, "server", LOCAL);
        if (!decoded.ok) throw new Error(decoded.detail);
        out.push(decoded.message);
      }
    }
    return out;
  }
  feed(message: Message): void {
    if (message.t === "content.chunk") {
      const encoded = encodeChunkFrame(message, "fe", LOCAL);
      if (!encoded.ok) throw new Error(encoded.detail);
      this.emit("data", Buffer.from(packFrame(encoded.bytes)));
      return;
    }
    const encoded = encodeFrame(message, "fe", LOCAL);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.emit("data", Buffer.from(packFrame(encoded.text)));
  }
}

function openSession(uploads: Uploads, options: { uploadIdleMs?: number } = {}) {
  const received: Array<{ cmd: Command; complete: boolean }> = [];
  const log: string[] = [];
  const host = {
    serverId: "server-1", serverName: "Mac", startedAt: 0, minFeVersion: "3.0.0", token: () => TOKEN,
    hub: { attach: () => ({ close() {}, sub: async () => ({ ok: false, reason: "unknown stream" }), ack() {}, history: () => null }), reader: () => null },
    live: { subscribe: () => ({ close() {}, resync() {} }) },
    runtime: {
      receive: async (body: { cmd: Command }) => {
        const files = body.cmd.type === "chat.send" ? body.cmd.files ?? [] : [];
        received.push({ cmd: body.cmd, complete: files.every((file) => uploads.complete(file.id)) });
        return { status: "result", message: { t: "result" } };
      },
    },
    engine: { run: async () => null }, content: null, uploads,
    shell: { attach() {}, detach() {}, answer() {} },
    nextFor: () => ({}), ensureBotStream: async () => false, log: (text: string) => log.push(text),
  } as unknown as SessionHost;
  const socket = new FakeSocket();
  const session = new Session(socket as never, host, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000, ...options });
  socket.feed({ t: "hello", deviceId: "test", feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], token: TOKEN } as never);
  return { socket, session, received, log };
}

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const sendCmd = (socket: FakeSocket, n: number, files: UploadedFile[]) => socket.feed({
  t: "cmd", slot: { origin: "test", originEpoch: EPOCH, target: `bot:${BOT}`, n }, floor: n, inc: "logAAAAAAAAA",
  cmd: { type: "chat.send", botId: BOT, text: "the file", files },
} as never);
const fileOf = (data: Uint8Array, name = "a.pdf"): UploadedFile => ({ id: idOf(data), name, size: data.length, type: "application/pdf" });

describe("a session holds a chat.send with files until their bytes are in", () => {
  it("held at once, handed on once after the last chunk", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const { socket, session, received } = openSession(uploads);
    const data = randomBytes(150 * KiB);
    socket.feed(put("r1", data));
    sendCmd(socket, 1, [fileOf(data)]);
    await wait();
    expect(socket.frames().filter((f) => f.t === "held")).toHaveLength(1);
    expect(socket.frames().find((f) => f.t === "content.stored")).toMatchObject({ req: "r1", have: 0 });
    expect(received).toEqual([]);
    for (let at = 0; at < data.length; at += 50 * KiB) {
      socket.feed(chunk("r1", at, data.subarray(at, at + 50 * KiB)));
      await wait(5);
      if (at + 50 * KiB < data.length) expect(received).toEqual([]);
    }
    await wait();
    expect(received).toHaveLength(1);
    expect(received[0]!.complete).toBe(true);
    expect(socket.frames().filter((f) => f.t === "content.stored").at(-1)).toMatchObject({ have: data.length });
    session.close();
  });

  it("files already here: no hold", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const data = randomBytes(10 * KiB);
    await uploads.put("x", put("r0", data));
    await uploads.chunk("x", chunk("r0", 0, data));
    const { socket, session, received } = openSession(uploads);
    sendCmd(socket, 1, [fileOf(data)]);
    await wait();
    expect(socket.frames().filter((f) => f.t === "held")).toEqual([]);
    expect(received).toHaveLength(1);
    session.close();
  });

  it("the session ends during the hold: nothing is handed on (the outbox sends it again on the next one)", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const { socket, session, received } = openSession(uploads);
    const data = randomBytes(10 * KiB);
    sendCmd(socket, 1, [fileOf(data)]);
    await wait();
    session.close();
    await wait();
    expect(received).toEqual([]);
  });

  it("no byte for the idle wait, or bytes refused: the handler decides (and refuses)", async () => {
    const uploads = new Uploads({ dir: newDir() });
    const { socket, session, received } = openSession(uploads, { uploadIdleMs: 30 });
    const data = randomBytes(10 * KiB);
    sendCmd(socket, 1, [fileOf(data)]);
    await wait(80);
    expect(received).toHaveLength(1);
    expect(received[0]!.complete).toBe(false);
    session.close();

    const second = openSession(uploads, { uploadIdleMs: 60_000 });
    const other = randomBytes(10 * KiB);
    second.socket.feed(put("r2", other));
    sendCmd(second.socket, 1, [fileOf(other)]);
    await wait();
    const wrong = new Uint8Array(other);
    wrong[5]! ^= 1;
    second.socket.feed(chunk("r2", 0, wrong));
    await wait(30);
    expect(second.socket.frames().find((f) => f.t === "content.gone")).toMatchObject({ req: "r2", reason: "changed" });
    expect(second.received).toHaveLength(1);
    second.session.close();
  });
});

// ------------------------------------------------------------------------------------------------
// The intent handler and the 2.x core.

describe("chat.send with files: the handler", () => {
  const open: Harness[] = [];
  afterEach(() => { for (const h of open.splice(0)) h.close(); });

  it("applies with the files when they are in (the turn gets their ids and names), refuses when one is missing, refused or of another size", async () => {
    const present = randomBytes(10);
    const store = {
      complete: (id: string) => id === idOf(present) ? { path: "/x", size: present.length } : null,
      refused: (id: string) => id === `sha256:${"c".repeat(64)}`,
    };
    const h = await harness({}, undefined, { uploads: store });
    open.push(h);
    const ok = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "", files: [fileOf(present, "talk.mp4")] }));
    expect(ok.kind).toBe("applied");
    await h.settle();
    expect(h.engine.starts[0]).toMatchObject({ send: { files: [{ id: idOf(present), name: "talk.mp4" }] } });
    const missing = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x", files: [{ ...fileOf(present), id: `sha256:${"d".repeat(64)}`, name: "gone.pdf" }] }));
    expect(missing).toMatchObject({ kind: "refused", reason: "invalid", detail: expect.stringMatching(/gone\.pdf did not arrive/) });
    const refused = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x", files: [{ ...fileOf(present), id: `sha256:${"c".repeat(64)}`, name: "bad.pdf" }] }));
    expect(refused).toMatchObject({ kind: "refused", detail: expect.stringMatching(/bad\.pdf was refused: its bytes did not match/) });
    const size = outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x", files: [{ ...fileOf(present), size: 99 }] }));
    expect(size).toMatchObject({ kind: "refused", detail: expect.stringMatching(/not the size/) });
  });

  it("refuses files when this server has no upload store", async () => {
    const h = await harness();
    open.push(h);
    const present = randomBytes(10);
    expect(outcomeOf(await h.send({ type: "chat.send", botId: "B1", text: "x", files: [fileOf(present)] }))).toMatchObject({ kind: "refused", reason: "invalid" });
  });
});

describe("the 2.x core keeps chat.send without files", () => {
  const harnesses: CoreHarness[] = [];
  afterEach(async () => { for (const c of harnesses.splice(0)) if (c.child.exitCode === null && c.child.signalCode === null) await c.kill("SIGKILL"); });
  it("refuses a chat.send that names files by hash (only Botling 3's server takes them)", async () => {
    const dir = tempDir("core-files");
    const c = new CoreHarness(dir);
    harnesses.push(c);
    await expect(c.call({ type: "chat.send", botId: MAIN, text: "x", files: [fileOf(randomBytes(4))] })).rejects.toThrow(/Botling 3 server/);
    expect(existsSync(join(dir, "incoming"))).toBe(false);
  });
});

describe("contract: chat.send files", () => {
  it("takes up to 50 files named by sha256, each at most 500 MB, and nothing else", () => {
    const file = fileOf(randomBytes(4));
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: [file] }).success).toBe(true);
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: [] }).success).toBe(false);
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: [{ ...file, id: "md5:abc" }] }).success).toBe(false);
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: [{ ...file, size: UPLOAD_LIMIT + 1 }] }).success).toBe(false);
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: [{ ...file, path: "/etc/passwd" }] }).success).toBe(false);
    expect(Command.safeParse({ type: "chat.send", botId: BOT, text: "x", files: Array.from({ length: 51 }, () => file) }).success).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// The page bridge.

class FakeUploads implements PageUploadsPort {
  chips: PendingFileView[] = [{ id: "u1-x", name: "talk.mp4 · sending", kind: "file" }];
  removed: string[] = [];
  untaken = 0;
  fail: string | null = null;
  private readonly listeners = new Set<() => void>();
  pending(botId: string) { return botId === "B1" ? this.chips : []; }
  owns(botId: string, id: string) { return botId === "B1" && this.chips.some((chip) => chip.id === id); }
  remove(_botId: string, id: string) { this.removed.push(id); this.chips = this.chips.filter((chip) => chip.id !== id); }
  async take(botId: string): Promise<UploadedFile[]> {
    if (this.fail) throw new Error(this.fail);
    if (botId !== "B1" || !this.chips.length) return [];
    this.chips = [];
    return [{ id: `sha256:${"e".repeat(64)}`, name: "talk.mp4", size: 5, type: "video/mp4" }];
  }
  untake() { this.untaken += 1; }
  onChipsChanged(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

function bridgeWith(uploads: FakeUploads, answer: (cmd: Command) => unknown = () => ({ ok: true, result: {} })) {
  const sent: Command[] = [];
  const adapter: AdapterPort = { request: async (cmd: Command) => { sent.push(cmd); return answer(cmd) as never; } };
  const bridge = new BridgeV3(adapter, { openLink: () => undefined, narrow: () => true, scopes: ["read", "reply", "approve", "manage"], uploads });
  const responses: Array<{ id: string; ok: boolean; result?: unknown; error?: { message: string } }> = [];
  bridge.subscribe((message) => { if ((message as { id?: string }).id) responses.push(message as never); });
  const ask = async (id: string, cmd: Command) => {
    bridge.post({ v: PROTOCOL_VERSION, id, cmd });
    for (let i = 0; i < 20 && !responses.some((r) => r.id === id); i += 1) await wait(1);
    return responses.find((r) => r.id === id)!;
  };
  return { bridge, sent, ask };
}

describe("BridgeV3 with the page's attachments", () => {
  it("a chat.send takes the chips as files; files.remove of a chip is answered by the page", async () => {
    const uploads = new FakeUploads();
    const { sent, ask } = bridgeWith(uploads);
    const removed = await ask("1", { type: "files.remove", botId: "B1", id: "u1-x" });
    expect(removed).toMatchObject({ ok: true, result: { files: [] } });
    expect(uploads.removed).toEqual(["u1-x"]);
    expect(sent).toEqual([]);
    uploads.chips = [{ id: "u2-x", name: "talk.mp4 · ready", kind: "file" }];
    expect(await ask("2", { type: "chat.send", botId: "B1", text: "see this" })).toMatchObject({ ok: true });
    expect(sent).toEqual([{ type: "chat.send", botId: "B1", text: "see this", files: [{ id: `sha256:${"e".repeat(64)}`, name: "talk.mp4", size: 5, type: "video/mp4" }] }]);
  });

  it("a failed attachment stops the send on the page; a refused send puts the chips back", async () => {
    const uploads = new FakeUploads();
    uploads.fail = "talk.mp4 cannot be sent: refused. Remove it first.";
    const first = bridgeWith(uploads);
    expect(await first.ask("1", { type: "chat.send", botId: "B1", text: "x" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cannot be sent/) } });
    expect(first.sent).toEqual([]);
    uploads.fail = null;
    const second = bridgeWith(uploads, () => ({ ok: false, error: { code: "forbidden", message: "no" } }));
    expect(await second.ask("2", { type: "chat.send", botId: "B1", text: "x" })).toMatchObject({ ok: false });
    expect(uploads.untaken).toBe(1);
  });

  it("the snapshot and files.updated show the server's files, then the page's chips", async () => {
    const uploads = new FakeUploads();
    const server: PendingFileView = { id: "srv1", name: "notes.txt", kind: "file" };
    const { bridge, ask } = bridgeWith(uploads, (cmd) => cmd.type === "chat.snapshot"
      ? { ok: true, result: { epoch: "e", seq: 1, bots: [], imported: null, chat: { botId: "B1", messages: [], running: null, live: [], runs: [], heads: null, pendingFiles: [server] }, components: {}, plugins: { installed: [] } } }
      : { ok: true, result: {} });
    const snap = await ask("1", { type: "chat.snapshot", botId: "B1" });
    expect((snap.result as { chat: { pendingFiles: PendingFileView[] } }).chat.pendingFiles.map((f) => f.id)).toEqual(["srv1", "u1-x"]);
    const events: unknown[] = [];
    bridge.subscribe((message) => { if ((message as { event?: unknown }).event) events.push(message); });
    bridge.emit({ v: 2, epoch: "e", seq: 2, event: { type: "files.updated", botId: "B1", files: [server] } } as never);
    expect(events).toEqual([{ v: 2, epoch: "e", seq: 2, event: { type: "files.updated", botId: "B1", files: [server, uploads.chips[0]] } }]);
  });
});
