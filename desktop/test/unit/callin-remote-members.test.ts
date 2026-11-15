// M5-02a: peer bots from valid peers' srv: table copies can be called with @, after local bots.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "../../src/core/bot";
import type { Conversations } from "../../src/core/conversations";
import { saveProjectRow } from "../../src/core/projects";
import { Core, type CoreOptions } from "../../src/core/server";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../src/core/store/records";
import type { LogId, StreamId } from "../../src/protocol";
import { peerRemoteMembers } from "../../src/server/botlingd";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { applyCopy } from "../../src/server/replica/peer-tables";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";
import { tempDir } from "../helpers";

const BOT_A = "6AC64E3A-C7D7-4000-8000-0000000000A1";
const BOT_LOCAL_BUILD = "6AC64E3A-C7D7-4000-8000-0000000000A2";
const REMOTE_BUILD_B = "6AC64E3A-C7D7-4000-8000-0000000000B1";
const REMOTE_BUILD_C = "6AC64E3A-C7D7-4000-8000-0000000000C1";
const REMOTE_MAINTAINER_B = "6AC64E3A-C7D7-4000-8000-0000000000B2";
const REMOTE_MAIN_OLD_B = "6AC64E3A-C7D7-4000-8000-0000000000B3";
const REMOTE_SUB_B = "6AC64E3A-C7D7-4000-8000-0000000000B4";
const REMOTE_MAIN_B = "6AC64E3A-C7D7-4000-8000-0000000000B5";

const SERVER_B = "srv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVER_C = "srv_cccccccccccccccccccccccccccccc";

