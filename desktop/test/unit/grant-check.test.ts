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
import { grantAllows, grantTierOf, pluginApproved } from "../../src/server/slots/grant-check";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
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

const call = (name: string) => ({ type: "plugins.call", name, method: "m", params: {}, from: "web" }) as unknown as Command;
const byId = (type: string, id: string) => ({ type, id, botId: BOT, messageId: "m", tabId: "t", url: "https://x.test/" }) as unknown as Command;
const PLUGIN_GRANT = { type: "plugin.grant", plugin: "my.plugin", codeHash: H1, tier: "write", reads: [], requests: [] } as Command;

describe("2026-11-16 trust model: grantAllows (pure)", () => {
  it("an uninstalled plugin is refused: no row, or a row with no approval record (a bot or a copied folder put it there)", () => {
    expect(grantAllows(null, via(), send(), NAME)).toEqual({ ok: false, detail: `plugin my.plugin is not installed on ${NAME}` });
    expect(grantAllows(row(), via(), send(), NAME)).toEqual({ ok: false, detail: `plugin my.plugin is not installed on ${NAME}` });
    expect(grantAllows({ ...row(), author: "bot" }, via(), send(), NAME).ok).toBe(false);
    expect(pluginApproved(row())).toBe(false);
    expect(pluginApproved(null)).toBe(false);
  });

  it("context-budget: an installed 2.x plugin (author user, tier write, an approval record only at an older hash) is allowed at its current hash", () => {
    // Before: the grant was read at via.codeHash only, so a row with grants {} or a grant at another hash refused every command.
    const installed = row({ codeHash: H2, grants: { [H1]: grant("write") } });
    expect(grantAllows(installed, via("my.plugin", H2), call("my.plugin"), NAME)).toEqual({ ok: true });
    expect(grantAllows(installed, via("my.plugin", H2), send(), NAME)).toEqual({ ok: true });
  });

  it("a new code hash of an installed plugin is allowed with no new grant, whatever hash the command was written under", () => {
    const r = row({ codeHash: H2, tier: "write", grants: { [H1]: grant("request", ["chat.send"]) } });
    for (const h of [H1, H2, "c".repeat(64), "constructor", "__proto__"]) {
      expect(grantAllows(r, via("my.plugin", h), send(), NAME), h).toEqual({ ok: true });
      expect(grantAllows(r, via("my.plugin", h), react(), NAME), h).toEqual({ ok: true });
    }
  });

  it("the tier of the record decides nothing: read, request and write all allow the same", () => {
    for (const tier of ["read", "request", "write"] as const) {
      const r = row({ grants: { [H1]: grant(tier) } });
      expect(grantAllows(r, via(), send(), NAME), tier).toEqual({ ok: true });
      expect(grantAllows(r, via(), react(), NAME), tier).toEqual({ ok: true });
      expect(grantAllows(r, via(), call("my.plugin"), NAME), tier).toEqual({ ok: true });
    }
  });

  it("a built-in is installed without a record", () => {
    expect(grantAllows({ ...row(), author: "builtin" }, via(), send(), NAME)).toEqual({ ok: true });
  });

  it("plugin.grant is never allowed, even for an installed plugin or when a (hand-edited) record lists it", () => {
    expect(grantAllows(row({ grants: { [H1]: grant("write", ["plugin.grant"]) } }), via(), PLUGIN_GRANT, NAME)).toEqual({ ok: false, detail: "plugin.grant cannot be sent by a plugin" });
    expect(grantAllows({ ...row(), author: "builtin" }, via(), PLUGIN_GRANT, NAME).ok).toBe(false);
    expect(grantAllows(null, via(), PLUGIN_GRANT, NAME).ok).toBe(false);
  });

  it("a plugin's own commands name that plugin; another plugin's (or a longer-named plugin's) needs the manifest to declare the type", () => {
    const r = row({ grants: { [H1]: grant("write") } });
    expect(grantAllows(r, via(), call("my.plugin"), NAME)).toEqual({ ok: true });
    expect(grantAllows(r, via(), call("other"), NAME).ok).toBe(false);
    for (const type of ["plugins.command", "plugins.linkCommand", "plugins.tabCommand"]) {
      expect(grantAllows(r, via(), byId(type, "my.plugin.go"), NAME), type).toEqual({ ok: true });
      expect(grantAllows(r, via(), byId(type, "other.go"), NAME).ok, type).toBe(false);
      // The prefix is the whole name plus a dot: "my.plugin2.go" is another plugin.
      expect(grantAllows(r, via(), byId(type, "my.plugin2.go"), NAME).ok, type).toBe(false);
    }
    const declared = row({ requests: ["plugins.call"], grants: { [H1]: grant("write") } });
    expect(grantAllows(declared, via(), call("other"), NAME)).toEqual({ ok: true });
  });

  it("the nested-name guard: plugin 'my' never runs a command of installed plugin 'my.plugin'", () => {
    const my = row({ grants: { [H1]: grant("write") } });
    const command = (id: string) => ({ type: "plugins.command", id }) as unknown as Command;
    expect(grantAllows(my, via("my", H1), command("my.plugin.go"), NAME, ["my", "my.plugin"]).ok).toBe(false);
    expect(grantAllows(my, via("my", H1), command("my.go"), NAME, ["my", "my.plugin"])).toEqual({ ok: true });
    expect(grantAllows(my, via("my", H1), command("my.plugin.go"), NAME, ["my"])).toEqual({ ok: true });
  });

  it("what installs, removes or approves for the user passes only when the manifest declares it (no silent install of another plugin)", () => {
    const r = row({ grants: { [H1]: grant("write") } });
    for (const type of ["plugins.storeInstall", "plugins.remove", "plugins.enable", "plugins.secret"]) {
      expect(grantAllows(r, via(), { type, name: "other" } as unknown as Command, NAME).ok, type).toBe(false);
    }
    expect(grantAllows(r, via(), approve(), NAME).ok).toBe(false);
    expect(grantAllows(r, via(), { type: "plugins.approve", name: "my.plugin", botId: BOT, command: "ls", folder: "/tmp" } as unknown as Command, NAME).ok).toBe(false);
    const declared = row({ requests: ["plugins.storeInstall", "link.authorize"], grants: { [H1]: grant("write") } });
    expect(grantAllows(declared, via(), { type: "plugins.storeInstall", name: "other" } as unknown as Command, NAME)).toEqual({ ok: true });
    expect(grantAllows(declared, via(), approve(), NAME)).toEqual({ ok: true });
  });

  it("M5-12b F2: helper commands are allowed only when cmd.name === via.plugin", () => {
    const tile = (name = "my.plugin") => ({ type: "plugins.tileImages", name, botId: BOT, data: "{}" }) as unknown as Command;
    const snap = (name = "my.plugin") => ({ type: "plugins.noteSnapshot", name, botId: BOT, rect: { x: 0, y: 0, width: 10, height: 10 } }) as unknown as Command;
    const ask = (name = "my.plugin") => ({ type: "plugins.approvalAsk", name, botId: BOT, command: "ls", folder: "/tmp" }) as unknown as Command;
    for (const cmd of [tile(), snap(), ask()]) {
      expect(grantAllows(null, via(), cmd, NAME).ok, cmd.type).toBe(false);
      expect(grantAllows(row(), via(), cmd, NAME).ok, cmd.type).toBe(false);
    }
    const r = row({ grants: { [H1]: grant("read") } });
    for (const make of [tile, snap, ask]) {
      expect(grantAllows(r, via(), make("my.plugin"), NAME)).toEqual({ ok: true });
      expect(grantAllows(r, via(), make("other"), NAME).ok).toBe(false);
    }
  });
});

