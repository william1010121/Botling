// M5-07b: the requester side of a fetch (into `.bot/incoming/<source>/<fetchId>/`, verify every chunk and the manifest,
// resume after a lost session). The source is the real `FetchSource` (M5-07a); the "network" is an in-process pipe that
// round-trips every frame through the real codec and can flip bytes, drop the session or reconnect. Temp folders only,
// no window, loopback not even needed (no socket).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame, type WireMessage } from "../../src/protocol";
import { FetchRequester, incomingDirName, type FetchPeer, type FetchResult } from "../../src/server/fetch/requester";
import { FetchSource, type FetchAskHook, type FetchSink } from "../../src/server/fetch/source";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { until } from "../helpers";
import { makeCluster, readServerKeys, writeStatements } from "../support/peer-cluster";

// Independent check of the M5-07b review fixes: a bot racing the requester is simulated by hooks on the requester's
// own `realpathSync` / `lstatSync` / `open` calls (pass-through unless a test sets one), so the swap lands exactly in
// the window between two of its checks.
const race = vi.hoisted(() => ({
  afterRealpath: null as ((path: string) => void) | null,
  beforeOpen: null as ((path: string) => void) | null,
  afterLstat: null as ((path: string) => void) | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = Object.assign((path: string, ...rest: unknown[]) => { const out = (actual.realpathSync as (...a: unknown[]) => string)(path, ...rest); race.afterRealpath?.(String(path)); return out; }, {
    native: (path: string, ...rest: unknown[]) => { const out = (actual.realpathSync.native as (...a: unknown[]) => string)(path, ...rest); race.afterRealpath?.(String(path)); return out; },
  });
  const lstatSync = (path: string, ...rest: unknown[]) => { const out = (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest); race.afterLstat?.(String(path)); return out; };
  return { ...actual, realpathSync, lstatSync };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (path: string, ...rest: unknown[]) => { race.beforeOpen?.(String(path)); return (actual.open as (...a: unknown[]) => unknown)(path, ...rest); };
  return { ...actual, open };
});

const PEER = { local: false } as const;
const MiB = 1024 * 1024;
const FRAME = 64 * 1024;
const SOURCE_NAME = "build box/1";

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function deterministicBytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { block.copy(out, at); block = createHash("sha256").update(block).digest(); }
  return out;
}

function manifestOf(files: Array<{ rel: string; bytes: Uint8Array }>): string {
  const lines = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)).map((f) => `${f.rel}\t${f.bytes.length}\t${sha256Hex(f.bytes)}\n`);
  return sha256Hex(lines.join(""));
}

type Tamper = (message: WireMessage) => WireMessage | null;

