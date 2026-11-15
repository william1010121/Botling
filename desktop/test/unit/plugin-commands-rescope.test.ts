// Botling 3 M5-16: plugin commands rescoped from `manage` to `reply` (§11.7, C6, Q-C11). The grant does the limiting:
// a device sends a plugin command only with `via`, within device scope ∩ the plugin's grant at `via.codeHash`; the local
// window keeps working without `via` (2.x buttons). Everything else keeps its scope: the table test below proves that no
// command other than the four became reachable by a lower scope. Real IntentRuntime on a temp folder; no window, no focus.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { COMMAND_SCOPES, DEFAULT_DEVICE_SCOPE, commandScope, memberIdFromKey, remoteCmdRefusal, toBase64Url, type CmdBody, type DeviceScope, type Scope, type Slot, type Via } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { ownTableStream, putRow } from "../../src/server/replica/tables";
import { RosterStore } from "../../src/server/roster";
import { slotAuthorize, statedScope, type DeviceRoster } from "../../src/server/session";
import { PLUGIN_COMMAND_NEEDS_GRANT, pluginCommandNeedsGrant } from "../../src/server/slots/grant-check";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair } from "../../src/session";
import { testRoot } from "../botlingd-harness";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";

const root = testRoot("plugin-rescope");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const PEER_ID = "srv-peer-1";
const NAME = "build-box";
const PLUGIN_COMMANDS = ["plugins.command", "plugins.linkCommand", "plugins.tabCommand", "plugins.call"] as const;
const DEFAULT: DeviceScope[] = [...DEFAULT_DEVICE_SCOPE];
let folders = 0;

const link = (id: string) => ({ type: "plugins.linkCommand", id, botId: BOT, messageId: "m1", url: "https://x.test/a.pdf" }) as unknown as Command;
const tab = (id: string) => ({ type: "plugins.tabCommand", id, botId: BOT, tabId: "t1", url: "https://x.test/a.pdf" }) as unknown as Command;
const pcommand = (id: string, extra: object = {}) => ({ type: "plugins.command", id, ...extra }) as unknown as Command;
const pcall = (name: string) => ({ type: "plugins.call", name, method: "start", params: {}, from: "web" }) as unknown as Command;
/** One command of each of the four types that names plugin `plugin`. */
const own = (plugin: string): Command[] => [pcommand(`${plugin}.go`), link(`${plugin}.go`), tab(`${plugin}.go`), pcall(plugin)];

