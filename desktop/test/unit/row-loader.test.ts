// M7-09b: the row loader (renderer/shell/row-loader.ts). A framed plugin's web part is loaded from the plugin's row in the attached
// server's own table, by the content reference `files.web` names (M7-09a):
//   - a row change swaps that plugin only (another plugin's instance keeps its generation and its registrations); its dependents
//     unload first (D64) and load again when its services are back (D65);
//   - a web part that cannot be had leaves the old code running; a newer row wins over a fetch still on its way;
//   - the build's own copy runs in the page when the manifest lists exactly that (name, hash) (the manifest is the one built into the
//     bundle); any other code is a frame, from the bytes the row names;
//   - the ticket fetcher asks for `seq: 1` of the plugin's row entry, names the plugin of the request, checks the hash, and keeps nothing it
//     could not verify;
//   - an outbox item the old code caused keeps its `via` and gets one outcome: on the live instance, or the shell's pending view.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { Kernel } from "../../../Web/src/plugin-kernel";
import {
  RowLoader, followRows, plansOf, ticketBundleFetcher, webInstance, webRefOf, MAX_BUNDLE_BYTES,
  type BundleFetcher, type BundleRequest, type BundleTicketPort, type OutcomeItem, type RowsLink,
} from "../../src/renderer/shell/row-loader";
import type { InPageSource } from "../../src/renderer/shell/inpage-loader";
import { desktop } from "../helpers";

const hex = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const refOf = (text: string) => `sha256:${hex(text)}`;
const H64 = (letter: string) => letter.repeat(64);
/** A code hash as the rows carry it: 64 hex characters (the in-page loader refuses any other shape). */
const h = (tag: string) => hex(`code ${tag}`);

const A1 = "plugin a, version 1";
const A2 = "plugin a, version 2";
const A3 = "plugin a, version 3";
const B1 = "plugin b";
const C1 = "plugin c";
const SOURCES: Record<string, string> = Object.fromEntries([A1, A2, A3, B1, C1].map((text) => [refOf(text), text]));

interface RowOver { web?: string | null; provides?: string[]; requires?: string[]; uses?: string[] }
/** A `plugin:<name>` row body. */
function row(codeHash: string, over: RowOver = {}): unknown {
  return {
    codeHash,
    manifest: { tier: "read", reads: [], requests: [], owns: [], provides: over.provides ?? [], requires: over.requires ?? [], uses: over.uses ?? [], clients: [], needsShell: [] },
    author: "user",
    ...(over.web ? { files: { web: over.web } } : {}),
    grants: {},
  };
}
const rowsOf = (plugins: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(plugins).map(([name, body]) => [`plugin:${name}`, body]));

/** A fetcher over `SOURCES` that records each request. `gate` holds back the fetch of one reference. */
function fetcher(options: { gate?: { ref: string; until: Promise<void> }; missing?: Set<string> } = {}) {
  const calls: BundleRequest[] = [];
  const fetch: BundleFetcher = async (request) => {
    calls.push(request);
    if (options.gate && request.ref === options.gate.ref) await options.gate.until;
    const text = SOURCES[request.ref];
    if (text === undefined || options.missing?.has(request.ref)) throw new Error("gone");
    return text;
  };
  return { fetch, calls };
}

function setup(over: Partial<ConstructorParameters<typeof RowLoader>[0]> = {}) {
  const kernel = new Kernel({ log: true });
  const f = fetcher();
  const lines: string[] = [];
  const loader = new RowLoader({ kernel, fetch: f.fetch, manifest: { plugins: [] }, log: (line) => lines.push(line), ...over });
  return { kernel, loader, f, lines };
}

const eventAt = (kernel: Kernel, action: string, plugin: string, generation?: number) =>
  kernel.events.findIndex((event) => event.action === action && event.plugin === plugin && (generation === undefined || event.generation === generation));

