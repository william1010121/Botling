// The floating chat over the Note as the window really lays it out (test/fixtures/floating-chat/entry.tsx: the real
// FloatingChat, ChatBody, float-chrome.ts and the built stylesheets), in an offscreen Electron window that is never
// shown (no focus, no dock icon), driven with real mouse input (webContents.sendInputEvent). It pins: the strip sits in
// the Note's bottom right corner and the native chat is hidden; a click opens the panel there at the default size; the
// header drags it (the native chat follows), and dropped near a corner it snaps in; the grip resizes it; the dock button
// lays the chat beside the Note and back to where the panel was; collapse brings the strip back; the place is
// remembered. With FLOAT_SHOT set it saves a picture of the open panel there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLUMNS } from "../../src/renderer/column-resize";
import { DEFAULT_H, DEFAULT_W, FLOAT_KEY, MARGIN } from "../../src/renderer/floating-chat";
import { desktop } from "../helpers";

type Box = { x: number; y: number; width: number; height: number };
type Probe = { note: Box; strip: Box | null; header: Box | null; grip: Box | null; dock: Box | null; collapse: Box | null; native: Box | null; saved: string | null };

const probe = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  const list = window.__native.chat;
  return { note: box(document.querySelector(".main-tab")), strip: box(document.querySelector(".float-strip-holder .bot-strip-open")),
    header: box(document.querySelector(".float-chrome")), grip: box(document.querySelector(".float-grip:not([hidden])")),
    dock: box(document.querySelector(".float-dock")), collapse: box(document.querySelector(".float-collapse")),
    native: list.length ? list[list.length - 1] : null, sent: window.__sent.slice(-4), saved: localStorage.getItem(${JSON.stringify(FLOAT_KEY)}) };
})()`;

const runner = `const { app, BrowserWindow } = require("electron");
const fs = require("fs");
if (app.dock) app.dock.hide();
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, focusable: false, width: 1400, height: 900, useContentSize: true, webPreferences: { offscreen: true } });
    await win.loadFile(process.env.LAYOUT_PAGE);
    const web = win.webContents;
    const probe = () => web.executeJavaScript(fs.readFileSync(process.env.LAYOUT_PROBE, "utf8"));
    await web.executeJavaScript("localStorage.clear()");
    await web.reload(); await new Promise((done) => web.once("did-finish-load", done));
    await wait(400);
    const mid = (b) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    const click = async (b) => { const { x, y } = mid(b);
      web.sendInputEvent({ type: "mouseMove", x, y }); web.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }); web.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 }); await wait(300); };
    // globalX/Y: the screen position, which the header's drag measures by (the view moves under the pointer).
    const at = (x, y) => ({ x, y, globalX: x, globalY: y });
    const drag = async (from, dx, dy) => {
      web.sendInputEvent({ type: "mouseMove", ...at(from.x, from.y) });
      web.sendInputEvent({ type: "mouseDown", ...at(from.x, from.y), button: "left", clickCount: 1 });
      for (let i = 1; i <= 8; i++) { web.sendInputEvent({ type: "mouseMove", ...at(Math.round(from.x + dx * i / 8), Math.round(from.y + dy * i / 8)), button: "left", modifiers: ["leftButtonDown"] }); await wait(25); }
      web.sendInputEvent({ type: "mouseUp", ...at(from.x + dx, from.y + dy), button: "left", clickCount: 1 });
      await wait(300);
    };
    const out = { start: await probe() };
    await click(out.start.strip); out.open = await probe();
    const grab = { x: Math.round(out.open.header.x + 60), y: Math.round(out.open.header.y + 20) };
    await drag(grab, -420, -150); out.moved = await probe();
    const near = { x: Math.round(out.moved.header.x + 60), y: Math.round(out.moved.header.y + 20) };
    await drag(near, -(out.moved.native.x - out.moved.note.x) + 8, -(out.moved.native.y - out.moved.note.y) + 6); out.snapped = await probe();
    await drag(mid(out.snapped.grip), 60, 40); out.resized = await probe();
    if (process.env.FLOAT_SHOT) {
      // The panel moved back over the Note's right half for the picture.
      await drag({ x: Math.round(out.resized.header.x + 60), y: Math.round(out.resized.header.y + 20) }, 520, 120);
      const image = await web.capturePage();
      fs.writeFileSync(process.env.FLOAT_SHOT, image.toPNG());
      out.shot = await probe();
    }
    const before = await probe();
    await click(before.dock); out.docked = await probe();
    await click(out.docked.dock); out.floatedAgain = await probe();
    await click(out.floatedAgain.collapse); out.collapsed = await probe();
    if (process.env.FLOAT_SHOT) fs.writeFileSync(process.env.FLOAT_SHOT.replace(/\.png$/, "-strip.png"), (await web.capturePage()).toPNG());
    await click(out.collapsed.strip); out.reopened = await probe();
    process.stdout.write("LAYOUT " + JSON.stringify(out) + "\\n");
  } catch (error) { process.stdout.write("LAYOUT-ERROR " + String(error && error.stack || error) + "\\n"); }
  app.exit(0);
});`;

const dir = mkdtempSync(join(tmpdir(), "botling-floating-chat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function layout(): Promise<Record<string, Probe>> {
  const css = join(desktop, "out/renderer/styles.css"), frameCss = join(desktop, "out/renderer/frame.css");
  if (!existsSync(css) || !existsSync(frameCss)) throw new Error("out/renderer is missing: run `node build.mjs` first (test:changed does)");
  await build({ entryPoints: [join(desktop, "test/fixtures/floating-chat/entry.tsx")], bundle: true, format: "iife", target: "chrome130", jsx: "automatic",
    outfile: join(dir, "entry.js"), nodePaths: [join(desktop, "node_modules")], define: { "process.env.NODE_ENV": '"production"', __CHARACTERS__: "{}", __BOTLING_WEB__: "false" }, logLevel: "silent" });
  writeFileSync(join(dir, "page.html"), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(css)}"><link rel="stylesheet" href="${pathToFileURL(frameCss)}"></head>
<body><div id="root"></div><script src="${pathToFileURL(join(dir, "entry.js"))}"></script></body></html>`);
  writeFileSync(join(dir, "probe.js"), probe);
  writeFileSync(join(dir, "main.cjs"), runner);
  const env: NodeJS.ProcessEnv = { ...process.env, LAYOUT_PAGE: join(dir, "page.html"), LAYOUT_PROBE: join(dir, "probe.js") };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron") as unknown as string, [join(dir, "main.cjs")], { env, encoding: "utf8", timeout: 90_000 });
  const line = result.stdout.split("\n").find((text) => text.startsWith("LAYOUT"));
  if (process.env.FLOAT_DEBUG) console.log(line);
  if (!line?.startsWith("LAYOUT ")) throw new Error(`offscreen layout failed: ${line ?? ""}\n${result.stderr}`);
  return JSON.parse(line.slice("LAYOUT ".length)) as Record<string, Probe>;
}

