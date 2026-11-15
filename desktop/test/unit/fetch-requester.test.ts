// M5-07b: the requester side of a fetch (into `.bot/incoming/<source>/<fetchId>/`, verify every chunk and the manifest,
// resume after a lost session). The source is the real `FetchSource` (M5-07a); the "network" is an in-process pipe that
// round-trips every frame through the real codec and can flip bytes, drop the session or reconnect. Temp folders only,
// no window, loopback not even needed (no socket).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame, type WireMessage } from "../../src/protocol";
import { FETCH_MAX_DEPTH, FETCH_MAX_DIRS, FETCH_MAX_FILES } from "../../src/protocol/fetch";
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
  noProc: false, // true: this machine has no /proc (existsSync says no, readlink fails)
  afterReaddir: null as ((path: string) => void) | null,
  mkdirs: null as string[] | null, // every mkdirSync path the requester made (when a test sets an array)
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = Object.assign((path: string, ...rest: unknown[]) => { const out = (actual.realpathSync as (...a: unknown[]) => string)(path, ...rest); race.afterRealpath?.(String(path)); return out; }, {
    native: (path: string, ...rest: unknown[]) => { const out = (actual.realpathSync.native as (...a: unknown[]) => string)(path, ...rest); race.afterRealpath?.(String(path)); return out; },
  });
  const lstatSync = (path: string, ...rest: unknown[]) => { const out = (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest); race.afterLstat?.(String(path)); return out; };
  const isProc = (path: unknown) => String(path) === "/proc/self/fd" || String(path).startsWith("/proc/self/fd/");
  const existsSync = (path: string) => (race.noProc && isProc(path) ? false : actual.existsSync(path));
  const readlinkSync = (path: string, ...rest: unknown[]) => {
    if (race.noProc && isProc(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, readlink '${path}'`), { code: "ENOENT" });
    return (actual.readlinkSync as (...a: unknown[]) => unknown)(path, ...rest);
  };
  const readdirSync = (path: string, ...rest: unknown[]) => { const out = (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest); race.afterReaddir?.(String(path)); return out; };
  const mkdirSync = (path: string, ...rest: unknown[]) => { race.mkdirs?.push(String(path)); return (actual.mkdirSync as (...a: unknown[]) => unknown)(path, ...rest); };
  return { ...actual, realpathSync, lstatSync, existsSync, readlinkSync, readdirSync, mkdirSync };
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

async function setup(options: { ask?: FetchAskHook; resumeWindowMs?: number; maxDirs?: number; maxDepth?: number; onAudit?: () => void } = {}) {
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

  // `auditFails`: the audit row cannot be written (submit rejects, or throws before returning a promise).
  const audit = { fails: null as null | "reject" | "throw" };
  const store = {
    submit: ((fn: Parameters<ServerStore["submit"]>[0]) => {
      if (audit.fails === "throw") throw new Error("audit disk is full");
      if (audit.fails === "reject") return Promise.reject(new Error("audit disk is full"));
      return storeB.submit(fn);
    }) as ServerStore["submit"],
  };
  const requester = new FetchRequester({
    store,
    ...(options.maxDirs !== undefined ? { maxDirs: options.maxDirs } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
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
    failAudit: (how: "reject" | "throw" | null) => { audit.fails = how; },
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
  afterEach(async () => { race.afterRealpath = null; race.beforeOpen = null; race.afterLstat = null; race.noProc = false; race.afterReaddir = null; race.mkdirs = null; for (const fn of cleanups.splice(0)) await fn(); });
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

    // ---- second check: the Linux real-path check fails closed ----
    it("check 2: on Linux without a readable /proc/self/fd the file is refused (the real-path check is never skipped)", async () => {
      const env = await make();
      env.muteSource();
      // a requester module loaded as on Linux on a machine with no /proc (its flags are fixed when it loads)
      race.noProc = true;
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      let Fresh: typeof FetchRequester;
      try {
        vi.resetModules();
        ({ FetchRequester: Fresh } = await import("../../src/server/fetch/requester"));
      } finally { Object.defineProperty(process, "platform", platform); }
      const requester = new Fresh({
        store: env.storeB,
        session: (member) => (member === env.ka.memberId ? env.current() : null),
        botFolder: (botId) => (botId === "bot-b" ? env.folderB : null),
        serverName: (member) => (member === env.ka.memberId ? SOURCE_NAME : null),
      });
      cleanups.unshift(async () => { requester.close(); await requester.flushed(); });
      const before = env.asks.length;
      const pending = requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
      const ask = await until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" });
      const send = (m: WireMessage) => requester.onMessage(env.current()!, m);
      send(grant(ask.fetchId, 3, 1));
      send(chunk(ask.fetchId, 0, "a.txt", "abc"));
      send(done(ask.fetchId, [{ rel: "a.txt", text: "abc" }]));
      const result = await pending;
      expect(result).toMatchObject({ ok: false, reason: "corrupt" });
      if (!result.ok) expect(result.detail).toMatch(/did not land/);
    });
  });
  // ---- follow-up card: fetch-receive hardening (M5-07b review F-2 leftover staging, F-3 directory flood, F-4 audit) ----
  describe("fetch-receive hardening", () => {
    const chunk = (fetchId: string, index: number, file: string, text: string): WireMessage => {
      const bytes = new Uint8Array(Buffer.from(text));
      return { t: "fetch.chunk", fetchId, index, file, sha256: sha256Hex(bytes), bytes };
    };
    const grant = (fetchId: string, bytes: number, files: number): WireMessage =>
      ({ t: "fetch.grant", fetchId, prefix: "/p", mode: "read", bytes, files, expires: null } as WireMessage);
    const done = (fetchId: string, files: Array<{ rel: string; text: string }>): WireMessage => ({
      t: "fetch.done", fetchId, manifest: manifestOf(files.map((f) => ({ rel: f.rel, bytes: Buffer.from(f.text) }))),
      bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
    } as WireMessage);
    /** Starts a fetch the test answers by hand. */
    const start = async (env: Awaited<ReturnType<typeof setup>>) => {
      env.muteSource();
      const before = env.asks.length;
      const pending = env.requester.fetch("bot-b", env.ka.memberId, artifact("x"), "x", MiB);
      const ask = await until(() => env.asks[before] ?? null, { timeout: 2_000, what: "ask" });
      const srv = join(env.incoming(), env.srvDir());
      const send = (m: WireMessage) => env.requester.onMessage(env.current()!, m);
      return { pending, id: ask.fetchId, staging: join(srv, `.${ask.fetchId}.partial`), dest: join(srv, ask.fetchId), send };
    };
    const noFiles = (dir: string) => listTree(dir).filter((p) => !p.endsWith("/"));
    /** A tree of folders `names` deep, with one file at the bottom, under `<artifactsA>/<root>`. */
    const deepTree = (env: Awaited<ReturnType<typeof setup>>, root: string, depth: number) => {
      const folders = Array.from({ length: depth }, (_, i) => `f${i}`);
      mkdirSync(join(env.artifactsA, root, ...folders), { recursive: true });
      writeFileSync(join(env.artifactsA, root, ...folders, "leaf.txt"), "leaf");
    };

    describe("1. staging folders a fetch that never finished left behind are removed at start", () => {
      const SRV = "build_box_1-deadbeef";
      /** `<incoming>/<SRV>/.<uuid>.partial/` with a nested file in it. */
      const leftover = (folder: string) => {
        const srv = join(folder, ".bot", "incoming", SRV);
        const name = `.${randomUUID()}.partial`;
        mkdirSync(join(srv, name, "a", "b"), { recursive: true });
        writeFileSync(join(srv, name, "a", "b", "x.bin"), "partial bytes");
        writeFileSync(join(srv, name, "top.txt"), "t");
        return { srv, name, path: join(srv, name) };
      };

      it("1a. removes every staging folder of the bot folders it is given, and nothing else in them", async () => {
        const env = await make();
        const other = join(env.root, "bots", "bot-c");
        const one = leftover(env.folderB);
        const two = leftover(env.folderB);
        const three = leftover(other);
        // a finished fetch (`<fetchId>/`) is the bot's data: never touched
        const finished = join(one.srv, randomUUID());
        mkdirSync(finished);
        writeFileSync(join(finished, "kept.txt"), "kept");
        expect(env.requester.removeLeftoverStaging([env.folderB, other])).toBe(3);
        for (const gone of [one.path, two.path, three.path]) expect(existsSync(gone)).toBe(false);
        expect(readFileSync(join(finished, "kept.txt"), "utf8")).toBe("kept");
      });

      it("1b. only the exact staging name goes: `.<uuid>.partial`, a plain folder, nothing else", async () => {
        const env = await make();
        const srv = join(env.incoming(), SRV);
        mkdirSync(srv, { recursive: true });
        const id = randomUUID();
        const keepFolders = [".partial", ".abc.partial", `.${id}.partial.bak`, `..${id}.partial`, `.${id.toUpperCase()}.partial`, id, `x.${id}.partial`];
        for (const name of keepFolders) { mkdirSync(join(srv, name)); writeFileSync(join(srv, name, "keep.txt"), name); }
        const fileName = `.${randomUUID()}.partial`; // a regular FILE with the staging name is not a staging folder
        writeFileSync(join(srv, fileName), "a file");
        expect(env.requester.removeLeftoverStaging([env.folderB])).toBe(0);
        for (const name of keepFolders) expect(readFileSync(join(srv, name, "keep.txt"), "utf8")).toBe(name);
        expect(readFileSync(join(srv, fileName), "utf8")).toBe("a file");
      });

      it("1c. a symlink is never followed: one named like a staging folder stays, and a link inside one is removed without touching its target", async () => {
        const env = await make();
        const outside = join(env.root, "outside-clean");
        mkdirSync(join(outside, "sub"), { recursive: true });
        writeFileSync(join(outside, "keep.txt"), "outside");
        writeFileSync(join(outside, "sub", "keep2.txt"), "outside2");
        const srv = join(env.incoming(), SRV);
        mkdirSync(srv, { recursive: true });
        const linkName = `.${randomUUID()}.partial`;
        symlinkSync(outside, join(srv, linkName)); // named like staging but a link: left alone, not followed
        const real = leftover(env.folderB);
        symlinkSync(outside, join(real.path, "link-dir"));
        symlinkSync(join(outside, "keep.txt"), join(real.path, "link-file"));
        expect(env.requester.removeLeftoverStaging([env.folderB])).toBe(1);
        expect(existsSync(real.path)).toBe(false);
        expect(lstatSync(join(srv, linkName)).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
        expect(readFileSync(join(outside, "sub", "keep2.txt"), "utf8")).toBe("outside2");
      });

      it("1d. only under a plain `.bot/incoming/<source>/`: a symlink at `.bot`, `incoming` or the source folder is not followed", async () => {
        const env = await make();
        const name = `.${randomUUID()}.partial`;
        const mk = (label: string) => { const folder = join(env.root, "bots", `case-${label}`); mkdirSync(folder, { recursive: true }); return folder; };
        const outsideFor = (label: string, ...inside: string[]) => {
          const outside = join(env.root, `outside-${label}`);
          mkdirSync(join(outside, ...inside, name), { recursive: true });
          writeFileSync(join(outside, ...inside, name, "keep.txt"), label);
          return { outside, file: join(outside, ...inside, name, "keep.txt") };
        };
        const a = outsideFor("bot", "incoming", SRV); // `.bot` is a link
        const fa = mk("bot"); symlinkSync(a.outside, join(fa, ".bot"));
        const b = outsideFor("incoming", SRV); // `.bot/incoming` is a link
        const fb = mk("incoming"); mkdirSync(join(fb, ".bot")); symlinkSync(b.outside, join(fb, ".bot", "incoming"));
        const c = outsideFor("srv"); // `.bot/incoming/<source>` is a link
        const fc = mk("srv"); mkdirSync(join(fc, ".bot", "incoming"), { recursive: true }); symlinkSync(c.outside, join(fc, ".bot", "incoming", SRV));
        expect(env.requester.removeLeftoverStaging([fa, fb, fc])).toBe(0);
        for (const [x, label] of [[a, "bot"], [b, "incoming"], [c, "srv"]] as const) expect(readFileSync(x.file, "utf8")).toBe(label);
      });

      it("1e. a folder missing, or a bot folder with no .bot, is fine (nothing thrown, nothing removed)", async () => {
        const env = await make();
        expect(env.requester.removeLeftoverStaging([join(env.root, "no-such-folder"), env.folderB])).toBe(0);
      });

      it("1f. a fetch running now keeps its staging folder (only the leftovers beside it go)", async () => {
        const env = await make();
        const { pending, staging } = await start(env);
        const stale = leftover(env.folderB);
        expect(env.requester.removeLeftoverStaging([env.folderB])).toBe(1);
        expect(existsSync(stale.path)).toBe(false);
        expect(lstatSync(staging).isDirectory()).toBe(true);
        env.requester.close();
        expect(await pending).toMatchObject({ ok: false, reason: "unreachable" });
      });

      it("1g. race: the staging folder swapped for a symlink after it was checked loses only the link, nothing outside", async () => {
        const env = await make();
        const outside = join(env.root, "outside-race");
        mkdirSync(join(outside, "sub"), { recursive: true });
        writeFileSync(join(outside, "keep.txt"), "outside");
        writeFileSync(join(outside, "sub", "keep2.txt"), "outside2");
        const stale = leftover(env.folderB);
        let swapped = 0;
        race.afterLstat = (path) => {
          if (path !== stale.path || swapped++) return;
          renameSync(stale.path, join(stale.srv, "aside")); // the bot moves its (real) folder away and links outside in its place
          symlinkSync(outside, stale.path);
        };
        env.requester.removeLeftoverStaging([env.folderB]);
        expect(swapped).toBeGreaterThan(0);
        expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
        expect(readFileSync(join(outside, "sub", "keep2.txt"), "utf8")).toBe("outside2");
      });

      it("1h. race: the source folder swapped for a symlink after it was listed makes the cleanup stop there, nothing outside is removed", async () => {
        const env = await make();
        const stale = leftover(env.folderB);
        const outside = join(env.root, "outside-srv");
        mkdirSync(join(outside, stale.name), { recursive: true }); // the same name, out there
        writeFileSync(join(outside, stale.name, "keep.txt"), "outside");
        let swapped = 0;
        race.afterReaddir = (path) => {
          if (path !== stale.srv || swapped++) return;
          renameSync(stale.srv, `${stale.srv}-aside`);
          symlinkSync(outside, stale.srv);
        };
        env.requester.removeLeftoverStaging([env.folderB]);
        expect(swapped).toBeGreaterThan(0);
        expect(readFileSync(join(outside, stale.name, "keep.txt"), "utf8")).toBe("outside");
      });
    });

    describe("2. a source cannot make the requester create unbounded or too deeply nested folders", () => {
      it("2a. the default caps sit with the file and byte caps and match the source's folder cap", () => {
        expect(FETCH_MAX_DIRS).toBe(20_000);
        expect(FETCH_MAX_DIRS).toBe(FETCH_MAX_FILES);
        expect(FETCH_MAX_DEPTH).toBe(64);
      });

      it("2b. a flood of zero-byte files, each in a fresh folder: the cap is `limit`, and no more folders than the cap were ever made", async () => {
        const env = await make({ maxDirs: 3 });
        const { pending, id, send } = await start(env);
        race.mkdirs = [];
        send(grant(id, 0, 50));
        for (let i = 0; i < 10; i++) send(chunk(id, i, `d${i}/x`, ""));
        expect(await pending).toMatchObject({ ok: false, reason: "limit" });
        // (matched by the fetch id: the requester works on real paths, which on a Mac differ from the typed temp path)
        expect(race.mkdirs.filter((path) => path.includes(`.${id}.partial/`))).toHaveLength(3);
        expect(readdirSync(env.folderB)).toEqual([".bot"]);
        expect(noFiles(env.incoming())).toEqual([]);
        expect(existsSync(join(env.incoming(), env.srvDir()))).toBe(false);
      });

      it("2c. the cap counts folders made, not files: three files in one folder chain stay at the cap, one more fresh folder goes over", async () => {
        const env = await make({ maxDirs: 3 });
        const first = await start(env);
        first.send(grant(first.id, 0, 3));
        for (const [i, file] of ["a/b/c/x", "a/b/c/y", "a/b/c/z"].entries()) first.send(chunk(first.id, i, file, ""));
        first.send(done(first.id, ["a/b/c/x", "a/b/c/y", "a/b/c/z"].map((rel) => ({ rel, text: "" }))));
        expect(ok(await first.pending).files).toBe(3);
        const second = await start(env);
        second.send(grant(second.id, 0, 2));
        second.send(chunk(second.id, 0, "a/b/c/x", ""));
        second.send(chunk(second.id, 1, "a/b/d/x", "")); // a, b, c, d: the fourth new folder
        expect(await second.pending).toMatchObject({ ok: false, reason: "limit" });
      });

      it("2d. a path nested deeper than the depth cap is `limit` before any folder is made for it", async () => {
        const env = await make({ maxDepth: 3 });
        const { pending, id, send } = await start(env);
        race.mkdirs = [];
        send(grant(id, 0, 1));
        send(chunk(id, 0, "a/b/c/d/x", "")); // four folders deep
        expect(await pending).toMatchObject({ ok: false, reason: "limit" });
        expect(race.mkdirs.filter((path) => path.includes(`.${id}.partial/`))).toEqual([]);
        expect(readdirSync(env.folderB)).toEqual([".bot"]);
      });

      it("2e. through the real source: a tree exactly at the folder cap arrives, one folder more is `limit` and leaves nothing", async () => {
        const env = await make({ maxDirs: 5 });
        for (const [root, n] of [["t5", 5], ["t6", 6]] as const) {
          for (let i = 0; i < n; i++) { mkdirSync(join(env.artifactsA, root, `d${i}`), { recursive: true }); writeFileSync(join(env.artifactsA, root, `d${i}`, "f.txt"), `f${i}`); }
        }
        const good = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("t5"), "x", MiB));
        expect(good.files).toBe(5);
        expect(listTree(join(env.folderB, good.dest)).filter((p) => p.endsWith("/"))).toHaveLength(5);
        expect(await env.requester.fetch("bot-b", env.ka.memberId, artifact("t6"), "x", MiB)).toMatchObject({ ok: false, reason: "limit" });
        expect(readdirSync(join(env.incoming(), env.srvDir()))).toEqual([good.fetchId]);
      });

      it("2f. through the real source: a tree exactly at the depth cap arrives, one folder deeper is `limit`", async () => {
        const env = await make({ maxDepth: 3 });
        deepTree(env, "ok3", 3);
        deepTree(env, "bad4", 4);
        const good = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("ok3"), "x", MiB));
        expect(readFileSync(join(env.folderB, good.dest, "f0", "f1", "f2", "leaf.txt"), "utf8")).toBe("leaf");
        expect(await env.requester.fetch("bot-b", env.ka.memberId, artifact("bad4"), "x", MiB)).toMatchObject({ ok: false, reason: "limit" });
        expect(readdirSync(join(env.incoming(), env.srvDir()))).toEqual([good.fetchId]);
      });

      it("2g. with the default caps: 64 folders deep arrives, 65 is `limit`", async () => {
        const env = await make();
        deepTree(env, "ok64", FETCH_MAX_DEPTH);
        deepTree(env, "bad65", FETCH_MAX_DEPTH + 1);
        ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("ok64"), "x", MiB));
        expect(await env.requester.fetch("bot-b", env.ka.memberId, artifact("bad65"), "x", MiB)).toMatchObject({ ok: false, reason: "limit" });
      });
    });

    describe("3. an audit row that cannot be written means the fetch is not ok and nothing is kept", () => {
      const rowCount = (env: Awaited<ReturnType<typeof setup>>) =>
        (env.readerB.prepare("SELECT COUNT(*) AS n FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0").get(`srv:${env.kb.memberId}`) as { n: number }).n;

      for (const how of ["reject", "throw"] as const) {
        it(`3a. the audit write ${how === "reject" ? "rejects" : "throws"}: corrupt, the files already placed are removed, no row`, async () => {
          const env = await make();
          writeFileSync(join(env.artifactsA, "r.txt"), "hello");
          env.failAudit(how);
          const result = await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.txt"), "x", MiB);
          expect(result).toMatchObject({ ok: false, reason: "corrupt" });
          if (!result.ok) expect(result.detail).toMatch(/audit/);
          expect(readdirSync(env.folderB)).toEqual([".bot"]);
          expect(noFiles(env.incoming())).toEqual([]);
          expect(existsSync(join(env.incoming(), env.srvDir()))).toBe(false);
          expect(rowCount(env)).toBe(0);
          // the requester is not stuck: with the store back, the same fetch is ok and has its row
          env.failAudit(null);
          const again = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.txt"), "x", MiB));
          expect(readFileSync(join(env.folderB, again.dest, "r.txt"), "utf8")).toBe("hello");
          expect(rowCount(env)).toBe(1);
        });
      }

      it("3b. onAudit (the notify after the row is written) throwing does not undo a fetch whose row is there", async () => {
        const env = await make({ onAudit: () => { throw new Error("feed gone"); } });
        writeFileSync(join(env.artifactsA, "r.txt"), "hello");
        const result = ok(await env.requester.fetch("bot-b", env.ka.memberId, artifact("r.txt"), "x", MiB));
        expect(readFileSync(join(env.folderB, result.dest, "r.txt"), "utf8")).toBe("hello");
        expect(rowCount(env)).toBe(1);
      });
    });
  });
});
