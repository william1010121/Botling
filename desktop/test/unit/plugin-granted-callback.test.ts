// The user allows a plugin (`plugin.grant`): the runtime calls `pluginGranted` once after the commit, so Maintainer can be told
// (botlingd-start.ts -> core.pluginGranted). A revoke (tier none) and a refused grant call nothing; `pluginRowsChanged` is
// the existing path and is checked beside it, so each case shows the command did reach the commit.
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { CmdBody, StreamId } from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { ownTableStream, putRow } from "../../src/server/replica/tables";
import { RosterStore } from "../../src/server/roster";
import { slotAuthorize, type DeviceRoster } from "../../src/server/session";
import { openServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { EPOCH_A } from "./server-slots-harness";

const root = testRoot("plugin-granted-callback");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const HASH_1 = "a".repeat(64);
const HASH_UNKNOWN = "f".repeat(64);
let folders = 0;

const pluginRow = (grants: Record<string, unknown> = {}) => ({
  codeHash: HASH_1,
  manifest: { tier: "request", reads: ["chat.snapshot"], requests: ["chat.send"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
  author: "user",
  grants,
});

async function start() {
  const dir = `${root}/d${++folders}`;
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { log: () => {} });
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);
  const engine = new FakeTurnEngine({ bots: [BOT] });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const deviceRoster: DeviceRoster = { memberId: roster.memberId, device: (member) => roster.device(member), server: () => false };
  const granted: string[] = [];
  let rowsChanged = 0;
  const runtime = new IntentRuntime({
    store, engine, hub, live, log: () => {}, authorize: slotAuthorize(deviceRoster), serverEvents: "all", mirrorBotUpdates: true,
    pluginRowsChanged: () => { rowsChanged += 1; },
    pluginGranted: (plugin) => { granted.push(plugin); },
  });
  await runtime.start();
  cleanups.push(async () => {
    await runtime.scope.submit(() => undefined);
    engine.close(); runtime.close(); live.close(); hub.close();
    await store.close();
  });
  const stream = `srv:${serverId}`;
  let n = 0;
  const grant = async (over: { tier: "none" | "read" | "request" | "write"; codeHash?: string }) => {
    const status = await runtime.receive({
      slot: { origin: "desktop", originEpoch: EPOCH_A, target: stream as StreamId, n: ++n },
      floor: n,
      inc: String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(stream)!.logId),
      cmd: { type: "plugin.grant", plugin: "design-duel", codeHash: over.codeHash ?? HASH_1, tier: over.tier, reads: over.tier === "none" ? [] : ["chat.snapshot"], requests: over.tier === "request" ? ["chat.send"] : [] },
    } as CmdBody, { scope: "local" });
    await runtime.scope.submit(() => undefined);
    return status;
  };
  const seed = (row: Record<string, unknown>) => store.submit((tx) => { putRow(tx, ownTableStream(tx), "plugin:design-duel", row); });
  return { grant, seed, granted, rowsChanged: () => rowsChanged };
}

describe("plugin.grant tells the server who was allowed", () => {
  it("the user allows a plugin: pluginGranted once, with the plugin's name", async () => {
    const s = await start();
    await s.seed(pluginRow());
    const status = await s.grant({ tier: "request" });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });
    expect(s.granted).toEqual(["design-duel"]);
    expect(s.rowsChanged()).toBe(1);
  });

  it("a revoke (tier none) changes the row but is not an allow: nothing is said", async () => {
    const s = await start();
    await s.seed(pluginRow({ [HASH_1]: { tier: "request", reads: ["chat.snapshot"], requests: ["chat.send"], grantedBy: "user", at: 1 } }));
    await s.grant({ tier: "none" });
    expect(s.rowsChanged()).toBe(1);
    expect(s.granted).toEqual([]);
  });

  it("a grant that is refused (an unknown code hash) says nothing", async () => {
    const s = await start();
    await s.seed(pluginRow());
    await s.grant({ tier: "request", codeHash: HASH_UNKNOWN });
    expect(s.rowsChanged()).toBe(0);
    expect(s.granted).toEqual([]);
  });
});
