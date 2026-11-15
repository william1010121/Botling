// @vitest-environment jsdom
// M5-12b (Q-C12 / D53): FrameBroker attribution flows down the request path (`request(cmd, via)`):
//   - desktop path: pluginFrameHost -> Client -> Bridge.post(envelope, via) -> preload -> main -> ServerClient -> RendererAdapter -> FeLink
//   - page path:    pluginFrameHost -> Client -> BridgeV3.post(envelope, via) -> RendererAdapter -> FeLink
// RendererAdapter looks up the plugin's current `codeHash` in the attached server's `plugin:<name>` row and passes
// `{ plugin, codeHash }` to `FeLink.submit`. Missing/unreadable row refuses locally with
// `"not sent: the plugin is not installed on this machine"`. Omitting `via` leaves 2.x behavior completely unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BotView, type Command, type ComponentInfoView } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter, type LinkPort } from "../../src/main-v3/renderer-adapter";
import { ServerClient } from "../../src/main-v3/server-client";
import type { CoreClientOptions } from "../../src/main/core-client";
import type { Via } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import { Client, type Bridge } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { BridgeV3 } from "../../web-v3/bridge-v3";
import { FakeClock, FakeServer, flush, SERVER_ID, SRV_STREAM } from "./fe-link-harness";

const BOT = "6A0B0000-0000-4000-8000-000000000021";
const BOTS = [{ id: BOT, role: "main", name: "Main" }] as BotView[];
const COMPONENTS = {
  tile: { template: "<div></div>", version: 1, updated: false, sizes: ["2x2"] } as ComponentInfoView,
} satisfies Record<string, ComponentInfoView>;

const HASH_1 = "sha256:" + "11".repeat(32);
const HASH_2 = "sha256:" + "22".repeat(32);
const HASH_OTHER = "sha256:" + "33".repeat(32);

function pluginRow(codeHash: string, over: Partial<PluginRow> = {}): PluginRow {
  return {
    codeHash,
    manifest: {
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send", "plugins.call", "plugins.command", "plugins.tileImages", "plugins.approvalAsk"],
      owns: [],
      provides: [],
      requires: [],
      uses: [],
      clients: [],
      needsShell: [],
    },
    author: "user",
    grants: {},
    ...over,
  };
}

let epochSeq = 0;
const nextEpoch = () => (++epochSeq).toString(16).padStart(32, "0");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.innerHTML = "";
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setupAdapterWithPluginTable(rows: Map<string, unknown> | null) {
  const server = new FakeServer();
  const clock = new FakeClock();
  const link = await FeLink.open({
    storage: new MemoryFeStorage(),
    dial: server.dial,
    deviceId: "desktop",
    feVersion: "3.0.0",
    clock,
    newEpoch: nextEpoch,
    local: true,
  });
  link.start();
  await flush();

  // Wrap FeLink as LinkPort supplying the attached server's own table copy (delivered by M5-14e in production).
  const port: LinkPort = {
    get status() { return link.status; },
    get server() { return link.server; },
    on: (listener) => link.on(listener),
    subscribe: (stream) => link.subscribe(stream),
    unsubscribe: (stream) => link.unsubscribe(stream),
    dropCache: (stream) => link.dropCache(stream),
    submit: (target, cmd, basis, via) => link.submit(target, cmd, basis, via),
    dismiss: (slot) => link.dismiss(slot),
    dismissRestored: () => link.dismissRestored(),
    pending: (target) => link.pending(target),
    cursor: (stream) => link.cursor(stream),
    request: (cmd) => link.request(cmd),
    history: (stream, before, bytes) => link.history(stream, before, bytes),
    servers: () => link.servers(),
    ownerOf: (target) => link.ownerOf(target),
    table: (serverId) => {
      if (serverId === SERVER_ID && rows !== null) {
        return { rows };
      }
      return link.table(serverId);
    },
    staleSince: (stream) => link.staleSince(stream),
  };

  const adapter = new RendererAdapter({ link: port, clock, emit: () => undefined });
  adapter.start();
  cleanups.push(async () => { adapter.stop(); await link.stop(); });
  return { server, clock, link, port, adapter };
}

