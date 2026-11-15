// M7-04c: the Note reads a note over one log entry (a 1 MiB note with cards) in full, on the path N2 left (2026-11-15):
// a result too large for one `cmd.applied` entry is kept by the server (`slot_results`) and fetched by the window with a
// `slot.result` req; the call is never refused after its handler ran. The Note's frame reads (`read`, `cards`, `parse`…)
// and writes (`write`…) both go through that one path (`plugins.call` as a slot with `via`), so nothing in the frame host
// or the Note's package.json changes: this file is the proof for the Note, in two parts.
//   1. The real Note program part (builtin-plugins/botling.note/src/host.ts) over a real server.db and slot engine: what
//      the server keeps, that the handler runs once, that the log holds only a marker.
//   2. The window: plugin-frame-host -> renderer Client -> RendererAdapter -> FeLink -> a server that keeps the result:
//      the frame gets the whole 1 MiB note; a result that cannot be fetched or was too large to keep says the call ran
//      (never "not sent"), and the handler is not asked again.
// A remote page cannot fetch a kept result yet: `slot.result` is not in REMOTE_READS (N2 review probe in
// server-slot-big-result.test.ts); see M7-04c.md. This file does not change that.
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type Command } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter } from "../../src/main-v3/renderer-adapter";
import { KeptResultMarker, REMOTE_READS, type Message, type Slot } from "../../src/protocol";
import { ENTRY_BYTES_LIMIT } from "../../src/server/log";
import { ownTableStream, putRow } from "../../src/server/replica/tables";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import type { Bridge } from "../../src/renderer/client";
import { Client } from "../../src/renderer/client";
import { activate } from "../../builtin-plugins/botling.note/src/host";
import { entriesOf, harness, outcomeOf, type Harness } from "./server-intents-harness";
import { FakeClock, FakeServer, flush, SRV_STREAM } from "./fe-link-harness";
import { EPOCH_A } from "./server-slots-harness";

/** A note of CJK, quotes, tabs and newlines: its JSON-escaped UTF-8 is far larger than its length (L-005), over 1 MiB. */
const bigNote = (): string => "筆記一行\n\"引用\"\t- [ ] 待辦 <show name=\"card\">{\"n\":1}</show>\n".repeat(22_000);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The Note's program part over a fake `api`: the methods it exposes, by name. */
function noteHost(notes: Record<string, unknown>) {
  const methods = new Map<string, (params: unknown) => unknown>();
  const api = {
    subscriptions: [] as unknown[],
    notes,
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { methods.set(method, fn); return { dispose() {} }; }, emit() {} },
    events: { on: () => ({ dispose() {} }) },
    storage: { get: () => null, set() {} },
  };
  activate(api as never);
  return methods;
}

