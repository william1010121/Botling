// @vitest-environment jsdom
// A bot's own picture for its card on the main bot's whiteboard, as botling.whiteboard will draw it
// (plugin-extraction.md W3, W4): the <whiteboard> tag (the plugin's reply tag), the line every bot but
// the main bot is told (the core's prompt section, byte for byte),
// and the picture itself: the plugin's frame asks the app page for a tile, and a picture's command is
// allowed only on the app page's ApprovalSheet, never by the frame. Hostile frames stay contained.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseReply, saysNothing } from "../../src/core/reply";
import { botPrompts, CORE_PROMPT_SECTIONS, desktopPrompts, TASK_STAGE_SENTENCE, WHITEBOARD_PICTURE_LINE } from "../../src/core/prompts";
import { tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";
import { writeLibrary } from "../fixtures/components";
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, type BotView, type ComponentInfoView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { useApprovalSheet } from "../../src/renderer/ApprovalSheet";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost, TILE_DATA_MAX } from "../../src/renderer/plugin-frame-host";
import { panelPage } from "../../src/renderer/panel-page";
import { COMPONENT_CSP, PANEL_CSP, tileNavigation } from "../../src/main/card-page";

describe("<whiteboard> in a reply", () => {
  it("is botling.whiteboard's reply tag: the same tag, handed to the plugin whole", () => {
    expect(parseReply('Done. <whiteboard name="gitlog" command="git log --oneline" size="2x1"></whiteboard>', ["whiteboard"])).toMatchObject({
      body: "Done.", pluginTags: [{ tag: "whiteboard", attributes: { name: "gitlog", command: "git log --oneline", size: "2x1" }, body: "" }],
    });
    expect(parseReply("Cleared. <whiteboard clear/>", ["whiteboard"]).pluginTags).toEqual([{ tag: "whiteboard", attributes: {}, body: "" }]);
  });
});

describe("the line bots are told", () => {
  const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });
  it("is added after the <show> line for every bot but the main bot; the Swift-matched prompts stay as they are", () => {
    for (const role of ["manager", "bot"] as const) {
      const plain = botPrompts({ profile: profile(role) });
      const system = desktopPrompts(plain, profile(role)).system;
      expect(plain.system).not.toContain("<whiteboard");
      expect(system).toContain(`</show> to your reply.\n${WHITEBOARD_PICTURE_LINE}\n`);
    }
    const main = botPrompts({ profile: profile("main") });
    // The main bot gets no picture line; every bot gets only the <task> stage sentence besides.
    expect(desktopPrompts(main, profile("main"), "claude", false).system).toBe(main.system.replace(" done or stopped.", ` done or stopped. ${TASK_STAGE_SENTENCE}`));
    expect(WHITEBOARD_PICTURE_LINE).toContain('<whiteboard name="component name" size="1x1">JSON</whiteboard>');
    // It is the core's prompt section that botling.whiteboard's first version repeats byte for byte.
    expect(CORE_PROMPT_SECTIONS).toContainEqual({ id: "botling.whiteboard.picture", text: WHITEBOARD_PICTURE_LINE, after: "show", roles: ["manager", "bot"] });
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin's frame on the app page (jsdom): FrameBroker + plugin-frame-host + the page's ApprovalSheet.

const BOT = "6A0B0000-0000-4000-8000-000000000020";
const COMPONENTS: Record<string, ComponentInfoView> = { status: { template: "<div id=status-template></div>", version: 1, updated: false } as ComponentInfoView };
const BOTS = [{ id: "6A0B0000-0000-4000-8000-000000000002", role: "main", name: "Main bot" }, { id: BOT, role: "manager", name: "Site" }] as BotView[];
const PICTURE = { command: "git log --oneline", folder: "/p/site" };

function pluginFrame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  return { element, posted };
}
const send = (from: HTMLIFrameElement | null, data: unknown, origin = "null") =>
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: (from?.contentWindow ?? null) as MessageEventSource | null }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** A message whose answer opens the page's sheet: React updates happen inside act. */
const actSend = (from: HTMLIFrameElement, data: unknown) => act(async () => { send(from, data); for (let i = 0; i < 5; i++) await settle(); });

