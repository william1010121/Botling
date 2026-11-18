// @vitest-environment jsdom
// The chat header's plugin views and the composer bar, from the slots `botling.chat` owns (M7-06b): `chat/header` (2.x `view/chatHeader`)
// and `composer/bar` (2.x `view/composerBar`). The DOM goldens (test/fixtures/chat-header/*.html, *.json) were recorded from the code BEFORE
// the move (UPDATE_CHAT_HEADER_GOLDEN=1 rewrites them, in a change that means to change the page): the header with a popover open, and the
// composer bar in the chat page, compact (the row's frame) and expanded (the card a click opens), and what the app page tells the chat page.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import type { Client } from "../../src/renderer/client";
import { ChatHeaderViews } from "../../src/renderer/ChatHeaderViews";
import { useComposerBar, useComposerBarView } from "../../src/renderer/ComposerBar";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { slotViews } from "../../src/renderer/chat-slot";
import { composerBarFor } from "../../src/renderer/main-tabs";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { InPageHost, inPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";

const GOLDENS = join(desktop, "test", "fixtures", "chat-header");
const golden = (name: string, actual: string) => {
  const file = join(GOLDENS, name);
  if (process.env.UPDATE_CHAT_HEADER_GOLDEN === "1" || !existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, actual + "\n"); }
  expect(actual + "\n").toBe(readFileSync(file, "utf8"));
};
const surfaces = (): PluginsView => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [],
  ...JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "view-surfaces.json"), "utf8")) as Record<string, unknown> }) as unknown as PluginsView;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});
const client = (): Client => {
  let pages = 0;
  return {
    request: vi.fn(async (command: any) => {
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: `botling-card://page/${++pages}` };
      if (command.type === "plugins.list") return { plugins: [] }; // Plugins.tsx reads list.plugins for the frame's stamp
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
};
async function mount(node: () => ReturnType<typeof createElement>): Promise<{ host: HTMLElement; rerender: (next: () => ReturnType<typeof createElement>) => Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(node()));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, rerender: (next) => act(async () => root.render(next())) };
}
const markup = (html: string) => html.replace(/:r[0-9a-z]+:/g, ":rN:");

describe("goldens of the code before the move (M7-06b)", () => {
  it("the chat header's plugin views: closed, and with a popover open", async () => {
    const views = surfaces().chatHeaderViews ?? [];
    const { host } = await mount(() => createElement(ChatHeaderViews, { client: client(), views, botId: "B1" }));
    golden("header-closed.html", markup(host.innerHTML));
    await act(async () => { (host.querySelectorAll("button")[0] as HTMLButtonElement).click(); });
    golden("header-popover-open.html", markup(host.innerHTML));
    expect(host.querySelector(".header-view-panel")).not.toBeNull();
    await act(async () => { (host.querySelectorAll("button")[1] as HTMLButtonElement).click(); });
    golden("header-popover-second.html", markup(host.innerHTML));
  });

  it("the composer bar in the chat page: compact (the row's frame), then expanded (the card a click opens)", async () => {
    document.body.innerHTML = `<div id="pin-area"></div>`;
    const { showComposerBar } = await import("../../src/renderer/chat-frame/composer-bar");
    const bar = { plugin: "zed.tools", view: "zed.tools.bar", title: "Zed bar", width: 300, compact: "botling-card://page/1", expanded: "botling-card://page/2" };
    showComposerBar(bar);
    golden("composer-bar-compact.html", document.body.innerHTML);
    (document.querySelector(".composer-bar-open") as HTMLButtonElement).click();
    golden("composer-bar-expanded.html", document.body.innerHTML);
    showComposerBar(null);
    golden("composer-bar-none.html", document.body.innerHTML);
  });

  it("what the app page tells the chat page about the bar: the first view for the bot's role, with both pages made", async () => {
    document.body.innerHTML = `<iframe id="chat-frame"></iframe>`;
    const told: unknown[] = [];
    const chatWindow = (document.getElementById("chat-frame") as HTMLIFrameElement).contentWindow!;
    vi.spyOn(chatWindow, "postMessage").mockImplementation(((message: unknown) => { told.push(message); }) as never);
    const plugins = surfaces();
    const view = composerBarFor(plugins, { role: "main", parent: undefined as never });
    expect(view?.id).toBe("zed.tools.bar");
    const Probe = () => { useComposerBar({ client: client(), view, botId: "B1" }); return null; };
    await mount(() => createElement(Probe));
    await vi.waitFor(() => expect(told.some((message) => (message as { bar?: unknown }).bar)).toBe(true));
    golden("composer-bar-told.json", JSON.stringify(told, null, 1));
  });

  it("is also what a page draws when no shell touched `botling.chat` (a component test, a page without the shell): the views as they are", () => {
    expect(inPageHost.unavailable(CHAT_PLUGIN)).toBe(false);
    const plugins = surfaces();
    expect(slotViews("view/chatHeader", plugins.chatHeaderViews ?? [])).toBe(plugins.chatHeaderViews);
    expect(slotViews("view/composerBar", plugins.composerBarViews ?? [])).toBe(plugins.composerBarViews);
  });
});

