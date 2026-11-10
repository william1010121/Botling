// Site tools for the in-app browser, phase 3 (2026-11-10): the tool format and URL patterns, loading the tools folder
// (built-ins, bot-made folders, broken ones, a file watcher), what is on per site, the bridge a script gets (its
// wrapper run in a VM, what it gives back checked, file names made safe), the runner, and the wire messages.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  askForToolText, compilePattern, emptySiteState, matchesUrl, parseRunOutput, parseSiteState, parseSiteTool, runOptions, safeFileName,
  setToolOn, siteOf, toolIsOn, toolsFor, worldIdOf, wrapScript, type SiteTool,
} from "../../src/browser-site-tools";
import { parseBrowserUp } from "../../src/browser-wire";
import { SiteToolStore, loadSiteTools } from "../../src/main/site-tools";
import { BUILT_IN_SITE_TOOLS } from "../../src/main/site-tools-builtin";
import { runSiteTool } from "../../src/main/site-tool-runner";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "site-tools-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function writeTool(folder: string, id: string, manifest: unknown, script = "botling.result('ok');") {
  mkdirSync(join(folder, id), { recursive: true });
  writeFileSync(join(folder, id, "tool.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  writeFileSync(join(folder, id, "script.js"), script);
}
const tool = (overrides: Partial<SiteTool> = {}): SiteTool => ({
  id: "t", name: "T", description: "", matches: ["<all_urls>"], kind: "action", fields: [], runLabel: "Run", builtIn: false, script: "", ...overrides,
});

describe("URL patterns", () => {
  it("matches scheme, host and path the way extensions do", () => {
    expect(matchesUrl(["https://chatgpt.com/*"], "https://chatgpt.com/c/123")).toBe(true);
    expect(matchesUrl(["https://chatgpt.com/*"], "http://chatgpt.com/c/123")).toBe(false);
    expect(matchesUrl(["https://chatgpt.com/*"], "https://evilchatgpt.com/")).toBe(false);
    expect(matchesUrl(["https://chatgpt.com/*"], "https://chatgpt.com.evil.io/")).toBe(false);
    expect(matchesUrl(["*://*.example.com/*"], "http://example.com/")).toBe(true);
    expect(matchesUrl(["*://*.example.com/*"], "https://a.b.example.com/x")).toBe(true);
    expect(matchesUrl(["*://*.example.com/*"], "https://notexample.com/")).toBe(false);
    expect(matchesUrl(["https://news.ycombinator.com/item*"], "https://news.ycombinator.com/item?id=1")).toBe(true);
    expect(matchesUrl(["https://news.ycombinator.com/item*"], "https://news.ycombinator.com/news")).toBe(false);
    expect(matchesUrl(["http://localhost:3000/*"], "http://localhost:3000/a")).toBe(true);
    expect(matchesUrl(["http://localhost:3000/*"], "http://localhost:4000/a")).toBe(false);
    expect(matchesUrl(["<all_urls>"], "https://any.where/")).toBe(true);
    expect(matchesUrl(["<all_urls>"], "file:///etc/passwd")).toBe(false);
    expect(matchesUrl(["*://*/*"], "chrome://settings/")).toBe(false);
    expect(matchesUrl(["https://a.com/*"], "not a url")).toBe(false);
  });

  it("refuses what is not a pattern", () => {
    for (const bad of ["chatgpt.com", "https://chatgpt.com", "ftp://a.com/*", "https://*foo.com/*", "https://a..com/*", "javascript:alert(1)", ""]) {
      expect(compilePattern(bad), bad).toBeNull();
    }
  });

  it("lists a site's own tools before those for every site", () => {
    const all = [tool({ id: "reader", name: "Reader", matches: ["<all_urls>"] }), tool({ id: "x", name: "Export", matches: ["https://chatgpt.com/*"] }), tool({ id: "y", name: "Other", matches: ["https://other.com/*"] })];
    expect(toolsFor(all, "https://chatgpt.com/c/1").map((each) => each.id)).toEqual(["x", "reader"]);
    expect(toolsFor(all, "https://example.org/").map((each) => each.id)).toEqual(["reader"]);
  });

  it("names the site without www.", () => {
    expect(siteOf("https://www.Example.com/a")).toBe("example.com");
    expect(siteOf("http://localhost:3000/")).toBe("localhost:3000");
    expect(siteOf("file:///x")).toBeNull();
  });
});

describe("tool.json", () => {
  const good = { name: "Export", matches: ["https://chatgpt.com/*"], fields: [{ id: "format", label: "Format", type: "choice", options: ["Markdown", "JSON"] }] };

  it("takes a good tool with defaults filled in", () => {
    const parsed = parseSiteTool("chatgpt-export", good, "botling.result(1)");
    expect("tool" in parsed && parsed.tool).toMatchObject({ id: "chatgpt-export", kind: "action", runLabel: "Run", description: "", builtIn: false });
  });

  it("says what is wrong with a bad one", () => {
    const error = (id: string, manifest: unknown, script = "x") => { const parsed = parseSiteTool(id, manifest, script); return "error" in parsed ? parsed.error : null; };
    expect(error("Bad_ID", good)).toMatch(/folder name/);
    expect(error("a", { ...good, name: "" })).toMatch(/^name/);
    expect(error("a", { ...good, matches: [] })).toMatch(/^matches/);
    expect(error("a", { ...good, matches: ["chatgpt.com"] })).toMatch(/not a URL pattern/);
    expect(error("a", { ...good, kind: "popup" })).toMatch(/^kind/);
    expect(error("a", { ...good, kind: "toggle" })).toMatch(/toggle tool has no form/);
    expect(error("a", { ...good, fields: [{ id: "f", label: "F", type: "choice", options: ["one"] }] })).toMatch(/options/);
    expect(error("a", { ...good, fields: [{ id: "f", label: "F", type: "text" }, { id: "f", label: "G", type: "check" }] })).toMatch(/used twice/);
    expect(error("a", { ...good, fields: [{ id: "f", label: "F", type: "slider" }] })).toMatch(/type/);
    expect(error("a", good, "  ")).toMatch(/script.js is missing/);
    expect(error("a", [1, 2])).toMatch(/not an object/);
  });

  it("keeps a run's options to the tool's fields and their types", () => {
    const fields = [
      { id: "format", label: "F", type: "choice" as const, options: ["Markdown", "JSON"], default: "JSON" },
      { id: "all", label: "A", type: "check" as const },
      { id: "name", label: "N", type: "text" as const, default: "x" },
    ];
    expect(runOptions({ fields }, undefined)).toEqual({ format: "JSON", all: false, name: "x" });
    expect(runOptions({ fields }, { format: "Markdown", all: true, name: "y", extra: "z" })).toEqual({ format: "Markdown", all: true, name: "y" });
    expect(runOptions({ fields }, { format: "HTML", all: "yes", name: true })).toEqual({ format: "JSON", all: false, name: "x" });
  });

  it("ships built-ins that load", () => {
    for (const builtIn of BUILT_IN_SITE_TOOLS) expect("tool" in parseSiteTool(builtIn.id, builtIn.manifest, builtIn.script, true), builtIn.id).toBe(true);
    for (const builtIn of BUILT_IN_SITE_TOOLS) expect(() => new Script(wrapScript({ id: builtIn.id, script: builtIn.script }, { options: {}, active: true })), builtIn.id).not.toThrow();
    const ids = toolsFor(loadSiteTools(tempDir()).tools, "https://chatgpt.com/c/1").map((each) => each.id);
    expect(ids).toEqual(["chatgpt-export", "reader-layout"]);
  });
});

describe("the tools folder", () => {
  it("loads bot-made tools, reports broken ones, skips half-written ones, and lets a folder replace a built-in", () => {
    const folder = tempDir();
    writeTool(folder, "hn-export", { name: "HN export", matches: ["https://news.ycombinator.com/*"] });
    writeTool(folder, "broken", "{ not json");
    writeTool(folder, "reader-layout", { name: "My reader", matches: ["<all_urls>"], kind: "toggle" });
    mkdirSync(join(folder, "being-written"));
    mkdirSync(join(folder, "Bad Name"));
    writeFileSync(join(folder, "README.md"), "guide");
    const { tools, problems } = loadSiteTools(folder);
    expect(tools.map((each) => each.id).sort()).toEqual(["chatgpt-export", "hn-export", "reader-layout"]);
    expect(tools.find((each) => each.id === "reader-layout")).toMatchObject({ name: "My reader", builtIn: false });
    expect(problems.map((each) => each.id).sort()).toEqual(["Bad Name", "broken"]);
    expect(problems.find((each) => each.id === "broken")!.error).toMatch(/not valid JSON/);
  });

  it("writes the guide, keeps per-site state in a file, and drops odd entries from it", () => {
    const dir = tempDir();
    const folder = join(dir, "browser-tools");
    const stateFile = join(dir, "state.json");
    const store = new SiteToolStore({ folder, stateFile, guide: "# guide", watch: false });
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("# guide");
    expect(store.catalog()).toMatchObject({ folder, guide: join(folder, "README.md") });
    expect(store.catalog().tools.every((each) => !("script" in each))).toBe(true);
    let changes = 0;
    store.subscribe(() => changes++);
    store.setOn("reader-layout", "example.com", true);
    store.setOn("chatgpt-export", "chatgpt.com", false);
    store.setOn("missing", "example.com", true);
    expect(changes).toBe(2);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ on: { "reader-layout": ["example.com"] }, off: { "chatgpt-export": ["chatgpt.com"] } });
    const again = new SiteToolStore({ folder, stateFile, watch: false });
    expect(again.siteState()).toEqual(store.siteState());
    expect(parseSiteState({ on: { "Bad Id": ["a"], ok: ["a", 3, ""] }, off: "x" })).toEqual({ on: { ok: ["a"] }, off: {} });
  });

  it("picks up a tool a bot writes while the app runs", async () => {
    const dir = tempDir();
    const folder = join(dir, "browser-tools");
    const store = new SiteToolStore({ folder, stateFile: join(dir, "state.json"), debounceMs: 30 });
    try {
      const seen = new Promise<void>((resolve) => store.subscribe(() => { if (store.tool("new-tool")) resolve(); }));
      writeTool(folder, "new-tool", { name: "New", matches: ["<all_urls>"] });
      await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error("no reload")), 4000))]);
      expect(store.tool("new-tool")?.name).toBe("New");
    } finally { store.dispose(); }
  });
});

