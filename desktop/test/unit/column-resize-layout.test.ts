// The column dividers as the window really lays them out and drives them: the left column, the browser pane and the
// right panel, with the native chat's placeholder and the browser's page beside them. The real components
// (test/fixtures/column-layout/entry.tsx) and the built stylesheet, in an offscreen Electron window that is never shown
// (no focus, no dock icon), driven with real mouse input (webContents.sendInputEvent).
// The bug this pins: the browser divider lay half over the native chat and half over the web page, both native views
// above the page, so it could only be grabbed in the 48 px tab strip; the side columns had no divider at all. Each
// grab strip must now be outside every native view's bounds, be what the pointer hits there, and a drag must resize
// the column live with the native views' bounds following, clamp, remember, and reset on a double click.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLUMNS, MIN_CHAT } from "../../src/renderer/column-resize";
import { desktop } from "../helpers";

type Box = { x: number; y: number; width: number; height: number };
type Probe = {
  columns: { rail: number; chat: number; browser: number; right: number };
  handles: Record<string, { x: number; side: string; strip: [number, number]; hits: boolean[] }>;
  native: { chat: Box | null; page: Box | null };
  saved: Record<string, string | null>;
  vars: Record<string, string>;
};
type Run = Record<string, Probe>;

// Runs in the page: the columns' widths, each handle's grab strip and what the pointer hits across it, the bounds the
// native views were last given, and what is saved.
const probe = `(() => {
  const shell = document.querySelector(".shell");
  const width = (selector) => shell.querySelector(":scope > " + selector)?.getBoundingClientRect().width ?? -1;
  const handles = {};
  for (const handle of shell.querySelectorAll(":scope > .col-handle")) {
    const box = handle.getBoundingClientRect(), side = handle.dataset.side;
    const strip = side === "left" ? [box.x - 7, box.x] : [box.x, box.x + 7];
    const hits = [];
    for (const y of [60, 300, 600]) for (let x = Math.ceil(strip[0]) ; x < strip[1]; x++) hits.push(document.elementFromPoint(x + 0.5, y) === handle);
    handles[handle.dataset.column] = { x: box.x, side, strip, hits };
  }
  const last = (list) => list.length ? list[list.length - 1] : null;
  const saved = {}, vars = {};
  for (const key of ${JSON.stringify(Object.values(COLUMNS).map((spec) => spec.key))}) saved[key] = localStorage.getItem(key);
  for (const name of ${JSON.stringify(Object.values(COLUMNS).map((spec) => spec.cssVar))}) vars[name] = shell.style.getPropertyValue(name);
  return { columns: { rail: width(".rail"), chat: width(".chat-pane"), browser: width(".browser-pane"), right: width(".detail-panel") },
    handles, native: { chat: last(window.__native.chat), page: last(window.__native.page) }, saved, vars };
})()`;

// Main: load, then drag each divider with real mouse input, probing between steps.
const runner = `const { app, BrowserWindow } = require("electron");
const fs = require("fs");
if (app.dock) app.dock.hide();
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, focusable: false, width: 2000, height: 900, useContentSize: true, webPreferences: { offscreen: true } });
    await win.loadFile(process.env.LAYOUT_PAGE);
    const web = win.webContents;
    const probe = () => web.executeJavaScript(fs.readFileSync(process.env.LAYOUT_PROBE, "utf8"));
    await web.executeJavaScript("localStorage.clear()");
    await web.reload(); await new Promise((done) => web.once("did-finish-load", done));
    await wait(400);
    const out = { start: await probe() };
    const grab = (p, column) => { const h = p.handles[column]; return Math.floor((h.strip[0] + h.strip[1]) / 2); };
    const drag = async (from, to, y = 400) => {
      web.sendInputEvent({ type: "mouseMove", x: from, y });
      web.sendInputEvent({ type: "mouseDown", x: from, y, button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) { web.sendInputEvent({ type: "mouseMove", x: Math.round(from + (to - from) * i / steps), y, button: "left", modifiers: ["leftButtonDown"] }); await wait(20); }
      web.sendInputEvent({ type: "mouseUp", x: to, y, button: "left", clickCount: 1 });
      await wait(300);
    };
    let x = grab(out.start, "rail"); await drag(x, x + 80); out.rail = await probe();
    x = grab(out.rail, "browser"); await drag(x, x + 200); out.browser = await probe();
    x = grab(out.browser, "right"); await drag(x, x - 60); out.right = await probe();
    x = grab(out.right, "rail"); await drag(x, x + 1500); out.railMax = await probe();
    x = grab(out.railMax, "rail");
    for (const clickCount of [1, 2]) { web.sendInputEvent({ type: "mouseDown", x, y: 400, button: "left", clickCount }); web.sendInputEvent({ type: "mouseUp", x, y: 400, button: "left", clickCount }); }
    await wait(300); out.reset = await probe();
    await web.reload(); await new Promise((done) => web.once("did-finish-load", done)); await wait(400);
    out.reloaded = await probe();
    process.stdout.write("LAYOUT " + JSON.stringify(out) + "\\n");
  } catch (error) { process.stdout.write("LAYOUT-ERROR " + String(error && error.stack || error) + "\\n"); }
  app.exit(0);
});`;

