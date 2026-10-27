// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { WorkspaceStore } from "../../src/renderer/store";
import type { Client } from "../../src/renderer/client";
import type { BotView, Event, SettingsView } from "../../src/contract";
import { CHAT_ORIGIN } from "../../src/renderer/chat-frame/protocol";

it("the actual shell sends no packet for unrelated activity, batches tokens, and sends a full page resync", async () => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
  const other = { ...bot, id: "C", name: "other" };
  const components = { demo: { template: "<p>template-marker</p>", version: 1, updated: false, sizes: ["2x2"], icon: null, title: null } };
  const store = new WorkspaceStore(async () => ({ epoch: "e", seq: 1, bots: [bot, other], imported: null, components, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
    chat: { botId: "B", messages: [{ id: "m", role: "bot", text: "start", time: "2026-10-27T08:00:00Z" }], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [] } }));
  await store.resync();
  let seq = 1;
  const event = (event: Event) => store.receive({ v: 10, epoch: "e", seq: ++seq, event });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    const client = { request: vi.fn(async () => ({ specs: [] })) } as unknown as Client;
    await act(async () => root.render(createElement(App, { client, store })));
    const frame = host.querySelector<HTMLIFrameElement>("#chat-frame")!;
    const posted = vi.spyOn(frame.contentWindow!, "postMessage");
    const action = (type: string) => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: CHAT_ORIGIN, data: { botling: "action", action: { type } } }));
    await act(async () => action("ready"));
    expect(posted.mock.calls.filter(([m]) => m.botling === "state")).toHaveLength(1);
    posted.mockClear();
    await act(async () => {
      event({ type: "bot.updated", bot: { ...other, unread: 7, working: false } });
      event({ type: "turn.delta", botId: "C", turnId: "other", messageId: "x", text: "unrelated" });
    });
    await act(async () => vi.advanceTimersByTime(40));
    expect(posted).not.toHaveBeenCalled();
    // Separate React commits still coalesce before payload conversion/transport.
    for (let i = 0; i < 10; i++) await act(async () => event({ type: "turn.delta", botId: "B", turnId: "t", messageId: "m", text: "x" }));
    expect(posted).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(32));
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][0]).toMatchObject({ botling: "stateDelta", patch: { changed: [{ id: "m", text: "startxxxxxxxxxx" }] } });
    expect(JSON.stringify(posted.mock.calls[0][0])).not.toContain("template-marker");
    posted.mockClear();
    await act(async () => event({ type: "settings.updated", settings: { effectiveLanguage: "ja", messageColumnWidth: 720 } as SettingsView }));
    await act(async () => vi.advanceTimersByTime(32));
    expect(posted.mock.calls[0][0]).toMatchObject({ botling: "stateDelta", patch: { changed: [], base: { lang: "ja" } }, messageColumnWidth: 720 });
    expect(posted.mock.calls[0][0].patch).not.toHaveProperty("components");
    posted.mockClear();
    await act(async () => event({ type: "components.updated", components: { demo: { ...components.demo, version: 2, template: "<p>version-two</p>" } } }));
    await act(async () => vi.advanceTimersByTime(32));
    expect(posted.mock.calls[0][0]).toMatchObject({ botling: "stateDelta", patch: { changed: [], components: { demo: { version: 2, template: "<p>version-two</p>" } } } });
    posted.mockClear();
    await act(async () => action("resync"));
    expect(posted.mock.calls[0][0]).toMatchObject({ botling: "state", state: { components: { demo: { template: "<p>version-two</p>" } } } });
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
