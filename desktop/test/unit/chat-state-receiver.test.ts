// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
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

it("preserves the loaded history boundary, frames and draft through desktop deltas and full resync", () => {
  const receive = (message: ShellMessage) => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: APP_ORIGIN, data: message }));
  const historyBot = { ...bot, id: "long-history" };
  let messages = Array.from({ length: 160 }, (_, i) => ({ id: `m${i}`, role: "bot" as const, text: `Reply ${i}`, time: "2026-10-27T08:00:00Z" }));
  const build = (): ChatPacket => {
    const packet = { ...chatState(historyBot, { botId: historyBot.id, running: null, live: [], tasks: [], messages }), libraryVersion: 1, resyncs: 1, messageColumnWidth: null };
    packet.state.components = { card: { template: "<p>kept card</p>", version: 1, working: false, updated: false, hasPrevious: false } };
    packet.state.messages = packet.state.messages.map(message => message.id === "m125" ? { ...message, displays: [{ name: "card", data: "{}", at: null }] } : message);
    return packet;
  };
  const sent: ShellMessage[] = [];
  const channel = new ChatStateChannel(build, message => { sent.push(message); receive(message); });
  const rows = () => document.querySelectorAll("#messages > .row, #messages > .stamped");
  const row = (id: string) => document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  channel.flush();
  expect(rows()).toHaveLength(50);
  expect(row("m110")).not.toBeNull();
  document.querySelector<HTMLButtonElement>(".history-more")!.click();
  expect(rows()).toHaveLength(100);
  const retained = row("m100");
  const frame = row("m125")!.querySelector("iframe");
  expect(frame).not.toBeNull();
  const editor = document.querySelector<HTMLElement>("#composer-slot .cm-editor")!;
  const view = EditorView.findFromDOM(editor)!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "unsent history draft" } });
  messages = [...messages.map(message => message.id === "m10" ? { ...message, text: "hidden delta text" }
    : message.id === "m159" ? { ...message, text: "streamed reply" } : message),
    { id: "m160", role: "bot", text: "new reply", time: "2026-10-27T08:00:00Z" }];
  channel.flush();
  expect(sent.at(-1)?.botling).toBe("stateDelta");
  expect(rows()).toHaveLength(101);
  expect(row("m10")).toBeNull();
  expect(row("m100")).toBe(retained);
  expect(row("m125")!.querySelector("iframe")).toBe(frame);
  expect(row("m159")!.textContent).toContain("streamed reply");
  // Removing the loaded boundary advances to the next mounted row, without shrinking the page.
  messages = messages.filter(message => message.id !== "m60");
  channel.flush();
  expect(rows()).toHaveLength(100);
  expect(rows()[0].getAttribute("data-id")).toBe("m61");
  channel.flush(true);
  expect(sent.at(-1)?.botling).toBe("state");
  expect(rows()).toHaveLength(100);
  expect(row("m100")).toBe(retained);
  expect(row("m125")!.querySelector("iframe")).toBe(frame);
  expect(document.querySelector("#composer-slot .cm-editor")).toBe(editor);
  expect(view.state.doc.toString()).toBe("unsent history draft");
  document.dispatchEvent(new CustomEvent("ccb-reveal-message", { detail: "m10" }));
  expect(row("m10")!.textContent).toContain("hidden delta text");
});

it("cancels queued history loading on a same-bot subagent delta and resets the window after rebind", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; });
  const cancel = vi.fn((id: number) => callbacks.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancel);
  try {
    const receive = (message: ShellMessage) => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: APP_ORIGIN, data: message }));
    const lifecycleBot = { ...bot, id: "history-lifecycle" };
    const packet: ChatPacket = { ...chatState(lifecycleBot, { botId: lifecycleBot.id, running: null, live: [], tasks: [],
      messages: Array.from({ length: 150 }, (_, i) => ({ id: `life${i}`, role: "bot", text: `Reply ${i}`, time: "2026-10-27T08:00:00Z" })) }), libraryVersion: 1, resyncs: 1, messageColumnWidth: null };
    let current = packet;
    const sent: ShellMessage[] = [];
    const channel = new ChatStateChannel(() => current, message => { sent.push(message); receive(message); });
    const rows = () => document.querySelectorAll("#messages > .row, #messages > .stamped");
    channel.flush();
    document.querySelector<HTMLButtonElement>(".history-more")!.click();
    expect(rows()).toHaveLength(100);
    document.getElementById("scroller")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    expect(callbacks.size).toBeGreaterThan(0);
    current = { ...packet, state: { ...packet.state, subagent: { id: "worker-one", title: "Worker", owner: "Main", status: "running", type: null } } };
    channel.flush();
    expect(sent.at(-1)?.botling).toBe("stateDelta");
    expect(cancel).toHaveBeenCalled();
    expect(rows()).toHaveLength(50);
    expect(rows()[0].classList.contains("sub-work")).toBe(true);
    for (const callback of [...callbacks.values()]) callback(0);
    callbacks.clear();
    expect(rows()).toHaveLength(50);
    document.querySelector<HTMLButtonElement>(".history-more")!.click();
    expect(rows()).toHaveLength(100);
    channel.reset();
    current = packet;
    channel.flush();
    expect(sent.at(-1)?.botling).toBe("state");
    expect(rows()).toHaveLength(50);
    expect(rows()[0].classList.contains("sub-work")).toBe(false);
    expect(rows()[0].getAttribute("data-id")).toBe("life100");
  } finally { vi.unstubAllGlobals(); }
});