describe("the Note's read of a 1 MiB note, through the server's slot (real host, server.db and slot engine)", () => {
  let open: Harness[] = [];
  afterEach(() => { for (const h of open) h.close(); open = []; });
  const slotOf = (h: Harness, n: number): Slot => ({ origin: "desktop", originEpoch: EPOCH_A, target: h.serverStream, n } as Slot);
  async function start(methods: Map<string, (params: unknown) => unknown>) {
    const h = await harness();
    open.push(h);
    const runs: string[] = [];
    const run = h.engine.run.bind(h.engine);
    h.engine.run = async (cmd: Command) => {
      if (cmd.type !== "plugins.call") return run(cmd);
      runs.push(cmd.method);
      return { result: await methods.get(cmd.method)!(cmd.params) };
    };
    return { h, runs };
  }
  const send = (h: Harness, cmd: Command, n: number) => h.runtime.legacy.receive({ slot: slotOf(h, n), floor: 1, inc: h.inc, cmd } as never, { scope: "local" });
  const call = (method: string, params: unknown) => ({ type: "plugins.call", name: "botling.note", method, params, from: "frame" }) as Command;

  it("reads in full: the slot settles applied with a small marker and the owner keeps the whole note for the window", async () => {
    const text = bigNote();
    expect(bytesOf({ text, mtime: 1 })).toBeGreaterThan(1_048_576);
    const { h, runs } = await start(noteHost({ read: async () => ({ path: "/p/.bot/note.md", text, mtime: 1 }) }));
    const outcome = outcomeOf(await send(h, call("read", { botId: "b1" }), 1));
    expect(outcome.kind).toBe("applied");
    expect(KeptResultMarker.parse(outcome.result)).toEqual({ resultKept: { bytes: bytesOf({ result: { text, mtime: 1 } }), kept: true } });
    expect(runs).toEqual(["read"]);
    // The log holds only the marker; the note itself is in slot_results, whole.
    const last = entriesOf(h.db, h.serverStream).at(-1)!;
    expect(last.kind).toBe("cmd.applied");
    expect(JSON.stringify(last.body).length).toBeLessThan(4_000);
    expect(await h.runtime.keptResult(slotOf(h, 1))).toEqual({ found: true, result: { result: { text, mtime: 1 } } });
  });

  it("the cards and the cut of a big note (more cells than one entry holds) are kept the same way", async () => {
    const cards = Array.from({ length: 4_000 }, (_, i) => ({ key: `k${i}`, name: "card", line: i, endLine: i, refresh: null, text: "筆記".repeat(40) }));
    const { h } = await start(noteHost({
      parse: async () => ({ cards, cells: cards, branches: [] }),
      cards: async () => cards.map(({ key }) => ({ key, state: "idle" })),
    }));
    const outcome = outcomeOf(await send(h, call("cards", { botId: "b1", text: "x" }), 1));
    expect(bytesOf({ result: cards })).toBeGreaterThan(ENTRY_BYTES_LIMIT);
    expect(KeptResultMarker.parse(outcome.result).resultKept.kept).toBe(true);
    const kept = await h.runtime.keptResult(slotOf(h, 1));
    expect(kept.found && (kept.result as { result: unknown[] }).result.length).toBe(4_000);
  });

  it("the write path keeps its result too: a save refused because the note changed hands back the 1 MiB note, and the handler ran once", async () => {
    const text = bigNote();
    const { h, runs } = await start(noteHost({ write: async () => ({ saved: false, conflict: true, text, mtime: 9 }) }));
    const outcome = outcomeOf(await send(h, call("write", { botId: "b1", text: "mine", base: 1 }), 1));
    expect(outcome.kind).toBe("applied");
    expect(KeptResultMarker.parse(outcome.result).resultKept.kept).toBe(true);
    expect(runs).toEqual(["write"]);
    const kept = await h.runtime.keptResult(slotOf(h, 1));
    expect(kept).toEqual({ found: true, result: { result: { saved: false, conflict: true, text, mtime: 9 } } });
  });
});

