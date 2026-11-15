// M7-09c (plan-change §4.3 check 3; Q-M7-C1): a plugin's row changes and every front end runs the new code within 5 s, with no refresh.
//   - the desktop window (the renderer adapter: `plugins.updated`, then the frames ask again) and two pages (the row loader on a kernel)
//     all run the new web part; another plugin's frame keeps its generation and its source, and is not fetched again;
//   - a newer row never waits for a fetch of an older one that is stuck;
//   - 20 swaps during the airplane script (the link cut and re-dialled) lose and double nothing: each command is applied once, each
//     outbox item has one outcome, and the item keeps the `via` the old code gave it;
//   - a server switch: the new server's rows are reconciled with what runs: the same (name, codeHash) keeps running untouched, another
//     hash swaps, a plugin the new server lacks unloads; what was being fetched for the old server is dropped; a plugin that failed on the
//     old server is tried again on the new one; the outbox stays the shell's.
// The harness is the real FeLink over fe-link-harness's FakeServer (a second server for a switch), a fake clock that also times the
// fetches, and the real RendererAdapter / RowLoader / Kernel.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter } from "../../src/main-v3/renderer-adapter";
import { slotKey, type Message } from "../../src/protocol";
import { Kernel } from "../../../Web/src/plugin-kernel";
import type { InPageSource } from "../../src/renderer/shell/inpage-loader";
import { RowLoader, followRows, webInstance, type BundleFetcher, type BundleRequest, type OutcomeItem, type RowsLink } from "../../src/renderer/shell/row-loader";
import { BOT, FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const hex = (text: string) => createHash("sha256").update(text).digest("hex");
const refOf = (text: string) => `sha256:${hex(text)}`;
const code = (tag: string) => hex(`code ${tag}`);
const HOT_UPDATE_BUDGET_MS = 5_000;

const A = (n: number) => `plugin a, version ${n}`;
const B1 = "plugin b";
const B2 = "plugin b, version 2";
const C1 = "plugin c";
const SOURCES: Record<string, string> = {};
for (const text of [...Array.from({ length: 25 }, (_, i) => A(i + 1)), B1, B2, C1]) SOURCES[refOf(text)] = text;

const EMPTY = { reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
/** A `plugin:<name>` row body naming its web bundle. */
const row = (text: string, tag = text) => ({ codeHash: code(tag), manifest: { tier: "read", ...EMPTY }, author: "user", files: { web: refOf(text) }, grants: {} });
type Table = Record<string, unknown | null>;

/** A fake botlingd that can be any server: its welcome names `id`; the own `srv:<id>` table's rows are sent as `rows` frames. */
class HotServer extends FakeServer {
  rev = 0;
  /** The names `plugins.web` lists (the server's own answer; a framed plugin's source there is the fallback). */
  specNames: string[] = ["a", "b"];
  private readonly held = new Map<string, { body: unknown; rev: number }>();
  constructor(readonly id: string) { super(); }
  override send(message: Message): void {
    super.send(message.t === "welcome" ? { ...message, serverId: this.id } : message);
  }
  /**
   * Changes rows (null removes one) and sends the whole table (`after: 0`, what a server sends after a `sub`): a delta lost to a cut
   * link would leave a gap the front end drops, and the airplane script cuts the link.
   */
  publish(change: Table): void {
    for (const [name, body] of Object.entries(change)) {
      const key = `plugin:${name}`;
      this.rev += 1;
      if (body === null) this.held.delete(key); else this.held.set(key, { body, rev: this.rev });
    }
    this.rev += 1;
    const rows = [...this.held].map(([key, held]) => ({ key, rev: held.rev, body: held.body })).sort((x, y) => x.rev - y.rev);
    this.sendWire({ t: "rows", stream: `srv:${this.id}`, logId: `incown-${this.id}`, after: 0, to: this.rev, rows, more: false });
  }
}

const links: FeLink[] = [];
const adapters: RendererAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  for (const link of links.splice(0)) await link.stop();
});

let epochs = 0;
const nextEpoch = () => (++epochs).toString(16).padStart(32, "0");

