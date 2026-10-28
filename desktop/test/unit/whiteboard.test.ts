// @vitest-environment jsdom
// The main bot's whiteboard (Whiteboard.tsx): the summary (numbers, donuts, where the open work is,
// tasks finished), the Waiting on you and Running lanes and the Idle & asleep shelf; a card's latest
// line, waiting items and task bar from the bots' own data; pressed, the report with only the parts
// that have something in them; and the main bot's Chat / Board / Whiteboard switch.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type BotView, type ResultOf, type TaskView, type WaitingView, type WhiteboardBotView, type WhiteboardView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { CARD_LINE_WIDTH, SHELF_KEY, Whiteboard, ageLabel, askCount, boardLanes, boardWeek, botWeek, dayKey, doneByDay, highlight, lineWidth, shortLine, lastActive, nextSteps, openRanking, quietWeeks, taskCounts, waitingAsks, waitingCount } from "../../src/renderer/Whiteboard";
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
  it("puts the bots with something for you in Waiting, the rest on the shelf; no card for the main bot or a group with no question", () => {
    const byBot = new Map(data.bots.map((entry) => [entry.botId, entry]));
    const lanes = boardLanes(bots, byBot, waiting);
    expect([lanes.waiting, lanes.running, lanes.quiet].map((lane) => lane.map((entry) => entry.name))).toEqual([["Site"], [], ["Paper", "News"]]);
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

describe("whiteboard: terse cards (one short line, as the approved design)", () => {
  const status = "token-speed 是 Rust CLI / Ratatui TUI，讀取本機 Claude Code 與 Codex 的 session 紀錄，算出每秒 token 速度。下一步是加上每個模型的分開統計，再把結果畫成圖表給使用者看，最後打包成 Homebrew formula。";
  it("keeps only the first sentence, clamped to one line's width", () => {
    expect(shortLine("The theme is live. Next: dark mode and phones.")).toBe("The theme is live.");
    expect(shortLine("- **Done**: shipped `v2`.")).toBe("Done: shipped v2.");
    const line = shortLine(status)!;
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("下一步");
    expect(lineWidth(line)).toBeLessThanOrEqual(CARD_LINE_WIDTH + 1);
    expect(shortLine("   ")).toBeNull();
  });
  it("gives the card's highlight as that one short line, not the memory paragraph", () => {
    const long = { ...data.bots[0]!, currentStatus: [status, "second line"] };
    const line = highlight(site, long, waiting)!;
    expect(lineWidth(line)).toBeLessThanOrEqual(CARD_LINE_WIDTH + 1);
    expect(line.startsWith("token-speed 是 Rust CLI")).toBe(true);
  });
  it("draws no empty task bar for a bot with no tasks, and keeps the main bot's reply to a short excerpt", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let receive: (value: unknown) => void = () => {};
    const view: WhiteboardView = { bots: [{ ...data.bots[0]!, currentStatus: [status] }, data.bots[1]!, data.bots[2]!] };
    const quiet = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result: envelope.cmd.type === "whiteboard.view" ? view : {} }));
    } });
    const reply = `${status}\n\n第二段：很長的說明。`;
    try {
      await act(async () => root.render(createElement(Whiteboard, {
        client: quiet, bots, waiting, components, look: "original", now: Date.now(), mainBotId: MAIN, refreshMs: 0,
        mainMessages: [{ id: "m1", role: "bot", text: reply } as any],
        statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
      })));
      const card = host.querySelector(`.wb-card[data-bot="${site.id}"]`)!;
      expect(lineWidth(card.querySelector(".wb-latest .txt")!.textContent!)).toBeLessThanOrEqual(CARD_LINE_WIDTH + 1);
      expect(card.querySelector(".wb-statebar")).not.toBeNull();
      expect(host.querySelector(`[data-bot="${paper.id}"] .wb-statebar`)).toBeNull();
      const excerpt = host.querySelector(".wb-main-reply")!.textContent!;
      expect(excerpt).not.toContain("第二段");
      expect(lineWidth(excerpt)).toBeLessThanOrEqual(2 * CARD_LINE_WIDTH + 1);
    } finally {
      await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});