async function setup(options: { ask?: FetchAskHook; resumeWindowMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "botling-fetch-req-"));
  const dataA = join(root, "data-a");
  const dataB = join(root, "data-b");
  const folderA = join(root, "bots", "bot-a");
  const folderB = join(root, "bots", "bot-b");
  const artifactsA = join(folderA, ".bot", "artifacts");
  for (const dir of [dataA, dataB, artifactsA, folderB]) mkdirSync(dir, { recursive: true });

  const storeA0 = await openServerStore(dataA);
  const storeB0 = await openServerStore(dataB);
  const idA = await loadOrCreateServerIdentity(dataA, { create: true });
  const idB = await loadOrCreateServerIdentity(dataB, { create: true });
  await storeA0.submit((tx) => bindServerIdentity(tx, idA));
  await storeB0.submit((tx) => bindServerIdentity(tx, idB));
  const ka = await readServerKeys(dataA);
  const kb = await readServerKeys(dataB);
  const cluster = await makeCluster([ka, kb]);
  await storeA0.close();
  await storeB0.close();
  writeStatements(dataA, cluster.clusterId, cluster.statements);
  writeStatements(dataB, cluster.clusterId, cluster.statements);

  const storeA = await openServerStore(dataA);
  const storeB: ServerStore = await openServerStore(dataB);
  const rosterA = await RosterStore.open(storeA, idA);
  const readerA = storeA.openReader();
  const readerB = storeB.openReader();
  // A's copy of B's table names B's bot (the source checks the requester bot is live there).
  await storeA.submit((tx) => {
    tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(`srv:${kb.memberId}`, "bot:bot-b", JSON.stringify({ name: "B Bot" }));
  });

  const source = new FetchSource({
    self: ka.memberId, dataDir: dataA, store: storeA, reader: () => readerA, roster: rosterA,
    botFolders: () => new Map([["bot-a", folderA]]),
    ...(options.ask ? { ask: options.ask } : {}),
  });

  // The pipe. `current` is the requester-side session object of the live link (null while down).
  const asks: Array<Extract<WireMessage, { t: "fetch.ask" }>> = [];
  const delivered: WireMessage[] = [];
  let current: (FetchPeer & { open: boolean }) | null = null;
  let sinkA: (FetchSink & { open: boolean }) | null = null;
  let tamper: Tamper | null = null;
  let afterDeliver: ((message: WireMessage) => void) | null = null;
  let muted = false; // true: asks reach nobody (the test plays the source by hand)

  const requester = new FetchRequester({
    store: storeB,
    session: (member) => (current && current.open && member === ka.memberId ? current : null),
    botFolder: (botId) => (botId === "bot-b" ? folderB : null),
    serverName: (member) => (member === ka.memberId ? SOURCE_NAME : null),
    ...(options.resumeWindowMs !== undefined ? { resumeWindowMs: options.resumeWindowMs } : {}),
  });

  const roundTrip = (message: WireMessage, sender: "peer"): WireMessage => {
    if (message.t === "fetch.chunk") {
      const encoded = encodeChunkFrame(message, sender, PEER);
      if (!encoded.ok) throw new Error(`chunk refused by the codec: ${encoded.detail}`);
      const decoded = decodeWireFrame(encoded.bytes, sender, PEER);
      if (!decoded.ok) throw new Error(decoded.detail);
      return decoded.message;
    }
    const encoded = encodeWireFrame(message, sender, PEER);
    if (!encoded.ok) throw new Error(`frame refused by the codec: ${encoded.detail}`);
    const decoded = decodeWireFrame(encoded.text, sender, PEER);
    if (!decoded.ok) throw new Error(decoded.detail);
    return decoded.message;
  };

  const connect = () => {
    const req: FetchPeer & { open: boolean } = {
      peer: ka.memberId, open: true,
      get state() { return this.open ? "open" : "closed"; },
      sendWire: (message) => {
        if (!req.open) return false;
        const wire = roundTrip(message, "peer");
        if (wire.t === "fetch.ask") asks.push(wire);
        const target = sinkA!;
        if (!muted) setImmediate(() => { if (target.open) source.onMessage(target, wire); });
        return true;
      },
    };
    const deliver = (message: WireMessage): boolean => {
      if (!sink.open) return false;
      const wire = roundTrip(message, "peer");
      setImmediate(() => {
        if (!sink.open || !req.open) return;
        const seen = tamper ? tamper(wire) : wire;
        if (!seen) return;
        delivered.push(seen);
        requester.onMessage(req, seen);
        afterDeliver?.(seen);
      });
      return true;
    };
    const sink: FetchSink & { open: boolean } = {
      peer: kb.memberId, open: true, queuedBytes: 0, transport: "tailnet",
      get state() { return this.open ? "open" : "closed"; },
      sendWire: deliver, sendChunk: deliver,
    };
    current = req;
    sinkA = sink;
    return { req, sink };
  };
  const drop = () => {
    const req = current; const sink = sinkA;
    if (!req || !sink) return;
    req.open = false; sink.open = false;
    source.sessionClosed(sink);
    requester.sessionClosed(req);
    current = null;
  };
  const reconnect = () => {
    const { req } = connect();
    requester.sessionOpened(req);
  };
  connect();

  const incoming = (): string => join(folderB, ".bot", "incoming");
  const srvDir = (): string => incomingDirName(SOURCE_NAME, ka.memberId);
  return {
    root, folderA, folderB, artifactsA, ka, kb, storeA, storeB, readerA, readerB, source, requester, asks, delivered,
    muteSource: () => { muted = true; },
    setTamper: (fn: Tamper | null) => { tamper = fn; },
    setAfterDeliver: (fn: ((message: WireMessage) => void) | null) => { afterDeliver = fn; },
    drop, reconnect, incoming, srvDir,
    current: () => current,
    cleanup: async () => {
      requester.close();
      await requester.flushed();
      source.close();
      await source.flushed();
      readerA.close(); readerB.close();
      await storeA.close(); await storeB.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const artifact = (path: string) => ({ kind: "artifact" as const, botId: "bot-a", path });
const listTree = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(full).isDirectory()) { out.push(`${r}/`); walk(full, r); } else out.push(r);
    }
  };
  walk(dir, "");
  return out;
};
const ok = (result: FetchResult): Extract<FetchResult, { ok: true }> => {
  if (!result.ok) throw new Error(`fetch failed: ${result.reason} ${result.detail ?? ""}`);
  return result;
};