describe("rows as plans", () => {
  it("takes the plugin's name from the row key, and reads one content reference from `files.web`", () => {
    const plans = plansOf(rowsOf({ a: row("h1", { web: refOf(A1) }), b: row("h2") }));
    expect([...plans.keys()]).toEqual(["a", "b"]);
    expect(plans.get("a")).toMatchObject({ name: "a", codeHash: "h1", ref: refOf(A1) });
    expect(plans.get("b")?.ref).toBeNull();
  });

  it("leaves out a row that is not a plugin row, a key that is not a plugin's name, and keys of other kinds", () => {
    const rows = new Map<string, unknown>([
      ["plugin:ok", row("h1")],
      ["plugin:__proto__", row("h1")],
      ["plugin:Upper", row("h1")],
      ["plugin:", row("h1")],
      ["plugin:broken", { codeHash: 5 }],
      ["bot:x", row("h1")],
      ["machine", {}],
    ]);
    expect([...plansOf(rows).keys()]).toEqual(["ok"]);
    expect(plansOf(null).size).toBe(0);
  });

  it("accepts only an exact reference as the web part, and reads it as an own property", () => {
    expect(webRefOf({ web: refOf(A1) })).toBe(refOf(A1));
    for (const bad of [null, undefined, 5, "x", {}, { web: 5 }, { web: "sha256:xyz" }, { web: `${refOf(A1)}\n` }, { web: `sha256:${H64("A")}` }, { web: "../x" }, Object.create({ web: refOf(A1) })]) {
      expect(webRefOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("a row loads a frame", () => {
  it("fetches the reference the row names for the plugin the row names, and holds the bytes while the instance is active", async () => {
    const { kernel, loader, f } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    expect(f.calls).toEqual([{ plugin: "a", ref: refOf(A1) }]);
    expect(kernel.state(webInstance("a"))).toBe("active");
    expect(loader.webSource("a")).toEqual({ codeHash: h("a1"), ref: refOf(A1), source: A1 });
    expect(loader.loaded()).toEqual([{ name: "a", where: "frame", codeHash: h("a1") }]);
    // The same row again changes nothing: no second fetch, no new instance.
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    expect(f.calls).toHaveLength(1);
    expect(kernel.generation(webInstance("a"))).toBe(1);
  });

  it("does nothing for a row with no reference (plugins.web is its source), and never fetches for it", async () => {
    const { loader, f, kernel } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1")) }));
    expect(f.calls).toEqual([]);
    expect(loader.webSource("a")).toBeNull();
    expect(kernel.installed()).toEqual([]);
  });

  it("unloads a plugin whose row is gone, or whose row lost its reference", async () => {
    const { loader, kernel } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }), b: row(h("b1"), { web: refOf(B1) }) }));
    await loader.reconcile(rowsOf({ a: row(h("a2")), b: row(h("b1"), { web: refOf(B1) }) }));
    expect(loader.webSource("a")).toBeNull();
    expect(kernel.state(webInstance("a"))).toBe("absent");
    expect(kernel.declaration(webInstance("a"))).toBeUndefined();
    await loader.reconcile(rowsOf({}));
    expect(loader.webSource("b")).toBeNull();
    expect(kernel.installed()).toEqual([]);
  });
});

describe("a row change swaps that plugin only", () => {
  it("another plugin's instance keeps its generation and registrations, and is not fetched again", async () => {
    const { kernel, loader, f } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }), b: row(h("b1"), { web: refOf(B1) }) }));
    let bUndone = 0;
    kernel.register(webInstance("b"), "counter", "n", () => { bUndone += 1; });
    const bGeneration = kernel.generation(webInstance("b"));
    await loader.reconcile(rowsOf({ a: row(h("a2"), { web: refOf(A2) }), b: row(h("b1"), { web: refOf(B1) }) }));
    expect(loader.webSource("a")).toEqual({ codeHash: h("a2"), ref: refOf(A2), source: A2 });
    expect(kernel.generation(webInstance("a"))).toBe(2);
    expect(kernel.generation(webInstance("b"))).toBe(bGeneration);
    expect(kernel.state(webInstance("b"))).toBe("active");
    expect(bUndone).toBe(0);
    expect(loader.webSource("b")?.source).toBe(B1);
    expect(f.calls.filter((call) => call.plugin === "b")).toHaveLength(1);
    // The old copy of a was undone once, and the swap is in the kernel's log.
    expect(kernel.events.filter((event) => event.action === "Swap" && event.plugin === webInstance("a"))).toHaveLength(1);
    expect(kernel.events.some((event) => event.plugin === webInstance("b") && event.action === "Swap")).toBe(false);
  });

  it("a plugin whose dependents require its service: they unload first (D64) and load again when it is back (D65)", async () => {
    const { kernel, loader } = setup();
    const rows = (a: string, web: string) => rowsOf({ a: row(a, { web, provides: ["svc.a"] }), c: row(h("c1"), { web: refOf(C1), requires: ["svc.a"] }) });
    await loader.reconcile(rows(h("a1"), refOf(A1)));
    expect(loader.webSource("c")?.source).toBe(C1);
    expect(kernel.generation(webInstance("c"))).toBe(1);
    await loader.reconcile(rows(h("a2"), refOf(A2)));
    // c finished unloading before a's own undos began.
    const cGone = eventAt(kernel, "FinishUnload", webInstance("c"), 1);
    const aBegins = eventAt(kernel, "BeginUnload", webInstance("a"), 1);
    expect(cGone).toBeGreaterThan(-1);
    expect(aBegins).toBeGreaterThan(cGone);
    // Both are up again; c was not fetched again (its row did not change).
    expect(loader.webSource("a")?.source).toBe(A2);
    expect(loader.webSource("c")?.source).toBe(C1);
    expect(kernel.generation(webInstance("c"))).toBe(2);
  });

  it("a plugin that goes away leaves its dependents waiting; they load again when the plugin's row is back", async () => {
    const { kernel, loader, f } = setup();
    const withA = rowsOf({ a: row(h("a1"), { web: refOf(A1), provides: ["svc.a"] }), c: row(h("c1"), { web: refOf(C1), requires: ["svc.a"] }) });
    await loader.reconcile(withA);
    await loader.reconcile(rowsOf({ c: row(h("c1"), { web: refOf(C1), requires: ["svc.a"] }) }));
    expect(loader.webSource("a")).toBeNull();
    expect(loader.webSource("c")).toBeNull();
    expect(kernel.wanted()).toContain(webInstance("c"));
    expect(kernel.waitingFor(webInstance("c"))).toEqual(['"svc.a"']);
    await loader.reconcile(withA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loader.webSource("a")?.source).toBe(A1);
    expect(loader.webSource("c")?.source).toBe(C1);
    // c's bytes were held by its loader: only a was fetched again.
    expect(f.calls.filter((call) => call.plugin === "c")).toHaveLength(1);
  });

  it("a declaration the kernel refuses (a service another plugin provides) fails that plugin only", async () => {
    const { loader, lines } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1), provides: ["svc.x"] }), b: row(h("b1"), { web: refOf(B1), provides: ["svc.x"] }) }));
    const running = ["a", "b"].filter((name) => loader.webSource(name));
    expect(running).toHaveLength(1);
    expect(lines.some((line) => line.includes("cannot be declared"))).toBe(true);
  });
});