function row(over: { codeHash?: string; tier?: "read" | "request" | "write"; requests?: string[]; grants?: Record<string, unknown> } = {}): PluginRow {
  return {
    codeHash: over.codeHash ?? H1,
    manifest: { tier: over.tier ?? "write", reads: [], requests: over.requests ?? [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "user",
    grants: over.grants ?? {},
  } as PluginRow;
}
const grant = (tier: "read" | "request" | "write", requests: string[] = []) => ({ tier, reads: [], requests, grantedBy: "user", at: 1 });
const via = (plugin = "note", codeHash = H1): Via => ({ plugin, codeHash });

// --- the scope table -------------------------------------------------------------------------------------------------
describe("M5-16: the scope table (nothing but the four moved)", () => {
  it("the four plugin commands need `reply`; the rest of the plugin family still needs `manage`", () => {
    for (const type of PLUGIN_COMMANDS) expect(COMMAND_SCOPES[type], type).toBe("reply");
    for (const type of ["plugins.enable", "plugins.storeInstall", "plugins.storeDismiss", "plugins.revert", "plugins.remove", "plugins.setting", "plugins.secret", "plugins.approvalAsk", "plugins.tileImages", "plugin.grant"] as const) {
      expect(COMMAND_SCOPES[type], type).toBe("manage");
    }
    expect(COMMAND_SCOPES["plugins.approve"]).toBe("approve");
  });

  it("every other command keeps the scope it had at the base (hash of the table without the four, taken at bb212ac7)", () => {
    const rest = Object.entries(COMMAND_SCOPES).filter(([type]) => !(PLUGIN_COMMANDS as readonly string[]).includes(type)).map(([type, scope]) => `${type}:${scope}`).sort();
    expect(rest).toHaveLength(119);
    expect(createHash("sha256").update(rest.join("\n")).digest("hex")).toBe("fe1c68fea62cf028df0a976bf2a1913f4b757422f5bf5be3ceee25204a79ca99");
    // The `reply` list read as words, so a diff is readable: the old reply commands plus exactly the four.
    const reply = Object.entries(COMMAND_SCOPES).filter(([, scope]) => scope === "reply").map(([type]) => type).sort();
    expect(reply).toEqual([
      "agent.message", "chat.answer", "chat.choose", "chat.ignoreQuestion", "chat.react", "chat.send", "files.data", "files.remove", "handoff.stop",
      "plugins.call", "plugins.command", "plugins.linkCommand", "plugins.tabCommand", "rounds.stop", "turn.stop", "waiting.ignore",
    ]);
  });

  it("the accepting server's scope check: reply is enough for the four; read-only is refused; the rest still needs manage", () => {
    for (const cmd of own("note")) {
      expect(remoteCmdRefusal(cmd, DEFAULT), cmd.type).toBeNull();
      expect(remoteCmdRefusal(cmd, ["read"]), cmd.type).toBe(`${cmd.type} needs the reply scope`);
      expect(remoteCmdRefusal(cmd, ["read", "approve"]), cmd.type).toBe(`${cmd.type} needs the reply scope`);
      expect(statedScope(cmd)).toBe("reply");
    }
    const others: Command[] = [
      { type: "plugins.enable", name: "note", enabled: true }, { type: "plugins.remove", name: "note" }, { type: "plugins.setting", name: "note", key: "k", value: "v" },
      { type: "plugins.secret", name: "note", key: "k", value: "v" }, { type: "plugins.storeInstall", name: "note" }, { type: "plugins.approvalAsk", botId: BOT } as never,
      { type: "plugin.grant", plugin: "note", codeHash: H1, tier: "write", reads: [], requests: [] },
    ] as unknown as Command[];
    for (const cmd of others) {
      expect(commandScope(cmd), cmd.type).toBe("manage");
      expect(remoteCmdRefusal(cmd, DEFAULT), cmd.type).toBe(`${cmd.type} needs the manage scope`);
    }
  });
});

describe("M5-16: pluginCommandNeedsGrant (pure)", () => {
  it("only a plugin command, and only from a scope other than the local window, needs the grant; fail closed on anything unknown", () => {
    for (const cmd of own("note")) {
      for (const scope of ["read", "reply", "approve", "manage", "admin"] as Scope[]) {
        expect(pluginCommandNeedsGrant(cmd, scope), `${cmd.type} ${scope}`).toEqual({ reason: "grant", detail: PLUGIN_COMMAND_NEEDS_GRANT });
      }
      expect(pluginCommandNeedsGrant(cmd, "local")).toBeNull();
      expect(pluginCommandNeedsGrant(cmd, undefined as never)).not.toBeNull();
      expect(pluginCommandNeedsGrant(cmd, "LOCAL" as never)).not.toBeNull();
    }
    expect(PLUGIN_COMMAND_NEEDS_GRANT).toBe("plugin commands from a device need the plugin's grant");
    // Not a plugin command of the four: untouched (their own scope rules apply).
    for (const type of ["chat.send", "plugins.enable", "plugins.remove", "plugins.approve", "plugin.grant"]) {
      expect(pluginCommandNeedsGrant({ type } as unknown as Command, "reply"), type).toBeNull();
    }
  });
});

// --- the owner in a real slot engine -----------------------------------------------------------------------------------
interface Server { store: ServerStore; roster: RosterStore; runtime: IntentRuntime; engine: FakeTurnEngine; serverId: string; valid: Set<string>; inc(): string }

async function startServer(): Promise<Server> {
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
  return { store, roster, runtime, engine, serverId, valid, inc: () => String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId) };
}

async function device(s: Server, scope: DeviceScope[]): Promise<string> {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  await s.roster.addDevice({ keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) }, name: "Phone", scope });
  return member;
}

const seed = (s: Server, name: string, body: PluginRow) => s.store.submit((tx) => { putRow(tx, ownTableStream(tx), `plugin:${name}`, body); });

