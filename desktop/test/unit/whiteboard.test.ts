// @vitest-environment jsdom
// The main bot's whiteboard (Whiteboard.tsx): cards grouped by group chat, then projects and bots;
// a card's highlight, waiting count and task bar from the bots' own data; pressed, the report with
// only the parts that have something in them; and the main bot's Chat / Board / Whiteboard switch.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type BotView, type ResultOf, type TaskView, type WaitingView, type WhiteboardView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { INACTIVE_AFTER_MS, Whiteboard, doneByDay, highlight, isInactive, lastActive, nextSteps, shownSections, taskCounts, waitingCount, whiteboardSections } from "../../src/renderer/Whiteboard";
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
const news = bot(13, "News", "bot", { job: "Morning news", lastActivity: new Date().toISOString() });
const group = bot(20, "Writing", "group", { members: [paper.id] });
const bots = [main, site, paper, news, group];
const today = new Date().toISOString();
const data: WhiteboardView = { bots: [
  { botId: site.id, currentStatus: ["The theme is live."], inProgress: ["Dark mode"], decided: ["Kept the old URLs"],
    tasks: [task("a", "Ship the theme", "done", today), task("b", "Dark mode", "running", today, { now: "Colours", next: "Test on phones" }), task("c", "Pick a domain", "waiting", today, { blocked: "Which domain?" })],
    results: [{ label: "Theme preview", url: "https://example.com/theme" }], picture: null },
  { botId: paper.id, currentStatus: [], inProgress: [], decided: [], tasks: [], results: [], picture: null },
  { botId: news.id, currentStatus: [], inProgress: [], decided: [], tasks: [], results: [], picture: null },
] };
const display = (extra: Record<string, unknown>) => ({ name: "status", data: '{"ok":true}', at: null, command: null, folder: null, detail: null, card: "whiteboard", status: null, error: null, ranAt: null, images: null, pinned: null, every: null, size: "1x1", ...extra }) as any;
const components = { status: { template: '<div class="card" id="s"></div>', version: 1, updated: false, sizes: ["2x1"], icon: null, title: "Status card" } };
const waiting: WaitingView = { items: [{ botId: site.id, text: "Publish now?", messageId: null }], doing: {} };

describe("whiteboard data", () => {
  it("groups a group chat's members first, then projects, then bots; no card for the main bot or the group", () => {
    expect(whiteboardSections(bots).map((section) => [section.title, section.bots.map((entry) => entry.name)])).toEqual([["Writing", ["Paper"]], ["Projects", ["Site"]], ["Bots", ["News"]]]);
  });
  it("takes the highlight from the bot's own words and counts what waits on you", () => {
    expect(highlight(site, data.bots[0], waiting)).toBe("The theme is live.");
    expect(highlight(news, data.bots[2], waiting)).toBe("Morning news");
    expect(highlight(paper, data.bots[1], waiting)).toBeNull();
    expect(waitingCount(site, waiting, data.bots[0])).toBe(2); // Its question and its task waiting on you.
    expect(taskCounts(data.bots[0]!.tasks)).toEqual({ waiting: 1, active: 1, done: 1, total: 3 });
    expect(nextSteps(data.bots[0]!)).toEqual(["Dark mode", "Test on phones"]);
    const days = doneByDay(data.bots[0]!.tasks, Date.now());
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ day: "Today", count: 1 });
  });
});

