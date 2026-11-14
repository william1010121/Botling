// @vitest-environment jsdom
// The app's renders must not redraw the native chat (M1 demo bug 1). The app renders again every 30 s (the column's
// clock) and at every event; its chat frame's listener used to be made again each time, and the native chat's
// `subscribe` says "bound" to every new listener, so each render sent the whole chat state again and asked for
// plugins.web again. The newest reply was then drawn again (its playing video back at 0:00), and with Botling 3 the
// oversized plugins.web answer was logged as "cannot send res" every time.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import { Client } from "../../src/renderer/client";
import { WorkspaceStore } from "../../src/renderer/store";
import { editorBridge } from "../../src/preload/editor-bridge";
import { EDITOR_CHANNEL } from "../../src/editor-host-wire";
import { PROTOCOL_VERSION, type BotView, type ResultOf } from "../../src/contract";

const stamp = { surfaceId: "surface", documentGeneration: "document" };

afterEach(() => { delete (window as { botling?: unknown }).botling; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("sends a bound native chat its whole state once, and plugins once, however often the app renders", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const send = vi.fn();
  const bridge = editorBridge({ on: (channel, fn) => listeners.set(channel, fn), send }, "shell");
  Object.defineProperty(window, "botling", { value: { editorHost: bridge }, configurable: true });
  const bot: BotView = { id: "main", name: "Main", role: "main", avatar: "square", folder: "/synthetic", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
  const other: BotView = { ...bot, id: "other", name: "Other", role: "manager" };
  const snapshot: ResultOf<"chat.snapshot"> = {
    epoch: "test", seq: 0, bots: [bot, other], imported: null, settings: settingsView({ railCollapsed: true }),
    chat: { botId: bot.id, messages: [{ id: "r1", role: "bot", text: "Rendered the video: ![demo](file:///synthetic/demo.mp4)", time: "2026-11-14T14:57:00.000Z" }], running: null, live: [], runs: [], heads: null },
    components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
  };
  const store = new WorkspaceStore(async () => snapshot);
  await store.resync();
  const commands: Array<{ type: string }> = [];
  let respond: (message: unknown) => void = () => {};
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(fn) { respond = fn; return () => {}; }, post(envelope: any) {
    commands.push(envelope.cmd);
    queueMicrotask(() => respond({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result: envelope.cmd.type === "plugins.web" ? { specs: [] } : {} }));
  } });
  const fullStates = () => send.mock.calls.filter(([channel, packet]) => channel === EDITOR_CHANNEL.down && packet.message.botling === "state").length;
  const pluginAsks = () => commands.filter((cmd) => cmd.type === "plugins.web").length;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await act(async () => root.render(createElement(App, { client, store })));
    await act(async () => listeners.get(EDITOR_CHANNEL.bound)!({}, stamp));
    await act(async () => { await Promise.resolve(); });
    expect(fullStates()).toBe(1);
    const asked = pluginAsks();
    expect(asked).toBeGreaterThanOrEqual(1);

    // Events that make the app render again without changing this chat: another bot's unread count, then its activity.
    for (let seq = 1; seq <= 6; seq += 1) {
      await act(async () => store.receive({ v: PROTOCOL_VERSION, epoch: "test", seq, event: { type: "bot.updated", bot: { ...other, unread: seq } } }));
    }
    // The column's clock: a render every 30 s.
    for (let tick = 0; tick < 3; tick += 1) await act(async () => { vi.advanceTimersByTime(30_000); });
    await act(async () => { await Promise.resolve(); });

    expect(fullStates()).toBe(1);
    expect(pluginAsks()).toBe(asked);
    // A real new binding (the native chat reloaded) still gets the whole state and the plugins.
    await act(async () => listeners.get(EDITOR_CHANNEL.bound)!({}, { ...stamp, documentGeneration: "document-2" }));
    await act(async () => { await Promise.resolve(); });
    expect(fullStates()).toBe(2);
    expect(pluginAsks()).toBe(asked + 1);
  } finally {
    await act(async () => root.unmount());
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