/** The core as the app page's client sees it: what each command answers, and every command sent. */
function fakeCore() {
  const sent: any[] = [];
  const approved = new Set<string>();
  let receive: (value: unknown) => void = () => {};
  const answer = (cmd: any): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } => {
    switch (cmd.type) {
      case "card.page": return { ok: true, result: { url: `botling-card://page/${"a".repeat(36)}` } };
      case "plugins.tileImages": return { ok: true, result: { images: JSON.parse(cmd.data)?.image ? { [JSON.parse(cmd.data).image]: "botling-card://image/abc" } : {} } };
      case "plugins.approvalAsk":
        if (cmd.folder !== PICTURE.folder) return { ok: false, error: { code: "bad_request", message: "A plugin's command runs in its bot's folder (/p/site), not /." } };
        return { ok: true, result: { needsApproval: approved.has(cmd.command) ? null : { command: cmd.command, folder: PICTURE.folder, detail: null, card: `Whiteboard: ${cmd.card ?? "?"}` } } };
      case "plugins.approve": approved.add(cmd.command); return { ok: true, result: { accepted: true } };
      default: return { ok: false, error: { code: "not_found", message: cmd.type } };
    }
  };
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
    sent.push(envelope.cmd);
    queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ...answer(envelope.cmd) }));
  } });
  return { client, sent, approved };
}

