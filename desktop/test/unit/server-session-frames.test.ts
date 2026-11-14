// botlingd never tries to write a frame over the protocol's limit without saying so (M1 demo bugs 1 and 3): a `req`'s
// answer too large for one frame (plugins.web: every web part's source, ~2 MB) goes as `res.part`s the front end joins;
// an answer that cannot be sent at all is answered with an error naming its command; any other frame over the limit is
// refused before it reaches the socket, and the log names it, its reason and what it was for.
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeFrame, encodeFrame, encodeResFrames, FRAME_LIMIT, FrameSplitter, packFrame, RES_PART_CHARS, ResAssembler,
  type Message, type MessageOf,
} from "../../src/protocol";
import { Session, type SessionHost } from "../../src/server/session/session";

const TOKEN = "t".repeat(32);
const EPOCH = "0123456789abcdef0123456789abcdef";
const LOCAL = { local: true } as const;

/** A socket as Session uses it: what it writes is cut back into frames here. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean { this.writes.push(bytes); return true; }
  end(): void { /* the session closes itself */ }
  destroy(): void { this.destroyed = true; }
  /** Every frame written so far, decoded as a front end would (no role or size check skipped). */
  frames(): Message[] {
    const splitter = new FrameSplitter();
    const out: Message[] = [];
    for (const chunk of this.writes) {
      const split = splitter.push(chunk);
      if (!split.ok) throw new Error(split.detail);
      for (const frame of split.frames) {
        expect(frame.length).toBeLessThanOrEqual(FRAME_LIMIT);
        const decoded = decodeFrame(frame, "server", LOCAL);
        if (!decoded.ok) throw new Error(decoded.detail);
        out.push(decoded.message);
      }
    }
    return out;
  }
  feed(message: Message): void {
    const encoded = encodeFrame(message, "fe", LOCAL);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.emit("data", Buffer.from(packFrame(encoded.text)));
  }
}

let hubSend: ((message: Message) => void) | null = null;
function open(run: (cmd: { type: string }) => Promise<unknown>): { socket: FakeSocket; session: Session; log: string[] } {
  const log: string[] = [];
  const host = {
    serverId: "server-1", serverName: "Mac", startedAt: 0, minFeVersion: "3.0.0", token: () => TOKEN,
    hub: { attach: (send: (message: Message) => void) => { hubSend = send; return { close() {}, sub: async () => ({ ok: false, reason: "unknown stream" }), ack() {}, history: () => null }; }, reader: () => null },
    live: { subscribe: () => ({ close() {}, resync() {} }) },
    runtime: {}, engine: { run }, content: null,
    shell: { attach() {}, detach() {}, answer() {} },
    nextFor: () => ({}), ensureBotStream: async () => false, log: (text: string) => log.push(text),
  } as unknown as SessionHost;
  const socket = new FakeSocket();
  const session = new Session(socket as never, host, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000 });
  socket.feed({ t: "hello", deviceId: "test", feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], token: TOKEN } as never);
  return { socket, session, log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A plugins.web answer the size the demo's library made (~1.9 MB of web part sources). */
function bigSpecs(): { specs: Array<{ name: string; source: string }> } {
  return { specs: Array.from({ length: 12 }, (_, i) => ({ name: `plugin-${i}`, source: `/* ${i} */ ${"console.log(\"é\\n\");".repeat(9_000)}` })) };
}

describe("a req answer over the frame limit", () => {
  it("goes as res.parts the front end joins into the very answer (plugins.web as the demo had it)", async () => {
    const result = bigSpecs();
    expect(JSON.stringify(result).length).toBeGreaterThan(FRAME_LIMIT * 4);
    const { socket, session, log } = open(async () => result);
    socket.feed({ t: "req", req: "r7", cmd: { type: "plugins.web" } } as never);
    await settle();
    const frames = socket.frames().filter((frame) => frame.t !== "welcome");
    expect(frames.length).toBeGreaterThan(4);
    expect(frames.every((frame) => frame.t === "res.part")).toBe(true);
    const parts = new ResAssembler();
    let joined: MessageOf<"res"> | null = null;
    for (const part of frames as MessageOf<"res.part">[]) {
      const step = parts.push(part, LOCAL);
      if (!step.ok) throw new Error(step.detail);
      joined = step.message ?? joined;
    }
    expect(joined).toEqual({ t: "res", req: "r7", ok: true, result });
    expect(log.filter((line) => line.includes("cannot send"))).toEqual([]);
    session.close();
  });

  it("an answer that cannot be sent at all is answered with an error naming the command, and logged with it", async () => {
    const { socket, session, log } = open(async () => ({ value: 1n })); // a BigInt: not JSON
    socket.feed({ t: "req", req: "r8", cmd: { type: "plugins.web" } } as never);
    await settle();
    const res = socket.frames().find((frame) => frame.t === "res") as MessageOf<"res"> | undefined;
    expect(res).toMatchObject({ req: "r8", ok: false, error: { code: "internal", message: expect.stringContaining("plugins.web") } });
    expect(log.some((line) => /cannot send res \(plugins\.web\)/.test(line))).toBe(true);
    session.close();
  });
});

describe("any other frame over the limit", () => {
  it("is never written: send says false and the log names the frame, what it was for and why", () => {
    const { socket, session, log } = open(async () => null);
    const before = socket.writes.length;
    const huge = "x".repeat(FRAME_LIMIT + 1);
    const snap = { t: "snap", stream: "bot:6A0B0000-0000-4000-8000-000000000002", logId: "logAAAAAAAAA", seq: 1, hash: "a".repeat(64), view: { huge } } as unknown as Message;
    expect(session.send(snap, "bot:6A0B0000-0000-4000-8000-000000000002")).toBe(false);
    expect(socket.writes.length).toBe(before);
    expect(log).toEqual([expect.stringMatching(/^session: cannot send snap \(bot:6A0B[^)]*\): .*(at most 262144 bytes|malformed)/)]);
    session.close();
  });
});

