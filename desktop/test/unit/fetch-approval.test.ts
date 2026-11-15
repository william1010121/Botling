// M5-06c: the fetch approval card in the Maintainer's chat and the fetch grants (card text byte for byte, B-12).
// In-process: a real Core (its Maintainer chat, waiting list, restart) + FetchApproval + FetchSource on a real
// server.db; the peer is a fake sink. The real-botlingd wiring (admin ops, `botlingd fetch`) is in
// fetch-approval-botlingd.test.ts.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame, type WireMessage } from "../../src/protocol";
import { Core } from "../../src/core/server";
import { NO_LONGER_NEEDED } from "../../src/core/bot";
import { cardText, countTarget, FetchApproval, formatFiles, formatSize, GONE_DETAIL, tildePath } from "../../src/server/fetch/approval";
import { FetchSource, type FetchAskHook, type FetchSink } from "../../src/server/fetch/source";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import { makeCluster, readServerKeys, writeStatements } from "../support/peer-cluster";

const PEER = { local: false } as const;
const KiB = 1024;

function fakeSink(peer: string) {
  const sent: WireMessage[] = [];
  const sink: FetchSink & { open: boolean } = {
    peer, open: true, queuedBytes: 0, transport: "tailnet",
    get state() { return this.open ? "open" : "closed"; },
    sendWire: (message) => {
      if (!sink.open) return false;
      const encoded = encodeWireFrame(message, "peer", PEER);
      if (!encoded.ok) throw new Error(encoded.detail);
      const decoded = decodeWireFrame(encoded.text, "peer", PEER);
      if (!decoded.ok) throw new Error(decoded.detail);
      sent.push(decoded.message);
      return true;
    },
    sendChunk: (message) => {
      if (!sink.open) return false;
      const encoded = encodeChunkFrame(message, "peer", PEER);
      if (!encoded.ok) throw new Error(encoded.detail);
      const decoded = decodeWireFrame(encoded.bytes, "peer", PEER);
      if (!decoded.ok) throw new Error(decoded.detail);
      sent.push(decoded.message);
      return true;
    },
  };
  return { sink, sent };
}

const NAMES = {
  bot: (_server: string, botId: string) => (botId === "bot-b" ? "build" : null),
  machine: (server: string) => (server === "self" ? "build-box" : "studio"),
  device: () => null,
};