describe("botling.whiteboard's frame asks the app page for a tile and an approval", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let broker: FrameBroker;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    broker = new FrameBroker(window, { name: "test panel broker" });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    broker.dispose();
    document.body.innerHTML = "";
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  /** The app page: its own sheet, and the plugin's frame registered for `plugin`. */
  async function page(plugin = "botling.whiteboard") {
    const core = fakeCore();
    const frame = pluginFrame();
    let dispose = () => {};
    function Page() {
      const approval = useApprovalSheet(core.client, "en", () => {}, 0);
      // Registered once, as PanelFrame does (the sheet's ask is read when an ask comes).
      const ask = approval.ask;
      (Page as any).ask = ask;
      return createElement("div", null, approval.sheet);
    }
    await act(async () => root.render(createElement(Page)));
    dispose = registerPluginFrame(broker, pluginFrameHost({ client: core.client, components: () => COMPONENTS, bots: () => BOTS, ask: (...args) => (Page as any).ask(...args) }), { frame: frame.element, plugin });
    return { ...core, frame, dispose };
  }

  it("a tile: a library component drawn read only as a Board tile, on a card page main serves; its URL goes back to the frame", async () => {
    const { frame, sent } = await page();
    send(frame.element, { ccb: "tile", id: 1, component: "status", data: { ok: true, image: "chart.png" }, size: "2x1", botId: BOT });
    await until(() => frame.posted.length === 1);
    expect(frame.posted).toEqual([{ ccb: "reply", id: 1, ok: true, value: `botling-card://page/${"a".repeat(36)}` }]);
    // The core finds the pictures its data names (the bot's folder); the page puts them into the tile's page. A tile never reads a path itself.
    expect(sent.map((cmd) => cmd.type)).toEqual(["plugins.tileImages", "card.page"]);
    expect(sent[0]).toEqual({ type: "plugins.tileImages", name: "botling.whiteboard", botId: BOT, data: '{"ok":true,"image":"chart.png"}' });
    expect(Command.safeParse(sent[0]).success).toBe(true);
    expect(sent[1]).not.toHaveProperty("panel");
    expect(Command.safeParse(sent[1]).success).toBe(true);
    const html: string = sent[1].html;
    expect(html).toContain("botling-card://image/abc");
    expect(html).toContain("<div id=status-template></div>");
    expect(html).toContain('data-size="2x1" data-surface="board" data-fill');
    expect(html).toContain('"ok":true');
    // Not in the library, no such bot, too much data, a size a card has no room for: refused, nothing served.
    send(frame.element, { ccb: "tile", id: 2, component: "nope", data: null, size: "1x1", botId: BOT });
    send(frame.element, { ccb: "tile", id: 3, component: "status", data: null, size: "1x1", botId: "6A0B0000-0000-4000-8000-0000000000FF" });
    send(frame.element, { ccb: "tile", id: 4, component: "status", data: "x".repeat(TILE_DATA_MAX), size: "1x1", botId: "main" });
    send(frame.element, { ccb: "tile", id: 5, component: "status", data: null, size: "4x4", botId: BOT });
    send(frame.element, { ccb: "tile", id: 6, component: "status", data: null, size: "2x2", botId: BOT });
    await until(() => frame.posted.length === 5);
    expect(frame.posted.slice(1, 4)).toEqual([
      { ccb: "reply", id: 2, ok: false, value: 'No component "nope" in the library.' },
      { ccb: "reply", id: 3, ok: false, value: "No such bot." },
      { ccb: "reply", id: 4, ok: false, value: "The tile's data is too big." },
    ]);
    // The report's 2x2 is allowed, a bigger one is not a request at all.
    expect(frame.posted[4]).toMatchObject({ ccb: "reply", id: 6, ok: true });
    expect(broker.refusals.map((refusal) => refusal.reason)).toEqual(["a message that is not a valid ccb call (tile)"]);
    expect(sent.map((cmd) => cmd.type)).toEqual(["plugins.tileImages", "card.page", "plugins.tileImages", "card.page"]);
  });

  it("an approval: the sheet shows the core's command and folder; only its Allow sends plugins.approve; the frame hears { allowed }", async () => {
    const { frame, sent, approved } = await page();
    await actSend(frame.element, { ccb: "approval", id: 1, botId: BOT, command: PICTURE.command, folder: PICTURE.folder, card: "gitlog" });
    await until(() => document.querySelector(".approval-sheet"));
    expect(sent).toEqual([{ type: "plugins.approvalAsk", name: "botling.whiteboard", botId: BOT, command: PICTURE.command, folder: PICTURE.folder, card: "gitlog" }]);
    const sheet = document.querySelector(".approval-sheet")!;
    expect(sheet.querySelector("#approval-line")?.textContent).toBe("“Whiteboard: gitlog” gets its data by running this command in");
    expect(sheet.querySelector(".approval-folder")?.textContent).toBe(PICTURE.folder);
    expect(sheet.querySelector(".approval-command")?.textContent).toBe(PICTURE.command);
    // While it is open, the frame cannot swap what you read: another ask is answered "not allowed" at once.
    await actSend(frame.element, { ccb: "approval", id: 2, botId: BOT, command: "rm -rf ~", folder: PICTURE.folder });
    await until(() => frame.posted.length === 1);
    expect(frame.posted).toEqual([{ ccb: "reply", id: 2, ok: true, value: { allowed: false } }]);
    expect(document.querySelector(".approval-command")?.textContent).toBe(PICTURE.command);
    expect(approved.size).toBe(0);
    await act(async () => document.querySelector<HTMLButtonElement>(".approval-allow")!.click());
    await until(() => frame.posted.length === 2);
    expect(frame.posted[1]).toEqual({ ccb: "reply", id: 1, ok: true, value: { allowed: true } });
    expect(sent.filter((cmd) => cmd.type === "plugins.approve")).toEqual([{ type: "plugins.approve", name: "botling.whiteboard", botId: BOT, command: PICTURE.command, folder: PICTURE.folder }]);
    for (const cmd of sent) expect(Command.safeParse(cmd).success).toBe(true);
    // Allowed once: asked again, no sheet.
    await actSend(frame.element, { ccb: "approval", id: 3, botId: BOT, command: PICTURE.command, folder: PICTURE.folder });
    await until(() => frame.posted.length === 3);
    expect(frame.posted[2]).toEqual({ ccb: "reply", id: 3, ok: true, value: { allowed: true } });
    expect(document.querySelector(".approval-sheet")).toBeNull();
  });

  it("Cancel allows nothing; a folder that is not the bot's is refused by the core before any sheet", async () => {
    const { frame, sent } = await page();
    await actSend(frame.element, { ccb: "approval", id: 1, botId: BOT, command: PICTURE.command, folder: PICTURE.folder });
    await until(() => document.querySelector(".approval-sheet"));
    await act(async () => document.querySelector<HTMLButtonElement>(".dialog-cancel")!.click());
    await until(() => frame.posted.length === 1);
    expect(frame.posted[0]).toEqual({ ccb: "reply", id: 1, ok: true, value: { allowed: false } });
    await actSend(frame.element, { ccb: "approval", id: 2, botId: BOT, command: "rm -rf /", folder: "/" });
    await until(() => frame.posted.length === 2);
    expect(frame.posted[1]).toEqual({ ccb: "reply", id: 2, ok: false, value: "A plugin's command runs in its bot's folder (/p/site), not /." });
    expect(document.querySelector(".approval-sheet")).toBeNull();
    expect(sent.some((cmd) => cmd.type === "plugins.approve")).toBe(false);
  });
});

