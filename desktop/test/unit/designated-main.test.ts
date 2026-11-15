// Botling 3 M5-04i: only the designated server runs a main bot; `botlingd designate <machine>` moves it at next start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type Outbound } from "../../src/contract";
import { coreProcessOptions } from "../../src/core/core-process";
import { saveProjectRow } from "../../src/core/projects";
import { Core, type CoreOptions } from "../../src/core/server";
import { MAIN_BOT_ID, newId, toSwiftDate } from "../../src/core/store/records";
import { mainProfile } from "../../src/core/store/workspace";
import type { MessageOf } from "../../src/protocol";
import { DbBotStores } from "../../src/server/botstore";
import { openServerStore } from "../../src/server/store";
import { fakeCli, tempDir, until } from "../helpers";
import { makeCluster, profile, readServerKeys, revokeServer, sign, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { admin } from "../support/ws-device";
import { designatedServer, machineLabel } from "../../src/server/designated";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };

const CUSTOM_MAIN = "0A0B0000-0000-4000-8000-000000000001";
const CUSTOM_MAINTAINER = "0A0B0000-0000-4000-8000-000000000002";

const openCores: Core[] = [];

afterEach(async () => {
  for (const core of openCores.splice(0)) {
    await core.shutdown().catch(() => undefined);
  }
});

function okRes<T = Record<string, unknown>>(res: { ok: true; result: unknown } | { ok: false; error: { message: string } }): T {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error.message);
  return res.result as T;
}

function errRes(res: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected error response");
  return res.error;
}

function createCore(dir: string, extra: Partial<CoreOptions> = {}) {
  const outbound: Outbound[] = [];
  const base = coreProcessOptions({
    env: {
      BOTLING_AGENT: "fake",
      BOTLING_FAKE_CLI: fakeCli,
      BOTLING_COMPONENT_SCAN_MS: "0",
      BOTLING_WAITING_SCAN_MS: "0",
      BOTLING_ROUTINE_TICK_MS: "0",
      BOTLING_WATCH_MS: "0",
      BOTLING_QUIT_TIDY_MS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    dataDir: dir,
    outDir: join(dir, "unused-out"),
    emit: (message) => outbound.push(message),
    log: () => {},
    node: null,
    sealer: null,
    app: null,
  });
  const core = new Core({ ...base, plugins: null, ...extra });
  openCores.push(core);
  return { core, outbound };
}

async function receiveCall(core: Core, outbound: Outbound[], cmd: unknown) {
  const id = `req-${Math.random().toString(36).slice(2)}`;
  core.receive({ v: PROTOCOL_VERSION, id, cmd });
  return until(() => outbound.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === id));
}

function mainIdOf(server: TestServer): string {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'ids.main'").get() as { value?: string } | undefined;
    return String(row?.value ?? "");
  } finally {
    db.close();
  }
}