let slotN = 0;
function body(s: Server, origin: string, cmd: Command, withVia?: Via): CmdBody {
  // A command about a bot goes to that bot's stream; the others (plugins.command, plugins.call) go to this server's.
  const target = "botId" in cmd ? `bot:${BOT}` : `srv:${s.serverId}`;
  return { slot: { origin, originEpoch: EPOCH, target, n: ++slotN } as Slot, floor: slotN, inc: s.inc(), cmd, ...(withVia ? { via: withVia } : {}) } as CmdBody;
}
/** The owner's outcome for a command sent from `origin` under the scope a remote session states for it. */
async function outcome(s: Server, origin: string, cmd: Command, scope: Scope, withVia?: Via) {
  const status = await s.runtime.receive(body(s, origin, cmd, withVia), { scope });
  if (status.status !== "result") throw new Error(`no result: ${status.status}`);
  return status.message.outcome;
}
const asPhone = (s: Server, origin: string, cmd: Command, withVia?: Via) => outcome(s, origin, cmd, statedScope(cmd), withVia);
const ran = (s: Server) => s.engine.runs.map((cmd) => cmd.type);
const GRANT_REFUSED = { kind: "refused", reason: "grant", detail: PLUGIN_COMMAND_NEEDS_GRANT };

describe("M5-16: a default phone and a plugin's button", () => {
  it("1. via of a request-tier plugin whose `requests` holds the command: applied, and the handler runs", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "request", requests: ["plugins.linkCommand"], grants: { [H1]: grant("request", ["plugins.linkCommand"]) } }));
    const phone = await device(s, DEFAULT);
    expect((await asPhone(s, phone, link("note.coach"), via())).kind).toBe("applied");
    expect(ran(s)).toEqual(["plugins.linkCommand"]);
    // The grant lists linkCommand only: the other three are refused grant, whatever their target (the handler never runs).
    for (const cmd of [pcommand("note.coach"), tab("note.coach"), pcall("note")]) {
      expect(await asPhone(s, phone, cmd, via()), cmd.type).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin note may not do this on ${NAME}` });
    }
    expect(ran(s)).toEqual(["plugins.linkCommand"]);
  });

  it("2. the same command without via: refused grant (all four types), for a default phone, a manage device and a peer server; the handler never runs", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write", ["plugins.linkCommand"]) } }));
    const phone = await device(s, DEFAULT);
    const admin = await device(s, [...DEFAULT, "manage"]);
    for (const cmd of [link("note.coach"), ...own("note")]) {
      expect(await asPhone(s, phone, cmd), `phone ${cmd.type}`).toEqual(GRANT_REFUSED);
      expect(await asPhone(s, admin, cmd), `manage ${cmd.type}`).toEqual(GRANT_REFUSED);
      expect(await outcome(s, PEER_ID, cmd, "reply"), `peer ${cmd.type}`).toEqual(GRANT_REFUSED);
    }
    expect(ran(s)).toEqual([]);
  });

  it("3. plugins.call naming another plugin than via.plugin: refused grant (write tier, request tier, and a read tier)", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "other", row({ tier: "write", grants: { [H1]: grant("write") } }));
    const phone = await device(s, DEFAULT);
    expect(await asPhone(s, phone, pcall("other"), via("note"))).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin note may not do this on ${NAME}` });
    expect((await asPhone(s, phone, pcall("note"), via("note"))).kind).toBe("applied");
    expect(ran(s)).toEqual(["plugins.call"]);
    s.engine.runs.length = 0;
    await seed(s, "req", row({ tier: "request", grants: { [H1]: grant("request", ["chat.send"]) } }));
    await seed(s, "ro", row({ tier: "read", grants: { [H1]: grant("read") } }));
    for (const plugin of ["req", "ro"]) expect(await asPhone(s, phone, pcall(plugin), via(plugin)), plugin).toMatchObject({ kind: "refused", reason: "grant" });
    // An explicit cross-plugin request entry in the grant (C6) is the only way across.
    await seed(s, "note", row({ tier: "request", grants: { [H1]: grant("request", ["plugins.call"]) } }));
    expect((await asPhone(s, phone, pcall("other"), via("note"))).kind).toBe("applied");
    expect(ran(s)).toEqual(["plugins.call"]);
  });

  it("4. the local window without via keeps working for all four (2.x buttons); a local command with via is still grant-checked", async () => {
    const s = await startServer();
    for (const cmd of own("note")) expect((await outcome(s, "desktop", cmd, "local")).kind, cmd.type).toBe("applied");
    expect(ran(s)).toEqual(["plugins.command", "plugins.linkCommand", "plugins.tabCommand", "plugins.call"]);
    s.engine.runs.length = 0;
    expect(await outcome(s, "desktop", pcall("note"), "local", via())).toMatchObject({ kind: "refused", reason: "grant" });
    expect(ran(s)).toEqual([]);
  });

  it("5. a device with only `read`: refused scope (not grant), with or without via; the handler never runs", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    const watcher = await device(s, ["read"]);
    for (const cmd of own("note")) {
      expect(await asPhone(s, watcher, cmd, via()), `via ${cmd.type}`).toMatchObject({ kind: "refused", reason: "scope" });
      expect(await asPhone(s, watcher, cmd), cmd.type).toMatchObject({ kind: "refused", reason: "scope" });
    }
    expect(ran(s)).toEqual([]);
  });

  it("6. a refused command sent again (double submit, resend) gives the same refusal and never runs the handler", async () => {
    const s = await startServer();
    const phone = await device(s, DEFAULT);
    const cmd = pcall("note");
    const first = body(s, phone, cmd);
    const a = await s.runtime.receive(first, { scope: "reply" });
    const b = await s.runtime.receive(first, { scope: "reply" });
    expect(a).toMatchObject({ status: "result", message: { outcome: GRANT_REFUSED } });
    expect(b).toMatchObject({ status: "result", message: { outcome: GRANT_REFUSED } });
    expect(ran(s)).toEqual([]);
  });
});

