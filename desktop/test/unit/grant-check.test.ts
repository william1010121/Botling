// Botling 3 M5-15: the grant check at the owner (D53, D54, C7, C12, plan change §4.1 checks 1 and 2).
// `grantAllows` is pure; the engine tests run a real IntentRuntime on a temp folder (no window, no focus, loopback-free).
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { GRANT_REFUSAL_DETAIL, type CmdBody, type MessageOf, type Scope, type Slot, type StreamId, type Via, type WireMessage } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { OwnerInbox, type InboxSession } from "../../src/server/forward/owner-inbox";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { ownTableStream, putRow } from "../../src/server/replica/tables";
import { RosterStore } from "../../src/server/roster";
import { slotAuthorize, type DeviceRoster } from "../../src/server/session";
import { grantAllows } from "../../src/server/slots/grant-check";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { generateDhKeyPair } from "../../src/session";
import { memberIdFromKey, toBase64Url } from "../../src/protocol";

const root = testRoot("grant-check");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const PEER_ID = "srv-peer-1";
const NAME = "build-box";
let folders = 0;

const send = (text = "hi"): Command => ({ type: "chat.send", botId: BOT, text } as Command);
const react = (): Command => ({ type: "chat.react", botId: BOT, messageId: "m1", emoji: "👍", present: true } as Command);
const approve = (): Command => ({ type: "link.authorize", botId: BOT, url: "https://x.test/" } as Command);

