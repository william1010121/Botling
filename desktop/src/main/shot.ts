// `electron <desktop> --component-shot <component folder> …` (1.x's ComponentShotRun.swift): draws one
// component in this build's real chat page — in a reply, as Board tiles of several sizes, opened above
// the input box, floating in a corner — in a hidden window, pictures each frame, judges it
// (src/core/component-shot.ts, checked against the Swift strings), writes a contact sheet and
// report.json, prints the summary and exits (0: no problems, 1: problems, 2: bad usage, 3: it could not
// draw). Main serves the pages as for the app; no core starts and no data folder is touched.
import type { BrowserWindow, NativeImage, WebFrameMain } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  FRAMES_SCRIPT, fileName, isUniform, sourceText, judge, neverLoaded, notDrawn, parse, resolveData, shotSizes, summary, USAGE,
  type Finding, type FrameReport, type Shot, type Surface,
} from "../core/component-shot";
import { ComponentLibrary } from "../core/components/library";
import { chatState } from "../renderer/payload";
import type { BotView, ChatSnapshot, ComponentInfoView, DisplayView, PinView } from "../contract";

/** How long each step is given, in ms (1.x's `Timing`). */
const TIMING = { giveUp: 180_000, beforeSecondScript: 500, settle: 3_500, pageNeverReady: 20_000 };

