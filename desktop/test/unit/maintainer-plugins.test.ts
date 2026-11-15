// @vitest-environment jsdom
// M5-04h: PluginsPanel "Ask Maintainer" sends chat.send to the bot flagged as Maintainer.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { BotView, PluginStoreView, PluginsView } from "../../src/contract";
import { PluginsPanel } from "../../src/renderer/Plugins";
import type { Client } from "../../src/renderer/client";

const CUSTOM_MAINTAINER = "0F0F0000-0000-4000-8000-000000000022";

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.host.remove();
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("M5-04h: PluginsPanel Ask Maintainer targets flagged Maintainer", () => {
  it("sends chat.send to the Maintainer bot's minted id instead of the 2.x constant", async () => {
    const sent: unknown[] = [];
    const client = {
      request: async (cmd: unknown) => {
        sent.push(cmd);
        return {};
      },
    } as unknown as Client;
    const bots: BotView[] = [
      { id: "0F0F0000-0000-4000-8000-000000000011", name: "Main bot", role: "main", avatar: "circle", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] },
      { id: CUSTOM_MAINTAINER, name: "Maintainer", role: "manager", maintainer: true, avatar: "diamond", folder: "/w/plugins", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] },
    ];
    const plugins: PluginsView = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null };
    const initialStore: PluginStoreView = { url: "", official: true, fetchedAt: null, fromCache: false, error: null, offline: false, loading: false, appVersion: null, entries: [], updates: 0 };

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ host, root });

    await act(async () => {
      root.render(createElement(PluginsPanel, {
        client,
        plugins,
        bots,
        embedded: true,
        initialStore,
        onPanel: () => {},
        onClose: () => {},
      }));
    });

    const textarea = host.querySelector<HTMLTextAreaElement>(".plugins-ask-text")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "Make a status badge");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = host.querySelector<HTMLButtonElement>(".plugins-ask-send")!;
    await act(async () => { send.click(); });

    expect(sent).toContainEqual(expect.objectContaining({
      type: "chat.send",
      botId: CUSTOM_MAINTAINER,
    }));
  });
});
