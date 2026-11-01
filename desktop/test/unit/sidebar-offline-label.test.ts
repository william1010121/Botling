// @vitest-environment jsdom
// Real Bot -> contract -> store -> App callbacks, with no CLI or windows.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { BotView, EventEnvelope, PROTOCOL_VERSION, type Event, type ResultOf } from "../../src/contract";
import { Bot } from "../../src/core/bot";
import { ClaudeHead } from "../../src/core/agent/head";
import { parseLine, type StreamItem } from "../../src/core/agent/stream";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { settingsView } from "../../src/core/settings";
import { App, BotRow } from "../../src/renderer/App";
import { SubagentRows } from "../../src/renderer/Rail";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore } from "../../src/renderer/store";
import { tempDir } from "../helpers";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); vi.restoreAllMocks(); });
const connection = (bot: Bot) => (bot.view() as { connection?: string | null }).connection ?? null;
function harness() {
  const dir = tempDir("sidebar-offline-label");
  const events: Event[] = [];
  let forward = (_event: Event) => {};
  const bot = new Bot({ profile: mainProfile(dir), deferStartup: true, welcome: false,
    ledger: new ProcessLedger(join(dir, "ledger.json")), headConfig() { throw new Error("No real CLI"); },
    codexConfig() { throw new Error("No real CLI"); },
    prompts() { throw new Error("No real turn launch"); }, emit(event) { events.push(event); forward(event); }, log() {},
    approvalTimeoutMs: 60_000, idleMs: 60_000, interruptGraceMs: 10,
  });
  const head = new ClaudeHead({ command: process.execPath, cwd: dir, sessionId: "test", resume: false, allowedTools: [] }, { onItem() {}, onExit() {} });
  (bot as any).head = head; head.running = true;
  vi.spyOn(head, "send").mockImplementation(() => {});
  cleanup.push(async () => { head.running = false; (bot as any).head = null; await bot.shutdown({ tidy: false }); });
  const feed = (...items: StreamItem[]) => { for (const item of items) (bot as any).onItem(head, item); };
  const retry = () => feed(...parseLine(JSON.stringify({ type: "system", subtype: "api_retry", error_status: null, error: "connection_error" })));
  const row = () => renderToStaticMarkup(createElement(BotRow, { bot: BotView.parse(bot.view()), selected: false, onSelect() {}, look: "original", waiting: false }));
  return { bot, head, events, feed, retry, row, forward(fn: (event: Event) => void) { forward = fn; } };
}

