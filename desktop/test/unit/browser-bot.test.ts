// The in-app browser for bots, phase 2 (2026-11-10): each tab's network capture (a ring bounded in count and bytes),
// secret headers masked for bots, the request filters, the four bot tools' checks (browser-bot.ts), main's answers from
// the window's tabs with the tab's "reading" mark (browser-bot-host.ts), and how the core hands results to the model,
// saving data to the bot's .bot/browser/ (core/browser-tools.ts). Also: every engine lists the tools.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BODY_KEEP, MASKED, NetCapture, browserRequest, csvRows, filterRequests, forBot, maskHeaders, parseBrowserBotRequest, toCsv, type CapturedRequest,
} from "../../src/browser-bot";
import { BrowserBotHost, extractionCode, type BotBrowserWindow } from "../../src/main/browser-bot-host";
import { BrowserTabs, type TabPage } from "../../src/main/browser-tabs";
import { INLINE_MAX, runBrowserTool } from "../../src/core/browser-tools";
import { appTools, workerAppTools } from "../../src/core/app-tools/registry";
import { AgyMcpBridge } from "../../src/core/agent/agy-mcp";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import type { AppAnswer } from "../../src/core/server";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "botling-browser-bot-")); dirs.push(dir); return dir; };

function sent(capture: NetCapture, id: string, url: string, extra: Record<string, unknown> = {}) {
  return capture.handle("Network.requestWillBeSent", { requestId: id, type: "XHR", wallTime: 1_700_000_000, request: { url, method: "GET", headers: { Accept: "*/*" } }, ...extra });
}

describe("NetCapture", () => {
  it("builds one entry per request from the DevTools events, and asks for text bodies of XHR/Fetch/Document", () => {
    const capture = new NetCapture();
    sent(capture, "1", "https://api.example.com/items?page=1", { request: { url: "https://api.example.com/items?page=1", method: "POST", headers: { "Content-Type": "application/json" }, postData: "{\"q\":1}" } });
    capture.handle("Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: "sid=abc" } });
    capture.handle("Network.responseReceived", { requestId: "1", type: "Fetch", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: { "Content-Type": "application/json" } } });
    capture.handle("Network.responseReceivedExtraInfo", { requestId: "1", headers: { "Set-Cookie": "sid=def" } });
    expect(capture.handle("Network.loadingFinished", { requestId: "1", encodedDataLength: 321 })).toBe("1");
    capture.setBody("1", "{\"items\":[1,2]}", false);
    const entry = capture.get("1")!;
    expect(entry).toMatchObject({
      url: "https://api.example.com/items?page=1", method: "POST", type: "Fetch", status: 200, mimeType: "application/json", size: 321, finished: true,
      postData: "{\"q\":1}", body: "{\"items\":[1,2]}", bodyBase64: false, bodyTruncated: false,
      requestHeaders: { "Content-Type": "application/json", Cookie: "sid=abc" }, responseHeaders: { "Content-Type": "application/json", "Set-Cookie": "sid=def" },
    });
    expect(entry.started).toBe(1_700_000_000_000);
  });

  it("does not ask for images' or scripts' bodies, skips data: URLs, records failures and keeps redirect hops apart", () => {
    const capture = new NetCapture();
    capture.handle("Network.requestWillBeSent", { requestId: "img", type: "Image", request: { url: "https://cdn.example.com/a.png", method: "GET", headers: {} } });
    capture.handle("Network.responseReceived", { requestId: "img", type: "Image", response: { status: 200, mimeType: "image/png", headers: {} } });
    expect(capture.handle("Network.loadingFinished", { requestId: "img", encodedDataLength: 10 })).toBeNull();
    sent(capture, "d", "data:text/plain,hi");
    expect(capture.get("d")).toBeUndefined();
    sent(capture, "f", "https://example.com/fail");
    capture.handle("Network.loadingFailed", { requestId: "f", errorText: "net::ERR_BLOCKED" });
    expect(capture.get("f")).toMatchObject({ finished: true, failed: "net::ERR_BLOCKED" });
    sent(capture, "r", "http://example.com/old");
    sent(capture, "r", "https://example.com/new", { redirectResponse: { status: 301 } });
    expect(capture.get("r")!.url).toBe("https://example.com/new");
    expect(capture.all().some((each) => each.url === "http://example.com/old" && each.id.startsWith("r:"))).toBe(true);
  });

  it("keeps at most the newest N requests and about the byte cap (oldest go first), and cuts long bodies", () => {
    const capture = new NetCapture(3, 1_000_000);
    for (let i = 1; i <= 5; i++) sent(capture, String(i), `https://example.com/${i}`);
    expect(capture.all().map((each) => each.id)).toEqual(["3", "4", "5"]);

    const small = new NetCapture(100, 5_000);
    for (let i = 1; i <= 4; i++) { sent(small, String(i), `https://example.com/${i}`); small.setBody(String(i), "x".repeat(2_000), false); }
    expect(small.byteSize).toBeLessThanOrEqual(5_000);
    expect(small.all().map((each) => each.id)).toEqual(["3", "4"]);

    const one = new NetCapture();
    sent(one, "big", "https://example.com/big");
    one.setBody("big", "y".repeat(BODY_KEEP + 10), false);
    expect(one.get("big")).toMatchObject({ bodyTruncated: true });
    expect(one.get("big")!.body!.length).toBe(BODY_KEEP);
  });
});

