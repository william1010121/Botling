// M5-08b: Plugin API `content.fetch(ref)` across Web/host/src/api.ts, Core/Plugins, and
// server/content/plugin-read.ts (reusing PluginContentRead, CoreOptions.content, and M5-08a errors, D74/Q-C7).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Host, type BotlingApi, type HostPluginSpec } from "../../../Web/host/src/host";
import { CONTENT_CHUNK_BYTES, type EntryRef, type MessageOf, type StreamId, type WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame } from "../../src/protocol/frame";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { Core, type CoreOptions } from "../../src/core/server";
import { ContentService, type LineLike } from "../../src/server/content";
import { ChunkCache, PeerCacheBudget } from "../../src/server/content/chunk-cache";
import { PeerContent, PeerContentOwner } from "../../src/server/content/peer-content";
import type { PinOptions } from "../../src/server/content/pin";
import { PluginContentRead } from "../../src/server/content/plugin-read";
import { ensureStream } from "../../src/server/log";
import type { PeerSession } from "../../src/server/peer";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { expectSameBytes, tempDir, until } from "../helpers";

const MiB = CONTENT_CHUNK_BYTES;
const FETCH_MAX_BYTES = 500 * MiB;
const PEER_OPTS = { local: false } as const;
const SERVER_A = "srvaaaaaaaaaaaaaaaaaaaaaaa";
const SERVER_B = "srvbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_LOCAL = "bot-local";
const STREAM_LOCAL = `bot:${BOT_LOCAL}` as StreamId;
const BOT_PEER = "bot-peer";
const STREAM_PEER = `bot:${BOT_PEER}` as StreamId;

function makeBytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) {
    x.copy(out, at);
    x = createHash("sha256").update(x).digest();
  }
  return out;
}

function sha256Id(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function writePlugin(dir: string, name: string, ccb: Record<string, unknown> = {}) {
  const folder = join(dir, "plugins", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name,
      displayName: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: { host: "dist/host.mjs", ...ccb },
    }),
  );
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

/** Two ends of a FIFO peer session through the real wire encoder. */
class PeerLink {
  open = true;
  readonly upRaw: Array<Record<string, unknown>> = [];
  readonly a: PeerSession;
  readonly b: PeerSession;
  private queue: Array<() => void> = [];
  private flushing = false;

  constructor(
    onA: (s: PeerSession, m: WireMessage) => void,
    onB: (s: PeerSession, m: WireMessage) => void,
    aId: string,
    bId: string,
  ) {
    const link = this;
    const end = (peer: string, deliver: () => (m: WireMessage) => void) =>
      ({
        peer,
        get state() {
          return link.open ? "open" : "closed";
        },
        sendWire: (message: WireMessage) => {
          if (!link.open) return false;
          const encoded = encodeWireFrame(message, "peer", PEER_OPTS);
          if (!encoded.ok) throw new Error(`${message.t}: ${encoded.detail}`);
          if (peer === bId) link.upRaw.push(JSON.parse(encoded.text) as Record<string, unknown>);
          link.push(encoded.text, deliver);
          return true;
        },
        sendChunk: (message: MessageOf<"content.chunk">) => {
          if (!link.open) return false;
          const encoded = encodeChunkFrame(message, "peer", PEER_OPTS);
          if (!encoded.ok) throw new Error(encoded.detail);
          link.push(encoded.bytes, deliver);
          return true;
        },
      }) as unknown as PeerSession;
    this.a = end(bId, () => (m) => onB(this.b, m));
    this.b = end(aId, () => (m) => onA(this.a, m));
  }