describe("whiteboard: bots gone quiet", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const old = "2026-10-23T09:00:00Z";
  const recent = new Date(now - 3 * 3_600_000).toISOString();
  const none: WaitingView = { items: [], doing: {} };
  const empty = (botId: string, tasks: TaskView[] = []) => ({ botId, currentStatus: [], inProgress: [], decided: [], tasks, results: [], picture: null });
  const stale = bot(31, "Stale", "bot", { lastActivity: old });
  const fresh = bot(32, "Fresh", "bot", { lastActivity: recent });
  const asking = bot(33, "Asking", "bot", { lastActivity: old });
  const busy = bot(34, "Busy", "bot", { lastActivity: old, working: true });
  const helped = bot(35, "Helped", "bot", { lastActivity: old, subagents: 1 });
  const approving = bot(36, "Approving", "bot", { lastActivity: old, approvals: 1 });
  const pinnedBot = bot(37, "Pinned", "bot", { lastActivity: old });
  const taskNews = bot(38, "TaskNews", "bot", { lastActivity: old });
  const silent = bot(39, "Silent", "bot", { lastActivity: null });
  const asks: WaitingView = { items: [{ botId: asking.id, text: "Which one?", messageId: null }], doing: {} };

  it("waits 48 hours, counting a task card's change as activity", () => {
    expect(INACTIVE_AFTER_MS).toBe(48 * 3_600_000);
    expect(lastActive(stale, undefined)).toBe(Date.parse(old));
    expect(lastActive(taskNews, empty(taskNews.id, [task("t", "Draft", "done", recent)]))).toBe(Date.parse(recent));
    expect(lastActive(silent, undefined)).toBeNull();
  });

  it("hides a bot quiet for 48 hours with nothing waiting and nothing running; keeps waiting, working, recent and pinned ones", () => {
    const pins = new Set([pinnedBot.id]);
    const hidden = (entry: BotView, waitingView = none, data = empty(entry.id)) => isInactive(entry, data, waitingView, now, pins);
    expect(hidden(stale)).toBe(true);
    expect(hidden(silent)).toBe(true);
    expect(hidden(fresh)).toBe(false);
    expect(hidden(asking, asks)).toBe(false);
    expect(hidden(busy)).toBe(false);
    expect(hidden(helped)).toBe(false);
    expect(hidden(approving)).toBe(false);
    expect(hidden(pinnedBot)).toBe(false);
    expect(hidden(taskNews, none, empty(taskNews.id, [task("t", "Draft", "done", recent)]))).toBe(false);
    expect(hidden(stale, none, empty(stale.id, [task("w", "Pick", "waiting", old)]))).toBe(false);
    expect(hidden(stale, none, empty(stale.id, [task("r", "Build", "running", old, { atWork: true })]))).toBe(false);
    // Exactly at the line: still shown.
    expect(isInactive(bot(40, "Edge", "bot", { lastActivity: new Date(now - INACTIVE_AFTER_MS).toISOString() }), undefined, none, now, new Set())).toBe(false);
  });

  it("leaves out sections with no card shown and counts what it hid", () => {
    const sections = whiteboardSections([main, stale, fresh, bot(41, "Old project", "manager", { lastActivity: old })]);
    const result = shownSections(sections, (entry) => entry.lastActivity === old);
    expect(result.hidden).toBe(2);
    expect(result.sections.map((section) => [section.title, section.bots.map((entry) => entry.name)])).toEqual([["Bots", ["Fresh"]]]);
  });

  describe("on the page", () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
    const quietClient = () => {
      let receive: (value: unknown) => void = () => {};
      return new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
        const result = envelope.cmd.type === "whiteboard.view" ? { bots: [] } : {};
        queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
      } });
    };
    const render = (lang?: string) => act(async () => root.render(createElement(Whiteboard, {
      client: quietClient(), bots: [main, stale, fresh, asking, busy, pinnedBot, silent], waiting: asks, components: {}, look: "original", now, mainMessages: [], mainBotId: MAIN, refreshMs: 0,
      pinned: [pinnedBot.id], lang: lang as any, statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
    })));
    const shownNames = () => [...host.querySelectorAll(".wb-card .wb-card-name")].map((name) => name.textContent);

    it("shows only the active bots, counts only them, and the toggle at the end reveals the rest", async () => {
      await render();
      expect(shownNames()).toEqual(["Fresh", "Asking", "Busy", "Pinned"]);
      expect(host.querySelector(".wb-bar-count")?.textContent).toBe("4 bots · 0 tasks · 1 waiting on you");
      const toggle = host.querySelector<HTMLButtonElement>(".wb-inactive-toggle")!;
      expect(toggle.textContent).toBe("Show 2 inactive");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelector(".wb-sections")!.lastElementChild).toBe(toggle.parentElement);
      await act(async () => toggle.click());
      expect(shownNames()).toEqual(["Stale", "Fresh", "Asking", "Busy", "Pinned", "Silent"]);
      expect(host.querySelector(".wb-bar-count")?.textContent).toBe("6 bots · 0 tasks · 1 waiting on you");
      expect(toggle.textContent).toBe("Hide inactive");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await act(async () => toggle.click());
      expect(shownNames()).toHaveLength(4);
    });

    it("says the toggle in the app's language", async () => {
      await render("zh-Hant");
      expect(host.querySelector(".wb-inactive-toggle")?.textContent).toBe("顯示 2 個不活躍的");
    });

    it("has no toggle when nothing is hidden", async () => {
      await act(async () => root.render(createElement(Whiteboard, {
        client: quietClient(), bots: [main, fresh], waiting: none, components: {}, look: "original", now, mainMessages: [], mainBotId: MAIN, refreshMs: 0,
        statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
      })));
      expect(host.querySelector(".wb-inactive-toggle")).toBeNull();
    });
  });
});

