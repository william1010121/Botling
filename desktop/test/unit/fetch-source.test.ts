// M5-07a: fetch source (free vs ask vs denied, audit before first chunk, per-chunk grant/roster/O_NOFOLLOW/real-path
// checks, once-grant reuse prevention, limits, and resume).
// Requires `npm run build` (out/server/main.cjs) for the two-server botlingd test.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTENT_FRAME_CHUNK_LIMIT, decodeWireFrame, encodeChunkFrame, encodeWireFrame, fromBase64Url, type WireMessage,
} from "../../src/protocol";
import { FetchAsk } from "../../src/protocol/fetch";
import { PEER_CONTENT_FRAME } from "../../src/server/content/peer-content";
import { FetchSource, type FetchAskHook, type FetchSink } from "../../src/server/fetch/source";
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
const RELAY_FRAME = CONTENT_FRAME_CHUNK_LIMIT; // 128 KiB

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
  const sink: FetchSink & { open: boolean } = {
    peer: peerId,
    open: true,
    get state() { return this.open ? "open" : "closed"; },
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

async function setupInProcessCluster(askHook?: FetchAskHook, onChunkHook?: (fetchId: string, index: number) => void | Promise<void>) {
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

  const source = new FetchSource({
    self: ka.memberId,
    dataDir: dataA,
    store: reopenedA,
    reader: () => readerA,
    roster: rosterA,
    botFolders: () => botFolders,
    ...(askHook ? { ask: askHook } : {}),
    ...(onChunkHook ? { onChunk: onChunkHook } : {}),
    onAudit: () => {
      auditCommitOrder = ++seq;
      events.push({ event: "audit-committed", order: auditCommitOrder });
    },
  });

  const cleanup = async () => {
    readerA.close();
    await reopenedA.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root, dataA, botFolderA, artifactsA, srcA, outsideDir,
    ka, kb, botB, cluster, storeA: reopenedA, readerA, rosterA, source,
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

  it("8. Relay transport sends 128 KiB chunks; unknown requester bot is refused", async () => {
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
    expect(relayChunks.map((c) => c.bytes.length)).toEqual([RELAY_FRAME, payload.length - RELAY_FRAME]);

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

  it("serves free artifact over live PeerSession and denies ask-gated path with default hook", async () => {
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
    const denied2 = await until(() => received.find((m) => m.t === "fetch.denied" && m.fetchId === "two-srv-ask") ?? null, {
      timeout: 10_000, what: "two-srv-ask denied",
    });
    expect(denied2).toEqual({ t: "fetch.denied", fetchId: "two-srv-ask", reason: "denied" });

    link.close();
  }, 60_000);
});
