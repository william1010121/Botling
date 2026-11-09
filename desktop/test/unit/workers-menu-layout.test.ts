// The workers badge's menu as the window really paints it, beside the Sub bots menu in the same row and above the
// native chat's placeholder (#chat-frame: an opaque, positioned div that holds the chat's snapshot while a shell
// overlay is open). Static markup of the real components and the built stylesheet, laid out in an offscreen Electron
// window that is never shown (no focus, no dock icon): the menu must have a size, sit in the window, and be what a
// click on each of its rows hits. A state-only check passed while the menu was painted under #chat-frame.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { BotView, SubagentRowView, WaitingView } from "../../src/contract";
import { SubBotNav } from "../../src/renderer/SubBotNav";
import { headerNav } from "../../src/renderer/sub-bot-nav";
import { WorkersBadge, WorkersMenu } from "../../src/renderer/Workers";
import { desktop } from "../helpers";

const now = Date.now();
const worker = (id: string, title: string): SubagentRowView => ({ id, title, status: "completed", head: "claude", startedAt: now - 30 * 60_000, endedAt: now - 20 * 60_000, unsettledAt: null, settled: true, prompt: "p" });
const math: BotView = { id: "m", name: "Math", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null,
  subagentRows: [worker("w1", "Fix the API"), worker("w2", "Write the docs"), worker("w3", "Run the tests")] };
const sub = (id: string, name: string): BotView => ({ ...math, id, name, role: "bot", parent: "m", job: `${name} job`, subagentRows: [] });
const bots = [math, sub("r", "Release"), sub("n", "Nightly")];
const none: WaitingView = { items: [], doing: {} };

