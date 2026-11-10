// The worker list under a bot row as drawn (static markup, no window): items named by the worker, the unread dot,
// the settle clock on finished ones, a sub bot's worker labelled, "N more", and the count on the bot row that folds the list.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotView, SubagentRowView } from "../../src/contract";
import { BotRow } from "../../src/renderer/App";
import { RailWorkerList, type RailWorkerActions } from "../../src/renderer/RailWorkers";
import { railWorkers, type RailMarks } from "../../src/renderer/rail-workers";

const NOW = new Date(2026, 10, 10, 16, 0).getTime();
const MIN = 60_000;
const row = (over: Partial<SubagentRowView> & { id: string }): SubagentRowView => ({
  title: over.id, status: "running", head: "claude", startedAt: NOW - 4 * MIN, endedAt: null, unsettledAt: null, settled: false, prompt: "do it", ...over,
});
const bot = (over: Partial<BotView> & { id: string }): BotView => ({
  name: over.id, role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0,
  problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
} as BotView);
const marks: RailMarks = { viewed: new Set(), since: 0, watching: null, folded: new Set(), all: new Set() };
const actions: RailWorkerActions = { onOpen() {}, onSettle() {}, onAll() {}, onToggleJob() {} };

const root = bot({ id: "botling", subagentRows: [
  row({ id: "Draw the worker list" }), row({ id: "Fix scrolling", status: "completed", startedAt: NOW - 17 * MIN, endedAt: NOW - 5 * MIN }),
  row({ id: "r2" }), row({ id: "r3" }),
] });
const release = bot({ id: "rel", name: "Release", parent: "botling" as never, subagentRows: [row({ id: "Pack dmg", status: "failed", endedAt: NOW - MIN }), row({ id: "notes" })] });

describe("the worker list as drawn", () => {
  const draw = (lang: string | null) => {
    const list = railWorkers(root, [root, release], NOW, marks);
    return renderToStaticMarkup(createElement(RailWorkerList, { botId: "botling", list, name: "botling", now: NOW, lang, actions }));
  };
  it("names each item by its worker, with state and time and the settle clock on the finished one; no blue dot on a worker", () => {
    const out = draw(null);
    expect(out).toContain('<span class="rail-wk-name">Fix scrolling</span>');
    expect(out).toContain('class="rail-wk-row done"');
    expect(out).toContain('<span class="rail-wk-state">Done</span>・ran 12m');
    expect(out).toContain('<span class="rail-wk-state">Running</span>・4m');
    expect(out).toContain('aria-label="Settle down Fix scrolling"');
    expect(out.match(/rail-wk-settle/g)).toHaveLength(2);
    expect(out).not.toContain("rail-wk-dot");
  });
  it("shows 3 (the sub bot's failure first, labelled with its sub bot), then 'N more'", () => {
    const out = draw(null);
    expect(out.match(/class="rail-wk-row /g)).toHaveLength(3);
    expect(out).toContain(">3 more<");
    expect(out.indexOf("Pack dmg")).toBeLessThan(out.indexOf("Fix scrolling"));
    expect(out).toContain('<span class="rail-wk-tag" data-sub-bot="rel"><span class="rail-wk-subface" aria-hidden="true">R</span>Release</span><span class="rail-wk-state">Failed</span>');
    expect(out).toContain("of the sub bot Release");
  });
  it("in Traditional Chinese", () => {
    const out = draw("zh-Hant");
    expect(out).toContain(">還有 3 個<");
    expect(out).toContain('<span class="rail-wk-state">做完</span>・跑了 12 分');
    expect(out).toContain('aria-label="收起 Fix scrolling"');
  });
});

describe("one job's workers as drawn", () => {
  const job = { id: "t:turn-1", title: "比較 GPU 雲" };
  const gpu = bot({ id: "b", subagentRows: [
    row({ id: "aws", group: job, startedAt: NOW - 12 * MIN }), row({ id: "gcp", status: "completed", endedAt: NOW - MIN, group: job }),
    row({ id: "lambda", status: "failed", endedAt: NOW - MIN, group: job }), row({ id: "Pack dmg" }),
  ] });
  const draw = (open: boolean) => renderToStaticMarkup(createElement(RailWorkerList, {
    botId: "b", name: "b", now: NOW, lang: "zh-Hant", actions,
    list: railWorkers(gpu, [gpu], NOW, { ...marks, jobsOpen: new Set(open ? ["b|t:turn-1"] : []) }),
  }));
  it("one row with a dot per worker, failures, count and time; its workers not shown until opened; no blue dot", () => {
    const out = draw(false);
    expect(out.match(/class="rail-wk-row /g)).toHaveLength(2);
    // The dots sit beside the name, outside its ellipsis: a long name is cut, never the dots.
    expect(out).toContain('<span class="rail-wk-jobline"><span class="rail-wk-name">比較 GPU 雲</span><span class="rail-wk-pips" aria-hidden="true"><span class="rail-wk-pip failed"></span><span class="rail-wk-pip done"></span><span class="rail-wk-pip running"></span></span></span>');
    // Only the failures are red; the rest of the line is plain.
    expect(out).toContain('<span class="rail-wk-state"><span class="rail-wk-failed">1 失敗</span>・3 個・12 分</span>');
    // One still runs: the job's mark is the running one (as the spec draws it), and its row takes no state colour class.
    expect(out).toContain('class="rail-wk-row rail-wk-job" data-state="running"');
    expect(out).toContain('rail-wk-mark running');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain(">aws<");
    expect(out).not.toContain("rail-wk-dot");
  });
  it("opened, its workers are listed under it", () => {
    const out = draw(true);
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('<div class="rail-wk-members">');
    expect(out.match(/class="rail-wk-row /g)).toHaveLength(5);
  });
});

describe("the count on the bot row", () => {
  const draw = (folded: boolean) => renderToStaticMarkup(createElement(BotRow, {
    bot: root, selected: false, look: "original", waiting: false, onSelect() {},
    workers: { total: 6, unread: 2, folded, label: folded ? "Show botling’s 6 workers" : "Fold botling’s workers", unreadTip: "2 finished", onToggle() {} },
  } as Parameters<typeof BotRow>[0]));
  it("open: the count and a down chevron; folded: the unread number too", () => {
    const open = draw(false);
    expect(open).toContain("bot-row-wrap has-workers");
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain("rail-wk-count");
    const folded = draw(true);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('<span class="rail-wk-count" title="2 finished">2</span>');
  });
});

describe("a worker whose words wait for its background work, as drawn", () => {
  it("says what it waits for (the reason may be cut, never the time) instead of Running", () => {
    const waiting = bot({ id: "board", subagentRows: [row({ id: "board-zero-downtime", startedAt: NOW - 40 * MIN,
      waitingOn: { kind: "command", title: "Write deploy record and update TODO", since: NOW - 25 * MIN, queued: 2 } })] });
    const out = renderToStaticMarkup(createElement(RailWorkerList, { botId: "board", list: railWorkers(waiting, [waiting], NOW, marks), name: "board", now: NOW, lang: null, actions }));
    expect(out).toContain('class="rail-wk-row running waiting"');
    expect(out).toContain('<span class="rail-wk-state" title="Waiting for background command: Write deploy record and update TODO">Waiting for background command: Write deploy record and update TODO</span>・25m');
    expect(out).not.toContain(">Running<");
  });
});
