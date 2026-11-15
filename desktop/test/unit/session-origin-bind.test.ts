// M7-12c (security follow-up to M7-12a, finding F1): a local socket session binds `slot.origin` to its `hello.deviceId`,
// as `remote-session.ts` does for a device (`cmdScope`). Without it any holder of the local token could write a command
// under origin `desktop` and have A stamp it `manage` for a peer, or under a phone's or server's origin.
//
// - hello `desktop` + origin `desktop`: the window's own command is taken (stated `local`), nothing changes;
// - hello `botlingd-cli` (or any non-window id) + origin `desktop`: the session ends with `bye{role}` and the command
//   reaches neither this server's runtime nor the forwarder (a target a peer owns);
// - the same for any other origin that is not the session's own id (a phone's member id, a server's id).
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, FrameSplitter, packFrame, type Message, type MessageOf } from "../../src/protocol";
import { Session, type SessionHost } from "../../src/server/session/session";

const TOKEN = "t".repeat(32);
const EPOCH = "0123456789abcdef0123456789abcdef";
const LOCAL = { local: true } as const;

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
    for (const chunk of this.writes) {
      const split = splitter.push(chunk);
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
    const encoded = encodeFrame(message, "fe", LOCAL);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.emit("data", Buffer.from(packFrame(encoded.text)));
  }
}

interface Seen { received: Array<{ origin: string; scope: string }>; committed: Array<{ origin: string; scope: unknown }> }

/** A session whose hello names `deviceId`. `owner` is the peer that owns every target (null: this server decides). */
function open(deviceId: string, owner: string | null): { socket: FakeSocket; session: Session; seen: Seen } {
  const seen: Seen = { received: [], committed: [] };
  const host = {
    serverId: "server-1", serverName: "Mac", startedAt: 0, minFeVersion: "3.0.0", token: () => TOKEN,
    hub: { attach: () => ({ close() {}, sub: async () => ({ ok: false, reason: "unknown stream" }), ack() {}, history: () => null }), reader: () => null },
    live: { subscribe: () => ({ close() {}, resync() {} }) },
    runtime: {
      receive: async (body: { slot: { origin: string } }, options: { scope: string }) => { seen.received.push({ origin: body.slot.origin, scope: options.scope }); return { status: "held" }; },
      legacy: { receive: async (body: { slot: { origin: string } }, options: { scope: string }) => { seen.received.push({ origin: body.slot.origin, scope: options.scope }); return { status: "held" }; } },
    },
    forward: {
      ownerOf: () => owner,
      attach: () => () => undefined,
      commit: async (body: { slot: { origin: string }; scope: unknown }) => { seen.committed.push({ origin: body.slot.origin, scope: body.scope }); },
    },
    engine: { run: async () => null }, content: null,
    shell: { attach() {}, detach() {}, answer() {} },
    nextFor: () => ({}), ensureBotStream: async () => false, log: () => undefined,
  } as unknown as SessionHost;
  const socket = new FakeSocket();
  const session = new Session(socket as never, host, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000 });
  socket.feed({ t: "hello", deviceId, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], token: TOKEN } as never);
  return { socket, session, seen };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const slotOf = (origin: string, target: string) => ({ origin, originEpoch: EPOCH, target, n: 1 });
const cmdOf = (origin: string, target = "bot:b1"): Message =>
  ({ t: "cmd", slot: slotOf(origin, target), floor: 1, inc: "inc-0000001", cmd: { type: "chat.send", botId: "b1", text: "hi" } }) as never;
const bye = (socket: FakeSocket) => socket.frames().find((f) => f.t === "bye") as MessageOf<"bye"> | undefined;

describe("M7-12c: a local session binds slot.origin to its hello deviceId", () => {
  it("the window's own origin is taken: this server decides it as local", async () => {
    const { socket, session, seen } = open("desktop", null);
    socket.feed(cmdOf("desktop"));
    await settle();
    expect(bye(socket)).toBeUndefined();
    expect(seen.received).toEqual([{ origin: "desktop", scope: "local" }]);
    session.close();
  });

  it("the window's own origin for a peer's bot is forwarded (A stamps it later), and the session stays open", async () => {
    const { socket, session, seen } = open("desktop", "srv-b");
    socket.feed(cmdOf("desktop"));
    await settle();
    expect(bye(socket)).toBeUndefined();
    expect(seen.committed).toEqual([{ origin: "desktop", scope: "local" }]);
    session.close();
  });

  it("a non-window local client naming origin desktop is ended with bye{role} and nothing is decided", async () => {
    const { socket, session, seen } = open("botlingd-cli", null);
    socket.feed(cmdOf("desktop"));
    await settle();
    expect(bye(socket)).toMatchObject({ t: "bye", reason: "role" });
    expect(seen.received).toEqual([]);
    session.close();
  });

  it("the same client for a peer's bot is not committed to the forwarder (it would be stamped manage)", async () => {
    const { socket, session, seen } = open("botlingd-cli", "srv-b");
    socket.feed(cmdOf("desktop"));
    await settle();
    expect(bye(socket)).toMatchObject({ t: "bye", reason: "role" });
    expect(seen.committed).toEqual([]);
    expect(seen.received).toEqual([]);
    session.close();
  });

  it("any origin that is not the session's own id is refused (a phone's member id, a server's id, the window's id from another hello)", async () => {
    for (const origin of ["dev-phone", "srv-a", "desktop"]) {
      const { socket, session, seen } = open("some-local-client", "srv-b");
      socket.feed(cmdOf(origin));
      await settle();
      expect(bye(socket), origin).toMatchObject({ t: "bye", reason: "role" });
      expect(seen.committed, origin).toEqual([]);
      expect(seen.received, origin).toEqual([]);
      session.close();
    }
  });

  it("a client's own origin still works for its own id (the CLI, tests): the check is equality, not a name list", async () => {
    const { socket, session, seen } = open("botlingd-cli", null);
    socket.feed(cmdOf("botlingd-cli"));
    await settle();
    expect(bye(socket)).toBeUndefined();
    expect(seen.received).toEqual([{ origin: "botlingd-cli", scope: "local" }]);
    session.close();
  });
});
