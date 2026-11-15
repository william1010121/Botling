// M5-09 (protocol v1 §9A.8, D53/D54, Q-C12): a PDF link button (`chat/link`, 「開始陪讀」) on a peer bot's chat runs on the
// machine that owns the bot, as the plugin that contributes the button, and is offered only while that machine has the plugin.
//   1. Owner side: `lineContentRef` (the line's `content_names` row -> a reference the plugin can `content.read`) and the core's
//      `Plugins.linkCommand`: `path` only for a file on this machine, else `content`.
//   2. Window side: the renderer adapter (desktop and page share it) hides the buttons of plugins the owner lacks, tells the window
//      when that changes, and sends the command to the owner with `via` stamped from the OWNER's row; one press sends once.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, EventEnvelope, PluginsView } from "../../src/contract";
import { Plugins, type LineContentRef, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter, type LinkPort } from "../../src/main-v3/renderer-adapter";
import type { Message, StreamId } from "../../src/protocol";
import type { PluginRow, SummaryRow } from "../../src/protocol/table-rows";
import { ContentService } from "../../src/server/content";
import { lineContentRef } from "../../src/server/content/line-content";
import { PluginContentRead } from "../../src/server/content/plugin-read";
import { ensureStream } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { tempDir, until } from "../helpers";
import { FakeClock, FakeServer, flush, SERVER_ID } from "./fe-link-harness";

// ---------------------------------------------------------------------------------------------
// Owner side, 1: the content reference of a line's file (real ContentService and store)

const OWNER = "srvowner";
const BOT = "bot-b";
const PDF_BYTES = Buffer.from("%PDF-1.4 the attention paper, pretend");
const stores: ServerStore[] = [];
const services: ContentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) await store.close();
});

async function ownerWithLine(lineId = "L1") {
  const dir = tempDir("peer-link-owner");
  const files = join(dir, "files");
  mkdirSync(files, { recursive: true });
  const file = join(files, "paper.pdf");
  writeFileSync(file, PDF_BYTES);
  const store = await openServerStore(join(dir, "data"));
  stores.push(store);
  const stream = `bot:${BOT}` as StreamId;
  await store.submit((db) => ensureStream(db, stream));
  const service = new ContentService({ store, dataDir: join(dir, "data"), serverId: OWNER, pin: { force: "copy" } });
  services.push(service);
  const url = pathToFileURL(file).href;
  const line = { id: lineId, text: `see [paper](${url})`, attachments: [] };
  const body = { botId: BOT, message: { id: lineId, role: "bot", text: line.text, time: "2026-11-15T00:00:00.000Z", state: "done" } };
  const { ready } = await service.appendLine(stream, BOT, line, [{ kind: "message.added", body }]);
  await ready;
  return { dir, file, url, store, service, stream };
}

