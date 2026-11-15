// N1 (D67): the "stop after 5 unsettled sessions" bound must hold over the real local transport, not only over a fake
// socket that delivers the `bye` and closes later. Here a real botlingd `Session` sits on a real Unix socket and the
// desktop's own `unixDial` + `FeLink` talk to it. The server can never settle the command (its runtime throws every
// time, like the oversized plugins.panel result that was re-sent 582 times every 0.5 s): every session that carries it
// ends with `bye{unsettled, slot}`. The front end must count those and stop sending the slot after the 5th.
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, MemoryFeStorage, type FeLinkEvent } from "../../src/fe-link";
import { unixDial } from "../../src/main-v3/unix-dial";
import { decodeFrame, encodeFrame, FrameSplitter, packFrame, type Message, type StreamId } from "../../src/protocol";
import { Session, type SessionHost } from "../../src/server/session/session";

const TOKEN = "t".repeat(32);
const SERVER_ID = "server-1";
const SRV = `srv:${SERVER_ID}` as StreamId;
const BOT = "bot:b1" as StreamId;
const LOG_ID = "logAAAAAAAAA";
const HASH = "a".repeat(64);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A snap of BOT about 200 KB long (under the frame limit). */
function bigSnap(i: number): Message {
  return { t: "snap", stream: BOT, logId: LOG_ID, seq: 0, hash: HASH, view: { i, text: "x".repeat(200_000) } } as unknown as Message;
}

/** A botlingd local server whose command runtime always throws (nothing can ever be stored). */
async function neverSettlingServer(backlog: boolean, byeFlushMs?: number, subBacklog = false): Promise<{ path: string; copies: () => number; sessions: () => number; sockets: Set<Socket> }> {
  const dir = mkdtempSync(join(tmpdir(), "n1-"));
  const path = join(dir, "s.sock");
  let copies = 0;
  let sessions = 0;
  let logSend: ((message: Message) => void) | null = null;
  const fail = async () => {
    copies += 1;
    // As in the field (69 bots catching up after a 2.x import): log frames are still waiting in the socket's write
    // buffer when the session ends, so the bye is queued behind them, not written at once.
    if (backlog) for (let i = 0; i < 12; i += 1) logSend?.(bigSnap(i));
    throw new Error("could not be stored");
  };
  const host = {
    serverId: SERVER_ID, serverName: "Mac", startedAt: 0, minFeVersion: "3.0.0", token: () => TOKEN,
    hub: {
      attach: (send: (message: Message) => void) => (logSend = send, {
        close() {}, ack() {}, unsub() {}, history: () => null,
        // The server's own srv: stream: a snap, so the front end may send its outbox (§13.1).
        sub: async (stream: StreamId) => {
          if (stream !== SRV && stream !== BOT) return { ok: false, reason: "unknown stream" };
          if (subBacklog && stream === BOT) for (let i = 0; i < 12; i += 1) send(bigSnap(i));
          else send({ t: "snap", stream, logId: LOG_ID, seq: 0, hash: HASH, view: {} } as unknown as Message);
          return { ok: true };
        },
      }),
      reader: () => null,
    },
    live: { subscribe: () => ({ close() {}, resync() {} }) },
    runtime: { receive: fail, legacy: { receive: fail } },
    engine: { run: fail }, content: null,
    shell: { attach() {}, detach() {}, answer() {} },
    nextFor: () => ({}), ensureBotStream: async () => false, log: () => undefined,
  } as unknown as SessionHost;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sessions += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    new Session(socket, host, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000, ...(byeFlushMs ? { byeFlushMs } : {}) });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, copies: () => copies, sessions: () => sessions, sockets };
}