// M1 demo bug 3: no server → front end frame over the limit is ever attempted silently.
describe("no frame over the limit is attempted silently", () => {
  it("a log batch over the limit from the hub is not written; the log names it, its stream and why", async () => {
    const { socket, session, log } = open(async () => null);
    await settle();
    const before = socket.writes.length;
    const stream = "bot:6A0B0000-0000-4000-8000-000000000002";
    const body = { botId: "6A0B0000-0000-4000-8000-000000000002", message: { id: "m1", role: "bot", text: "y".repeat(FRAME_LIMIT), time: new Date(0).toISOString() } };
    const batch = { t: "batch", stream, logId: "logAAAAAAAAA", from: 1, to: 1, prevHash: "0".repeat(64), more: false,
      entries: [{ logId: "logAAAAAAAAA", seq: 1, hash: "b".repeat(64), kind: "message.added", body, at: 0 }] } as unknown as Message;
    expect(hubSend).not.toBeNull();
    hubSend!(batch);
    expect(socket.writes.length).toBe(before);
    expect(log).toEqual([expect.stringMatching(new RegExp(`^session: cannot send batch \\(${stream}\\): .+`))]);
    session.close();
  });

  it("only Session.write writes frames to a socket in botlingd (so every frame passes its checks)", () => {
    const root = join(__dirname, "..", "..", "src", "server");
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
    walk(root);
    const uses = files.flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, i) => ({ file: file.slice(root.length + 1), line: i + 1, text })))
      .filter(({ text }) => /packFrame\(|socket\.(write|end)\([^)]/.test(text) && !text.trim().startsWith("//") && !text.includes("import "));
    expect(uses.map(({ file, text }) => `${file}: ${text.trim()}`)).toEqual([
      "session/session.ts: packed = texts.map((text) => packFrame(text));",
      "session/session.ts: for (const frame of packed) this.socket.write(frame);",
    ]);
  });
});

describe("encodeResFrames / ResAssembler", () => {
  it("keep a small answer in one frame, cut a big one into parts that each fit, and refuse parts out of order", () => {
    const small = encodeResFrames({ t: "res", req: "a", ok: true, result: { x: 1 } }, "server", LOCAL);
    expect(small).toMatchObject({ ok: true, texts: [expect.any(String)] });
    // Escapes make the JSON longer than its characters: every part still fits a frame.
    const text = "\u0001\"\\".repeat(RES_PART_CHARS);
    const big = encodeResFrames({ t: "res", req: "b", ok: true, result: { text } }, "server", LOCAL);
    if (!big.ok) throw new Error(big.detail);
    expect(big.texts.length).toBeGreaterThan(1);
    for (const part of big.texts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(FRAME_LIMIT);
    const parts = big.texts.map((part) => JSON.parse(part) as MessageOf<"res.part">);
    const joiner = new ResAssembler();
    expect(joiner.push(parts[1], LOCAL)).toMatchObject({ ok: false });
    let done: MessageOf<"res"> | null = null;
    for (const part of parts) { const step = joiner.push(part, LOCAL); if (!step.ok) throw new Error(step.detail); done = step.message ?? done; }
    expect(done).toEqual({ t: "res", req: "b", ok: true, result: { text } });
    expect(joiner.pending).toBe(0);
  });
});