describe("whiteboard page", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const commands: any[] = [];
  const client = () => {
    let receive: (value: unknown) => void = () => {};
    return new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      commands.push(envelope.cmd);
      const result = envelope.cmd.type === "whiteboard.view" ? data : envelope.cmd.type === "card.page" ? { url: `botling-card://page/${commands.length}` } : envelope.cmd.type === "whiteboard.allow" ? { accepted: true } : {};
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
    } });
  };
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; commands.length = 0; });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

  it("shows each bot's card and, pressed, its report with only the parts it has", async () => {
    const opened: string[] = [];
    await act(async () => root.render(createElement(Whiteboard, {
      client: client(), bots, waiting, components, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 0,
      statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: (botId: string) => opened.push(botId), onError: () => {},
    })));
    expect(commands[0]).toEqual({ type: "whiteboard.view" });
    const card = host.querySelector<HTMLButtonElement>(`.wb-card[data-bot="${site.id}"]`)!;
    expect(card.className).toContain("waiting");
    expect(card.querySelector(".wb-pill")?.textContent).toBe("2 waiting");
    expect(card.querySelector(".wb-highlight")?.textContent).toBe("The theme is live.");
    expect(card.querySelector(".wb-ring")?.getAttribute("aria-label")).toBe("1 of 3 tasks done");
    expect(host.querySelector(`.wb-card[data-bot="${paper.id}"] .wb-highlight`)?.textContent).toBe("Nothing written yet");
    expect(host.querySelector(`.wb-card[data-bot="${MAIN}"]`)).toBeNull();
    expect(host.querySelector(".wb-main-line")?.textContent).toBe("2 waiting on you: 2 from Site.");

    await act(async () => card.click());
    const report = host.querySelector(`.wb-report[data-bot="${site.id}"]`)!;
    expect([...report.querySelectorAll("[data-part]")].map((part) => part.getAttribute("data-part"))).toEqual(["sum", "ask", "made", "trend", "log", "decided", "next"]);
    expect(report.querySelector('[data-part="ask"]')?.textContent).toContain("Publish now?");
    expect(report.querySelector('[data-part="ask"]')?.textContent).toContain("Which domain?");
    expect(report.querySelector('[data-part="decided"]')?.textContent).toContain("Kept the old URLs");
    await act(async () => report.querySelector<HTMLButtonElement>(".wb-result")!.click());
    expect(commands.at(-1)).toEqual({ type: "result.open", botId: site.id, url: "https://example.com/theme" });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector(".wb-report")).toBeNull();

    // A bot with nothing written: the report says so, with no empty parts.
    await act(async () => host.querySelector<HTMLButtonElement>(`.wb-card[data-bot="${paper.id}"]`)!.click());
    expect(host.querySelectorAll(".wb-report [data-part]")).toHaveLength(0);
    expect(host.querySelector(".wb-report-empty")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".wb-report-chat")!.click());
    expect(opened).toEqual([paper.id]);
    expect(host.querySelector(".wb-report")).toBeNull();
  });

  it("draws a bot's own picture in its card (wide for 2x1) instead of the ring; one waiting for your OK keeps the ring and asks in the report", async () => {
    const saved = data.bots.map((entry) => entry.picture);
    data.bots[0]!.picture = display({ size: "2x1" });
    data.bots[1]!.picture = display({ name: "gitlog", data: "null", command: "printf x", folder: "/tmp/paper", status: "approve" });
    try {
      await act(async () => root.render(createElement(Whiteboard, {
        client: client(), bots, waiting, components: { ...components, gitlog: components.status }, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 0,
        statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
      })));
      const card = host.querySelector(`.wb-card[data-bot="${site.id}"]`)!;
      for (let i = 0; i < 50 && !card.querySelector("iframe"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(card.className).toContain("wide");
      expect(card.querySelector(".wb-ring")).toBeNull();
      const frame = card.querySelector<HTMLIFrameElement>("iframe.wb-picture-frame")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("src")).toMatch(/^botling-card:\/\/page\//);
      const page = commands.find((cmd) => cmd.type === "card.page");
      expect(page.html).toContain('data-size="2x1" data-surface="board" data-fill');
      expect(page.html).toContain('"ok":true');
      // Waiting for your OK: no frame, and the report says what would run where, with Allow.
      const paperCard = host.querySelector<HTMLButtonElement>(`.wb-card[data-bot="${paper.id}"]`)!;
      expect(paperCard.querySelector("iframe")).toBeNull();
      await act(async () => paperCard.click());
      const ask = host.querySelector(".wb-picture-ask")!;
      expect(ask.textContent).toContain("printf x");
      await act(async () => ask.querySelector<HTMLButtonElement>("button")!.click());
      expect(commands.find((cmd) => cmd.type === "whiteboard.allow")).toEqual({ type: "whiteboard.allow", botId: paper.id, command: "printf x", folder: "/tmp/paper" });
    } finally {
      data.bots.forEach((entry, index) => { entry.picture = saved[index]!; });
    }
  });

  it("sends the board's input to the main bot", async () => {
    await act(async () => root.render(createElement(Whiteboard, {
      client: client(), bots, waiting, components, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 0,
      statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
    })));
    const input = host.querySelector<HTMLTextAreaElement>(".wb-composer-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "How is everyone?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(commands.find((cmd) => cmd.type === "chat.send")).toEqual({ type: "chat.send", botId: MAIN, text: "How is everyone?" });
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
    const owner = new Bot({ profile, deferStartup: true, welcome: false, ledger: new ProcessLedger(join(dir, "ledger.json")), headConfig() { throw new Error("No real CLI"); }, prompts() { throw new Error("No turn"); }, emit() {}, log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
    const snapshot = (): ResultOf<"chat.snapshot"> => ({ epoch: "test", seq: 0, bots: [owner.view(), site], imported: null, chat: owner.snapshot(), components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null } });
    const store = new WorkspaceStore(async () => snapshot());
    await store.resync();
    const switchButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".board-switch button")].find((candidate) => candidate.textContent === name)!;
    // Nothing picked yet: the whiteboard.
    await act(async () => root.render(createElement(App, { client: client(), store })));
    expect(switchButton("Whiteboard").getAttribute("aria-pressed")).toBe("true");
    expect(switchButton("Chat").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".chat-column")?.className).toContain("whiteboard-on");
    expect(host.querySelector(`.wb-card[data-bot="${site.id}"]`)).not.toBeNull();
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
