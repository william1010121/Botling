// The Note tab's docked chat as the window really lays it out (test/fixtures/note-dock/entry.tsx: the real ChatBody,
// ColumnDivider, BotBubble and dock state, the built stylesheet), in an offscreen Electron window that is never shown
// (no focus, no dock icon), driven with real mouse input (webContents.sendInputEvent). It pins: the bubble sits at the
// bottom right of the Note; a click docks the native chat right beside the Note at the default width, the same height;
// the divider between them is grabbable outside the chat's native bounds, resizes it live and remembers the width;
// the chat follows when the right panel moves it; the bubble closes it again (the native chat hidden).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLUMNS } from "../../src/renderer/column-resize";
import { desktop } from "../helpers";

type Box = { x: number; y: number; width: number; height: number };
type Probe = {
  note: Box; bubble: Box | null; bubblePressed: string | null; chatBox: Box | null;
  handle: { x: number; strip: [number, number]; hits: boolean[] } | null;
  native: Box | null; saved: string | null;
};

const probe = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const note = document.querySelector(".main-tab"), bubble = document.querySelector(".note-bubble"), chat = document.getElementById("chat-frame");
  const h = document.querySelector('.col-handle[data-column="noteChat"]');
  let handle = null;
  if (h) {
    const x = h.getBoundingClientRect().x, strip = [x - 7, x], hits = [];
    for (const y of [120, 400, 700]) for (let px = Math.ceil(strip[0]); px < strip[1]; px++) hits.push(document.elementFromPoint(px + 0.5, y) === h);
    handle = { x, strip, hits };
  }
  const list = window.__native.chat;
  return { note: box(note), bubble: box(bubble), bubblePressed: bubble && bubble.getAttribute("aria-pressed"), chatBox: chat.getBoundingClientRect().width ? box(chat) : null,
    handle, native: list.length ? list[list.length - 1] : null, saved: localStorage.getItem(${JSON.stringify(COLUMNS.noteChat.key)}) };
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
    const click = async (b) => { const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
      web.sendInputEvent({ type: "mouseMove", x, y }); web.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }); web.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 }); await wait(300); };
    const drag = async (from, to, y = 400) => {
      web.sendInputEvent({ type: "mouseMove", x: from, y });
      web.sendInputEvent({ type: "mouseDown", x: from, y, button: "left", clickCount: 1 });
      for (let i = 1; i <= 8; i++) { web.sendInputEvent({ type: "mouseMove", x: Math.round(from + (to - from) * i / 8), y, button: "left", modifiers: ["leftButtonDown"] }); await wait(20); }
      web.sendInputEvent({ type: "mouseUp", x: to, y, button: "left", clickCount: 1 });
      await wait(300);
    };
    const out = { start: await probe() };
    await click(out.start.bubble); out.docked = await probe();
    let x = Math.floor((out.docked.handle.strip[0] + out.docked.handle.strip[1]) / 2);
    await drag(x, x - 100); out.dragged = await probe();
    const side = await web.executeJavaScript("(() => { const r = document.querySelector('.col-handle[data-column=\\"right\\"]').getBoundingClientRect(); return Math.floor(r.x + 3); })()");
    await drag(side, side + 40); out.sideMoved = await probe();
    await click(out.sideMoved.bubble); out.closed = await probe();
    await click(out.closed.bubble); out.reopened = await probe();
    process.stdout.write("LAYOUT " + JSON.stringify(out) + "\\n");
  } catch (error) { process.stdout.write("LAYOUT-ERROR " + String(error && error.stack || error) + "\\n"); }
  app.exit(0);
});`;

const dir = mkdtempSync(join(tmpdir(), "botling-note-dock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function layout(): Promise<Record<string, Probe>> {
  const css = join(desktop, "out/renderer/styles.css");
  if (!existsSync(css)) throw new Error("out/renderer/styles.css is missing: run `node build.mjs` first (test:changed does)");
  await build({ entryPoints: [join(desktop, "test/fixtures/note-dock/entry.tsx")], bundle: true, format: "iife", target: "chrome130", jsx: "automatic",
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
  return JSON.parse(line.slice("LAYOUT ".length)) as Record<string, Probe>;
}

const right = (box: Box) => box.x + box.width;
const bottom = (box: Box) => box.y + box.height;

describe("the fixture matches App.tsx", () => {
  it("puts the Note's frame, then the chat page, in ChatBody", () => {
    const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
    const body = app.indexOf("<ChatBody docked={noteDocked}>"), tab = app.indexOf("<MainTabFrame key=", body), chat = app.indexOf("<ChatFrame client=", body), end = app.indexOf("</ChatBody>", body);
    expect(body).toBeGreaterThan(0);
    expect(tab).toBeGreaterThan(body);
    expect(chat).toBeGreaterThan(tab);
    expect(end).toBeGreaterThan(chat);
  });
});

describe.runIf(process.platform === "darwin" || !!process.env.DISPLAY)("the Note's docked chat as laid out (offscreen window)", () => {
  let run: Record<string, Probe>;
  beforeAll(async () => { run = await layout(); }, 120_000);

  it("the bubble sits at the bottom right of the Note; the chat is hidden until it is clicked", () => {
    const { start } = run;
    expect(start.bubble).toBeTruthy();
    expect(right(start.note) - right(start.bubble!)).toBeGreaterThan(0);
    expect(right(start.note) - right(start.bubble!)).toBeLessThan(40);
    expect(bottom(start.note) - bottom(start.bubble!)).toBeGreaterThan(0);
    expect(bottom(start.note) - bottom(start.bubble!)).toBeLessThan(40);
    expect(start.bubblePressed).toBe("false");
    expect(start.native).toBeNull();
    expect(start.handle).toBeNull();
  });

  it("a click docks the native chat right beside the Note, at the default width and the Note's height", () => {
    const { start, docked } = run;
    expect(docked.bubblePressed).toBe("true");
    const chat = docked.native!;
    expect(chat, "the native chat got bounds").toBeTruthy();
    expect(chat.width).toBe(COLUMNS.noteChat.fallback);
    expect(chat.x).toBe(Math.round(right(docked.note)));
    expect(chat.y).toBe(Math.round(docked.note.y));
    expect(chat.height).toBe(Math.floor(docked.note.height));
    expect(right(docked.note) + chat.width).toBeCloseTo(right(start.note), 0);
    // The bubble stays over the Note, never over the native chat.
    expect(right(docked.bubble!)).toBeLessThanOrEqual(chat.x);
  });

  it("the divider's grab strip is outside the native chat and is what the pointer hits", () => {
    const { docked } = run;
    const handle = docked.handle!;
    expect(handle).toBeTruthy();
    expect(handle.strip[1]).toBeLessThanOrEqual(docked.native!.x);
    expect(handle.hits.length).toBeGreaterThan(12);
    expect(handle.hits.every(Boolean), JSON.stringify(handle.hits)).toBe(true);
  });

  it("dragging the divider resizes the chat live, the Note giving way, and remembers the width", () => {
    const { docked, dragged } = run;
    expect(dragged.native!.width).toBe(docked.native!.width + 100);
    expect(dragged.native!.x).toBe(docked.native!.x - 100);
    expect(dragged.note.width).toBeCloseTo(docked.note.width - 100, 0);
    expect(dragged.saved).toBe(String(docked.native!.width + 100));
  });

  it("the chat follows when the right panel narrows and moves it without resizing it", () => {
    const { dragged, sideMoved } = run;
    expect(sideMoved.native!.width).toBe(dragged.native!.width);
    // The panel narrows from its default to at most its minimum.
    expect(sideMoved.native!.x).toBe(dragged.native!.x + Math.min(40, COLUMNS.right.fallback! - COLUMNS.right.min));
    expect(sideMoved.native!.x).toBe(Math.round(right(sideMoved.note)));
  });

  it("the bubble closes it (the native chat hidden), and it opens again at the remembered width", () => {
    const { closed, reopened, dragged } = run;
    expect(closed.native).toBeNull();
    expect(closed.chatBox).toBeNull();
    expect(closed.bubblePressed).toBe("false");
    expect(reopened.native!.width).toBe(dragged.native!.width);
  });
});