describe("a web part that cannot be had, and a row that moves on", () => {
  it("a fetch that fails leaves the old code running; it is not tried again until the row changes or retry()", async () => {
    const missing = new Set<string>([refOf(A2)]);
    const f = fetcher({ missing });
    const { kernel, loader, lines } = setup({ fetch: f.fetch });
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    await loader.reconcile(rowsOf({ a: row(h("a2"), { web: refOf(A2) }) }));
    expect(loader.webSource("a")?.source).toBe(A1);
    expect(kernel.generation(webInstance("a"))).toBe(1);
    expect(lines.some((line) => line.includes("was not loaded"))).toBe(true);
    const asked = f.calls.length;
    await loader.reconcile(rowsOf({ a: row(h("a2"), { web: refOf(A2) }) }));
    expect(f.calls).toHaveLength(asked);
    missing.clear();
    await loader.retry();
    expect(loader.webSource("a")?.source).toBe(A2);
    expect(kernel.generation(webInstance("a"))).toBe(2);
  });

  it("a newer row wins over a fetch still on its way: the stale bytes are never activated", async () => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    const f = fetcher({ gate: { ref: refOf(A2), until } });
    const { loader } = setup({ fetch: f.fetch });
    const seen: (string | undefined)[] = [];
    loader.subscribe(() => seen.push(loader.webSource("a")?.source));
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    const second = loader.reconcile(rowsOf({ a: row(h("a2"), { web: refOf(A2) }) }));
    const third = loader.reconcile(rowsOf({ a: row(h("a3"), { web: refOf(A3) }) }));
    release();
    await Promise.all([second, third]);
    expect(loader.webSource("a")?.source).toBe(A3);
    expect(seen).not.toContain(A2);
  });

  it("a row that goes while its fetch is on its way is not loaded when the bytes arrive", async () => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    const f = fetcher({ gate: { ref: refOf(A1), until } });
    const { loader, kernel } = setup({ fetch: f.fetch });
    const first = loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    const gone = loader.reconcile(rowsOf({}));
    release();
    await Promise.all([first, gone]);
    expect(loader.webSource("a")).toBeNull();
    expect(kernel.installed()).toEqual([]);
  });
});

