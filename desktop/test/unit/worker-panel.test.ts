// @vitest-environment jsdom
// Navigation v5, part 2: the "<owner>'s workers" badge and its menu (a room's app-managed workers grouped by owner).
// A worker opens in the main area, the chat's place, read only like a left-column click, with "Ask <owner>" under it
// (your words go to the owner bot, never to the worker). The right panel keeps Details only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView, SubagentRowView, SubagentView } from "../../src/contract";
import {
  askOwnerText, askReference, askState, filesChanged, ownerSummary, sectionedWorkers, watchedWorker, workerFamily, workerRowsOf, workersBadge, workersMenuAfterMove,
} from "../../src/renderer/worker-panel";
import { shellOverlayActive } from "../../src/renderer/ShellOverlay";

const NOW = new Date(2026, 10, 8, 16, 0).getTime();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const row = (over: Partial<SubagentRowView> & { id: string }): SubagentRowView => ({
  title: over.id, status: "completed", head: "claude", startedAt: NOW - HOUR, endedAt: NOW - 50 * MIN, unsettledAt: null, settled: false, prompt: "do it", ...over,
});
const bot = (over: Partial<BotView> & { id: string }): BotView => ({
  name: over.id, role: "project", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0,
  problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
} as BotView);

afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

describe("which rows are workers", () => {
  it("leaves out sub bot rows (a sub bot is a room, not a worker)", () => {
    const b = bot({ id: "b", subagentRows: [row({ id: "w1" }), row({ id: "sb", subBot: "R" as never })] });
    expect(workerRowsOf(b).map((r) => r.id)).toEqual(["w1"]);
  });
});

