// Self-test of the Botling 3 two-server harness and fault proxy (M3 brief step 2; test/support/two-servers.ts,
// fault-proxy.ts, framed.ts). Needs the built botlingd (out/server/main.cjs; test:changed builds it).
// - Two botlingd start with separate data folders, sockets and ports, no inherited BOTLING_* variable, each with its own
//   store and server id, and listen on 127.0.0.1 only (asserted with lsof / /proc on every socket they listen on).
// - kill -9 + restart of either keeps its store: same server id, same logId, every entry back with the same hash, and
//   the other server's store untouched.
// - The proxy at frame level on loopback: drop, duplicate, delay, cut, half-open, partition and whole-session replay are
//   each observed at the far side (a simple framed echo, length-prefixed and WebSocket); a seeded schedule repeats.
// - The real encrypted session layer (SessionLink, as remote and peer sessions use it) through the proxy: a duplicated,
//   dropped or replayed frame ends the session at the far side and nothing replayed is ever opened.
// - Cleanup: every process gone and every temp folder removed.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Entry, Message, MessageOf, Slot } from "../../src/protocol";
import { generateDhKeyPair, SessionLink, type LocalStatic, type SessionEnd, type SessionTransport } from "../../src/session";
import { MAIN } from "../botlingd-harness";
import { sleep, until } from "../helpers";
import { FaultProxy } from "../support/fault-proxy";
import { dialFramed, framedEcho, framedServer, LOOPBACK, type FramedConnection, type FramedServer } from "../support/framed";
import { LISTEN_PORT_ENV, listeningSockets, startServers, type TestCluster, type TestServer } from "../support/two-servers";

const text = (value: string) => Buffer.from(value);
const strings = (frames: Buffer[]) => frames.map((frame) => frame.toString());
const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