function makeSandboxFrame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const replies: unknown[] = [];
  element.contentWindow!.postMessage = ((msg: unknown) => { replies.push(msg); }) as Window["postMessage"];
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const send = (data: unknown) => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
  };
  return { element, replies, send };
}

describe("M5-12b: frame broker attribution -> via on outbox items", () => {
  it("page bridge path stamps via { plugin, codeHash } from attached server's plugin: row for broker commands", async () => {
    const rows = new Map<string, unknown>([
      ["plugin:notes-helper", pluginRow(HASH_1)],
      ["plugin:other", pluginRow(HASH_OTHER)],
    ]);
    const { server, adapter } = await setupAdapterWithPluginTable(rows);
    const bridge = new BridgeV3(adapter, {
      openLink: () => undefined,
      narrow: () => false,
      scopes: ["read", "reply", "approve", "manage"],
    });
    const client = new Client(bridge);
    const broker = new FrameBroker(window, { name: "m5-12b test" });
    cleanups.push(() => { broker.dispose(); bridge.close(); });

    const frame = makeSandboxFrame();
    const askCalls: Array<{ approve: Command }> = [];
    registerPluginFrame(
      broker,
      pluginFrameHost({
        client,
        components: () => COMPONENTS,
        bots: () => BOTS,
        ask: (_view, approve, done) => {
          askCalls.push({ approve });
          // Simulate ApprovalSheet clicking Allow without any via parameter.
          void client.request(approve).then(() => done(true), () => done(false));
        },
      }),
      { frame: frame.element, plugin: "notes-helper" },
    );

    // 1. ccb.call -> plugins.call carries via { plugin: "notes-helper", codeHash: HASH_1 }
    frame.send({ ccb: "call", id: 1, method: "ping", params: { a: 1 } });
    await flush();
    expect(server.copies).toHaveLength(1);
    expect(server.copies[0].cmd).toMatchObject({ type: "plugins.call", name: "notes-helper", method: "ping" });
    expect(server.copies[0].via).toEqual({ plugin: "notes-helper", codeHash: HASH_1 } satisfies Via);

    // 2. ccb.command -> plugins.command carries via { plugin: "notes-helper", codeHash: HASH_1 }
    frame.send({ ccb: "command", id: "notes-helper.refresh" });
    await flush();
    expect(server.copies).toHaveLength(2);
    expect(server.copies[1].cmd).toMatchObject({ type: "plugins.command", id: "notes-helper.refresh", name: "notes-helper" });
    expect(server.copies[1].via).toEqual({ plugin: "notes-helper", codeHash: HASH_1 });

    // 3. Hot swap changes row's codeHash -> next command stamps HASH_2
    rows.set("plugin:notes-helper", pluginRow(HASH_2));
    frame.send({ ccb: "call", id: 2, method: "ping", params: null });
    await flush();
    expect(server.copies).toHaveLength(3);
    expect(server.copies[2].via).toEqual({ plugin: "notes-helper", codeHash: HASH_2 });

    // 4. ccb.requestApproval: plugins.approvalAsk carries via into server.copies
    frame.send({ ccb: "approval", id: 3, botId: BOT, command: "echo hi", folder: "/tmp/p" });
    await flush();
    expect(server.copies).toHaveLength(4);
    expect(server.copies[3].cmd.type).toBe("plugins.approvalAsk");
    expect(server.copies[3].via).toEqual({ plugin: "notes-helper", codeHash: HASH_2 });

    // 5. Spoofed cmd.name ("other") still gets attributed to via.plugin ("notes-helper") + HASH_2, never "other".
    await (adapter as unknown as {
      request(cmd: Command, via?: { plugin: string }): Promise<unknown>;
    }).request(
      { type: "plugins.call", name: "other", method: "steal", params: null, from: "frame" },
      { plugin: "notes-helper" },
    );
    expect(server.copies).toHaveLength(5);
    expect(server.copies[4].via).toEqual({ plugin: "notes-helper", codeHash: HASH_2 });

    // 6. When plugins.approvalAsk asks for confirmation, ApprovalSheet's plugins.approve NEVER carries via.
    const approvalBridge = new BridgeV3(
      {
        request: (cmd, via) => {
          if (cmd.type === "plugins.approvalAsk") {
            return Promise.resolve({ ok: true, result: { needsApproval: { command: "echo hi", folder: "/tmp/p", card: "c", detail: null } } });
          }
          return (adapter as unknown as { request(c: Command, v?: { plugin: string }): ReturnType<RendererAdapter["request"]> }).request(cmd, via);
        },
      },
      { openLink: () => undefined, narrow: () => false, scopes: ["read", "reply", "approve", "manage"] },
    );
    cleanups.push(() => approvalBridge.close());
    const approvalClient = new Client(approvalBridge);
    const approvalHost = pluginFrameHost({
      client: approvalClient,
      components: () => COMPONENTS,
      bots: () => BOTS,
      ask: (_view, approve, done) => {
        askCalls.push({ approve });
        // Simulate ApprovalSheet clicking Allow without any via parameter.
        void approvalClient.request(approve).then(() => done(true), () => done(false));
      },
    });
    const approvalResult = await approvalHost.requestApproval!("notes-helper", { botId: BOT, command: "echo hi", folder: "/tmp/p" });
    expect(approvalResult).toEqual({ allowed: true });
    expect(askCalls).toHaveLength(1);
    expect(server.copies).toHaveLength(6);
    expect(server.copies[5].cmd.type).toBe("plugins.approve");
    expect("via" in server.copies[5]).toBe(false);
  });

  it("desktop ServerClient.request passes optional via to RendererAdapter and omits it when omitted", async () => {
    const server = new FakeServer();
    const sc = new ServerClient(
      {
        script: "/build/out/core/main.cjs",
        env: { BOTLING_APP_DATA_DIR: "/app-data" },
        onEvent: () => undefined,
        audit: () => undefined,
      } satisfies Pick<CoreClientOptions, "script" | "env" | "onEvent" | "audit">,
      {
        dial: server.dial,
        storage: () => new MemoryFeStorage(),
        clock: new FakeClock(),
        readToken: () => "t".repeat(32),
        feVersion: "3.0.0",
      },
    );
    cleanups.push(() => sc.stop());
    sc.start();
    await sc.ready();
    await flush();

    // Without via -> submitted without via key (2.x/shell call).
    const plainRes = await (sc as unknown as {
      request(cmd: Command, id?: string, via?: { plugin: string }): Promise<unknown>;
    }).request({ type: "chat.react", botId: BOT, messageId: "m1", emoji: "👍", present: true }, "w1.1");
    expect(plainRes).toMatchObject({ ok: true });
    expect("via" in server.copies[0]).toBe(false);

    // With via when no plugin: row exists -> refused locally with exact message, nothing sent.
    const refused = await (sc as unknown as {
      request(cmd: Command, id?: string, via?: { plugin: string }): Promise<unknown>;
    }).request({ type: "plugins.call", name: "notes-helper", method: "ping", params: null, from: "frame" }, "w1.2", { plugin: "notes-helper" });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
    });
    expect(server.copies).toHaveLength(1);
  });

  it("omitting via on Client.request calls bridge.post with 1 argument (2.x unchanged); pluginFrameHost passes via", async () => {
    const postCalls: unknown[][] = [];
    let receive: (msg: unknown) => void = () => undefined;
    const bridge: Bridge = {
      protocol: PROTOCOL_VERSION,
      subscribe(listener) { receive = listener; return () => undefined; },
      post(...args: unknown[]) {
        postCalls.push(args);
        const env = args[0] as { id: string; cmd: Command };
        queueMicrotask(() => {
          const result = env.cmd.type === "plugins.tileImages"
            ? { images: {} }
            : env.cmd.type === "card.page"
              ? { url: "botling-card://page/" + "a".repeat(36) }
              : env.cmd.type === "plugins.noteSnapshot"
                ? { ref: "note-assets/x.png", url: "botling-card://image/x" }
                : env.cmd.type === "plugins.openLink"
                  ? { opened: true }
                  : env.cmd.type === "plugins.approvalAsk"
                    ? { needsApproval: null }
                    : { result: "ok" };
          receive({ v: PROTOCOL_VERSION, id: env.id, ok: true, result });
        });
      },
    };
    const client = new Client(bridge);

    // 2.x direct call: no 2nd arg at all!
    await client.request({ type: "chat.read", botId: BOT });
    expect(postCalls[0]).toHaveLength(1);
    expect(postCalls[0][0]).toEqual({ v: PROTOCOL_VERSION, id: "r1", cmd: { type: "chat.read", botId: BOT } });

    const host = pluginFrameHost({
      client,
      components: () => COMPONENTS,
      bots: () => BOTS,
      ask: (_v, _a, done) => done(false),
    });
    const fakeFrame = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect,
    } as HTMLIFrameElement;

    await host.call("my-plugin", "run", {});
    await host.command("my-plugin", "my-plugin.go");
    await host.tile!("my-plugin", { component: "tile", data: { x: 1 }, size: "2x2" as never, botId: BOT });
    await host.card!("my-plugin", { component: "tile", data: { x: 1 }, botId: BOT });
    await host.snapshot!("my-plugin", fakeFrame, { botId: BOT, rect: { x: 0, y: 0, width: 50, height: 50 } });
    await host.openLink!("my-plugin", { botId: BOT, href: "https://example.com" });
    await host.requestApproval!("my-plugin", { botId: BOT, command: "ls", folder: "/tmp" });

    // Every single pluginFrameHost request carries { plugin: "my-plugin" } as the 2nd post argument.
    const brokerCalls = postCalls.slice(1);
    expect(brokerCalls.length).toBeGreaterThanOrEqual(7);
    for (const callArgs of brokerCalls) {
      expect(callArgs).toHaveLength(2);
      expect(callArgs[1]).toEqual({ plugin: "my-plugin" });
    }
  });

  it("preload post forwards optional via only when defined, keeping 2.x 1-arg post unchanged", async () => {
    const sent: unknown[][] = [];
    let exposed: { post(env: unknown, via?: { plugin: string }): void } | null = null;
    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld(name: string, api: unknown) {
          if (name === "botling") exposed = api as typeof exposed;
        },
      },
      ipcRenderer: {
        on: () => undefined,
        send: (...args: unknown[]) => { sent.push(args); },
      },
      webUtils: { getPathForFile: () => "" },
    }));
    await import("../../src/preload/preload");
    expect(exposed).not.toBeNull();
    exposed!.post({ v: PROTOCOL_VERSION, id: "r1", cmd: { type: "chat.snapshot" } });
    exposed!.post({ v: PROTOCOL_VERSION, id: "r2", cmd: { type: "plugins.call", name: "p", method: "m", params: null, from: "frame" } }, { plugin: "p" });

    expect(sent[0]).toEqual(["botling:post", { v: PROTOCOL_VERSION, id: "r1", cmd: { type: "chat.snapshot" } }]);
    expect(sent[1]).toEqual(["botling:post", { v: PROTOCOL_VERSION, id: "r2", cmd: { type: "plugins.call", name: "p", method: "m", params: null, from: "frame" } }, { plugin: "p" }]);
  });

  it("refuses locally fail-closed when plugin row is missing, table is null, row is malformed, via is malformed, or local shortcuts carry via", async () => {
    const rows = new Map<string, unknown>([
      ["plugin:broken", { codeHash: HASH_1, grants: "invalid-not-object" }],
      ["plugin:valid", pluginRow(HASH_1)],
    ]);
    const openLinkSpy = vi.fn();
    const removeSpy = vi.fn();
    const { server, link, adapter } = await setupAdapterWithPluginTable(rows);
    const bridge = new BridgeV3(adapter, {
      openLink: openLinkSpy,
      narrow: () => false,
      scopes: ["read", "reply", "approve", "manage"],
      uploads: {
        owns: () => true,
        remove: removeSpy,
        pending: () => [],
        take: async () => [],
        untake: () => undefined,
        onChipsChanged: () => () => undefined,
      },
    });
    cleanups.push(() => bridge.close());

    // Missing plugin:<name> row (including JS object-property name like "constructor")
    for (const missingName of ["not-installed", "constructor"]) {
      const missing = await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
        { type: "plugins.call", name: missingName, method: "m", params: null, from: "frame" },
        { plugin: missingName },
      );
      expect(missing).toEqual({
        ok: false,
        error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
      });
    }

    // Malformed row
    const broken = await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.call", name: "broken", method: "m", params: null, from: "frame" },
      { plugin: "broken" },
    );
    expect(broken).toEqual({
      ok: false,
      error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
    });

    // Null table (link.table(server) returns null)
    const nullTableAdapter = new RendererAdapter({
      link: {
        get status() { return link.status; },
        get server() { return SERVER_ID; },
        on: (l) => link.on(l),
        subscribe: (s) => link.subscribe(s),
        unsubscribe: (s) => link.unsubscribe(s),
        dropCache: (s) => link.dropCache(s),
        submit: (t, c, b, v) => link.submit(t, c, b, v),
        dismiss: (s) => link.dismiss(s),
        dismissRestored: () => link.dismissRestored(),
        pending: (t) => link.pending(t),
        cursor: (s) => link.cursor(s),
        request: (c) => link.request(c),
        history: (s, b, by) => link.history(s, b, by),
        table: () => null,
      },
      clock: new FakeClock(),
      emit: () => undefined,
    });
    nullTableAdapter.start();
    cleanups.push(() => nullTableAdapter.stop());
    const noTable = await (nullTableAdapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.call", name: "valid", method: "m", params: null, from: "frame" },
      { plugin: "valid" },
    );
    expect(noTable).toEqual({
      ok: false,
      error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
    });

    // Malformed via on BridgeV3.post -> fails closed (never strips via and submits as user!)
    const responses: unknown[] = [];
    bridge.subscribe((m) => responses.push(m));
    for (const badVia of [
      { plugin: "../evil" },
      { plugin: "_bad" },
      { plugin: "__proto__" },
      { plugin: "" },
      { plugin: "ValidUpper" },
      { plugin: "valid", extra: true },
      "valid",
      null,
    ]) {
      (bridge as unknown as { post(env: unknown, via?: unknown): void }).post(
        { v: PROTOCOL_VERSION, id: "bad1", cmd: { type: "plugins.call", name: "valid", method: "m", params: null, from: "frame" } },
        badVia,
      );
    }
    await flush();
    expect(responses).toHaveLength(8);
    for (const res of responses) {
      expect(res).toMatchObject({ v: PROTOCOL_VERSION, id: "bad1", ok: false, error: { code: "bad_request" } });
    }

    // Local shortcuts on BridgeV3 must refuse fail-closed when via is set (never run with user authority)
    responses.length = 0;
    (bridge as unknown as { post(env: unknown, via?: unknown): void }).post(
      { v: PROTOCOL_VERSION, id: "loc1", cmd: { type: "settings.set", change: { key: "railCollapsed", value: true } } },
      { plugin: "valid" },
    );
    (bridge as unknown as { post(env: unknown, via?: unknown): void }).post(
      { v: PROTOCOL_VERSION, id: "loc2", cmd: { type: "link.open", botId: BOT, url: "https://example.com" } },
      { plugin: "valid" },
    );
    (bridge as unknown as { post(env: unknown, via?: unknown): void }).post(
      { v: PROTOCOL_VERSION, id: "loc3", cmd: { type: "files.remove", botId: BOT, id: "u1" } },
      { plugin: "valid" },
    );
    await flush();
    expect(responses).toHaveLength(3);
    for (const res of responses) {
      expect(res).toMatchObject({ v: PROTOCOL_VERSION, ok: false, error: { code: "forbidden" } });
    }
    expect(openLinkSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(server.copies).toHaveLength(0);
    expect(link.pending()).toHaveLength(0);

    // Reads with via -> refused fail-closed, never forwarded as req
    const readWithVia = await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "chat.snapshot" },
      { plugin: "valid" },
    );
    expect(readWithVia).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("M5-14e + M5-12b: real FeLink own-rows frames populate link.table(own) for RendererAdapter without a mocked table()", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const link = await FeLink.open({
      storage: new MemoryFeStorage(),
      dial: server.dial,
      deviceId: "desktop",
      feVersion: "3.0.0",
      clock,
      newEpoch: nextEpoch,
      local: true,
    });
    const adapter = new RendererAdapter({ link, clock, emit: () => undefined });
    link.start();
    adapter.start();
    cleanups.push(async () => { adapter.stop(); await link.stop(); });
    await flush();

    // Before the attached server's own rows arrive, resolveVia refuses locally.
    const beforeRows = await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.tileImages", name: "notes-helper", botId: BOT, data: "{}" },
      { plugin: "notes-helper" },
    );
    expect(beforeRows).toEqual({
      ok: false,
      error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
    });
    expect(server.copies).toHaveLength(0);

    // Server sends its own plugin: row over srv:<own> rows frame (M5-14e).
    server.sendWire({
      t: "rows",
      stream: SRV_STREAM,
      logId: "incown01",
      after: 0,
      to: 2,
      rows: [{ key: "plugin:notes-helper", rev: 2, body: pluginRow(HASH_1) }],
      more: false,
    });
    await flush();

    // tileImages, approvalAsk, and noteSnapshot carry { plugin, codeHash: HASH_1 } through real FeLink.
    await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.tileImages", name: "notes-helper", botId: BOT, data: "{}" },
      { plugin: "notes-helper" },
    );
    await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.approvalAsk", name: "notes-helper", botId: BOT, command: "ls", folder: "/tmp" },
      { plugin: "notes-helper" },
    );
    await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.noteSnapshot", name: "notes-helper", botId: BOT, rect: { x: 0, y: 0, width: 10, height: 10 } },
      { plugin: "notes-helper" },
    );
    expect(server.copies).toHaveLength(3);
    expect(server.copies.map((c) => c.cmd.type)).toEqual(["plugins.tileImages", "plugins.approvalAsk", "plugins.noteSnapshot"]);
    expect(server.copies.map((c) => c.via)).toEqual([
      { plugin: "notes-helper", codeHash: HASH_1 },
      { plugin: "notes-helper", codeHash: HASH_1 },
      { plugin: "notes-helper", codeHash: HASH_1 },
    ]);

    // A delta rows frame hot-swaps the hash -> next command stamps HASH_2; tombstone refuses again.
    server.sendWire({
      t: "rows",
      stream: SRV_STREAM,
      logId: "incown01",
      after: 2,
      to: 3,
      rows: [{ key: "plugin:notes-helper", rev: 3, body: pluginRow(HASH_2) }],
      more: false,
    });
    await flush();
    await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.call", name: "notes-helper", method: "ping", params: null, from: "frame" },
      { plugin: "notes-helper" },
    );
    expect(server.copies).toHaveLength(4);
    expect(server.copies[3].via).toEqual({ plugin: "notes-helper", codeHash: HASH_2 });

    server.sendWire({
      t: "rows",
      stream: SRV_STREAM,
      logId: "incown01",
      after: 3,
      to: 4,
      rows: [{ key: "plugin:notes-helper", rev: 4, deleted: true }],
      more: false,
    });
    await flush();
    const afterTombstone = await (adapter as unknown as { request(cmd: Command, via?: { plugin: string }): Promise<unknown> }).request(
      { type: "plugins.call", name: "notes-helper", method: "ping", params: null, from: "frame" },
      { plugin: "notes-helper" },
    );
    expect(afterTombstone).toEqual({
      ok: false,
      error: { code: "forbidden", message: "not sent: the plugin is not installed on this machine" },
    });
    expect(server.copies).toHaveLength(4);
  });
});