describe.each([
  { name: "an idle socket", backlog: false },
  { name: "log frames still waiting in the server's write buffer (the field case)", backlog: true },
])("D67 over the real local transport (N1), $name", ({ backlog }) => {
  it("a slot the server can never settle is sent 5 times, then stopped; the front end stops re-attaching in a loop", async () => {
    const server = await neverSettlingServer(backlog);
    const byes: string[] = [];
    const dial = unixDial({ path: server.path });
    const link = await FeLink.open({
      storage: new MemoryFeStorage(), dial, deviceId: "desktop", feVersion: "3.0.0", token: TOKEN,
      // Short backoff, so an unbounded loop shows within the test's time (production: 250 ms doubling to 5 s).
      reconnectMinMs: 5, reconnectMaxMs: 40,
    });
    cleanups.push(() => link.stop());
    const events: FeLinkEvent[] = [];
    link.on((event) => { events.push(event); if (event.type === "bye") byes.push(event.reason); });
    link.subscribe(BOT);
    link.start();
    await until(() => link.state === "live", 5_000);

    const item = await link.submit(BOT, { type: "chat.react", botId: "b1", messageId: "m1", emoji: "👍", present: true });
    // Without the bound this goes on for ever (582 copies in the field); give it ample time to show.
    await until(() => server.copies() >= 5, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Every one of those sessions told the front end why it ended.
    expect(byes.filter((reason) => reason === "unsettled").length).toBeGreaterThanOrEqual(5);
    expect(server.copies()).toBe(5);
    const view = link.pending(BOT).find((p) => p.slot.n === item.slot.n);
    expect(view).toMatchObject({ state: "waiting", stopped: true, sending: false });
    // Stopped, the link stays attached instead of re-dialing.
    const sessions = server.sessions();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.sessions()).toBe(sessions);
    expect(link.state).toBe("live");
  }, 20_000);

  it("the server's bye{unsettled} reaches the client before the socket closes", async () => {
    const server = await neverSettlingServer(backlog);
    const { socket, got, closed } = await rawClient(server.path);
    await closed;
    if (backlog) expect(got.filter((m) => m.t === "snap" && m.stream === BOT)).toHaveLength(12);
    expect(got.find((m) => m.t === "bye")).toMatchObject({ t: "bye", reason: "unsettled", slot: { n: 1 } });
    socket.destroy();
  }, 20_000);
});

describe("the bye's flush is bounded (N1)", () => {
  it("a front end that stops reading is cut off after byeFlushMs, not kept open by the queued frames", async () => {
    const server = await neverSettlingServer(true, 100);
    const { socket } = await rawClient(server.path, true);
    await until(() => server.copies() === 1, 5_000);
    const [serverSocket] = [...server.sockets];
    expect(serverSocket?.destroyed).toBe(false); // still writing the queued frames, the client does not read
    await until(() => serverSocket!.destroyed, 3_000);
    socket.destroy();
  }, 20_000);
});

describe("a malformed frame's bye takes the same path (N1)", () => {
  it("the bye{malformed} still reaches the client behind log frames waiting in the server's write buffer", async () => {
    const server = await neverSettlingServer(false, undefined, true);
    const { socket, got, closed, write } = await rawClient(server.path, false, false);
    write({ t: "sub", stream: BOT, cursor: null } as never);
    await until(() => got.some((m) => m.t === "snap" && m.stream === BOT), 5_000);
    socket.write(packFrame("not json")); // about 2 MB of snaps are still queued on the server side
    await closed;
    expect(got.filter((m) => m.t === "snap" && m.stream === BOT)).toHaveLength(12);
    expect(got.find((m) => m.t === "bye")).toMatchObject({ t: "bye", reason: "malformed" });
    socket.destroy();
  }, 20_000);
});

/** A front end written by hand: hello, then (with `cmd`) one command the server cannot settle; `pause` stops reading after the welcome. */
async function rawClient(path: string, pause = false, cmd = true): Promise<{ socket: Socket; got: Message[]; closed: Promise<void>; write: (message: Message) => void }> {
  const socket = createConnection(path);
  const got: Message[] = [];
  const splitter = new FrameSplitter();
  socket.on("data", (chunk: Buffer) => {
    const split = splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (!split.ok) throw new Error(split.detail);
    for (const frame of split.frames) {
      const decoded = decodeFrame(frame, "server", { local: true });
      if (decoded.ok) got.push(decoded.message);
    }
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  const write = (message: Message) => {
    const encoded = encodeFrame(message, "fe", { local: true });
    if (!encoded.ok) throw new Error(encoded.detail);
    socket.write(packFrame(encoded.text));
  };
  write({ t: "hello", deviceId: "desktop", feVersion: "3.0.0", protocol: 1, originEpoch: "0123456789abcdef0123456789abcdef", cursors: {}, outbox: [], want: [], token: TOKEN } as never);
  await until(() => got.some((m) => m.t === "welcome"), 5_000);
  if (pause) socket.pause();
  if (cmd) write({
    t: "cmd", slot: { origin: "desktop", originEpoch: "0123456789abcdef0123456789abcdef", target: BOT, n: 1 }, floor: 1, inc: LOG_ID,
    cmd: { type: "chat.react", botId: "b1", messageId: "m1", emoji: "👍", present: true },
  } as never);
  return { socket, got, closed, write };
}