describe("two-server harness: two botlingd on loopback", () => {
  let cluster: TestCluster;
  let root = "";
  const serverIds = new Map<string, string>();

  beforeAll(async () => {
    process.env.BOTLING_HARNESS_LEAK = "must not reach botlingd";
    try { cluster = await startServers({ name: "two-servers-harness" }); } finally { delete process.env.BOTLING_HARNESS_LEAK; }
    root = cluster.root;
  }, 120_000);
  afterAll(async () => { await cluster?.cleanup(); });

  it("starts A and B with separate folders, sockets, ports and stores, bound to 127.0.0.1 only", async () => {
    const { a, b } = cluster;
    expect(a.dataDir).not.toBe(b.dataDir);
    expect(a.socket).not.toBe(b.socket);
    expect(a.port).not.toBe(b.port);
    expect(a.pid).not.toBe(b.pid);
    for (const server of [a, b]) {
      expect(server.alive).toBe(true);
      expect(server.dataDir.startsWith(root)).toBe(true);
      expect(existsSync(server.socket)).toBe(true);
      // Nothing of this process's environment: only the harness's own BOTLING_* settings.
      const botling = Object.keys(server.environment).filter((key) => key.startsWith("BOTLING_")).sort();
      expect(botling).toEqual(["BOTLING_AGENT", "BOTLING_FAKE_CLI", "BOTLING_FAKE_CODEX", "BOTLING_PLUGIN_HOST", "BOTLING_SERVER_BACKUP_CHECK_MS", "BOTLING_SERVER_DATA_DIR", LISTEN_PORT_ENV].sort());
      expect(server.environment[LISTEN_PORT_ENV]).toBe(String(server.port));
      const client = await server.client();
      serverIds.set(server.name, client.welcome!.serverId);
      client.close();
      // Every socket it listens on is 127.0.0.1 (botlingd's TCP listener is M2 step 6; until then it has none).
      const sockets = server.assertLoopbackOnly();
      for (const socket of sockets) expect(socket.address).toBe(LOOPBACK);
    }
    expect(serverIds.get("A")).not.toBe(serverIds.get("B"));
  });

  it("the loopback check sees a listener and refuses one outside 127.0.0.1", async () => {
    const { createServer } = await import("node:net");
    const inside = createServer();
    await new Promise<void>((resolve) => inside.listen(0, LOOPBACK, () => resolve()));
    const port = (inside.address() as { port: number }).port;
    try {
      expect(listeningSockets(process.pid)).toContainEqual({ proto: "tcp", address: LOOPBACK, port });
      const fake = { ...cluster.a, listeners: () => [{ proto: "tcp" as const, address: "*", port: 1 }] };
      expect(() => (cluster.a.assertLoopbackOnly as (this: TestServer) => unknown).call(fake as unknown as TestServer)).toThrow(/outside 127\.0\.0\.1/);
    } finally {
      await new Promise<void>((resolve) => inside.close(() => resolve()));
    }
  });

  it("kill -9 + restart of either server keeps its store", async () => {
    for (const server of [cluster.a, cluster.b]) {
      const other = server === cluster.a ? cluster.b : cluster.a;
      const marker = `kept by ${server.name} ${Date.now()}`;
      const client = await server.client("script", `${server.name === "A" ? "a" : "b"}`.repeat(32));
      await client.sub(client.srv);
      const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
      const stream = `bot:${MAIN}`;
      await client.sub(stream);
      await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, "bot snap");
      const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: stream as Slot["target"], n: 1 };
      client.cmd(slot, { type: "chat.send", botId: MAIN, text: `/say ${marker}` }, srvSnap.logId);
      expect((await client.wait(isResult(slot), "cmd.result")).outcome.kind).toBe("applied");
      await until(() => client.entriesOf(stream).some((entry) => entry.kind === "turn.finished"), { timeout: 60_000, what: "turn.finished" });
      const before: Entry[] = client.entriesOf(stream);
      const logId = client.logIdOf(stream)!;

      await server.kill();
      expect(server.alive).toBe(false);
      expect(other.alive).toBe(true);
      await server.start();
      server.assertLoopbackOnly();

      const again = await server.client("script", client.originEpoch);
      expect(again.welcome!.serverId).toBe(serverIds.get(server.name));
      await again.sub(stream, { logId, seq: 0 });
      await until(() => again.entriesOf(stream).length >= before.length, { timeout: 30_000, what: "entries after restart" });
      expect(again.logIdOf(stream)).toBe(logId); // no reset: the same log
      for (const entry of before) expect(again.entriesOf(stream).find((e) => e.seq === entry.seq)?.hash).toBe(entry.hash);
      const userLine = again.entriesOf(stream).find((entry) => entry.slot?.n === slot.n && entry.slot?.originEpoch === slot.originEpoch);
      expect(JSON.stringify(userLine?.body)).toContain(marker);
      // The slot sent again: its stored outcome, not a second apply.
      again.cmd(slot, { type: "chat.send", botId: MAIN, text: `/say ${marker}` }, srvSnap.logId);
      expect((await again.wait(isResult(slot), "stored cmd.result")).outcome.kind).toBe("applied");
      again.close();

      // The other server's store never saw it.
      const look = await other.client("look", "c".repeat(32));
      await look.sub(stream, null);
      await look.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, "other bot snap");
      const shown = await look.req({ type: "chat.snapshot", botId: MAIN });
      expect(JSON.stringify(shown)).not.toContain(marker);
      look.close();
    }
    expect(cluster.a.starts).toBe(2);
    expect(cluster.b.starts).toBe(2);
  }, 240_000);

  it("cleanup stops both servers and removes every temp folder", async () => {
    const pids = [cluster.a.pid!, cluster.b.pid!];
    await cluster.cleanup();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(cluster.a.dataDir)).toBe(false);
    expect(existsSync(cluster.b.dataDir)).toBe(false);
  }, 60_000);
});

