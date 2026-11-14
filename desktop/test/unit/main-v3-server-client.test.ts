// Botling 3's window main (src/main-v3, M1 step 11): the server client that replaces the 2.x core client (requests,
// milestones, botlingd's `shell.*` asks answered with the 2.x app ops), its Unix-socket dial, the build that swaps
// the client in, and the check that the 2.x main entry pulls in nothing of Botling 3. Headless: no Electron, no window.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { EventEnvelope } from "../../src/contract";
import { MemoryFeStorage } from "../../src/fe-link";
import { FrameSplitter, packFrame } from "../../src/protocol/frame";
import type { Message } from "../../src/protocol";
import type { CoreClientOptions } from "../../src/main/core-client";
import { ServerClient, serverPaths, serverScriptFor } from "../../src/main-v3/server-client";
import { unixDial } from "../../src/main-v3/unix-dial";
import { v3DataDir } from "../../src/main-v3/paths";
import { FakeClock, FakeServer, flush } from "./fe-link-harness";

const root = resolve(__dirname, "..", "..");
const clients: ServerClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.stop(); });

type AppFn = NonNullable<CoreClientOptions["app"]>;

function client(server: FakeServer, app?: AppFn, over: Partial<CoreClientOptions> = {}) {
  const events: EventEnvelope[] = [];
  const milestones: string[] = [];
  const audit: string[] = [];
  const c = new ServerClient(
    { script: "/build/out/core/main.cjs", env: { BOTLING_APP_DATA_DIR: "/app-data" }, onEvent: (e) => events.push(e), audit: (t) => audit.push(t), milestone: (m) => milestones.push(m), ...(app ? { app } : {}), ...over },
    { dial: server.dial, storage: () => new MemoryFeStorage(), clock: new FakeClock(), readToken: () => "t".repeat(32), feVersion: "3.0.0" },
  );
  clients.push(c);
  return { c, events, milestones, audit };
}

function answerReads(server: FakeServer): void {
  server.onMessage = (message: Message) => {
    if (message.t === "req") server.send({ t: "res", req: message.req, ok: true, result: { read: message.cmd.type } });
  };
}

const dones = (server: FakeServer) => server.received.filter((m) => m.t === "shell.done");

describe("server client", () => {
  it("opens the link with the token, marks core.spawn / core.ready, and answers main's requests as 2.x responses", async () => {
    const server = new FakeServer();
    answerReads(server);
    const { c, milestones } = client(server);
    expect(await c.request({ type: "settings.get" }, "early")).toMatchObject({ id: "early", ok: false, error: { code: "core_unavailable" } });
    c.start();
    await c.ready();
    await flush();
    expect(server.received[0]).toMatchObject({ t: "hello", deviceId: "desktop", token: "t".repeat(32) });
    expect(milestones).toEqual(["core.spawn", "core.ready"]);
    expect(await c.request({ type: "settings.get" }, "w1.5")).toEqual({ v: expect.any(Number), id: "w1.5", ok: true, result: { read: "settings.get" } });
    expect(await c.call({ type: "settings.get" })).toEqual({ read: "settings.get" });
    expect(await c.prepareRestart()).toBe(false);
    expect([c.pid, c.hostPids, c.pluginGroups]).toEqual([undefined, [], []]);
  });

  it("serves shell.screenshot / browser / install / quit with the 2.x app ops and answers shell.done", async () => {
    const server = new FakeServer();
    const app = vi.fn<AppFn>(async (op, args) => {
      if (op === "screenshot") return { ok: true, file: "/shots/window.png" };
      if (op === "browser") return { ok: true, data: { echoed: JSON.parse(args.request) } };
      if (op === "installRelease") return { ok: false, error: "no newer release" };
      return { ok: true };
    });
    const { c } = client(server, app);
    c.start();
    await c.ready();
    await flush();
    server.send({ t: "shell.screenshot", req: "s1" });
    server.send({ t: "shell.browser", req: "s2", args: { request: JSON.stringify({ op: "tabs" }), extra: "dropped" } });
    server.send({ t: "shell.install", req: "s3" });
    server.send({ t: "shell.quit", req: "s4" });
    await flush();
    expect(app.mock.calls).toEqual([["screenshot", {}], ["browser", { request: "{\"op\":\"tabs\"}" }], ["installRelease", {}], ["quit", {}]]);
    expect(dones(server)).toEqual([
      { t: "shell.done", req: "s1", ok: true, file: "/shots/window.png" },
      { t: "shell.done", req: "s2", ok: true, data: { echoed: { op: "tabs" } } },
      { t: "shell.done", req: "s3", ok: false, error: "no newer release" },
      { t: "shell.done", req: "s4", ok: true },
    ]);
  });

  it("a failing app op, or a window with none, answers ok: false", async () => {
    const server = new FakeServer();
    const { c } = client(server, async () => { throw new Error("no window"); });
    c.start();
    await c.ready();
    await flush();
    server.send({ t: "shell.screenshot", req: "s1" });
    await flush();
    expect(dones(server)).toEqual([{ t: "shell.done", req: "s1", ok: false, error: "no window" }]);

    const bare = new FakeServer();
    const second = client(bare);
    second.c.start();
    await second.c.ready();
    await flush();
    bare.send({ t: "shell.quit", req: "q1" });
    await flush();
    expect(dones(bare)).toEqual([{ t: "shell.done", req: "q1", ok: false, error: "This window cannot do that." }]);
  });

  it("starts botlingd when nothing listens on the socket, at most once every 10 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blv3-"));
    try {
      const launch = vi.fn();
      const c = new ServerClient(
        { script: "/build/out/core/main.cjs", env: { BOTLING_APP_DATA_DIR: dir, BOTLING_SERVER_SOCKET: join(dir, "none.sock") }, onEvent: () => undefined, audit: () => undefined },
        { storage: () => new MemoryFeStorage(), clock: new FakeClock(), readToken: () => "t".repeat(32), launch },
      );
      clients.push(c);
      c.start();
      await c.ready();
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      await flush();
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paths: botlingd's folder, socket and token under the app data; the server build beside the core build", () => {
    expect(serverPaths({ BOTLING_APP_DATA_DIR: "/d" })).toEqual({ serverDir: "/d/server", socket: "/d/server/botlingd.sock", token: "/d/server/botlingd.token", feStorage: "/d/electron/fe-link.sqlite" });
    expect(serverPaths({ BOTLING_APP_DATA_DIR: "/d", BOTLING_SERVER_DATA_DIR: "/s", BOTLING_SERVER_SOCKET: "/k.sock" })).toMatchObject({ serverDir: "/s", socket: "/k.sock", token: "/s/botlingd.token" });
    expect(serverScriptFor("/b/out/core/main.cjs")).toBe("/b/out/server/main.cjs");
  });

  it("the v3 window never opens the 2.x data folder", () => {
    expect(v3DataDir("/r", {})).toEqual({ ok: true, dataDir: "/r/.data-v3" });
    expect(v3DataDir("/r", { BOTLING_DATA_DIR: "/x" })).toEqual({ ok: true, dataDir: "/x" });
    expect(v3DataDir("/r", { BOTLING_DATA_DIR: "/r/.data" }).ok).toBe(false);
  });
});