describe("per-site on and off", () => {
  it("has action tools on until turned off, toggle tools off until turned on, per site", () => {
    const action = { id: "a", kind: "action" as const };
    const toggle = { id: "b", kind: "toggle" as const };
    let state = emptySiteState();
    expect(toolIsOn(state, action, "x.com")).toBe(true);
    expect(toolIsOn(state, toggle, "x.com")).toBe(false);
    state = setToolOn(setToolOn(state, action, "x.com", false), toggle, "x.com", true);
    expect(toolIsOn(state, action, "x.com")).toBe(false);
    expect(toolIsOn(state, action, "y.com")).toBe(true);
    expect(toolIsOn(state, toggle, "x.com")).toBe(true);
    expect(toolIsOn(state, toggle, "y.com")).toBe(false);
    state = setToolOn(setToolOn(state, action, "x.com", true), toggle, "x.com", false);
    expect(state).toEqual(emptySiteState());
  });
});

describe("the bridge a script gets", () => {
  /** The wrapper run in a VM with a page's `location`, as the isolated world runs it. */
  const run = (script: string, input = { options: {}, active: null as boolean | null }) =>
    runInNewContext(wrapScript({ id: "t", script }, input), { location: { href: "https://example.com/a" } }) as Promise<unknown>;

  it("gives the script its options and collects a result, files and on/off", async () => {
    const raw = await run(`
      botling.progress("half");
      botling.result(botling.options.format + " " + botling.url);
      botling.saveFile("chat.md", "# hi", "text/markdown");
      botling.saveFile("data.json", { a: 1 });
      botling.setActive(true);
    `, { options: { format: "Markdown" }, active: null });
    expect(parseRunOutput(raw)).toEqual({
      result: "Markdown https://example.com/a", active: true, error: null,
      files: [{ name: "chat.md", content: "# hi", type: "text/markdown" }, { name: "data.json", content: '{\n  "a": 1\n}', type: null }],
    });
  });

  it("turns a throw into an error, and refuses a sixth file", async () => {
    expect(parseRunOutput(await run(`throw new Error("No conversation")`))).toMatchObject({ error: "No conversation" });
    expect(parseRunOutput(await run(`for (let i = 0; i < 6; i++) botling.saveFile(i + ".txt", "x");`))).toMatchObject({ error: "at most 5 files per run" });
  });

  it("does not let the script change the bridge", async () => {
    const out = parseRunOutput(await run(`botling.result = null; botling.options.x = 1; botling.result("still");`));
    expect(out).toMatchObject({ result: "still" });
  });

  it("checks what comes back", () => {
    expect(parseRunOutput(null)).toEqual({ invalid: "the script gave back nothing" });
    expect(parseRunOutput({ files: "x" })).toEqual({ invalid: "files is not a list" });
    expect(parseRunOutput({ files: Array.from({ length: 6 }, () => ({ name: "a.txt", content: "" })) })).toMatchObject({ invalid: expect.stringMatching(/more than 5/) });
    expect(parseRunOutput({ files: [{ name: "a.exe", content: "MZ" }] })).toMatchObject({ invalid: expect.stringMatching(/must be named/) });
    expect(parseRunOutput({ files: [{ name: "a.txt", content: 3 }] })).toMatchObject({ invalid: expect.stringMatching(/not text/) });
    expect(parseRunOutput({ result: "x".repeat(5000), active: "yes" })).toMatchObject({ result: "x".repeat(2000), active: null, files: [] });
  });

  it("makes file names safe", () => {
    expect(safeFileName("../../.ssh/authorized_keys.txt")).toBe("authorized_keys.txt");
    expect(safeFileName("C:\\Users\\x\\chat.md")).toBe("chat.md");
    expect(safeFileName(".bashrc")).toBeNull();
    expect(safeFileName("run.sh")).toBeNull();
    expect(safeFileName("a.MD")).toBe("a.md");
    expect(safeFileName("  my: chat?  .md")).toBe("my chat.md");
    expect(safeFileName("對話 紀錄.json")).toBe("對話 紀錄.json");
    expect(safeFileName("...md")).toBeNull();
    expect(safeFileName(`${"x".repeat(300)}.csv`)!.length).toBe(114);
  });

  it("gives each tool its own world, apart from Electron's", () => {
    expect(worldIdOf("a")).not.toBe(worldIdOf("b"));
    for (const id of ["a", "chatgpt-export", "reader-layout"]) { expect(worldIdOf(id)).toBeGreaterThanOrEqual(2000); expect(worldIdOf(id)).toBe(worldIdOf(id)); }
  });
});

