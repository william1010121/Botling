// @vitest-environment jsdom
// The main bot's whiteboard as botling.whiteboard draws it (whiteboard.test.ts, moved with the page): the summary (numbers,
// donuts, where the open work is, tasks finished), the Waiting on you and Running lanes and the Idle & asleep shelf; a card's
// latest line, waiting items and task bar from the bots' own data; pressed, the report with only the parts that have something
// in them. The functions are the ones the app page's Whiteboard.tsx had; the page runs on React here (Preact in the plugin).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ageLabel, askCount, boardLanes, boardWeek, botWeek, CARD_LINE_WIDTH, dayKey, doneByDay, highlight, lastActive, lineWidth, nextSteps, openRanking, quietWeeks,
  shortLine, taskCounts, waitingAsks, waitingCount,
} from "../src/board";
import { Whiteboard, type BoardApi } from "../src/ui";
import type { BoardView, Bot, Entry, Picture, Task, Waiting } from "../src/types";
import { board, bot, bots, empty, entries, id, main, MAIN, news, paper, site, task, waiting } from "./fixtures";
import { isOpenQuestion, type ChatRecord } from "../../../src/core/store/records";

const display = (extra: Partial<Picture>): Picture => ({ name: "status", data: '{"ok":true}', size: "1x1", command: null, folder: null, status: null, error: null, ranAt: null, ...extra });

describe("whiteboard data", () => {
  it("does not classify a declarative reply as waiting without explicit unanswered choices", () => {
    const record: ChatRecord = { id: id(90), role: "bot", date: 814897456.479,
      text: "**Codex 慢，主因是它的工作方式，不是啟動。** 我抽查過，設定值和程式位置都對得上。" };
    expect(isOpenQuestion(record)).toBe(false);
    record.choices = [{ label: "先加 TTFT 計時，再決定怎麼改", recommended: false }];
    expect(isOpenQuestion(record)).toBe(true);
    expect(isOpenQuestion({ ...record, chosen: 0 })).toBe(false);
    expect(isOpenQuestion({ ...record, answer: "先不要改" })).toBe(false);
  });

  it("puts the bots with something for you in Waiting, the rest on the shelf; no card for the main bot", () => {
    const byBot = new Map(entries.map((entry) => [entry.botId, entry]));
    const lanes = boardLanes(bots, byBot, waiting);
    expect([lanes.waiting, lanes.running, lanes.quiet].map((lane) => lane.map((entry) => entry.name))).toEqual([["Site"], [], ["Paper", "News"]]);
  });
  it("takes the highlight from the bot's own words and counts what waits on you", () => {
    expect(highlight(site, entries[0], waiting)).toBe("The theme is live.");
    expect(highlight(news, entries[2], waiting)).toBe("Morning news");
    expect(highlight(paper, entries[1], waiting)).toBeNull();
    expect(waitingCount(site, waiting, entries[0])).toBe(2); // Its question and its task waiting on you.
    expect(taskCounts(entries[0]!.tasks)).toEqual({ waiting: 1, active: 1, done: 1, total: 3 });
    expect(nextSteps(entries[0]!)).toEqual(["Dark mode", "Test on phones"]);
    const days = doneByDay(entries[0]!.tasks, Date.now());
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
    const long = { ...entries[0]!, currentStatus: [status, "second line"] };
    const line = highlight(site, long, waiting)!;
    expect(lineWidth(line)).toBeLessThanOrEqual(CARD_LINE_WIDTH + 1);
    expect(line.startsWith("token-speed 是 Rust CLI")).toBe(true);
  });
  it("draws no empty task bar for a bot with no tasks, and keeps the main bot's reply to a short excerpt", async () => {
    const reply = `${status}\n\n第二段：很長的說明。`;
    const { host, unmount } = await mount(board(bots, [{ ...entries[0]!, currentStatus: [status] }, entries[1]!, entries[2]!], waiting, { mainReply: reply }));
    try {
      const card = host.querySelector(`.wb-card[data-bot="${site.id}"]`)!;
      expect(lineWidth(card.querySelector(".wb-latest .txt")!.textContent!)).toBeLessThanOrEqual(CARD_LINE_WIDTH + 1);
      expect(card.querySelector(".wb-statebar")).not.toBeNull();
      expect(host.querySelector(`[data-bot="${paper.id}"] .wb-statebar`)).toBeNull();
      const excerpt = host.querySelector(".wb-main-reply")!.textContent!;
      expect(excerpt).not.toContain("第二段");
      expect(lineWidth(excerpt)).toBeLessThanOrEqual(2 * CARD_LINE_WIDTH + 1);
    } finally { await unmount(); }
  });
});