describe("fault proxy at frame level on loopback", () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterAll(async () => { for (const close of closers.splice(0).reverse()) await close(); });

  async function setup(framing: "length" | "websocket" = "length", seed?: number): Promise<{ far: FramedServer; proxy: FaultProxy }> {
    const far = await framedEcho(framing);
    const proxy = await FaultProxy.start({ target: far.port, framing, seed });
    closers.push(() => far.close(), () => proxy.close());
    return { far, proxy };
  }

  it("listens and dials on 127.0.0.1 only and passes frames unchanged", async () => {
    const { far, proxy } = await setup();
    expect(proxy.address).toBe(LOOPBACK);
    const mine = listeningSockets(process.pid).filter((socket) => socket.port === proxy.port || socket.port === far.port);
    expect(mine.map((socket) => socket.address)).toEqual([LOOPBACK, LOOPBACK]);
    const client = await dialFramed(proxy.port);
    for (const frame of ["one", "two", "three"]) client.send(text(frame));
    await until(() => client.frames.length === 3, { what: "echoes" });
    expect(strings(far.connections[0].frames)).toEqual(["one", "two", "three"]);
    expect(strings(client.frames)).toEqual(["one", "two", "three"]);
    expect(proxy.count("pass", "up")).toBe(3);
    expect(proxy.count("pass", "down")).toBe(3);
    client.close();
  });

  it("drop: the far side never gets the dropped frame; the rest arrive in order", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    proxy.drop("up", 1, (payload) => payload.toString() === "f2");
    proxy.drop("down", 1, (payload) => payload.toString() === "f4");
    for (const frame of ["f1", "f2", "f3", "f4", "f5"]) client.send(text(frame));
    await until(() => client.frames.length === 3, { what: "echoes" });
    await sleep(100);
    expect(strings(far.connections[0].frames)).toEqual(["f1", "f3", "f4", "f5"]);
    expect(strings(client.frames)).toEqual(["f1", "f3", "f5"]);
    expect(proxy.count("drop")).toBe(2);
    client.close();
  });

  it("duplicate: the far side gets the frame twice", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    proxy.duplicate("up", 1, (payload) => payload.toString() === "d2");
    for (const frame of ["d1", "d2", "d3"]) client.send(text(frame));
    await until(() => client.frames.length === 4, { what: "echoes" });
    expect(strings(far.connections[0].frames)).toEqual(["d1", "d2", "d2", "d3"]);
    client.close();
  });

  it("delay: the frame arrives late and the ones behind it wait (order kept)", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    proxy.delay("up", 300, 1, (payload) => payload.toString() === "s1");
    const sent = Date.now();
    client.send(text("s1"));
    client.send(text("s2"));
    const connection = await until(() => far.connections[0], { what: "far connection" });
    await until(() => connection.frames.length === 2, { every: 5, what: "delayed frames" });
    const elapsed = Date.now() - sent;
    expect(strings(connection.frames)).toEqual(["s1", "s2"]);
    expect(elapsed).toBeGreaterThanOrEqual(290);
    client.close();
  });

  it("cut: both ends see their connection closed", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    client.send(text("before"));
    await until(() => client.frames.length === 1, { what: "echo" });
    proxy.cut();
    await until(() => client.closed && far.connections[0].closed, { what: "both closed" });
    expect(proxy.count("cut")).toBe(1);
    expect(proxy.open).toEqual([]);
  });

  it("half-open: frames one way vanish while both sockets stay open; the other way still flows", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    client.send(text("h0"));
    await until(() => client.frames.length === 1, { what: "echo" });
    proxy.halfOpen("up");
    client.send(text("h1"));
    far.connections[0].send(text("push"));
    await until(() => client.frames.length === 2, { what: "far push" });
    await sleep(150);
    expect(strings(far.connections[0].frames)).toEqual(["h0"]);
    expect(strings(client.frames)).toEqual(["h0", "push"]);
    expect(client.closed || far.connections[0].closed).toBe(false);
    expect(proxy.count("blackhole", "up")).toBe(1);
    proxy.heal();
    client.send(text("h2"));
    await until(() => far.connections[0].frames.length === 2, { what: "after heal" });
    expect(strings(far.connections[0].frames)).toEqual(["h0", "h2"]);
    client.close();
  });

  it("partition: nothing crosses and a new dial is held; after heal the held dial connects, old frames stay lost", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    client.send(text("p0"));
    await until(() => client.frames.length === 1, { what: "echo" });
    proxy.partition();
    client.send(text("p1"));
    far.connections[0].send(text("down-lost"));
    const late = await dialFramed(proxy.port);
    late.send(text("late"));
    await sleep(200);
    expect(far.connections.length).toBe(1); // the held dial never reached the far side
    expect(strings(far.connections[0].frames)).toEqual(["p0"]);
    expect(strings(client.frames)).toEqual(["p0"]);
    expect(proxy.count("held")).toBeGreaterThanOrEqual(2);
    proxy.heal();
    await until(() => far.connections.length === 2 && far.connections[1].frames.length === 1, { what: "held dial connected" });
    expect(strings(far.connections[1].frames)).toEqual(["late"]);
    client.send(text("p2"));
    await until(() => far.connections[0].frames.length === 2, { what: "after heal" });
    expect(strings(far.connections[0].frames)).toEqual(["p0", "p2"]);
    client.close();
    late.close();
  });

  it("replay: a new connection at the far side carries the whole session again", async () => {
    const { far, proxy } = await setup();
    const client = await dialFramed(proxy.port);
    for (const frame of ["r1", "r2", "r3"]) client.send(text(frame));
    await until(() => client.frames.length === 3, { what: "echoes" });
    const conn = proxy.open[0];
    await proxy.replay(conn);
    await until(() => far.connections.length === 2 && far.connections[1].frames.length === 3, { what: "replayed session" });
    expect(strings(far.connections[1].frames)).toEqual(["r1", "r2", "r3"]);
    expect(proxy.count("replay")).toBe(1);
    client.close();
  });

  it("a seeded schedule makes the same decisions for the same seed, and the far side sees exactly them", async () => {
    const run = async (seed: number) => {
      const { far, proxy } = await setup("length", seed);
      proxy.schedule({ drop: 0.2, duplicate: 0.2, dirs: ["up"] });
      const client = await dialFramed(proxy.port);
      for (let i = 0; i < 60; i++) client.send(text(`m${i}`));
      const expected: string[] = [];
      await until(() => proxy.events.filter((event) => event.dir === "up").length === 60, { what: "60 decisions" });
      for (const event of proxy.events) {
        if (event.dir !== "up") continue;
        if (event.action === "pass") expected.push(event.payload!.toString());
        if (event.action === "duplicate") expected.push(event.payload!.toString(), event.payload!.toString());
      }
      await until(() => far.connections[0]?.frames.length === expected.length, { what: "far frames" });
      expect(strings(far.connections[0].frames)).toEqual(expected);
      client.close();
      return proxy.events.filter((event) => event.dir === "up").map((event) => event.action);
    };
    const first = await run(42);
    expect(await run(42)).toEqual(first);
    expect(first).toContain("drop");
    expect(first).toContain("duplicate");
    expect(await run(7)).not.toEqual(first);
  });

  it("websocket framing: the upgrade passes, messages are the unit, drop/duplicate/cut observed at the far side", async () => {
    const { far, proxy } = await setup("websocket");
    const got: string[] = [];
    let closed = false;
    const socket = new WebSocket(`${proxy.url}/v3/ws`);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => got.push(Buffer.from(event.data as ArrayBuffer).toString());
    socket.onclose = () => { closed = true; };
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("websocket failed")); });
    proxy.drop("up", 1, (payload) => payload.toString() === "w2");
    proxy.duplicate("up", 1, (payload) => payload.toString() === "w3");
    for (const frame of ["w1", "w2", "w3", "w4"]) socket.send(text(frame));
    // A big message (several TCP chunks, 16-bit and 64-bit lengths) stays one unit.
    const big = "x".repeat(200_000);
    socket.send(text(big));
    await until(() => got.length === 5, { what: "websocket echoes" });
    const connection = far.connections[0];
    expect(strings(connection.frames)).toEqual(["w1", "w3", "w3", "w4", big]);
    expect(got).toEqual(["w1", "w3", "w3", "w4", big]);
    expect(proxy.count("drop", "up")).toBe(1);
    proxy.cut();
    await until(() => closed && connection.closed, { what: "websocket closed at both ends" });
  });

  it("the real session layer through the proxy: a duplicated, dropped or replayed frame ends the session at the far side", async () => {
    const cluster = "0123456789abcdef0123456789abcdef";
    const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
    const identity = async (): Promise<LocalStatic> => {
      const keys = await generateDhKeyPair();
      return { memberId: [...globalThis.crypto.getRandomValues(new Uint8Array(26))].map((byte) => BASE32[byte & 31]).join(""), dhPub: keys.publicKey, dhKey: keys.privateKey };
    };
    const serverA = await identity();
    const serverB = await identity();
    interface FarSession { link: SessionLink; got: string[]; ended: SessionEnd | null; conn: FramedConnection }
    const sessions: FarSession[] = [];
    // Server B's side: one KK responder per connection, frames from the length framing.
    const far = await framedServer("length", {
      onConnection: (conn) => {
        const transport: SessionTransport = { send: (frame) => conn.send(frame), close: () => conn.close() };
        const session: FarSession = { link: null as unknown as SessionLink, got: [], ended: null, conn };
        session.link = SessionLink.respond(transport, {
          transport: "tailnet", cluster, self: serverB, modes: ["kk"], expectInitiator: serverA.memberId,
          checkPeer: (claim) => ({ ok: claim.memberId === serverA.memberId }),
        }, { onFrame: (bytes) => { session.got.push(Buffer.from(bytes).toString()); }, onEnd: (end) => { session.ended = end; } });
        sessions.push(session);
      },
      onFrame: (conn, payload) => sessions.find((session) => session.conn === conn)?.link.receive(payload),
      onClose: (conn) => sessions.find((session) => session.conn === conn)?.link.transportClosed(),
    });
    const proxy = await FaultProxy.start({ target: far.port, framing: "length" });
    closers.push(() => far.close(), () => proxy.close());

    // Server A dials B through the proxy.
    const dial = async () => {
      const client = await dialFramed(proxy.port);
      const got: string[] = [];
      let ended: SessionEnd | null = null;
      const link = SessionLink.initiate({ send: (frame) => client.send(frame), close: () => client.close() }, {
        mode: "kk", transport: "tailnet", cluster, self: serverA, responder: { memberId: serverB.memberId, dhPub: serverB.dhPub },
      }, { onFrame: (bytes) => { got.push(Buffer.from(bytes).toString()); }, onEnd: (end) => { ended = end; } });
      client.onFrame = (payload) => link.receive(payload);
      client.onClose = () => link.transportClosed();
      closers.push(() => link.close());
      await link.established;
      return { link, client, got, ended: () => ended };
    };

    // A clean session works through the proxy.
    const first = await dial();
    first.link.send("control", text("hello B"));
    await until(() => sessions[0]?.got.length === 1, { what: "frame at B" });
    expect(sessions[0].got).toEqual(["hello B"]);
    // Duplicate the next frame up: B sees the same counter twice and ends the session (order), opening it once only.
    proxy.duplicate("up");
    first.link.send("control", text("once"));
    await until(() => sessions[0].ended, { what: "B ends on the duplicate" });
    expect(sessions[0].ended!.reason).toBe("order");
    expect(sessions[0].got).toEqual(["hello B", "once"]);

    // A dropped frame: the next one has a skipped counter, B ends the session and never opens it.
    const second = await dial();
    const atB = sessions[1];
    second.link.send("control", text("warm"));
    await until(() => atB.got.length === 1, { what: "first frame at B" });
    proxy.drop("up");
    second.link.send("control", text("lost"));
    second.link.send("control", text("after the gap"));
    await until(() => atB.ended, { what: "B ends on the gap" });
    expect(atB.ended!.reason).toBe("order");
    expect(atB.got).toEqual(["warm"]);

    // A whole-session replay of the first connection: a new session at B that never opens a frame and ends.
    const replayed = await proxy.replay(proxy.events.find((event) => event.action === "open")!.conn);
    expect(replayed).toBeGreaterThan(0);
    await until(() => sessions.length === 3 && sessions[2].ended, { what: "the replayed session ends at B" });
    expect(sessions[2].got).toEqual([]);
    expect(sessions[2].link.delivered).toBe(0);
    expect(sessions[2].link.state).toBe("ended");
  });
});
