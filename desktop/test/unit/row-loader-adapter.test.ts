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
import type { BundleFetcher, BundleRequest } from "../../src/renderer/shell/row-loader";
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
async function rig(options: { bundles?: (fetched: BundleRequest[]) => BundleFetcher | undefined } = {}): Promise<Rig> {
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
  const bundles = options.bundles ? options.bundles(fetched) : undefined;
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

  it("the first rows of a connection change nothing the window was told (it was given nothing from a row yet)", async () => {
    const r = await rig({ bundles: bySource(BUNDLES) });
    const before = r.updated();
    r.rows(0, 2, [{ key: "plugin:a", rev: 2, body: plugin("h-a1", refOf(A1)) }]);
    await flush();
    expect(r.updated()).toBe(before);
  });
});
