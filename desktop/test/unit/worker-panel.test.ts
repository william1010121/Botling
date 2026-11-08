// @vitest-environment jsdom
// Navigation v5, part 2: the right panel's Workers tab (a room's app-managed workers grouped by owner, a read-only
// log, "Ask <owner>" that writes to the owner bot and never to the worker) and the "<owner>'s workers" badge.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView, SubagentRowView, SubagentView } from "../../src/contract";
import {
  askOwnerText, askReference, askState, filesChanged, ownerSummary, sectionedWorkers, workerFamily, workerRowsOf, workersBadge, workersTabOffered,
} from "../../src/renderer/worker-panel";

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
  it("offers the tab only when the room or its family has a worker in the last 7 days", () => {
    expect(workersTabOffered(root, [root, release], NOW)).toBe(false);
    expect(workersTabOffered(root, [root, { ...release, subagentRows: [row({ id: "x" })] }], NOW)).toBe(true);
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

describe("the Workers tab in the right panel", () => {
  const view = (over: Partial<SubagentView> = {}): SubagentView => ({
    id: "w1", title: "context-baseline", owner: "botling", status: "completed", type: null, model: "sonnet-5-5", engine: "claude",
    prompt: "Measure context use", result: "Main 1.8M, subagents 317k.", startedAt: new Date(NOW - 5 * MIN).toISOString(), endedAt: new Date(NOW - MIN).toISOString(),
    outputTokens: 317_000,
    steps: [{ id: "s1", kind: "tool", tool: "Write", title: "Write base.md", detail: "/w/perf/base.md", output: null, failed: false, done: true }], ...over,
  });

  async function mount(props: Record<string, unknown>) {
    const { RightPanel } = await import("../../src/renderer/RightPanel");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const base = {
      waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], watching: null, collapsed: false,
      onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
    };
    const render = (more: Record<string, unknown>) => act(async () => root.render(createElement(RightPanel, { ...base, ...props, ...more } as never)));
    await render({});
    return { host, render, unmount: () => act(async () => root.unmount()) };
  }

  it("groups by owner, opens a read-only log with no input or Stop, and Ask sends the question to the owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const botling = bot({ id: "botling", name: "botling", subagentRows: [
      row({ id: "w1", title: "context-baseline" }), row({ id: "w2", title: "fix-theme", status: "running", endedAt: null }),
    ] });
    const release = bot({ id: "release", name: "Release", parent: "botling" as never, subagentRows: [row({ id: "n1", status: "running", endedAt: null })] });
    const onLoadWorker = vi.fn(async () => view());
    const onAskOwner = vi.fn(async () => {});
    const onPanelTab = vi.fn();
    const { host, unmount } = await mount({ bot: botling, bots: [botling, release], panelTab: "workers", onPanelTab, onLoadWorker, onAskOwner });
    try {
      expect([...host.querySelectorAll(".panel-tabs button")].map((b) => b.textContent)).toEqual(["Details", "Workers"]);
      expect(host.querySelector(".wk-owner")?.textContent).toContain("botling");
      expect([...host.querySelectorAll(".wk-sec")].map((s) => s.textContent)).toEqual(["Running · 1", "Today · 1"]);
      expect(host.querySelector(".wk-folded")?.textContent).toContain("Release");
      expect(host.querySelector(".wk-folded")?.textContent).toContain("1 running");
      await act(async () => host.querySelector<HTMLButtonElement>('.wk-row[data-worker="w1"]')!.click());
      expect(onLoadWorker).toHaveBeenCalledWith("botling", "w1");
      expect(host.querySelector(".wk-log-title")?.textContent).toBe("context-baseline");
      expect(host.querySelector(".wk-own")?.textContent).toBe("botling’s worker");
      expect(host.querySelector(".wk-result")?.textContent).toContain("Main 1.8M");
      expect(host.querySelector(".wk-files")?.textContent).toContain("perf/base.md");
      expect(host.querySelector(".wk-steps li")?.textContent).toContain("From botling:");
      expect(host.querySelector(".wk-log textarea, .wk-log input")).toBeNull();
      expect([...host.querySelectorAll(".wk-log button")].some((b) => /stop/i.test(b.textContent ?? ""))).toBe(false);
      await act(async () => host.querySelector<HTMLButtonElement>(".wk-ask")!.click());
      expect(onAskOwner).toHaveBeenCalledWith("botling", { id: "w1", title: "context-baseline" });
      await act(async () => host.querySelector<HTMLButtonElement>(".wk-back")!.click());
      expect(host.querySelector(".wk-log")).toBeNull();
      await act(async () => host.querySelectorAll<HTMLButtonElement>(".panel-tabs button")[0]!.click());
      expect(onPanelTab).toHaveBeenCalledWith("details");
    } finally { await unmount(); vi.useRealTimers(); }
  });

  it("a folded owner opens in place, and its worker's Ask goes to that owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const botling = bot({ id: "botling", name: "botling", subagentRows: [row({ id: "w1" })] });
    const release = bot({ id: "release", name: "Release", parent: "botling" as never, subagentRows: [row({ id: "n1", title: "notarize", status: "running", endedAt: null })] });
    const onLoadWorker = vi.fn(async () => view({ id: "n1", title: "notarize", owner: "release", status: "running", endedAt: null, result: null }));
    const onAskOwner = vi.fn(async () => {});
    const { host, unmount } = await mount({ bot: botling, bots: [botling, release], panelTab: "workers", onPanelTab() {}, onLoadWorker, onAskOwner });
    try {
      await act(async () => host.querySelector<HTMLButtonElement>(".wk-folded")!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('.wk-row[data-worker="n1"]')!.click());
      expect(onLoadWorker).toHaveBeenCalledWith("release", "n1");
      expect(host.querySelector(".wk-own")?.textContent).toBe("Release’s worker");
      expect(host.querySelector(".wk-now")).not.toBeNull();
      expect(host.querySelector(".wk-ask")?.textContent).toBe("Ask Release");
      await act(async () => host.querySelector<HTMLButtonElement>(".wk-ask")!.click());
      expect(onAskOwner).toHaveBeenCalledWith("release", { id: "n1", title: "notarize" });
    } finally { await unmount(); vi.useRealTimers(); }
  });

  it("shows nothing new when no worker is around: no tabs, the panel as today", async () => {
    const lonely = bot({ id: "solo" });
    const { host, unmount } = await mount({ bot: lonely, bots: [lonely], panelTab: "details", onPanelTab() {}, onLoadWorker: vi.fn(), onAskOwner: vi.fn() });
    try { expect(host.querySelector(".panel-tabs")).toBeNull(); expect(host.querySelector(".detail-head")).not.toBeNull(); }
    finally { await unmount(); }
  });
});