/** The host page (served at app://botling/shot.html): the chat page in a frame, its component frames' pages from main. */
export const SHOT_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe id="chat" src="botling-chat://chat/chat.html"></iframe><script src="shot.js"></script></body></html>`;
export const SHOT_JS = (protocolVersion: number) => `(() => {
  const frame = document.getElementById("chat");
  const chat = "botling-chat://chat";
  // (The page's CSP has no inline styles: the layout is set from here.)
  for (const element of [document.documentElement, document.body]) Object.assign(element.style, { margin: "0", padding: "0", height: "100%", overflow: "hidden", background: "#0E0E10" });
  Object.assign(frame.style, { border: "0", display: "block", width: "100vw", height: "100vh" });
  let next = 0, ready = false, state = null;
  const waiting = new Map();
  window.botling.subscribe((message) => { const done = waiting.get(message && message.id); if (done) { waiting.delete(message.id); done(message); } });
  const push = () => { if (ready && state) frame.contentWindow.postMessage({ botling: "state", state, extras: { botId: state.botID, running: false, cards: {}, states: {} } }, chat); };
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.origin !== chat) return;
    const message = event.data;
    if (message && message.botling === "page") {
      const id = "shot" + (++next);
      waiting.set(id, (answer) => frame.contentWindow.postMessage({ botling: "page", id: message.id, url: answer.ok ? answer.result.url : null }, chat));
      window.botling.post({ v: ${protocolVersion}, id, cmd: { type: "card.page", html: message.html } });
    } else if (message && message.botling === "action" && message.action && message.action.type === "ready") {
      ready = true;
      window.__shotReady = true;
      push();
    }
  });
  window.__shotStart = (given) => { state = given; push(); };
})();`;

interface Drawn { surface: Surface; image: NativeImage | null; scale: number; frames: { x: number; y: number; width: number; height: number; surface: string; size: string }[]; reports: Map<string, FrameReport> }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The state the chat page draws for one surface (1.x's ChatPayload for a throwaway main bot). */
function stateFor(surface: Surface, name: string, data: string, sizes: string[], info: ComponentInfoView) {
  const display: DisplayView = { name, data, at: null, command: null, folder: null, detail: null, card: null, status: null, error: null, ranAt: null, images: null, pinned: null, every: null };
  const pin = (id: number, size: string, float: boolean): PinView => ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, name, headline: name, chip: { text: name.slice(0, 14), tone: "neutral" }, size, place: null, panelHeight: null,
    refresh: "manual", minutes: 15, seconds: null, display: { ...display, card: `pin/${id}` }, makingLive: null,
    float: float ? { corner: "topRight", width: null, height: null, collapsed: false } : null, floatMenu: float ? "stop" : "float",
  });
  const bot = { id: "6A0B0000-0000-4000-8000-000000000002", name: "Main bot", role: "main", avatar: "circle", folder: "/", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0,
    problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;
  const pins = surface === "board" ? sizes.map((size, index) => pin(index + 1, size, false))
    : surface === "pinned" ? [pin(1, sizes.includes("2x2") ? "2x2" : sizes[0]!, false)]
    : surface === "floating" ? [pin(1, "2x2", true)] : [];
  const chat: ChatSnapshot = {
    botId: bot.id, running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pinChoices: [],
    messages: surface === "chat" ? [{ id: "00000000-0000-4000-8000-0000000000A1", role: "bot", text: "", time: new Date().toISOString(), displays: [display] }] : [],
    pins, floating: pins.filter((entry) => entry.float),
  };
  return chatState(bot, chat, new Date(), null, { components: { [name]: info }, board: surface === "board", look: "original" }).state;
}

/** The window's picture, cropped to `rect` (page points) with `pad` points around it. */
function crop(image: NativeImage, rect: { x: number; y: number; width: number; height: number }, scale: number, pad: number): NativeImage | null {
  const size = image.getSize();
  const x = Math.max(0, Math.floor((rect.x - pad) * scale)), y = Math.max(0, Math.floor((rect.y - pad) * scale));
  const width = Math.min(size.width - x, Math.ceil((rect.width + pad * 2) * scale)), height = Math.min(size.height - y, Math.ceil((rect.height + pad * 2) * scale));
  if (width <= 0 || height <= 0) return null;
  return image.crop({ x, y, width, height });
}

/** Every frame's picture on one dark sheet, each labelled with where it was drawn (drawn on a canvas in the host page). */
async function contactSheet(window: BrowserWindow, tiles: [string, NativeImage][], title: string): Promise<Buffer | null> {
  if (!tiles.length) return null;
  const items = tiles.map(([place, image]) => ({ place, url: image.toDataURL(), ...image.getSize() }));
  const script = `(async () => {
    const items = ${JSON.stringify(items)};
    const gap = 32, label = 44, maxWidth = 2400;
    let x = gap, y = gap + 64, row = 0, width = 0;
    const placed = [];
    for (const item of items) {
      if (x > gap && x + item.width + gap > maxWidth) { x = gap; y += row + label + gap; row = 0; }
      placed.push({ ...item, x, y: y + label });
      x += item.width + gap; width = Math.max(width, x); row = Math.max(row, item.height);
    }
    const height = y + row + label + gap;
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext("2d");
    g.fillStyle = "rgb(18,18,20)"; g.fillRect(0, 0, width, height);
    g.fillStyle = "rgb(237,237,237)"; g.font = "bold 40px system-ui"; g.textBaseline = "top";
    g.fillText(${JSON.stringify(title + " · dark")}, gap, gap);
    for (const item of placed) {
      const image = new Image(); image.src = item.url; await image.decode();
      g.fillStyle = "rgb(161,161,161)"; g.font = "500 28px system-ui"; g.fillText(item.place, item.x, item.y - label + 4);
      g.drawImage(image, item.x, item.y);
      g.strokeStyle = "rgba(255,255,255,0.12)"; g.strokeRect(item.x - 0.5, item.y - 0.5, item.width + 1, item.height + 1);
    }
    return canvas.toDataURL("image/png");
  })()`;
  const url = await window.webContents.executeJavaScript(script) as string;
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

function findFrame(window: BrowserWindow, test: (frame: WebFrameMain) => boolean): WebFrameMain | null {
  return window.webContents.mainFrame.framesInSubtree.find(test) ?? null;
}

/** Loads the host page at `size`, gives it the state, waits for the frames to draw, reads where they are and takes a picture. */
async function draw(surface: Surface, size: { width: number; height: number }, state: unknown, after: string | null, makeWindow: (size: { width: number; height: number }) => BrowserWindow): Promise<Drawn> {
  const window = makeWindow(size);
  try {
    await window.loadURL("app://botling/shot.html");
    const start = Date.now();
    while (!(await window.webContents.executeJavaScript("!!window.__shotReady")) && Date.now() - start < TIMING.pageNeverReady) await sleep(100);
    await window.webContents.executeJavaScript(`window.__shotStart(${JSON.stringify(state)})`);
    if (after) {
      await sleep(TIMING.beforeSecondScript);
      await findFrame(window, (frame) => frame.url.startsWith("botling-chat://chat/"))?.executeJavaScript(after).catch(() => {});
    }
    await sleep(TIMING.settle);
    const chat = findFrame(window, (frame) => frame.url.startsWith("botling-chat://chat/"));
    const frames = (await chat?.executeJavaScript(FRAMES_SCRIPT).catch(() => []) ?? []) as Drawn["frames"];
    const reports = new Map<string, FrameReport>();
    for (const frame of window.webContents.mainFrame.framesInSubtree.filter((candidate) => candidate.url.startsWith("botling-card://page/"))) {
      const report = await frame.executeJavaScript("window.__ccbShotMeasure ? window.__ccbShotMeasure() : null").catch(() => null) as FrameReport | null;
      if (report) reports.set(`${report.surface}|${report.size}`, report);
    }
    const image = await window.webContents.capturePage();
    const scale = image.isEmpty() ? 1 : image.getSize().width / size.width;
    return { surface, image: image.isEmpty() ? null : image, scale, frames, reports };
  } finally {
    window.destroy();
  }
}

/** The whole run; resolves with the exit code. */
export async function runShot(argv: readonly string[], makeWindow: (size: { width: number; height: number }) => BrowserWindow, print: (text: string) => void, fail: (text: string) => void): Promise<number> {
  const parsed = parse(argv);
  if (!parsed.ok) { fail(parsed.error.message); return 2; }
  const options = parsed.options;
  const name = basename(options.component);
  const library = new ComponentLibrary(() => [dirname(options.component)]);
  const info = library.info(name);
  if (!info) { fail(`There is no template.html in ${options.component}.\n\n${USAGE}`); return 2; }
  mkdirSync(options.out, { recursive: true });
  const resolved = await resolveData(options);
  if ("error" in resolved) { fail(resolved.error); return 2; }
  const { data, source, notes } = resolved;
  const findings: Finding[] = [...resolved.findings];
  const sizes = shotSizes(options.sizes, library.sizes(name));
  const view: ComponentInfoView = { template: info.template, version: 0, updated: false, sizes: info.sizes, icon: info.icon, title: info.title };
  const drawn: Drawn[] = [];
  for (const surface of options.surfaces) {
    const rows = sizes.map((size) => Number(size.split("x")[1] ?? 1)).reduce((a, b) => a + b, 0);
    const size = surface === "chat" ? { width: 760, height: 1100 } : surface === "board" ? { width: 900, height: Math.min(4000, 300 + rows * 200) }
      : surface === "pinned" ? { width: 760, height: 1000 } : { width: 1000, height: 800 };
    const open = surface === "pinned" ? `document.dispatchEvent(new CustomEvent('ccb-open-pin', {detail: ${JSON.stringify(name)}}))` : null;
    drawn.push(await draw(surface, size, stateFor(surface, name, data, sizes, view), open, makeWindow));
  }
  const shots: Shot[] = [];
  const tiles: [string, NativeImage][] = [];
  for (const result of drawn) {
    if (result.image) writeFileSync(join(options.out, `page-${result.surface}.png`), result.image.toPNG());
    if (!result.frames.length && !result.reports.size) {
      findings.push(notDrawn(result.surface, data));
      continue;
    }
    const seen = new Set<string>();
    for (const frame of result.frames) {
      const key = `${frame.surface}|${frame.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const place = result.surface === "board" ? `board ${frame.size}` : result.surface;
      const report = result.reports.get(key);
      if (!report) { findings.push(neverLoaded(place)); continue; }
      let uniform = false;
      if (result.image) {
        const exact = crop(result.image, frame, result.scale, 0);
        uniform = exact ? isUniform(rgba(exact)) : false;
        const tile = crop(result.image, frame, result.scale, 10);
        if (tile) {
          const path = join(options.out, `${fileName(place)}.png`);
          writeFileSync(path, tile.toPNG());
          shots.push({ place, path });
          tiles.push([place, tile]);
        }
      }
      findings.push(...judge(report, place, uniform));
    }
    // Reported but not on the page (scrolled away, hidden): judged without a picture.
    for (const [key, report] of result.reports) {
      if (seen.has(key)) continue;
      findings.push(...judge(report, result.surface === "board" ? `board ${report.size}` : result.surface, false));
    }
  }
  let sheet: string | null = null;
  const sheetWindow = makeWindow({ width: 400, height: 300 });
  try {
    await sheetWindow.loadURL("app://botling/shot.html");
    const png = await contactSheet(sheetWindow, tiles, name);
    if (png) { sheet = join(options.out, "contact-sheet.png"); writeFileSync(sheet, png); }
  } finally {
    sheetWindow.destroy();
  }
  const report = { component: name, contactSheet: sheet, data: sourceText(source), findings: findings.map((finding) => ({ level: finding.level, place: finding.place, text: finding.text })), shots };
  writeFileSync(join(options.out, "report.json"), JSON.stringify(report, null, 2));
  print(summary(name, source, findings, shots, sheet, notes));
  print(`Report: ${join(options.out, "report.json")}`);
  return findings.some((finding) => finding.level === "problem") ? 1 : 0;
}

/** A picture's pixels as RGBA (Electron's bitmap is BGRA; the check compares channels alike). */
function rgba(image: NativeImage): Uint8Array {
  return new Uint8Array(image.toBitmap());
}
