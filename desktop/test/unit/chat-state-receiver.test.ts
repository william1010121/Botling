// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { PluginHost } from "../../../Web/src/plugins";
import { APP_ORIGIN, type ShellMessage } from "../../src/renderer/chat-frame/protocol";
import { ChatStateChannel, type ChatPacket } from "../../src/renderer/chat-state-channel";
import { chatState } from "../../src/renderer/payload";
import type { BotView } from "../../src/contract";

// No OS windows or focus acceptance: exercise the actual desktop receive path and Web DOM.
vi.mock("../../src/renderer/chat-frame/input-focus", () => ({ installInputRecovery: () => () => false }));
const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
beforeAll(async () => {
  document.body.innerHTML = readFileSync("../Web/src/chat.html", "utf8").match(/<body>([\s\S]*)<\/body>/)![1];
  vi.stubGlobal("__LATEX_SOURCE__", "export function activate() {}");
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(PluginHost.prototype, "sync").mockResolvedValue();
  await import("../../src/renderer/chat-frame/entry");
});
it("renders deltas, keeps untouched rows, rejects a missing base, and recovers with a complete resync", () => {
  const receive = (message: ShellMessage) => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: APP_ORIGIN, data: message }));
  const output = vi.spyOn(window.parent, "postMessage");
  let text = "first", deleted = false;
  const build = (): ChatPacket => ({ ...chatState(bot, { botId: bot.id, running: null, live: [], tasks: [],
    messages: [...(deleted ? [] : [{ id: "history", role: "user" as const, text: "Keep this row", time: "2026-10-27T08:00:00Z" }]),
      { id: "live", role: "bot", text, time: "2026-10-27T08:01:00Z", state: "streaming" }] }), libraryVersion: 1, resyncs: 1, messageColumnWidth: null });
  const sent: ShellMessage[] = [];
  const channel = new ChatStateChannel(build, message => { sent.push(message); receive(message); });
  channel.flush();
  const history = document.querySelector('[data-id="history"]');
  expect(history?.textContent).toContain("Keep this row");
  text = "first and streamed"; channel.flush();
  expect(sent.at(-1)?.botling).toBe("stateDelta");
  expect(document.querySelector('[data-id="live"]')?.textContent).toContain(text);
  expect(document.querySelector('[data-id="history"]')).toBe(history);
  expect(document.querySelector<HTMLElement>('[data-id="live"]')?.dataset.state).toBe("streaming");
  deleted = true; channel.flush();
  expect(document.querySelector('[data-id="history"]')).toBeNull();
  const delta = sent.at(-1) as Extract<ShellMessage, { botling: "stateDelta" }>;
  output.mockClear();
  receive({ ...delta, baseRevision: 999, patch: { order: [], changed: [] } });
  expect(output).toHaveBeenCalledWith({ botling: "action", action: { type: "resync" } }, APP_ORIGIN);
  expect(document.querySelector('[data-id="live"]')?.textContent).toContain(text);
  text = "recovered final reply"; channel.flush(true);
  expect(sent.at(-1)?.botling).toBe("state");
  expect(document.querySelector('[data-id="live"]')?.textContent).toContain(text);
  text = "new delta after recovery"; channel.flush();
  expect(document.querySelector('[data-id="live"]')?.textContent).toContain(text);
});