describe("lineContentRef: the reference of the file a line's link names", () => {
  it("a file taken off the disk afterwards still gives a reference whose bytes content.read serves", async () => {
    const { file, url, store, service } = await ownerWithLine();
    rmSync(file);
    const ref = lineContentRef(store.openReader(), OWNER, BOT, "L1", url);
    expect(ref).toMatchObject({ owner: OWNER, id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), entry: { stream: `bot:${BOT}` } });
    const read = new PluginContentRead({ serverId: OWNER, service, peer: { respond: async () => { throw new Error("not a peer file"); } } as never, roster: { view: { revoked: new Set<string>() } } });
    const bytes = await read.read(ref!, 0, 1024);
    expect(Buffer.from(bytes).equals(PDF_BYTES)).toBe(true);
    // An absolute path (what the chat opens as a file) is the same file.
    expect(lineContentRef(store.openReader(), OWNER, BOT, "L1", file)).toEqual(ref);
  });

  it("gives nothing for another line, another file, another bot, a web link, or an odd value", async () => {
    const { url, store } = await ownerWithLine();
    const db = store.openReader();
    expect(lineContentRef(db, OWNER, BOT, "L2", url)).toBeNull();
    expect(lineContentRef(db, OWNER, BOT, "L1", pathToFileURL(join(tempDir("peer-link-x"), "other.pdf")).href)).toBeNull();
    expect(lineContentRef(db, OWNER, "other-bot", "L1", url)).toBeNull();
    expect(lineContentRef(db, OWNER, "..", "L1", url)).toBeNull();
    expect(lineContentRef(db, OWNER, "a/b", "L1", url)).toBeNull();
    expect(lineContentRef(db, OWNER, BOT, "", url)).toBeNull();
    expect(lineContentRef(db, OWNER, BOT, "x".repeat(201), url)).toBeNull();
    expect(lineContentRef(db, OWNER, BOT, "L1", "https://arxiv.org/pdf/1706.03762.pdf")).toBeNull();
    expect(lineContentRef(db, OWNER, BOT, "L1", "papers/a.pdf")).toBeNull();
  });

  it("gives nothing while the hash is not ready, when the content changed, or when the entry no longer references it", async () => {
    const { url, store } = await ownerWithLine();
    const db = store.openReader();
    const base = lineContentRef(db, OWNER, BOT, "L1", url);
    expect(base).not.toBeNull();
    const change = async (sql: string, ...args: string[]) => { await store.submit((writer) => { writer.prepare(sql).run(...args); }); };
    const names = db.prepare("SELECT id FROM content_names").get()!;
    // The hash is not ready: the name still has a `pending:` id (local socket only).
    await change("UPDATE content_names SET id = ?", `pending:${"ab".repeat(16)}`);
    expect(lineContentRef(store.openReader(), OWNER, BOT, "L1", url)).toBeNull();
    await change("UPDATE content_names SET id = ?", String(names.id));
    expect(lineContentRef(store.openReader(), OWNER, BOT, "L1", url)).toEqual(base);
    await change("UPDATE content SET state = ? WHERE id = ?", "changed", base!.id);
    expect(lineContentRef(store.openReader(), OWNER, BOT, "L1", url)).toBeNull();
    await change("UPDATE content SET state = ? WHERE id = ?", "ready", base!.id);
    await change("DELETE FROM content_refs WHERE id = ? AND stream = ?", base!.id, `bot:${BOT}`);
    expect(lineContentRef(store.openReader(), OWNER, BOT, "L1", url)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Owner side, 2: the core hands the plugin `path` or `content`

function plugin(dir: string, name: string, ccb: Record<string, unknown>) {
  const folder = join(dir, "plugins", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: "Coach", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", ...ccb } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

const REF: LineContentRef = { owner: OWNER, id: `sha256:${"cd".repeat(32)}`, entry: { stream: `bot:${BOT}` as StreamId, seq: 7 } };

/** The core over a fake host; `lineContent` is the world's lookup (absent: a 2.x world). */
async function coreWith(lineContent?: PluginWorld["lineContent"]) {
  const dir = tempDir("peer-link-core");
  plugin(dir, "coach", { contributes: { commands: [{ id: "coach.start", title: "Start" }], menus: { "chat/link": [{ command: "coach.start", title: "開始陪讀", when: { ext: "pdf" } }] } } });
  const sent: any[] = [];
  let handlers!: HostHandlers;
  const line = (message: unknown) => handlers.data(JSON.stringify(message) + "\n");
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => line({ method: "ready", params: {} }));
      return {
        pid: 4242,
        write: (text) => {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.method === "load") line({ id: message.id, result: { loaded: message.params.plugins.map((spec: any) => spec.name), failed: [] } });
          if (message.method === "shutdown" || message.method === "command") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const world = {
    bots: () => [], notice: () => {}, appSettings: () => ({ language: "en", botLook: "cute", workerLimit: 4 }), shortcutOverrides: () => ({}), workspaceWatch: () => {}, botId: (botId: string) => (botId === "main" ? "MAIN-ID" : null), changed: () => {}, broken: () => {}, log: () => {},
    ...(lineContent ? { lineContent } : {}),
  } as unknown as PluginWorld;
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key") });
  running.push(plugins);
  await plugins.start();
  await until(() => plugins.host.running);
  line({ method: "registered", params: { beforeSend: 0, afterReply: 0, commands: ["coach.start"], exposed: {} } });
  await until(() => plugins.host.commands.includes("coach.start"));
  const lastArgs = () => sent.filter((m) => m.method === "command").at(-1).params.args[0];
  return { dir, plugins, lastArgs };
}

describe("Plugins.linkCommand: path for a file on this machine, content for one that is not", () => {
  it("a file no longer on this disk, but held by the line: { botId, messageId, url, content } and no path", async () => {
    const asked: unknown[][] = [];
    const { dir, plugins, lastArgs } = await coreWith((...args) => { asked.push(args); return REF; });
    const url = pathToFileURL(join(dir, "gone", "paper.pdf")).href;
    await plugins.linkCommand("coach.start", { botId: "B1", messageId: "L7", url });
    expect(lastArgs()).toEqual({ botId: "B1", messageId: "L7", url, content: REF });
    expect(Object.keys(lastArgs())).toEqual(["botId", "messageId", "url", "content"]);
    expect(asked).toEqual([["B1", "L7", url]]);
  });

  it("a file on this disk keeps `path` as today and the lookup is never made", async () => {
    let asked = 0;
    const { dir, plugins, lastArgs } = await coreWith(() => { asked += 1; return REF; });
    const file = join(dir, "here.pdf");
    writeFileSync(file, PDF_BYTES);
    const url = pathToFileURL(file).href;
    await plugins.linkCommand("coach.start", { botId: "B1", messageId: "L7", url });
    expect(lastArgs()).toEqual({ botId: "B1", messageId: "L7", url, path: file });
    expect(asked).toBe(0);
  });

  it("a folder or a link to nothing is not a file here", async () => {
    const { dir, plugins, lastArgs } = await coreWith(() => REF);
    const folder = join(dir, "folder.pdf");
    mkdirSync(folder);
    await plugins.linkCommand("coach.start", { botId: "B1", messageId: "L7", url: pathToFileURL(folder).href });
    expect(lastArgs()).toMatchObject({ content: REF });
    expect(lastArgs()).not.toHaveProperty("path");
  });

  it("no reference, a failing lookup, or a 2.x world (no lookup): the path as today, nothing else", async () => {
    for (const lookup of [() => null, () => { throw new Error("db closed"); }, undefined] as const) {
      const { dir, plugins, lastArgs } = await coreWith(lookup);
      const file = join(dir, "gone", "paper.pdf");
      const url = pathToFileURL(file).href;
      await plugins.linkCommand("coach.start", { botId: "B1", messageId: "L7", url });
      expect(lastArgs()).toEqual({ botId: "B1", messageId: "L7", url, path: file });
    }
  });

  it("a web link has no path and no lookup", async () => {
    let asked = 0;
    const { plugins, lastArgs } = await coreWith(() => { asked += 1; return REF; });
    await plugins.linkCommand("coach.start", { botId: "B1", messageId: "L7", url: "https://arxiv.org/pdf/1706.03762v7.pdf" });
    expect(lastArgs()).toEqual({ botId: "B1", messageId: "L7", url: "https://arxiv.org/pdf/1706.03762v7.pdf" });
    expect(asked).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Window side: the renderer adapter attached to A of two; B owns bot far1

const B = "srvB";
const SRV_B = `srv:${B}`;
const FAR = "far1";
const FAR_STREAM = `bot:${FAR}` as StreamId;
const HASH_B = "sha256:" + "bb".repeat(32);
const HASH_B2 = "sha256:" + "b2".repeat(32);
const summary = (): SummaryRow => ({
  name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
  waiting: [], unread: 0, lastAt: null, lines: ["hello"],
} as SummaryRow);
const pluginRow = (codeHash: string): PluginRow => ({
  codeHash,
  manifest: { tier: "request", reads: [], requests: ["plugins.linkCommand"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
  author: "user",
  grants: {},
});
const link = (plugin: string, command: string) => ({ menu: "chat/link" as const, command, plugin, title: "開始陪讀", when: { ext: ["pdf"] } });
/** A's plugin view: two plugins with a PDF link button, and a menu entry that is not a link button. */
const VIEW: PluginsView = {
  plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  menus: [link("coach", "coach.start"), link("reader", "reader.open"), { menu: "composer/plus", command: "coach.note", plugin: "coach", title: "Note" }],
};
const linkKeys = (view: PluginsView | null | undefined) => (view?.menus ?? []).filter((entry) => entry.menu === "chat/link").map((entry) => entry.plugin);

const opened: Array<{ link: FeLink; adapter: RendererAdapter }> = [];
afterEach(async () => { for (const { link: held, adapter } of opened.splice(0)) { adapter.stop(); await held.stop(); } });

let epochs = 0;
async function rig(rows: Record<string, PluginRow> = {}) {
  const server = new FakeServer();
  server.servers = [
    { id: SERVER_ID, name: "Studio", state: "live", since: 1 },
    { id: B, name: "Linux box", state: "live", since: 2 },
  ];
  // Revisions rise one row at a time (the table's own rule).
  const table = new Map<string, { rev: number; body?: unknown }>([[`bot:${FAR}`, { rev: 1, body: summary() }]]);
  for (const [name, row] of Object.entries(rows)) table.set(`plugin:${name}`, { rev: table.size + 1, body: row });
  server.tables.set(SRV_B, { logId: "incb-0001", rev: table.size, rows: table, retired: [] });
  server.peerTargets.add(FAR_STREAM);
  const clock = new FakeClock();
  server.onMessage = (message: Message) => {
    if (message.t !== "req") return;
    const cmd = (message as { cmd: Command }).cmd;
    if (cmd.type === "chat.snapshot") {
      const own = { id: "b1", name: "Main", role: "main", avatar: "circle", folder: "/p", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
      server.send({ t: "res", req: message.req, ok: true, result: { epoch: "e", seq: 0, bots: [own], imported: null, components: {}, plugins: VIEW, settings: null, doctor: null, waiting: { items: [], doing: {} }, chat: null } } as unknown as Message);
    } else if (cmd.type === "plugins.list") server.send({ t: "res", req: message.req, ok: true, result: VIEW } as unknown as Message);
    else server.send({ t: "res", req: message.req, ok: true, result: {} } as unknown as Message);
  };
  server.snapView = () => ({ bot: null, messages: [], history: { hasMore: false, older: 0 }, cards: [] });
  const held = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "phone", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0"), local: true });
  held.start();
  const events: EventEnvelope[] = [];
  const adapter = new RendererAdapter({ link: held as unknown as LinkPort, emit: (envelope) => { events.push(envelope); }, clock, noticeDelayMs: 0 });
  opened.push({ link: held, adapter });
  adapter.start();
  await flush();
  const updates = () => events.map((e) => e.event).filter((e): e is { type: "plugins.updated"; plugins: PluginsView } => e.type === "plugins.updated");
  const press = (over: Record<string, unknown> = {}) => adapter.request({ type: "plugins.linkCommand", id: "coach.start", botId: FAR, messageId: "L1", url: "file:///srv/b/paper.pdf", ...over } as Command);
  const sentTo = (target: string) => server.copies.filter((copy) => copy.slot.target === target);
  return { server, adapter, events, updates, press, sentTo };
}

describe("the window offers a peer bot's link buttons only for plugins its machine has", () => {
  it("B has coach, not reader: the peer bot's chat gets coach's button only; A's own bot still gets both", async () => {
    const { adapter } = await rig({ coach: pluginRow(HASH_B) });
    const own = await adapter.snapshot();
    expect(linkKeys(own.plugins)).toEqual(["coach", "reader"]);
    const peer = await adapter.snapshot(FAR);
    expect(linkKeys(peer.plugins)).toEqual(["coach"]);
    // Only the link buttons are filtered: the rest of the view is whole.
    expect(peer.plugins.menus!.some((entry) => entry.menu === "composer/plus" && entry.plugin === "coach")).toBe(true);
    const listed = await adapter.request({ type: "plugins.list" } as Command);
    expect(linkKeys((listed as { result: PluginsView }).result)).toEqual(["coach"]);
    await adapter.request({ type: "chat.shown", botId: "b1" } as Command);
    expect(linkKeys(((await adapter.request({ type: "plugins.list" } as Command)) as { result: PluginsView }).result)).toEqual(["coach", "reader"]);
  });

  it("B has no plugin at all, or its table is unknown: no link button on its bots (fail closed)", async () => {
    const { adapter } = await rig();
    await adapter.snapshot();
    expect(linkKeys((await adapter.snapshot(FAR)).plugins)).toEqual([]);
  });

  it("a plugin's row arriving or going on B changes the offered buttons: the window is told with plugins.updated", async () => {
    const { server, adapter, updates } = await rig();
    await adapter.snapshot();
    await adapter.snapshot(FAR);
    await flush();
    expect(updates()).toEqual([]);
    server.setRow(SRV_B, "plugin:coach", pluginRow(HASH_B));
    await flush();
    expect(updates().map((view) => linkKeys(view.plugins))).toEqual([["coach"]]);
    // Nothing relevant changed (a hash swap keeps the plugin): no second event.
    server.setRow(SRV_B, "plugin:coach", pluginRow(HASH_B2));
    await flush();
    expect(updates()).toHaveLength(1);
    server.setRow(SRV_B, "plugin:coach", null);
    await flush();
    expect(updates().map((view) => linkKeys(view.plugins))).toEqual([["coach"], []]);
  });

  it("moving from the peer's bot to A's own bot gives the window every button again", async () => {
    const { adapter, updates } = await rig({ coach: pluginRow(HASH_B) });
    await adapter.snapshot();
    await adapter.snapshot(FAR);
    await flush();
    expect(updates()).toEqual([]);
    await adapter.request({ type: "chat.shown", botId: "b1" } as Command);
    await flush();
    expect(updates().map((view) => linkKeys(view.plugins))).toEqual([["coach", "reader"]]);
    await adapter.request({ type: "chat.shown", botId: FAR } as Command);
    await flush();
    expect(updates().map((view) => linkKeys(view.plugins))).toEqual([["coach", "reader"], ["coach"]]);
  });
});

describe("pressing the button on a peer bot's line runs at its owner, as the contributing plugin", () => {
  it("goes to the bot's stream with via { plugin, codeHash } from B's row (not A's)", async () => {
    const { adapter, press, sentTo } = await rig({ coach: pluginRow(HASH_B) });
    await adapter.snapshot();
    await adapter.snapshot(FAR);
    // The fake server has no plugin rows of its own, so its grant check (M5-15, tested there) refuses; what the window sent is what counts here.
    await press();
    const copies = sentTo(FAR_STREAM);
    expect(copies).toHaveLength(1);
    expect(copies[0].cmd).toMatchObject({ type: "plugins.linkCommand", id: "coach.start", botId: FAR, messageId: "L1", url: "file:///srv/b/paper.pdf" });
    expect(copies[0].via).toEqual({ plugin: "coach", codeHash: HASH_B });
  });

  it("the plugin is the one that contributes the button, whatever else is named", async () => {
    const { adapter, press, sentTo } = await rig({ coach: pluginRow(HASH_B), reader: pluginRow(HASH_B2) });
    await adapter.snapshot();
    await press({ id: "reader.open" });
    expect(sentTo(FAR_STREAM)[0].via).toEqual({ plugin: "reader", codeHash: HASH_B2 });
  });

  it("B lacks the plugin: refused here, nothing sent", async () => {
    const { adapter, press, sentTo } = await rig({ reader: pluginRow(HASH_B2) });
    await adapter.snapshot();
    const answer = await press();
    expect(answer).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("not installed on that machine") } });
    expect(sentTo(FAR_STREAM)).toEqual([]);
  });

  it("no button offers that command (a command nobody contributes, or a prefix of another plugin): refused, nothing sent", async () => {
    const { adapter, press, sentTo } = await rig({ coach: pluginRow(HASH_B) });
    await adapter.snapshot();
    for (const id of ["coach.nothing", "plugins.remove", "constructor", "coach"]) {
      expect(await press({ id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(sentTo(FAR_STREAM)).toEqual([]);
  });

  it("a double press sends once; a press after it finished sends again", async () => {
    const { adapter, press, sentTo } = await rig({ coach: pluginRow(HASH_B) });
    await adapter.snapshot();
    const [first, second] = await Promise.all([press(), press()]);
    expect(second).toEqual(first);
    expect(sentTo(FAR_STREAM)).toHaveLength(1);
    await press();
    expect(sentTo(FAR_STREAM)).toHaveLength(2);
    // A different line or link is a different press.
    await Promise.all([press({ messageId: "L2" }), press({ messageId: "L3" })]);
    expect(sentTo(FAR_STREAM)).toHaveLength(4);
  });

  it("A's own bot: as today, no via (the window needs none), no lookup in any table", async () => {
    const { adapter, press, sentTo } = await rig({});
    await adapter.snapshot();
    expect(await press({ botId: "b1" })).toMatchObject({ ok: true });
    const copies = sentTo("bot:b1");
    expect(copies).toHaveLength(1);
    expect("via" in copies[0]).toBe(false);
  });
});
