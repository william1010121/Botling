// @vitest-environment jsdom
// The right panel and the bottom panels as slots of the shell (M7-03c). Part 1 (this commit): the DOM of the whole app page with the
// terminal's bottom panel closed and open, recorded from the code BEFORE the two regions moved out of App's legacy surface
// (test/fixtures/shell-side-bottom/*.html). It must stay byte-identical afterwards.
// A missing golden prints its text (SIDE-BOTTOM-GOLDEN-BEGIN … END) and fails; UPDATE_SIDE_BOTTOM_GOLDEN=1 writes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView, PluginsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import { desktop } from "../helpers";

const GOLDEN_DIR = join(desktop, "test", "fixtures", "shell-side-bottom");
const BOT = "B0000000-0000-4000-8000-000000000001";
const bot: BotView = { id: BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const terminalPanel = { plugin: "botling.terminal", id: "botling.terminal.panel", title: "Terminal", toggle: "botling.terminal.toggle" };
const pluginsView = (): PluginsView => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [], bottomPanels: [terminalPanel] }) as unknown as PluginsView;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Mounts App with the terminal's panel row; `.markup()` is the page's HTML with the document's counters written as `:rN:` / `/N`. */
async function mountPage(plugins: PluginsView | null = pluginsView()) {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), plugins, chat: { botId: BOT, messages: [], running: null, live: [] } };
  const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
  let pages = 0;
  const client = {
    request: vi.fn(async (command: any) => {
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: `botling-card://page/${++pages}` };
      if (command.type === "plugins.web") return { specs: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  const unmount = async () => { await act(async () => root.unmount()); element.remove(); };
  cleanups.push(unmount);
  return { element, client, unmount, markup: () => element.innerHTML.replace(/:r[0-9a-z]+:/g, ":rN:").replace(/botling-card:\/\/page\/\d+/g, "botling-card://page/N") };
}

function same(name: string, markup: string) {
  const text = `<!-- ${name} -->\n${markup}\n`;
  const file = join(GOLDEN_DIR, `${name}.html`);
  if (process.env.UPDATE_SIDE_BOTTOM_GOLDEN === "1") { mkdirSync(GOLDEN_DIR, { recursive: true }); writeFileSync(file, text); }
  if (!existsSync(file)) {
    console.log(`SIDE-BOTTOM-GOLDEN-BEGIN ${name}\n${text}SIDE-BOTTOM-GOLDEN-END ${name}`);
    throw new Error(`No golden ${file}`);
  }
  expect(text, `golden ${name}`).toBe(readFileSync(file, "utf8"));
}

const toggleButton = (element: HTMLElement) => element.querySelector<HTMLButtonElement>("button.bottom-toggle")!;
const openTerminal = async (page: Awaited<ReturnType<typeof mountPage>>) => {
  await act(async () => { toggleButton(page.element).click(); });
  await vi.waitFor(() => expect(page.element.querySelector('[data-plugin="botling.terminal"] iframe.bottom-panel-frame')).not.toBeNull());
};

describe("the app page's DOM with the terminal panel, as recorded before the regions moved", () => {
  it("terminal panel closed: the header's toggle, the right panel, no panel section", async () => {
    const page = await mountPage();
    expect(toggleButton(page.element).getAttribute("aria-expanded")).toBe("false");
    expect(page.element.querySelector("section.bottom-panel")).toBeNull();
    expect(page.element.querySelector("aside.detail-panel")).not.toBeNull();
    same("terminal-closed", page.markup());
  });
  it("terminal panel open: the section under the chat with its divider and frame", async () => {
    const page = await mountPage();
    await openTerminal(page);
    const section = page.element.querySelector<HTMLElement>("section.bottom-panel")!;
    expect(section.hidden).toBe(false);
    expect(toggleButton(page.element).getAttribute("aria-expanded")).toBe("true");
    same("terminal-open", page.markup());
  });
  it("terminal panel opened and hidden again: the section stays mounted but hidden", async () => {
    const page = await mountPage();
    await openTerminal(page);
    await act(async () => { toggleButton(page.element).click(); });
    expect(page.element.querySelector<HTMLElement>("section.bottom-panel")!.hidden).toBe(true);
    same("terminal-hidden", page.markup());
  });
  it("no plugins view: no toggle, no panel (the right panel is still drawn)", async () => {
    const page = await mountPage(null);
    expect(page.element.querySelector("button.bottom-toggle")).toBeNull();
    same("no-plugins", page.markup());
  });
});