describe("2026-11-16 trust model: pluginApproved / grantTierOf", () => {
  it("any user / import / builtin record at any hash installs; nothing else does", () => {
    expect(pluginApproved(row({ grants: { [H2]: grant("read") } }))).toBe(true);
    expect(pluginApproved(row({ grants: { [H1]: { ...grant("write"), grantedBy: "import" } } }))).toBe(true);
    expect(pluginApproved(row({ grants: {} }))).toBe(false);
  });

  it("the shown tier is the record at the current hash, 'write' for an installed plugin with an older record, 'none' otherwise", () => {
    expect(grantTierOf(row({ grants: { [H1]: grant("request") } }))).toBe("request");
    expect(grantTierOf(row({ codeHash: H2, grants: { [H1]: grant("request") } }))).toBe("write");
    expect(grantTierOf(row({ grants: {} }))).toBe("none");
    expect(grantTierOf(row({ codeHash: "constructor", grants: { [H1]: grant("write") } }))).toBe("write");
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
    // Allowed for the plugin but forbidden by the device: still scope. An installed plugin may send any command the device may.
    expect((await outcome(s, phone, react(), "reply", via())).kind).toBe("applied");
    // What acts on other plugins needs the manifest to declare it: the plugin's own manifest here asks for chat.send only.
    expect(await outcome(s, phone, { type: "plugins.remove", name: "other" } as unknown as Command, "manage", via())).toMatchObject({ kind: "refused", reason: "scope" });
  });

  it("2. a write-tier plugin on a read-only device: every command refused scope", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "write", grants: { [H1]: grant("write", ["chat.send", "chat.react"]) } }));
    const watcher = await device(s, ["read"]);
    for (const cmd of [send(), react(), approve()]) {
      expect(await outcome(s, watcher, cmd, stated(cmd), via()), cmd.type).toMatchObject({ kind: "refused", reason: "scope" });
    }
  });

  it("3. not installed: a row with no approval record, or no row, is refused 'is not installed' (the old 'differs' wording is gone)", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "request" }));
    const phone = await device(s, ["read", "reply"]);
    expect(await outcome(s, phone, send(), "reply", via("my.plugin", H1))).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin is not installed on ${NAME}` });
    expect(await outcome(s, phone, send("2"), "reply", via("my.plugin", H2))).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin is not installed on ${NAME}` });
    expect(await outcome(s, phone, send("3"), "reply", via("ghost", H1))).toEqual({ kind: "refused", reason: "grant", detail: `plugin ghost is not installed on ${NAME}` });
    expect(GRANT_REFUSAL_DETAIL).toBe("plugin grants arrive in M5"); // still exported for older tests, no longer used by the engine
  });

  it("3b. context-budget: an installed 2.x plugin whose record is not at its current hash (or an empty `grants` before the migration) was refused; with the record it applies", async () => {
    const s = await startServer();
    // The refusal the user saw in Settings › Context 開銷: a row at hash H2 whose only approval record is at H1.
    await seed(s, "context-budget", row({ codeHash: H2, tier: "write", requests: [], grants: { [H1]: grant("write") } }));
    const phone = await device(s, ["read", "reply"]);
    const call = { type: "plugins.call", name: "context-budget", method: "read", params: {}, from: "web" } as unknown as Command;
    expect(await s.store.submit((tx) => s.runtime.slots.denies(tx, { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN } as Slot, cmd: call, scope: "reply", via: via("context-budget", H2) }))).toBeNull();
    expect(await s.store.submit((tx) => s.runtime.slots.denies(tx, { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN } as Slot, cmd: call, scope: "reply", via: via("context-budget", H1) }))).toBeNull();
  });

  it("4. approved at h1, plugin swapped to h2: a command written with via h1 or via h2 both apply (no new question for an update)", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "request", requests: ["chat.send"], grants: { [H1]: grant("request", ["chat.send"]) } }));
    const phone = await device(s, ["read", "reply"]);
    expect((await outcome(s, phone, send(), "reply", via("my.plugin", H1))).kind).toBe("applied");
    expect((await outcome(s, phone, send("2"), "reply", via("my.plugin", H2))).kind).toBe("applied");
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
    expect(result.outcome).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin is not installed on ${NAME}` });
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

  it("review: a prototype-key hash is not a hash to look up (installed by name: applies, no throw); a malformed row is not installed", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "request", requests: ["chat.send"], grants: { [H1]: grant("request", ["chat.send"]) } }));
    const phone = await device(s, ["read", "reply"]);
    const n = ++slotN;
    const first = { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n }, floor: n, inc: s.inc(), cmd: send("p"), via: via("my.plugin", "constructor") } as CmdBody;
    expect(await s.runtime.receive(first, { scope: "reply" })).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });
    const next = { slot: { origin: phone, originEpoch: EPOCH, target: `bot:${BOT}`, n: n + 1 }, floor: n, inc: s.inc(), cmd: send("q") } as CmdBody;
    expect(await s.runtime.receive(next, { scope: "reply" })).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });
    slotN = n + 1;
    await s.store.submit((tx) => {
      const body = JSON.parse(String(tx.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'plugin:my.plugin'").get(s.stream)!.body));
      body.grants[H1].tier = "admin";
      tx.prepare("UPDATE rows SET body = ? WHERE stream = ? AND key = 'plugin:my.plugin'").run(JSON.stringify(body), s.stream);
    });
    expect(await outcome(s, phone, send("r"), "reply", via())).toEqual({ kind: "refused", reason: "grant", detail: `plugin my.plugin is not installed on ${NAME}` });
  });

  it("review: write plugin 'my' cannot run a command of installed plugin 'my.plugin'", async () => {
    const s = await startServer();
    await seed(s, "my", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "write", grants: {} }));
    const cmd = { type: "plugins.command", id: "my.plugin.go" } as Command;
    const status = await s.runtime.receive({ slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN }, floor: slotN, inc: s.inc(), cmd, via: via("my", H1) } as CmdBody, { scope: "local" });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "grant", detail: `plugin my may not do this on ${NAME}` } } });
  });

  it("review: when the installed-plugins query throws, the nested-name guard fails closed: refused grant, not allowed", async () => {
    const s = await startServer();
    await seed(s, "my", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "write", grants: {} }));
    const cmd = { type: "plugins.command", id: "my.plugin.go" } as Command;
    const input = { slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN } as Slot, cmd, scope: "local" as Scope, via: via("my", H1) };
    // A command of plugin "my" that names its own commands is allowed when the list can be read ...
    const own = { ...input, cmd: { type: "plugins.command", id: "my.go" } as Command };
    expect(await s.store.submit((tx) => s.runtime.slots.denies(tx, own))).toBeNull();
    // ... and refused for every command when the query fails (the proxy makes only that query throw).
    const failing = (tx: Db): Db => new Proxy(tx, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key, target);
        return (sql: string) => {
          if (sql.includes("substr(key, 1, 7)")) throw new Error("forced: installed-plugins query failed");
          return target.prepare(sql);
        };
      },
    });
    for (const c of [own.cmd, cmd]) {
      expect(await s.store.submit((tx) => s.runtime.slots.denies(failing(tx), { ...input, cmd: c })), JSON.stringify(c))
        .toEqual({ reason: "grant", detail: `plugin my may not do this on ${NAME}` });
    }
  });

  it("7. plugin.grant with via stays refused (M5-14a F3), also when the row's grant lists it", async () => {
    const s = await startServer();
    await seed(s, "my.plugin", row({ tier: "write", grants: { [H1]: grant("write", ["plugin.grant"]) } }));
    const cmd = { type: "plugin.grant", plugin: "my.plugin", codeHash: H1, tier: "write", reads: [], requests: [] } as Command;
    const status = await s.runtime.receive({ slot: { origin: "desktop", originEpoch: EPOCH, target: s.stream, n: ++slotN }, floor: slotN, inc: s.inc(), cmd, via: via() } as CmdBody, { scope: "local" });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "grant", detail: "plugin.grant cannot be sent by a plugin" } } });
  });

  it("8. M5-12b F2: helper commands with via in the slot engine (own name only; an approval the manifest did not declare stays refused)", async () => {
    const s = await startServer();
    await seed(s, "builtin-note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "reader", row({ tier: "read", grants: { [H1]: grant("read") } }));

    const tile = (name: string) => ({ type: "plugins.tileImages", name, botId: BOT, data: "{}" }) as unknown as Command;
    const snap = (name: string) => ({ type: "plugins.noteSnapshot", name, botId: BOT, rect: { x: 0, y: 0, width: 10, height: 10 } }) as unknown as Command;
    const ask = (name: string) => ({ type: "plugins.approvalAsk", name, botId: BOT, command: "ls", folder: "/tmp" }) as unknown as Command;
    const approvePlugin = (name: string) => ({ type: "plugins.approve", name, botId: BOT, command: "ls", folder: "/tmp" }) as unknown as Command;
    const deniedByEngine = (cmd: Command, plugin: string) =>
      s.store.submit((tx) => s.runtime.slots.denies(tx, { slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${BOT}`, n: ++slotN } as Slot, cmd, scope: "local", via: via(plugin, H1) }));

    // An installed plugin (any tier record): own tileImages / noteSnapshot / approvalAsk pass; another plugin's name, plugins.approve (a user approval it did not declare) stay refused; chat.react passes.
    expect(await deniedByEngine(tile("builtin-note"), "builtin-note")).toBeNull();
    expect(await deniedByEngine(snap("builtin-note"), "builtin-note")).toBeNull();
    expect(await deniedByEngine(ask("builtin-note"), "builtin-note")).toBeNull();
    expect(await deniedByEngine(tile("other"), "builtin-note")).toEqual({ reason: "grant", detail: `plugin builtin-note may not do this on ${NAME}` });
    expect(await deniedByEngine(snap("other"), "builtin-note")).toEqual({ reason: "grant", detail: `plugin builtin-note may not do this on ${NAME}` });
    expect(await deniedByEngine(ask("other"), "builtin-note")).toEqual({ reason: "grant", detail: `plugin builtin-note may not do this on ${NAME}` });
    expect(await deniedByEngine(approvePlugin("builtin-note"), "builtin-note")).toEqual({ reason: "grant", detail: `plugin builtin-note may not do this on ${NAME}` });
    expect(await deniedByEngine(react(), "builtin-note")).toBeNull();

    // A plugin whose record is the old read tier is installed all the same: the tier decides nothing now.
    expect(await deniedByEngine(tile("reader"), "reader")).toBeNull();
    expect(await deniedByEngine(snap("reader"), "reader")).toBeNull();
    expect(await deniedByEngine(ask("reader"), "reader")).toBeNull();
    expect(await deniedByEngine({ type: "plugins.call", name: "reader", method: "m", params: {}, from: "frame" } as unknown as Command, "reader")).toBeNull();
    expect(await deniedByEngine(send(), "reader")).toBeNull();
  });
});