// ---- From the slots (M7-06b) ----
const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const chatOnly = { plugins: manifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) };
const hosts: InPageHost[] = [];
async function chatUp(): Promise<InPageHost> {
  const made = new InPageHost({ manifest: chatOnly, log: () => undefined });
  hosts.push(made);
  await made.start();
  return made;
}
const full = surfaces;
const without = (view: PluginsView, plugin: string): PluginsView => ({
  ...view,
  chatHeaderViews: (view.chatHeaderViews ?? []).filter((row) => row.plugin !== plugin),
  composerBarViews: (view.composerBarViews ?? []).filter((row) => row.plugin !== plugin),
});
/** Waits until the feed has put the view's header and bar rows in the kernel. */
/** Waits inside `act`, for a redraw the slots cause while a component is mounted. */
const settle = (check: () => void) => act(async () => { await vi.waitFor(check); });
const fed = (header: number, bar: number) => vi.waitFor(() => {
  expect(rendererKernel.entries("chat/header")).toHaveLength(header);
  expect(rendererKernel.entries("composer/bar")).toHaveLength(bar);
});
const buttons = (host: HTMLElement) => [...host.querySelectorAll(".header-view > button")].map((button) => button.textContent);
const headerNode = (views: PluginsView["chatHeaderViews"]) => () => createElement(ChatHeaderViews, { client: client(), views: views ?? [], botId: "B1" });
const MAIN = { role: "main", parent: undefined as never } as const;
const Bar = ({ plugins, bot }: { plugins: PluginsView | null; bot: typeof MAIN | null }) => {
  useComposerBar({ client: client(), view: useComposerBarView(plugins, bot), botId: "B1" });
  return null;
};

describe("the header's plugin views come from the chat/header slot", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const one of hosts.splice(0)) await one.stop();
    await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
    reconcileView(null);
    await inPageHost.stop();
  });

  it("draws the same DOM as the code before the move (the three goldens), with the slot's rows", async () => {
    await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    const { host } = await mount(headerNode(view.chatHeaderViews));
    golden("header-closed.html", markup(host.innerHTML));
    await act(async () => { (host.querySelectorAll("button")[0] as HTMLButtonElement).click(); });
    golden("header-popover-open.html", markup(host.innerHTML));
    await act(async () => { (host.querySelectorAll("button")[1] as HTMLButtonElement).click(); });
    golden("header-popover-second.html", markup(host.innerHTML));
  });

  it("owns the rows by either slot name: the feed's rows are the view's, in order", async () => {
    await chatUp();
    reconcileView(full());
    await fed(2, 1);
    expect(rendererKernel.slotOwner("chat/header")).toBe(CHAT_PLUGIN);
    expect(rendererKernel.slotOwner("view/chatHeader")).toBe(CHAT_PLUGIN);
    expect(rendererKernel.entries<{ row?: { id: string } }>("view/chatHeader").map(({ entry }) => entry.row?.id).sort()).toEqual(["botling.routines.panel", "zed.tools.header"]);
    expect(slotViews("view/chatHeader", full().chatHeaderViews ?? [])).toEqual(full().chatHeaderViews);
  });

  it("draws a row only while the slot holds it AND the view has it: nothing early, nothing stale", async () => {
    await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    const late = { plugin: "late.one", id: "late.one.panel", title: "Late" };
    const { host, rerender } = await mount(headerNode([...(view.chatHeaderViews ?? []), late]));
    expect(buttons(host)).toEqual(["Routines", "Zed header"]);
    // The slot still holds Zed's row, the view (the prop) dropped it.
    await rerender(headerNode((view.chatHeaderViews ?? []).filter((row) => row.plugin !== "zed.tools")));
    expect(buttons(host)).toEqual(["Routines"]);
  });

  it("keeps the view's order, not the slot's (the feed loads plugins in its own order: here Zed's rows come first)", async () => {
    await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    expect(rendererKernel.entries<{ row?: { plugin: string } }>("view/chatHeader").map(({ entry }) => entry.row?.plugin)).toEqual(["zed.tools", "botling.routines"]);
    expect((slotViews("view/chatHeader", view.chatHeaderViews ?? [])).map((row) => row.plugin)).toEqual(["botling.routines", "zed.tools"]);
  });

  it("draws again by itself when the owner goes away and comes back (no new props)", async () => {
    const one = await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    const { host } = await mount(headerNode(view.chatHeaderViews));
    expect(buttons(host)).toEqual(["Routines", "Zed header"]);
    // The feed drops Zed's plugin: the slot loses the row, the component's props do not change.
    reconcileView(without(view, "zed.tools"));
    await settle(() => { expect(rendererKernel.entries("chat/header")).toHaveLength(1); });
    await settle(() => { expect(buttons(host)).toEqual(["Routines"]); });
    reconcileView(view);
    await settle(() => { expect(buttons(host)).toEqual(["Routines", "Zed header"]); });
    expect(one.unavailable(CHAT_PLUGIN)).toBe(false);
  });

  it("closes the popover of a row that leaves the slot, and does not open it again when the row returns", async () => {
    await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    const { host } = await mount(headerNode(view.chatHeaderViews));
    await act(async () => { (host.querySelectorAll("button")[1] as HTMLButtonElement).click(); });
    expect(host.querySelector(".header-view-panel")?.getAttribute("aria-label")).toBe("Zed header");
    reconcileView(without(view, "zed.tools"));
    await settle(() => { expect(host.querySelector(".header-view-panel")).toBeNull(); });
    reconcileView(view);
    await settle(() => { expect(buttons(host)).toEqual(["Routines", "Zed header"]); });
    expect(host.querySelector(".header-view-panel")).toBeNull();
  });
});