/** The board's frame api with every call it makes written down. */
function fakeApi(view: BoardView | (() => BoardView)) {
  const calls: unknown[][] = [];
  const api: BoardApi = {
    board: async (since) => { calls.push(["board", since]); const now = typeof view === "function" ? view() : view; return since !== undefined && since === now.stamp ? { ...now, same: true, bots: [], entries: [] } : now; },
    ignore: async (botId, text) => { calls.push(["ignore", botId, text]); },
    send: async (text) => { calls.push(["send", text]); },
    openChat: (botId) => { calls.push(["openChat", botId]); },
    openResult: (botId, url) => { calls.push(["openResult", botId, url]); },
    tile: async (spec) => { calls.push(["tile", spec]); return `botling-card://page/${"a".repeat(36)}`; },
    approve: async (req) => { calls.push(["approve", req]); return { allowed: true }; },
    run: async (botId) => { calls.push(["run", botId]); },
    setShelf: (open) => { calls.push(["shelf", open]); },
    onError: (failure) => { calls.push(["error", failure]); },
  };
  return { api, calls };
}

/** The board drawn once (no polling) for `view`. */
async function mount(view: BoardView, now = Date.now()) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { api, calls } = fakeApi(view);
  await act(async () => root.render(createElement(Whiteboard, { api, now, refreshMs: 0 })));
  return { host, api, calls, unmount: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

describe("whiteboard: lanes, ranking, the week and the shelf", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const old = "2026-10-23T09:00:00Z";
  const recent = new Date(now - 3 * 3_600_000).toISOString();
  const none: Waiting = { items: [], doing: {} };
  const stale = bot(31, "Stale", "bot", { lastActivity: old });
  const fresh = bot(32, "Fresh", "bot", { lastActivity: recent, phase: "awake" });
  const asking = bot(33, "Asking", "bot", { lastActivity: old });
  const busy = bot(34, "Busy", "bot", { lastActivity: old, working: true });
  const helped = bot(35, "Helped", "bot", { lastActivity: old, subagents: 1 });
  const approving = bot(36, "Approving", "bot", { lastActivity: old, approvals: 1, working: true });
  const pinnedBot = bot(37, "Pinned", "bot", { lastActivity: old });
  const silent = bot(39, "Silent", "bot", { lastActivity: null });
  const asks: Waiting = { items: [{ botId: asking.id, text: "Which one?", messageId: "Q1", at: new Date(now - 2 * 3_600_000).toISOString() }], doing: {} };

  it("puts a bot once: Waiting (even while running), else Running, else the shelf (pinned, then ready, then latest)", () => {
    const byBot = new Map([[helped.id, empty(helped.id)]]);
    const lanes = boardLanes([main, stale, fresh, asking, busy, helped, approving, pinnedBot, silent], byBot, asks, new Set([pinnedBot.id]));
    expect(lanes.waiting.map((entry) => entry.name)).toEqual(["Asking", "Approving"]);
    expect(lanes.running.map((entry) => entry.name)).toEqual(["Busy", "Helped"]);
    expect(lanes.quiet.map((entry) => entry.name)).toEqual(["Pinned", "Fresh", "Stale", "Silent"]);
    // A running task's subagent at work counts as running.
    const atWork = boardLanes([stale], new Map([[stale.id, empty(stale.id, [task("r", "Build", "running", old, { atWork: true })])]]), none);
    expect(atWork.running.map((entry) => entry.name)).toEqual(["Stale"]);
  });

  it("lists every thing waiting on you oldest first, with its kind, age and the chat that answers it", () => {
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const entry = bot(50, "Many", "bot", { approvals: 2 });
    const view: Waiting = { items: [{ botId: entry.id, text: "Ship it?", messageId: "Q3", at: ago(1) }, { botId: entry.id, text: "Pick a name", messageId: null }, { botId: entry.id, text: "In the group", messageId: "Q4", at: ago(5) }], doing: {} };
    const wb = empty(entry.id, [task("w", "Domain", "waiting", ago(9), { blocked: "Which domain?", history: [{ kind: "waiting", at: ago(3), text: "Which domain?" }] })],
      { approvals: [{ tool: "Bash", text: "npm publish", at: ago(2) }] });
    const list = waitingAsks(entry, view, wb);
    expect(list).toHaveLength(waitingCount(entry, view, wb));
    expect(list.map((ask) => [ask.kind, ask.code ?? ask.text, ageLabel(ask.at, now), ask.open])).toEqual([
      ["question", "In the group", "5h", entry.id],
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
    const view: Waiting = { items: [], doing: {}, acked: [`${entry.id}-task:w`] };
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
    const three = bot(57, "Three", "bot", { approvals: 3 });
    const { host, unmount } = await mount(board([main, three], [], none), now);
    try {
      expect(host.querySelector(`[data-bot="${three.id}"] .wb-pill`)?.textContent).toBe("3 waiting");
      expect(host.querySelector('[data-metric="Waiting on you"] .wb-metric-n')?.textContent).toBe("3");
      expect(host.querySelector(".lane-waiting .wb-section-meta")?.textContent).toContain("3 things");
    } finally { await unmount(); }
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
    let current: Awaited<ReturnType<typeof mount>> | null = null;
    afterEach(async () => { await current?.unmount(); current = null; });
    const list = [main, stale, fresh, asking, busy, approving, pinnedBot, silent];
    const render = async (extra: Partial<BoardView> = {}, data: Entry[] = [], bots = list, waits = asks) => {
      await current?.unmount();
      current = await mount(board(bots, data, waits, { pinned: [pinnedBot.id], ...extra }), now);
      return current;
    };
    const names = (host: HTMLElement, selector: string) => [...host.querySelectorAll(`${selector} .wb-card-name`)].map((name) => name.textContent);

    it.each([0, 1, 8])("expands all approval commands and ages even when the bot count is %i", async (count) => {
      const entry = { ...approving, approvals: count };
      const approvals = Array.from({ length: 5 }, (_, index) => ({ tool: "Bash", text: `command-${index + 1}`, at: new Date(now - (index + 1) * 3_600_000).toISOString() }));
      const { host, calls } = await render({}, [empty(entry.id, [], { approvals })], [main, entry]);
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
      await act(async () => report.querySelector<HTMLButtonElement>('[data-part="ask"] .wb-ask-open')!.click());
      expect(calls.filter((call) => call[0] === "openChat")).toEqual([["openChat", entry.id]]);
    });

    it.each(["persisted", "empty", "legacy"])("uses %s completion history in the expanded report", async (mode) => {
      const tasks = mode === "persisted" ? [] : [task("finished", "Finished", "done", new Date(now).toISOString())];
      const extra = mode === "legacy" ? {} : { doneDays: mode === "empty" ? [] : [{ day: dayKey(now), done: 7, manual: 0 }] };
      const { host } = await render({}, [empty(busy.id, tasks, extra)], [main, busy]);
      await act(async () => host.querySelector<HTMLButtonElement>(".run-card")!.click());
      const trend = host.querySelector('.wb-report [data-part="trend"]');
      if (mode === "empty") expect(trend).toBeNull();
      else expect(trend?.querySelector("svg")?.getAttribute("aria-label")).toContain(`Today ${mode === "persisted" ? 7 : 1}`);
    });

    it("draws the numbers, the lanes and the quiet bots as dimmed pills; the waiting number scrolls to its lane", async () => {
      const { host } = await render({}, [empty(approving.id, [], { approvals: [{ tool: "Bash", text: "npm publish --tag next", at: new Date(now - 20 * 60_000).toISOString() }] })]);
      const metric = (name: string) => host.querySelector(`[data-metric="${name}"]`)!;
      expect(metric("Bots").querySelector(".wb-metric-n")!.textContent).toBe("7");
      expect(metric("Bots").querySelector(".wb-metric-s")!.textContent).toBe("2 active · 2 waiting · 3 asleep");
      expect(metric("Waiting on you").querySelector(".wb-metric-n")!.textContent).toBe("2");
      expect(metric("Waiting on you").querySelector(".wb-metric-s")!.textContent).toBe("from 2 bots · oldest 2 hours");
      expect(metric("Running").querySelector(".wb-metric-s")!.textContent).toBe("0 tasks under way · 1 also waiting");
      expect(names(host, ".lane-waiting")).toEqual(["Asking", "Approving"]);
      expect(names(host, ".lane-running")).toEqual(["Busy"]);
      // Running and waiting: in Waiting only, marked Running.
      expect(host.querySelector(`.lane-waiting [data-bot="${approving.id}"] .wb-status`)!.textContent).toBe("Running");
      const approval = host.querySelector(`.lane-waiting [data-bot="${approving.id}"] .wb-ask.approval`)!;
      expect(approval.querySelector(".wb-ask-kind")!.textContent).toBe("Approval");
      expect(approval.querySelector("code")!.textContent).toBe("npm publish --tag next");
      expect(approval.querySelector(".wb-ask-age")!.textContent).toBe("20m ago");
      const question = host.querySelector(`.lane-waiting [data-bot="${asking.id}"] .wb-ask.question`)!;
      expect(question.querySelector(".wb-ask-open")).toBeNull();
      expect([...host.querySelectorAll(".quiet-pill .name")].map((pill) => pill.textContent)).toEqual(["Pinned", "Fresh", "Stale", "Silent"]);
      expect(host.querySelector(`.quiet-pill[data-bot="${fresh.id}"]`)!.className).toContain("ready");
      expect(host.querySelector(".wb-inactive-toggle")).toBeNull();
      let scrolled = false;
      (host.querySelector(".lane-waiting") as any).scrollIntoView = () => { scrolled = true; };
      await act(async () => host.querySelector<HTMLButtonElement>('[data-metric="Waiting on you"]')!.click());
      expect(scrolled).toBe(true);
    });

    it("uses each bot's face and the app's words for its state, as the core gave them", async () => {
      const { host } = await render({ statuses: { [approving.id]: { key: "waiting", text: "Waiting for your answer" } } }, [], [main, approving]);
      expect(host.querySelector(`[data-bot="${approving.id}"] img.wb-face`)?.getAttribute("src")).toBe(`data:image/svg+xml,${approving.id}`);
      await act(async () => host.querySelector<HTMLButtonElement>(".wb-card-open")!.click());
      expect(host.querySelector(".wb-report-sub")?.textContent).toMatch(/^Waiting for your answer · /);
      expect(host.querySelector(".wb-report-sub .now-dot")?.getAttribute("data-status")).toBe("waiting");
      expect(host.querySelector("img.wb-report-face")?.getAttribute("src")).toBe(`data:image/svg+xml,${approving.id}`);
    });

    it("keeps unanswered choices accessible without an Answer button for a declarative excerpt", async () => {
      const excerpt = "**Codex 慢，主因是它的工作方式，不是啟動。** 我抽查過，設定值和程式位置都對得上。";
      const { host, calls } = await render({}, [], [main, asking], { items: [{ botId: asking.id, messageId: id(90), text: excerpt }], doing: {} });
      expect(host.querySelector(".wb-ask-text")?.textContent).toBe(excerpt);
      expect(host.querySelector(".wb-pill")?.textContent).toBe("1 waiting");
      expect(host.querySelector(".wb-ask.question button")).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>(".wb-card-head")!.click());
      expect(host.querySelector(".wb-report .wb-ask.question button")).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>(".wb-report-chat")!.click());
      expect(calls.at(-1)).toEqual(["openChat", asking.id]);
    });

    it("opens the shelf's details list and tells the program part, which keeps it open for the next start", async () => {
      const { host, calls } = await render();
      const toggle = () => host.querySelector<HTMLButtonElement>(".wb-shelf-toggle")!;
      expect(toggle().textContent).toBe("Show details");
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle().click());
      expect(host.querySelectorAll(".quiet-row:not(.quiet-head)")).toHaveLength(4);
      expect(host.querySelector(".quiet-pill")).toBeNull();
      expect(toggle().textContent).toBe("Show less");
      expect(calls.filter((call) => call[0] === "shelf")).toEqual([["shelf", true]]);
      // The next start: the board arrives with it open.
      const again = await render({ shelfOpen: true });
      expect(again.host.querySelectorAll(".quiet-row:not(.quiet-head)")).toHaveLength(4);
      await act(async () => again.host.querySelector<HTMLButtonElement>(".wb-shelf-toggle")!.click());
      expect(again.calls.filter((call) => call[0] === "shelf")).toEqual([["shelf", false]]);
    });

    it("says the shelf's toggle in the app's language", async () => {
      const { host } = await render({ lang: "zh-Hant" });
      expect(host.querySelector(".wb-shelf-toggle")?.textContent).toBe("顯示詳情");
    });

    it("has no shelf when no bot is quiet", async () => {
      const { host } = await render({}, [], [main, busy]);
      expect(host.querySelector(".lane-quiet")).toBeNull();
      expect(names(host, ".lane-running")).toEqual(["Busy"]);
    });

    it("draws nothing (not even 'No bots yet') until the first board arrives", async () => {
      const host = document.createElement("div"); document.body.append(host);
      const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      await act(async () => root.render(createElement(Whiteboard, { api: { ...fakeApi(board([], [], none)).api, board: () => new Promise<BoardView>(() => {}) }, now, refreshMs: 0 })));
      expect(host.querySelector(".whiteboard")).not.toBeNull();
      expect(host.querySelector(".wb-empty")).toBeNull();
      await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    });
  });
});