describe("sections: Running → Today → Earlier (7 days)", () => {
  it("puts running first (newest start first), today by end newest first, earlier up to 7 days, drops older", () => {
    const rows = [
      row({ id: "old", endedAt: NOW - 8 * DAY, startedAt: NOW - 8 * DAY - MIN }),
      row({ id: "yesterday", endedAt: NOW - DAY, startedAt: NOW - DAY - MIN }),
      row({ id: "t1", endedAt: NOW - 2 * HOUR }),
      row({ id: "t2", endedAt: NOW - 10 * MIN }),
      row({ id: "r1", status: "running", endedAt: null, startedAt: NOW - 9 * MIN }),
      row({ id: "r2", status: "running", endedAt: null, startedAt: NOW - 4 * MIN }),
    ];
    const s = sectionedWorkers(rows, NOW);
    expect(s.running.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(s.today.map((r) => r.id)).toEqual(["t2", "t1"]);
    expect(s.earlier.map((r) => r.id)).toEqual(["yesterday"]);
  });
  it("counts settled rows too: the panel shows every worker, not only the left column's", () => {
    expect(sectionedWorkers([row({ id: "s", settled: true })], NOW).today.map((r) => r.id)).toEqual(["s"]);
  });
});

describe("owners: the room expanded, its family folded", () => {
  const root = bot({ id: "botling" });
  const release = bot({ id: "release", name: "Release", parent: "botling" as never });
  const nightly = bot({ id: "nightly", name: "Nightly audit", parent: "botling" as never });
  const other = bot({ id: "other" });
  it("in the project bot: itself, then its sub bots", () => {
    expect(workerFamily(root, [root, release, other, nightly])).toEqual({ room: root, others: [release, nightly] });
  });
  it("in a sub bot: itself, then its parent, then its siblings", () => {
    expect(workerFamily(release, [root, release, other, nightly])).toEqual({ room: release, others: [root, nightly] });
  });
  it("a folded owner's line: running, then failed, then today; nothing when it had no worker today", () => {
    const rows = [row({ id: "a", status: "running", endedAt: null }), row({ id: "b", status: "failed" }), row({ id: "c" }), row({ id: "d" })];
    expect(ownerSummary(rows, NOW)).toEqual([{ text: "1 running", tone: "running" }, { text: "1 failed", tone: "failed" }, { text: "2 today", tone: "today" }]);
    expect(ownerSummary([row({ id: "old", endedAt: NOW - 2 * DAY })], NOW)).toEqual([]);
  });
});

describe("the badge: hidden, running, today, failed", () => {
  it("is hidden with no worker today", () => {
    expect(workersBadge([row({ id: "old", endedAt: NOW - 2 * DAY })], NOW, new Set())).toBeNull();
  });
  it("counts running", () => {
    expect(workersBadge([row({ id: "a", status: "running", endedAt: null }), row({ id: "b" })], NOW, new Set())).toMatchObject({ tone: "running", count: "1 running", extra: null });
  });
  it("greys out to today when all are done", () => {
    expect(workersBadge([row({ id: "a" }), row({ id: "b", status: "stopped" })], NOW, new Set())).toMatchObject({ tone: "today", count: "2 today" });
  });
  it("puts an unseen failure first, then running; a seen one goes back to normal", () => {
    const rows = [row({ id: "f", status: "failed" }), row({ id: "r", status: "running", endedAt: null }), row({ id: "r2", status: "running", endedAt: null })];
    expect(workersBadge(rows, NOW, new Set())).toMatchObject({ tone: "failed", count: "1 failed", extra: "2 running" });
    expect(workersBadge(rows, NOW, new Set(["f"]))).toMatchObject({ tone: "running", count: "2 running" });
  });
  it("its tip names today's totals", () => {
    const rows = [row({ id: "f", status: "failed" }), row({ id: "r", status: "running", endedAt: null }), row({ id: "d" })];
    expect(workersBadge(rows, NOW, new Set())?.tip).toBe("1 running · 1 done today · 1 failed");
  });
});

describe("the log's Files changed", () => {
  const step = (tool: string, detail: string, failed = false) => ({ id: tool + detail, kind: "tool" as const, tool, title: tool, detail, output: null, failed, done: true });
  it("lists each edited or written file once, in order, leaving out failed edits and other tools", () => {
    expect(filesChanged([
      step("Read", "/w/a.ts"), step("Edit", "/w/a.ts"), step("Write", "/w/b.md"), step("Edit", "/w/a.ts"),
      step("Edit", "/w/c.ts", true), step("Edit", "/w/d.ts\n/w/e.ts"), step("Bash", "npm test"),
    ])).toEqual(["/w/a.ts", "/w/b.md", "/w/d.ts", "/w/e.ts"]);
  });
});

describe("Ask <owner>: the words go to the owner bot", () => {
  it("names the worker, its id and agent id, then the question", () => {
    expect(askOwnerText({ title: "context-baseline", id: "toolu_1", agentId: "ag-7" }, "  Rerun with 30 turns  "))
      .toBe('About your worker "context-baseline" (toolu_1, agent ag-7): Rerun with 30 turns');
    expect(askOwnerText({ title: "x", id: "t2" }, "why?")).toBe('About your worker "x" (t2): why?');
  });
});

const view = (over: Partial<SubagentView> = {}): SubagentView => ({
  id: "w1", title: "context-baseline", owner: "botling", status: "completed", type: null, model: "sonnet-5-5", engine: "claude",
  prompt: "Measure context use", result: "Main 1.8M, subagents 317k.", startedAt: new Date(NOW - 5 * MIN).toISOString(), endedAt: new Date(NOW - MIN).toISOString(),
  steps: [], ...over,
});

async function mountEl(type: unknown, props: Record<string, unknown>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const render = (more: Record<string, unknown> = {}) => act(async () => root.render(createElement(type as never, { ...props, ...more } as never)));
  await render();
  return { host, render, unmount: () => act(async () => root.unmount()) };
}

const panelBase = {
  waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], watching: null, collapsed: false,
  onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
};

