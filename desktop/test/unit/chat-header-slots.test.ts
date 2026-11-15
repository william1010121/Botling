// @vitest-environment jsdom
// The chat header's plugin views and the composer bar, from the slots `botling.chat` owns (M7-06b): `chat/header` (2.x `view/chatHeader`)
// and `composer/bar` (2.x `view/composerBar`). The DOM goldens (test/fixtures/chat-header/*.html, *.json) were recorded from the code BEFORE
// the move (UPDATE_CHAT_HEADER_GOLDEN=1 rewrites them, in a change that means to change the page): the header with a popover open, and the
// composer bar in the chat page, compact (the row's frame) and expanded (the card a click opens), and what the app page tells the chat page.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { ChatHeaderViews } from "../../src/renderer/ChatHeaderViews";
import { useComposerBar } from "../../src/renderer/ComposerBar";
import { composerBarFor } from "../../src/renderer/main-tabs";
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
});

// The cases below need the slots; they are added with the change.
beforeEach(() => undefined);
