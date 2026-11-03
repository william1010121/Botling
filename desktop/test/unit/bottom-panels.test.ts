// @vitest-environment jsdom
// The Terminal's key was an app shortcut ("toggleTerminal") and is the botling.terminal plugin's toggle command now: a key the user chose
// moves to the command once, on start; the page knows which command shows a bottom panel; a plugin's push to its frames changes no view.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveShortcutsToPlugins, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import { bottomPanelToggledBy } from "../../src/renderer/BottomPanels";
import type { Client } from "../../src/renderer/client";
import { apply, WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import type { BotView, PluginsView } from "../../src/contract";
import { tempDir } from "../helpers";

const moved = (raw: Record<string, unknown>) => {
  const file = join(tempDir("moved-shortcuts"), "settings.json");
  writeSettings(file, raw);
  moveShortcutsToPlugins(file);
  return readSettings(file);
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("the Terminal's key", () => {
  it("moves from toggleTerminal to the plugin's command, once, and leaves the other keys alone", () => {
    expect(moved({ languageChoice: "en", shortcutBindings: { toggleTerminal: "Mod+T", search: "Mod+L" } }))
      .toEqual({ languageChoice: "en", shortcutBindings: { "botling.terminal.toggle": "Mod+T", search: "Mod+L" } });
  });
  it("lets a key already chosen for the command win, drops a bad one and does nothing when there is nothing to move", () => {
    expect(moved({ shortcutBindings: { toggleTerminal: "Mod+T", "botling.terminal.toggle": "Mod+Alt+J" } })).toEqual({ shortcutBindings: { "botling.terminal.toggle": "Mod+Alt+J" } });
    expect(moved({ shortcutBindings: { toggleTerminal: 42 } })).toEqual({ shortcutBindings: {} });
    const same = { languageChoice: "en", shortcutBindings: { search: "Mod+L" } };
    expect(moved(same)).toEqual(same);
    expect(moved({ languageChoice: "en" })).toEqual({ languageChoice: "en" });
  });
});

describe("bottom panels on the app page", () => {
  const plugins = { bottomPanels: [{ plugin: "botling.terminal", id: "botling.terminal.panel", title: "Terminal", toggle: "botling.terminal.toggle" }, { plugin: "x", id: "x.p", title: "X" }] } as unknown as PluginsView;
  it("finds the panel a command toggles; none for another command, a panel without one or no plugins view", () => {
    expect(bottomPanelToggledBy(plugins, "botling.terminal.toggle")?.id).toBe("botling.terminal.panel");
    expect(bottomPanelToggledBy(plugins, "x.toggle")).toBeNull();
    expect(bottomPanelToggledBy(plugins, "")).toBeNull();
    expect(bottomPanelToggledBy(null, "botling.terminal.toggle")).toBeNull();
  });
  it("a plugin's push to its frames changes nothing in the view", () => {
    const view = { ready: true } as never;
    expect(apply(view, { type: "plugins.emit", plugin: "botling.terminal", name: "terminal", forBot: "B1", data: { type: "data" } } as never)).toBe(view);
  });

  it("a panel's forwarded key runs app shortcuts and its own commands (with from: \"frame\"), never another plugin's command or synthetic window keydown", async () => {
    localStorage.setItem("botling.mainWhiteboard", "0");
    const BOT = "B0000000-0000-4000-8000-000000000001";
    const bot: BotView = { id: BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
    const pluginsView: PluginsView = {
      plugins: [
        { name: "alpha", title: "Alpha", version: "1.0.0", description: null, enabled: true, failure: null, installedFrom: null, permissions: [], parts: ["web", "host"], settings: [], panels: [], commands: [{ id: "alpha.toggle", title: "Toggle Alpha", registered: true }, { id: "alpha.sync", title: "Sync", registered: true }, { id: "alpha.webCmd", title: "Alpha Web", registered: false }] },
        { name: "beta", title: "Beta", version: "1.0.0", description: null, enabled: true, failure: null, installedFrom: null, permissions: [], parts: ["web", "host"], settings: [], panels: [], commands: [{ id: "beta.toggle", title: "Toggle Beta", registered: true }, { id: "beta.secret", title: "Secret", registered: true }, { id: "beta.webCmd", title: "Web", registered: false }] },
      ],
      broken: [], host: { running: true, problem: null }, secretsProblem: null,
      bottomPanels: [
        { plugin: "alpha", id: "alpha.panel", title: "Alpha", toggle: "alpha.toggle" },
        { plugin: "beta", id: "beta.panel", title: "Beta", toggle: "beta.toggle" },
      ],
      keybindings: [
        { command: "alpha.toggle", key: "Mod+J", plugin: "alpha", title: "Toggle Alpha" },
        { command: "alpha.sync", key: "Mod+Shift+9", plugin: "alpha", title: "Sync" },
        { command: "alpha.webCmd", key: "Mod+Shift+5", plugin: "alpha", title: "Alpha Web" },
        { command: "beta.toggle", key: "Mod+Shift+7", plugin: "beta", title: "Toggle Beta" },
        { command: "beta.secret", key: "Mod+Shift+8", plugin: "beta", title: "Secret" },
        { command: "beta.webCmd", key: "Mod+Shift+6", plugin: "beta", title: "Web" },
      ],
    };
    const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
    const view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), plugins: pluginsView, chat: { botId: BOT, messages: [], running: null, live: [], tasks: [] } };
    const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
    const requests: any[] = [];
    const client = {
      request: vi.fn(async (command: any) => {
        requests.push(command);
        if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
        if (command.type === "card.page") return { url: `botling-card://page/${requests.length}` };
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

    const chatPosted: unknown[] = [];
    const chatFrame = host.querySelector<HTMLIFrameElement>("#chat-frame")!;
    chatFrame.contentWindow!.postMessage = ((msg: unknown) => { chatPosted.push(msg); }) as Window["postMessage"];

    // Open plugin alpha's bottom panel so its sandboxed iframe registers with the frame broker.
    const alphaToggle = [...host.querySelectorAll<HTMLButtonElement>(".bottom-toggle")].find((btn) => btn.textContent === "Alpha")!;
    await act(async () => { alphaToggle.click(); });
    await vi.waitFor(() => expect(host.querySelector<HTMLIFrameElement>('[data-plugin="alpha"] iframe.bottom-panel-frame')).not.toBeNull());
    const alphaFrame = host.querySelector<HTMLIFrameElement>('[data-plugin="alpha"] iframe.bottom-panel-frame')!;
    requests.length = 0;
    chatPosted.length = 0;

    const windowKeys: string[] = [];
    const spyKey = (event: KeyboardEvent) => windowKeys.push(event.key);
    window.addEventListener("keydown", spyKey);
    cleanups.push(async () => window.removeEventListener("keydown", spyKey));

    const sendKey = async (key: string, code: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", {
          source: alphaFrame.contentWindow,
          origin: "null",
          data: { ccb: "key", key, code, metaKey: !!mods.metaKey, ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey, shiftKey: !!mods.shiftKey },
        }));
      });
    };

    // 1. Cross-plugin host command, web command, and bottom-panel toggle forged from alpha's frame MUST be blocked.
    await sendKey("8", "Digit8", { metaKey: true, shiftKey: true }); // beta.secret
    await sendKey("6", "Digit6", { metaKey: true, shiftKey: true }); // beta.webCmd
    await sendKey("7", "Digit7", { metaKey: true, shiftKey: true }); // beta.toggle
    expect(requests.filter((r) => r.type === "plugins.command")).toEqual([]);
    expect(chatPosted.filter((m: any) => m?.botling === "runCommand")).toEqual([]);
    expect(host.querySelector('[data-plugin="beta"]')).toBeNull();

    // 2. Alpha's own host command runs with explicit frame attribution (`from: "frame", name: "alpha"`),
    //    and alpha's own web-only command in the chat page runs too.
    await sendKey("9", "Digit9", { metaKey: true, shiftKey: true }); // alpha.sync
    await sendKey("5", "Digit5", { metaKey: true, shiftKey: true }); // alpha.webCmd
    expect(requests.filter((r) => r.type === "plugins.command")).toEqual([
      { type: "plugins.command", id: "alpha.sync", from: "frame", name: "alpha" },
    ]);
    expect(chatPosted.filter((m: any) => m?.botling === "runCommand")).toEqual([
      { botling: "runCommand", id: "alpha.webCmd" },
    ]);

    // 3. App shortcut (Ctrl+Cmd+I -> toggleRightPanel) still works from the panel's frame, without dispatching synthetic window keydowns.
    await sendKey("i", "KeyI", { metaKey: true, ctrlKey: true });
    expect(requests).toContainEqual({ type: "settings.set", change: { key: "rightPanelCollapsed", value: true } });
    expect(windowKeys).toEqual([]);
  });
});
