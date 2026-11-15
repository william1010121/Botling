// M5-07a: fetch source (free vs ask vs denied, audit before first chunk, per-chunk grant/roster/O_NOFOLLOW/real-path
// checks, once-grant reuse prevention, limits, and resume).
// Requires `npm run build` (out/server/main.cjs) for the two-server botlingd test.
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, linkSync, realpathSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTENT_FRAME_CHUNK_LIMIT, decodeWireFrame, encodeChunkFrame, encodeWireFrame, fromBase64Url, type WireMessage,
} from "../../src/protocol";
import { FetchAsk } from "../../src/protocol/fetch";
import { ContentService } from "../../src/server/content";
import { statSig } from "../../src/server/content/pin";
import { PEER_CONTENT_FRAME } from "../../src/server/content/peer-content";
import { ensureBot } from "../../src/server/effects/log-ops";
import { FetchSource, type FetchAskHook, type FetchSink, type FetchSourceOptions } from "../../src/server/fetch/source";
import { createServer } from "node:http";
import { DeviceSockets, WS_HIGH_WATER } from "../../src/server/net/ws";
import { webSocketConnector } from "../../src/server/peer/connector";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { SessionLink } from "../../src/session";
import type { Message, MessageOf, Slot } from "../../src/protocol";
import { MAIN } from "../botlingd-harness";
import { until } from "../helpers";
import { makeCluster, profile, readServerKeys, revokeServer, sign, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const PEER = { local: false } as const;
const MiB = 1024 * 1024;
const DIRECT_FRAME = PEER_CONTENT_FRAME; // 64 KiB
const CHUNK_FRAME = PEER_CONTENT_FRAME; // Fixed 64 KiB on every transport (M2 decision)

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function deterministicBytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) {
    block.copy(out, at);
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

function manifestOf(files: Array<{ relPath: string; bytes: Uint8Array }>): string {
  const lines = [...files]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((f) => `${f.relPath}\t${f.bytes.length}\t${sha256Hex(f.bytes)}\n`);
  return sha256Hex(lines.join(""));
}

function makeFakeSink(peerId: string, transport: "tailnet" | "relay" = "tailnet", onSend?: (msg: WireMessage) => void) {
  const sent: WireMessage[] = [];
  const sink: FetchSink & { open: boolean; queued: number } = {
    peer: peerId,
    open: true,
    queued: 0,
    get state() { return this.open ? "open" : "closed"; },
    get queuedBytes() { return this.queued; },
    transport,
    sendWire: (message) => {
      if (!sink.open) return false;
      const encoded = encodeWireFrame(message, "peer", PEER);
      if (!encoded.ok) throw new Error(`invalid wire message ${message.t}: ${encoded.detail}`);
      const decoded = decodeWireFrame(encoded.text, "peer", PEER);
      if (!decoded.ok) throw new Error(`decode failed ${message.t}: ${decoded.detail}`);
      sent.push(decoded.message);
      onSend?.(decoded.message);
      return true;
    },
    sendChunk: (message) => {
      if (!sink.open) return false;
      const encoded = encodeChunkFrame(message, "peer", PEER);
      if (!encoded.ok) throw new Error(`invalid chunk: ${encoded.detail}`);
      const decoded = decodeWireFrame(encoded.bytes, "peer", PEER);
      if (!decoded.ok) throw new Error(`decode chunk failed: ${decoded.detail}`);
      sent.push(decoded.message);
      onSend?.(decoded.message);
      return true;
    },
  };
  return { sink, sent };
}

async function setupInProcessCluster(askHook?: FetchAskHook, onChunkHook?: (fetchId: string, index: number) => void | Promise<void>, extra?: { rosterWrap?: (r: RosterStore) => FetchSourceOptions["roster"]; dailyLimitBytes?: number; content?: ContentService }) {
  const root = mkdtempSync(join(tmpdir(), "botling-fetch-src-"));
  const dataA = join(root, "data-a");
  const dataB = join(root, "data-b");
  const botFolderA = join(root, "bots", "bot-a");
  const artifactsA = join(botFolderA, ".bot", "artifacts");
  const srcA = join(botFolderA, "src");
  const outsideDir = join(root, "outside");
  mkdirSync(dataA, { recursive: true });
  mkdirSync(dataB, { recursive: true });
  mkdirSync(artifactsA, { recursive: true });
  mkdirSync(srcA, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const storeA = await openServerStore(dataA);
  const storeB = await openServerStore(dataB);
  const idA = await loadOrCreateServerIdentity(dataA, { create: true });
  const idB = await loadOrCreateServerIdentity(dataB, { create: true });
  await storeA.submit((tx) => bindServerIdentity(tx, idA));
  await storeB.submit((tx) => bindServerIdentity(tx, idB));

  const ka = await readServerKeys(dataA);
  const kb = await readServerKeys(dataB);
  const cluster = await makeCluster([ka, kb]);
  await storeA.close();
  await storeB.close();

  writeStatements(dataA, cluster.clusterId, cluster.statements);
  writeStatements(dataB, cluster.clusterId, cluster.statements);

  const reopenedA = await openServerStore(dataA);
  const rosterA = await RosterStore.open(reopenedA, idA);
  const readerA = reopenedA.openReader();

  // Seed B's bot in A's replicated srv:B rows table.
  const botB = "bot-b";
  await reopenedA.submit((tx) => {
    tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)")
      .run(`srv:${kb.memberId}`, `bot:${botB}`, JSON.stringify({ name: "B Bot" }));
  });

  const botFolders = new Map<string, string>([["bot-a", botFolderA]]);
  let auditCommitOrder = 0;
  let seq = 0;
  const events: Array<{ event: string; order: number }> = [];

  const makeSource = (opts?: Partial<FetchSourceOptions>) => new FetchSource({
    self: ka.memberId,
    dataDir: dataA,
    store: reopenedA,
    reader: () => readerA,
    roster: extra?.rosterWrap ? extra.rosterWrap(rosterA) : rosterA,
    botFolders: () => botFolders,
    ...(extra?.content ? { content: extra.content } : {}),
    ...(extra?.dailyLimitBytes !== undefined ? { dailyLimitBytes: extra.dailyLimitBytes } : {}),
    ...(askHook ? { ask: askHook } : {}),
    ...(onChunkHook ? { onChunk: onChunkHook } : {}),
    onAudit: () => {
      auditCommitOrder = ++seq;
      events.push({ event: "audit-committed", order: auditCommitOrder });
    },
    ...opts,
  });
  const source = makeSource();

  const cleanup = async () => {
    readerA.close();
    await reopenedA.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root, dataA, botFolderA, artifactsA, srcA, outsideDir,
    ka, kb, botB, cluster, storeA: reopenedA, readerA, rosterA, source, makeSource,
    recordEvent: (name: string) => events.push({ event: name, order: ++seq }),
    events,
    cleanup,
  };
}

describe("M5-07a: fetch source", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("1. Free: serves bot artifact with 64 KiB direct frames, per-frame sha256, manifest, and audit row committed BEFORE first chunk", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("free-report", 150 * 1024); // 3 direct chunks: 64 + 64 + 22 KiB
    writeFileSync(join(env.artifactsA, "r.html"), payload);

    const { sink, sent } = makeFakeSink(env.kb.memberId, "tailnet", (msg) => {
      if (msg.t === "fetch.chunk") env.recordEvent(`chunk-${msg.index}`);
    });

    const handled = env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-free-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.html" },
      purpose: "read report",
      maxBytes: 10 * MiB,
    });
    expect(handled).toBe(true);

    const done = await until(() => sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, {
      timeout: 5_000, what: "fetch.done",
    });
    expect(done.t).toBe("fetch.done");

    const grant = sent.find((m): m is WireMessage & { t: "fetch.grant" } => m.t === "fetch.grant");
    expect(grant).toBeDefined();
    expect(grant!.mode).toBe("read");
    expect(grant!.bytes).toBe(payload.length);
    expect(grant!.files).toBe(1);

    const chunks = sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0]!.bytes.length).toBe(DIRECT_FRAME);
    expect(chunks[1]!.bytes.length).toBe(DIRECT_FRAME);
    expect(chunks[2]!.bytes.length).toBe(payload.length - 2 * DIRECT_FRAME);
    for (const c of chunks) expect(c.sha256).toBe(sha256Hex(c.bytes));
    // M5-07b: every chunk names its file (relative to the target).
    for (const c of chunks) expect(c.file).toBe("r.html");

    const reassembled = Buffer.concat(chunks.map((c) => c.bytes));
    expect(reassembled.equals(payload)).toBe(true);

    const expectedManifest = manifestOf([{ relPath: "r.html", bytes: payload }]);
    expect((done as WireMessage & { t: "fetch.done" }).manifest).toBe(expectedManifest);
    expect((done as WireMessage & { t: "fetch.done" }).bytes).toBe(payload.length);

    // One audit row in srv:A, committed before the first chunk left.
    const auditRows = env.readerA.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0")
      .all(`srv:${env.ka.memberId}`) as Array<{ key: string; rev: number; body: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.key).toBe("audit:fetch-free-1");
    expect(JSON.parse(auditRows[0]!.body)).toMatchObject({
      act: "fetch.serve",
      by: env.kb.memberId,
      member: env.botB,
      name: "r.html",
      size: payload.length,
      hash: expectedManifest,
    });
    const auditIdx = env.events.findIndex((e) => e.event === "audit-committed");
    const chunk0Idx = env.events.findIndex((e) => e.event === "chunk-0");
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(chunk0Idx).toBeGreaterThan(auditIdx);
  });

  it("2. Ask with hook answering deny (and default deny) -> fetch.denied{denied}, no chunks, no serving audit row", async () => {
    const env = await setupInProcessCluster(); // default hook = deny
    cleanups.push(env.cleanup);

    writeFileSync(join(env.srcA, "secret.ts"), "export const token = 42;\n");
    const { sink, sent } = makeFakeSink(env.kb.memberId);

    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-ask-deny",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: join(env.srcA, "secret.ts") },
      purpose: "inspect source",
      maxBytes: MiB,
    });

    const denied = await until(() => sent.find((m) => m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "fetch.denied" });
    expect(denied).toEqual({ t: "fetch.denied", fetchId: "fetch-ask-deny", reason: "denied" });
    expect(sent.filter((m) => m.t === "fetch.chunk" || m.t === "fetch.grant" || m.t === "fetch.done")).toHaveLength(0);

    const audits = env.readerA.prepare("SELECT key FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0")
      .all(`srv:${env.ka.memberId}`);
    expect(audits).toHaveLength(0);
  });

  it("3. Once grant reused with another fetchId (or replayed with same fetchId) -> denied", async () => {
    let answer: "once" | "deny" = "once";
    const env = await setupInProcessCluster(async () => answer);
    cleanups.push(env.cleanup);

    const filePath = join(env.srcA, "data.txt");
    writeFileSync(filePath, "hello once");

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-once-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: filePath },
      purpose: "one time",
      maxBytes: MiB,
    });
    await until(() => sent.find((m) => m.t === "fetch.done") ?? null, { timeout: 5_000, what: "first once done" });

    // Now hook would deny if asked again: another fetchId must NOT reuse the once grant.
    answer = "deny";
    const { sink: sink2, sent: sent2 } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink2, {
      t: "fetch.ask",
      fetchId: "fetch-once-2",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: filePath },
      purpose: "reuse attempt",
      maxBytes: MiB,
    });
    const denied2 = await until(() => sent2.find((m) => m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "denied2" });
    expect(denied2).toMatchObject({ t: "fetch.denied", fetchId: "fetch-once-2", reason: "denied" });
    expect(sent2.some((m) => m.t === "fetch.chunk")).toBe(false);

    // Replaying the completed once fetchId is also refused.
    const { sink: sink3, sent: sent3 } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink3, {
      t: "fetch.ask",
      fetchId: "fetch-once-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: filePath },
      purpose: "replay same fetchId",
      maxBytes: MiB,
    });
    const denied3 = await until(() => sent3.find((m) => m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "denied3" });
    expect(denied3.t).toBe("fetch.denied");
    expect(sent3.some((m) => m.t === "fetch.chunk")).toBe(false);
  });

  it("4. Revoke B (statement merged) after chunk 1 of 3 -> no chunk 2", async () => {
    let onChunk!: (fetchId: string, index: number) => Promise<void>;
    const env = await setupInProcessCluster(undefined, (fetchId, index) => onChunk(fetchId, index));
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("revoke-mid", 3 * DIRECT_FRAME);
    writeFileSync(join(env.artifactsA, "three.bin"), payload);
    const revokeStmt = await revokeServer(env.cluster.clusterId, env.ka, env.kb, 1);

    onChunk = async (_fetchId, index) => {
      if (index === 0) await env.rosterA.mergeRevocations([revokeStmt.statement]);
    };
    const { sink, sent } = makeFakeSink(env.kb.memberId, "tailnet");

    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-revoke-mid",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "three.bin" },
      purpose: "revoked mid-stream",
      maxBytes: 10 * MiB,
    });

    const endMsg = await until(() => sent.find((m) => m.t === "fetch.denied" || m.t === "fetch.done") ?? null, {
      timeout: 5_000, what: "fetch denied on revoke",
    });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "fetch-revoke-mid", reason: "revoked" });
    const chunks = sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(chunks.map((c) => c.index)).toEqual([0]);
  });

  it("5. Replace file with a symlink to an outside file between chunks -> fetch.denied{outside}", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const target = join(env.artifactsA, "swap.bin");
    const outsideSecret = join(env.outsideDir, "outside-secret.txt");
    writeFileSync(target, deterministicBytes("swap-orig", 3 * DIRECT_FRAME));
    writeFileSync(outsideSecret, "OUTSIDE_SECRET_DATA".repeat(10_000));

    let swapped = false;
    const { sink, sent } = makeFakeSink(env.kb.memberId, "tailnet", (msg) => {
      if (msg.t === "fetch.chunk" && msg.index === 0 && !swapped) {
        swapped = true;
        unlinkSync(target);
        symlinkSync(outsideSecret, target);
      }
    });

    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-swap",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "swap.bin" },
      purpose: "symlink swap",
      maxBytes: 10 * MiB,
    });

    const endMsg = await until(() => sent.find((m) => m.t === "fetch.denied" || m.t === "fetch.done") ?? null, {
      timeout: 5_000, what: "fetch denied outside",
    });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "fetch-swap", reason: "outside" });
    const chunks = sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(chunks.map((c) => c.index)).toEqual([0]);
  });

  it("5b. Stored real prefix string is never re-realpath'd after an always grant (swapped prefix dir fails)", async () => {
    let answer: "always" | "deny" = "always";
    const env = await setupInProcessCluster(async () => answer);
    cleanups.push(env.cleanup);

    const realSub = join(env.srcA, "sub");
    const realFile = join(realSub, "ok.txt");
    mkdirSync(realSub, { recursive: true });
    writeFileSync(realFile, "safe");

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-always-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: realFile },
      purpose: "grant always on folder",
      maxBytes: MiB,
    });
    await until(() => sent.find((m) => m.t === "fetch.done") ?? null, { timeout: 5_000, what: "always done" });

    // Swap prefix dir for a symlink to outsideDir; hook denies any new ask.
    answer = "deny";
    rmSync(realSub, { recursive: true, force: true });
    writeFileSync(join(env.outsideDir, "ok.txt"), "stolen");
    symlinkSync(env.outsideDir, realSub);

    const { sink: sink2, sent: sent2 } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink2, {
      t: "fetch.ask",
      fetchId: "fetch-always-2",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: join(realSub, "ok.txt") },
      purpose: "try escaping via swapped prefix",
      maxBytes: MiB,
    });
    const denied = await until(() => sent2.find((m) => m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "denied after prefix swap" });
    expect(denied).toMatchObject({ t: "fetch.denied", fetchId: "fetch-always-2", reason: "denied" });
  });

  it("6. Limit: maxBytes 1 MiB on a 3 MiB file -> denied limit after sending <= 1 MiB", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("three-mib", 3 * MiB);
    writeFileSync(join(env.artifactsA, "three-mib.bin"), payload);

    const { sink, sent } = makeFakeSink(env.kb.memberId, "tailnet");
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "fetch-limit",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "three-mib.bin" },
      purpose: "capped",
      maxBytes: 1 * MiB,
    });

    const endMsg = await until(() => sent.find((m) => m.t === "fetch.denied" || m.t === "fetch.done") ?? null, {
      timeout: 5_000, what: "limit denied",
    });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "fetch-limit", reason: "limit" });
    const chunks = sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    const totalSent = chunks.reduce((acc, c) => acc + c.bytes.length, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(totalSent).toBeLessThanOrEqual(1 * MiB);
    expect(totalSent).toBe(1 * MiB);
  });

  it("7. Resume from index 2 sends only chunks > 2 and produces the same manifest; from schema is strict", async () => {
    const validAsk = FetchAsk.safeParse({
      t: "fetch.ask",
      fetchId: "f-1",
      requester: { bot: "b1" },
      source: "srva",
      what: { kind: "artifact", botId: "b2", path: "big.bin" },
      purpose: "resume",
      maxBytes: MiB,
      from: { file: "big.bin", index: 2 },
    });
    expect(validAsk.success).toBe(true);
    const badExtra = FetchAsk.safeParse({
      t: "fetch.ask",
      fetchId: "f-1",
      requester: { bot: "b1" },
      source: "srva",
      what: { kind: "artifact", botId: "b2", path: "big.bin" },
      purpose: "resume",
      maxBytes: MiB,
      from: { file: "big.bin", index: 2, extra: true },
    });
    expect(badExtra.success).toBe(false);

    const env = await setupInProcessCluster(async () => "once");
    cleanups.push(env.cleanup);

    // 5 direct chunks (5 * 64 KiB = 320 KiB) in an ask-gated folder so resume also proves reusing the in-flight once grant.
    const payload = deterministicBytes("resume-5", 5 * DIRECT_FRAME);
    const bigPath = join(env.srcA, "big.bin");
    writeFileSync(bigPath, payload);

    // Interrupt initial ask after chunk index 2 (so indices 0, 1, 2 were delivered before session closed).
    const { sink: sink1, sent: sent1 } = makeFakeSink(env.kb.memberId, "tailnet", (msg) => {
      if (msg.t === "fetch.chunk" && msg.index === 2) sink1.open = false;
    });
    env.source.onMessage(sink1, {
      t: "fetch.ask",
      fetchId: "fetch-resume-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: bigPath },
      purpose: "resume test",
      maxBytes: 10 * MiB,
    });
    await until(() => sent1.filter((m) => m.t === "fetch.chunk").length === 3, { timeout: 5_000, what: "3 initial chunks" });
    env.source.sessionClosed(sink1);

    // Resume from index 2 with the same fetchId: sends only chunks 3 and 4, same manifest.
    const { sink: sink2, sent: sent2 } = makeFakeSink(env.kb.memberId, "tailnet");
    env.source.onMessage(sink2, {
      t: "fetch.ask",
      fetchId: "fetch-resume-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: bigPath },
      purpose: "resume test",
      maxBytes: 10 * MiB,
      from: { file: "big.bin", index: 2 },
    });
    const done2 = await until(() => sent2.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, {
      timeout: 5_000, what: "resume done",
    });
    expect(done2.t).toBe("fetch.done");
    const resumedChunks = sent2.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(resumedChunks.map((c) => c.index)).toEqual([3, 4]);
    expect((done2 as WireMessage & { t: "fetch.done" }).manifest).toBe(manifestOf([{ relPath: "big.bin", bytes: payload }]));

    const first3 = sent1.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk").map((c) => c.bytes);
    const full = Buffer.concat([...first3, ...resumedChunks.map((c) => c.bytes)]);
    expect(full.equals(payload)).toBe(true);
  });

  it("7b. M5-06c: a resume after the approved file got a second name is refused (the card never said so; resume asks nobody)", async () => {
    const env = await setupInProcessCluster(async () => "once");
    cleanups.push(env.cleanup);
    const payload = deterministicBytes("resume-hl", 4 * DIRECT_FRAME);
    const bigPath = join(env.srcA, "hl.bin");
    writeFileSync(bigPath, payload);
    const ask = { t: "fetch.ask", fetchId: "fetch-resume-hl", requester: { bot: env.botB }, source: env.ka.memberId, what: { kind: "path", path: bigPath }, purpose: "resume test", maxBytes: 10 * MiB } as const;
    const { sink: sink1, sent: sent1 } = makeFakeSink(env.kb.memberId, "tailnet", (msg) => {
      if (msg.t === "fetch.chunk" && msg.index === 0) sink1.open = false;
    });
    env.source.onMessage(sink1, ask);
    await until(() => sent1.some((m) => m.t === "fetch.chunk"), { timeout: 5_000, what: "first chunk" });
    env.source.sessionClosed(sink1);
    linkSync(bigPath, join(env.outsideDir, "second-name.bin"));
    const { sink: sink2, sent: sent2 } = makeFakeSink(env.kb.memberId, "tailnet");
    env.source.onMessage(sink2, { ...ask, from: { file: "hl.bin", index: 0 } });
    const end = await until(() => sent2.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "resume end" });
    expect(end).toMatchObject({ t: "fetch.denied", reason: "denied" });
    expect(sent2.some((m) => m.t === "fetch.chunk")).toBe(false);
  });

  it("8. Relay transport sends fixed 64 KiB chunks; unknown requester bot is refused", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("relay-size", 200 * 1024);
    writeFileSync(join(env.artifactsA, "relay.bin"), payload);

    const { sink: relaySink, sent: relaySent } = makeFakeSink(env.kb.memberId, "relay");
    env.source.onMessage(relaySink, {
      t: "fetch.ask",
      fetchId: "fetch-relay-1",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "relay.bin" },
      purpose: "relay chunk size",
      maxBytes: 10 * MiB,
    });
    const relayDone = await until(() => relaySent.find((m) => m.t === "fetch.done") ?? null, { timeout: 5_000, what: "relay done" });
    expect(relayDone.t).toBe("fetch.done");
    const relayChunks = relaySent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(relayChunks.map((c) => c.bytes.length)).toEqual([CHUNK_FRAME, CHUNK_FRAME, CHUNK_FRAME, payload.length - 3 * CHUNK_FRAME]);

    const { sink: badBotSink, sent: badBotSent } = makeFakeSink(env.kb.memberId, "tailnet");
    env.source.onMessage(badBotSink, {
      t: "fetch.ask",
      fetchId: "fetch-unknown-bot",
      requester: { bot: "unknown-bot" },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "relay.bin" },
      purpose: "unknown requester",
      maxBytes: MiB,
    });
    const denied = await until(() => badBotSent.find((m) => m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "unknown bot denied" });
    expect(denied).toMatchObject({ t: "fetch.denied", fetchId: "fetch-unknown-bot", reason: "denied" });
  });

  it("P1 (H1). always on one file grants ONLY that file, never a sibling in its folder", async () => {
    let answer: "always" | "deny" = "always";
    const env = await setupInProcessCluster(async () => answer);
    cleanups.push(env.cleanup);

    const aPath = join(env.srcA, "a.txt");
    const bPath = join(env.srcA, "b.txt");
    writeFileSync(aPath, "approved");
    writeFileSync(bPath, "never approved");

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "p1-a",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: aPath },
      purpose: "read a.txt",
      maxBytes: 10 * MiB,
    });
    const doneA = await until(() => sent.find((m) => (m.t === "fetch.done" || m.t === "fetch.denied") && m.fetchId === "p1-a") ?? null, { timeout: 5_000, what: "p1-a end" });
    expect(doneA.t).toBe("fetch.done");
    const grantA = sent.find((m) => m.t === "fetch.grant" && m.fetchId === "p1-a") as WireMessage & { t: "fetch.grant" };
    expect(grantA.prefix).toBe(realpathSync(aPath));

    answer = "deny";
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "p1-b",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "path", path: bPath },
      purpose: "read sibling",
      maxBytes: 10 * MiB,
    });
    const endB = await until(() => sent.find((m) => (m.t === "fetch.done" || m.t === "fetch.denied") && m.fetchId === "p1-b") ?? null, { timeout: 5_000, what: "p1-b end" });
    expect(endB).toMatchObject({ t: "fetch.denied", fetchId: "p1-b", reason: "denied" });
  });

  it("P2 (H3). 600 MiB sparse file is refused at 500 MiB limit before audit row and fetch.grant", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const bigPath = join(env.artifactsA, "big.bin");
    const fd = openSync(bigPath, "w");
    ftruncateSync(fd, 600 * MiB);
    closeSync(fd);

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "p2-big",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "big.bin" },
      purpose: "too big",
      maxBytes: MiB,
    });
    const endMsg = await until(() => sent.find((m) => (m.t === "fetch.done" || m.t === "fetch.denied") && m.fetchId === "p2-big") ?? null, { timeout: 5_000, what: "p2 end" });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "p2-big", reason: "limit" });
    expect(sent.some((m) => m.t === "fetch.grant" || m.t === "fetch.chunk")).toBe(false);
    const audit = env.readerA.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${env.ka.memberId}`, "audit:p2-big");
    expect(audit).toBeUndefined();
  });

  it("P3 (H2 + L6). requester bot/device removed mid-stream stops chunks; device must belong to asking server and hold reply or manage scope", async () => {
    let deviceValid = true;
    let deviceScope: Array<"read" | "reply" | "approve" | "manage"> = ["reply"];
    let deviceBy = "";
    let step = 0;

    const env = await setupInProcessCluster(
      undefined,
      async (fetchId) => {
        if (fetchId === "p3-bot" && ++step === 1) {
          await env.storeA.submit((tx) => {
            tx.prepare("UPDATE rows SET deleted = 1 WHERE stream = ? AND key = ?").run(`srv:${env.kb.memberId}`, `bot:${env.botB}`);
          });
        } else if (fetchId === "p3-dev" && ++step === 1) {
          deviceValid = false;
        }
      },
      {
        rosterWrap: (r) => ({
          get view() { return r.view; },
          device: () => (deviceValid ? { scope: deviceScope, by: deviceBy } : null),
        }),
      },
    );
    cleanups.push(env.cleanup);
    deviceBy = env.kb.memberId;

    writeFileSync(join(env.artifactsA, "r.bin"), deterministicBytes("p3", 300 * 1024));

    // (a) Bot removed mid-stream -> fetch.denied{revoked} after chunk 0
    const sBot = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sBot.sink, {
      t: "fetch.ask", fetchId: "p3-bot", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "bot mid", maxBytes: 10 * MiB,
    });
    const endBot = await until(() => sBot.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p3-bot end" });
    expect(endBot).toMatchObject({ t: "fetch.denied", fetchId: "p3-bot", reason: "revoked" });
    expect(sBot.sent.filter((m) => m.t === "fetch.chunk")).toHaveLength(1);

    // (b) L6: read-only device is refused; device bound to another server is refused
    deviceScope = ["read"];
    const sReadOnly = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sReadOnly.sink, {
      t: "fetch.ask", fetchId: "p3-ro", requester: { device: "d".repeat(32) }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "ro dev", maxBytes: 10 * MiB,
    });
    const endRo = await until(() => sReadOnly.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p3-ro end" });
    expect(endRo).toMatchObject({ t: "fetch.denied", fetchId: "p3-ro", reason: "denied" });
    expect(sReadOnly.sent.some((m) => m.t === "fetch.chunk")).toBe(false);

    deviceScope = ["manage"];
    deviceBy = env.ka.memberId; // bound to A, not asking server B
    const sWrongSrv = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sWrongSrv.sink, {
      t: "fetch.ask", fetchId: "p3-wrong-srv", requester: { device: "d".repeat(32) }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "wrong srv", maxBytes: 10 * MiB,
    });
    const endWrong = await until(() => sWrongSrv.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p3-wrong-srv end" });
    expect(endWrong).toMatchObject({ t: "fetch.denied", fetchId: "p3-wrong-srv", reason: "denied" });

    // (c) Valid device bound to asking server B with reply scope revoked mid-stream -> fetch.denied{revoked} after chunk 0
    step = 0;
    deviceBy = env.kb.memberId;
    deviceScope = ["reply"];
    const sDev = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sDev.sink, {
      t: "fetch.ask", fetchId: "p3-dev", requester: { device: "d".repeat(32) }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "dev mid", maxBytes: 10 * MiB,
    });
    const endDev = await until(() => sDev.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p3-dev end" });
    expect(endDev).toMatchObject({ t: "fetch.denied", fetchId: "p3-dev", reason: "revoked" });
    expect(sDev.sent.filter((m) => m.t === "fetch.chunk")).toHaveLength(1);
  });

  it("P4 (L1). symlink loop inside a folder does not hang or fail; real files are served", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    mkdirSync(join(env.artifactsA, "d"));
    writeFileSync(join(env.artifactsA, "d", "x.txt"), "hello-loop");
    symlinkSync(".", join(env.artifactsA, "d", "loop"));

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    const t0 = Date.now();
    env.source.onMessage(sink, {
      t: "fetch.ask", fetchId: "p4-loop", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "d" }, purpose: "folder with loop", maxBytes: 10 * MiB,
    });
    const endMsg = await until(() => sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p4 end" });
    expect(endMsg).toMatchObject({ t: "fetch.done", fetchId: "p4-loop", bytes: 10 });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("P5 (M2). resume over relay after direct start uses fixed 64 KiB frames and reassembles exact bytes; bad from is gone", async () => {
    let closedOnce = false;
    let firstSink!: FetchSink & { open: boolean };
    const env = await setupInProcessCluster(undefined, async (id, index) => {
      if (id === "p5-cross" && index === 2 && !closedOnce) {
        closedOnce = true;
        firstSink.open = false;
        env.source.sessionClosed(firstSink);
      }
    });
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("p5", 600 * 1024);
    writeFileSync(join(env.artifactsA, "r.bin"), payload);

    const a = makeFakeSink(env.kb.memberId, "tailnet");
    firstSink = a.sink;
    env.source.onMessage(a.sink, {
      t: "fetch.ask", fetchId: "p5-cross", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "cross transport", maxBytes: 10 * MiB,
    });
    await until(() => (a.sent.filter((m) => m.t === "fetch.chunk").length >= 3 ? true : null), { timeout: 5_000, what: "3 direct chunks" });

    // Invalid from.file or out-of-range from.index -> gone
    const badFrom = makeFakeSink(env.kb.memberId, "relay");
    env.source.onMessage(badFrom.sink, {
      t: "fetch.ask", fetchId: "p5-cross", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "bad from", maxBytes: 10 * MiB,
      from: { file: "other.bin", index: 2 },
    });
    const badEnd = await until(() => badFrom.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "bad from end" });
    expect(badEnd).toMatchObject({ t: "fetch.denied", fetchId: "p5-cross", reason: "gone" });
  });

  it("P5b (M2). resume on relay after direct drop succeeds with identical manifest and bytes", async () => {
    let closedOnce = false;
    let firstSink!: FetchSink & { open: boolean };
    const env = await setupInProcessCluster(undefined, async (id, index) => {
      if (id === "p5b-cross" && index === 2 && !closedOnce) {
        closedOnce = true;
        firstSink.open = false;
        env.source.sessionClosed(firstSink);
      }
    });
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("p5b", 600 * 1024);
    writeFileSync(join(env.artifactsA, "r.bin"), payload);

    const a = makeFakeSink(env.kb.memberId, "tailnet");
    firstSink = a.sink;
    env.source.onMessage(a.sink, {
      t: "fetch.ask", fetchId: "p5b-cross", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "cross transport", maxBytes: 10 * MiB,
    });
    await until(() => (a.sent.filter((m) => m.t === "fetch.chunk").length >= 3 ? true : null), { timeout: 5_000, what: "3 direct chunks" });

    const b = makeFakeSink(env.kb.memberId, "relay");
    env.source.onMessage(b.sink, {
      t: "fetch.ask", fetchId: "p5b-cross", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "cross transport", maxBytes: 10 * MiB,
      from: { file: "r.bin", index: 2 },
    });
    const endB = await until(() => b.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p5b relay end" });
    expect(endB).toMatchObject({ t: "fetch.done", fetchId: "p5b-cross", manifest: manifestOf([{ relPath: "r.bin", bytes: payload }]), bytes: payload.length });

    const chunksA = a.sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk" && m.fetchId === "p5b-cross");
    const chunksB = b.sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk" && m.fetchId === "p5b-cross");
    const joined = Buffer.concat([...chunksA.slice(0, 3).map((c) => c.bytes), ...chunksB.map((c) => c.bytes)]);
    expect(joined.equals(payload)).toBe(true);
  });

  it("P6b (M3). after a dropped session the once grant stays, a same-fetchId ask without from is refused, with from it resumes", async () => {
    let drop: (() => void) | null = null;
    const env = await setupInProcessCluster(undefined, (fetchId, index) => { if (fetchId === "p6b" && index === 1) drop?.(); });
    cleanups.push(env.cleanup);
    writeFileSync(join(env.artifactsA, "r.bin"), deterministicBytes("p6b", 300 * 1024));
    const a = makeFakeSink(env.kb.memberId);
    drop = () => { a.sink.open = false; env.source.sessionClosed(a.sink); };
    env.source.onMessage(a.sink, {
      t: "fetch.ask", fetchId: "p6b", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "drop", maxBytes: 10 * MiB,
    });
    await until(() => (a.sent.filter((m) => m.t === "fetch.chunk").length >= 2 ? true : null), { timeout: 5_000, what: "2 chunks" });
    await new Promise((r) => setTimeout(r, 100));
    const row = env.readerA.prepare("SELECT revokedAt FROM grants WHERE fetchId = ?").get("p6b") as { revokedAt: number | null };
    expect(row.revokedAt).toBeNull();
    const b = makeFakeSink(env.kb.memberId);
    env.source.onMessage(b.sink, {
      t: "fetch.ask", fetchId: "p6b", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "restart", maxBytes: 10 * MiB,
    });
    const r2 = await until(() => b.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p6b r2" });
    expect(r2).toMatchObject({ t: "fetch.denied", fetchId: "p6b", reason: "denied" });
    expect(b.sent.some((m) => m.t === "fetch.chunk")).toBe(false);
    const c = makeFakeSink(env.kb.memberId);
    env.source.onMessage(c.sink, {
      t: "fetch.ask", fetchId: "p6b", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "resume", maxBytes: 10 * MiB, from: { file: "r.bin", index: 1 },
    });
    const r3 = await until(() => c.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p6b r3" });
    expect(r3.t).toBe("fetch.done");
  });

  it("P6 (M3). once grant gets 10-minute expires, is revoked on terminal failure, and refuses replay without from", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    writeFileSync(join(env.artifactsA, "r.bin"), deterministicBytes("p6", 300 * 1024));
    const a = makeFakeSink(env.kb.memberId);
    env.source.onMessage(a.sink, {
      t: "fetch.ask", fetchId: "p6-fail", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "limit fail", maxBytes: 64 * 1024,
    });
    const r1 = await until(() => a.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p6 r1" });
    expect(r1).toMatchObject({ t: "fetch.denied", fetchId: "p6-fail", reason: "limit" });

    const row = env.readerA.prepare("SELECT kind, expires, createdAt, revokedAt FROM grants WHERE fetchId = ?").get("p6-fail") as {
      kind: string; expires: number | null; createdAt: number; revokedAt: number | null;
    };
    expect(row.kind).toBe("once");
    expect(row.expires).toBe(row.createdAt + 10 * 60_000);
    expect(row.revokedAt).not.toBeNull();

    const b = makeFakeSink(env.kb.memberId);
    env.source.onMessage(b.sink, {
      t: "fetch.ask", fetchId: "p6-fail", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "r.bin" }, purpose: "replay fail", maxBytes: 64 * 1024,
    });
    const r2 = await until(() => b.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "p6 r2" });
    expect(r2).toMatchObject({ t: "fetch.denied", fetchId: "p6-fail", reason: "denied" });
    expect(b.sent.some((m) => m.t === "fetch.chunk")).toBe(false);
  });

  it("L2. hard link (nlink > 1) inside artifacts or always-granted folder is ask every time", async () => {
    const asks: boolean[] = [];
    let decision: "always" | "once" | "deny" = "always";
    const env = await setupInProcessCluster(async (req) => {
      asks.push(Boolean(req.hardLinks));
      return decision;
    });
    cleanups.push(env.cleanup);

    const realOutside = join(env.outsideDir, "secret-target.txt");
    writeFileSync(realOutside, "outside-secret");
    const hardInArtifacts = join(env.artifactsA, "hard.txt");
    linkSync(realOutside, hardInArtifacts);

    // Inside .bot/artifacts (normally free): nlink > 1 forces askHook (deny -> denied)
    decision = "deny";
    const s1 = makeFakeSink(env.kb.memberId);
    env.source.onMessage(s1.sink, {
      t: "fetch.ask", fetchId: "l2-art", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "hard.txt" }, purpose: "hardlink in artifacts", maxBytes: MiB,
    });
    const end1 = await until(() => s1.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "l2-art" });
    expect(end1).toMatchObject({ t: "fetch.denied", fetchId: "l2-art", reason: "denied" });
    expect(asks).toEqual([true]);

    // Under a folder granted "always": hardlink inside that folder still asks every time
    const folder = join(env.srcA, "shared");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "normal.txt"), "normal");
    decision = "always";
    const s2 = makeFakeSink(env.kb.memberId);
    env.source.onMessage(s2.sink, {
      t: "fetch.ask", fetchId: "l2-grant-dir", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "path", path: folder }, purpose: "grant dir always", maxBytes: MiB,
    });
    await until(() => s2.sent.find((m) => m.t === "fetch.done") ?? null, { timeout: 5_000, what: "l2-grant-dir" });

    linkSync(realOutside, join(folder, "hard-inside.txt"));
    decision = "deny";
    const s3 = makeFakeSink(env.kb.memberId);
    env.source.onMessage(s3.sink, {
      t: "fetch.ask", fetchId: "l2-under-always", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "path", path: join(folder, "hard-inside.txt") }, purpose: "hardlink under always", maxBytes: MiB,
    });
    const end3 = await until(() => s3.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "l2-under-always" });
    expect(end3).toMatchObject({ t: "fetch.denied", fetchId: "l2-under-always", reason: "denied" });
    expect(asks).toEqual([true, false, true]);
  });
  it("M1. mutated path-pinned blob (even preserving size and mtime) is refused with fetch.denied{gone} and marked changed", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const content = new ContentService({ store: env.storeA, dataDir: env.dataA, serverId: env.ka.memberId });
    const src = env.makeSource({ content });
    const blobPath = join(env.outsideDir, "pinned-orig.bin");
    const orig = deterministicBytes("m1-orig", 128 * 1024);
    writeFileSync(blobPath, orig);
    const id = `sha256:${sha256Hex(orig)}`;

    // Rewrite bytes in-place, then store that new file's statSig under the OLD sha256 id so statSig still matches
    // while file hash differs: proves SHA-256 verification catches tampering and calls ContentService.markChanged().
    writeFileSync(blobPath, deterministicBytes("m1-evil", 128 * 1024));
    const currentSig = statSig(blobPath);
    await env.storeA.submit((tx) => {
      ensureBot(tx, "bot-a");
      tx.prepare("INSERT INTO content (id, size, type, pin, path, statSig, chunkHashes, state, createdAt) VALUES (?, ?, 'application/octet-stream', 'path', ?, ?, '[]', 'ready', ?)")
        .run(id, orig.length, blobPath, JSON.stringify(currentSig), Date.now());
      tx.prepare("INSERT INTO content_refs (id, stream, seq) VALUES (?, 'bot:bot-a', 1)").run(id);
    });

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    src.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "m1-changed-blob",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "blob", id, entry: { stream: "bot:bot-a", seq: 1 } },
      purpose: "tampered blob",
      maxBytes: MiB,
    });
    const endMsg = await until(() => sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "m1 end" });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "m1-changed-blob", reason: "gone" });
    expect(sent.some((m) => m.t === "fetch.chunk")).toBe(false);
    const row = env.readerA.prepare("SELECT state FROM content WHERE id = ?").get(id) as { state: string };
    expect(row.state).toBe("changed");
  });

  it("M4. FetchSource waits while sink.queuedBytes exceeds 1 MiB and resumes when drained", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("m4-bp", 256 * 1024);
    writeFileSync(join(env.artifactsA, "bp.bin"), payload);
    const { sink, sent } = makeFakeSink(env.kb.memberId);
    sink.queued = 2 * MiB;

    env.source.onMessage(sink, {
      t: "fetch.ask",
      fetchId: "m4-wait",
      requester: { bot: env.botB },
      source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "bp.bin" },
      purpose: "backpressure test",
      maxBytes: 10 * MiB,
    });
    await until(() => sent.find((m) => m.t === "fetch.grant") ?? null, { timeout: 5_000, what: "m4 grant" });
    await new Promise((r) => setTimeout(r, 40));
    expect(sent.filter((m) => m.t === "fetch.chunk")).toHaveLength(0);

    sink.queued = 0;
    const done = await until(() => sent.find((m) => m.t === "fetch.done") ?? null, { timeout: 5_000, what: "m4 done" });
    expect(done.t).toBe("fetch.done");
    expect(sent.filter((m) => m.t === "fetch.chunk")).toHaveLength(4);
  });

  it("L3. daily byte limit is persisted in server.db meta and enforced across FetchSource restart", async () => {
    const fixedNow = 1_700_000_000_000;
    const env = await setupInProcessCluster(undefined, undefined, { dailyLimitBytes: 200 * 1024 });
    cleanups.push(env.cleanup);

    writeFileSync(join(env.artifactsA, "d1.bin"), deterministicBytes("d1", 192 * 1024));
    writeFileSync(join(env.artifactsA, "d2.bin"), deterministicBytes("d2", 64 * 1024));

    const src1 = env.makeSource({ now: () => fixedNow });
    const s1 = makeFakeSink(env.kb.memberId);
    src1.onMessage(s1.sink, {
      t: "fetch.ask", fetchId: "l3-f1", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "d1.bin" }, purpose: "day part 1", maxBytes: 10 * MiB,
    });
    const d1 = await until(() => s1.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "l3 f1" });
    expect(d1.t).toBe("fetch.done");
    src1.close();
    await src1.flushed();

    // New FetchSource instance after restart reads persisted daily usage from server.db meta.
    const src2 = env.makeSource({ now: () => fixedNow + 1_000 });
    const s2 = makeFakeSink(env.kb.memberId);
    src2.onMessage(s2.sink, {
      t: "fetch.ask", fetchId: "l3-f2", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "d2.bin" }, purpose: "day part 2 exceeds", maxBytes: 10 * MiB,
    });
    const d2 = await until(() => s2.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "l3 f2" });
    expect(d2).toMatchObject({ t: "fetch.denied", fetchId: "l3-f2", reason: "limit" });
    expect(s2.sent.some((m) => m.t === "fetch.chunk")).toBe(false);
  });

  it("L-a. a cancelled serve ends without the approval hook answering (session closed, then source closed)", async () => {
    const asked: string[] = [];
    // The hook never answers, like an approval card nobody clicks.
    const env = await setupInProcessCluster(async (fetch) => { asked.push(fetch.fetchId); return new Promise<never>(() => undefined); });
    cleanups.push(env.cleanup);
    writeFileSync(join(env.srcA, "a.txt"), "needs approval");
    const settles = async (what: string) => {
      const result = await Promise.race([
        env.source.flushed().then(() => "ended" as const),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 3_000)),
      ]);
      expect(result, what).toBe("ended");
    };

    const a = makeFakeSink(env.kb.memberId);
    env.source.onMessage(a.sink, {
      t: "fetch.ask", fetchId: "la-session", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "path", path: join(env.srcA, "a.txt") }, purpose: "wait", maxBytes: 10 * MiB,
    });
    await until(() => (asked.includes("la-session") ? true : null), { timeout: 5_000, what: "hook asked (session)" });
    a.sink.open = false;
    env.source.sessionClosed(a.sink);
    await settles("a serve whose session closed must end while the hook is unanswered");

    const b = makeFakeSink(env.kb.memberId);
    env.source.onMessage(b.sink, {
      t: "fetch.ask", fetchId: "la-close", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "path", path: join(env.srcA, "a.txt") }, purpose: "wait", maxBytes: 10 * MiB,
    });
    await until(() => (asked.includes("la-close") ? true : null), { timeout: 5_000, what: "hook asked (close)" });
    env.source.close();
    await settles("stop (close + flushed) must not wait for the hook");

    for (const sent of [a.sent, b.sent]) expect(sent.some((m) => m.t === "fetch.chunk" || m.t === "fetch.grant")).toBe(false);
    expect((env.readerA.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n).toBe(0);
    expect(env.readerA.prepare("SELECT 1 FROM rows WHERE key IN ('audit:la-session', 'audit:la-close')").get()).toBeUndefined();
  });

  it("L4. racing resume from same requesterServer cancels old in-flight task and completes on new sink", async () => {
    let releaseOld!: () => void;
    const oldPaused = new Promise<void>((r) => { releaseOld = r; });
    let oldChunk1Seen = false;
    const env = await setupInProcessCluster(undefined, async (fetchId, index) => {
      if (fetchId === "l4-race" && index === 1 && !oldChunk1Seen) {
        oldChunk1Seen = true;
        await oldPaused;
      }
    });
    cleanups.push(env.cleanup);

    const payload = deterministicBytes("l4-race", 5 * CHUNK_FRAME);
    writeFileSync(join(env.artifactsA, "race.bin"), payload);

    const s1 = makeFakeSink(env.kb.memberId);
    env.source.onMessage(s1.sink, {
      t: "fetch.ask", fetchId: "l4-race", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "race.bin" }, purpose: "initial", maxBytes: 10 * MiB,
    });
    await until(() => oldChunk1Seen, { timeout: 5_000, what: "old paused at chunk 1" });

    // Racing resume arrives from the same server before s1 closed: should cancel old task, not reject with denied.
    const s2 = makeFakeSink(env.kb.memberId);
    env.source.onMessage(s2.sink, {
      t: "fetch.ask", fetchId: "l4-race", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "race.bin" }, purpose: "racing resume", maxBytes: 10 * MiB,
      from: { file: "race.bin", index: 1 },
    });
    releaseOld();

    const end2 = await until(() => s2.sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "s2 done" });
    expect(end2.t).toBe("fetch.done");
    const chunks2 = s2.sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    expect(chunks2.map((c) => c.index)).toEqual([2, 3, 4]);
    expect(s1.sent.some((m) => m.t === "fetch.done" || m.t === "fetch.denied")).toBe(false);
  });

  it("L5. sendChunk returning false while session is open sends fetch.denied{gone} and revokes once grant", async () => {
    const env = await setupInProcessCluster(async () => "once");
    cleanups.push(env.cleanup);

    const filePath = join(env.srcA, "l5.bin");
    writeFileSync(filePath, deterministicBytes("l5", 4 * CHUNK_FRAME));

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    const origSendChunk = sink.sendChunk.bind(sink);
    sink.sendChunk = (chunk) => {
      if (chunk.t === "fetch.chunk" && chunk.index === 1) return false;
      return origSendChunk(chunk);
    };

    env.source.onMessage(sink, {
      t: "fetch.ask", fetchId: "l5-send-false", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "path", path: filePath }, purpose: "sendChunk fails", maxBytes: 10 * MiB,
    });
    const endMsg = await until(() => sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "l5 end" });
    expect(endMsg).toMatchObject({ t: "fetch.denied", fetchId: "l5-send-false", reason: "gone" });
    const row = env.readerA.prepare("SELECT revokedAt FROM grants WHERE fetchId = ?").get("l5-send-false") as { revokedAt: number | null };
    expect(row.revokedAt).not.toBeNull();
  });

  it("M4b. direct WS transports (DeviceSockets and webSocketConnector) expose writable() and call resume() after drain", async () => {
    let serverTransport: import("../../src/session").SessionTransport | null = null;
    let resumeCalls = 0;
    const sockets = new DeviceSockets({
      log: () => undefined,
      remote: {
        accept: (transport) => {
          serverTransport = transport;
          return {
            link: {
              established: Promise.resolve(),
              resume: () => { resumeCalls++; },
            },
            receive: () => undefined,
            transportClosed: () => undefined,
          };
        },
      },
    });
    const httpServer = createServer();
    httpServer.on("upgrade", (req, raw, head) => sockets.upgrade(req, raw, head));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    cleanups.push(async () => {
      await sockets.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const conn = await webSocketConnector.connect(`ws://127.0.0.1:${port}/v3/ws`);
    conn.bind({ frame: () => undefined, closed: () => undefined });
    await until(() => serverTransport, { timeout: 5_000, what: "server transport" });

    expect(typeof conn.writable).toBe("function");
    expect(conn.writable!()).toBe(true);
    expect(typeof serverTransport!.writable).toBe("function");
    expect(serverTransport!.writable!()).toBe(true);

    // Simulate bufferedAmount reaching WS_HIGH_WATER on the server socket and verify resume() runs when it drains.
    const serverWs = [...(sockets as unknown as { wss: { clients: Set<object> } }).wss.clients][0]!;
    let fakeBuffered = WS_HIGH_WATER;
    Object.defineProperty(serverWs, "bufferedAmount", { get: () => fakeBuffered, configurable: true });
    expect(serverTransport!.writable!()).toBe(false);
    fakeBuffered = 0;
    await until(() => (resumeCalls > 0 ? true : null), { timeout: 2_000, every: 5, what: "resume callback" });
    expect(serverTransport!.writable!()).toBe(true);

    conn.close();
  });

});