function row(over: { codeHash?: string; tier?: "read" | "request" | "write"; requests?: string[]; grants?: Record<string, unknown> } = {}): PluginRow {
  return {
    codeHash: over.codeHash ?? H1,
    manifest: { tier: over.tier ?? "write", reads: [], requests: over.requests ?? ["chat.send", "chat.react"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "user",
    grants: over.grants ?? {},
  } as PluginRow;
}
const grant = (tier: "read" | "request" | "write", requests: string[] = []) => ({ tier, reads: [], requests, grantedBy: "user", at: 1 });
const via = (plugin = "my.plugin", codeHash = H1): Via => ({ plugin, codeHash });

describe("M5-15: grantAllows (pure)", () => {
  it("no row, or no grant at the hash: 'may not do this' when the row's hash is the running one, else 'differs'", () => {
    expect(grantAllows(null, via(), send(), NAME)).toEqual({ ok: false, detail: `plugin my.plugin differs on ${NAME}` });
    expect(grantAllows(row(), via(), send(), NAME)).toEqual({ ok: false, detail: `plugin my.plugin may not do this on ${NAME}` });
    expect(grantAllows(row({ codeHash: H2, grants: { [H2]: grant("request", ["chat.send"]) } }), via("my.plugin", H1), send(), NAME))
      .toEqual({ ok: false, detail: `plugin my.plugin differs on ${NAME}` });
  });

  it("read refuses everything; request allows only its list; write allows its list and its own plugin commands", () => {
    const readRow = row({ grants: { [H1]: grant("read") } });
    expect(grantAllows(readRow, via(), send(), NAME).ok).toBe(false);
    const requestRow = row({ grants: { [H1]: grant("request", ["chat.send"]) } });
    expect(grantAllows(requestRow, via(), send(), NAME)).toEqual({ ok: true });
    expect(grantAllows(requestRow, via(), react(), NAME).ok).toBe(false);
    // A request-tier plugin has no commands of its own.
    expect(grantAllows(requestRow, via(), { type: "plugins.call", name: "my.plugin", method: "m", params: {}, from: "web" } as unknown as Command, NAME).ok).toBe(false);
    const writeRow = row({ grants: { [H1]: grant("write", ["chat.send"]) } });
    expect(grantAllows(writeRow, via(), send(), NAME)).toEqual({ ok: true });
    expect(grantAllows(writeRow, via(), react(), NAME).ok).toBe(false);
    const call = (name: string) => ({ type: "plugins.call", name, method: "m", params: {}, from: "web" }) as unknown as Command;
    expect(grantAllows(writeRow, via(), call("my.plugin"), NAME)).toEqual({ ok: true });
    expect(grantAllows(writeRow, via(), call("other"), NAME).ok).toBe(false);
    const byId = (type: string, id: string) => ({ type, id, botId: BOT, messageId: "m", tabId: "t", url: "https://x.test/" }) as unknown as Command;
    for (const type of ["plugins.command", "plugins.linkCommand", "plugins.tabCommand"]) {
      expect(grantAllows(writeRow, via(), byId(type, "my.plugin.go"), NAME), type).toEqual({ ok: true });
      expect(grantAllows(writeRow, via(), byId(type, "other.go"), NAME).ok, type).toBe(false);
      // The prefix is the whole name plus a dot: "my.plugin2.go" is another plugin.
      expect(grantAllows(writeRow, via(), byId(type, "my.plugin2.go"), NAME).ok, type).toBe(false);
    }
  });

  it("review: prototype keys as via.codeHash are no grant (no throw); a read grant that lists requests still refuses", () => {
    const r = row({ grants: { [H1]: grant("request", ["chat.send"]) } });
    for (const h of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(grantAllows(r, via("my.plugin", h), send(), NAME), h).toEqual({ ok: false, detail: `plugin my.plugin differs on ${NAME}` });
    }
    expect(grantAllows(row({ grants: { [H1]: grant("read", ["chat.send"]) } }), via(), send(), NAME).ok).toBe(false);
  });

  it("review: a write plugin never runs a command of another installed plugin whose name extends its own", () => {
    const writeMy = row({ grants: { [H1]: grant("write") } });
    const command = (id: string) => ({ type: "plugins.command", id }) as unknown as Command;
    expect(grantAllows(writeMy, via("my", H1), command("my.plugin.go"), NAME, ["my", "my.plugin"]).ok).toBe(false);
    expect(grantAllows(writeMy, via("my", H1), command("my.go"), NAME, ["my", "my.plugin"])).toEqual({ ok: true });
    expect(grantAllows(writeMy, via("my", H1), command("my.plugin.go"), NAME, ["my"])).toEqual({ ok: true });
  });

  it("plugin.grant is never allowed, even when a (hand-edited) grant lists it", () => {
    const hostile = row({ grants: { [H1]: grant("write", ["plugin.grant"]) } });
    expect(grantAllows(hostile, via(), { type: "plugin.grant", plugin: "my.plugin", codeHash: H1, tier: "write", reads: [], requests: [] } as Command, NAME).ok).toBe(false);
  });
});

interface Server { store: ServerStore; roster: RosterStore; runtime: IntentRuntime; serverId: string; stream: StreamId; inc(): string; valid: Set<string> }

async function startServer(): Promise<Server> {
  const dir = `${root}/d${++folders}`;
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { log: () => {} });
  const { ClusterSetup } = await import("../../src/server/identity");
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);
  const engine = new FakeTurnEngine({ bots: [BOT] });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const valid = new Set([PEER_ID]);
  const deviceRoster: DeviceRoster = {
    memberId: roster.memberId,
    device: (member) => roster.device(member),
    server: (member) => member !== roster.memberId && valid.has(member),
  };
  const runtime = new IntentRuntime({ store, engine, hub, live, log: () => {}, authorize: slotAuthorize(deviceRoster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  await store.submit((tx) => {
    ensureBot(tx, BOT);
    putRow(tx, ownTableStream(tx), "machine", { name: NAME, os: "test", versions: {}, addresses: [], pluginsDigest: null });
  });
  cleanups.push(async () => {
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    live.close();
    hub.close();
    await store.close();
  });
  return {
    store, roster, runtime, serverId, valid, stream: `srv:${serverId}` as StreamId,
    inc: () => String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId),
  };
}

async function device(s: Server, scope: Array<"read" | "reply" | "approve" | "manage">): Promise<string> {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  await s.roster.addDevice({ keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) }, name: "Phone", scope });
  return member;
}

async function seed(s: Server, name: string, body: PluginRow): Promise<void> {
  await s.store.submit((tx) => { putRow(tx, ownTableStream(tx), `plugin:${name}`, body); });
}