describe("whiteboard: lanes, ranking, the week and the shelf", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const old = "2026-10-23T09:00:00Z";
  const recent = new Date(now - 3 * 3_600_000).toISOString();
  const none: WaitingView = { items: [], doing: {} };
  const empty = (botId: string, tasks: TaskView[] = [], extra: Partial<WhiteboardBotView> = {}): WhiteboardBotView => ({ botId, currentStatus: [], inProgress: [], decided: [], tasks, results: [], picture: null, ...extra });
  const stale = bot(31, "Stale", "bot", { lastActivity: old });
  const fresh = bot(32, "Fresh", "bot", { lastActivity: recent, phase: "awake" });
  const asking = bot(33, "Asking", "bot", { lastActivity: old });
  const busy = bot(34, "Busy", "bot", { lastActivity: old, working: true });
  const helped = bot(35, "Helped", "bot", { lastActivity: old, subagents: 1 });
  const approving = bot(36, "Approving", "bot", { lastActivity: old, approvals: 1, working: true });
  const pinnedBot = bot(37, "Pinned", "bot", { lastActivity: old });
  const silent = bot(39, "Silent", "bot", { lastActivity: null });
  const asks: WaitingView = { items: [{ botId: asking.id, text: "Which one?", messageId: "Q1", at: new Date(now - 2 * 3_600_000).toISOString() }], doing: {} };

  it("puts a bot once: Waiting (even while running), else Running, else the shelf (pinned, then ready, then latest)", () => {
    const byBot = new Map([[helped.id, empty(helped.id)]]);
    const lanes = boardLanes([main, stale, fresh, asking, busy, helped, approving, pinnedBot, silent, group], byBot, asks, new Set([pinnedBot.id]));
    expect(lanes.waiting.map((entry) => entry.name)).toEqual(["Asking", "Approving"]);
    expect(lanes.running.map((entry) => entry.name)).toEqual(["Busy", "Helped"]);
    expect(lanes.quiet.map((entry) => entry.name)).toEqual(["Pinned", "Fresh", "Stale", "Silent"]);
    // A running task's subagent at work counts as running.
    const atWork = boardLanes([stale], new Map([[stale.id, empty(stale.id, [task("r", "Build", "running", old, { atWork: true })])]]), none);
    expect(atWork.running.map((entry) => entry.name)).toEqual(["Stale"]);
    // A group chat shows only with a question of its own.
    const groupAsk: WaitingView = { items: [{ botId: group.id, text: "Who writes?", messageId: "Q2", groupId: group.id }], doing: {} };
    expect(boardLanes([group], new Map(), groupAsk).waiting.map((entry) => entry.name)).toEqual(["Writing"]);
  });

  it("lists every thing waiting on you oldest first, with its kind, age and the chat that answers it", () => {
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const entry = bot(50, "Many", "bot", { approvals: 2 });
    const view: WaitingView = { items: [{ botId: entry.id, text: "Ship it?", messageId: "Q3", at: ago(1) }, { botId: entry.id, text: "Pick a name", messageId: null }, { botId: entry.id, text: "In the group", messageId: "Q4", groupId: group.id, at: ago(5) }], doing: {} };
    const wb = empty(entry.id, [task("w", "Domain", "waiting", ago(9), { blocked: "Which domain?", history: [{ kind: "waiting", at: ago(3), text: "Which domain?" }] })],
      { approvals: [{ tool: "Bash", text: "npm publish", at: ago(2) }] });
    const list = waitingAsks(entry, view, wb);
    expect(list).toHaveLength(waitingCount(entry, view, wb));
    expect(list.map((ask) => [ask.kind, ask.code ?? ask.text, ageLabel(ask.at, now), ask.open])).toEqual([
      ["question", "In the group", "5h", group.id],
      ["call", "Domain · Which domain?", "3h", entry.id],
      ["approval", "npm publish", "2h", entry.id],
      ["question", "Ship it?", "1h", entry.id],
      ["call", "Pick a name", null, entry.id],
      ["approval", "1 more tool approval waiting", null, entry.id], // The core named one of two: the other is counted.
    ]);
    expect(ageLabel(ago(0.1), now)).toBe("6m");
    expect(ageLabel(ago(50), now)).toBe("2d");
  });

  it("leaves out the tasks waiting on you that were acknowledged with Notify", () => {
    const entry = bot(55, "Acked", "bot");
    const wb = empty(entry.id, [task("w", "Domain", "waiting", new Date(now).toISOString(), { blocked: "Which domain?" })]);
    const view: WaitingView = { items: [], doing: {}, acked: [`${entry.id}-task:w`] };
    expect(waitingAsks(entry, view, wb)).toEqual([]);
    expect(waitingCount(entry, view, wb)).toBe(0);
    expect(waitingAsks(entry, none, wb).map((ask) => [ask.kind, ask.ack])).toEqual([["call", { botId: entry.id, text: "task:w" }]]);
  });

  it("counts every tool approval, also those the core gives no details for (one row says how many)", () => {
    const three = bot(54, "Three", "bot", { approvals: 3 });
    const rows = waitingAsks(three, none, empty(three.id));
    expect(rows).toHaveLength(1);
    expect(askCount(rows)).toBe(3);
    expect(askCount(rows)).toBe(waitingCount(three, none, empty(three.id)));
    // 25 waiting, details for the first 20.
    const many = bot(55, "Many", "bot", { approvals: 25 });
    const listed = empty(many.id, [], { approvals: Array.from({ length: 20 }, (_, n) => ({ tool: "Bash", text: `cmd ${n}`, at: null })) });
    expect(askCount(waitingAsks(many, none, listed))).toBe(25);
    // Details for more than the view's count (the view is a moment older): all of them count.
    const behind = bot(56, "Behind", "bot", { approvals: 1 });
    const two = empty(behind.id, [], { approvals: [{ tool: "Bash", text: "a", at: null }, { tool: "Bash", text: "b", at: null }] });
    expect(askCount(waitingAsks(behind, none, two))).toBe(2);
    expect(waitingCount(behind, none, two)).toBe(2);
  });

  it("shows the whole approval count on the card, the lane and the number", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let receive: (value: unknown) => void = () => {};
    const quiet = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result: envelope.cmd.type === "whiteboard.view" ? { bots: [] } : {} }));
    } });
    const three = bot(57, "Three", "bot", { approvals: 3 });
    try {
      await act(async () => root.render(createElement(Whiteboard, {
        client: quiet, bots: [main, three], waiting: none, components: {}, look: "original", now, mainMessages: [], mainBotId: MAIN, refreshMs: 0,
        statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
      })));
      expect(host.querySelector(`[data-bot="${three.id}"] .wb-pill`)?.textContent).toBe("3 waiting");
      expect(host.querySelector('[data-metric="Waiting on you"] .wb-metric-n')?.textContent).toBe("3");
      expect(host.querySelector(".lane-waiting .wb-section-meta")?.textContent).toContain("3 things");
    } finally {
      await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("ranks the open work by what waits on you, then what is under way", () => {
    const a = bot(51, "A", "bot", { approvals: 1 });
    const b = bot(52, "B", "bot");
    const c = bot(53, "C", "bot");
    const byBot = new Map([[b.id, empty(b.id, [task("1", "One", "running", old), task("2", "Two", "pending", old)])], [c.id, empty(c.id, [task("3", "Three", "done", old)])]]);
    expect(openRanking([main, a, b, c], byBot, none).map((row) => [row.bot.name, row.waiting, row.active])).toEqual([["A", 1, 0], ["B", 0, 2]]);
  });

  it("sums the tasks finished on each of the last seven days across the bots, with last week's sum from the done log", () => {
    const day = (back: number) => { const date = new Date(now); date.setDate(date.getDate() - back); return dayKey(date.getTime()); };
    const logged = empty("x", [], { doneDays: Array.from({ length: 14 }, (_, index) => ({ day: day(13 - index), done: index === 13 ? 2 : index === 3 ? 4 : 1, manual: 0 })) });
    // An older core (no done log): its done cards by their last change.
    const older = empty("y", [task("d", "Done", "done", new Date(now).toISOString())]);
    const week = boardWeek([logged, older, undefined], now);
    expect(week.days.map((entry) => entry.count)).toEqual([1, 1, 1, 1, 1, 1, 3]);
    expect(week.days.at(-1)).toMatchObject({ label: "Today", today: true });
    expect(week.week).toBe(9);
    expect(week.lastWeek).toBe(10);
    expect(botWeek(logged, now)).toEqual([1, 1, 1, 1, 1, 1, 2]);
    expect(boardWeek([older], now).lastWeek).toBeNull();
  });

  it("says a bot is quiet from three weeks on", () => {
    expect(quietWeeks(bot(60, "Q", "bot", { lastActivity: new Date(now - 26 * 86_400_000).toISOString() }), undefined, now)).toBe(3);
    expect(quietWeeks(bot(61, "R", "bot", { lastActivity: new Date(now - 20 * 86_400_000).toISOString() }), undefined, now)).toBeNull();
    expect(quietWeeks(silent, undefined, now)).toBeNull();
    expect(lastActive(stale, empty(stale.id, [task("t", "Draft", "done", recent)]))).toBe(Date.parse(recent));
  });

  describe("on the page", () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; try { localStorage.removeItem(SHELF_KEY); } catch { /* none */ } });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
    const boardClient = (view: WhiteboardView = { bots: [] }) => {
      let receive: (value: unknown) => void = () => {};
      return new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
        const result = envelope.cmd.type === "whiteboard.view" ? view : {};
        queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
      } });
    };
    const opened: string[] = [];
    const render = (lang?: string, view?: WhiteboardView, list = [main, stale, fresh, asking, busy, approving, pinnedBot, silent]) => act(async () => root.render(createElement(Whiteboard, {
      client: boardClient(view), bots: list, waiting: asks, components: {}, look: "original", now, mainMessages: [], mainBotId: MAIN, refreshMs: 0,
      pinned: [pinnedBot.id], lang: lang as any, statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: (botId: string) => opened.push(botId), onError: () => {},
    })));
    const names = (selector: string) => [...host.querySelectorAll(`${selector} .wb-card-name`)].map((name) => name.textContent);

    it.each([0, 1, 8])("expands all approval commands and ages even when the bot count is %i", async (count) => {
      const entry = { ...approving, approvals: count };
      const approvals = Array.from({ length: 5 }, (_, index) => ({ tool: "Bash", text: `command-${index + 1}`, at: new Date(now - (index + 1) * 3_600_000).toISOString() }));
      await render(undefined, { bots: [empty(entry.id, [], { approvals })] }, [main, entry]);
      const card = host.querySelector(".ask-card")!;
      expect(card.querySelectorAll("code")).toHaveLength(4);
      expect(card.querySelector(".wb-ask-more")?.textContent).toBe(`+${Math.max(5, count) - 4} more in the report`);
      await act(async () => card.querySelector<HTMLButtonElement>(".wb-card-open")!.click());
      const report = host.querySelector(".wb-report")!;
      expect([...report.querySelectorAll('[data-part="ask"] code')].map(node => node.textContent).sort()).toEqual(approvals.map(item => item.text).sort());
      expect([...report.querySelectorAll('[data-part="ask"] .wb-ask-age')].map(node => node.textContent).sort()).toEqual(["1h ago", "2h ago", "3h ago", "4h ago", "5h ago"]);
      expect(report.querySelector(".wb-toc")?.textContent).toContain(`Your call ${Math.max(5, count)}`);
      expect(report.querySelector(".wb-stat-n.waiting")?.textContent).toBe(String(Math.max(5, count)));
      if (count > 5) expect(report.querySelector('[data-part="ask"]')?.textContent).toContain("3 more tool approvals waiting");
      const before = opened.length;
      await act(async () => report.querySelector<HTMLButtonElement>('[data-part="ask"] .wb-ask-open')!.click());
      expect(opened.slice(before)).toEqual([entry.id]);
    });

    it.each(["persisted", "empty", "legacy"])("uses %s completion history in the expanded report", async (mode) => {
      const tasks = mode === "persisted" ? [] : [task("finished", "Finished", "done", new Date(now).toISOString())];
      const extra = mode === "legacy" ? {} : { doneDays: mode === "empty" ? [] : [{ day: dayKey(now), done: 7, manual: 0 }] };
      await render(undefined, { bots: [empty(busy.id, tasks, extra)] }, [main, busy]);
      await act(async () => host.querySelector<HTMLButtonElement>(".run-card")!.click());
      const trend = host.querySelector('.wb-report [data-part="trend"]');
      if (mode === "empty") expect(trend).toBeNull();
      else expect(trend?.querySelector("svg")?.getAttribute("aria-label")).toContain(`Today ${mode === "persisted" ? 7 : 1}`);
    });

    it("draws the numbers, the lanes and the quiet bots as dimmed pills; the waiting number scrolls to its lane", async () => {
      await render(undefined, { bots: [empty(approving.id, [], { approvals: [{ tool: "Bash", text: "npm publish --tag next", at: new Date(now - 20 * 60_000).toISOString() }] })] });
      const metric = (name: string) => host.querySelector(`[data-metric="${name}"]`)!;
      expect(metric("Bots").querySelector(".wb-metric-n")!.textContent).toBe("7");
      expect(metric("Bots").querySelector(".wb-metric-s")!.textContent).toBe("2 active · 2 waiting · 3 asleep");
      expect(metric("Waiting on you").querySelector(".wb-metric-n")!.textContent).toBe("2");
      expect(metric("Waiting on you").querySelector(".wb-metric-s")!.textContent).toBe("from 2 bots · oldest 2 hours");
      expect(metric("Running").querySelector(".wb-metric-s")!.textContent).toBe("0 tasks under way · 1 also waiting");
      expect(names(".lane-waiting")).toEqual(["Asking", "Approving"]);
      expect(names(".lane-running")).toEqual(["Busy"]);
      // Running and waiting: in Waiting only, marked Running.
      expect(host.querySelector(`.lane-waiting [data-bot="${approving.id}"] .wb-status`)!.textContent).toBe("Running");
      const approval = host.querySelector(`.lane-waiting [data-bot="${approving.id}"] .wb-ask.approval`)!;
      expect(approval.querySelector(".wb-ask-kind")!.textContent).toBe("Approval");
      expect(approval.querySelector("code")!.textContent).toBe("npm publish --tag next");
      expect(approval.querySelector(".wb-ask-age")!.textContent).toBe("20m ago");
      const question = host.querySelector(`.lane-waiting [data-bot="${asking.id}"] .wb-ask.question`)!;
      expect(question.querySelector(".wb-ask-open")!.textContent).toBe("Answer");
      await act(async () => question.querySelector<HTMLButtonElement>(".wb-ask-open")!.click());
      expect(opened.at(-1)).toBe(asking.id);
      expect([...host.querySelectorAll(".quiet-pill .name")].map((pill) => pill.textContent)).toEqual(["Pinned", "Fresh", "Stale", "Silent"]);
      expect(host.querySelector(`.quiet-pill[data-bot="${fresh.id}"]`)!.className).toContain("ready");
      expect(host.querySelector(".wb-inactive-toggle")).toBeNull();
      let scrolled = false;
      (host.querySelector(".lane-waiting") as any).scrollIntoView = () => { scrolled = true; };
      await act(async () => host.querySelector<HTMLButtonElement>('[data-metric="Waiting on you"]')!.click());
      expect(scrolled).toBe(true);
    });

    it("opens the shelf's details list and keeps it open for the next start", async () => {
      await render();
      const toggle = () => host.querySelector<HTMLButtonElement>(".wb-shelf-toggle")!;
      expect(toggle().textContent).toBe("Show details");
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle().click());
      expect(host.querySelectorAll(".quiet-row:not(.quiet-head)")).toHaveLength(4);
      expect(host.querySelector(".quiet-pill")).toBeNull();
      expect(toggle().textContent).toBe("Show less");
      expect(localStorage.getItem(SHELF_KEY)).toBe("1");
      await act(async () => root.unmount());
      root = createRoot(host);
      await render();
      expect(host.querySelectorAll(".quiet-row:not(.quiet-head)")).toHaveLength(4);
      await act(async () => toggle().click());
      expect(localStorage.getItem(SHELF_KEY)).toBe("0");
    });

    it("says the shelf's toggle in the app's language", async () => {
      await render("zh-Hant");
      expect(host.querySelector(".wb-shelf-toggle")?.textContent).toBe("顯示詳情");
    });

    it("has no shelf when no bot is quiet", async () => {
      await render(undefined, undefined, [main, busy]);
      expect(host.querySelector(".lane-quiet")).toBeNull();
      expect(names(".lane-running")).toEqual(["Busy"]);
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
    const card = host.querySelector<HTMLElement>(`.wb-card[data-bot="${site.id}"]`)!;
    expect(card.className).toContain("waiting");
    expect(card.querySelector(".wb-pill")?.textContent).toBe("2 waiting");
    expect([...card.querySelectorAll(".wb-ask-text")].map((text) => text.textContent)).toEqual(["Pick a domain · Which domain?", "Publish now?"]); // Oldest first; a memory line has no time.
    expect([...card.querySelectorAll(".wb-ask-open")].map((button) => button.textContent)).toEqual(["Notify", "Notify"]);
    // Notify only acknowledges (waiting.ignore): it opens no chat and answers nothing.
    const opened0 = opened.length;
    await act(async () => card.querySelectorAll<HTMLButtonElement>(".wb-ask-open")[1]!.click());
    expect(commands.at(-1)).toEqual({ type: "waiting.ignore", botId: site.id, text: "Publish now?" });
    await act(async () => card.querySelectorAll<HTMLButtonElement>(".wb-ask-open")[0]!.click());
    expect(commands.at(-1)).toEqual({ type: "waiting.ignore", botId: site.id, text: `task:c` });
    expect(opened).toHaveLength(opened0);
    expect(card.querySelector(".wb-latest .txt")?.textContent).toBe("The theme is live.");
    expect(card.querySelector(".wb-foot-count")?.textContent).toBe("1/3");
    expect(card.querySelector(".wb-ring")).toBeNull();
    expect(host.querySelector(`.quiet-pill[data-bot="${paper.id}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-bot="${MAIN}"]`)).toBeNull();
    // Where the open work is: Site, 2 waiting on you and 1 under way.
    expect(host.querySelector(`.wb-rank li[data-bot="${site.id}"] .wb-rank-v`)?.textContent).toBe("2 · 1");
    expect(host.querySelector('[data-donut="tasks"] svg')?.getAttribute("aria-label")).toBe("tasks: Done 1, Under way 1, Waiting 1");

    await act(async () => card.querySelector<HTMLButtonElement>(".wb-card-open")!.click());
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
    await act(async () => host.querySelector<HTMLButtonElement>(`.quiet-pill[data-bot="${paper.id}"]`)!.click());
    expect(host.querySelectorAll(".wb-report [data-part]")).toHaveLength(0);
    expect(host.querySelector(".wb-report-empty")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".wb-report-chat")!.click());
    expect(opened).toEqual([paper.id]);
    expect(host.querySelector(".wb-report")).toBeNull();
  });

  it("draws a running bot's own picture on its card (wide for 2x1); one waiting for your OK is not drawn and asks in the report", async () => {
    const saved = data.bots.map((entry) => entry.picture);
    data.bots[0]!.picture = display({ size: "2x1" });
    data.bots[1]!.picture = display({ name: "gitlog", data: "null", command: "printf x", folder: "/tmp/paper", status: "approve" });
    const working = bots.map((entry) => (entry.id === site.id ? { ...entry, working: true } : entry));
    const calm: WaitingView = { items: [], doing: {} };
    const settled: WhiteboardView = { bots: [{ ...data.bots[0]!, tasks: data.bots[0]!.tasks.filter((entry) => entry.state !== "waiting") }, ...data.bots.slice(1)] };
    const pictures = () => {
      let receive: (value: unknown) => void = () => {};
      return new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
        commands.push(envelope.cmd);
        const result = envelope.cmd.type === "whiteboard.view" ? settled : envelope.cmd.type === "card.page" ? { url: `botling-card://page/${commands.length}` } : envelope.cmd.type === "whiteboard.allow" ? { accepted: true } : {};
        queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
      } });
    };
    try {
      await act(async () => root.render(createElement(Whiteboard, {
        client: pictures(), bots: working, waiting: calm, components: { ...components, gitlog: components.status }, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 0,
        statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
      })));
      const card = host.querySelector(`.lane-running .wb-card[data-bot="${site.id}"]`)!;
      for (let i = 0; i < 50 && !card.querySelector("iframe"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(card.className).toContain("wide");
      expect(card.querySelector(".wb-next")?.textContent).toBe("Next · Dark mode");
      const frame = card.querySelector<HTMLIFrameElement>("iframe.wb-picture-frame")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("src")).toMatch(/^botling-card:\/\/page\//);
      const page = commands.find((cmd) => cmd.type === "card.page");
      expect(page.html).toContain('data-size="2x1" data-surface="board" data-fill');
      expect(page.html).toContain('"ok":true');
      // Waiting for your OK: no frame, and the report says what would run where, with Allow.
      const paperCard = host.querySelector<HTMLButtonElement>(`.quiet-pill[data-bot="${paper.id}"]`)!;
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

describe("whiteboard page: asks with the stamp it has", () => {
  it("sends `since`, keeps the board on a `same` answer, and draws a changed one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const asked: any[] = [];
    let board: WhiteboardView & { stamp: string } = { ...data, stamp: "e:1" };
    let receive: (value: unknown) => void = () => {};
    const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      if (envelope.cmd.type === "whiteboard.view") asked.push(envelope.cmd);
      const result = envelope.cmd.type !== "whiteboard.view" ? {} : envelope.cmd.since === board.stamp ? { bots: [], stamp: board.stamp, same: true } : board;
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
    } });
    await act(async () => root.render(createElement(Whiteboard, {
      client, bots, waiting, components, look: "original", now: Date.now(), mainMessages: [], mainBotId: MAIN, refreshMs: 40,
      statusOf: () => ({ key: "asleep", text: "Asleep" }), onOpenChat: () => {}, onError: () => {},
    })));
    const highlight = () => host.querySelector(`.wb-card[data-bot="${site.id}"] .wb-latest .txt`)?.textContent;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(asked[0]).toEqual({ type: "whiteboard.view" });
    expect(asked.slice(1).length).toBeGreaterThan(0);
    expect(asked.slice(1).every((cmd) => cmd.since === "e:1")).toBe(true);
    expect(highlight()).toBe("The theme is live.");
    board = { bots: [{ ...data.bots[0]!, currentStatus: ["Moved to the new host."] }, ...data.bots.slice(1)], stamp: "e:2" };
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(highlight()).toBe("Moved to the new host.");
    expect(asked.at(-1)).toEqual({ type: "whiteboard.view", since: "e:2" });
    await act(async () => root.unmount());
    host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
});