describe("masking and filters", () => {
  it("masks Cookie, Set-Cookie, Authorization and Proxy-Authorization (any case) unless asked", () => {
    const headers = { cookie: "a=1", "Set-Cookie": "b=2", Authorization: "Bearer x", "proxy-authorization": "Basic y", Accept: "json" };
    expect(maskHeaders(headers)).toEqual({ cookie: MASKED, "Set-Cookie": MASKED, Authorization: MASKED, "proxy-authorization": MASKED, Accept: "json" });
    expect(maskHeaders(headers, true)).toBe(headers);
    const entry: CapturedRequest = { id: "1", url: "u", method: "GET", type: "XHR", started: 0, requestHeaders: { Cookie: "s" }, responseHeaders: { "set-cookie": "t" }, body: "abcdef" };
    expect(forBot(entry, { bodies: false, unmasked: false, bodyMax: 100 })).toEqual({ id: "1", url: "u", method: "GET", type: "XHR", started: 0, requestHeaders: { Cookie: MASKED }, responseHeaders: { "set-cookie": MASKED } });
    expect(forBot(entry, { bodies: true, unmasked: true, bodyMax: 3 })).toMatchObject({ requestHeaders: { Cookie: "s" }, body: "abc", bodyTruncated: true });
  });

  it("filters by URL text, type (xhr takes Fetch too), method, and keeps the newest `limit`", () => {
    const rows = [
      { id: "1", url: "https://A.com/api/list", type: "XHR", method: "GET" },
      { id: "2", url: "https://a.com/api/save", type: "Fetch", method: "POST" },
      { id: "3", url: "https://a.com/app.js", type: "Script", method: "GET" },
      { id: "4", url: "https://b.com/api/x", type: "Fetch", method: "GET" },
    ].map((row) => ({ ...row, started: 0, requestHeaders: {} })) as CapturedRequest[];
    const ids = (list: CapturedRequest[]) => list.map((each) => each.id);
    expect(ids(filterRequests(rows, { urlContains: "a.com/API" }))).toEqual(["1", "2"]);
    expect(ids(filterRequests(rows, { type: "xhr" }))).toEqual(["1", "2", "4"]);
    expect(ids(filterRequests(rows, { type: "script" }))).toEqual(["3"]);
    expect(ids(filterRequests(rows, { method: "post" }))).toEqual(["2"]);
    expect(ids(filterRequests(rows, { limit: 2 }))).toEqual(["3", "4"]);
    expect(filterRequests(Array.from({ length: 300 }, (_, i) => ({ ...rows[0]!, id: String(i) })), { limit: 1_000 })).toHaveLength(200);
  });

  it("CSV from rows, objects, or a tables result", () => {
    expect(toCsv([["a", "b,c"], [1, "say \"hi\""]])).toBe("a,\"b,c\"\r\n1,\"say \"\"hi\"\"\"\r\n");
    expect(toCsv([{ x: 1 }, { x: 2, y: "z" }])).toBe("x,y\r\n1,\r\n2,z\r\n");
    expect(csvRows([{ headers: ["h1", "h2"], rows: [["1", "2"]] }, { headers: [], rows: [] }])).toEqual([["h1", "h2"], ["1", "2"]]);
    expect(csvRows("text")).toBeNull();
  });
});