describe("unix socket dial", () => {
  let server: Server | null = null;
  let dir: string | null = null;
  afterEach(() => { server?.close(); server = null; if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("frames go both ways as length-prefixed JSON, whatever the chunking", async () => {
    dir = mkdtempSync(join(tmpdir(), "blv3-"));
    const path = join(dir, "s.sock");
    const got: string[] = [];
    let peer!: Socket;
    server = createServer((socket) => {
      peer = socket;
      const splitter = new FrameSplitter();
      socket.on("data", (chunk) => {
        const split = splitter.push(new Uint8Array(chunk));
        if (split.ok) for (const frame of split.frames) got.push(new TextDecoder().decode(frame));
      });
    });
    await new Promise<void>((done) => server!.listen(path, done));
    const frames: string[] = [];
    let opened = false;
    let closed: string | undefined;
    const socket = unixDial({ path })({ open: () => { opened = true; }, frame: (f) => frames.push(typeof f === "string" ? f : new TextDecoder().decode(f)), close: (d) => { closed = d ?? "?"; } });
    await vi.waitFor(() => expect(opened).toBe(true));
    socket.send("{\"t\":\"ping\"}");
    await vi.waitFor(() => expect(got).toEqual(["{\"t\":\"ping\"}"]));
    const a = packFrame("{\"a\":1}");
    const b = packFrame("{\"b\":\"ü\"}");
    const both = new Uint8Array([...a, ...b]);
    peer.write(both.slice(0, 3));
    await new Promise((r) => setTimeout(r, 10));
    peer.write(both.slice(3));
    await vi.waitFor(() => expect(frames).toEqual(["{\"a\":1}", "{\"b\":\"ü\"}"]));
    socket.close();
    expect(closed).toBe("closed by the front end");
  });

  it("no server: the dial closes and reports ENOENT", async () => {
    dir = mkdtempSync(join(tmpdir(), "blv3-"));
    const codes: string[] = [];
    let closed = false;
    unixDial({ path: join(dir, "missing.sock"), onError: (e) => codes.push(String(e.code)) })({ open: () => undefined, frame: () => undefined, close: () => { closed = true; } });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(codes).toEqual(["ENOENT"]);
  });
});

describe("builds", () => {
  const inputsOf = async (entry: string, plugins: import("esbuild").Plugin[] = []) => {
    const result = await build({
      absWorkingDir: root, preserveSymlinks: true, bundle: true, platform: "node", format: "cjs", target: "node22",
      entryPoints: [join(root, entry)], outfile: join(root, "out/unused.cjs"), write: false, metafile: true, external: ["electron", "original-fs"], logLevel: "silent", plugins,
    });
    return Object.keys(result.metafile!.inputs);
  };

  it("the 2.x main entry imports nothing from main-v3, the server, fe-link or the v3 protocol", async () => {
    const inputs = await inputsOf("src/main/main.ts");
    expect(inputs).toContain("src/main/core-client.ts");
    expect(inputs.filter((file) => /^src\/(main-v3|server|fe-link|protocol)\//.test(file))).toEqual([]);
  }, 60_000);

  it("the v3 main is the 2.x main with the server client in place of the core client", async () => {
    const { coreClientToServerClient } = await import("../../build.mjs" as string) as { coreClientToServerClient: (root: string) => import("esbuild").Plugin };
    const inputs = await inputsOf("src/main-v3/main.ts", [coreClientToServerClient(root)]);
    expect(inputs).toContain("src/main/main.ts");
    expect(inputs).toContain("src/main-v3/server-client.ts");
    expect(inputs).toContain("src/main-v3/guard.ts");
    expect(inputs).not.toContain("src/main/core-client.ts");
  }, 60_000);
});