let slotN = 0;
function body(s: Server, origin: string, cmd: Command, withVia?: Via): CmdBody {
  return {
    slot: { origin, originEpoch: EPOCH, target: BOT_TARGET(s), n: ++slotN } as Slot,
    floor: slotN, inc: s.inc(), cmd, ...(withVia ? { via: withVia } : {}),
  } as CmdBody;
}
const BOT_TARGET = (_s: Server): StreamId => `bot:${BOT}` as StreamId;
const stated = (cmd: Command): Scope => (cmd.type === "link.authorize" ? "approve" : cmd.type.startsWith("plugins.") ? "manage" : "reply");

async function outcome(s: Server, origin: string, cmd: Command, scope: Scope, withVia?: Via) {
  const status = await s.runtime.receive(body(s, origin, cmd, withVia), { scope });
  if (status.status !== "result") throw new Error(`no result: ${status.status}`);
  return status.message.outcome;
}

describe("M5-15: the owner's grant check in the slot engine", () => {
  it("1. request-tier plugin granted chat.send on a read+reply device: chat.send applies; link.authorize is refused scope (device first), not grant", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "request", requests: ["chat.send"], grants: { [H1]: grant("request", ["chat.send"]) } }));
    const phone = await device(s, ["read", "reply"]);
    expect((await outcome(s, phone, send(), "reply", via())).kind).toBe("applied");
    const refused = await outcome(s, phone, approve(), "approve", via());
    expect(refused).toMatchObject({ kind: "refused", reason: "scope" });
    // Granted by the plugin but forbidden by the device: still scope. A command the plugin lacks and the device has: grant.
    expect(await outcome(s, phone, react(), "reply", via())).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin my.plugin may not do this on ${NAME}` });
  });

  it("2. a write-tier plugin on a read-only device: every command refused scope", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "write", grants: { [H1]: grant("write", ["chat.send", "chat.react"]) } }));
    const watcher = await device(s, ["read"]);
    for (const cmd of [send(), react(), approve()]) {
      expect(await outcome(s, watcher, cmd, stated(cmd), via()), cmd.type).toMatchObject({ kind: "refused", reason: "scope" });
    }
  });

  it("3. no grant at the hash: refused grant 'may not do this'; another hash: 'differs on'; no row: 'differs on'", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "request" }));
    const phone = await device(s, ["read", "reply"]);
    expect(await outcome(s, phone, send(), "reply", via("my.plugin", H1))).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin may not do this on ${NAME}` });
    expect(await outcome(s, phone, send("2"), "reply", via("my.plugin", H2))).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin differs on ${NAME}` });
    expect(await outcome(s, phone, send("3"), "reply", via("ghost", H1))).toEqual({ kind: "refused", reason: "grant", detail: `plugin ghost differs on ${NAME}` });
    expect(GRANT_REFUSAL_DETAIL).toBe("plugin grants arrive in M5"); // still exported for older tests, no longer used by the engine
  });

  it("4. grant at h1, plugin swapped to h2: a command written with via h1 still applies (C12); via h2 has no grant yet", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "request", requests: ["chat.send"], grants: { [H1]: grant("request", ["chat.send"]) } }));
    const phone = await device(s, ["read", "reply"]);
    expect((await outcome(s, phone, send(), "reply", via("my.plugin", H1))).kind).toBe("applied");
    expect(await outcome(s, phone, send("2"), "reply", via("my.plugin", H2))).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin my.plugin may not do this on ${NAME}` });
  });

  it("5. the accepting server never refuses for a grant; the owner refuses from its own row and applies nothing", async () => {
    const owner = await startServer();
    await seed(owner, "my.plugin", row({ tier: "request" }));
    const phone = await device(owner, ["read", "reply"]);
    // The accepting server's checks are device scope and origin only (`slotAuthorize` with no plugin table): a command
    // with `via` passes them whatever its (behind) copy of the owner's table holds.
    const accepting = slotAuthorize({ memberId: "srv-accepting", device: (member) => owner.roster.device(member) });
    expect(accepting(null as never, { slot: { origin: phone, originEpoch: EPOCH, target: owner.stream, n: 1 }, cmd: send(), scope: "reply" })).toBeNull();
    // The forwarded copy reaches the owner (via kept); the owner decides from its own row.
    const inbox = new OwnerInbox({ self: owner.serverId, runtime: owner.runtime, log: () => {} });
    const sent: WireMessage[] = [];
    const session: InboxSession = { peer: PEER_ID, state: "open", sendWire: (m) => { sent.push(m); return true; }, bye: () => {} };
    const slot = { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n: 1 };
    inbox.onMessage(session, { t: "cmd", slot, floor: 1, inc: owner.inc(), scope: "reply", cmd: send("forwarded"), via: via() } as WireMessage);
    const deadline = Date.now() + 10_000;
    while (!sent.some((m) => m.t === "cmd.result") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    const result = sent.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result")!;
    expect(result.outcome).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin may not do this on ${NAME}` });
    // Nothing applied: chat.send is an intent (begunCount counts legacy slots only), so read the bot's log itself.
    const kinds = (await owner.store.submit((tx) => tx.prepare("SELECT kind FROM entries WHERE stream = ?").all(`bot:${BOT}`))).map((r) => String(r.kind));
    expect(kinds).toContain("cmd.refused");
    expect(kinds).not.toContain("cmd.applied");
  });

  it("6. a command without via is unaffected, with or without a plugin row", async () => {
    const s = await startServer();
    const phone = await device(s, ["read", "reply"]);
    expect((await outcome(s, phone, send(), "reply")).kind).toBe("applied");
    await seed(s, "my.plugin", row({ tier: "read" }));
    expect((await outcome(s, phone, send("2"), "reply")).kind).toBe("applied");
  });

  it("review: a prototype-key hash is refused grant and the queue moves on; a malformed row is no grant", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "request", requests: ["chat.send"], grants: { [H1]: grant("request", ["chat.send"]) } }));
    const phone = await device(s, ["read", "reply"]);
    const n = ++slotN;
    const first = { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n }, floor: n, inc: s.inc(), cmd: send("p"), via: via("my.plugin", "constructor") } as CmdBody;
    expect(await s.runtime.receive(first, { scope: "reply" })).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "grant" } } });
    const next = { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n: n + 1 }, floor: n, inc: s.inc(), cmd: send("q") } as CmdBody;
    expect(await s.runtime.receive(next, { scope: "reply" })).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });
    slotN = n + 1;
    await s.store.submit((tx) => {
      const body = JSON.parse(String(tx.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'plugin:my.plugin'").get(s.stream)!.body));
      body.grants[H1].tier = "admin";
      tx.prepare("UPDATE rows SET body = ? WHERE stream = ? AND key = 'plugin:my.plugin'").run(JSON.stringify(body), s.stream);
    });
    expect(await outcome(s, phone, send("r"), "reply", via())).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin differs on ${NAME}` });
  });

  it("review: write plugin 'my' cannot run a command of installed plugin 'my.plugin'", async () => {
    const s = await startServer();
    await seed(s, "my", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "write", grants: {} }));
    const cmd = { type: "plugins.command", id: "my.plugin.go" } as Command;
    const status = await s.runtime.receive({ slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN }, floor: slotN, inc: s.inc(), cmd, via: via("my", H1) } as CmdBody, { scope: "local" });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "grant", detail: `plugin my may not do this on ${NAME}` } } });
  });

  it("7. plugin.grant with via stays refused (M5-14a F3), also when the row's grant lists it", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "write", grants: { [H1]: grant("write", ["plugin.grant"]) } }));
    const cmd = { type: "plugin.grant", plugin: "my.plugin", codeHash: H1, tier: "write", reads: [], requests: [] } as Command;
    const status = await s.runtime.receive({ slot: { origin: "desktop", originEpoch: EPOCH, target: s.stream, n: ++slotN }, floor: slotN, inc: s.inc(), cmd, via: via() } as CmdBody, { scope: "local" });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "grant", detail: "plugin.grant cannot be sent by a plugin" } } });
  });
});