describe("M5-07b: the requester receives a fetch", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { race.afterRealpath = null; race.beforeOpen = null; race.afterLstat = null; for (const fn of cleanups.splice(0)) await fn(); });
  const make = async (options?: Parameters<typeof setup>[0]) => { const env = await setup(options); cleanups.push(env.cleanup); return env; };

  it("names the folder after the source's safe name and the first 8 characters of its id", () => {
    expect(incomingDirName("build-box", "1a2b3c4d5e6f")).toBe("build-box-1a2b3c4d");
    expect(incomingDirName("build box/1", "1a2b3c4d5e6f")).toBe("build_box_1-1a2b3c4d");
    expect(incomingDirName("../..", "1a2b3c4d5e6f")).toBe(".._..-1a2b3c4d");
    expect(incomingDirName("", "1a2b3c4d5e6f")).toBe("server-1a2b3c4d");
    expect(incomingDirName("é".repeat(100), "1a2b3c4d5e6f")).toMatch(/^_{1,64}-1a2b3c4d$/);
  });

  it("1. a 3 MiB file arrives byte-identical under .bot/incoming/<name-id8>/<fetchId>/", async () => {
    const env = await make();
    const payload = deterministicBytes("three-mib", 3 * MiB);
    writeFileSync(join(env.artifactsA, "big.bin"), payload);

    const result = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("big.bin"), "need it", 10 * MiB));
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(payload.length);
    expect(result.dest).toBe(`.bot/incoming/${env.srvDir()}/${result.fetchId}`);
    expect(result.dest.startsWith(".bot/incoming/build_box_1-")).toBe(true);
    const file = join(env.folderB, result.dest, "big.bin");
    expect(readFileSync(file).equals(payload)).toBe(true);
    // Nothing else is left: no .partial, no other file.
    expect(listTree(join(env.folderB, result.dest))).toEqual(["big.bin"]);
    expect(env.asks).toHaveLength(1);
    expect(env.asks[0]).toMatchObject({ requester: { bot: "bot-b" }, source: env.ka.memberId, purpose: "need it", maxBytes: 10 * MiB });
  });

  it("1b. a folder arrives with its tree, an empty file and a name that is not ASCII", async () => {
    const env = await make();
    const dir = join(env.artifactsA, "pack");
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    const files = [
      { rel: "a.txt", bytes: Buffer.from("alpha") },
      { rel: "empty.txt", bytes: Buffer.alloc(0) },
      { rel: "sub/b.bin", bytes: deterministicBytes("b", FRAME * 2 + 17) },
      { rel: "sub/deep/檔案.txt", bytes: Buffer.from("deep") },
    ];
    for (const f of files) writeFileSync(join(dir, f.rel), f.bytes);

    const result = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("pack"), "tree", 10 * MiB));
    expect(result.files).toBe(4);
    expect(result.manifest).toBe(manifestOf(files));
    const base = join(env.folderB, result.dest);
    for (const f of files) expect(readFileSync(join(base, f.rel)).equals(f.bytes)).toBe(true);
    expect(listTree(base).filter((p) => !p.endsWith("/"))).toEqual(files.map((f) => f.rel).sort());
    expect(existsSync(join(base, ".partial"))).toBe(false);
  });

  it("2. a corrupt chunk (a byte flipped on the wire) ends the fetch as corrupt and leaves nothing in the bot folder", async () => {
    const env = await make();
    writeFileSync(join(env.artifactsA, "big.bin"), deterministicBytes("corrupt", 3 * FRAME));
    env.setTamper((m) => {
      if (m.t === "fetch.chunk" && m.index === 1) { const bytes = new Uint8Array(m.bytes); bytes[5] = bytes[5]! ^ 0xff; return { ...m, bytes }; }
      return m;
    });
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("big.bin"), "x", 10 * MiB);
    expect(result).toMatchObject({ ok: false, reason: "corrupt" });
    expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
    expect(existsSync(join(env.incoming(), env.srvDir()))).toBe(false);
    expect(readdirSync(env.folderB)).toEqual([".bot"]);
  });

  it("2b. a manifest that does not match what arrived is corrupt, and nothing is moved into place", async () => {
    const env = await make();
    writeFileSync(join(env.artifactsA, "r.txt"), "hello");
    env.setTamper((m) => (m.t === "fetch.done" ? { ...m, manifest: "0".repeat(64) } : m));
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.txt"), "x", MiB);
    expect(result).toMatchObject({ ok: false, reason: "corrupt" });
    expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
  });

  it("2c. a chunk that is out of order, a file that comes back, a chunk past the granted bytes: each is corrupt", async () => {
    const env = await make();
    // The source never does these; a hostile or broken one could. Inject frames by hand.
    const hostile = async (frames: (fetchId: string) => WireMessage[], expected: "corrupt" | "limit", maxBytes = MiB) => {
      const before = env.asks.length;
      const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", maxBytes);
      const ask = await until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" });
      for (const frame of frames(ask.fetchId)) env.requester.onMessage(env.current()!, frame);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, reason: expected });
    };
    const chunk = (fetchId: string, index: number, file: string, text: string): WireMessage => {
      const bytes = new Uint8Array(Buffer.from(text));
      return { t: "fetch.chunk", fetchId, index, file, sha256: sha256Hex(bytes), bytes };
    };
    env.muteSource(); // the test plays the source by hand
    // A chunk whose bytes do not match its own SHA-256 (no fetch.done follows, so only the per-chunk check can say so).
    await hostile((id) => [{ ...chunk(id, 0, "a.txt", "one"), bytes: new Uint8Array(Buffer.from("two")) } as WireMessage], "corrupt");
    await hostile((id) => [chunk(id, 0, "a.txt", "one"), chunk(id, 2, "a.txt", "three")], "corrupt");
    await hostile((id) => [chunk(id, 0, "a.txt", "one"), chunk(id, 1, "b.txt", "two"), chunk(id, 2, "a.txt", "again")], "corrupt");
    await hostile((id) => [{ t: "fetch.grant", fetchId: id, prefix: "/p", mode: "read", bytes: 3, files: 1, expires: null }, chunk(id, 0, "a.txt", "four")], "corrupt");
    await hostile((id) => [{ t: "fetch.grant", fetchId: id, prefix: "/p", mode: "read", bytes: 10, files: 1, expires: null }, chunk(id, 0, "a.txt", "0123456789")], "limit", 4);
    expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
  });

  it("3. a source that sends ../escape.txt, an absolute path or a NUL ends the fetch as corrupt and writes nothing outside <dest>", async () => {
    const env = await make();
    env.muteSource();
    const bad = ["../escape.txt", "a/../../escape.txt", "/tmp/botling-escape.txt", "a\0b", "", "./a", "a//b", "a/"];
    for (const file of bad) {
      const before = env.asks.length;
      const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
      const ask = await until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" });
      const bytes = new Uint8Array(Buffer.from("pwn"));
      // Not through the codec (the codec already refuses most of these): a hostile peer is not bound by our encoder.
      env.requester.onMessage(env.current()!, { t: "fetch.chunk", fetchId: ask.fetchId, index: 0, file, sha256: sha256Hex(bytes), bytes } as WireMessage);
      expect(await pending, JSON.stringify(file)).toMatchObject({ ok: false, reason: "corrupt" });
    }
    expect(existsSync(join(env.folderB, ".bot", "escape.txt"))).toBe(false);
    expect(existsSync(join(env.folderB, ".bot", "incoming", "escape.txt"))).toBe(false);
    expect(existsSync(join(env.folderB, "escape.txt"))).toBe(false);
    expect(existsSync("/tmp/botling-escape.txt")).toBe(false);
    expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
    expect(readdirSync(env.folderB)).toEqual([".bot"]);
  });

  it("3b. a .bot/incoming that is a symlink out of the bot folder is refused and nothing is written there", async () => {
    const env = await make();
    writeFileSync(join(env.artifactsA, "r.txt"), "hello");
    const outside = join(env.root, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(env.folderB, ".bot"), { recursive: true });
    symlinkSync(outside, join(env.folderB, ".bot", "incoming"));
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.txt"), "x", MiB);
    expect(result.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(env.asks).toHaveLength(0);
  });

  it("4. a session dropped after chunk 1 and back within the window resumes from chunk 2 with the same fetchId; the file is right", async () => {
    const env = await make({ resumeWindowMs: 5_000 });
    const payload = deterministicBytes("resume", 5 * FRAME + 100);
    writeFileSync(join(env.artifactsA, "big.bin"), payload);
    let dropped = false;
    env.setAfterDeliver((m) => { if (m.t === "fetch.chunk" && m.index === 1 && !dropped) { dropped = true; env.drop(); } });

    const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("big.bin"), "x", 10 * MiB);
    await until(() => (dropped ? true : null), { timeout: 5_000, what: "drop" });
    // While the link is down nothing resolves.
    await new Promise((r) => setTimeout(r, 50));
    expect(env.asks).toHaveLength(1);
    env.reconnect();
    const result = ok(await pending);

    expect(env.asks).toHaveLength(2);
    expect(env.asks[1]!.fetchId).toBe(env.asks[0]!.fetchId);
    expect(env.asks[1]!.from).toEqual({ file: "big.bin", index: 1 });
    expect(result.fetchId).toBe(env.asks[0]!.fetchId);
    expect(readFileSync(join(env.folderB, result.dest, "big.bin")).equals(payload)).toBe(true);
    expect(listTree(join(env.folderB, result.dest))).toEqual(["big.bin"]);
  });

  it("4b. a session lost before the first chunk cannot resume: the same fetch starts again under a new fetchId and the old folder is gone (L-c)", async () => {
    const env = await make({ resumeWindowMs: 5_000 });
    const payload = deterministicBytes("lc", 2 * FRAME);
    writeFileSync(join(env.artifactsA, "big.bin"), payload);
    let dropped = false;
    env.setAfterDeliver((m) => { if (m.t === "fetch.grant" && !dropped) { dropped = true; env.drop(); } });

    const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("big.bin"), "x", 10 * MiB);
    await until(() => (dropped ? true : null), { timeout: 5_000, what: "drop" });
    env.reconnect();
    const result = ok(await pending);

    expect(env.asks).toHaveLength(2);
    expect(env.asks[1]!.fetchId).not.toBe(env.asks[0]!.fetchId);
    expect(env.asks[1]!.from).toBeUndefined();
    expect(result.fetchId).toBe(env.asks[1]!.fetchId);
    expect(readdirSync(join(env.incoming(), env.srvDir()))).toEqual([result.fetchId]);
    expect(readFileSync(join(env.folderB, result.dest, "big.bin")).equals(payload)).toBe(true);
  });

  it("4c. a session that does not come back within the window ends the fetch as unreachable and removes the partial files", async () => {
    const env = await make({ resumeWindowMs: 80 });
    writeFileSync(join(env.artifactsA, "big.bin"), deterministicBytes("gone", 4 * FRAME));
    let dropped = false;
    env.setAfterDeliver((m) => { if (m.t === "fetch.chunk" && m.index === 1 && !dropped) { dropped = true; env.drop(); } });
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("big.bin"), "x", 10 * MiB);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
    expect(existsSync(join(env.incoming(), env.srvDir()))).toBe(false);
  });

  it("4d. no session to the source at the start is unreachable at once, and nothing is created", async () => {
    const env = await make();
    env.drop();
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(existsSync(env.incoming())).toBe(false);
  });

  it("5. one fetch leaves an audit row on both servers (fetch.serve at the source, fetch.receive here, same manifest)", async () => {
    const env = await make();
    const payload = deterministicBytes("audit", 2 * FRAME + 5);
    writeFileSync(join(env.artifactsA, "r.bin"), payload);
    const result = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.bin"), "x", 10 * MiB));
    const manifest = manifestOf([{ rel: "r.bin", bytes: payload }]);

    const rowOf = (db: ReturnType<ServerStore["openReader"]>, stream: string) =>
      db.prepare("SELECT body FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(stream, `audit:${result.fetchId}`) as { body: string } | undefined;
    const served = rowOf(env.readerA, `srv:${env.ka.memberId}`);
    const received = rowOf(env.readerB, `srv:${env.kb.memberId}`);
    expect(JSON.parse(served!.body)).toMatchObject({ act: "fetch.serve", by: env.kb.memberId, member: "bot-b", size: payload.length, hash: manifest });
    expect(JSON.parse(received!.body)).toMatchObject({ act: "fetch.receive", by: env.ka.memberId, member: "bot-b", size: payload.length, hash: manifest });
  });

  it("6. a source that says no ends the fetch with its reason and leaves nothing", async () => {
    const env = await make(); // the default approval hook denies anything that is not a bot's artifact
    writeFileSync(join(env.folderA, "secret.txt"), "x");
    const result = await env.requester.fetch("bot-b", env.ka.memberId, { kind: "path", path: join(env.folderA, "secret.txt") }, "x", MiB);
    expect(result).toMatchObject({ ok: false, reason: "denied" });
    expect(existsSync(join(env.incoming(), env.srvDir()))).toBe(false);
  });

  it("6b. a bot this server does not have, or a maxBytes outside 1..500 MiB, never reaches the wire", async () => {
    const env = await make();
    expect(await env.requester.fetch("no-such-bot", env.ka.memberId, artifact("x"), "x", MiB)).toMatchObject({ ok: false, reason: "denied" });
    const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("missing.txt"), "x", 10 ** 12);
    expect(env.asks[0]?.maxBytes ?? 500 * MiB).toBe(500 * MiB);
    expect(result.ok).toBe(false); // the file is not there
  });

  it("7. frames for an unknown fetchId, or from another server than the source, change nothing", async () => {
    const env = await make();
    env.muteSource();
    const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
    const ask = await until(() => env.asks[0] ?? null, { timeout: 2_000, what: "ask" });
    const stranger: FetchPeer = { peer: env.kb.memberId, state: "open", sendWire: () => true };
    const frame = (text: string, fetchId = ask.fetchId) => {
      const bytes = new Uint8Array(Buffer.from(text));
      return { t: "fetch.chunk", fetchId, index: 0, file: "a.txt", sha256: sha256Hex(bytes), bytes } as WireMessage;
    };
    const grantFrame = { t: "fetch.grant", fetchId: ask.fetchId, prefix: "/p", mode: "read", bytes: 3, files: 1, expires: null } as WireMessage;
    expect(env.requester.onMessage(stranger, grantFrame)).toBe(true);
    expect(env.requester.onMessage(stranger, frame("zzz"))).toBe(true);
    expect(env.requester.onMessage(env.current()!, frame("yyy", "other-fetch"))).toBe(true);
    expect(env.requester.onMessage(env.current()!, { t: "fetch.ask", fetchId: "x", requester: { bot: "b" }, source: env.ka.memberId, what: artifact("x"), purpose: "", maxBytes: 1 } as WireMessage)).toBe(false);
    // The source's own frames still make a whole fetch: nothing above was taken (chunk 0 is still due, a.txt is new).
    env.requester.onMessage(env.current()!, grantFrame);
    env.requester.onMessage(env.current()!, frame("abc"));
    env.requester.onMessage(env.current()!, { t: "fetch.done", fetchId: ask.fetchId, manifest: manifestOf([{ rel: "a.txt", bytes: Buffer.from("abc") }]), bytes: 3 } as WireMessage);
    const result = ok(await pending);
    expect(readFileSync(join(env.folderB, result.dest, "a.txt"), "utf8")).toBe("abc");
  });

  describe("review fixes (M5-07b review R1-R4 and the guards mutation found untested)", () => {
    const chunk = (fetchId: string, index: number, file: string, text: string): WireMessage => {
      const bytes = new Uint8Array(Buffer.from(text));
      return { t: "fetch.chunk", fetchId, index, file, sha256: sha256Hex(bytes), bytes };
    };
    const grant = (fetchId: string, bytes: number, files: number): WireMessage =>
      ({ t: "fetch.grant", fetchId, prefix: "/p", mode: "read", bytes, files, expires: null } as WireMessage);
    const done = (fetchId: string, files: Array<{ rel: string; text: string }>, bytes?: number): WireMessage => ({
      t: "fetch.done", fetchId, manifest: manifestOf(files.map((f) => ({ rel: f.rel, bytes: Buffer.from(f.text) }))),
      bytes: bytes ?? files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
    } as WireMessage);
    /** Starts a fetch the test answers by hand; `staging` is `<source>/.<fetchId>.partial`, `dest` is not made yet. */
    const start = async (env: Awaited<ReturnType<typeof setup>>) => {
      env.muteSource();
      const before = env.asks.length;
      const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
      const ask = await until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" });
      const srv = join(env.incoming(), env.srvDir());
      const send = (m: WireMessage) => env.requester.onMessage(env.current()!, m);
      return { pending, id: ask.fetchId, staging: join(srv, `.${ask.fetchId}.partial`), dest: join(srv, ask.fetchId), send };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    it("R1: files are staged next to <dest>, and <dest> appears only after fetch.done", async () => {
      const env = await make();
      const { pending, id, staging, dest, send } = await start(env);
      expect(lstatSync(staging).isDirectory()).toBe(true);
      expect(existsSync(dest)).toBe(false);
      send(grant(id, 3, 1));
      send(chunk(id, 0, "a.txt", "abc"));
      await settle();
      expect(existsSync(dest)).toBe(false);
      send(done(id, [{ rel: "a.txt", text: "abc" }]));
      ok(await pending);
      expect(existsSync(staging)).toBe(false);
      expect(listTree(dest)).toEqual(["a.txt"]);
    });

    it("R1: a staging folder the bot swapped for a symlink gets nothing written through it", async () => {
      const env = await make();
      const outside = join(env.root, "outside-staging");
      mkdirSync(outside);
      const { pending, id, staging, send } = await start(env);
      rmSync(staging, { recursive: true, force: true });
      symlinkSync(outside, staging);
      send(grant(id, 7, 1));
      send(chunk(id, 0, "evil.plist", "PAYLOAD"));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(readdirSync(outside)).toEqual([]);
    });

    it("R1: a staging sub folder swapped for a symlink between two files gets nothing written through it", async () => {
      const env = await make();
      const outside = join(env.root, "outside-sub");
      mkdirSync(outside);
      const { pending, id, staging, send } = await start(env);
      send(grant(id, 6, 2));
      send(chunk(id, 0, "sub/a", "AAA"));
      await settle();
      renameSync(join(staging, "sub"), join(staging, "moved"));
      symlinkSync(outside, join(staging, "sub"));
      send(chunk(id, 1, "sub/b", "BBB"));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(readdirSync(outside)).toEqual([]);
    });

    it("R1: a <dest> the bot planted (a symlink out) before fetch.done: nothing moves there, nothing is overwritten", async () => {
      const env = await make();
      const outside = join(env.root, "outside-dest");
      mkdirSync(join(outside, "sub"), { recursive: true });
      writeFileSync(join(outside, "sub", "x.txt"), "ORIGINAL");
      const { pending, id, dest, send } = await start(env);
      send(grant(id, 8, 1));
      send(chunk(id, 0, "sub/x.txt", "REPLACED"));
      await settle();
      symlinkSync(outside, dest);
      send(done(id, [{ rel: "sub/x.txt", text: "REPLACED" }]));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(readFileSync(join(outside, "sub", "x.txt"), "utf8")).toBe("ORIGINAL");
      expect(readdirSync(outside)).toEqual(["sub"]);
    });

    it("R2: a source folder named .partial / .PARTIAL next to a file arrives intact (no reserved name inside <dest>)", async () => {
      const env = await make();
      const files = [{ rel: ".PARTIAL/x", text: "AAA" }, { rel: ".partial-not/y", text: "CC" }, { rel: "x", text: "BBB" }];
      const { pending, id, send } = await start(env);
      send(grant(id, 8, 3));
      files.forEach((f, i) => send(chunk(id, i, f.rel, f.text)));
      send(done(id, files));
      const result = ok(await pending);
      const base = join(env.folderB, result.dest);
      expect(result.files).toBe(3);
      for (const f of files) expect(readFileSync(join(base, f.rel), "utf8")).toBe(f.text);
    });

    it("R4: a chunk before fetch.grant is corrupt", async () => {
      const env = await make();
      const { pending, id, send } = await start(env);
      send(chunk(id, 0, "a", "A"));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
    });

    it("more files than the grant names, a fetch.done byte count or grant totals that differ: each is corrupt", async () => {
      const env = await make();
      const cases: Array<(id: string) => WireMessage[]> = [
        (id) => [grant(id, 6, 1), chunk(id, 0, "a.txt", "aaa"), chunk(id, 1, "b.txt", "bbb")],
        (id) => [grant(id, 3, 1), chunk(id, 0, "a.txt", "aaa"), done(id, [{ rel: "a.txt", text: "aaa" }], 4)],
        (id) => [grant(id, 6, 2), chunk(id, 0, "a.txt", "aaa"), done(id, [{ rel: "a.txt", text: "aaa" }])],
      ];
      for (const frames of cases) {
        const { pending, id, send } = await start(env);
        for (const frame of frames(id)) send(frame);
        expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      }
      expect(listTree(env.incoming()).filter((p) => !p.endsWith("/"))).toEqual([]);
    });

    it("two names that differ only by case are corrupt (they would be one file on a case-insensitive disk)", async () => {
      const env = await make();
      const { pending, id, send } = await start(env);
      send(grant(id, 6, 2));
      send(chunk(id, 0, "Read.me", "aaa"));
      send(chunk(id, 1, "read.ME", "bbb"));
      const result = await pending;
      expect(result).toMatchObject({ ok: false, reason: "corrupt" });
      if (!result.ok) expect(result.detail).toMatch(/differs only by case/);
    });

    // ---- independent check (bot racing the requester) ----
    const realFs = () => vi.importActual<typeof import("node:fs")>("node:fs");

    it("check: a staging folder swapped for a symlink right after prepare's realpath check is refused (its inode is not a folder's)", async () => {
      const env = await make();
      const fs = await realFs();
      const outside = join(env.root, "outside-prepare");
      mkdirSync(outside);
      let fired = false;
      race.afterRealpath = (path) => {
        if (!/\.[0-9a-f-]{36}\.partial$/.test(path)) return;
        race.afterRealpath = null;
        fired = true;
        fs.renameSync(path, `${path}.moved`);
        fs.symlinkSync(outside, path);
      };
      env.muteSource();
      const before = env.asks.length;
      const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
      const ask = await Promise.race([until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" }), pending.then(() => null)]);
      if (ask) {
        const send = (m: WireMessage) => env.requester.onMessage(env.current()!, m);
        send(grant(ask.fetchId, 7, 1));
        send(chunk(ask.fetchId, 0, "evil.plist", "PAYLOAD"));
        send(done(ask.fetchId, [{ rel: "evil.plist", text: "PAYLOAD" }]));
      }
      expect((await pending).ok).toBe(false);
      expect(fired).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
    });

    it("check: a sub folder swapped to a symlink for the open and back before the folder re-check gets no file and no byte outside", async () => {
      const env = await make();
      const fs = await realFs();
      const outside = join(env.root, "outside-swap");
      mkdirSync(outside);
      const { pending, id, staging, send } = await start(env);
      // the requester works on real paths (the temp folder is under a symlinked /var on macOS)
      const sub = join(fs.realpathSync(staging), "sub");
      let swapped = false;
      race.beforeOpen = (path) => {
        if (path !== join(sub, "evil.plist")) return;
        race.beforeOpen = null;
        swapped = true;
        fs.renameSync(sub, `${sub}.real`);
        fs.symlinkSync(outside, sub);
        race.afterLstat = (p) => {
          if (p !== join(sub, "evil.plist")) return;
          race.afterLstat = null;
          fs.unlinkSync(sub);
          fs.renameSync(`${sub}.real`, sub);
        };
      };
      send(grant(id, 7, 1));
      send(chunk(id, 0, "sub/evil.plist", "PAYLOAD"));
      send(done(id, [{ rel: "sub/evil.plist", text: "PAYLOAD" }]));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(swapped).toBe(true);
      if (process.platform === "darwin") expect(readdirSync(outside)).toEqual([]);
      else for (const name of readdirSync(outside)) expect(readFileSync(join(outside, name), "utf8")).toBe("");
    });

    it("check: a sub folder that is a symlink makes no folder outside (folders are made one at a time, each checked)", async () => {
      const env = await make();
      const outside = join(env.root, "outside-mkdir");
      mkdirSync(outside);
      const { pending, id, staging, send } = await start(env);
      symlinkSync(outside, join(staging, "sub"));
      send(grant(id, 3, 1));
      send(chunk(id, 0, "sub/deep/er/x", "abc"));
      expect(await pending).toMatchObject({ ok: false, reason: "corrupt" });
      expect(readdirSync(outside)).toEqual([]);
    });
  });
});
