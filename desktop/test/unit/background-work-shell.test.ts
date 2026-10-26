// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import { CHAT_ORIGIN } from "../../src/renderer/chat-frame/protocol";
import type { BotView } from "../../src/contract";

it("requests core output for every chip kind and drops a reply after changing chats", async () => {
  const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  let view: WorkspaceView = { ...defaults, ready: true, bots: [bot], chat: { botId: bot.id, messages: [], running: null, live: [], tasks: [] } };
  const listeners = new Set<() => void>();
  const store = { getView: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as WorkspaceStore;
  const pending: ((value: { text: string }) => void)[] = [];
  const request = vi.fn((cmd: { type: string }) => cmd.type === "task.output"
    ? new Promise<{ text: string }>((resolve) => pending.push(resolve)) : Promise.resolve({ specs: [] }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement(App, { client: { request } as unknown as Client, store })));
    const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame).not.toBeNull();
    const posted = vi.spyOn(frame.contentWindow!, "postMessage");
    for (const kind of ["command", "agent", "monitor", "wakeup", "cron"]) {
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow, origin: CHAT_ORIGIN,
        data: { botling: "action", action: { type: "taskOutput", messageID: "origin", taskID: kind } },
      })));
      expect(request).toHaveBeenLastCalledWith({ type: "task.output", botId: "B", messageId: "origin", taskId: kind });
      await act(async () => pending.shift()!({ text: `${kind} output` }));
      expect(posted).toHaveBeenLastCalledWith({ botling: "taskOutput", botID: "B", messageID: "origin", taskID: kind, text: `${kind} output` }, CHAT_ORIGIN);
    }
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: CHAT_ORIGIN,
      data: { botling: "action", action: { type: "taskOutput", messageID: "origin", taskID: "late" } } }));
    await act(async () => { view = { ...view, chat: { ...view.chat!, botId: "C" } }; listeners.forEach((listener) => listener()); });
    posted.mockClear();
    await act(async () => pending.shift()!({ text: "Previous chat's output" }));
    expect(posted).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