/** A fetcher over `SOURCES`; each fetch takes `ms` of the fake clock. `stuck` refs never answer; `gone` refs fail. */
function fetcher(clock: FakeClock, ms: number, options: { stuck?: Set<string>; gone?: Set<string> } = {}) {
  const calls: BundleRequest[] = [];
  const kept = new Map<string, Promise<string>>();
  // Like the real ticket fetcher: a bundle that was read is kept (by plugin and reference), a failure is not.
  const fetch: BundleFetcher = (request) => {
    const key = `${request.plugin}\u0000${request.ref}`;
    const held = kept.get(key);
    if (held) return held;
    const asked = read(request);
    kept.set(key, asked);
    asked.catch(() => { if (kept.get(key) === asked) kept.delete(key); });
    return asked;
  };
  const read = async (request: BundleRequest): Promise<string> => {
    calls.push(request);
    if (options.stuck?.has(request.ref)) await new Promise<never>(() => undefined);
    await new Promise<void>((resolve) => { clock.setTimeout(resolve, ms); });
    const text = SOURCES[request.ref];
    if (text === undefined || options.gone?.has(request.ref)) throw new Error("gone");
    return text;
  };
  return { fetch, calls };
}

const PLUGINS = { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null };

/** The server's answers for the window: a snapshot, and `plugins.web` listing each name with the server's own source. */
function answerRequests(server: HotServer): void {
  server.onMessage = (message: Message) => {
    if (message.t !== "req") return;
    const answer = (result: unknown) => server.send({ t: "res", req: message.req, ok: true, result });
    if (message.cmd.type === "chat.snapshot") answer({ epoch: "server", seq: 0, bots: [], imported: null, components: {}, plugins: PLUGINS, chat: null });
    else if (message.cmd.type === "plugins.web") answer({ specs: server.specNames.map((name) => ({ name, version: "1", source: `SERVER-${name}`, styles: [], settings: {}, commands: [] })) });
    else answer({});
  };
}

interface Window {
  link: FeLink;
  adapter: RendererAdapter;
  fetched: BundleRequest[];
  /** What the window's frames run: the sources of the last `plugins.web` it asked for (it asks again at each `plugins.updated`). */
  shown: Map<string, string>;
  /** The frames ask for `plugins.web` now (what a re-bound frame does). */
  ask(): Promise<void>;
  updated(): number;
}

/** The desktop window: the renderer adapter over its own link. A frame asks again whenever the adapter says `plugins.updated`. */
async function openWindow(server: HotServer, clock: FakeClock, fetch: { fetch: BundleFetcher; calls: BundleRequest[] }): Promise<Window> {
  answerRequests(server);
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true });
  links.push(link);
  const shown = new Map<string, string>();
  let updates = 0;
  let adapter!: RendererAdapter;
  const ask = async () => {
    const answer = await adapter.request({ type: "plugins.web" });
    if (!answer.ok) return;
    shown.clear();
    for (const spec of (answer.result as { specs: { name: string; source: string }[] }).specs) shown.set(spec.name, spec.source);
  };
  adapter = new RendererAdapter({
    link, clock, newEpoch: () => "e1", bundles: fetch.fetch,
    emit: (envelope: EventEnvelope | { id: string }) => { if ("event" in envelope && envelope.event.type === "plugins.updated") { updates += 1; void ask(); } },
  } as never);
  adapters.push(adapter);
  adapter.start();
  link.start();
  await flush();
  await adapter.request({ type: "chat.snapshot" });
  await ask();
  return { link, adapter, fetched: fetch.calls, shown, ask, updated: () => updates };
}

interface Page {
  link: FeLink;
  kernel: Kernel;
  loader: RowLoader;
  fetched: BundleRequest[];
  lines: string[];
  /** What the page's frame of `name` runs, or null. */
  runs(name: string): string | null;
  stop(): Promise<void>;
}

