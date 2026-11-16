// M7-09b: the renderer adapter answers the frames' web parts (`plugins.web`, `plugins.panel`) from the attached server's own
// `plugin:` rows when a row names its bundle (`files.web`), and from the server's own answer otherwise (the fallback):
//   - a plugin whose row names a bundle gets that bundle's code, asked for by the plugin the SPEC names (not the caller);
//   - a row without a reference, a bundle that cannot be had, or an adapter with no fetcher leaves the server's source as it was;
//   - a row that moves to another bundle drops the kept answer and tells the window with one `plugins.updated`, so its frames ask again;
//     a row of a plugin whose web part was never given from a row tells it nothing.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, EventEnvelope } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter } from "../../src/main-v3/renderer-adapter";
import { BundleRefusedError, ticketBundleFetcher, type BundleFetcher, type BundleRequest } from "../../src/renderer/shell/row-loader";
import { sourceByRef } from "../../src/main-v3/web-by-ref";
import type { Message } from "../../src/protocol";
import { FakeClock, FakeServer, flush, SRV_STREAM } from "./fe-link-harness";

const refOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const A1 = "export const a = 1;";
const A2 = "export const a = 2;";
const PLUGINS = { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null };

function plugin(codeHash: string, web?: string): unknown {
  return {
    codeHash,
    manifest: { tier: "read", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "user",
    ...(web ? { files: { web } } : {}),
    grants: {},
  };
}
const spec = (name: string, source: string) => ({ name, version: "1", source, styles: [], settings: {}, commands: [] });

interface Rig {
  server: FakeServer;
  adapter: RendererAdapter;
  events: EventEnvelope[];
  reqs: Command[];
  fetched: BundleRequest[];
  rows(after: number, to: number, rows: Array<{ key: string; rev: number; body?: unknown; deleted?: true }>): void;
  web(): Promise<{ name: string; source: string }[]>;
  updated(): number;
}

const opened: Array<{ link: FeLink; adapter: RendererAdapter }> = [];
afterEach(async () => { for (const { link, adapter } of opened.splice(0)) { adapter.stop(); await link.stop(); } });

let epochs = 0;
async function rig(options: { bundles?: (fetched: BundleRequest[]) => BundleFetcher | undefined; fetcherFor?: (link: FeLink) => BundleFetcher } = {}): Promise<Rig> {
  const server = new FakeServer();
  const clock = new FakeClock();
  const reqs: Command[] = [];
  const fetched: BundleRequest[] = [];
  server.onMessage = (message: Message) => {
    if (message.t !== "req") return;
    reqs.push(message.cmd);
    const answer = (result: unknown) => server.send({ t: "res", req: message.req, ok: true, result });
    if (message.cmd.type === "chat.snapshot") answer({ epoch: "server", seq: 0, bots: [], imported: null, components: {}, plugins: PLUGINS, chat: null });
    else if (message.cmd.type === "plugins.web") answer({ specs: [spec("a", "SERVER-A"), spec("b", "SERVER-B")] });
    else if (message.cmd.type === "plugins.panel") answer({ title: "t", source: `SERVER-PANEL-${message.cmd.name}`, settings: {} });
    else answer({});
  };
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0") });
  const events: EventEnvelope[] = [];
  const bundles = options.fetcherFor ? options.fetcherFor(link) : options.bundles ? options.bundles(fetched) : undefined;
  const adapter = new RendererAdapter({ link, clock, newEpoch: () => "e1", emit: (envelope) => { events.push(envelope); }, ...(bundles ? { bundles } : {}) });
  opened.push({ link, adapter });
  adapter.start();
  link.start();
  await flush();
  await adapter.request({ type: "chat.snapshot" });
  return {
    server, adapter, events, reqs, fetched,
    rows(after, to, rows) { server.sendWire({ t: "rows", stream: SRV_STREAM, logId: "incown01", after, to, rows, more: false }); },
    async web() {
      const answer = await adapter.request({ type: "plugins.web" });
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      return (answer.result as { specs: { name: string; source: string }[] }).specs;
    },
    updated: () => events.filter((envelope) => "event" in envelope && envelope.event.type === "plugins.updated").length,
  };
}

const bySource = (texts: Record<string, string>) => (fetched: BundleRequest[]): BundleFetcher => async (request) => {
  fetched.push(request);
  const text = texts[request.ref];
  if (text === undefined) throw new Error("gone");
  return text;
};
const BUNDLES = { [refOf(A1)]: A1, [refOf(A2)]: A2 };

describe("the frames' web parts come from the rows", () => {
  it("answers plugins.web with the bundle a row names, asked for by the plugin the spec names; a row with none keeps the server's source", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }, { key: "plugin:b", rev: 3, body: plugin("h-b1") }]);
    await flush();
    expect(await r.web()).toEqual([expect.objectContaining({ name: "a", source: A1 }), expect.objectContaining({ name: "b", source: "SERVER-B" })]);
    expect(r.fetched).toEqual([{ plugin: "a", ref: refOf(A1) }]);
    // Asked again: the answer is kept (no new fetch, no new ask of the server).
    await r.web();
    expect(r.fetched).toHaveLength(1);
    expect(r.reqs.filter((cmd) => cmd.type === "plugins.web")).toHaveLength(1);
  });

  it("answers plugins.panel the same way, for the plugin the command names", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }, { key: "plugin:b", rev: 3, body: plugin("h-b1") }]);
    await flush();
    const a = await r.adapter.request({ type: "plugins.panel", name: "a", panel: "main" });
    const b = await r.adapter.request({ type: "plugins.panel", name: "b", panel: "main" });
    expect(a).toEqual({ ok: true, result: { title: "t", source: A1, settings: {} } });
    expect(b).toEqual({ ok: true, result: { title: "t", source: "SERVER-PANEL-b", settings: {} } });
    expect(r.fetched.map((call) => call.plugin)).toEqual(["a"]);
  });

  it("keeps the server's source when the bundle cannot be had, and when the adapter has no fetcher", async () => {
    const down = await rig({ bundles: bySource({}) });
    down.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect((await down.web()).find((entry) => entry.name === "a")?.source).toBe("SERVER-A");
    expect(down.fetched).toHaveLength(1);
    const none = await rig();
    none.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect((await none.web()).find((entry) => entry.name === "a")?.source).toBe("SERVER-A");
  });

  it("does not take a `files.web` that is not an exact reference (a wrong shape, upper-case hex) as a bundle", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", "sha256:nothex") }, { key: "plugin:b", rev: 3, body: plugin("h-b1", `sha256:${"A".repeat(64)}`) }]);
    await flush();
    const specs = await r.web();
    expect(specs.map((entry) => entry.source)).toEqual(["SERVER-A", "SERVER-B"]);
    expect(r.fetched).toEqual([]);
  });
});