describe("the right panel keeps Details only (workers open in the main area)", () => {
  it("has no Details | Workers tabs and no worker list, even with workers around", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { RightPanel } = await import("../../src/renderer/RightPanel");
    const b = bot({ id: "botling", name: "botling", subagentRows: [row({ id: "w1" }), row({ id: "f", status: "failed" })] });
    const { host, unmount } = await mountEl(RightPanel, { ...panelBase, bot: b, bots: [b] });
    try {
      expect(host.querySelector(".panel-tabs")).toBeNull();
      expect(host.querySelector(".wk-list, .wk-log")).toBeNull();
      expect(host.querySelector(".detail-head")).not.toBeNull();
    } finally { await unmount(); vi.useRealTimers(); }
  });
});

describe("the workers menu (the badge, ⌘⇧W): a row opens the worker in the main area", () => {
  it("groups by owner (the room expanded, its family folded) and hands the picked row on, never showing a log itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersMenu } = await import("../../src/renderer/Workers");
    const botling = bot({ id: "botling", name: "botling", subagentRows: [
      row({ id: "w1", title: "context-baseline" }), row({ id: "w2", title: "fix-theme", status: "running", endedAt: null }),
    ] });
    const release = bot({ id: "release", name: "Release", parent: "botling" as never, subagentRows: [row({ id: "n1", title: "notarize", status: "running", endedAt: null })] });
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { host, unmount } = await mountEl(WorkersMenu, { bot: botling, bots: [botling, release], onOpen, onClose });
    try {
      expect(host.querySelector(".wk-menu")?.getAttribute("aria-label")).toBe("botling’s workers");
      expect([...host.querySelectorAll(".wk-sec")].map((s) => s.textContent)).toEqual(["Running · 1", "Today · 1"]);
      expect(host.querySelector(".wk-folded")?.textContent).toContain("1 running");
      await act(async () => host.querySelector<HTMLButtonElement>('.wk-row[data-worker="w1"]')!.click());
      expect(onOpen).toHaveBeenCalledWith("botling", expect.objectContaining({ id: "w1" }));
      expect(host.querySelector(".wk-log")).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>(".wk-folded")!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('.wk-row[data-worker="n1"]')!.click());
      expect(onOpen).toHaveBeenLastCalledWith("release", expect.objectContaining({ id: "n1" }));
      await act(async () => host.querySelector(".wk-menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onClose).toHaveBeenCalled();
    } finally { await unmount(); vi.useRealTimers(); }
  });
});

describe("the workers menu shows above the native chat", () => {
  it("registers as a shell overlay while open, so the chat view (a native view over the shell) steps aside and the list is visible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersMenu } = await import("../../src/renderer/Workers");
    const b = bot({ id: "botling", name: "botling", subagentRows: [row({ id: "w1" })] });
    expect(shellOverlayActive()).toBe(false);
    const { host, unmount } = await mountEl(WorkersMenu, { bot: b, bots: [b], onOpen() {}, onClose() {} });
    try {
      expect(host.querySelector('.wk-menu .wk-row[data-worker="w1"]')).not.toBeNull();
      expect(shellOverlayActive()).toBe(true);
    } finally { await unmount(); vi.useRealTimers(); }
    expect(shellOverlayActive()).toBe(false);
  });
  it("Cmd+Shift+W on a watched worker: going back to the chat keeps the menu it asked for; any other move closes it", () => {
    expect(workersMenuAfterMove("botling", "botling")).toBe("botling");
    expect(workersMenuAfterMove(null, "botling")).toBeNull();
    expect(workersMenuAfterMove("botling", "release")).toBeNull();
    expect(workersMenuAfterMove("botling", undefined)).toBeNull();
  });
});