describe("M5-16: no other command became reachable by a lower scope", () => {
  const HOSTILE = ["plugins.enable", "plugins.remove", "plugins.setting", "plugins.secret", "plugins.storeInstall", "plugins.storeDismiss", "plugins.revert", "plugins.approvalAsk", "plugins.tileImages", "plugin.grant", "bots.create", "settings.set"];
  const make = (type: string): Command => ({
    "plugins.enable": { type, name: "note", enabled: true }, "plugins.remove": { type, name: "note" }, "plugins.setting": { type, name: "note", key: "k", value: "v" },
    "plugins.secret": { type, name: "note", key: "k", value: "v" }, "plugins.storeInstall": { type, name: "note" }, "plugins.storeDismiss": { type, name: "note" },
    "plugins.revert": { type, name: "note" }, "plugins.approvalAsk": { type, botId: BOT }, "plugins.tileImages": { type, name: "note" },
    "plugin.grant": { type, plugin: "note", codeHash: H1, tier: "write", reads: [], requests: [] },
    "bots.create": { type, name: "x" }, "settings.set": { type, change: { key: "theme", value: "dark" } },
  } as Record<string, unknown>)[type] as Command;

  it("a plugin granted every other command by a hostile row, on a default phone: each is refused scope, the handler never runs", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", requests: HOSTILE, grants: { [H1]: grant("write", HOSTILE) } }));
    const phone = await device(s, DEFAULT);
    for (const type of HOSTILE) {
      const cmd = make(type);
      expect(await outcome(s, phone, cmd, statedScope(cmd), via()), type).toMatchObject({ kind: "refused", reason: expect.stringMatching(/^(scope|grant)$/) });
    }
    expect(ran(s)).toEqual([]);
    // Without via, the default phone is refused for the same commands too (scope: it has no manage).
    for (const type of HOSTILE) {
      const cmd = make(type);
      expect(await outcome(s, phone, cmd, statedScope(cmd)), type).toMatchObject({ kind: "refused", reason: "scope" });
    }
    expect(ran(s)).toEqual([]);
  });

  it("a stated scope that does not match the command is refused at the owner (a phone cannot state `reply` for plugins.remove)", async () => {
    const s = await startServer();
    const phone = await device(s, DEFAULT);
    expect(await outcome(s, phone, make("plugins.remove"), "reply")).toMatchObject({ kind: "refused", reason: "scope" });
    expect(await outcome(s, phone, make("plugins.remove"), "reply", via())).toMatchObject({ kind: "refused", reason: "scope" });
    expect(ran(s)).toEqual([]);
  });
});