// The header row and the chat placeholder as App.tsx draws them for a native chat (checked against its source below).
const page = (css: string) => {
  const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
  const badge = draw(createElement(WorkersBadge, { bot: math, bots, seen: new Set<string>(), on: true, onClick() {} }));
  const menu = draw(createElement(WorkersMenu, { bot: math, bots, onOpen() {}, onClose() {} }));
  const subBots = draw(createElement(SubBotNav, { nav: headerNav(math, bots, none, now), open: true, onOpenChange() {}, onOpen() {}, keys: { menu: "⌘⇧S", back: "⌘[", forward: "⌘]" } }));
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(css)}"></head>
<body style="margin:0"><div style="display:flex;height:100vh"><section class="chat-pane"><div class="chat-column">
<header class="chat-header drag"><span class="chat-title">Math</span></header>
<div class="board-switch-bar"><span class="workers-badge-slot">${badge}${menu}</span><div class="board-switch-left">${subBots}</div>
<div class="board-switch" role="group" aria-label="Chat views"><button type="button" aria-pressed="true">Chat</button></div></div>
<div id="chat-frame" aria-label="Chat" style="position:relative;overflow:hidden"></div>
</div></section></div></body></html>`;
};

// Runs in the offscreen window: each menu's box, its look, and what a click at each row's centre would hit.
const probe = `(async () => {
  await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  const out = {};
  for (const [name, selector, rows] of [["workers", ".wk-menu", ".wk-row, .wk-owner"], ["subBots", ".sbn-menu", "button"]]) {
    const menu = document.querySelector(selector);
    if (!menu) { out[name] = null; continue; }
    const box = menu.getBoundingClientRect(), style = getComputedStyle(menu);
    const hits = [...menu.querySelectorAll(rows)].map((row) => {
      const r = row.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { text: row.textContent.trim().slice(0, 40), inMenu: !!hit && menu.contains(hit), hit: hit ? (hit.id ? "#" + hit.id : hit.className || hit.tagName) : null };
    });
    out[name] = { box: { x: box.x, y: box.y, width: box.width, height: box.height }, opacity: style.opacity, visibility: style.visibility, display: style.display, hits };
  }
  out.viewport = { width: innerWidth, height: innerHeight };
  return out;
})()`;

const runner = `const { app, BrowserWindow } = require("electron");
const fs = require("fs");
if (app.dock) app.dock.hide();
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, focusable: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
    await win.loadFile(process.env.LAYOUT_PAGE);
    const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.LAYOUT_PROBE, "utf8"));
    if (process.env.LAYOUT_SHOT) fs.writeFileSync(process.env.LAYOUT_SHOT, (await win.webContents.capturePage()).toPNG());
    process.stdout.write("LAYOUT " + JSON.stringify(result) + "\\n");
  } catch (error) { process.stdout.write("LAYOUT-ERROR " + String(error && error.stack || error) + "\\n"); }
  app.exit(0);
});`;

type Menu = { box: { x: number; y: number; width: number; height: number }; opacity: string; visibility: string; display: string; hits: { text: string; inMenu: boolean; hit: string | null }[] };
type Layout = { workers: Menu | null; subBots: Menu | null; viewport: { width: number; height: number } };

const dir = mkdtempSync(join(tmpdir(), "botling-workers-layout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function layout(): Layout {
  const css = join(desktop, "out/renderer/styles.css");
  if (!existsSync(css)) throw new Error("out/renderer/styles.css is missing: run `node build.mjs` first (test:changed does)");
  writeFileSync(join(dir, "page.html"), page(css));
  writeFileSync(join(dir, "probe.js"), probe);
  writeFileSync(join(dir, "main.cjs"), runner);
  const env: NodeJS.ProcessEnv = { ...process.env, LAYOUT_PAGE: join(dir, "page.html"), LAYOUT_PROBE: join(dir, "probe.js") };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron") as unknown as string, [join(dir, "main.cjs")], { env, encoding: "utf8", timeout: 60_000 });
  const line = result.stdout.split("\n").find((text) => text.startsWith("LAYOUT"));
  if (!line?.startsWith("LAYOUT ")) throw new Error(`offscreen layout failed: ${line ?? ""}\n${result.stderr}`);
  return JSON.parse(line.slice("LAYOUT ".length)) as Layout;
}

describe("the mirrored header matches App.tsx", () => {
  const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
  it("the badge and its menu sit in .workers-badge-slot inside .board-switch-bar, before the native chat's placeholder", () => {
    const bar = app.indexOf('<div className="board-switch-bar">'), slot = app.indexOf('<span className="workers-badge-slot">'), menu = app.indexOf("<WorkersMenu bot={bot}");
    expect(bar).toBeGreaterThan(0);
    expect(slot).toBeGreaterThan(bar);
    expect(menu).toBeGreaterThan(slot);
    expect(app).toContain('<div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }}>');
  });
});

// Electron needs a display on Linux; the CI's macOS job runs this.
describe.runIf(process.platform === "darwin" || !!process.env.DISPLAY)("the workers menu as painted (offscreen window)", () => {
  it("is drawn with its rows above the native chat's placeholder, like the Sub bots menu beside it", () => {
    const result = layout();
    const workers = result.workers!, subBots = result.subBots!;
    expect(workers, "the workers menu is in the page").toBeTruthy();
    expect(subBots, "the Sub bots menu is in the page").toBeTruthy();
    // The control: the Sub bots menu in the same row is what its rows hit.
    expect(subBots.hits.length).toBeGreaterThan(0);
    expect(subBots.hits.every((hit) => hit.inMenu), JSON.stringify(subBots.hits)).toBe(true);
    // A real box, inside the window, not faded or hidden.
    expect(workers.box.width).toBeGreaterThan(200);
    expect(workers.box.height).toBeGreaterThan(60);
    expect(workers.box.x).toBeGreaterThanOrEqual(0);
    expect(workers.box.y).toBeGreaterThanOrEqual(0);
    expect(workers.box.x + workers.box.width).toBeLessThanOrEqual(result.viewport.width);
    expect(workers.box.y + workers.box.height).toBeLessThanOrEqual(result.viewport.height);
    expect([workers.display, workers.visibility, workers.opacity]).toEqual(["flex", "visible", "1"]);
    // Every row (the three workers) is on top: a click there lands in the menu, not on #chat-frame.
    expect(workers.hits.map((hit) => hit.text).join(" | ")).toMatch(/Fix the API.*Write the docs.*Run the tests/);
    expect(workers.hits.filter((hit) => !hit.inMenu), JSON.stringify(workers.hits)).toEqual([]);
  });
});
