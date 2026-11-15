// M5-08a: Plugin API `content.read(ref, offset, length)` across Web/host/src/api.ts, Core/Plugins, and
// server/content/plugin-read.ts (local ContentService + peer PeerContent with LOCAL_WINDOW, D69).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { PluginContentRead } from "../../src/server/content/plugin-read";
import { ensureStream } from "../../src/server/log";
import type { PeerSession } from "../../src/server/peer";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { tempDir, until } from "../helpers";

const MiB = CONTENT_CHUNK_BYTES;
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
          if (deliver !== undefined && peer === bId) link.upRaw.push(JSON.parse(encoded.text) as Record<string, unknown>);
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
  cleanup: () => Promise<void>;
}

async function createHarness(options: { withContent?: boolean; forcePin?: "path" | "copy" | "clone" } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "plugin-content-read-"));
  const dataA = join(root, "server-a");
  const dataB = join(root, "server-b");
  const coreDir = tempDir("plugin-content-core");
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

  const realRead = new PluginContentRead({
    serverId: SERVER_A,
    service: serviceA,
    peer: peerContent,
    roster: { view: { revoked } },
  });
  let attached = true;

  writePlugin(coreDir, "reader");
  let capturedApi!: BotlingApi;
  let handlers!: HostHandlers;
  const host = new Host(
    (msg) => handlers.data(JSON.stringify(msg) + "\n"),
    async (_spec: HostPluginSpec) => (api: BotlingApi) => {
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
    ...(options.withContent === false
      ? {}
      : {
          content: {
            read: async (ref, offset, length) => {
              if (!attached) throw new Error("The machine that has this file is not reachable.");
              return realRead.read(ref, offset, length);
            },
          },
        }),
  };

  const core = new Core(coreOpts);
  await core.plugins.start();
  await until(() => Boolean(capturedApi));

  return {
    root,
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

describe("M5-08a: plugin API content.read(ref, offset, length)", () => {
  it("1. a local reference: read 0..1024 equals the file's first KiB, and past-end reads stop at EOF", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("local-1", 4096);
    const file = join(h.root, "sample.pdf");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l1", file);
    const ref = { owner: SERVER_A, id, entry };

    const firstKib = await h.api.content.read(ref, 0, 1024);
    expect(firstKib).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(firstKib)).toEqual(data.subarray(0, 1024));

    const tail = await h.api.content.read(ref, 3500, 2000);
    expect(Buffer.from(tail)).toEqual(data.subarray(3500));

    const pastEnd = await h.api.content.read(ref, 4096, 1024);
    expect(pastEnd.byteLength).toBe(0);
  });

  it("1b. a local path-pinned file changes on disk -> refused as changed", async () => {
    const h = await createHarness({ forcePin: "path" });
    cleanups.push(h.cleanup);
    const data = makeBytes("local-path-pin", 4096);
    const file = join(h.root, "big.mp4");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l-path", file);
    const ref = { owner: SERVER_A, id, entry };

    expect(Buffer.from(await h.api.content.read(ref, 0, 512))).toEqual(data.subarray(0, 512));
    truncateSync(file, 100);
    await expect(h.api.content.read(ref, 0, 512)).rejects.toThrow("That file changed or is no longer there.");
  });

  it("2. a wrong entry for that id -> \"That content is not referenced there.\"", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("local-wrong-entry", 2048);
    const file = join(h.root, "doc.pdf");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l2", file);

    await expect(
      h.api.content.read({ owner: SERVER_A, id, entry: { stream: entry.stream, seq: entry.seq + 99 } }, 0, 1024),
    ).rejects.toThrow("That content is not referenced there.");

    await expect(
      h.api.content.read({ owner: SERVER_A, id: sha256Id(Buffer.from("other")), entry }, 0, 1024),
    ).rejects.toThrow("That content is not referenced there.");
  });

  it("3. a peer's reference (two servers): matches owner bytes across 1 MiB chunks and verifies each chunk", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("peer-multi-chunk", 2 * MiB + 12345);
    const file = join(h.root, "video.mp4");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceB, STREAM_PEER, BOT_PEER, "p1", file);
    const ref = { owner: SERVER_B, id, entry };

    const slice1 = await h.api.content.read(ref, 0, 1024);
    expect(Buffer.from(slice1)).toEqual(data.subarray(0, 1024));
    expect(h.peerContent.counts.chunksVerified).toBeGreaterThanOrEqual(1);

    // Cross the 1 MiB -> 2 MiB -> 2+ MiB chunk boundaries
    const slice2 = await h.api.content.read(ref, MiB - 500, MiB + 2000);
    expect(Buffer.from(slice2)).toEqual(data.subarray(MiB - 500, 2 * MiB + 1500));
    expect(h.peerContent.counts.chunksVerified).toBeGreaterThanOrEqual(2);
    const gets = h.link.upRaw.filter((m) => m.t === "content.get");
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) expect(g.device).toBeUndefined();

    // Wrong entry on peer -> refused by owner
    await expect(
      h.api.content.read({ owner: SERVER_B, id, entry: { stream: STREAM_PEER, seq: entry.seq + 50 } }, 0, 1024),
    ).rejects.toThrow("That content is not referenced there.");
  });

  it("3b. peer refusals: corrupted chunk, unreachable owner, revoked owner, lazy wrapper before attach", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("peer-refusals", 2048);
    const file = join(h.root, "peer.png");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceB, STREAM_PEER, BOT_PEER, "p2", file);
    const ref = { owner: SERVER_B, id, entry };

    // Corrupted chunk from owner -> damaged
    h.setCorruptId(id);
    await expect(h.api.content.read(ref, 0, 1024)).rejects.toThrow("That file arrived damaged.");
    h.setCorruptId(null);

    // Unreachable owner -> not reachable
    h.link.open = false;
    await expect(h.api.content.read(ref, 0, 1024)).rejects.toThrow("The machine that has this file is not reachable.");
    h.link.open = true;

    // Revoked owner (checked before peer/cache) -> removed
    h.revoked.add(SERVER_B);
    await expect(h.api.content.read(ref, 0, 1024)).rejects.toThrow("That machine was removed.");
    h.revoked.delete(SERVER_B);

    // Lazy wrapper before pluginRead is assigned -> not reachable
    h.setPluginReadAttached(false);
    await expect(h.api.content.read(ref, 0, 1024)).rejects.toThrow("The machine that has this file is not reachable.");
  });

  it("4. 2.x core options without world.content -> \"Reading content needs Botling 3.\"", async () => {
    const h = await createHarness({ withContent: false });
    cleanups.push(h.cleanup);
    const ref = {
      owner: SERVER_A,
      id: sha256Id(Buffer.from("anything")),
      entry: { stream: STREAM_LOCAL, seq: 1 },
    };
    await expect(h.api.content.read(ref, 0, 1024)).rejects.toThrow("Reading content needs Botling 3.");
  });

  it("5. length 0 -> empty; length 4 MiB -> allowed; length 5 MiB and negative/non-integer values -> refused", async () => {
    const h = await createHarness();
    cleanups.push(h.cleanup);
    const data = makeBytes("bounds", 4 * MiB + 100);
    const file = join(h.root, "large.mp4");
    writeFileSync(file, data);
    const { id, entry } = await postLine(h.serviceA, STREAM_LOCAL, BOT_LOCAL, "l5", file);
    const ref = { owner: SERVER_A, id, entry };

    const empty = await h.api.content.read(ref, 0, 0);
    expect(empty).toBeInstanceOf(Uint8Array);
    expect(empty.byteLength).toBe(0);

    const fourMib = await h.api.content.read(ref, 0, 4 * MiB);
    expect(Buffer.from(fourMib)).toEqual(data.subarray(0, 4 * MiB));

    await expect(h.api.content.read(ref, 0, 5 * MiB)).rejects.toThrow();
    await expect(h.api.content.read(ref, -1, 10)).rejects.toThrow();
    await expect(h.api.content.read(ref, 0, -1)).rejects.toThrow();
    await expect(h.api.content.read(ref, 1.5, 10)).rejects.toThrow();
    await expect(h.api.content.read(ref, 0, 1.5)).rejects.toThrow();
  });
});