describe("the build's own copy", () => {
  function inPage() {
    const log: string[] = [];
    let live = 0;
    const source: InPageSource = () => ({ activate: () => { log.push("activate"); live += 1; return () => { log.push("dispose"); live -= 1; }; } });
    return { log, source, live: () => live };
  }

  it("runs in the page when the manifest lists exactly the row's (name, hash); nothing is fetched", async () => {
    const page = inPage();
    const { loader, f, kernel } = setup({ manifest: { plugins: [{ name: "botling.x", codeHash: H64("a") }] }, source: page.source });
    await loader.reconcile(rowsOf({ "botling.x": row(H64("a"), { web: refOf(A1) }) }));
    expect(loader.loaded()).toEqual([{ name: "botling.x", where: "page", codeHash: H64("a") }]);
    expect(page.log).toEqual(["activate"]);
    expect(f.calls).toEqual([]);
    expect(kernel.installed()).toEqual([]);
    // The same row again does not reload it.
    await loader.reconcile(rowsOf({ "botling.x": row(H64("a"), { web: refOf(A1) }) }));
    expect(page.log).toEqual(["activate"]);
  });

  it("a built-in whose code a bot edited (another hash) is undone in the page and runs as a frame from its bytes", async () => {
    const page = inPage();
    const { loader, f } = setup({ manifest: { plugins: [{ name: "botling.x", codeHash: H64("a") }] }, source: page.source });
    await loader.reconcile(rowsOf({ "botling.x": row(H64("a"), { web: refOf(A1) }) }));
    await loader.reconcile(rowsOf({ "botling.x": row(H64("b"), { web: refOf(A2) }) }));
    expect(page.log).toEqual(["activate", "dispose"]);
    expect(page.live()).toBe(0);
    expect(f.calls).toEqual([{ plugin: "botling.x", ref: refOf(A2) }]);
    expect(loader.loaded()).toEqual([{ name: "botling.x", where: "frame", codeHash: H64("b") }]);
  });

  it("is undone when its row is gone", async () => {
    const page = inPage();
    const { loader } = setup({ manifest: { plugins: [{ name: "botling.x", codeHash: H64("a") }] }, source: page.source });
    await loader.reconcile(rowsOf({ "botling.x": row(H64("a")) }));
    await loader.reconcile(rowsOf({}));
    expect(page.log).toEqual(["activate", "dispose"]);
    expect(loader.loaded()).toEqual([]);
  });

  it("is read from the manifest built into the bundle (`embeddedFeManifest`), not fetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-row-loader-"));
    try {
      const entry = join(dir, "entry.ts");
      const outfile = join(dir, "out.cjs");
      writeFileSync(entry, `export * from ${JSON.stringify(join(desktop, "src/renderer/shell/row-loader"))};\n`);
      const manifest = JSON.stringify({ plugins: [{ name: "botling.x", codeHash: H64("c") }] });
      await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", define: { __FE_MANIFEST__: JSON.stringify(manifest) }, logLevel: "silent" });
      const built = createRequire(outfile)(outfile) as { RowLoader: typeof RowLoader };
      const page = inPage();
      const loader = new built.RowLoader({ kernel: new Kernel(), fetch: async () => { throw new Error("no fetch"); }, source: page.source, log: () => undefined });
      await loader.reconcile(rowsOf({ "botling.x": row(H64("c")) }));
      expect(loader.loaded().map((entry) => entry.where)).toEqual(["page"]);
      // Without the define (any other build) the manifest is empty: the same row is not run in the page.
      mkdirSync(join(dir, "plain"));
      const plain = join(dir, "plain", "out.cjs");
      await build({ entryPoints: [entry], outfile: plain, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
      const other = new (createRequire(plain)(plain) as { RowLoader: typeof RowLoader }).RowLoader({ kernel: new Kernel(), fetch: async () => { throw new Error("no fetch"); }, source: page.source, log: () => undefined });
      await other.reconcile(rowsOf({ "botling.x": row(H64("c")) }));
      expect(other.loaded()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the outcome of an item the old code caused", () => {
  const slot = (n: number) => ({ origin: "desktop", originEpoch: "e".repeat(32), target: "srv:s1", n }) as unknown as OutcomeItem["slot"];
  const item = (n: number, plugin: string, codeHash: string): OutcomeItem => ({ slot: slot(n), via: { plugin, codeHash } });

  it("keeps its via and is shown once on the live instance after a swap; a second outcome for it is dropped", async () => {
    const pending: OutcomeItem[] = [];
    const { loader } = setup({ pending: (outcome) => pending.push(outcome) });
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }), b: row(h("b1"), { web: refOf(B1) }) }));
    const shownOnA: OutcomeItem[] = [];
    const shownOnB: OutcomeItem[] = [];
    loader.attach("a", (outcome) => shownOnA.push(outcome));
    loader.attach("b", (outcome) => shownOnB.push(outcome));
    const old = item(1, "a", h("a1"));
    await loader.reconcile(rowsOf({ a: row(h("a2"), { web: refOf(A2) }), b: row(h("b1"), { web: refOf(B1) }) }));
    expect(loader.route(old)).toBe("instance");
    expect(loader.route(old)).toBe("duplicate");
    expect(shownOnA).toHaveLength(1);
    // The item still names the old code: the swap did not rewrite it.
    expect(shownOnA[0]!.via).toEqual({ plugin: "a", codeHash: h("a1") });
    expect(shownOnB).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("goes to the shell's pending view once when its plugin has no live instance", async () => {
    const pending: OutcomeItem[] = [];
    const { loader } = setup({ pending: (outcome) => pending.push(outcome) });
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    const shown: OutcomeItem[] = [];
    loader.attach("a", (outcome) => shown.push(outcome));
    await loader.reconcile(rowsOf({}));
    const caused = item(2, "a", h("a1"));
    expect(loader.route(caused)).toBe("pending");
    expect(loader.route(caused)).toBe("duplicate");
    expect(pending).toEqual([caused]);
    expect(shown).toEqual([]);
  });

  it("is not shown on another plugin's instance, and an item with no via has nowhere to go", async () => {
    const pending: OutcomeItem[] = [];
    const { loader } = setup({ pending: (outcome) => pending.push(outcome) });
    await loader.reconcile(rowsOf({ b: row(h("b1"), { web: refOf(B1) }) }));
    const shownOnB: OutcomeItem[] = [];
    loader.attach("b", (outcome) => shownOnB.push(outcome));
    expect(loader.route(item(3, "a", h("a1")))).toBe("pending");
    expect(loader.route({ slot: slot(4) })).toBe("none");
    expect(shownOnB).toEqual([]);
    expect(pending).toHaveLength(1);
  });
});