const openCores: Core[] = [];
const openStores: ServerStore[] = [];
const openReaders: Db[] = [];
const storeRoot = testRoot("callin-remote-members");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const reader of openReaders.splice(0)) reader.close();
  for (const core of openCores.splice(0)) await core.shutdown().catch(() => {});
  for (const store of openStores.splice(0)) await store.close().catch(() => {});
});
afterAll(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

function createFixture(options: { localBuild?: boolean; remoteMembers?: CoreOptions["remoteMembers"]; remoteTurn?: CoreOptions["remoteTurn"] } = {}) {
  const dir = tempDir("callin-remote");
  const folderA = tempDir("callin-remote-a");
  mkdirSync(join(folderA, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOT_A, name: "alpha", folder: folderA, avatar: "triangle" });
  if (options.localBuild) {
    const folderB = tempDir("callin-remote-b");
    mkdirSync(join(folderB, ".bot"), { recursive: true });
    saveProjectRow(dir, { id: BOT_LOCAL_BUILD, name: "build", folder: folderB, avatar: "cloud" });
  }
  const core = new Core({
    dataDir: dir,
    headConfig() { throw new Error("No agent allowed"); },
    emit() {},
    deferStartup: true,
    routineTickMs: 0,
    componentScanMs: 0,
    waitingScanMs: 0,
    watchMs: 0,
    quitTidyMs: 0,
    ...(options.remoteMembers ? { remoteMembers: options.remoteMembers } : {}),
    ...(options.remoteTurn ? { remoteTurn: options.remoteTurn } : {}),
  });
  openCores.push(core);
  const bots = (core as unknown as { bots: Map<string, Bot> }).bots;
  const conversations = (core as unknown as { conversations: Conversations }).conversations;
  const caller = bots.get(BOT_A)!;
  const notices: string[] = [];
  vi.spyOn(caller, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as never);
  vi.spyOn(caller, "appMessage").mockImplementation((() => false) as never);
  return { core, bots, conversations, caller, notices };
}

function summaryBody(overrides: Partial<{
  name: string;
  role: "main" | "manager" | "bot";
  parent: string | null;
}> = {}) {
  return {
    name: overrides.name ?? "build",
    face: null,
    role: overrides.role ?? "bot",
    parent: overrides.parent ?? null,
    folderName: "build",
    engine: "claude" as const,
    model: null,
    status: "idle" as const,
    waiting: [],
    unread: 0,
    lastAt: null,
    lines: [],
  };
}

let storeSeq = 0;
async function makeServerDb() {
  const dir = join(storeRoot, `s${++storeSeq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  openStores.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity);
  const reader = store.openReader();
  openReaders.push(reader);
  return { dir, store, reader, identity, roster, setup: new ClusterSetup(roster) };
}

describe("M5-02a: peer bots can be called with @", () => {
  it("1. @build resolves to B's bot 'build' (after local bots), and reports M5-02c placeholder notice when called", async () => {
    const h = createFixture({
      remoteMembers: () => [{ id: REMOTE_BUILD_B, name: "build", server: SERVER_B, serverName: "build-box" }],
    });
    const callable = h.conversations.callable(BOT_A);
    expect(callable.at(-1)).toMatchObject({ id: REMOTE_BUILD_B, name: "build" });

    // User's @ in composer:
    expect(h.conversations.calledIn("@build check status", BOT_A).map((m) => m.id)).toEqual([REMOTE_BUILD_B]);
    expect(h.conversations.calledIn("@build (build-box) check status", BOT_A).map((m) => m.id)).toEqual([REMOTE_BUILD_B]);

    // Bot's @ in reply:
    h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build check status", date: 0 }, h.caller);
    expect(h.conversations.mentionLog.records).toHaveLength(1);
    expect(h.conversations.mentionLog.records[0]).toMatchObject({
      sender: BOT_A,
      recipient: REMOTE_BUILD_B,
      body: "check status",
    });
    await vi.waitFor(() => {
      expect(h.notices).toContain("Did not answer this time: build (its machine cannot take call-ins yet).");
    });
  });

  it("2. a local bot of the same name wins over a peer bot", async () => {
    const h = createFixture({
      localBuild: true,
      remoteMembers: () => [{ id: REMOTE_BUILD_B, name: "build", server: SERVER_B, serverName: "build-box" }],
    });
    const localBuild = h.bots.get(BOT_LOCAL_BUILD)!;
    const asked: string[] = [];
    vi.spyOn(localBuild, "groupTurn").mockImplementation((text: string) => {
      asked.push(text);
      return new Promise(() => {});
    });

    // User's @build resolves only to the local bot.
    expect(h.conversations.calledIn("@build hello", BOT_A).map((m) => m.id)).toEqual([BOT_LOCAL_BUILD]);

    // Bot's @build resolves to the local bot.
    h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build check local", date: 0 }, h.caller);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(h.conversations.mentionLog.records.at(-1)).toMatchObject({ recipient: BOT_LOCAL_BUILD, body: "check local" });

    // Explicit @build (build-box) still targets the peer bot.
    expect(h.conversations.calledIn("@build (build-box) hello", BOT_A).map((m) => m.id)).toEqual([REMOTE_BUILD_B]);
    h.conversations.receiveBotMention({ id: "R2", role: "bot", text: "@build (build-box) check remote", date: 0 }, h.caller);
    expect(h.conversations.mentionLog.records.at(-1)).toMatchObject({ recipient: REMOTE_BUILD_B, body: "check remote" });
  });

  it("3. two peers with the same name -> refusal lists @build (build-box) and @build (studio)", () => {
    const h = createFixture({
      remoteMembers: () => [
        { id: REMOTE_BUILD_B, name: "build", server: SERVER_B, serverName: "build-box" },
        { id: REMOTE_BUILD_C, name: "build", server: SERVER_C, serverName: "studio" },
      ],
    });
    h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build run tests", date: 0 }, h.caller);
    expect(h.conversations.mentionLog.records).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('2 bots are named "build"');
    expect(h.notices[0]).toContain("@build (build-box)");
    expect(h.notices[0]).toContain("@build (studio)");
    expect(h.notices[0]).not.toContain("@Parent/");

    // Qualified name resolves unambiguously to the chosen peer bot.
    h.conversations.receiveBotMention({ id: "R2", role: "bot", text: "@build (studio) run tests", date: 0 }, h.caller);
    expect(h.conversations.mentionLog.records).toHaveLength(1);
    expect(h.conversations.mentionLog.records[0]).toMatchObject({ recipient: REMOTE_BUILD_C, body: "run tests" });
  });

  it("4. peerRemoteMembers reads live bot rows of valid peers, filters 2.x constants/main/sub/tombstones, and drops revoked or gone peers", async () => {
    const a = await makeServerDb();
    const b = await makeServerDb();
    const c = await makeServerDb();
    const started = await a.setup.begin();
    expect((await a.setup.confirm(started.code)).ok).toBe(true);
    const addB = await a.roster.addServer({ keys: b.identity.keys, name: "build-box" });
    const addC = await a.roster.addServer({ keys: c.identity.keys, name: "studio" });
    expect(addB.addId).toBeTruthy();
    expect(addC.addId).toBeTruthy();

    const streamB = `srv:${b.identity.memberId}` as StreamId;
    const streamC = `srv:${c.identity.memberId}` as StreamId;
    const logB = "log_bbbbbbbbbbbbbbbbbbbbbb" as LogId;
    const logC = "log_cccccccccccccccccccccc" as LogId;
    const DELETED_BOT = "6AC64E3A-C7D7-4000-8000-0000000000B6";

    await a.store.submit((tx) => {
      applyCopy(tx, b.identity.memberId, streamB, [{
        t: "rows", stream: streamB, logId: logB, after: 0, to: 8, more: false,
        rows: [
          { key: `bot:${REMOTE_BUILD_B}`, rev: 1, body: summaryBody({ name: "build", role: "bot" }) },
          { key: `bot:${REMOTE_MAINTAINER_B}`, rev: 2, body: summaryBody({ name: "Maintainer", role: "manager" }) },
          { key: `bot:${REMOTE_MAIN_OLD_B}`, rev: 3, body: summaryBody({ name: "Main (old)", role: "bot" }) },
          { key: `bot:${MAIN_BOT_ID}`, rev: 4, body: summaryBody({ name: "Main bot", role: "bot" }) },
          { key: `bot:${MAINTAINER_ID}`, rev: 5, body: summaryBody({ name: "Maintainer", role: "manager" }) },
          { key: `bot:${REMOTE_MAIN_B}`, rev: 6, body: summaryBody({ name: "Main bot", role: "main" }) },
          { key: `bot:${REMOTE_SUB_B}`, rev: 7, body: summaryBody({ name: "subby", role: "bot", parent: REMOTE_BUILD_B }) },
          { key: `bot:${DELETED_BOT}`, rev: 8, deleted: true },
        ],
      }], 1_000);
      applyCopy(tx, c.identity.memberId, streamC, [{
        t: "rows", stream: streamC, logId: logC, after: 0, to: 1, more: false,
        rows: [
          { key: `bot:${REMOTE_BUILD_C}`, rev: 1, body: summaryBody({ name: "build", role: "bot" }) },
        ],
      }], 1_000);
    });

    const listed = peerRemoteMembers(a.roster, a.reader);
    expect(listed).toEqual(expect.arrayContaining([
      { id: REMOTE_BUILD_B, name: "build", server: b.identity.memberId, serverName: "build-box" },
      { id: REMOTE_MAINTAINER_B, name: "Maintainer", server: b.identity.memberId, serverName: "build-box" },
      { id: REMOTE_MAIN_OLD_B, name: "Main (old)", server: b.identity.memberId, serverName: "build-box" },
      { id: REMOTE_BUILD_C, name: "build", server: c.identity.memberId, serverName: "studio" },
    ]));
    expect(listed).toHaveLength(4);

    // Stale peer (still valid in roster) remains listed.
    await a.store.submit((tx) => {
      tx.prepare("UPDATE streams SET state = 'stale' WHERE stream = ?").run(streamB);
    });
    expect(peerRemoteMembers(a.roster, a.reader).some((m) => m.server === b.identity.memberId)).toBe(true);

    // Gone peer (streams.state = 'gone') is not listed.
    await a.store.submit((tx) => {
      tx.prepare("UPDATE streams SET state = 'gone' WHERE stream = ?").run(streamB);
    });
    expect(peerRemoteMembers(a.roster, a.reader).some((m) => m.server === b.identity.memberId)).toBe(false);

    // Revoked peer (even if stream still says live/stale) is not listed.
    await a.roster.revokeServer(c.identity.memberId, false, "retired");
    expect(peerRemoteMembers(a.roster, a.reader)).toEqual([]);
  });

  it("5. 2.x (no remoteMembers option) is unchanged", () => {
    const h = createFixture();
    expect(h.conversations.callable(BOT_A).map((m) => m.id)).toEqual([MAIN_BOT_ID, MAINTAINER_ID]);
    expect(h.conversations.calledIn("@build hello", BOT_A)).toEqual([]);
    h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build hello", date: 0 }, h.caller);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("Not sent to @build: no bot with that name");
  });

  it("6. remoteTurn option receives remote call-in context and posts guest reply under peer bot id", async () => {
    const calls: unknown[] = [];
    const h = createFixture({
      remoteMembers: () => [{ id: REMOTE_BUILD_B, name: "build", server: SERVER_B, serverName: "build-box" }],
      remoteTurn: async (req) => {
        calls.push(req);
        return { kind: "reply", text: "Build is green.", steps: [], engine: "claude" };
      },
    });
    expect(h.conversations.speakerName(REMOTE_BUILD_B)).toBe("build");
    h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build status?", date: 0 }, h.caller);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      member: { id: REMOTE_BUILD_B, name: "build", server: SERVER_B, serverName: "build-box" },
      host: { botId: BOT_A, name: "alpha" },
      asked: "@build status?",
      by: "bot",
      depth: 1,
    });
    await vi.waitFor(() => {
      expect(h.caller.lines().some((line) => line.sourceID === REMOTE_BUILD_B && line.text === "Build is green.")).toBe(true);
    });
  });
});