describe("sidebar network status (1.x Workspace+Components / RailStrip)", () => {
  it("publishes retries immediately, retaining them through rate limits until actual progress", () => {
    const h = harness(); h.retry();
    expect(connection(h.bot)).toBe("retrying");
    expect(h.events.at(-1)).toMatchObject({ type: "bot.updated", bot: { connection: "retrying" } });
    expect(h.row()).toContain("網路中斷，重試中…");
    h.feed({ kind: "rateLimits", engine: "claude", limits: {} });
    expect(connection(h.bot)).toBe("retrying");
    h.feed({ kind: "delta", text: "Back" });
    expect(connection(h.bot)).toBeNull();
    expect(h.row()).not.toContain("網路中斷");
    expect(h.events.filter(e => e.type === "bot.updated").at(-1)).toMatchObject({ bot: { connection: null } });
  });

  it("keeps a failed turn disconnected until network restoration, then clears the label", () => {
    const h = harness(); (h.bot as any).backgroundTurn(h.head); h.retry();
    h.feed({ kind: "connectionLost", parent: null }, { kind: "result", ok: false, text: "API Error: Connection error.", error: "API Error: Connection error.", subtype: "error_during_execution" });
    expect(connection(h.bot)).toBe("disconnected");
    expect(h.row()).toContain("網路中斷"); expect(h.row()).not.toContain("重試中");
    h.feed({ kind: "init", sessionId: "test" });
    expect(connection(h.bot)).toBe("disconnected");
    h.bot.networkRestored();
    expect(connection(h.bot)).toBeNull(); expect(h.row()).not.toContain("網路中斷");
    expect(h.head.send).toHaveBeenCalled();
  });

  it("labels a network-exited sleeping bot and clears a retry after a normal exit", () => {
    const h = harness(); h.retry(); h.head.running = false;
    (h.bot as any).onExit(h.head, { code: 1, signal: null, stderr: "API Error: Connection refused (ECONNREFUSED)", expected: false });
    expect(h.bot.view().phase).toBe("asleep"); expect(connection(h.bot)).toBe("disconnected");
    expect(h.row()).toContain("網路中斷");
    const normal = harness(); normal.retry(); normal.head.running = false;
    (normal.bot as any).onExit(normal.head, { code: 0, signal: null, stderr: "", expected: true });
    expect(connection(normal.bot)).toBeNull(); expect(normal.row()).not.toContain("網路中斷");
  });

  it("does not label HTTP overload or certificate errors as a lost network", () => {
    const h = harness();
    h.feed(...parseLine(JSON.stringify({ type: "system", subtype: "api_retry", error_status: 529, error: "overloaded" })));
    expect(connection(h.bot)).toBeNull(); h.head.running = false;
    (h.bot as any).onExit(h.head, { code: 1, signal: null, stderr: "API Error: SSL certificate problem: network", expected: false });
    expect(connection(h.bot)).toBeNull(); expect(h.row()).not.toContain("網路中斷");
  });

  it("labels only the subagent cut off by the network and removes its label on recovery", () => {
    const h = harness();
    for (const id of ["cut-off", "other"]) h.bot.subagents.list.push({ id, description: id, prompt: "Research", status: "running", background: true, startedAt: Date.now(), steps: [] });
    const rows = () => renderToStaticMarkup(createElement(SubagentRows, { bot: BotView.parse(h.bot.view()), now: Date.now(), watching: null, onOpen() {}, onSettle() {} }));
    h.feed({ kind: "connectionLost", parent: "cut-off" }, { kind: "subagentEnded", id: "cut-off", status: "failed", summary: "API Error: Connection error." });
    expect((h.bot.view().subagentRows.find(row => row.id === "cut-off") as any).waitingForNetwork).toBe(true);
    const container = document.createElement("div"); container.innerHTML = rows();
    expect(container.querySelector('[data-subagent="cut-off"]')?.textContent).toContain("網路中斷");
    expect(container.querySelector('[data-subagent="other"]')?.textContent).not.toContain("網路中斷");
    h.bot.networkRestored();
    expect(rows()).not.toContain("網路中斷");
  });

  it("mirrors a partner head's retry and recovery into the shared sidebar row", () => {
    const h = harness();
    const partner = (h.bot as any).makePartner("codex") as Bot;
    // Only callbacks are replayed; neither head starts an external process.
    (partner as any).head = h.head;
    (partner as any).onItem(h.head, { kind: "connectionTrouble" });
    expect(connection(h.bot)).toBe("retrying");
    expect(h.events.at(-1)).toMatchObject({ type: "bot.updated", bot: { id: h.bot.id, connection: "retrying" } });
    (partner as any).onItem(h.head, { kind: "init", sessionId: "test" });
    expect(connection(h.bot)).toBeNull();
    expect(h.events.filter(e => e.type === "bot.updated").at(-1)).toMatchObject({ bot: { connection: null } });
  });

  it("updates the folded sidebar's mark, accessible label and hover text through real wire events", async () => {
    const h = harness();
    const snapshot = (): ResultOf<"chat.snapshot"> => ({ epoch: "test", seq: 0, bots: [h.bot.view()], imported: null,
      chat: h.bot.snapshot(), components: {}, settings: settingsView({ railCollapsed: true }),
      plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
    });
    const store = new WorkspaceStore(async () => snapshot()); await store.resync();
    let seq = 0;
    h.forward(event => store.receive(EventEnvelope.parse({ v: PROTOCOL_VERSION, epoch: "test", seq: ++seq, event })));
    const client = { request: vi.fn(async () => ({})) } as unknown as Client;
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    cleanup.push(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
    await act(async () => root.render(createElement(App, { client, store })));
    await act(async () => h.retry());
    const button = () => host.querySelector<HTMLButtonElement>(`.strip-bot[data-bot="${h.bot.id}"]`)!;
    expect(button().getAttribute("aria-label")).toContain("網路中斷，重試中…");
    expect(button().querySelector(".strip-disconnected")?.textContent).toBe("!");
    await act(async () => button().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(host.querySelector('.strip-peek')?.textContent).toContain("網路中斷，重試中…");
    await act(async () => h.feed({ kind: "delta", text: "Back" }));
    expect(button().querySelector(".strip-disconnected")).toBeNull();
    expect(button().getAttribute("aria-label")).not.toContain("網路中斷");
    expect(host.querySelector('.strip-peek')?.textContent).not.toContain("網路中斷");
  });
});