describe("hostile frames stay contained", () => {
  let broker: FrameBroker;
  beforeEach(() => { broker = new FrameBroker(window, { name: "test panel broker" }); });
  afterEach(() => { broker.dispose(); document.body.innerHTML = ""; });

  it("a frame cannot approve: no message allows, none names a plugin, a stranger or a frame with an origin is not heard", async () => {
    const core = fakeCore();
    const asks: unknown[] = [];
    const frame = pluginFrame();
    const stranger = pluginFrame();
    registerPluginFrame(broker, pluginFrameHost({ client: core.client, components: () => COMPONENTS, bots: () => BOTS, ask: (view, approve, done) => { asks.push(approve); done(false); } }), { frame: frame.element, plugin: "botling.whiteboard" });
    // Approve-shaped messages: an extra key, a contract command, a plugin of its choosing.
    send(frame.element, { ccb: "approval", id: 1, botId: BOT, command: PICTURE.command, folder: PICTURE.folder, approve: true });
    send(frame.element, { ccb: "approval", id: 2, botId: BOT, command: PICTURE.command, folder: PICTURE.folder, plugin: "other" });
    send(frame.element, { type: "plugins.approve", name: "botling.whiteboard", botId: BOT, ...PICTURE });
    send(frame.element, { ccb: "approve", id: 3, botId: BOT, ...PICTURE });
    // Not registered (a tile inside it posting to the top page), or not sandboxed.
    send(stranger.element, { ccb: "approval", id: 4, botId: BOT, ...PICTURE });
    send(frame.element, { ccb: "approval", id: 5, botId: BOT, ...PICTURE }, "botling-card://page");
    await settle();
    expect(core.sent).toEqual([]);
    expect(asks).toEqual([]);
    expect(frame.posted).toEqual([]);
    expect(broker.refusals.map((refusal) => refusal.reason)).toEqual([
      "a message that is not a valid ccb call (approval)",
      "a message that is not a valid ccb call (approval)",
      "a message that is not a valid ccb call (object)",
      "a message that is not a valid ccb call (approve)",
      "a message from a frame that is not a registered frame",
      "a frame with origin botling-card://page (expected an opaque, sandboxed origin)",
    ]);
    // Its own ask names the plugin the page registered it for, and goes only to the sheet.
    send(frame.element, { ccb: "approval", id: 6, botId: BOT, ...PICTURE });
    await until(() => frame.posted.length === 1);
    expect(core.sent).toEqual([{ type: "plugins.approvalAsk", name: "botling.whiteboard", botId: BOT, ...PICTURE }]);
    expect(asks).toEqual([{ type: "plugins.approve", name: "botling.whiteboard", botId: BOT, ...PICTURE }]);
    expect(frame.posted).toEqual([{ ccb: "reply", id: 6, ok: true, value: { allowed: false } }]);
  });

  it("asks are paced like calls: 20 at once, then refused", async () => {
    const core = fakeCore();
    const frame = pluginFrame();
    registerPluginFrame(broker, pluginFrameHost({ client: core.client, components: () => COMPONENTS, bots: () => BOTS, ask: (_view, _approve, done) => done(false) }), { frame: frame.element, plugin: "botling.whiteboard" });
    for (let id = 1; id <= 25; id++) send(frame.element, { ccb: "tile", id, component: "status", data: null, size: "1x1", botId: BOT });
    await until(() => frame.posted.length === 25);
    expect(frame.posted.filter((reply) => reply.ok)).toHaveLength(20);
    expect(frame.posted.filter((reply) => !reply.ok).map((reply) => reply.value)).toEqual(Array(5).fill("Too many calls; wait a moment."));
  });

  it("the panel page's ccb asks for a tile and an approval; nothing in it can allow", () => {
    const html = panelPage("botling.whiteboard", "board", "export function activate() {}", {});
    expect(html).toContain('tile: (spec) => ask({ ccb: "tile"');
    expect(html).toContain('requestApproval: (req) => ask({ ccb: "approval"');
    expect(html).not.toMatch(/approve/i);
  });

  it("only the app page's sheet sends plugins.approve: no chat page, card frame, main or plugin code names it", () => {
    const root = join(__dirname, "../..");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
    const naming = [...files(join(root, "src/renderer")), ...files(join(root, "src/main")), ...files(join(root, "../Web/src")), ...files(join(root, "../Web/host/src"))]
      .filter((file) => readFileSync(file, "utf8").includes('"plugins.approve"'))
      .map((file) => file.slice(join(root, "..").length + 1)).sort();
    // plugin-frame-host.ts (a frame's ask), App.tsx (a web part's ask in the chat, the component studio's; and the `onAsk` approve of a
    // built-in plugin's `approvalRequest`, botling.board's pinned-card commands) and TakeoverPage.tsx build it only as what the sheet's Allow sends (`ask`); tested above.
    expect(naming).toEqual(["desktop/src/renderer/App.tsx", "desktop/src/renderer/TakeoverPage.tsx", "desktop/src/renderer/plugin-frame-host.ts"]);
    expect(RENDERER_COMMANDS.has("plugins.approve")).toBe(true);
    expect(Command.safeParse({ type: "plugins.approvalAsk", name: "botling.whiteboard", botId: BOT, ...PICTURE, approve: true }).success).toBe(false);
  });

  it("a panel may frame card pages (its tiles) and nothing else; a tile frames nothing further", () => {
    const frameSrc = (csp: string) => csp.split("; ").find((part) => part.startsWith("frame-src"));
    expect(frameSrc(PANEL_CSP)).toBe("frame-src botling-card://preview botling-card://page/");
    expect(frameSrc(COMPONENT_CSP)).toBe("frame-src botling-card://preview");
    expect(PANEL_CSP).toContain("connect-src 'none'");
    expect(PANEL_CSP).toContain("script-src 'unsafe-inline' blob:");
    // Main's navigation rule for a card page inside a panel.
    const kinds: Record<string, "panel" | "component"> = { P1: "panel", P2: "panel", T1: "component" };
    const kind = (token: string) => kinds[token] ?? null;
    const panel = { url: "botling-card://page/P1", childOfApp: true };
    expect(tileNavigation("botling-card://page/T1", panel, true, kind)).toBe(true);
    // Not a tile (another panel), not started by the panel, not inside an app-held panel, inside a tile, or unknown.
    expect(tileNavigation("botling-card://page/P2", panel, true, kind)).toBe(false);
    expect(tileNavigation("botling-card://page/T1", panel, false, kind)).toBe(false);
    expect(tileNavigation("botling-card://page/T1", { ...panel, childOfApp: false }, true, kind)).toBe(false);
    expect(tileNavigation("botling-card://page/T1", { url: "botling-card://page/T1", childOfApp: true }, true, kind)).toBe(false);
    expect(tileNavigation("botling-card://page/XX", panel, true, kind)).toBe(false);
    expect(tileNavigation("botling-card://card/M/0", panel, true, kind)).toBe(false);
    expect(tileNavigation("botling-card://page/T1", null, true, kind)).toBe(false);
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