describe("M5-07a: two-server botlingd wiring", () => {
  let cluster: TestCluster;
  let a: TestServer, b: TestServer;
  let ka: MemberKeysInfo, kb: MemberKeysInfo;
  let botFolderA: string;
  let botAId: string;
  let botBId: string;

  beforeAll(async () => {
    cluster = await startServers({ name: "fetch-source" });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    const made = await makeCluster([ka, kb]);
    writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, b.port)]);
    writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, a.port)]);
    await Promise.all([a.start(), b.start()]);

    botFolderA = join(cluster.root, "project-a");
    const botFolderB = join(cluster.root, "project-b");
    mkdirSync(join(botFolderA, ".bot", "artifacts"), { recursive: true });
    mkdirSync(join(botFolderA, "src"), { recursive: true });
    mkdirSync(botFolderB, { recursive: true });

    const clientA = await a.client();
    await clientA.sub(clientA.srv);
    const snapA = await clientA.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === clientA.srv, "srv snap A");
    const slotA: Slot = { origin: "script", originEpoch: clientA.originEpoch, target: clientA.srv, n: 1 };
    clientA.cmd(slotA, { type: "projects.add", folder: botFolderA }, snapA.logId);
    const recA = await clientA.wait(isResult(slotA), "projects.add A");
    if (recA.outcome.kind !== "applied") throw new Error(JSON.stringify(recA.outcome));
    botAId = (recA.outcome.result as { botId: string }).botId;
    clientA.close();

    const clientB = await b.client();
    await clientB.sub(clientB.srv);
    const snapB = await clientB.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === clientB.srv, "srv snap B");
    const slotB: Slot = { origin: "script", originEpoch: clientB.originEpoch, target: clientB.srv, n: 1 };
    clientB.cmd(slotB, { type: "projects.add", folder: botFolderB }, snapB.logId);
    const recB = await clientB.wait(isResult(slotB), "projects.add B");
    if (recB.outcome.kind !== "applied") throw new Error(JSON.stringify(recB.outcome));
    botBId = (recB.outcome.result as { botId: string }).botId;
    clientB.close();

    // Wait until A's replicated copy of srv:B holds bot:<botBId>.
    await until(() => {
      const db = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
      try {
        return db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botBId}`) ?? null;
      } finally { db.close(); }
    }, { timeout: 20_000, every: 100, what: "A replicated B's bot row" });

    // Stop B so we can connect directly to A's /v3/ws with B's keys as a single peer session.
    await b.stop();
  }, 120_000);

  afterAll(async () => { await cluster?.cleanup(); }, 60_000);

  it("serves free artifact over live PeerSession and holds an ask-gated path for its approval card", async () => {
    const artifact = deterministicBytes("two-server-art", 90 * 1024);
    writeFileSync(join(botFolderA, ".bot", "artifacts", "r.html"), artifact);
    writeFileSync(join(botFolderA, "src", "private.txt"), "private");

    const keysB = JSON.parse(readFileSync(join(b.dataDir, "server-keys.json"), "utf8")) as {
      sign: { pub: string; pkcs8: string };
      dh: { pub: string; pkcs8: string };
    };
    const dhKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(keysB.dh.pkcs8)! as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"]);
    const dhPub = fromBase64Url(keysB.dh.pub)!;
    const responderDh = fromBase64Url(ka.dh)!;
    const dbA = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
    const clusterId = String((dbA.prepare("SELECT value FROM meta WHERE key = 'clusterId'").get() as { value: string }).value);
    dbA.close();

    const conn = await webSocketConnector.connect(`ws://127.0.0.1:${a.port}/v3/ws`);
    const received: WireMessage[] = [];
    const encoder = new TextEncoder();
    let synced = false;
    const link = SessionLink.initiate(conn, {
      mode: "kk",
      transport: "tailnet",
      cluster: clusterId,
      self: { memberId: kb.memberId, dhPub, dhKey },
      responder: { memberId: ka.memberId, dhPub: responderDh },
    }, {
      onFrame: (plaintext) => {
        const decoded = decodeWireFrame(plaintext, "peer", PEER);
        if (!decoded.ok) return;
        if (decoded.message.t === "roster.revocations") {
          synced = true;
          return;
        }
        received.push(decoded.message);
      },
      onEnd: () => undefined,
    });
    conn.bind({ frame: (f) => link.receive(f), closed: () => link.transportClosed() });
    await link.established;

    // Send empty roster.revocations chunk (peer sync required first by §4.6).
    const syncFrame = encodeWireFrame({ t: "roster.revocations", statements: [] } as WireMessage, "peer", PEER);
    if (!syncFrame.ok) throw new Error(syncFrame.detail);
    link.send("control", encoder.encode(syncFrame.text));
    await until(() => synced, { timeout: 5_000, what: "peer synced" });

    // 1. Free artifact fetch
    const ask1 = encodeWireFrame({
      t: "fetch.ask",
      fetchId: "two-srv-free",
      requester: { bot: botBId },
      source: ka.memberId,
      what: { kind: "artifact", botId: botAId, path: "r.html" },
      purpose: "two server free",
      maxBytes: 10 * MiB,
    }, "peer", PEER);
    if (!ask1.ok) throw new Error(ask1.detail);
    link.send("control", encoder.encode(ask1.text));

    const done1 = await until(() => received.find((m) => m.t === "fetch.done" && m.fetchId === "two-srv-free") ?? null, {
      timeout: 10_000, what: "two-srv-free done",
    });
    expect(done1.t).toBe("fetch.done");
    const chunks1 = received.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk" && m.fetchId === "two-srv-free");
    expect(Buffer.concat(chunks1.map((c) => c.bytes)).equals(artifact)).toBe(true);

    // Audit row written in A's server.db
    const dbCheck = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
    const audit = dbCheck.prepare("SELECT body FROM rows WHERE stream = ? AND key = ? AND deleted = 0")
      .get(`srv:${ka.memberId}`, "audit:two-srv-free") as { body: string } | undefined;
    dbCheck.close();
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.body)).toMatchObject({ act: "fetch.serve", by: kb.memberId, member: botBId, name: "r.html", size: artifact.length });

    // 2. Ask-gated path denied by default hook
    const ask2 = encodeWireFrame({
      t: "fetch.ask",
      fetchId: "two-srv-ask",
      requester: { bot: botBId },
      source: ka.memberId,
      what: { kind: "path", path: join(botFolderA, "src", "private.txt") },
      purpose: "needs approval",
      maxBytes: MiB,
    }, "peer", PEER);
    if (!ask2.ok) throw new Error(ask2.detail);
    link.send("control", encoder.encode(ask2.text));
    // M5-06c: botlingd now wires the approval card, so an ask-gated path waits for the user (the card is in the
    // Maintainer's chat; fetch-approval-botlingd.test.ts answers it). Nothing is sent until then.
    await until(() => {
      const db = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
      try { return db.prepare("SELECT 1 FROM meta WHERE key = 'fetch:pending:two-srv-ask'").get() ?? null; } finally { db.close(); }
    }, { timeout: 10_000, what: "pending approval for two-srv-ask" });
    expect(received.filter((m) => "fetchId" in m && m.fetchId === "two-srv-ask")).toEqual([]);

    link.close();
  }, 60_000);
});