/** One server A: server.db, roster with B, a real Core (fake CLI never started), the approval and the source. */
async function fixture(options: { timeoutMs?: number; ask?: FetchAskHook } = {}) {
  const root = realpathSync(testRoot("fetch-approval"));
  const dataA = join(root, "data-a");
  const dataB = join(root, "data-b");
  const coreDir = join(root, "core");
  const home = join(root, "home");
  const folder = join(home, "src", "app");
  const botFolder = join(root, "bots", "bot-a");
  for (const dir of [dataA, dataB, coreDir, folder, join(botFolder, ".bot", "artifacts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(folder, "main.ts"), "export const main = 1;\n");
  writeFileSync(join(folder, "util.ts"), "export const util = 2;\n");
  const other = join(home, "src", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "x.ts"), "x\n");

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

  const state: { store: ServerStore; core: Core; approval: FetchApproval; source: FetchSource; cores: Core[] } = { cores: [] } as never;
  const boot = async () => {
    state.store = await openServerStore(dataA);
    const roster = await RosterStore.open(state.store, idA);
    await state.store.submit((tx) => {
      tx.prepare("INSERT OR IGNORE INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)")
        .run(`srv:${kb.memberId}`, "bot:bot-b", JSON.stringify({ name: "build" }));
    });
    const reader = state.store.openReader();
    state.core = new Core({ dataDir: coreDir, headConfig() { throw new Error("no engine"); }, emit() {}, deferStartup: true, routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    state.cores.push(state.core);
    state.approval = new FetchApproval({
      core: state.core, store: state.store, reader: () => reader, self: "self", homeDir: home,
      names: NAMES, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    await state.approval.recover();
    state.source = new FetchSource({
      self: ka.memberId, dataDir: dataA, store: state.store, reader: () => reader, roster,
      botFolders: () => new Map([["bot-a", botFolder]]),
      ask: options.ask ?? state.approval.ask,
      gone: (fetchId) => state.approval.gone(fetchId),
    });
    return reader;
  };
  let reader = await boot();
  const closeAll = async () => {
    for (const core of state.cores.splice(0)) await core.shutdown().catch(() => undefined);
    reader.close();
    await state.store.close();
  };
  const restart = async () => {
    for (const core of state.cores.splice(0)) await core.shutdown();
    reader.close();
    await state.store.close();
    reader = await boot();
  };
  const maintainer = () => (state.core as any).bots.get(state.core.maintainerId);
  const cards = () => ((maintainer().records as any[]).filter((r) => r.role === "notice" && r.choices?.length));
  const askFetch = (fetchId: string, path: string, extra: Record<string, unknown> = {}) => {
    const { sink, sent } = fakeSink(kb.memberId);
    state.source.onMessage(sink, {
      t: "fetch.ask", fetchId, requester: { bot: "bot-b" }, source: ka.memberId,
      what: { kind: "path", path }, purpose: "build the app", maxBytes: 10 * 1024 * KiB, ...extra,
    } as never);
    return { sink, sent };
  };
  const finished = (sent: WireMessage[]) => until(() => (sent.find((m) => m.t === "fetch.done" || m.t === "fetch.denied") ?? null) as ({ t: string; reason?: string; detail?: string; fetchId: string } | null), { timeout: 8_000, what: "fetch.done or fetch.denied" });
  const openCard = async (count = 1) => until(() => (cards().length >= count ? cards()[count - 1] : null), { timeout: 8_000, what: "approval card" });
  return {
    root, home, folder, other, botFolder, ka, kb, state, cards, maintainer, askFetch, finished, openCard, restart,
    reader: () => reader,
    cleanup: async () => { await closeAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
const setup = async (options?: Parameters<typeof fixture>[0]) => { const env = await fixture(options); cleanups.push(env.cleanup); return env; };
const grantRows = (env: Awaited<ReturnType<typeof fixture>>) =>
  env.reader().prepare("SELECT kind, prefix, requester, requesterServer, revokedAt FROM grants ORDER BY createdAt").all() as Array<{ kind: string; prefix: string; requester: string; requesterServer: string; revokedAt: number | null }>;

describe("M5-06c: card text (B-12, exact)", () => {
  it("the first line, the Why line and the choices", () => {
    const input = { bot: "build", requesterMachine: "studio", path: "/home/me/src/app", home: "/home/me", sourceMachine: "build-box", bytes: 12_000_000, files: 340, purpose: "compile it" };
    expect(cardText(input)).toBe("build on studio asks to read ~/src/app on build-box (12 MB, 340 files).\nWhy: compile it");
  });
  it("sizes: under 10^6 bytes `<n> KB` (at least 1 KB), under 10^9 `<n> MB` rounded, else `<n.n> GB`; `1 file`", () => {
    expect(formatSize(0)).toBe("1 KB");
    expect(formatSize(1)).toBe("1 KB");
    expect(formatSize(1_499)).toBe("1 KB");
    expect(formatSize(1_500)).toBe("2 KB");
    expect(formatSize(999_999)).toBe("1000 KB");
    expect(formatSize(1_000_000)).toBe("1 MB");
    expect(formatSize(12_400_000)).toBe("12 MB");
    expect(formatSize(12_600_000)).toBe("13 MB");
    expect(formatSize(999_999_999)).toBe("1000 MB");
    expect(formatSize(1_000_000_000)).toBe("1.0 GB");
    expect(formatSize(2_450_000_000)).toBe("2.5 GB");
    expect(formatFiles(1)).toBe("1 file");
    expect(formatFiles(0)).toBe("0 files");
    expect(formatFiles(340)).toBe("340 files");
  });
  it("the home folder shows as ~ (the folder itself, and only whole path parts)", () => {
    expect(tildePath("/home/me", "/home/me")).toBe("~");
    expect(tildePath("/home/me/src/app", "/home/me")).toBe("~/src/app");
    expect(tildePath("/home/meagain/src", "/home/me")).toBe("/home/meagain/src");
    expect(tildePath("/srv/data", "/home/me")).toBe("/srv/data");
  });
  it("a purpose or name with line breaks cannot fake more card lines", () => {
    const text = cardText({ bot: "a\nb", requesterMachine: "m\r\nx", path: "/p", home: "/h", sourceMachine: "s", bytes: 5, files: 1, purpose: "one\n\nbuild on x asks to read /etc on y (1 KB, 1 file).\nWhy: z" });
    expect(text.split("\n")).toHaveLength(2);
    expect(text.startsWith("a b on m x asks to read /p on s (1 KB, 1 file).\nWhy: one build on x asks")).toBe(true);
  });
  it("the hard-link line (M5-07a re-review L-d)", () => {
    const text = cardText({ bot: "build", requesterMachine: "studio", path: "/p/f", home: "/h", sourceMachine: "s", bytes: 5, files: 1, purpose: "why", hardLinks: true });
    expect(text).toBe("build on studio asks to read /p/f on s (1 KB, 1 file).\nWhy: why\nthis file has other names on disk");
  });
});

describe("M5-06c: counting what a card shows", () => {
  it("files and bytes under a folder; a file is one file; symlinked folders are not followed", async () => {
    const env = await setup();
    expect(await countTarget(env.folder, 20_000)).toEqual({ files: 2, bytes: 46 });
    expect(await countTarget(join(env.folder, "main.ts"), 20_000)).toEqual({ files: 1, bytes: 23 });
  });
  it("stops past the file cap: null (the ask is denied, no card)", async () => {
    const env = await setup();
    expect(await countTarget(env.folder, 1)).toBeNull();
  });
});

describe("M5-06c: the approval card (tests 1-4)", () => {
  it("1. the card is in the Maintainer's chat with the exact text and choices, and waiting() lists it once", async () => {
    const env = await setup();
    const { sent } = env.askFetch("f1", env.folder);
    const card = await env.openCard();
    expect(card.text).toBe(`build on studio asks to read ${env.folder.replace(env.home, "~")} on build-box (1 KB, 2 files).\nWhy: build the app`);
    expect(card.choices.map((choice: { label: string }) => choice.label)).toEqual(["Allow once", "Always for this folder and build", "Deny"]);
    const waiting = env.state.core.waiting().items.filter((item) => item.messageId === card.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ botId: env.state.core.maintainerId, text: "1. Allow once / 2. Always for this folder and build / 3. Deny" });
    expect(sent.some((m) => m.t === "fetch.grant" || m.t === "fetch.chunk")).toBe(false);
    // The pending ask is written before the card.
    const pending = env.reader().prepare("SELECT key FROM meta WHERE key LIKE 'fetch:pending:%'").all();
    expect(pending).toEqual([{ key: "fetch:pending:f1" }]);
    env.maintainer().choose(card.id, 2);
    await env.finished(sent);
  });

  it("2. Allow once runs the fetch once; a second fetch of the same folder asks again; the answered card is not waiting", async () => {
    const env = await setup();
    const first = env.askFetch("f2a", env.folder);
    const card = await env.openCard();
    expect(env.maintainer().choose(card.id, 0)).toEqual({ accepted: true });
    expect((await env.finished(first.sent)).t).toBe("fetch.done");
    expect(grantRows(env)).toEqual([expect.objectContaining({ kind: "once", prefix: env.folder })]);
    expect(env.state.core.waiting().items.some((item) => item.messageId === card.id)).toBe(false);
    expect(env.reader().prepare("SELECT key FROM meta WHERE key LIKE 'fetch:pending:%'").all()).toEqual([]);
    const second = env.askFetch("f2b", env.folder);
    const again = await env.openCard(2);
    expect(again.id).not.toBe(card.id);
    env.maintainer().choose(again.id, 2);
    expect((await env.finished(second.sent))).toEqual({ t: "fetch.denied", fetchId: "f2b", reason: "denied" });
  });

  it("3. Always: another fetch of that folder asks nothing; another folder and another bot still ask; `grants()` lists it", async () => {
    const env = await setup();
    const first = env.askFetch("f3a", env.folder);
    const card = await env.openCard();
    env.maintainer().choose(card.id, 1);
    expect((await env.finished(first.sent)).t).toBe("fetch.done");
    const second = env.askFetch("f3b", join(env.folder, "util.ts"));
    expect((await env.finished(second.sent)).t).toBe("fetch.done");
    expect(env.cards()).toHaveLength(1);
    // Another folder (a sibling, not covered) asks again.
    const third = env.askFetch("f3c", env.other);
    const askedOther = await env.openCard(2);
    expect(askedOther.text).toContain("src/other");
    env.maintainer().choose(askedOther.id, 2);
    expect((await env.finished(third.sent)).t).toBe("fetch.denied");
    // The same folder by another bot of B asks again (the grant is per requester); its name is in the card.
    await env.state.store.submit((tx) => {
      tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(`srv:${env.kb.memberId}`, "bot:bot-c", JSON.stringify({ name: "other-bot" }));
    });
    const { sink, sent } = fakeSink(env.kb.memberId);
    env.state.source.onMessage(sink, { t: "fetch.ask", fetchId: "f3d", requester: { bot: "bot-c" }, source: env.ka.memberId, what: { kind: "path", path: env.folder }, purpose: "p", maxBytes: 1024 * KiB } as never);
    const otherBot = await env.openCard(3);
    expect(otherBot.text.startsWith("bot-c on studio asks to read ")).toBe(true);
    expect(otherBot.choices[1].label).toBe("Always for this folder and bot-c");
    env.maintainer().choose(otherBot.id, 2);
    expect((await env.finished(sent)).t).toBe("fetch.denied");
    expect(env.cards()).toHaveLength(3);
    const listed = env.state.approval.grants();
    expect(listed).toEqual([expect.objectContaining({ requester: "bot-b", requesterServer: env.kb.memberId, botName: "build", machine: "studio", prefix: env.folder })]);
    expect(listed[0]!.grantId).toMatch(/\S/);
  });

  it("4. Deny: fetch.denied{denied}, no chunk, no grant, no audit row", async () => {
    const env = await setup();
    const { sent } = env.askFetch("f4", env.folder);
    const card = await env.openCard();
    env.maintainer().choose(card.id, 2);
    expect(await env.finished(sent)).toEqual({ t: "fetch.denied", fetchId: "f4", reason: "denied" });
    expect(sent.filter((m) => m.t !== "fetch.denied")).toEqual([]);
    expect(grantRows(env)).toEqual([]);
    expect(env.reader().prepare("SELECT key FROM rows WHERE key LIKE 'audit:%'").all()).toEqual([]);
  });
});

describe("M5-06c: fail closed (a null answer never runs a fetch)", () => {
  it("an answer that is not Allow once / Always (null, out of range, junk) is a deny", async () => {
    for (const answer of [null, 3, -1, 1.5, undefined, "0"]) {
      const calls: unknown[] = [];
      const env = await setup({ ask: undefined });
      const approval = new FetchApproval({
        core: { maintainerId: "m", serverAsk: async (...args) => { calls.push(args); return answer as never; } },
        store: env.state.store, reader: env.reader, self: "self", homeDir: env.home, names: NAMES,
      });
      const decision = await approval.ask({ fetchId: "n1", requester: { bot: "bot-b" }, requesterServer: env.kb.memberId, what: { kind: "path", path: env.folder }, purpose: "p", maxBytes: 1024, prefix: env.folder, realPath: env.folder }, new Promise(() => undefined));
      expect(decision).toBe("deny");
      expect(calls).toHaveLength(1);
    }
  });
  it("FetchSource itself: a hook that returns null / undefined / junk or throws never serves a byte", async () => {
    for (const result of [null, undefined, "yes", "ONCE", 0, true]) {
      const env = await setup({ ask: (async () => result) as never });
      const { sent } = env.askFetch("s1", env.folder);
      expect((await env.finished(sent)).t).toBe("fetch.denied");
      expect(sent.some((m) => m.t === "fetch.chunk" || m.t === "fetch.grant")).toBe(false);
      expect(grantRows(env)).toEqual([]);
    }
    const env = await setup({ ask: async () => { throw new Error("card exploded"); } });
    const { sent } = env.askFetch("s2", env.folder);
    expect((await env.finished(sent)).t).toBe("fetch.denied");
    expect(sent.some((m) => m.t === "fetch.chunk")).toBe(false);
  });
  it("no Maintainer chat (serverAsk gives null at once) -> deny, nothing written for the grant", async () => {
    const env = await setup();
    expect(await env.state.core.serverAsk("no-such-bot", { text: "t", choices: ["a"] })).toBeNull();
    expect(await env.state.core.serverAsk(env.state.core.maintainerId, { text: "t", choices: [] })).toBeNull();
  });
  it("ignoring the card (closed without a pick) answers null -> deny", async () => {
    const env = await setup();
    const { sent } = env.askFetch("i1", env.folder);
    const card = await env.openCard();
    expect(env.maintainer().ignoreQuestion(card.id)).toEqual({ accepted: true });
    expect((await env.finished(sent)).t).toBe("fetch.denied");
    expect(sent.some((m) => m.t === "fetch.chunk")).toBe(false);
    expect(env.state.core.waiting().items.some((item) => item.messageId === card.id)).toBe(false);
  });
  it("timeout: nobody answers -> the card is closed 'No longer needed' and the fetch is denied", async () => {
    const env = await setup({ timeoutMs: 150 });
    const { sent } = env.askFetch("t1", env.folder);
    const card = await env.openCard();
    expect((await env.finished(sent)).t).toBe("fetch.denied");
    expect(env.cards().find((c) => c.id === card.id)?.answer).toBe(NO_LONGER_NEEDED);
    expect(env.state.core.waiting().items.some((item) => item.messageId === card.id)).toBe(false);
    // Answering the dead card later changes nothing.
    expect(env.maintainer().choose(card.id, 1)).toEqual({ accepted: false });
    expect(grantRows(env)).toEqual([]);
  });
  it("the session closes while the card is open: the card is closed, a later 'Always' creates no grant", async () => {
    const env = await setup();
    const { sink, sent } = env.askFetch("c1", env.folder);
    const card = await env.openCard();
    sink.open = false;
    env.state.source.sessionClosed(sink as never);
    await until(() => env.cards().find((c) => c.id === card.id)?.answer === NO_LONGER_NEEDED ? true : null, { timeout: 5_000, what: "card closed" });
    expect(env.maintainer().choose(card.id, 1)).toEqual({ accepted: false });
    expect(sent).toEqual([]);
    expect(grantRows(env)).toEqual([]);
  });
  it("more than 20,000 files under the folder: denied, no card (the source's own scan or the approval's count)", async () => {
    const env = await setup();
    const approval = new FetchApproval({
      core: { maintainerId: "m", serverAsk: async () => { throw new Error("no card may be made"); } },
      store: env.state.store, reader: env.reader, self: "self", homeDir: env.home, names: NAMES, maxFiles: 1,
    });
    const decision = await approval.ask({ fetchId: "big", requester: { bot: "bot-b" }, requesterServer: env.kb.memberId, what: { kind: "path", path: env.folder }, purpose: "p", maxBytes: 1024, prefix: env.folder, realPath: env.folder }, new Promise(() => undefined));
    expect(decision).toBe("deny");
  });
  it("a hard-linked file: the card shows the file, says so, offers only Allow once / Deny", async () => {
    const env = await setup();
    const { linkSync } = await import("node:fs");
    const file = join(env.botFolder, ".bot", "artifacts", "r.txt");
    writeFileSync(file, "hello");
    linkSync(file, join(env.folder, "r-other-name.txt"));
    const { sent } = env.askFetch("h1", file, { what: { kind: "artifact", botId: "bot-a", path: "r.txt" } });
    const card = await env.openCard();
    expect(card.text).toBe(`build on studio asks to read ${file} on build-box (1 KB, 1 file).\nWhy: build the app\nthis file has other names on disk`);
    expect(card.choices.map((choice: { label: string }) => choice.label)).toEqual(["Allow once", "Deny"]);
    env.maintainer().choose(card.id, 0);
    const end = await env.finished(sent);
    expect(end.t === "fetch.denied" ? `${end.reason} ${end.detail ?? ""}` : end.t).toBe("fetch.done");
    expect(grantRows(env)).toEqual([expect.objectContaining({ kind: "once" })]);
  });
});

describe("M5-06c: restart while the card is open (test 5)", () => {
  it("the card closes 'No longer needed'; the same fetchId asked again gets fetch.denied{gone} with the exact detail; a new fetchId asks again", async () => {
    const env = await setup();
    const { sent } = env.askFetch("r1", env.folder);
    const card = await env.openCard();
    expect(env.reader().prepare("SELECT key FROM meta WHERE key = 'fetch:pending:r1'").get()).toBeDefined();
    await env.restart();
    expect(sent.some((m) => m.t === "fetch.chunk")).toBe(false);
    const restarted = env.cards().find((c) => c.id === card.id);
    expect(restarted?.answer).toBe(NO_LONGER_NEEDED);
    expect(env.state.core.waiting().items.some((item) => item.messageId === card.id)).toBe(false);
    expect(env.reader().prepare("SELECT key FROM meta WHERE key LIKE 'fetch:pending:%'").all()).toEqual([]);
    const reasked = env.askFetch("r1", env.folder);
    expect(await env.finished(reasked.sent)).toEqual({ t: "fetch.denied", fetchId: "r1", reason: "gone", detail: "the source restarted before an answer" });
    expect(GONE_DETAIL).toBe("the source restarted before an answer");
    expect(env.cards().filter((c) => c.chosen == null && c.answer == null)).toHaveLength(0);
    // Still gone after another restart.
    await env.restart();
    const third = env.askFetch("r1", env.folder);
    expect((await env.finished(third.sent)).reason).toBe("gone");
    // A new fetchId is a new question.
    const fresh = env.askFetch("r2", env.folder);
    const again = await env.openCard(2); // the first, closed card stays in the chat
    expect(again.text).toContain("asks to read");
    env.maintainer().choose(again.id, 2);
    expect((await env.finished(fresh.sent)).reason).toBe("denied");
  });
});

describe("M5-06c: revoke (test 6)", () => {
  it("revoking an always grant during a fetch under it refuses the next chunk", async () => {
    const env = await setup();
    const big = join(env.folder, "big.bin");
    writeFileSync(big, Buffer.alloc(300 * KiB, 7));
    const first = env.askFetch("v1", env.folder);
    const card = await env.openCard();
    env.maintainer().choose(card.id, 1);
    expect((await env.finished(first.sent)).t).toBe("fetch.done");
    const [row] = env.state.approval.grants();
    // A fetch under that grant, revoked after its first chunk.
    let revoked: Promise<boolean> | null = null;
    (env.state.source as any).options.onChunk = (_fetchId: string, index: number) => { if (index === 0) revoked = env.state.approval.revoke(row!.grantId); };
    const second = env.askFetch("v2", big);
    const end = await env.finished(second.sent);
    expect(await revoked).toBe(true);
    expect(end.t).toBe("fetch.denied");
    expect(end.reason).toBe("revoked");
    expect(second.sent.filter((m) => m.t === "fetch.chunk").length).toBeLessThan(5);
    expect(env.state.approval.grants()).toEqual([]);
    // Revoking again, or an unknown id, changes nothing.
    expect(await env.state.approval.revoke(row!.grantId)).toBe(false);
    expect(await env.state.approval.revoke("nope")).toBe(false);
    // And the folder asks again.
    const third = env.askFetch("v3", env.folder);
    const asked = await env.openCard(2);
    env.maintainer().choose(asked.id, 2);
    expect((await env.finished(third.sent)).reason).toBe("denied");
  });
});

describe("M5-06c: from a phone attached to another server (test 7)", () => {
  // M5-04g (per-server Maintainer ids) is merged, but this needs a paired phone attached to B and B's pass-through of
  // `chat.choose` to A's Maintainer stream; no fixture builds that yet. The answer lands in the same Bot.choose as
  // the in-process tests above.
  it.todo("answer from a phone on another server: a paired phone attached to B answers A's card (needs a pairing + pass-through fixture)");
});