/** A headless page: the row loader following the link's rows (what `mountRenderer` does), on a kernel of its own. */
async function openPage(server: HotServer, clock: FakeClock, fetch: { fetch: BundleFetcher; calls: BundleRequest[] }, storage = new MemoryFeStorage()): Promise<Page> {
  const link = await FeLink.open({ storage, dial: server.dial, deviceId: "phone", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true });
  links.push(link);
  link.subscribe(BOT);
  const kernel = new Kernel({ log: true });
  const lines: string[] = [];
  const loader = new RowLoader({ kernel, fetch: fetch.fetch, manifest: { plugins: [] }, log: (line) => lines.push(line) });
  const off = followRows(loader, link as unknown as RowsLink);
  link.start();
  await flush();
  return {
    link, kernel, loader, fetched: fetch.calls, lines,
    runs: (name) => loader.webSource(name)?.source ?? null,
    stop: async () => { off(); await loader.stop(); },
  };
}

/** Advances the fake clock in 100 ms steps until `done`, and returns the fake time that took (the budget caps it). */
async function until(clock: FakeClock, done: () => boolean, budget = HOT_UPDATE_BUDGET_MS): Promise<number> {
  const start = clock.now();
  await flush(8);
  while (!done() && clock.now() - start < budget) { clock.advance(100); await flush(8); }
  return clock.now() - start;
}

/** Runs the fake clock until `promise` settles (a fetch that takes fake time), then returns its value. */
async function settle<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await until(clock, () => done);
  return promise;
}

describe("hot update: the window and two pages run the new code within 5 s", () => {
  it("a bot edits plugin a: all three front ends run the new bytes without a refresh; plugin b keeps its frame and is not fetched again", async () => {
    const clock = new FakeClock();
    const servers = [new HotServer("srv1"), new HotServer("srv1"), new HotServer("srv1")];
    const win = await openWindow(servers[0]!, clock, fetcher(clock, 300));
    const pageOne = await openPage(servers[1]!, clock, fetcher(clock, 300));
    const pageTwo = await openPage(servers[2]!, clock, fetcher(clock, 300));
    const publish = (change: Table) => servers.forEach((server) => server.publish(change));
    publish({ a: row(A(1)), b: row(B1) });
    expect(await until(clock, () => pageOne.runs("a") === A(1) && pageTwo.runs("a") === A(1) && pageOne.runs("b") === B1 && pageTwo.runs("b") === B1)).toBeLessThan(HOT_UPDATE_BUDGET_MS);
    // The window's frames ask after the rows came: the code of each comes from its row.
    await settle(clock, win.ask());
    expect([win.shown.get("a"), win.shown.get("b")]).toEqual([A(1), B1]);
    const generationB = [pageOne, pageTwo].map((page) => page.kernel.generation(webInstance("b")));
    const fetchedBBefore = [win, pageOne, pageTwo].map((fe) => fe.fetched.filter((call) => call.ref === refOf(B1)).length);
    const hellos = servers.map((server) => server.received.filter((message) => message.t === "hello").length);
    const t0 = clock.now();

    publish({ a: row(A(2)) });
    const took = await until(clock, () => pageOne.runs("a") === A(2) && pageTwo.runs("a") === A(2) && win.shown.get("a") === A(2));

    expect(clock.now() - t0).toBe(took);
    expect(took).toBeLessThan(HOT_UPDATE_BUDGET_MS);
    expect([win.shown.get("a"), pageOne.runs("a"), pageTwo.runs("a")]).toEqual([A(2), A(2), A(2)]);
    // Plugin b: the same generation, the same code, and no fetch of it again anywhere.
    expect([pageOne, pageTwo].map((page) => page.kernel.generation(webInstance("b")))).toEqual(generationB);
    expect([pageOne.runs("b"), pageTwo.runs("b"), win.shown.get("b")]).toEqual([B1, B1, B1]);
    expect([win, pageOne, pageTwo].map((fe) => fe.fetched.filter((call) => call.ref === refOf(B1)).length)).toEqual(fetchedBBefore);
    // No refresh: nobody dialled again.
    expect(servers.map((server) => server.received.filter((message) => message.t === "hello").length)).toEqual(hellos);
    // The window was told once for the move of a.
    expect(win.updated()).toBe(1);
  });

  it("a newer row does not wait behind a fetch of the older one that never answers", async () => {
    const clock = new FakeClock();
    const server = new HotServer("srv1");
    const stuck = new Set([refOf(A(2))]);
    const page = await openPage(server, clock, fetcher(clock, 100, { stuck }));
    server.publish({ a: row(A(1)) });
    await until(clock, () => page.runs("a") === A(1));
    server.publish({ a: row(A(2)) });
    await until(clock, () => false, 500);
    expect(page.runs("a")).toBe(A(1));
    server.publish({ a: row(A(3)) });
    const took = await until(clock, () => page.runs("a") === A(3));
    expect(page.runs("a")).toBe(A(3));
    expect(took).toBeLessThan(HOT_UPDATE_BUDGET_MS);
    expect(page.kernel.state(webInstance("a"))).toBe("active");
  });
});

