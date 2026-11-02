// @vitest-environment jsdom
// The main bot's whiteboard while botling.whiteboard is off (plan W5): the app page's own Whiteboard.tsx still draws it, as before,
// until W6 takes it out; the pure functions and the page's other tests moved with the board to the plugin
// (builtin-plugins/botling.whiteboard/test). With the plugin on, its tab takes the place of this one (main-tab-header.test.ts).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type BotView, type ResultOf, type TaskView, type WaitingView, type WhiteboardView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { Whiteboard } from "../../src/renderer/Whiteboard";
import { tempDir } from "../helpers";

const id = (n: number) => `6A0B0000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const bot = (n: number, name: string, role: BotView["role"], extra: Partial<BotView> = {}): BotView => ({
  id: n === 2 ? MAIN : id(n), name, role, avatar: "circle", folder: "/tmp", phase: "asleep", working: false, approvals: 0, unread: 0, subagents: 0,
  problem: null, heads: ["claude"], job: null, subagentRows: [], ...extra,
});
const task = (taskId: string, name: string, state: TaskView["state"], updatedAt: string, extra: Partial<TaskView> = {}): TaskView => ({
  id: taskId, name, state, owner: null, now: null, next: null, blocked: null, messageIds: [], updatedAt, atWork: false, ...extra,
});

const main = bot(2, "Main bot", "main");
const site = bot(11, "Site", "manager", { lastActivity: new Date().toISOString() });
const paper = bot(12, "Paper", "manager", { lastActivity: new Date().toISOString() });
const bots = [main, site, paper];
const today = new Date().toISOString();
const data: WhiteboardView = { bots: [
  { botId: site.id, currentStatus: ["The theme is live."], inProgress: ["Dark mode"], decided: ["Kept the old URLs"],
    tasks: [task("a", "Ship the theme", "done", today), task("b", "Dark mode", "running", today, { now: "Colours", next: "Test on phones" })],
    results: [], picture: null },
  { botId: paper.id, currentStatus: [], inProgress: [], decided: [], tasks: [], results: [], picture: null },
] };
const waiting: WaitingView = { items: [{ botId: site.id, text: "Publish now?", messageId: null }], doing: {} };

describe("whiteboard page (the app page's own, while botling.whiteboard is off)", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const commands: any[] = [];
  const client = () => {
    let receive: (value: unknown) => void = () => {};
    return new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      commands.push(envelope.cmd);
      const result = envelope.cmd.type === "whiteboard.view" ? data : {};
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
    } });
  };
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; commands.length = 0; });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

  it("still asks the core for the board and draws each bot's card", async () => {
    await act(async () => root.render(createElement(Whiteboard, {
      client: client(), bots, waiting, components: {}, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 0,
      statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
    })));
    expect(commands[0]).toEqual({ type: "whiteboard.view" });
    expect(host.querySelector(`.wb-card[data-bot="${site.id}"] .wb-latest .txt`)?.textContent).toBe("The theme is live.");
    expect(host.querySelector(`.quiet-pill[data-bot="${paper.id}"]`)).not.toBeNull();
  });

  it("is the main bot's default view beside Chat and Board, hiding the chat page while shown; Chat, once picked, is kept", async () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try { localStorage.removeItem("botling.mainWhiteboard"); } catch { /* none */ }
    const { Bot } = await import("../../src/core/bot");
    const { ProcessLedger } = await import("../../src/core/process/ledger");
    const { mainProfile } = await import("../../src/core/store/workspace");
    const { WorkspaceStore } = await import("../../src/renderer/store");
    const { App } = await import("../../src/renderer/App");
    const dir = tempDir("whiteboard-app");
    const profile = mainProfile(dir);
    mkdirSync(profile.storeDir, { recursive: true });
    const owner = new Bot({ profile, deferStartup: true, ledger: new ProcessLedger(join(dir, "ledger.json")), headConfig() { throw new Error("No real CLI"); }, prompts() { throw new Error("No turn"); }, emit() {}, log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
    const snapshot = (): ResultOf<"chat.snapshot"> => ({ epoch: "test", seq: 0, bots: [owner.view(), site], imported: null, chat: owner.snapshot(), components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null } });
    const store = new WorkspaceStore(async () => snapshot());
    await store.resync();
    const switchButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".board-switch button")].find((candidate) => candidate.textContent === name)!;
    // Nothing picked yet: the whiteboard.
    await act(async () => root.render(createElement(App, { client: client(), store })));
    expect(switchButton("Whiteboard").getAttribute("aria-pressed")).toBe("true");
    expect(switchButton("Chat").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".chat-column")?.className).toContain("whiteboard-on");
    expect(host.querySelector(`[data-bot="${site.id}"]`)).not.toBeNull();
    await act(async () => switchButton("Chat").click());
    expect(host.querySelector(".whiteboard")).toBeNull();
    expect(host.querySelector(".chat-column")?.className).not.toContain("whiteboard-on");
    expect(host.querySelector("#chat-frame")).not.toBeNull();
    expect(localStorage.getItem("botling.mainWhiteboard")).toBe("0");
    // Drawn again (the next start): Chat, as picked.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App, { client: client(), store })));
    expect(host.querySelector(".whiteboard")).toBeNull();
    await act(async () => switchButton("Whiteboard").click());
    expect(host.querySelector(".chat-column")?.className).toContain("whiteboard-on");
    expect(localStorage.getItem("botling.mainWhiteboard")).toBe("1");
  });
});