describe("a worker watched in the main area: read only, with Ask <owner>", () => {
  it("knows which watched subagent is a worker of the shown bot (not a sub bot row, not another bot's)", () => {
    const b = bot({ id: "b", subagentRows: [row({ id: "w1" }), row({ id: "sb", subBot: "R" as never })] });
    expect(watchedWorker(b, view({ id: "w1" }))?.id).toBe("w1");
    expect(watchedWorker(b, view({ id: "sb" }))).toBeNull();
    expect(watchedWorker(b, view({ id: "zz" }))).toBeNull();
    expect(watchedWorker(b, null)).toBeNull();
    expect(watchedWorker(null, view())).toBeNull();
  });
  it("the bar under the transcript says who takes instructions and Ask goes to the owner, never the worker", async () => {
    const { WorkerAskBar } = await import("../../src/renderer/Workers");
    const owner = bot({ id: "botling", name: "botling", working: true });
    const onAsk = vi.fn();
    const { host, render, unmount } = await mountEl(WorkerAskBar, { owner, worker: row({ id: "w1", title: "context-baseline", agentId: "ag-7" }), onAsk });
    try {
      expect(host.querySelector(".wk-hint")?.textContent).toBe("botling is mid-turn. It reads your note at its next step.");
      expect(host.querySelector("textarea, input")).toBeNull();
      const ask = host.querySelector<HTMLButtonElement>(".wk-ask")!;
      expect(ask.textContent).toBe("Ask botling");
      await act(async () => ask.click());
      expect(onAsk).toHaveBeenCalledWith("botling", { id: "w1", title: "context-baseline", agentId: "ag-7" });
      await render({ owner: null, ownerName: "Release" });
      expect(host.querySelector<HTMLButtonElement>(".wk-ask")!.disabled).toBe(true);
    } finally { await unmount(); }
  });
});

describe("the badge button", () => {
  it("names the owner, shows the count, is blue while its menu is open, and hides with nothing today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersBadge } = await import("../../src/renderer/Workers");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onClick = vi.fn();
    const b = bot({ id: "botling", name: "botling", subagentRows: [row({ id: "r", status: "running", endedAt: null })] });
    try {
      await act(async () => root.render(createElement(WorkersBadge, { bot: b, bots: [b], seen: new Set<string>(), on: true, onClick })));
      const button = host.querySelector<HTMLButtonElement>(".workers-badge")!;
      expect(button.querySelector("b")?.textContent).toBe("botling’s workers"); expect(button.querySelector(".cnt")?.textContent).toBe("1 running");
      expect(button.classList.contains("on")).toBe(true);
      expect(button.dataset.tone).toBe("running");
      await act(async () => button.click());
      expect(onClick).toHaveBeenCalled();
      await act(async () => root.render(createElement(WorkersBadge, { bot: { ...b, subagentRows: [] }, bots: [b], seen: new Set<string>(), on: false, onClick })));
      expect(host.querySelector(".workers-badge")).toBeNull();
    } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
  });
});

describe("Ask <owner> prefills the owner's input box (the chat page's reference bar)", () => {
  it("is a reference chip naming the worker, with the owner's name; the words then go out wrapped", () => {
    expect(askReference({ id: "w1", title: "context-baseline" }, "botling")).toEqual({ id: "worker:w1", who: "About context-baseline", preview: "botling’s worker · your words go to botling, not the worker" });
  });
  it("says when the owner is busy, and cannot ask an owner that is gone", () => {
    expect(askState(bot({ id: "b", name: "botling" }))).toEqual({ ok: true, note: "Workers take instructions only from botling." });
    expect(askState(bot({ id: "b", name: "botling", working: true }))).toEqual({ ok: true, note: "botling is mid-turn. It reads your note at its next step." });
    expect(askState(null, "Release")).toEqual({ ok: false, note: "Release is gone, so nobody can pass this on." });
  });
});

describe("the badge at narrow widths", () => {
  it("carries a short count (icon + number) beside the long one, and the full words in its label", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersBadge } = await import("../../src/renderer/Workers");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const b = bot({ id: "botling", name: "botling", subagentRows: [row({ id: "r", status: "running", endedAt: null }), row({ id: "r2", status: "running", endedAt: null })] });
    try {
      await act(async () => root.render(createElement(WorkersBadge, { bot: b, bots: [b], seen: new Set<string>(), on: false, onClick() {} })));
      expect(host.querySelector(".workers-badge .cnt-short")?.textContent).toBe("2");
      expect(host.querySelector(".workers-badge")?.getAttribute("aria-label")).toBe("botling’s workers: 2 running");
    } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
  });
});