describe("20 swaps during the airplane script lose and double nothing", () => {
  it("each command gets one outcome, none is applied twice, and an item keeps the via of the code that caused it", async () => {
    const clock = new FakeClock();
    const server = new HotServer("srv1");
    const page = await openPage(server, clock, fetcher(clock, 20));
    const outcomes = new Map<string, number>();
    const routed: OutcomeItem[] = [];
    const places: string[] = [];
    page.loader.attach("a", (item) => routed.push(item));
    page.link.on((event) => {
      if (event.type !== "outcome") return;
      const key = slotKey(event.item.slot);
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      places.push(page.loader.route(event.item as unknown as OutcomeItem));
    });
    server.publish({ a: row(A(1)), b: row(B1) });
    await until(clock, () => page.runs("a") === A(1) && page.runs("b") === B1);
    const generationB = page.kernel.generation(webInstance("b"));
    // Odd commands come from the shell (applied at once); even ones from plugin a's frame, stamped with the hash of the code that wrote them:
    // the harness's owner holds no grant for them, so it refuses each with one `grant` outcome (the owner's judgement is of the old hash).
    const submitted: string[] = [];
    const viaHashes: string[] = [];

    for (let i = 1; i <= 20; i += 1) {
      const via = i % 2 === 0 ? { plugin: "a", codeHash: code(A(i)) } : undefined;
      if (via) viaHashes.push(via.codeHash);
      const item = await page.link.submit(BOT, react(`m${i}`), undefined, via);
      submitted.push(slotKey(item.slot));
      server.publish({ a: row(A(i + 1)) });
      // The airplane script: the link is cut in the middle of the swaps, then comes back.
      if (i % 4 === 0) {
        server.kill();
        await flush();
        clock.advance(500);
        await flush();
        server.publish({ a: row(A(i + 1)) });
      }
      await until(clock, () => page.runs("a") === A(i + 1), 2_000);
      expect(page.runs("a"), `swap ${i}`).toBe(A(i + 1));
    }
    await until(clock, () => outcomes.size >= 20, 20_000);
    await flush(60);

    // Nothing lost: every command has an outcome; nothing doubled: one outcome each, and the owner applied each command at most once.
    expect([...outcomes.keys()].sort()).toEqual([...submitted].sort());
    expect([...outcomes.values()].every((count) => count === 1)).toBe(true);
    // What the shell still lists are the ten refusals ("not sent: grant", kept to be read); nothing waits, nothing is held, nothing is lost.
    expect(page.link.pending().filter((item) => item.state !== "not sent" || item.lost)).toEqual([]);
    expect(page.link.pending().filter((item) => item.reason === "grant")).toHaveLength(10);
    expect(server.applied).toHaveLength(10);
    expect(new Set(server.applied.map((applied) => slotKey(applied.slot))).size).toBe(10);
    // The items of plugin a were placed once each (on its live instance: it never stopped running), with the hash they were written under.
    expect(places.filter((place) => place === "instance")).toHaveLength(10);
    expect(places.filter((place) => place === "none")).toHaveLength(10);
    expect(routed.map((item) => item.via!.codeHash).sort()).toEqual([...viaHashes].sort());
    // Plugin b was never swapped; plugin a runs its last version.
    expect(page.kernel.generation(webInstance("b"))).toBe(generationB);
    expect(page.runs("a")).toBe(A(21));
  });
});