const right = (box: Box) => box.x + box.width;
const bottom = (box: Box) => box.y + box.height;

describe.runIf(process.platform === "darwin" || !!process.env.DISPLAY)("the floating chat over the Note as laid out (offscreen window)", () => {
  let run: Record<string, Probe>;
  beforeAll(async () => { run = await layout(); }, 120_000);

  it("the strip sits in the Note's bottom right corner; the chat is hidden", () => {
    const { start } = run;
    expect(start.strip).toBeTruthy();
    expect(right(start.note) - right(start.strip!)).toBeGreaterThan(0);
    expect(right(start.note) - right(start.strip!)).toBeLessThan(40);
    expect(bottom(start.note) - bottom(start.strip!)).toBeLessThan(40);
    expect(start.native).toBeNull();
    expect(start.header).toBeNull();
  });

  it("a click opens the panel at the Note's bottom right at the default size, the chat in it, the strip gone", () => {
    const { open } = run;
    expect(open.strip).toBeNull();
    expect(open.native).toEqual({ x: Math.round(right(open.note) - MARGIN - DEFAULT_W), y: Math.round(bottom(open.note) - MARGIN - DEFAULT_H), width: DEFAULT_W, height: DEFAULT_H });
    // The header is drawn by the chat page, at the top of the panel.
    expect(Math.round(open.header!.y)).toBe(open.native!.y);
  });

  it("the header drags it, the chat following; dropped near a corner it snaps in", () => {
    const { open, moved, snapped } = run;
    expect(moved.native!.x).toBe(open.native!.x - 420);
    expect(moved.native!.y).toBe(open.native!.y - 150);
    expect(moved.native!.width).toBe(DEFAULT_W);
    expect(snapped.native!.x).toBe(Math.round(snapped.note.x + MARGIN));
    expect(snapped.native!.y).toBe(Math.round(snapped.note.y + MARGIN));
  });

  it("the corner grip resizes it from the top left corner", () => {
    const { snapped, resized } = run;
    expect(resized.native!.x).toBe(snapped.native!.x);
    expect(resized.native!.y).toBe(snapped.native!.y);
    expect(resized.native!.width).toBe(DEFAULT_W + 60);
    expect(resized.native!.height).toBe(DEFAULT_H + 40);
  });

  it("the dock button lays it beside the Note, and floats it back where it was", () => {
    const { docked, floatedAgain, collapsed } = run;
    expect(docked.native!.width).toBe(COLUMNS.noteChat.fallback);
    expect(docked.native!.x).toBe(Math.round(right(docked.note)));
    expect(docked.grip).toBeNull();
    const panel = JSON.parse(collapsed.saved!).note.panel;
    expect(floatedAgain.native).toEqual({ x: Math.round(floatedAgain.note.x + panel.x), y: Math.round(floatedAgain.note.y + panel.y), width: panel.w, height: panel.h });
  });

  it("collapse brings the strip back and hides the chat; opening again finds the panel where it was left", () => {
    const { floatedAgain, collapsed, reopened } = run;
    expect(collapsed.native).toBeNull();
    expect(collapsed.strip).toBeTruthy();
    expect(reopened.native).toEqual(floatedAgain.native);
    const saved = JSON.parse(collapsed.saved!);
    expect(saved.note.docked).toBe(false);
    expect(saved.browser.panel).toBeNull();
    expect(saved.preview.panel).toBeNull();
  });
});