  private push(frame: string | Uint8Array, deliver: () => (m: WireMessage) => void): void {
    this.queue.push(() => {
      if (!this.open) return;
      const decoded = decodeWireFrame(frame, "peer", PEER_OPTS);
      if (!decoded.ok) throw new Error(`bad frame: ${decoded.detail}`);
      deliver()(decoded.message);
    });
    if (!this.flushing) {
      this.flushing = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    for (let i = 0; i < 8 && this.queue.length; i++) this.queue.shift()!();
    if (this.queue.length) setImmediate(() => this.flush());
    else this.flushing = false;
  }
}

async function postLine(
  svc: ContentService,
  stream: StreamId,
  botId: string,
  lineId: string,
  filePath: string,
): Promise<{ id: string; entry: EntryRef }> {
  const l: LineLike = { id: lineId, text: `![file](${pathToFileURL(filePath).href})`, attachments: [] };
  const body = { botId, message: { id: lineId, role: "bot", text: l.text, time: "2026-11-15T00:00:00.000Z", state: "done" } };
  const { entries, ready } = await svc.appendLine(stream, botId, l, [{ kind: "message.added", body }]);
  await ready;
  const found = svc.find({ t: "content.find", req: "f1", botId, line: lineId, url: pathToFileURL(filePath).href });
  if (!found.ref) throw new Error("expected content.find to return a ref");
  return { id: found.ref.id, entry: entries[0] ? { stream, seq: entries[0].seq } : found.ref.entry };
}

interface Harness {
  root: string;
  coreDir: string;
  storageDir: string;
  core: Core;
  api: BotlingApi;
  storeA: ServerStore;
  storeB: ServerStore;
  serviceA: ContentService;
  serviceB: ContentService;
  peerContent: PeerContent;
  link: PeerLink;
  revoked: Set<string>;
  setCorruptId: (id: string | null) => void;
  setPluginReadAttached: (attached: boolean) => void;
  setFakeLocalSize: (size: number | null) => void;
  setFakePeerSize: (size: number | null) => void;
  cleanup: () => Promise<void>;
}

async function createHarness(options: {
  contentMode?: "full" | "none" | "read-only";
  forcePin?: "path" | "copy" | "clone";
  pinFetch?: PinOptions;
} = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "plugin-content-fetch-"));
  const dataA = join(root, "server-a");
  const dataB = join(root, "server-b");
  const coreDir = tempDir("plugin-content-fetch-core");
  mkdirSync(dataA, { recursive: true });
  mkdirSync(dataB, { recursive: true });

  const storeA = await openServerStore(dataA);
  const storeB = await openServerStore(dataB);
  await storeA.submit((db) => ensureStream(db, STREAM_LOCAL));
  await storeB.submit((db) => ensureStream(db, STREAM_PEER));

  const serviceA = new ContentService({
    store: storeA,
    dataDir: dataA,
    serverId: SERVER_A,
    ...(options.forcePin ? { pin: { force: options.forcePin } } : {}),
  });
  const serviceB = new ContentService({ store: storeB, dataDir: dataB, serverId: SERVER_B });

  const budget = new PeerCacheBudget(16 * MiB);
  const cache = new ChunkCache({ store: storeA, reader: () => storeA.openReader(), dataDir: dataA, budget });
  const revoked = new Set<string>();
  let corruptId: string | null = null;
  let fakeLocalSize: number | null = null;
  let fakePeerSize: number | null = null;

  const ownerB = new PeerContentOwner({
    service: serviceB,
    roster: { device: () => ({ scope: ["read"] }) },
    get corruptId() {
      return corruptId;
    },
  } as ConstructorParameters<typeof PeerContentOwner>[0]);

  let link!: PeerLink;
  let peerContent!: PeerContent;
  peerContent = new PeerContent({
    self: SERVER_A,
    store: storeA,
    reader: () => storeA.openReader(),
    cache,
    session: (owner) => (owner === SERVER_B && link.open ? link.a : null),
    ownerOf: (stream) => (stream === STREAM_PEER ? SERVER_B : null),
    readable: () => true,
  });

  link = new PeerLink(
    (_s, m) => {
      peerContent.onMessage(link.a, m);
    },
    (s, m) => {
      ownerB.onMessage(s, m);
    },
    SERVER_A,
    SERVER_B,
  );

  const serviceProxy: Pick<ContentService, "open" | "markChanged"> = {
    open: async (msg, opts) => {
      const opened = await serviceA.open(msg, opts);
      if (fakeLocalSize !== null && opened.t === "content.file") {
        return { ...opened, sig: { ...opened.sig, size: fakeLocalSize } };
      }
      return opened;
    },
    markChanged: (id) => serviceA.markChanged(id),
  };

  const peerProxy: Pick<PeerContent, "respond"> = {
    respond: async (url, req, dev) => {
      const res = await peerContent.respond(url, req, dev);
      if (fakePeerSize !== null && req.method === "HEAD" && res.status === 200) {
        const headers = new Headers(res.headers);
        headers.set("Content-Length", String(fakePeerSize));
        return new Response(null, { status: 200, headers });
      }
      return res;
    },
  };

  const realRead = new PluginContentRead({
    serverId: SERVER_A,
    service: serviceProxy,
    peer: peerProxy,
    roster: { view: { revoked } },
    ...(options.pinFetch ? { pin: options.pinFetch } : {}),
  });
  let attached = true;

  writePlugin(coreDir, "fetcher");
  let capturedApi!: BotlingApi;
  let capturedSpec!: HostPluginSpec;
  let handlers!: HostHandlers;
  const host = new Host(
    (msg) => handlers.data(JSON.stringify(msg) + "\n"),
    async (spec: HostPluginSpec) => (api: BotlingApi) => {
      capturedSpec = spec;
      capturedApi = api;
    },
  );
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => host.notify("ready", { pid: 4242 }));
      return {
        pid: 4242,
        write: (text) => {
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            void host.receive(JSON.parse(line));
          }
        },
        terminate: async () => {},
      };
    },
  };

  const mode = options.contentMode ?? "full";
  const coreOpts: CoreOptions = {
    dataDir: coreDir,
    headConfig() {
      throw new Error("No agent allowed");
    },
    emit() {},
    deferStartup: true,
    routineTickMs: 0,
    componentScanMs: 0,
    waitingScanMs: 0,
    watchMs: 0,
    quitTidyMs: 0,
    plugins: { node, hostScript: "host.mjs", sealer: testSealer("test-key") },
    ...(mode === "none"
      ? {}
      : mode === "read-only"
        ? {
            content: {
              read: async (ref, offset, length) => realRead.read(ref, offset, length),
            },
          }
        : {
            content: {
              read: async (ref, offset, length) => {
                if (!attached) throw new Error("The machine that has this file is not reachable.");
                return realRead.read(ref, offset, length);
              },
              fetch: async (storageDir, ref) => {
                if (!attached) throw new Error("The machine that has this file is not reachable.");
                return realRead.fetch(storageDir, ref);
              },
            },
          }),
  };

  const core = new Core(coreOpts);
  await core.plugins.start();
  await until(() => Boolean(capturedApi));

  return {
    root,
    coreDir,
    storageDir: capturedSpec.storageDir,
    core,
    api: capturedApi,
    storeA,
    storeB,
    serviceA,
    serviceB,
    peerContent,
    link,
    revoked,
    setCorruptId: (id) => {
      corruptId = id;
    },
    setPluginReadAttached: (on) => {
      attached = on;
    },
    setFakeLocalSize: (size) => {
      fakeLocalSize = size;
    },
    setFakePeerSize: (size) => {
      fakePeerSize = size;
    },
    cleanup: async () => {
      peerContent.close();
      await peerContent.flushed();
      await core.shutdown();
      await serviceA.close();
      await serviceB.close();
      await storeA.close();
      await storeB.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("M5-08b: plugin API content.fetch(ref)", () => {
  it("1. a local reference -> path under <storageDir>/content/<id> and bytes equal the file", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("local-fetch-1", 4096);
    const file = join(h.root, "sample.pdf");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l1", file);
    const ref = { owner: SERVER_A, id, entry };

    const fetched = await h.api.content.fetch(ref);
    expect(fetched).toBe(resolve(h.storageDir, "content", id));
    const { readFileSync } = await import("node:fs");
    expectSameBytes(readFileSync(fetched), data);
  });

  it("1b. local copyFile fallback when pinFile answers path, plus path-pin mutation and wrong-entry checks", async () => {
    const h = await createHarness({ forcePin: "path", pinFetch: { force: "path" } });
    cleanups.push(h.cleanup);
    const data = makeBytes("local-fetch-path-fallback", 8192);
    const file = join(h.root, "big.mp4");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l-path", file);
    const ref = { owner: SERVER_A, id, entry };

    const fetched = await h.api.content.fetch(ref);
    expect(fetched).toBe(resolve(h.storageDir, "content", id));
    const { readFileSync } = await import("node:fs");
    expectSameBytes(readFileSync(fetched), data);

    // Wrong entry still fails
    await expect(
      h.api.content.fetch({ owner: SERVER_A, id, entry: { stream: entry.stream, seq: entry.seq + 99 } }),
    ).rejects.toThrow("That content is not referenced there.");

    // Mutated path-pinned source fails even if cached
    truncateSync(file, 100);
    await expect(h.api.content.fetch(ref)).rejects.toThrow("That file changed or is no longer there.");
  });

  it("2. a second call -> the same path, no second copy (mtime kept), and reference check still runs", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("local-fetch-reuse", 16 * 1024);
    const file = join(h.root, "reuse.pdf");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l2", file);
    const ref = { owner: SERVER_A, id, entry };

    const first = await h.api.content.fetch(ref);
    const mtimeBefore = statSync(first, { bigint: true }).mtimeNs;

    const second = await h.api.content.fetch(ref);
    expect(second).toBe(first);
    expect(statSync(second, { bigint: true }).mtimeNs).toBe(mtimeBefore);

    // Tampered file at destination is detected and replaced cleanly
    writeFileSync(first, makeBytes("tampered", 1024));
    const repaired = await h.api.content.fetch(ref);
    expect(repaired).toBe(first);
    const { readFileSync } = await import("node:fs");
    expectSameBytes(readFileSync(repaired), data);

    // Reference check still runs even when cached file is present
    await expect(
      h.api.content.fetch({ owner: SERVER_A, id, entry: { stream: entry.stream, seq: entry.seq + 42 } }),
    ).rejects.toThrow("That content is not referenced there.");
  });

  it("3. a peer's reference (two servers, > 4 MiB) -> same bytes; byte flipped in transit -> failure, no file left", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);

    // > 4 MiB so peer fetch exercises multiple 4 MiB reads
    const peerData = makeBytes("peer-fetch-multi", 4 * MiB + 12345);
    const peerFile = join(h.root, "video.mp4");
    writeFileSync(peerFile, peerData);
    const { id, entry } = await postLine(h.serviceB, STREAM_PEER, BOT_PEER, "p1", peerFile);
    const ref = { owner: SERVER_B, id, entry };

    const fetched = await h.api.content.fetch(ref);
    expect(fetched).toBe(resolve(h.storageDir, "content", id));
    const { readFileSync } = await import("node:fs");
    expectSameBytes(readFileSync(fetched), peerData);

    // Flip a byte in transit on a fresh uncached file -> failure and no file / .partial left
    const badData = makeBytes("peer-fetch-corrupt", 2048);
    const badFile = join(h.root, "corrupt.png");
    writeFileSync(badFile, badData);
    const bad = await postLine(h.serviceB, STREAM_PEER, BOT_PEER, "p2", badFile);
    const badRef = { owner: SERVER_B, id: bad.id, entry: bad.entry };

    h.setCorruptId(bad.id);
    await expect(h.api.content.fetch(badRef)).rejects.toThrow("That file arrived damaged.");
    h.setCorruptId(null);

    const contentDir = resolve(h.storageDir, "content");
    const leftover = readdirSync(contentDir);
    expect(leftover).toEqual([id]);

    // Revoked / unreachable / lazy-wrapper refusals match M5-08a
    h.link.open = false;
    await expect(h.api.content.fetch(badRef)).rejects.toThrow("The machine that has this file is not reachable.");
    h.link.open = true;

    h.revoked.add(SERVER_B);
    await expect(h.api.content.fetch(ref)).rejects.toThrow("That machine was removed.");
    h.revoked.delete(SERVER_B);

    h.setPluginReadAttached(false);
    await expect(h.api.content.fetch(ref)).rejects.toThrow("The machine that has this file is not reachable.");
  });

  it("4. over 500 MiB (fake the size) -> exact refusal", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("too-big-fetch", 1024);
    const file = join(h.root, "huge.pdf");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l4", file);

    h.setFakeLocalSize(FETCH_MAX_BYTES + 1);
    await expect(h.api.content.fetch({ owner: SERVER_A, id, entry })).rejects.toThrow(
      "That file is larger than 500 MB; read it in parts with content.read.",
    );
    h.setFakeLocalSize(null);

    const peerFile = join(h.root, "huge-peer.pdf");
    writeFileSync(peerFile, makeBytes("too-big-peer", 1024));
    const peerPosted = await postLine(h.serviceB, STREAM_PEER, BOT_PEER, "p4", peerFile);
    h.setFakePeerSize(FETCH_MAX_BYTES + 1);
    await expect(
      h.api.content.fetch({ owner: SERVER_B, id: peerPosted.id, entry: peerPosted.entry }),
    ).rejects.toThrow("That file is larger than 500 MB; read it in parts with content.read.");
    h.setFakePeerSize(null);
  });

  it("5. 2.x core options without world.content / without fetch -> \"Fetching content needs Botling 3.\"", async () => {
    const ref = {
      owner: SERVER_A,
      id: sha256Id(Buffer.from("anything")),
      entry: { stream: STREAM_LOCAL, seq: 1 },
    };

    const hNone = await createHarness({ contentMode: "none" });
    cleanups.push(hNone.cleanup);
    await expect(hNone.api.content.fetch(ref)).rejects.toThrow("Fetching content needs Botling 3.");

    const hReadOnly = await createHarness({ contentMode: "read-only" });
    cleanups.push(hReadOnly.cleanup);
    await expect(hReadOnly.api.content.fetch(ref)).rejects.toThrow("Fetching content needs Botling 3.");
  });
});