describe("the tool calls' checks", () => {
  it("turns a call into main's request, refusing what is wrong", () => {
    expect(browserRequest("B1", "app_browser_tabs", {})).toEqual({ op: "tabs", botId: "B1" });
    expect(browserRequest("B1", "app_browser_open", { url: "https://example.com" })).toEqual({ op: "open", botId: "B1", url: "https://example.com" });
    expect(() => browserRequest("B1", "app_browser_open", { url: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => browserRequest("B1", "app_browser_open", { url: "javascript:alert(1)" })).toThrow(/http/);
    expect(browserRequest("B1", "app_browser_requests", { tab_id: "t2", url_contains: "api", resource_type: "xhr", limit: 5, include_bodies: true }))
      .toEqual({ op: "requests", botId: "B1", tabId: "t2", filter: { urlContains: "api", type: "xhr", limit: 5 }, bodies: true, unmasked: false });
    expect(() => browserRequest("B1", "app_browser_requests", { tab_id: "../x" })).toThrow(/tab_id/);
    expect(() => browserRequest("B1", "app_browser_requests", { limit: 0 })).toThrow(/limit/);
    expect(() => browserRequest("B1", "app_browser_requests", { include_bodies: "yes" })).toThrow(/true or false/);
    expect(browserRequest("B1", "app_browser_extract", {})).toMatchObject({ op: "extract", what: "tables" });
    expect(browserRequest("B1", "app_browser_extract", { script: "return 1" })).toMatchObject({ what: "script", script: "return 1" });
    expect(() => browserRequest("B1", "app_browser_extract", { what: "selector" })).toThrow(/selector/);
    expect(() => browserRequest("B1", "app_browser_extract", { what: "click" })).toThrow(/what/);
    expect(() => browserRequest("B1", "app_browser_extract", { script: "x".repeat(20_001) })).toThrow(/too long/);
  });

  it("main checks the request again (round trip; junk refused)", () => {
    const request = browserRequest("B1", "app_browser_requests", { url_contains: "api", unmasked_headers: true });
    expect(parseBrowserBotRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(parseBrowserBotRequest({ op: "click", botId: "B1" })).toBeNull();
    expect(parseBrowserBotRequest({ op: "open", botId: "B1", url: "file:///x" })).toBeNull();
    expect(parseBrowserBotRequest({ op: "tabs", botId: "../../" })).toBeNull();
  });
});

class FakePage implements TabPage {
  loads: string[] = [];
  load(url: string) { this.loads.push(url); }
  back() {} forward() {} reload() {} stop() {} focus() {} hide() {} destroy() {} show() {}
  canGoBack() { return false; }
  canGoForward() { return false; }
}

function fakeWindow() {
  const changes: { botId: string; reading: (boolean | undefined)[] }[] = [];
  const tabs = new BrowserTabs({ create: () => new FakePage(), onChange: (state) => changes.push({ botId: state.botId, reading: state.tabs.map((tab) => tab.reading) }) });
  const captures = new Map<string, NetCapture>();
  const runs: { tabId: string; code: string }[] = [];
  const window: BotBrowserWindow & { result: unknown } = {
    tabs, result: [["a"]],
    open: (botId, url) => { const id = tabs.open(botId, url); if (!captures.has(id)) captures.set(id, new NetCapture()); return id; },
    capture: (tabId) => captures.get(tabId) ?? null,
    fetchBody: async (_tabId, id) => ({ body: `late body ${id}`, base64: false }),
    run: async (tabId, code) => { runs.push({ tabId, code }); return window.result; },
  };
  return { window, changes, captures, runs };
}

describe("main's answers (BrowserBotHost)", () => {
  it("lists only that bot's tabs; says how to start when it has none", async () => {
    const { window } = fakeWindow();
    const host = new BrowserBotHost(() => [window], 0);
    expect(await host.answer({ op: "tabs", botId: "B1" })).toMatchObject({ ok: true, data: { tabs: [], note: expect.stringContaining("app_browser_open") } });
    const opened = await host.answer({ op: "open", botId: "B1", url: "https://example.com/" });
    expect(opened).toMatchObject({ ok: true, data: { tab_id: "t1" } });
    window.open("B2", "https://other.example/");
    const listed = await host.answer({ op: "tabs", botId: "B1" });
    expect((listed.data as { tabs: { tab_id: string; url: string; active: boolean }[] }).tabs).toEqual([
      { tab_id: "t1", url: "https://example.com/", title: "", loading: true, active: true, captured_requests: 0 },
    ]);
    expect(await host.answer({ op: "requests", botId: "B1", tabId: "t2", filter: {}, bodies: false, unmasked: false })).toMatchObject({ ok: false, error: expect.stringContaining("No tab t2") });
    expect(await host.answer({ op: "requests", botId: "B3", filter: {}, bodies: false, unmasked: false })).toMatchObject({ ok: false });
    expect(await new BrowserBotHost(() => []).answer({ op: "tabs", botId: "B1" })).toMatchObject({ ok: false, error: "No app window is open." });
  });

  it("reads the selected tab's requests: filtered, masked, late bodies fetched on request; the tab shows it is being read", async () => {
    vi.useFakeTimers();
    try {
      const { window, captures, changes } = fakeWindow();
      const host = new BrowserBotHost(() => [window], 1_500);
      const tabId = window.open("B1", "https://shop.example/");
      const capture = captures.get(tabId)!;
      sent(capture, "1", "https://shop.example/api/items", { request: { url: "https://shop.example/api/items", method: "GET", headers: { Authorization: "Bearer secret" } } });
      capture.handle("Network.loadingFinished", { requestId: "1", encodedDataLength: 5 });
      sent(capture, "2", "https://shop.example/logo.png", { type: "Image" });
      changes.length = 0;
      const answer = await host.answer({ op: "requests", botId: "B1", filter: { urlContains: "/api/" }, bodies: true, unmasked: false });
      expect(answer.ok).toBe(true);
      const data = answer.data as { captured: number; matched: number; requests: CapturedRequest[]; masked?: string };
      expect(data).toMatchObject({ captured: 2, matched: 1, masked: expect.any(String) });
      expect(data.requests[0]).toMatchObject({ id: "1", requestHeaders: { Authorization: MASKED }, body: "late body 1" });
      expect(changes.map((change) => change.reading[0])).toEqual([true]);
      vi.advanceTimersByTime(1_500);
      expect(changes.at(-1)!.reading[0]).toBeUndefined();
      const unmasked = await host.answer({ op: "requests", botId: "B1", filter: {}, bodies: false, unmasked: true });
      expect((unmasked.data as { requests: CapturedRequest[] }).requests[0]).toMatchObject({ requestHeaders: { Authorization: "Bearer secret" } });
      expect((unmasked.data as { requests: CapturedRequest[] }).requests[0]!.body).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("extracts by running the built code in the tab and returns its data", async () => {
    const { window, runs } = fakeWindow();
    const host = new BrowserBotHost(() => [window], 0);
    window.open("B1", "https://example.com/");
    const answer = await host.answer({ op: "extract", botId: "B1", what: "tables" });
    expect(answer).toMatchObject({ ok: true, data: { tab_id: "t1", what: "tables", data: [["a"]] } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.code).toContain("querySelectorAll(\"table\")");
  });
});

describe("extraction code", () => {
  it("is valid JavaScript for every reader, turns off clicking/submitting/network first, and embeds the selector safely", () => {
    for (const what of ["tables", "text", "links", "selector", "script"] as const) {
      const code = extractionCode(what, "a[href*=\"x\"]`${evil}`", "return document.title;");
      expect(() => new Function(`return ${code}`)).not.toThrow();
      expect(code.indexOf("requestSubmit")).toBeLessThan(code.indexOf("const result"));
      expect(code).toContain("window.fetch = refuse");
    }
    expect(extractionCode("selector", "\"); fetch('x'); (\"")).toContain(JSON.stringify("\"); fetch('x'); (\""));
  });
});

describe("the core's side (runBrowserTool)", () => {
  const bridgeOf = (data: unknown, seen: unknown[] = []) => async (request: string): Promise<AppAnswer> => { seen.push(JSON.parse(request)); return { ok: true, data }; };

  it("sends the checked request for this bot and returns small answers as they are", async () => {
    const seen: unknown[] = [];
    const result = await runBrowserTool("app_browser_tabs", {}, { botId: "B1", folder: tempDir(), bridge: bridgeOf({ tabs: [] }, seen) });
    expect(result).toEqual({ tabs: [] });
    expect(seen).toEqual([{ op: "tabs", botId: "B1" }]);
    await expect(runBrowserTool("app_browser_tabs", {}, { botId: "B1", folder: tempDir(), bridge: null })).rejects.toThrow(/not available/);
    await expect(runBrowserTool("app_browser_tabs", {}, { botId: "B1", folder: tempDir(), bridge: async () => ({ ok: false, error: "No app window is open." }) })).rejects.toThrow("No app window is open.");
    await expect(runBrowserTool("app_browser_extract", { save_as: "xlsx" }, { botId: "B1", folder: tempDir(), bridge: bridgeOf({}) })).rejects.toThrow(/save_as/);
  });

  it("saves extracted rows as CSV in the bot's .bot/browser/ and returns the path to link", async () => {
    const folder = tempDir();
    const data = { tab_id: "t1", url: "https://www.shop.example/list", what: "tables", data: [{ index: 0, headers: ["Name", "Price"], rows: [["Tea", "3"], ["Cake, big", "5"]] }] };
    const result = await runBrowserTool("app_browser_extract", { save_as: "csv" }, { botId: "B1", folder, bridge: bridgeOf(data), now: () => new Date("2026-11-10T08:09:10Z") }) as { file: string; note: string; data?: unknown };
    expect(result.file).toBe(join(folder, ".bot", "browser", "20261110-080910-shop.example-tables.csv"));
    expect(readFileSync(result.file, "utf8")).toBe("Name,Price\r\nTea,3\r\n\"Cake, big\",5\r\n");
    expect(result.note).toMatch(/link/);
    expect(result.data).toBeUndefined();
    await expect(runBrowserTool("app_browser_extract", { what: "text", save_as: "csv" }, { botId: "B1", folder, bridge: bridgeOf({ what: "text", data: "words" }) })).rejects.toThrow(/not rows/);
  });

  it("saves a result too big to read inline, and cuts long bodies inline", async () => {
    const folder = tempDir();
    mkdirSync(join(folder, ".bot"), { recursive: true });
    const big = await runBrowserTool("app_browser_extract", { what: "text" }, { botId: "B1", folder, bridge: bridgeOf({ url: "https://e.com/", what: "text", data: "z".repeat(INLINE_MAX + 1) }) }) as { file: string; preview: string };
    expect(big.file).toMatch(/e\.com-text\.txt$/);
    expect(readFileSync(big.file, "utf8")).toHaveLength(INLINE_MAX + 1);
    expect(big.preview.length).toBeLessThanOrEqual(1_500);

    const request = (id: string, body: string): CapturedRequest => ({ id, url: `https://e.com/${id}`, method: "GET", type: "XHR", started: 0, requestHeaders: {}, body });
    const inline = await runBrowserTool("app_browser_requests", { include_bodies: true }, { botId: "B1", folder, bridge: bridgeOf({ url: "https://e.com/", requests: [request("1", "b".repeat(7_000))] }) }) as { requests: CapturedRequest[] };
    expect(inline.requests[0]).toMatchObject({ bodyTruncated: true });
    expect(inline.requests[0]!.body).toHaveLength(6_000);

    const saved = await runBrowserTool("app_browser_requests", { save_as: "json" }, { botId: "B1", folder, bridge: bridgeOf({ url: "https://e.com/", requests: [request("1", "x")] }) }) as { file: string; requests: unknown[] };
    expect(JSON.parse(readFileSync(saved.file, "utf8")).requests[0].body).toBe("x");
    expect(saved.requests).toEqual([{ id: "1", method: "GET", type: "XHR", url: "https://e.com/1" }]);
  });
});

describe("every engine has the tools", () => {
  const names = ["app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"];
  it("coordinators and workers of Claude, Codex and Antigravity list them", () => {
    for (const provider of ["claude", "codex", "agy"] as const) {
      expect(appTools(provider).map((tool) => tool.name)).toEqual(expect.arrayContaining(names));
      expect(workerAppTools(provider).map((tool) => tool.name)).toEqual(["app_notify_owner", ...names]);
    }
  });

  it("the agy bridge hands a browser call to its browser, with no approval card", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "profile"));
    const calls: unknown[] = [];
    const bridge = new AgyMcpBridge(cwd, join(cwd, "profile"), undefined, undefined, undefined, () => false, undefined, [], () => false, () => ({}), async (name, args) => { calls.push([name, args]); return { tabs: [] }; });
    expect(bridge.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(names));
    await expect(bridge.invoke("app_browser_tabs", {})).resolves.toEqual({ tabs: [] });
    expect(calls).toEqual([["app_browser_tabs", {}]]);
    const without = new AgyMcpBridge(cwd, join(cwd, "profile"), undefined, undefined, undefined, () => false, undefined, [], () => false, () => ({}));
    await expect(without.invoke("app_browser_tabs", {})).rejects.toThrow(/not available/);
  });

  it("a Codex session hands a browser call from the coordinator's thread to its head (answered later, out of band)", () => {
    const config: CodexConfig = { cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ownerSession: "owner-session" };
    const session = new CodexSession(config);
    session.start();
    session.receive(JSON.stringify({ id: 1, result: {} }));
    session.receive(JSON.stringify({ id: 2, result: { thread: { id: "coord" } } }));
    const out: CodexOutput[] = session.receive(JSON.stringify({ method: "item/tool/call", id: 77, params: { threadId: "coord", turnId: "t1", callId: "c1", tool: "app_browser_extract", arguments: { what: "text" } } }));
    expect(out).toEqual([{ kind: "browser", rpcId: 77, tool: "app_browser_extract", args: { what: "text" } }]);
  });
});
