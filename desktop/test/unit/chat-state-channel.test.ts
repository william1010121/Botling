import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStateChannel, type ChatPacket } from "../../src/renderer/chat-state-channel";
import { chatState, componentInfos, subagentState } from "../../src/renderer/payload";
import { applyPatch } from "../../../Web/src/patch";
import type { ShellMessage } from "../../src/renderer/chat-frame/protocol";
import type { BotView } from "../../src/contract";

const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const components = { demo: { template: "<p>template-marker</p>", version: 1, updated: false, working: false, hasPrevious: false, sizes: ["2x2"], icon: null, title: null } };
function packet(text = "hello", count = 2): ChatPacket {
  return { ...chatState(bot, { botId: bot.id, running: null, live: [], tasks: [],
    messages: Array.from({ length: count }, (_, i) => ({ id: String(i), role: "bot", text: i === count - 1 ? text : "History ".repeat(40), time: "2026-10-27T08:00:00Z" })) }, new Date("2026-10-27T09:00:00Z"), null, { components }),
    libraryVersion: 1, resyncs: 1, messageColumnWidth: null };
}
afterEach(() => vi.useRealTimers());
describe("chat state channel", () => {
  it("coalesces 20 streamed tokens before building and sends only the changed row, without templates", () => {
    vi.useFakeTimers();
    let current = packet("hello", 500);
    const build = vi.fn(() => current), send = vi.fn();
    const channel = new ChatStateChannel(build, send);
    channel.flush();
    const full = send.mock.calls[0][0] as ShellMessage;
    for (let i = 1; i <= 20; i++) { current = packet("hello" + "x".repeat(i), 500); channel.schedule(); }
    expect(build).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(32);
    expect(build).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    const delta = send.mock.calls[1][0] as Extract<ShellMessage, { botling: "stateDelta" }>;
    expect(delta.botling).toBe("stateDelta");
    expect(delta.patch.changed.map(message => message.id)).toEqual(["499"]);
    expect(delta.patch.changed[0].text).toBe("hello" + "x".repeat(20));
    expect(delta.patch).not.toHaveProperty("components");
    expect(JSON.stringify(delta)).not.toContain("template-marker");
    const fullBytes = Buffer.byteLength(JSON.stringify(full)), deltaBytes = Buffer.byteLength(JSON.stringify(delta));
    expect(deltaBytes).toBeLessThan(fullBytes / 20);
    console.info(`500-message stream: full=${fullBytes} bytes, delta=${deltaBytes} bytes, 20 tokens -> 1 delta`);
    if (full.botling !== "state") throw new Error("Expected full snapshot");
    const applied = applyPatch(full.state, delta.patch)!;
    expect(applied).toEqual(current.state);
    expect(applied.messages[0]).toBe(full.state.messages[0]);
    expect(applied.components).toBe(full.state.components);
  });

  it("sends library changes once, removes/reorders messages, and suppresses identical payloads", () => {
    let current = packet();
    const send = vi.fn(), channel = new ChatStateChannel(() => current, send);
    channel.flush(); channel.flush();
    expect(send).toHaveBeenCalledTimes(1);
    current = { ...packet(), libraryVersion: 2, state: { ...packet().state, components: { ...packet().state.components, demo: { ...packet().state.components.demo, version: 2, template: "new-template" } } } };
    channel.flush();
    expect(send.mock.calls[1][0].patch.components.demo.template).toBe("new-template");
    current = { ...current, state: { ...current.state, messages: [current.state.messages[1]] } };
    channel.flush();
    const delta = send.mock.calls[2][0];
    expect(delta.patch.order).toEqual(["1"]); expect(delta.patch.changed).toEqual([]);
    expect(delta.patch).not.toHaveProperty("components");
    current = { ...current, state: { ...current.state, replyingTo: { id: "1", who: "blog", preview: "hello" }, lang: "ja" }, messageColumnWidth: 800 };
    channel.flush();
    expect(send.mock.calls[3][0]).toMatchObject({ botling: "stateDelta", patch: { base: { lang: "ja", replyingTo: { id: "1" } } }, messageColumnWidth: 800 });
  });

  it("keeps first load, core resync, subagent/chat switches, explicit page resync and rebind complete", () => {
    let current = packet();
    const send = vi.fn(), channel = new ChatStateChannel(() => current, send);
    channel.flush();
    current = { ...current, resyncs: 2 }; channel.flush();
    current = { ...current, ...subagentState(bot, { id: "worker", title: "Worker", prompt: "Do work", owner: "blog", status: "running", type: "agent", steps: [], startedAt: "2026-10-27T08:00:00Z", endedAt: null, model: null, result: null }) }; channel.flush();
    current = packet(); channel.flush();
    channel.flush(true);
    channel.reset(); channel.flush();
    expect(send.mock.calls.map(([message]) => message.botling)).toEqual(Array(6).fill("state"));
    expect(send.mock.calls.at(-1)![0].state.components.demo.template).toContain("template-marker");
  });

  it("cancels queued work on reset and flushes the newest state immediately for resync", () => {
    vi.useFakeTimers();
    let current: ChatPacket | null = packet();
    const send = vi.fn(), channel = new ChatStateChannel(() => current, send);
    channel.schedule(); channel.reset(); vi.advanceTimersByTime(32);
    expect(send).not.toHaveBeenCalled();
    channel.schedule(); channel.flush(true); vi.advanceTimersByTime(32);
    expect(send).toHaveBeenCalledTimes(1);
    current = null; channel.flush(); expect(send).toHaveBeenCalledTimes(1);
  });

  it("reuses converted templates for the same immutable library", () => {
    expect(componentInfos(components)).toBe(componentInfos(components));
    expect(componentInfos({ ...components })).not.toBe(componentInfos(components));
  });
});