async function setupNamedCluster(a: TestServer, b: TestServer, nameA = "Alpha", nameB = "Beta"): Promise<{
  ka: MemberKeysInfo;
  kb: MemberKeysInfo;
  clusterId: string;
  recovery: Awaited<ReturnType<typeof makeCluster>>["recovery"];
}> {
  await Promise.all([a.stop(), b.stop()]);
  const [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  const made = await makeCluster([ka, kb]);
  const addB = await sign({
    type: "add", cluster: made.clusterId, member: kb.memberId, kind: "server",
    keys: { sign: kb.sign, dh: kb.dh }, name: nameB, by: ka.memberId, at: 1_700_000_000_000, joined: true,
  }, ka);
  const addA = await sign({
    type: "add", cluster: made.clusterId, member: ka.memberId, kind: "server",
    keys: { sign: ka.sign, dh: ka.dh }, name: nameA, by: kb.memberId, at: 1_700_000_000_000, joined: true,
  }, kb);
  const statements = [made.root, addB, addA];
  writeStatements(a.dataDir, made.clusterId, [...statements, await profile(made.clusterId, kb, kb, b.port)]);
  writeStatements(b.dataDir, made.clusterId, [...statements, await profile(made.clusterId, ka, ka, a.port)]);
  return { ka, kb, clusterId: made.clusterId, recovery: made.recovery };
}

describe("M5-04i: core runMainBot: false behavior", () => {
  it("hides main bot when fresh, shows Main (old) when history exists, skips inbox.md delivery, and refuses commands naming 'main'", async () => {
    // 1. Fresh store: no main bot at all.
    const freshDir = tempDir("designated-core-fresh");
    const { core: freshCore, outbound: freshOut } = createCore(freshDir, {
      mainBotId: CUSTOM_MAIN,
      maintainerId: CUSTOM_MAINTAINER,
      runMainBot: false,
      mainBotMachine: () => "Beta",
    });
    expect(freshCore.mainBot()).toBeNull();
    const freshSnap = freshCore.snapshot();
    expect(freshSnap.chat).toBeNull();
    expect(freshSnap.bots.some((b) => b.id === CUSTOM_MAIN || b.role === "main" || b.id === MAIN_BOT_ID)).toBe(false);

    const freshRes = await receiveCall(freshCore, freshOut, { type: "chat.snapshot", botId: "main" });
    expect(freshRes.ok).toBe(false);
    if (!freshRes.ok) {
      expect(freshRes.error.code).toBe("not_found");
      expect(freshRes.error.message).toBe("There is no main bot on this machine; it runs on Beta.");
    }

    // 2. Main store with history lines + project inbox.md: shown as Main (old), role "bot", inbox not delivered.
    const histDir = tempDir("designated-core-history");
    const projectDir = tempDir("designated-core-proj");
    mkdirSync(join(projectDir, ".bot"), { recursive: true });
    const projectId = "11111111-1111-4111-8111-111111111111";
    saveProjectRow(histDir, { id: projectId, name: "worker-proj", folder: projectDir, avatar: "triangle" });

    // Seed history into main bot's FileBotStore directly before starting Core with runMainBot: false.
    const seededProfile = mainProfile(histDir, CUSTOM_MAIN);
    mkdirSync(seededProfile.storeDir, { recursive: true });
    const { BotStore } = await import("../../src/core/store/bot-store");
    new BotStore(seededProfile.storeDir).saveMessages([
      { id: newId(), role: "user", text: "previous main question", date: toSwiftDate(Date.now() - 10_000) },
      { id: newId(), role: "bot", text: "previous main reply", date: toSwiftDate(Date.now() - 5_000) },
    ]);

    const { core: histCore, outbound: histOut } = createCore(histDir, {
      mainBotId: CUSTOM_MAIN,
      maintainerId: CUSTOM_MAINTAINER,
      runMainBot: false,
      mainBotMachine: () => "Beta",
    });

    expect(histCore.mainBot()).toBeNull();
    const histSnap = histCore.snapshot();
    expect(histSnap.chat).toBeNull();
    const oldMain = histSnap.bots.find((b) => b.id === CUSTOM_MAIN);
    expect(oldMain).toMatchObject({ id: CUSTOM_MAIN, role: "bot", name: "Main (old)" });
    expect(histSnap.bots.some((b) => b.role === "main")).toBe(false);

    // Its history stays readable via its own UUID.
    const oldChat = await receiveCall(histCore, histOut, { type: "chat.snapshot", botId: CUSTOM_MAIN });
    expect(oldChat.ok).toBe(true);
    if (oldChat.ok) {
      const texts = (oldChat.result as { chat: { messages: Array<{ text: string }> } }).chat.messages.map((m) => m.text);
      expect(texts).toContain("previous main question");
      expect(texts).toContain("previous main reply");
    }

    // Plugin world does not expose "main" for Main (old).
    const worldBots = (histCore as unknown as { plugins: { options: { world: { bots(): Array<{ id: string; role: string; name: string }> } } } }).plugins.options.world.bots();
    expect(worldBots.some((b) => b.id === "main" || b.role === "main")).toBe(false);
    expect(worldBots.find((b) => b.id === CUSTOM_MAIN)).toMatchObject({ role: "bot", name: "Main (old)" });

    // inbox.md files are NOT delivered on deliverInboxes() or replied() from Main (old).
    const inboxFile = join(projectDir, ".bot", "inbox.md");
    writeFileSync(inboxFile, "Should stay queued until main runs here");
    histCore.deliverInboxes();
    const oldMainBot = (histCore as unknown as { bots: Map<string, unknown> }).bots.get(CUSTOM_MAIN);
    (histCore as unknown as { replied(bot: unknown, rec: unknown): void }).replied(oldMainBot, { id: "r1", role: "bot", text: "ok", date: 0 });
    expect(readFileSync(inboxFile, "utf8")).toBe("Should stay queued until main runs here");

    // Commands naming "main" refuse with exact text.
    const mainHistRes = await receiveCall(histCore, histOut, { type: "chat.history", botId: "main", before: newId() });
    expect(mainHistRes.ok).toBe(false);
    if (!mainHistRes.ok) {
      expect(mainHistRes.error.code).toBe("not_found");
      expect(mainHistRes.error.message).toBe("There is no main bot on this machine; it runs on Beta.");
    }
    const mainSendRes = await receiveCall(histCore, histOut, { type: "chat.send", botId: "main", text: "hello" });
    expect(mainSendRes.ok).toBe(false);
    if (!mainSendRes.ok) {
      expect(mainSendRes.error.message).toBe("There is no main bot on this machine; it runs on Beta.");
    }
  });
});

describe("M5-04i review: designated server, Main (old) and the studio", () => {
  const S = (n: number) => String.fromCharCode(96 + n).repeat(26);
  const view = (over: Partial<Parameters<typeof designatedServer>[0]> = {}) => ({
    self: S(1), servers: new Set([S(1), S(2), S(3)]), valid: new Set([S(1), S(2), S(4)]), root: { root: S(1) } as never, ...over,
  });

  it("designates only a valid server; anything else falls back to the root, or to this server with no cluster", () => {
    expect(designatedServer(view(), S(2))).toBe(S(2));
    expect(designatedServer(view({ self: S(2) }), S(2))).toBe(S(2));
    expect(designatedServer(view(), S(3))).toBe(S(1)); // a known server this one does not hold valid (revoked, or added by a revoked one)
    expect(designatedServer(view(), S(4))).toBe(S(1)); // valid, but a device
    expect(designatedServer(view(), "unknown")).toBe(S(1));
    expect(designatedServer(view(), 7)).toBe(S(1));
    expect(designatedServer(view(), null)).toBe(S(1));
    expect(designatedServer(view({ self: S(2), valid: new Set([S(2)]) }), S(3))).toBe(S(1)); // an invalid server designated: it does not run one itself either
    expect(designatedServer(view({ self: S(3), valid: new Set([S(3)]) }), S(3))).toBe(S(3)); // in its own view it is valid (R6 from self)
    expect(designatedServer(view({ root: null, self: S(5) }), "x")).toBe(S(5));
  });

  it("machine names reach logs and the terminal as one line", () => {
    expect(machineLabel("Beta")).toBe("Beta");
    expect(machineLabel("evil\n(App: x)\u001b[31m")).toBe("evil\\n(App: x)\\u001b[31m");
    expect(machineLabel("x".repeat(300))).toHaveLength(200);
  });

  it("Main (old) cannot be removed (it would come back at the next start) and is not \"main\" to the studio", async () => {
    const dir = tempDir("designated-review");
    const seeded = mainProfile(dir, CUSTOM_MAIN);
    mkdirSync(seeded.storeDir, { recursive: true });
    const { BotStore } = await import("../../src/core/store/bot-store");
    new BotStore(seeded.storeDir).saveMessages([{ id: newId(), role: "user", text: "old", date: toSwiftDate(Date.now()) }]);
    const { core } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER, runMainBot: false, mainBotMachine: () => "Beta" });
    expect(() => core.checkRemoveBot(CUSTOM_MAIN)).toThrow("The main bot and Maintainer cannot be removed.");
    await expect(core.removeBot(CUSTOM_MAIN)).rejects.toThrow("The main bot and Maintainer cannot be removed.");
    expect(core.snapshot().bots.find((bot) => bot.id === CUSTOM_MAIN)?.name).toBe("Main (old)");
    const studio = (core as unknown as { studioNow(): { chats(): Array<{ id: string; name: string }>; chat(id: string): unknown } }).studioNow();
    expect(studio.chats().find((chat) => chat.name === "Main (old)")?.id).toBe(CUSTOM_MAIN);
    expect(studio.chat("main")).toBeNull();
  });
});