describe("whiteboard page", () => {
  let current: Awaited<ReturnType<typeof mount>> | null = null;
  afterEach(async () => { await current?.unmount(); current = null; });

  it("shows each bot's card and, pressed, its report with only the parts it has", async () => {
    current = await mount(board(bots, entries, waiting));
    const { host, calls } = current;
    expect(calls[0]).toEqual(["board", undefined]);
    const card = host.querySelector<HTMLElement>(`.wb-card[data-bot="${site.id}"]`)!;
    expect(card.className).toContain("waiting");
    expect(card.querySelector(".wb-pill")?.textContent).toBe("2 waiting");
    expect([...card.querySelectorAll(".wb-ask-text")].map((text) => text.textContent)).toEqual(["Pick a domain · Which domain?", "Publish now?"]); // Oldest first; a memory line has no time.
    expect([...card.querySelectorAll(".wb-ask-open")].map((button) => button.textContent)).toEqual(["Notify", "Notify"]);
    // Notify only acknowledges (the waiting ignore): it opens no chat and answers nothing.
    await act(async () => card.querySelectorAll<HTMLButtonElement>(".wb-ask-open")[1]!.click());
    expect(calls.at(-1)).toEqual(["ignore", site.id, "Publish now?"]);
    await act(async () => card.querySelectorAll<HTMLButtonElement>(".wb-ask-open")[0]!.click());
    expect(calls.at(-1)).toEqual(["ignore", site.id, "task:c"]);
    expect(calls.some((call) => call[0] === "openChat")).toBe(false);
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
    expect(calls.at(-1)).toEqual(["openResult", site.id, "https://example.com/theme"]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector(".wb-report")).toBeNull();

    // A bot with nothing written: the report says so, with no empty parts.
    await act(async () => host.querySelector<HTMLButtonElement>(`.quiet-pill[data-bot="${paper.id}"]`)!.click());
    expect(host.querySelectorAll(".wb-report [data-part]")).toHaveLength(0);
    expect(host.querySelector(".wb-report-empty")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".wb-report-chat")!.click());
    expect(calls.at(-1)).toEqual(["openChat", paper.id]);
    expect(host.querySelector(".wb-report")).toBeNull();
  });

  it("draws a running bot's own picture on its card (wide for 2x1) as a tile; one waiting for your OK is not drawn and asks in the report", async () => {
    const working = bots.map((entry) => (entry.id === site.id ? { ...entry, working: true } : entry));
    const calm: Waiting = { items: [], doing: {} };
    const withPictures: Entry[] = [
      { ...entries[0]!, tasks: entries[0]!.tasks.filter((entry) => entry.state !== "waiting"), picture: display({ size: "2x1" }) },
      { ...entries[1]!, picture: display({ name: "gitlog", data: "null", command: "printf x", folder: "/tmp/paper", status: "approve" }) },
      entries[2]!,
    ];
    current = await mount(board(working, withPictures, calm));
    const { host, calls } = current;
    const card = host.querySelector(`.lane-running .wb-card[data-bot="${site.id}"]`)!;
    for (let i = 0; i < 50 && !card.querySelector("iframe"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(card.className).toContain("wide");
    expect(card.querySelector(".wb-next")?.textContent).toBe("Next · Dark mode");
    const frame = card.querySelector<HTMLIFrameElement>("iframe.wb-picture-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toMatch(/^botling-card:\/\/page\//);
    // The tile is asked for from the app page (the core finds its pictures): the component, its data as JSON, the size.
    expect(calls.filter((call) => call[0] === "tile")).toEqual([["tile", { component: "status", data: { ok: true }, size: "2x1", botId: site.id }]]);
    // Waiting for your OK: no frame, and the report says what would run where, with Allow.
    const paperPill = host.querySelector<HTMLButtonElement>(`.quiet-pill[data-bot="${paper.id}"]`)!;
    expect(paperPill.querySelector("iframe")).toBeNull();
    await act(async () => paperPill.click());
    const ask = host.querySelector(".wb-picture-ask")!;
    expect(ask.textContent).toContain("printf x");
    // Allow asks the app page's ApprovalSheet (the frame can only ask); once the user allowed, Botling runs it.
    await act(async () => ask.querySelector<HTMLButtonElement>("button")!.click());
    expect(calls.filter((call) => call[0] === "approve")).toEqual([["approve", { botId: paper.id, command: "printf x", folder: "/tmp/paper", card: "gitlog" }]]);
    expect(calls.filter((call) => call[0] === "run")).toEqual([["run", paper.id]]);
  });

  it("does not run a picture's command when the sheet was cancelled", async () => {
    const pending: Entry[] = [entries[0]!, { ...entries[1]!, picture: display({ name: "gitlog", data: "null", command: "printf x", folder: "/tmp/paper", status: "approve" }) }, entries[2]!];
    const { host, api, calls, unmount } = await mount(board(bots, pending, { items: [], doing: {} }));
    current = { host, api, calls, unmount };
    api.approve = async (req) => { calls.push(["approve", req]); return { allowed: false }; };
    await act(async () => host.querySelector<HTMLButtonElement>(`.quiet-pill[data-bot="${paper.id}"]`)!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".wb-picture-ask button")!.click());
    expect(calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("sends the board's input to the main bot", async () => {
    current = await mount(board(bots, entries, waiting));
    const { host, calls } = current;
    const input = host.querySelector<HTMLTextAreaElement>(".wb-composer-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "How is everyone?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(calls.find((call) => call[0] === "send")).toEqual(["send", "How is everyone?"]);
  });
});

describe("whiteboard page: asks with the stamp it has", () => {
  it("sends `since`, keeps the board on a `same` answer, and draws a changed one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let current = board(bots, entries, waiting, { stamp: "e:1" });
    const { api, calls } = fakeApi(() => current);
    await act(async () => root.render(createElement(Whiteboard, { api, now: Date.now(), refreshMs: 40 })));
    const highlight = () => host.querySelector(`.wb-card[data-bot="${site.id}"] .wb-latest .txt`)?.textContent;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(calls[0]).toEqual(["board", undefined]);
    expect(calls.slice(1).length).toBeGreaterThan(0);
    expect(calls.slice(1).every((call) => call[1] === "e:1")).toBe(true);
    expect(highlight()).toBe("The theme is live.");
    current = board(bots, [{ ...entries[0]!, currentStatus: ["Moved to the new host."] }, ...entries.slice(1)], waiting, { stamp: "e:2" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(highlight()).toBe("Moved to the new host.");
    expect(calls.at(-1)).toEqual(["board", "e:2"]);
    await act(async () => root.unmount());
    host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
});
