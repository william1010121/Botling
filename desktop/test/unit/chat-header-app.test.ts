// @vitest-environment jsdom
// The call site in App.tsx (M7-06b review): what App hands `useComposerBar` as the bar's view, and what its header shows, when the
// chat plugin was never touched (the page as before), when `web` is set (no bar), and when the chat plugin was refused (fail closed).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { inPageHost } from "../../src/renderer/shell/inpage-host";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import type { BotView, PluginsView } from "../../src/contract";
import { desktop } from "../helpers";

const seen: ({ id: string } | null)[] = [];
vi.mock("../../src/renderer/ComposerBar", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/renderer/ComposerBar")>();
  return { ...real, useComposerBar: (args: { view: { id: string } | null }) => { seen.push(args.view); } };
});

const BOT = "B0000000-0000-4000-8000-000000000001";
const bot: BotView = { id: BOT, name: "Site", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const plugins = (): PluginsView => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [],
  ...JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "view-surfaces.json"), "utf8")) as Record<string, unknown> }) as unknown as PluginsView;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.clear();
  seen.length = 0;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function page(web: boolean): Promise<HTMLElement> {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), plugins: plugins(), chat: { botId: BOT, messages: [], running: null, live: [] } };
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
  await act(async () => root.render(createElement(App, { client, store, web })));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return host;
}

describe("App's call sites of the chat view slots", () => {
  // Never touched first: the renderer's own host keeps a refusal for good, so the refused case is last in the file.
  it("draws the bar view and the header buttons as before while nothing touched botling.chat", async () => {
    expect(inPageHost.unavailable(CHAT_PLUGIN)).toBe(false);
    const host = await page(false);
    expect(seen.at(-1)).not.toBeNull();
    expect(host.querySelectorAll(".header-view > button").length).toBeGreaterThan(0);
  });

  it("gives the bar no view on the web page", async () => {
    await page(true);
    expect(seen.at(-1)).toBeNull();
  });

  it("gives the bar no view and the header no button while botling.chat is refused (fail closed)", async () => {
    await inPageHost.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(inPageHost.unavailable(CHAT_PLUGIN)).toBe(true);
    const host = await page(false);
    expect(seen.at(-1)).toBeNull();
    expect(host.querySelectorAll(".header-view > button")).toHaveLength(0);
  });
});