describe("the badge button", () => {
  it("names the owner, shows the count, is blue while the panel shows Workers, and hides with nothing today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersBadge } = await import("../../src/renderer/WorkersTab");
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

describe("v5 extras in the panel", () => {
  async function mount(props: Record<string, unknown>) {
    const { RightPanel } = await import("../../src/renderer/RightPanel");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const base = {
      waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], watching: null, collapsed: false,
      onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
      onPanelTab() {}, onLoadWorker: vi.fn(async () => ({ id: "f", title: "perf-trace", owner: "b", status: "failed", type: null, model: null, prompt: "trace", result: "Trace too large",
        startedAt: new Date(NOW - 9 * MIN).toISOString(), endedAt: new Date(NOW - MIN).toISOString(),
        steps: [{ id: "s", kind: "tool", tool: "Edit", title: "Edit a.ts", detail: "/w/src/a.ts", output: null, failed: false, done: true }] })), onAskOwner: vi.fn(),
    };
    const render = (more: Record<string, unknown>) => act(async () => root.render(createElement(RightPanel, { ...base, ...props, ...more } as never)));
    await render({});
    return { host, render, unmount: () => act(async () => root.unmount()) };
  }

  it("dots: Workers red with an unseen failure (on Details), Details orange when something waits (on Workers)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const b = bot({ id: "b", name: "botling", role: "main" as never, subagentRows: [row({ id: "f", status: "failed" })] });
    const waiting = { items: [{ botId: "b", text: "Pick one?", messageId: null }], doing: {} };
    const { host, render, unmount } = await mount({ bot: b, bots: [b], panelTab: "details", seenWorkers: new Set() });
    try {
      expect(host.querySelector('.panel-tabs button:nth-child(2) .tab-dot')?.className).toContain("failed");
      await render({ seenWorkers: new Set(["f"]) });
      expect(host.querySelector(".panel-tabs .tab-dot")).toBeNull();
      await render({ panelTab: "workers", waiting });
      expect(host.querySelector('.panel-tabs button:nth-child(1) .tab-dot')?.className).toContain("waiting");
    } finally { await unmount(); vi.useRealTimers(); }
  });

  it("a focus request opens that worker's log directly; a changed file opens in Review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const b = bot({ id: "b", name: "botling", subagentRows: [row({ id: "f", status: "failed" })] });
    const onOpenFile = vi.fn();
    const { host, unmount } = await mount({ bot: b, bots: [b], panelTab: "workers", focusWorker: { ownerId: "b", workerId: "f", at: 1 }, onOpenFile });
    try {
      expect(host.querySelector(".wk-log-title")?.textContent).toBe("perf-trace");
      const file = host.querySelector<HTMLButtonElement>(".wk-files button.wk-fc")!;
      expect(file.textContent).toBe("/w/src/a.ts");
      await act(async () => file.click());
      expect(onOpenFile).toHaveBeenCalledWith("b", "/w/src/a.ts");
    } finally { await unmount(); vi.useRealTimers(); }
  });

  it("Ask is off, with why, when the owner is gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const b = bot({ id: "b", name: "botling", working: true, subagentRows: [row({ id: "f", status: "failed" })] });
    const { host, unmount } = await mount({ bot: b, bots: [b], panelTab: "workers", focusWorker: { ownerId: "b", workerId: "f", at: 1 } });
    try {
      expect(host.querySelector(".wk-hint")?.textContent).toBe("botling is mid-turn. It reads your note at its next step.");
      expect(host.querySelector<HTMLButtonElement>(".wk-ask")!.disabled).toBe(false);
    } finally { await unmount(); vi.useRealTimers(); }
  });
});

describe("the badge at narrow widths", () => {
  it("carries a short count (icon + number) beside the long one, and the full words in its label", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { WorkersBadge } = await import("../../src/renderer/WorkersTab");
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

describe("the narrow drawer opens on request", () => {
  it("opens when asked (the badge or ⌘⇧W at narrow widths), as a sheet over the chat", async () => {
    window.matchMedia = ((media: string) => ({ media, matches: true, addEventListener() {}, removeEventListener() {} })) as never;
    const { TaskDetails } = await import("../../src/renderer/TaskDetails");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const b = bot({ id: "b" });
    const props = {
      bot: b, bots: [b], waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], watching: null, collapsed: false,
      onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {}, onDrawerSettings() {},
    };
    try {
      await act(async () => root.render(createElement(TaskDetails, { ...props, openSignal: 0 } as never)));
      expect(document.querySelector<HTMLElement>("#task-details-drawer")!.hidden).toBe(true);
      await act(async () => root.render(createElement(TaskDetails, { ...props, openSignal: 1 } as never)));
      expect(document.querySelector<HTMLElement>("#task-details-drawer")!.hidden).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });
});