describe("a row that moves to another bundle", () => {
  it("drops the kept answer and tells the window once; the next ask has the new code", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect((await r.web()).find((entry) => entry.name === "a")?.source).toBe(A1);
    const before = r.updated();
    r.rows(2, 3, [{ key: "plugin:a", rev: 3, body: plugin("h-a2", refOf(A2)) }]);
    await flush();
    expect(r.updated()).toBe(before + 1);
    expect((await r.web()).find((entry) => entry.name === "a")?.source).toBe(A2);
    expect(r.reqs.filter((cmd) => cmd.type === "plugins.web")).toHaveLength(2);
    // The same row again is not a move.
    r.rows(3, 4, [{ key: "plugin:a", rev: 4, body: plugin("h-a2", refOf(A2)) }]);
    await flush();
    expect(r.updated()).toBe(before + 1);
  });

  it("tells it too when the row loses its reference, and not when a plugin never given from a row changes", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }, { key: "plugin:b", rev: 3, body: plugin("h-b1") }]);
    await flush();
    await r.web();
    const before = r.updated();
    r.rows(3, 4, [{ key: "plugin:b", rev: 4, body: plugin("h-b2") }]);
    await flush();
    expect(r.updated()).toBe(before);
    r.rows(4, 5, [{ key: "plugin:a", rev: 5, body: plugin("h-a1") }]);
    await flush();
    expect(r.updated()).toBe(before + 1);
    expect((await r.web()).find((entry) => entry.name === "a")?.source).toBe("SERVER-A");
  });

  it("a row that moves while its old bundle is still being read is answered with the new bundle, never the old (L-008)", async () => {
    let release: (() => void) | null = null;
    const held = (fetched: BundleRequest[]): BundleFetcher => async (request) => {
      fetched.push(request);
      if (request.ref === refOf(A1)) await new Promise<void>((resolve) => { release = resolve; });
      return BUNDLES[request.ref]!;
    };
    const r = await rig({ bundles: held });
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    const asked = r.web();
    await flush();
    expect(release).not.toBeNull();
    r.rows(2, 3, [{ key: "plugin:a", rev: 3, body: plugin("h-a2", refOf(A2)) }]);
    await flush();
    release!();
    expect((await asked).find((entry) => entry.name === "a")?.source).toBe(A2);
    expect(r.fetched.map((call) => call.ref)).toEqual([refOf(A1), refOf(A2)]);
  });

  it("the first rows of a connection change nothing the window was told (it was given nothing from a row yet)", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    const before = r.updated();
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect(r.updated()).toBe(before);
  });
});