describe("the ticket fetcher", () => {
  const TICKET = "T".repeat(43);
  function port(server: string | null = "srvA", answer: () => { t: string; ticket?: unknown; reason?: unknown } = () => ({ t: "content.granted", ticket: TICKET })) {
    const asked: unknown[] = [];
    const link: BundleTicketPort = { server, remoteContent: async (message) => { asked.push(message); return answer(); } };
    return { link, asked };
  }
  function web(bytes: Uint8Array | string, status = 200) {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(String(url)); return new Response(typeof bytes === "string" ? bytes : (bytes as BodyInit), { status }); }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it("asks for seq 1 of the plugin's row entry in the attached server's srv: stream, naming the plugin of the request", async () => {
    const { link, asked } = port();
    const { fetchImpl, urls } = web(A1);
    const fetchBundle = ticketBundleFetcher({ link, base: "http://page.example/", fetch: fetchImpl });
    expect(await fetchBundle({ plugin: "a", ref: refOf(A1) })).toBe(A1);
    expect(asked).toEqual([{ t: "content.ticket", owner: "srvA", id: refOf(A1), entry: { stream: "srv:srvA", seq: 1 }, plugin: "a" }]);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.origin).toBe("http://page.example");
    expect(url.pathname).toBe(`/v3/c/srvA/${encodeURIComponent(refOf(A1))}/original`);
    expect(url.searchParams.get("e")).toBe("srv:srvA.1");
    expect(url.searchParams.get("t")).toBe(TICKET);
    expect(url.searchParams.get("p")).toBe("a");
  });

  it("refuses bytes that do not hash to the reference, and does not keep them", async () => {
    const { link, asked } = port();
    const { fetchImpl } = web("other bytes");
    const fetchBundle = ticketBundleFetcher({ link, base: "http://page.example", fetch: fetchImpl });
    await expect(fetchBundle({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/not the web part/);
    await expect(fetchBundle({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/not the web part/);
    expect(asked).toHaveLength(2);
  });

  it("refuses a bundle over the size cap before it hashes it", async () => {
    const big = new Uint8Array(MAX_BUNDLE_BYTES + 1);
    const { link } = port();
    const { fetchImpl } = web(big);
    const fetchBundle = ticketBundleFetcher({ link, base: "http://page.example", fetch: fetchImpl });
    await expect(fetchBundle({ plugin: "a", ref: `sha256:${hex(big)}` })).rejects.toThrow(/too large/);
  });

  it("rejects when there is no ticket (a refusal, or no session), an HTTP error, no address, or a request that is not a plugin and a reference", async () => {
    const gone = port("srvA", () => ({ t: "content.gone", reason: "denied" }));
    await expect(ticketBundleFetcher({ link: gone.link, base: "http://p", fetch: web(A1).fetchImpl })({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/no ticket/);
    const detached = port(null);
    await expect(ticketBundleFetcher({ link: detached.link, base: "http://p", fetch: web(A1).fetchImpl })({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/not attached/);
    expect(detached.asked).toEqual([]);
    const ok = port();
    await expect(ticketBundleFetcher({ link: ok.link, base: "http://p", fetch: web("x", 404).fetchImpl })({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/404/);
    await expect(ticketBundleFetcher({ link: port().link, base: () => null, fetch: web(A1).fetchImpl })({ plugin: "a", ref: refOf(A1) })).rejects.toThrow(/no content address/);
    const strict = port();
    const fetchBundle = ticketBundleFetcher({ link: strict.link, base: "http://p", fetch: web(A1).fetchImpl });
    for (const request of [{ plugin: "../x", ref: refOf(A1) }, { plugin: "A", ref: refOf(A1) }, { plugin: "a", ref: "sha256:zz" }, { plugin: "a", ref: `${refOf(A1)}/..` }]) {
      await expect(fetchBundle(request), JSON.stringify(request)).rejects.toThrow(/not a plugin/);
    }
    expect(strict.asked).toEqual([]);
  });

  it("keeps a verified bundle per server, plugin and reference: a second plugin asks for its own ticket", async () => {
    const { link, asked } = port();
    const { fetchImpl, urls } = web(A1);
    const fetchBundle = ticketBundleFetcher({ link, base: "http://p", fetch: fetchImpl });
    await fetchBundle({ plugin: "a", ref: refOf(A1) });
    await fetchBundle({ plugin: "a", ref: refOf(A1) });
    expect(asked).toHaveLength(1);
    await fetchBundle({ plugin: "other", ref: refOf(A1) });
    expect(asked).toHaveLength(2);
    expect((asked[1] as { plugin: string }).plugin).toBe("other");
    expect(urls).toHaveLength(2);
  });
});

describe("following the link's rows", () => {
  function rig(initial: Map<string, unknown> | null) {
    let rows = initial;
    const listeners = new Set<(event: { type: string; table?: { stream: string }; attached?: boolean }) => void>();
    const link: RowsLink = {
      server: "s1",
      table: (id) => (id === "s1" && rows ? { rows } : null),
      on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const emit = (event: { type: string; table?: { stream: string }; attached?: boolean }) => { for (const listener of [...listeners]) listener(event); };
    return { link, emit, set: (next: Map<string, unknown>) => { rows = next; }, listeners };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("loads at once, follows a change of the attached server's own table, and ignores another server's", async () => {
    const r = rig(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    const { loader, f } = setup();
    const off = followRows(loader, r.link);
    await settle();
    expect(loader.webSource("a")?.source).toBe(A1);
    r.set(rowsOf({ a: row(h("a2"), { web: refOf(A2) }) }));
    r.emit({ type: "servers", table: { stream: "srv:peer" } });
    await settle();
    expect(loader.webSource("a")?.source).toBe(A1);
    r.emit({ type: "servers", table: { stream: "srv:s1" } });
    await settle();
    expect(loader.webSource("a")?.source).toBe(A2);
    expect(f.calls.map((call) => call.ref)).toEqual([refOf(A1), refOf(A2)]);
    off();
    expect(r.listeners.size).toBe(0);
  });

  it("changes nothing while the link holds no table for the server (an older server sends none)", async () => {
    const r = rig(null);
    const { loader, f } = setup();
    followRows(loader, r.link);
    r.emit({ type: "servers", table: { stream: "srv:s1" } });
    await settle();
    expect(f.calls).toEqual([]);
  });

  it("a re-attach tries again what failed", async () => {
    const missing = new Set<string>([refOf(A1)]);
    const f = fetcher({ missing });
    const r = rig(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    const { loader } = setup({ fetch: f.fetch });
    followRows(loader, r.link);
    await settle();
    expect(loader.webSource("a")).toBeNull();
    missing.clear();
    r.emit({ type: "attached", attached: true });
    await settle();
    expect(loader.webSource("a")?.source).toBe(A1);
  });
});

describe("stop", () => {
  it("unloads everything the loader runs, and later rows do nothing", async () => {
    const { loader, kernel } = setup();
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    await loader.stop();
    expect(kernel.installed()).toEqual([]);
    expect(loader.loaded()).toEqual([]);
    await loader.reconcile(rowsOf({ a: row(h("a1"), { web: refOf(A1) }) }));
    expect(kernel.installed()).toEqual([]);
  });
});
