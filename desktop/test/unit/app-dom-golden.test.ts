// @vitest-environment jsdom
// The app page's DOM, recorded before the shell frame went around it (M7-02a): App renders its page inside ShellFrame, as one
// contribution to `app/main`, and the DOM must be byte-identical. The page is drawn with the kernel step-1 fixture view (the
// PluginsView surfaces of test/fixtures/kernel-goldens/view-surfaces.json: main tabs, settings sections, quick settings, right
// panel sections, bottom panels, chat header views, composer bar views, menus), for a manager bot with a chat, and with no bot.
//
// Like the kernel goldens, it changes only in a change that means to change the page: run with UPDATE_APP_DOM_GOLDEN=1 and
// commit the new file with that change. `:r1:`-style React ids are written as `:rN:` (the counter is global to the document).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import type { BotView, PluginsView } from "../../src/contract";
import { desktop } from "../helpers";

const GOLDEN = join(desktop, "test", "fixtures", "app-dom", "app-shell.html");
const BOT = "B0000000-0000-4000-8000-000000000001";
const bot: BotView = { id: BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The fixture view: the step-1 view surfaces as the PluginsView arrays the page reads. */
function fixturePlugins(): PluginsView {
  const surfaces = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "view-surfaces.json"), "utf8")) as Record<string, unknown>;
  return { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [], ...surfaces } as unknown as PluginsView;
}

async function pageMarkup(bots: BotView[], plugins: PluginsView | null): Promise<string> {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const view: WorkspaceView = { ...defaults, ready: true, bots, settings: settingsView({}), plugins, chat: bots[0] ? { botId: bots[0].id, messages: [], running: null, live: [] } : defaults.chat };
  const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
  const client = {
    request: vi.fn(async (command: any) => {
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: "botling-card://page/1" };
      if (command.type === "plugins.web") return { specs: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return host.innerHTML.replace(/:r[0-9a-z]+:/g, ":rN:");
}

/** The page's markup as a golden: the same bytes as the file, or the file is written when UPDATE_APP_DOM_GOLDEN=1. */
function same(name: string, markup: string) {
  const text = `<!-- ${name} -->\n${markup}\n`;
  const file = GOLDEN.replace(/\.html$/, `.${name}.html`);
  if (process.env.UPDATE_APP_DOM_GOLDEN === "1") { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
  if (!existsSync(file)) throw new Error(`No golden ${file}: run with UPDATE_APP_DOM_GOLDEN=1 to record it.`);
  expect(text, `golden ${name}`).toBe(readFileSync(file, "utf8"));
}

describe("the app page's DOM", () => {
  it("is as recorded for a manager bot with the step-1 fixture view", async () => {
    const markup = await pageMarkup([bot], fixturePlugins());
    expect(markup).toContain('class="shell');
    same("bot-fixture", markup);
  });
  it("is as recorded with no bot and no plugins view", async () => {
    same("no-bot", await pageMarkup([], null));
  });
});