describe("a run", () => {
  const exec = (value: unknown) => async (_world: number, code: string) => code.includes("?? null") ? null : value;

  it("saves the files the person agrees to and says so", async () => {
    const saved: string[] = [];
    const result = await runSiteTool({
      tool: tool(), options: {}, active: null,
      exec: exec({ result: "12 messages", files: [{ name: "a.md", content: "x" }, { name: "b.json", content: "{}" }], active: null, error: null }),
      save: async (file) => { if (file.name === "b.json") return null; saved.push(file.name); return `/Users/me/Downloads/${file.name}`; },
    });
    expect(saved).toEqual(["a.md"]);
    expect(result).toEqual({ ok: true, text: "12 messages · Saved a.md · 1 not saved", saved: ["/Users/me/Downloads/a.md"], active: null });
  });

  it("fails on a script error, an odd value, a refused page, and a run that never ends", async () => {
    expect(await runSiteTool({ tool: tool(), options: {}, active: null, exec: exec({ error: "No conversation" }) })).toMatchObject({ ok: false, text: "No conversation" });
    expect(await runSiteTool({ tool: tool(), options: {}, active: null, exec: exec(42) })).toMatchObject({ ok: false, text: "Failed: the script gave back nothing" });
    expect(await runSiteTool({ tool: tool(), options: {}, active: null, exec: () => Promise.reject(new Error("SyntaxError: x")) })).toMatchObject({ ok: false, text: "Failed: SyntaxError: x" });
    expect(await runSiteTool({ tool: tool(), options: {}, active: null, exec: () => new Promise(() => {}), timeoutMs: 20 })).toMatchObject({ ok: false, text: "Failed: stopped after 0 s" });
  });

  it("reports progress while it runs", async () => {
    const lines: string[] = [];
    let release!: (value: unknown) => void;
    const progress = ["Reading 3 messages…"];
    const result = runSiteTool({
      tool: tool(), options: {}, active: null, pollMs: 5, onProgress: (text) => lines.push(text),
      exec: (_world, code) => code.includes("?? null") ? Promise.resolve(progress[0]) : new Promise((resolve) => { release = resolve; }),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    release({ result: "done", files: [] });
    expect((await result).text).toBe("done");
    expect(lines).toEqual(["Reading 3 messages…"]);
  });
});

describe("wire", () => {
  it("takes tool messages from the app page and refuses odd ones", () => {
    expect(parseBrowserUp({ type: "tool.run", botId: "b1", tabId: "t1", toolId: "chatgpt-export", options: { format: "JSON", all: true } }))
      .toEqual({ type: "tool.run", botId: "b1", tabId: "t1", toolId: "chatgpt-export", options: { format: "JSON", all: true } });
    expect(parseBrowserUp({ type: "tool.set", botId: "b1", tabId: "t1", toolId: "reader-layout", on: false })).toEqual({ type: "tool.set", botId: "b1", tabId: "t1", toolId: "reader-layout", on: false });
    expect(parseBrowserUp({ type: "tool.set", botId: "b1", tabId: "t1", toolId: "reader-layout", on: "yes" })).toBeNull();
    expect(parseBrowserUp({ type: "tool.run", botId: "b1", tabId: "t1", toolId: "../x" })).toBeNull();
    expect(parseBrowserUp({ type: "tool.run", botId: "b1", tabId: "x", toolId: "a" })).toBeNull();
    expect(parseBrowserUp({ type: "tool.run", botId: "b1", tabId: "t1", toolId: "a", options: { x: { y: 1 } } })).toBeNull();
    expect(parseBrowserUp({ type: "tool.run", botId: "b1", tabId: "t1", toolId: "a", options: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"])) })).toBeNull();
  });

  it("asks any other bot to hand the request on to Maintainer, never to write the tool itself", () => {
    const text = askForToolText("https://gemini.google.com/app/1", "/data/browser-tools", "/data/browser-tools/README.md", false);
    expect(text).toContain("https://gemini.google.com/app/1");
    expect(text).toContain("Maintainer");
    expect(text).toContain("<plugin>site tool:");
    expect(text).not.toContain("/data/browser-tools");
    expect(text).not.toMatch(/Write it as a folder/);
  });

  it("asks Maintainer with the page, the folder and the guide", () => {
    const text = askForToolText("https://chatgpt.com/c/1", "/data/browser-tools", "/data/browser-tools/README.md", true);
    expect(text).toContain("https://chatgpt.com/c/1");
    expect(text).toContain("/data/browser-tools/<tool-id>/");
    expect(text).toContain("/data/browser-tools/README.md");
  });
});