const dir = mkdtempSync(join(tmpdir(), "botling-column-layout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function layout(): Promise<Run> {
  const css = join(desktop, "out/renderer/styles.css");
  if (!existsSync(css)) throw new Error("out/renderer/styles.css is missing: run `node build.mjs` first (test:changed does)");
  await build({ entryPoints: [join(desktop, "test/fixtures/column-layout/entry.tsx")], bundle: true, format: "iife", target: "chrome130", jsx: "automatic",
    outfile: join(dir, "entry.js"), nodePaths: [join(desktop, "node_modules")], define: { "process.env.NODE_ENV": '"production"', __CHARACTERS__: "{}", __BOTLING_WEB__: "false" }, logLevel: "silent" });
  writeFileSync(join(dir, "page.html"), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(css)}"></head>
<body><div id="root"></div><script src="${pathToFileURL(join(dir, "entry.js"))}"></script></body></html>`);
  writeFileSync(join(dir, "probe.js"), probe);
  writeFileSync(join(dir, "main.cjs"), runner);
  const env: NodeJS.ProcessEnv = { ...process.env, LAYOUT_PAGE: join(dir, "page.html"), LAYOUT_PROBE: join(dir, "probe.js") };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron") as unknown as string, [join(dir, "main.cjs")], { env, encoding: "utf8", timeout: 90_000 });
  const line = result.stdout.split("\n").find((text) => text.startsWith("LAYOUT"));
  if (!line?.startsWith("LAYOUT ")) throw new Error(`offscreen layout failed: ${line ?? ""}\n${result.stderr}`);
  return JSON.parse(line.slice("LAYOUT ".length)) as Run;
}

const overlaps = (strip: [number, number], box: Box | null) => !!box && strip[1] > box.x && strip[0] < box.x + box.width;

describe("the fixture matches App.tsx and TaskDetails.tsx", () => {
  const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
  const details = readFileSync(join(desktop, "src/renderer/TaskDetails.tsx"), "utf8");
  it("puts each divider beside its column, as direct children of .shell", () => {
    const rail = app.indexOf('<ColumnDivider column="rail" />'), chat = app.indexOf('<section className="chat-pane">');
    const browser = app.indexOf('<ColumnDivider column="browser" />'), pane = app.indexOf("<BrowserPane bot={bot}"), tasks = app.indexOf("<TaskDetails");
    expect(rail).toBeGreaterThan(app.indexOf("</aside>"));
    expect(chat).toBeGreaterThan(rail);
    expect(browser).toBeGreaterThan(chat);
    expect(pane).toBeGreaterThan(browser);
    expect(tasks).toBeGreaterThan(pane);
    expect(app).toContain("{!railCollapsed && <ColumnDivider column=\"rail\" />}");
    expect(app).toContain("{paneOpen && bot && !browserFull && <ColumnDivider column=\"browser\" />}");
    expect(details).toContain('{!props.collapsed && <ColumnDivider column="right" />}<RightPanel {...props} />');
  });
});

// Electron needs a display on Linux; the CI's macOS job runs this.
describe.runIf(process.platform === "darwin" || !!process.env.DISPLAY)("the dividers as laid out and dragged (offscreen window)", () => {
  let run: Run;
  beforeAll(async () => { run = await layout(); }, 120_000);

  it("every grab strip is outside the native views' bounds and is what the pointer hits", () => {
    const start = run.start;
    expect(start.native.chat, "the chat placeholder was laid out").toBeTruthy();
    expect(start.native.page, "the browser page was laid out").toBeTruthy();
    for (const column of ["rail", "browser", "right"]) {
      const handle = start.handles[column]!;
      expect(handle, `${column} divider`).toBeTruthy();
      expect(overlaps(handle.strip, start.native.chat), `${column} strip ${handle.strip} vs chat ${JSON.stringify(start.native.chat)}`).toBe(false);
      expect(overlaps(handle.strip, start.native.page), `${column} strip ${handle.strip} vs page ${JSON.stringify(start.native.page)}`).toBe(false);
      expect(handle.hits.length).toBeGreaterThan(12);
      expect(handle.hits.every(Boolean), `${column}: ${JSON.stringify(handle.hits)}`).toBe(true);
    }
    // Defaults with nothing saved.
    expect(start.columns.rail).toBe(COLUMNS.rail.fallback);
    expect(start.columns.right).toBe(COLUMNS.right.fallback);
  });

  it("dragging the left column's divider resizes it live; the chat's native view follows", () => {
    const { start, rail } = run;
    expect(rail.columns.rail).toBe(start.columns.rail + 80);
    expect(rail.columns.chat).toBe(start.columns.chat - 80);
    expect(rail.native.chat!.x).toBe(start.native.chat!.x + 80);
    expect(rail.native.chat!.width).toBe(start.native.chat!.width - 80);
    expect(rail.saved[COLUMNS.rail.key]).toBe(String(start.columns.rail + 80));
  });

  it("dragging the browser's divider resizes the pane; the page's and the chat's bounds follow", () => {
    const { rail, browser } = run;
    expect(browser.columns.browser).toBe(rail.columns.browser - 200);
    expect(browser.native.page!.width).toBe(rail.native.page!.width - 200);
    expect(browser.native.page!.x).toBe(rail.native.page!.x + 200);
    expect(browser.native.chat!.width).toBe(rail.native.chat!.width + 200);
    expect(browser.saved[COLUMNS.browser.key]).toBe(String(rail.columns.browser - 200));
    // The handle moved with the pane and is still clear of both views.
    const handle = browser.handles.browser!;
    expect(overlaps(handle.strip, browser.native.page) || overlaps(handle.strip, browser.native.chat)).toBe(false);
  });

  it("dragging the right panel's divider resizes the panel", () => {
    const { browser, right } = run;
    expect(right.columns.right).toBe(browser.columns.right + 60);
    expect(right.saved[COLUMNS.right.key]).toBe(String(browser.columns.right + 60));
  });

  it("a drag far past the limit stops where the chat keeps its minimum or the column its maximum", () => {
    const { right, railMax } = run;
    const expected = Math.min(COLUMNS.rail.max, right.columns.rail + right.columns.chat - MIN_CHAT);
    expect(railMax.columns.rail).toBe(expected);
    expect(railMax.columns.chat).toBeGreaterThanOrEqual(MIN_CHAT);
  });

  it("a double click resets to the default and forgets the saved width; the others stay", () => {
    const { reset } = run;
    expect(reset.columns.rail).toBe(COLUMNS.rail.fallback);
    expect(reset.saved[COLUMNS.rail.key]).toBeNull();
    expect(reset.saved[COLUMNS.right.key]).not.toBeNull();
  });

  it("the widths come back after a restart (reload)", () => {
    const { right, reloaded } = run;
    expect(reloaded.columns.right).toBe(right.columns.right);
    expect(reloaded.columns.browser).toBe(right.columns.browser);
    expect(reloaded.columns.rail).toBe(COLUMNS.rail.fallback);
  });
});