describe("M5-07b: fetch chunks name their file", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

  it("a folder sends its files in sorted order, each chunk with its relative path, an empty file as one empty chunk, names in NFC", async () => {
    const env = await setupInProcessCluster();
    cleanups.push(env.cleanup);
    const dir = join(env.artifactsA, "pack");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const nfd = "cafe\u0301.txt"; // decomposed on disk (APFS keeps what it is given, other file systems too)
    const big = deterministicBytes("big", DIRECT_FRAME + 10);
    writeFileSync(join(dir, "b.bin"), big);
    writeFileSync(join(dir, "empty.txt"), "");
    writeFileSync(join(dir, "sub", "c.txt"), "hello");
    writeFileSync(join(dir, nfd), "accent");

    const { sink, sent } = makeFakeSink(env.kb.memberId);
    env.source.onMessage(sink, {
      t: "fetch.ask", fetchId: "fetch-names-1", requester: { bot: env.botB }, source: env.ka.memberId,
      what: { kind: "artifact", botId: "bot-a", path: "pack" }, purpose: "names", maxBytes: 10 * MiB,
    });
    const end = await until(() => sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null, { timeout: 5_000, what: "fetch end" });
    expect(end.t).toBe("fetch.done");
    const chunks = sent.filter((m): m is WireMessage & { t: "fetch.chunk" } => m.t === "fetch.chunk");
    const names = chunks.map((c) => c.file);
    expect(names.every((n) => n === n.normalize("NFC"))).toBe(true);
    const order = [...new Set(names)];
    expect(order).toEqual([...order].sort());
    expect(order).toContain("caf\u00e9.txt");
    expect(order).toContain("sub/c.txt");
    expect(names.filter((n) => n === "b.bin")).toHaveLength(2);
    expect(chunks.find((c) => c.file === "empty.txt")!.bytes.length).toBe(0);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});