// M7-09b-F (FU-6): bytes that are not the web part the row names are refused; the server's own source is never the fallback for them.
describe("a bundle that does not match its row is refused", () => {
  const evil = (fetched: BundleRequest[]): BundleFetcher => async (request) => { fetched.push(request); return request.ref === refOf(A1) ? "evil();" : BUNDLES[request.ref]!; };
  const refusing = (fetched: BundleRequest[]): BundleFetcher => async (request) => {
    fetched.push(request);
    if (request.ref === refOf(A1)) throw new BundleRefusedError("the bytes are not the web part its row names");
    return BUNDLES[request.ref]!;
  };

  for (const [how, bundles] of [["a fetcher that did not check", evil], ["a fetcher that refused", refusing]] as const) {
    it(`plugins.web carries no source for it (${how}): neither the wrong bytes nor the server's source; other plugins are as before`, async () => {
      const r = await rig({ bundles });
      r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }, { key: "plugin:b", rev: 3, body: plugin("h-b1") }]);
      await flush();
      const specs = await r.web();
      expect(specs.map((entry) => entry.name)).toEqual(["b"]);
      expect(JSON.stringify(specs)).not.toContain("evil");
      expect(JSON.stringify(specs)).not.toContain("SERVER-A");
      expect(specs[0]!.source).toBe("SERVER-B");
    });

    it(`plugins.panel is refused for it (${how}), and still answers another plugin from the server`, async () => {
      const r = await rig({ bundles });
      r.rows(0, 3, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }, { key: "plugin:b", rev: 3, body: plugin("h-b1") }]);
      await flush();
      const a = await r.adapter.request({ type: "plugins.panel", name: "a", panel: "main" });
      expect(a.ok).toBe(false);
      expect(JSON.stringify(a)).not.toContain("SERVER-PANEL-a");
      expect(JSON.stringify(a)).not.toContain("evil");
      expect(await r.adapter.request({ type: "plugins.panel", name: "b", panel: "main" })).toEqual({ ok: true, result: { title: "t", source: "SERVER-PANEL-b", settings: {} } });
    });
  }

  it("a row that then moves to a good bundle tells the window once, and the next ask has the good code", async () => {
    const r = await rig({ bundles: evil });
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect((await r.web()).map((entry) => entry.name)).toEqual(["b"]);
    const before = r.updated();
    r.rows(2, 3, [{ key: "plugin:a", rev: 3, body: plugin("h-a2", refOf(A2)) }]);
    await flush();
    expect(r.updated()).toBe(before + 1);
    expect((await r.web()).find((entry) => entry.name === "a")?.source).toBe(A2);
  });

  it("still falls back to the server's source when the bundle only could not be had (the old trust path)", async () => {
    const r = await rig({ bundles: bySource({}) });
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect((await r.web()).find((entry) => entry.name === "a")?.source).toBe("SERVER-A");
  });

  it("sourceByRef says it refused (not that the server's source is used), and a row that moved on is read again before refusing", async () => {
    const lines: string[] = [];
    const row = (web: string) => new Map<string, unknown>([["plugin:a", plugin("h", web)]]);
    let rows = row(refOf(A1));
    const by = { fetch: (async () => { rows = row(refOf(A2)); return "evil();"; }) as BundleFetcher, rows: () => rows, log: (line: string) => lines.push(line) };
    // The first fetch is of a row that moves meanwhile: its (wrong) bytes are dropped, the new row is fetched again (and is wrong too).
    const answer = await sourceByRef(by, "a");
    expect(answer).toEqual({ refused: expect.stringMatching(/./), key: expect.stringContaining(refOf(A2)) });
    expect(lines.join("\n")).toMatch(/refused/);
    expect(lines.join("\n")).not.toMatch(/server's source is used/);
  });
});

describe("a session that never answers content.ticket (the window's local one drops it)", () => {
  it("still answers plugins.panel and plugins.web within a bounded time, from the server's source, so no plugin frame (Note, Usage, 陪讀) waits for ever", async () => {
    const r = await rig({ fetcherFor: (link) => ticketBundleFetcher({ link: link as never, base: "http://127.0.0.1:1", ticketMs: 40 }) });
    r.rows(0, 3, [{ key: "plugin:botling.note", rev: 2, body: plugin("h-note", refOf(A1)) }, { key: "plugin:botling.usage", rev: 3, body: plugin("h-usage", refOf(A2)) }]);
    await flush();
    const started = Date.now();
    const [note, usage] = await Promise.all([
      r.adapter.request({ type: "plugins.panel", name: "botling.note", panel: "botling.note.tab" }),
      r.adapter.request({ type: "plugins.panel", name: "botling.usage", panel: "botling.usage.settings" }),
    ]);
    expect(note).toEqual({ ok: true, result: { title: "t", source: "SERVER-PANEL-botling.note", settings: {} } });
    expect(usage).toEqual({ ok: true, result: { title: "t", source: "SERVER-PANEL-botling.usage", settings: {} } });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The ask was made, and nobody answered it.
    expect(r.server.received.filter((message) => message.t === "content.ticket")).toHaveLength(2);
  });
});