describe("the composer bar's view comes from the composer/bar slot", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const one of hosts.splice(0)) await one.stop();
    await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
    reconcileView(null);
    await inPageHost.stop();
  });
  const bar = (plugin: string, id: string, forRole: "main" | "project" | "bots" | "any" = "any") => ({ plugin, id, title: id, width: 200, forRole });
  const two = (): PluginsView => ({ ...full(), composerBarViews: [bar("first.one", "first.bar"), bar("second.one", "second.bar")] });
  let picked: unknown;
  const Pick = ({ plugins, bot }: { plugins: PluginsView | null; bot: typeof MAIN | null }) => { picked = useComposerBarView(plugins, bot); return null; };
  const pick = async (plugins: PluginsView | null, bot: typeof MAIN | null = MAIN) => {
    await mount(() => createElement(Pick, { plugins, bot }));
    return (picked as { id?: string } | null)?.id ?? null;
  };

  it("shows the first one only (first for the bot's role), as before, when the slot holds every row", async () => {
    await chatUp();
    const view = two();
    reconcileView(view);
    await fed(2, 2);
    expect(await pick(view)).toBe("first.bar");
    expect(composerBarFor(view, MAIN)?.id).toBe("first.bar");
  });

  it("picks the first among the rows the slot holds, not among the view's", async () => {
    await chatUp();
    const view = two();
    reconcileView({ ...view, composerBarViews: [view.composerBarViews![1]!] });
    await fed(2, 1);
    expect(composerBarFor(view, MAIN)?.id).toBe("first.bar");
    expect(await pick(view)).toBe("second.bar");
  });

  it("still filters by the bot's role, and gives none for no bot", async () => {
    await chatUp();
    const view: PluginsView = { ...full(), composerBarViews: [bar("first.one", "project.bar", "project"), bar("second.one", "main.bar", "main")] };
    reconcileView(view);
    await fed(2, 2);
    expect(await pick(view)).toBe("main.bar");
    expect(await pick(view, null)).toBeNull();
  });

  it("tells the chat page what it told before the move (the golden), and nothing when the slot lost the row", async () => {
    await chatUp();
    const view = full();
    reconcileView(view);
    await fed(2, 1);
    document.body.innerHTML = `<iframe id="chat-frame"></iframe>`;
    const told: { bar?: unknown }[] = [];
    vi.spyOn((document.getElementById("chat-frame") as HTMLIFrameElement).contentWindow!, "postMessage").mockImplementation(((message: { bar?: unknown }) => { told.push(message); }) as never);
    const { rerender } = await mount(() => createElement(Bar, { plugins: view, bot: MAIN }));
    await settle(() => expect(told.some((message) => message.bar)).toBe(true));
    golden("composer-bar-told.json", JSON.stringify(told, null, 1));
    told.length = 0;
    reconcileView(without(view, "zed.tools"));
    await settle(() => { expect(rendererKernel.entries("composer/bar")).toHaveLength(0); });
    await rerender(() => createElement(Bar, { plugins: view, bot: MAIN }));
    await settle(() => { expect(told.at(-1)).toEqual({ botling: "composerBar", bar: null }); });
  });

  // Last in the file: the renderer's own host keeps a refusal (`unavailable`) for good, which the "never touched" cases above must not see.
  it("shows none while the chat plugin was refused (fail closed; the chat itself still works)", async () => {
    await inPageHost.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(inPageHost.unavailable(CHAT_PLUGIN)).toBe(true);
    expect(await pick(two())).toBeNull();
    const { host } = await mount(headerNode(full().chatHeaderViews));
    expect(host.innerHTML).toBe("");
  });
});

describe("the page asks the slots", () => {
  it("App draws the bar's view through useComposerBarView and the header through ChatHeaderViews (which reads the slot)", () => {
    const app = readFileSync(join(desktop, "src", "renderer", "App.tsx"), "utf8");
    expect(app).toContain("view: useComposerBarView(view.plugins, bot && !web ? bot : null)");
    expect(app).not.toContain("composerBarFor(");
    expect(app).toContain("<ChatHeaderViews client={client} views={view.plugins?.chatHeaderViews ?? []}");
    expect(readFileSync(join(desktop, "src", "renderer", "ChatHeaderViews.tsx"), "utf8")).toContain('slotViews("view/chatHeader"');
    expect(readFileSync(join(desktop, "src", "renderer", "ComposerBar.ts"), "utf8")).toContain('slotViews("view/composerBar"');
  });
});