describe("a server switch (Q-M7-C1)", () => {
  const rowsA = { a: row(A(1)), b: row(B1), c: row(C1) };

  async function attachedToA() {
    const clock = new FakeClock();
    const serverA = new HotServer("srvA");
    const serverB = new HotServer("srvB");
    const fetchA = fetcher(clock, 50);
    const page = await openPage(serverA, clock, fetchA);
    serverA.publish(rowsA);
    await until(clock, () => page.runs("a") === A(1) && page.runs("b") === B1 && page.runs("c") === C1);
    return { clock, serverA, serverB, page, fetchA };
  }

  const names = (page: Page) => ["a", "b", "c"].map((name) => page.kernel.generation(webInstance(name)));

  it("the same (name, codeHash) keeps running untouched, another hash swaps, a plugin the new server lacks unloads", async () => {
    const { clock, serverB, page, fetchA } = await attachedToA();
    const before = names(page);
    const fetchedBefore = fetchA.calls.length;
    page.link.replaceSocket(serverB.dial);
    await flush();
    // The new server's rows have not come: nothing was torn down on a guess.
    expect(page.link.server).toBe("srvB");
    expect([page.runs("a"), page.runs("b"), page.runs("c")]).toEqual([A(1), B1, C1]);
    serverB.publish({ a: row(A(1)), b: row(B2) });
    await until(clock, () => page.runs("b") === B2 && page.runs("c") === null);
    expect(page.runs("a")).toBe(A(1));
    expect(page.kernel.generation(webInstance("a"))).toBe(before[0]);
    expect(page.kernel.generation(webInstance("b"))).toBe(before[1]! + 1);
    expect(page.kernel.state(webInstance("c"))).toBe("absent");
    // Only b's new bundle was fetched.
    expect(fetchA.calls.slice(fetchedBefore)).toEqual([{ plugin: "b", ref: refOf(B2) }]);
  });

  it("a server with no plugin rows unloads them all once its (empty) table comes", async () => {
    const { clock, serverB, page } = await attachedToA();
    page.link.replaceSocket(serverB.dial);
    await flush();
    expect(page.runs("a")).toBe(A(1));
    serverB.publish({ z: null });
    await until(clock, () => page.loader.loaded().length === 0);
    expect(page.loader.loaded()).toEqual([]);
    expect(page.kernel.installed()).toEqual([]);
  });

  it("what was being fetched for the old server is dropped; the new server's row is fetched anew", async () => {
    const clock = new FakeClock();
    const serverA = new HotServer("srvA");
    const serverB = new HotServer("srvB");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: BundleRequest[] = [];
    const fetch: BundleFetcher = async (request) => {
      calls.push(request);
      if (calls.length === 1) { await gate; return SOURCES[request.ref]!; }
      return SOURCES[request.ref]!;
    };
    const page = await openPage(serverA, clock, { fetch, calls });
    serverA.publish({ a: row(A(1)) });
    await flush();
    expect(calls).toHaveLength(1);
    page.link.replaceSocket(serverB.dial);
    await flush();
    serverB.publish({ a: row(A(1)) });
    await flush();
    // The same plan on the new server is fetched again, for the new server, without waiting for the old fetch.
    expect(calls).toHaveLength(2);
    expect(page.runs("a")).toBe(A(1));
    const generation = page.kernel.generation(webInstance("a"));
    release();
    await flush();
    // The old fetch's answer is not used: no second instance, no swap.
    expect(page.kernel.generation(webInstance("a"))).toBe(generation);
    expect(page.loader.loaded()).toEqual([{ name: "a", where: "frame", codeHash: code(A(1)) }]);
  });

  it("a plugin that failed on the old server is tried again on the new one (same plan)", async () => {
    const clock = new FakeClock();
    const serverA = new HotServer("srvA");
    const serverB = new HotServer("srvB");
    const gone = new Set([refOf(A(1))]);
    const f = fetcher(clock, 10, { gone });
    const page = await openPage(serverA, clock, f);
    serverA.publish({ a: row(A(1)) });
    await until(clock, () => page.lines.some((line) => line.includes("was not loaded")));
    expect(page.runs("a")).toBeNull();
    gone.clear();
    const asked = f.calls.length;
    page.link.replaceSocket(serverB.dial);
    await until(clock, () => false, 500);
    // Attached to the new server before its rows came: the old server's failed plan is not asked of the new server.
    expect(f.calls).toHaveLength(asked);
    expect(page.runs("a")).toBeNull();
    serverB.publish({ a: row(A(1)) });
    await until(clock, () => page.runs("a") === A(1));
    expect(page.runs("a")).toBe(A(1));
  });

  it("a step that began for the old server and ends after the switch records nothing (L-008)", async () => {
    const kernel = new Kernel({ log: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let built = false;
    // The build's copy of plugin a is slow to come, and is missing the first time (the old server's step fails): a failure that belongs
    // to the old server must not stay on the plan for the new one.
    const source: InPageSource = async () => { await gate; return built ? { activate: () => () => undefined } : undefined; };
    const loader = new RowLoader({ kernel, fetch: async () => { throw new Error("no bundle"); }, manifest: { plugins: [{ name: "a", codeHash: code("a1") }] }, source, log: () => undefined });
    const rows = new Map<string, unknown>([["plugin:a", row(A(1), "a1")]]);
    const first = loader.reconcile(rows);
    await flush();
    loader.switchServer();
    release();
    await first;
    built = true;
    await loader.reconcile(rows);
    expect(loader.loaded()).toEqual([{ name: "a", where: "page", codeHash: code("a1") }]);
  });

  it("the outbox stays the shell's: an outcome of a plugin the new server lacks is shown once, in the pending view", async () => {
    const { clock, serverB, page } = await attachedToA();
    page.link.replaceSocket(serverB.dial);
    await flush();
    serverB.publish({ b: row(B1) });
    await until(clock, () => page.runs("c") === null);
    const item = { slot: { origin: "phone", originEpoch: "e1", target: BOT, n: 1 }, via: { plugin: "c", codeHash: code(C1) } } as unknown as OutcomeItem;
    expect(page.loader.route(item)).toBe("pending");
    expect(page.loader.route(item)).toBe("duplicate");
  });
});

describe("the window on a server switch", () => {
  async function windowOnA() {
    const clock = new FakeClock();
    const serverA = new HotServer("srvA");
    const serverB = new HotServer("srvB");
    answerRequests(serverB);
    const win = await openWindow(serverA, clock, fetcher(clock, 50));
    serverA.publish({ a: row(A(1)), b: row(B1) });
    await until(clock, () => false, 300);
    // The frames ask after the rows came: the code of each comes from its row.
    await settle(clock, win.ask());
    return { clock, serverA, serverB, win };
  }

  it("tells the window once when a plugin it was given from a row is gone on the new server; the one that is the same changes nothing", async () => {
    const { clock, serverB, win } = await windowOnA();
    serverB.specNames = ["b"];
    expect(win.shown.get("a")).toBe(A(1));
    expect(win.shown.get("b")).toBe(B1);
    const before = win.updated();
    win.link.replaceSocket(serverB.dial);
    await flush();
    serverB.publish({ b: row(B1) });
    await until(clock, () => !win.shown.has("a"), 1_000);
    expect(win.updated()).toBe(before + 1);
    expect([...win.shown.keys()]).toEqual(["b"]);
    expect(win.shown.get("b")).toBe(B1);
  });

  it("tells it too when the new server has no plugin rows at all", async () => {
    const { clock, serverB, win } = await windowOnA();
    serverB.specNames = [];
    const before = win.updated();
    win.link.replaceSocket(serverB.dial);
    await flush();
    serverB.publish({ z: null });
    await until(clock, () => win.shown.size === 0, 1_000);
    expect(win.updated()).toBe(before + 1);
    expect(win.shown.size).toBe(0);
  });
});