describe("M5-16: dotted plugin names (M5-15 F2): a default phone reaches `reply`, so `my` must never run `my.plugin`'s commands", () => {
  it("write plugin `my`, plugin `my.plugin` installed: every route to my.plugin.go is refused grant; my.go still applies", async () => {
    const s = await startServer();
    await seed(s, "my", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await seed(s, "my.plugin", row({ codeHash: H2, tier: "write", grants: { [H2]: grant("write") } }));
    const phone = await device(s, DEFAULT);
    const refused = { kind: "refused", reason: "grant", detail: `plugin my may not do this on ${NAME}` };
    for (const cmd of [pcommand("my.plugin.go"), link("my.plugin.go"), tab("my.plugin.go"), pcall("my.plugin"), pcommand("my.plugin.go", { from: "frame", name: "my" })]) {
      expect(await asPhone(s, phone, cmd, via("my", H1)), cmd.type).toEqual(refused);
    }
    expect(ran(s)).toEqual([]);
    for (const cmd of [pcommand("my.go"), link("my.go"), tab("my.go"), pcall("my")]) expect((await asPhone(s, phone, cmd, via("my", H1))).kind, cmd.type).toBe("applied");
    // The other way: `my.plugin` is not given `my`'s commands either (its own prefix is `my.plugin.`).
    s.engine.runs.length = 0;
    for (const cmd of [pcommand("my.go"), link("my.go"), tab("my.go"), pcall("my")]) expect(await asPhone(s, phone, cmd, via("my.plugin", H2)), cmd.type).toMatchObject({ kind: "refused", reason: "grant" });
    expect(ran(s)).toEqual([]);
    // And `my.plugin` runs its own.
    for (const cmd of [pcommand("my.plugin.go"), pcall("my.plugin")]) expect((await asPhone(s, phone, cmd, via("my.plugin", H2))).kind, cmd.type).toBe("applied");
  });

  it("a page's own claims do not widen it: `name`/`from` of plugins.command are not identity, via is", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    const phone = await device(s, DEFAULT);
    expect(await asPhone(s, phone, pcommand("other.go", { from: "frame", name: "note" }), via("note"))).toMatchObject({ kind: "refused", reason: "grant" });
    expect(await asPhone(s, phone, pcommand("other.go", { from: "chat" }), via("note"))).toMatchObject({ kind: "refused", reason: "grant" });
    expect(ran(s)).toEqual([]);
  });
});

describe("M5-16: hostile keys and fail-closed grant lookups on a plugin command", () => {
  it("a prototype-key via.codeHash on a plugin command is refused grant (no throw) and the queue moves on", async () => {
    const s = await startServer();
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    const phone = await device(s, DEFAULT);
    for (const h of ["constructor", "__proto__", "toString"]) {
      expect(await asPhone(s, phone, pcall("note"), via("note", h)), h).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin note differs on ${NAME}` });
    }
    expect((await asPhone(s, phone, pcall("note"), via("note", H1))).kind).toBe("applied");
    expect(ran(s)).toEqual(["plugins.call"]);
  });

  it("a plugin swapped to new code: a command written at the old hash applies (C12); at the new hash it has no grant yet", async () => {
    const s = await startServer();
    await seed(s, "note", row({ codeHash: H2, tier: "write", grants: { [H1]: grant("write") } }));
    const phone = await device(s, DEFAULT);
    expect((await asPhone(s, phone, pcall("note"), via("note", H1))).kind).toBe("applied");
    expect(await asPhone(s, phone, pcall("note"), via("note", H2))).toMatchObject({ kind: "refused", reason: "grant", detail: `plugin note may not do this on ${NAME}` });
  });

  it("a malformed row, a missing row and a removed device: refused, handler never runs", async () => {
    const s = await startServer();
    const phone = await device(s, DEFAULT);
    expect(await asPhone(s, phone, pcall("ghost"), via("ghost"))).toMatchObject({ kind: "refused", reason: "grant" });
    await seed(s, "note", row({ tier: "write", grants: { [H1]: grant("write") } }));
    await s.store.submit((tx) => {
      const stream = ownTableStream(tx);
      const stored = JSON.parse(String(tx.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'plugin:note'").get(stream)!.body));
      stored.grants[H1].tier = "admin";
      tx.prepare("UPDATE rows SET body = ? WHERE stream = ? AND key = 'plugin:note'").run(JSON.stringify(stored), stream);
    });
    expect(await asPhone(s, phone, pcall("note"), via("note"))).toMatchObject({ kind: "refused", reason: "grant" });
    expect(await asPhone(s, "not-a-device", pcall("note"), via("note"))).toMatchObject({ kind: "refused", reason: "origin" });
    expect(ran(s)).toEqual([]);
  });
});