describe("the window: a 1 MiB note read through plugin-frame-host, the adapter and a server that keeps the result", () => {
  const opened: Array<{ link: FeLink; adapter: RendererAdapter }> = [];
  afterEach(async () => { for (const { link, adapter } of opened.splice(0)) { adapter.stop(); await link.stop(); } });

  const HASH = "sha256:" + "11".repeat(32);
  /** The Note's `plugin:` row as the replica writes it for a shipped plugin: a write grant on its running code (plugin-rows.ts, grantedBy builtin). */
  const row = {
    codeHash: HASH,
    manifest: { tier: "write", reads: [], requests: [], owns: ["note"], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "builtin",
    grants: { [HASH]: { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: 1 } },
  };

  interface Rig {
    client: Client;
    server: FakeServer;
    /** The plugins.call slots the server ran (each is one run of the plugin's method). */
    calls: Command[];
    /** The slots whose kept result the window asked for. */
    fetches: Slot[];
    /** How the server answers a `slot.result` req. */
    answer(how: (message: Extract<Message, { t: "req" }>, server: FakeServer) => void): void;
  }
  let epochs = 0;
  /** The server settles every plugins.call `applied` with a marker (`marker`), as the real one does for a result over one entry. */
  async function rig(marker: { bytes: number; kept: boolean }): Promise<Rig> {
    const server = new FakeServer();
    const clock = new FakeClock();
    const state = { calls: [] as Command[], fetches: [] as Slot[], how: (_m: Extract<Message, { t: "req" }>, _s: FakeServer) => {} };
    server.applyHook = ({ cmd }) => { state.calls.push(cmd); return { result: { resultKept: marker } }; };
    server.onMessage = (message: Message) => {
      if (message.t !== "req") return;
      if (message.cmd.type === "slot.result") { state.fetches.push(message.cmd.slot); state.how(message, server); return; }
      server.send({ t: "res", req: message.req, ok: true, result: {} });
    };
    const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0"), local: true });
    const adapter = new RendererAdapter({ link, clock, emit: () => undefined });
    opened.push({ link, adapter });
    link.start();
    adapter.start();
    await flush();
    // The server's own plugin: row (the owner checks the grant at via.codeHash, M5-15) and the front end's copy of it, from
    // which the adapter stamps `via { plugin, codeHash }` (M5-12b).
    server.db.exec("BEGIN");
    putRow(server.db, ownTableStream(server.db), "plugin:botling.note", row);
    server.db.exec("COMMIT");
    server.sendWire({ t: "rows", stream: SRV_STREAM, logId: "incown01", after: 0, to: 1, rows: [{ key: "plugin:botling.note", rev: 1, body: row }], more: false });
    await flush();
    // The renderer's Client over a bridge that hands each request to the adapter, as the preload does.
    let listener: (message: unknown) => void = () => undefined;
    const bridge: Bridge = {
      protocol: PROTOCOL_VERSION,
      subscribe: (each) => { listener = each; return () => undefined; },
      post(envelope, via) {
        const { id, cmd } = envelope as { id: string; cmd: Command };
        void adapter.request(cmd, via).then((answer) => listener(answer.ok ? { v: PROTOCOL_VERSION, id, ok: true, result: answer.result } : { v: PROTOCOL_VERSION, id, ok: false, error: answer.error }));
      },
    };
    return { client: new Client(bridge), server, calls: state.calls, fetches: state.fetches, answer: (how) => { state.how = how; } };
  }
  const host = (client: Client) => pluginFrameHost({ client, components: () => ({}), bots: () => [], ask: (_view, _approve, done) => done(false) });

  it("answers the frame's read with the whole 1 MiB note: one slot with the Note's via, the note by one slot.result for that slot", async () => {
    const r = await rig({ bytes: 1_100_000, kept: true });
    const text = bigNote();
    r.answer((message, server) => server.send({ t: "res", req: message.req, ok: true, result: { result: { text, mtime: 1 } } }));
    const answer = await host(r.client).call("botling.note", "read", { botId: "b1" }) as { result: { text: string; mtime: number } };
    expect(answer.result.text === text).toBe(true);
    expect(answer.result.text.length).toBe(text.length);
    expect(r.calls.map((cmd) => cmd.type)).toEqual(["plugins.call"]);
    expect(r.server.copies[0].via).toEqual({ plugin: "botling.note", codeHash: HASH });
    expect(r.fetches).toEqual([r.server.copies[0].slot]);
  });

  it("a write goes the same way (a refused save hands the note back): via stamped, one run, the result fetched", async () => {
    const r = await rig({ bytes: 1_100_000, kept: true });
    const text = bigNote();
    r.answer((message, server) => server.send({ t: "res", req: message.req, ok: true, result: { result: { saved: false, text, mtime: 9 } } }));
    const answer = await host(r.client).call("botling.note", "write", { botId: "b1", text: "mine", base: 1 }) as { result: { text: string } };
    expect(answer.result.text === text).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.server.copies[0].via).toEqual({ plugin: "botling.note", codeHash: HASH });
  });

  it("a kept result that cannot be fetched says the call ran (never \"not sent\"), and the call is not sent again", async () => {
    const r = await rig({ bytes: 1_100_000, kept: true });
    r.answer((message, server) => server.send({ t: "res", req: message.req, ok: false, error: { code: "not_found", message: "no longer kept" } }));
    for (const method of ["read", "write"]) {
      await expect(host(r.client).call("botling.note", method, { botId: "b1" })).rejects.toThrow(/^plugins\.call ran, but its result \(1\.1 MB\) could not be fetched: .*no longer kept/);
    }
    expect(r.calls).toHaveLength(2);
    expect(r.fetches).toHaveLength(2);
  });

  it("a result too large to keep (over 16 MiB) says the call ran and asks for nothing", async () => {
    const r = await rig({ bytes: 40_000_000, kept: false });
    r.answer(() => { throw new Error("no fetch expected"); });
    await expect(host(r.client).call("botling.note", "read", { botId: "b1" })).rejects.toThrow(/plugins\.call ran, but its result \(40\.0 MB\) is too large to send back; the server did not keep it/);
    expect(r.calls).toHaveLength(1);
    expect(r.fetches).toHaveLength(0);
  });
});

describe("a remote page", () => {
  it("cannot fetch a kept result: slot.result is local only (the N2 review probe); M7-04c.md asks for a decision", () => {
    expect(REMOTE_READS.has("slot.result")).toBe(false);
  });
});