describe("M5-04i: two servers designated main bot & botlingd designate", () => {
  const clusters: TestCluster[] = [];
  afterAll(async () => {
    for (const c of clusters.splice(0)) await c.cleanup();
  }, 60_000);

  it("default root runs main bot, fresh non-designated has none, non-designated with history shows Main (old), designate moves at next start, and commands naming 'main' refuse", async () => {
    const cluster = await startServers({ name: "designated-main", env: { A: TIMERS_ENV, B: TIMERS_ENV } });
    clusters.push(cluster);
    const { a, b } = cluster;
    const { ka, kb } = await setupNamedCluster(a, b, "Alpha", "Beta");

    // Seed main-bot history into B's server.db before starting the cluster to verify Main (old) on a real server.
    const bMainId = mainIdOf(b);
    const bSeedStore = await openServerStore(b.dataDir);
    try {
      const bStores = new DbBotStores(bSeedStore);
      bStores.open(bMainId, join(b.dataDir, "main")).saveMessages([
        { id: newId(), role: "user", text: "old note on B", date: toSwiftDate(Date.now() - 5_000) },
      ]);
      await bStores.durable();
      await bStores.close();
    } finally {
      await bSeedStore.close();
    }

    await Promise.all([a.start(), b.start()]);
    await until(() => a.log.includes(`peer ${kb.memberId}: live`) && b.log.includes(`peer ${ka.memberId}: live`), {
      timeout: 30_000,
      what: "A and B live",
    });

    // 1 & 2: Root A runs main bot; B (not designated, has history) shows Main (old) with role "bot" and no role "main".
    const clientA1 = await a.client("fe-a1");
    const clientB1 = await b.client("fe-b1");
    const snapA1 = okRes<{ bots: Array<{ id: string; role: string; name: string }> }>(await clientA1.req({ type: "chat.snapshot" }));
    const snapB1 = okRes<{ bots: Array<{ id: string; role: string; name: string }>; chat: unknown }>(await clientB1.req({ type: "chat.snapshot" }));
    expect(snapA1.bots.some((bot) => bot.role === "main")).toBe(true);
    expect(snapB1.bots.some((bot) => bot.role === "main")).toBe(false);
    expect(snapB1.bots.find((bot) => bot.id === bMainId)).toMatchObject({ id: bMainId, role: "bot", name: "Main (old)" });
    expect(snapB1.chat).toBeNull();

    // 4: On non-designated B, req and cmd naming "main" refuse with the exact message pointing to Alpha.
    const reqMainOnB = errRes(await clientB1.req({ type: "chat.snapshot", botId: "main" }));
    expect(reqMainOnB.message).toBe("There is no main bot on this machine; it runs on Alpha.");

    await clientB1.sub(clientB1.srv);
    const bSrvInc = (await clientB1.wait(
      (m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === clientB1.srv,
      "B srv snap",
    )).logId;
    const slotB = { origin: clientB1.deviceId, originEpoch: clientB1.originEpoch, target: "bot:main", n: 1 };
    const fromB = clientB1.received.length;
    clientB1.cmd(slotB, { type: "chat.send", botId: "main", text: "ping main" }, bSrvInc);
    const refusedOnB = await clientB1.wait(
      (m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === "bot:main",
      "cmd.result refusal on B",
      { from: fromB },
    );
    expect(refusedOnB.outcome).toMatchObject({
      kind: "refused",
      reason: "invalid",
      detail: expect.stringContaining("There is no main bot on this machine; it runs on Alpha."),
    });

    // Give A's main bot a message so A shows Main (old) when B takes over.
    const aMainId = mainIdOf(a);
    const aStream = `bot:${aMainId}`;
    await clientA1.sub(clientA1.srv);
    const aSrvInc = (await clientA1.wait(
      (m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === clientA1.srv,
      "A srv snap",
    )).logId;
    await clientA1.sub(aStream);
    const slotA = { origin: clientA1.deviceId, originEpoch: clientA1.originEpoch, target: aStream, n: 1 };
    const fromA = clientA1.received.length;
    clientA1.cmd(slotA, { type: "chat.send", botId: aMainId, text: "hello from Alpha" }, aSrvInc);
    const sentOnA = await clientA1.wait(
      (m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === aStream,
      "A main message result",
      { from: fromA },
    );
    expect(sentOnA.outcome.kind).toBe("applied");
    await until(
      () =>
        clientA1.entriesOf(aStream).some(
          (e) => e.kind === "message.added" && (e.body as { message?: { text?: string } }).message?.text === "hello from Alpha",
        ) || null,
      { timeout: 10_000, what: "A main message added" },
    );

    // Unknown machine name exits 2 with exact text.
    const badCli = a.command(["designate", "NoSuchMachine"]);
    expect(badCli.code).toBe(2);
    expect(`${badCli.stdout}\n${badCli.stderr}`).toContain('no machine named "NoSuchMachine" (botlingd machines lists them)');

    // 3: Designate Beta; takes effect only at next start, and both log prefs.onChange line.
    const goodCli = a.command(["designate", "Beta"]);
    expect(goodCli.code).toBe(0);
    expect(goodCli.stdout).toContain("designated Beta; its main bot takes over when each server next starts.");

    await until(() => a.log.includes("designatedServer is now Beta; the main bot moves when each server next starts.")
      && b.log.includes("designatedServer is now Beta; the main bot moves when each server next starts."), {
      timeout: 30_000,
      what: "both servers log designatedServer change",
    });

    // Before restart: A still runs main bot and B still does not.
    const preRestartA = okRes<{ bots: Array<{ role: string }> }>(await clientA1.req({ type: "chat.snapshot" }));
    const preRestartB = okRes<{ bots: Array<{ role: string }> }>(await clientB1.req({ type: "chat.snapshot" }));
    expect(preRestartA.bots.some((bot) => bot.role === "main")).toBe(true);
    expect(preRestartB.bots.some((bot) => bot.role === "main")).toBe(false);

    // Restart both servers: Beta runs main bot; Alpha shows Main (old) with its readable history; "main" on Alpha refuses pointing to Beta.
    await Promise.all([a.stop(), b.stop()]);
    await Promise.all([a.start(), b.start()]);

    const clientA2 = await a.client("fe-a2");
    const clientB2 = await b.client("fe-b2");
    const snapA2 = okRes<{ bots: Array<{ id: string; role: string; name: string }> }>(await clientA2.req({ type: "chat.snapshot" }));
    const snapB2 = okRes<{ bots: Array<{ id: string; role: string; name: string }> }>(await clientB2.req({ type: "chat.snapshot" }));
    expect(snapB2.bots.find((bot) => bot.id === bMainId)).toMatchObject({ id: bMainId, role: "main" });
    expect(snapA2.bots.some((bot) => bot.role === "main")).toBe(false);
    expect(snapA2.bots.find((bot) => bot.id === aMainId)).toMatchObject({ id: aMainId, role: "bot", name: "Main (old)" });

    const oldHistoryA = okRes<{ chat: { messages: Array<{ text: string }> } }>(await clientA2.req({ type: "chat.snapshot", botId: aMainId }));
    expect(oldHistoryA.chat.messages.some((m) => m.text === "hello from Alpha")).toBe(true);

    const reqMainOnA = errRes(await clientA2.req({ type: "chat.snapshot", botId: "main" }));
    expect(reqMainOnA.message).toBe("There is no main bot on this machine; it runs on Beta.");

    // 5a: a pref naming an unknown member or a device is refused where it is set (review F1); a designated machine
    // can be designated back (the root designates itself through the CLI).
    await expect(admin(clientA2, { op: "prefs.set", key: "designatedServer", value: "unknown-member-id" }))
      .rejects.toThrow("is not a server of this cluster that can run the main bot");
    await expect(admin(clientA2, { op: "prefs.set", key: "designatedServer", value: clientA2.deviceId }))
      .rejects.toThrow("is not a server of this cluster that can run the main bot");
    const backToAlpha = a.command(["designate", "Alpha"]);
    expect(backToAlpha.code).toBe(0);
    expect(backToAlpha.stdout).toContain("designated Alpha; its main bot takes over when each server next starts.");
    await until(() => b.log.includes("designatedServer is now Alpha; the main bot moves when each server next starts."), {
      timeout: 30_000,
      what: "B hears Alpha designated",
    });
    await Promise.all([a.stop(), b.stop()]);
    await Promise.all([a.start(), b.start()]);

    const clientA3 = await a.client("fe-a3");
    const clientB3 = await b.client("fe-b3");
    expect(okRes<{ bots: Array<{ role: string }> }>(await clientA3.req({ type: "chat.snapshot" })).bots.some((bot) => bot.role === "main")).toBe(true);
    expect(okRes<{ bots: Array<{ role: string }> }>(await clientB3.req({ type: "chat.snapshot" })).bots.some((bot) => bot.role === "main")).toBe(false);

    // 5b: Designated server is later revoked -> falls back to root (Alpha).
    await admin(clientA3, { op: "prefs.set", key: "designatedServer", value: kb.memberId });
    await Promise.all([a.stop(), b.stop()]);
    const clusterIdDb = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
    const cid = String((clusterIdDb.prepare("SELECT value FROM meta WHERE key = 'clusterId'").get() as { value: string }).value);
    clusterIdDb.close();
    const revokeB = await revokeServer(cid, ka, kb);
    writeStatements(a.dataDir, cid, [revokeB]);
    await a.start();

    const clientA4 = await a.client("fe-a4");
    const botsA4 = okRes<{ bots: Array<{ id: string; role: string }> }>(await clientA4.req({ type: "chat.snapshot" })).bots;
    expect(botsA4.find((bot) => bot.id === aMainId)?.role).toBe("main");

    // A revoked machine is still listed by name, but designating it is refused with exit 2 (review F1).
    const revokedCli = a.command(["designate", "Beta"]);
    expect(revokedCli.code).toBe(2);
    expect(revokedCli.stderr).toContain("cannot designate Beta:");
    expect(revokedCli.stderr).toContain("is not a server of this cluster that can run the main bot");
  }, 120_000);

  it("two servers with a fresh non-designated server: fresh non-designated has no main bot row at all in bots.list", async () => {
    const cluster = await startServers({ name: "designated-fresh", env: { A: TIMERS_ENV, B: TIMERS_ENV } });
    clusters.push(cluster);
    const { a, b } = cluster;
    await setupNamedCluster(a, b, "RootBox", "FreshBox");

    await Promise.all([a.start(), b.start()]);
    const clientA = await a.client("fresh-a");
    const clientB = await b.client("fresh-b");
    const botsA = okRes<{ bots: Array<{ id: string; role: string; name: string }> }>(await clientA.req({ type: "chat.snapshot" })).bots;
    const botsB = okRes<{ bots: Array<{ id: string; role: string; name: string }> }>(await clientB.req({ type: "chat.snapshot" })).bots;

    expect(botsA.some((bot) => bot.role === "main")).toBe(true);
    expect(botsB.some((bot) => bot.role === "main" || bot.name === "Main (old)")).toBe(false);
    expect(botsB.map((bot) => bot.id)).not.toContain(mainIdOf(b));
  }, 90_000);
});
