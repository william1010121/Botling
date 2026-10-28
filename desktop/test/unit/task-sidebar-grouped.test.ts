// @vitest-environment jsdom
// The right panel's task list, design R2-3 "Grouped": one dense row per task in Needs you / Running /
// Done (each group folds; Done starts folded), a row pressed opens it in place (Now → Next, Blocked
// highlighted, Mark complete at its top right), and a row hovered floats the task's timeline.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPanel, taskGroups, taskTimeline, type RightPanelProps } from "../../src/renderer/RightPanel";
import { shellOverlayActive } from "../../src/renderer/ShellOverlay";
import type { BotView, TaskView } from "../../src/contract";

const bot: BotView = { id: "main", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const task = (fields: Partial<TaskView> & { id: string; name: string; state: TaskView["state"] }): TaskView => ({
  owner: "claude", now: null, next: null, blocked: null, messageIds: [], updatedAt: at(1), atWork: false, ...fields,
});
const tasks: TaskView[] = [
  task({ id: "t1", name: "Fix CLI launch", state: "running", now: "Rebuilding the bundle", next: "Run the smoke test", createdAt: at(30),
    history: [{ kind: "start", at: at(30), text: null }, { kind: "now", at: at(28), text: "Reading launch logs" }, { kind: "subagent", at: at(25), text: "a1" }, { kind: "now", at: at(2), text: "Rebuilding the bundle" }],
    relatedAgents: [{ id: "a1", title: "Trace PATH", engine: "claude", status: "running", available: true, run: null }] }),
  task({ id: "t2", name: "Release name", state: "waiting", blocked: "Botling 2.0 or 2.1?", next: "Tag the release", owner: "codex" }),
  task({ id: "t3", name: "Avatar portraits", state: "done", updatedAt: at(40) }),
  task({ id: "t4", name: "Panel cleanup", state: "done", updatedAt: at(50), manuallyCompletedAt: at(50) }),
];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; vi.useRealTimers(); });

async function mount(selectedTask: string | null = null, extra: Partial<RightPanelProps> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const props: RightPanelProps = {
    bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status: { key: "working", text: "Writing…" }, results: [], teams: [], watching: null,
    tasks, messages: [], selectedTask, collapsed: false,
    onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onEditGroup() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
    ...extra,
  };
  const render = (next: Partial<RightPanelProps> = {}) => act(async () => root.render(createElement(RightPanel, { ...props, ...next })));
  await render();
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); document.querySelectorAll(".task-timeline").forEach((node) => node.remove()); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; };
  return { host, render };
}

const group = (host: HTMLElement, key: string) => host.querySelector<HTMLElement>(`.task-group[data-group="${key}"]`);

describe("grouped task list", () => {
  it("groups the tasks into Needs you, Running and Done, each with its count; Done starts folded", async () => {
    const { host } = await mount();
    const groups = [...host.querySelectorAll<HTMLElement>(".task-group")];
    expect(groups.map((node) => node.dataset.group)).toEqual(["waiting", "running", "done"]);
    expect(groups.map((node) => node.querySelector("h3")!.textContent)).toEqual(["Needs you", "Running", "Done"]);
    expect(groups.map((node) => node.querySelector(".task-group-count")!.textContent)).toEqual(["1", "1", "2"]);
    expect(group(host, "waiting")!.querySelectorAll(".task-row")).toHaveLength(1);
    expect(group(host, "running")!.querySelectorAll(".task-row")).toHaveLength(1);
    expect(group(host, "done")!.querySelectorAll(".task-row")).toHaveLength(0);
    expect(group(host, "done")!.querySelector(".task-group-fold")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("is a dense list by default: one row per task, no card open, each line saying how it stands", async () => {
    const { host } = await mount();
    expect(host.querySelector(".task-card")).toBeNull();
    const running = group(host, "running")!.querySelector(".task-row")!;
    expect(running.querySelector(".task-row-name")!.textContent).toBe("Fix CLI launch");
    expect(running.querySelector(".task-line")!.textContent).toBe("Rebuilding the bundle");
    const waiting = group(host, "waiting")!.querySelector(".task-row")!;
    expect(waiting.querySelector(".task-line")!.textContent).toBe("Botling 2.0 or 2.1?");
    expect(waiting.querySelector(".task-owner-dot")!.getAttribute("data-head")).toBe("codex");
  });

  it("folds and unfolds every group", async () => {
    const { host } = await mount();
    await act(async () => group(host, "done")!.querySelector<HTMLButtonElement>(".task-group-fold")!.click());
    const done = [...group(host, "done")!.querySelectorAll(".task-row")];
    expect(done.map((row) => row.querySelector(".task-line")!.textContent)).toEqual([expect.stringMatching(/^Done · /), expect.stringMatching(/^Done · /)]);
    expect(done.some((row) => row.querySelector(".task-check"))).toBe(false);
    await act(async () => group(host, "running")!.querySelector<HTMLButtonElement>(".task-group-fold")!.click());
    expect(group(host, "running")!.querySelectorAll(".task-row")).toHaveLength(0);
    expect(group(host, "running")!.querySelector(".task-group-fold")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("a row pressed asks to open it; an active row's check marks it complete", async () => {
    const select = vi.fn(); const complete = vi.fn();
    const { host } = await mount(null, { onSelectTask: select, onCompleteTask: complete });
    const row = group(host, "running")!.querySelector(".task-row")!;
    await act(async () => row.querySelector<HTMLButtonElement>(".task-row-open")!.click());
    expect(select).toHaveBeenCalledWith("t1");
    await act(async () => row.querySelector<HTMLButtonElement>(".task-check")!.click());
    expect(complete).toHaveBeenCalledWith("t1");
  });

  it("the open task shows Now → Next, with Mark complete at its top right", async () => {
    const { host } = await mount("t1");
    const card = group(host, "running")!.querySelector(".task-card")!;
    expect(group(host, "running")!.querySelector(".task-row")).toBeNull();
    const top = card.querySelector(".task-card-top")!;
    expect(top.lastElementChild!.classList.contains("task-complete")).toBe(true);
    expect(top.lastElementChild!.getAttribute("aria-label")).toBe("Mark complete");
    const steps = [...card.querySelectorAll<HTMLElement>(".task-track .task-step")];
    expect(steps.map((step) => [step.dataset.step, step.querySelector(".task-field-value")!.textContent])).toEqual([["now", "Rebuilding the bundle"], ["next", "Run the smoke test"]]);
    expect(card.querySelector(".task-blocked")).toBeNull();
    expect(card.querySelector<HTMLDetailsElement>("details.task-agents")!.open).toBe(false);
  });

  it("a waiting task's blocker is highlighted above its track", async () => {
    const { host } = await mount("t2");
    const card = group(host, "waiting")!.querySelector(".task-card")!;
    expect(card.querySelector(".task-blocked")!.textContent).toContain("Botling 2.0 or 2.1?");
    expect([...card.querySelectorAll<HTMLElement>(".task-step")].map((step) => step.dataset.step)).toEqual(["next"]);
  });

  it("a finished task opened from elsewhere unfolds Done", async () => {
    const { host } = await mount("t3");
    expect(group(host, "done")!.querySelector('.task-card[data-task="t3"]')).not.toBeNull();
    expect(group(host, "done")!.querySelector(".task-complete")).toBeNull();
  });

  it("hovering a row floats its timeline from start to now", async () => {
    vi.useFakeTimers();
    const { host } = await mount();
    const row = group(host, "running")!.querySelector<HTMLElement>(".task-row")!;
    expect(shellOverlayActive()).toBe(false);
    await act(async () => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(400); });
    const pop = document.querySelector<HTMLElement>(".task-timeline[role=tooltip]")!;
    expect(pop).not.toBeNull();
    expect(shellOverlayActive()).toBe(true);
    expect(pop.querySelector(".task-timeline-name")!.textContent).toBe("Fix CLI launch");
    const events = [...pop.querySelectorAll<HTMLElement>(".task-event")].map((event) => [event.dataset.kind, event.querySelector(".task-event-text")!.textContent]);
    expect(events).toEqual([
      ["start", "Started"], ["now", "NowReading launch logs"], ["subagent", "SubagentTrace PATH"], ["now", "NowRebuilding the bundle"], ["next", "NextRun the smoke test"],
    ]);
    await act(async () => { row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(document.querySelector(".task-timeline")).toBeNull();
    expect(shellOverlayActive()).toBe(false);
  });
});

describe("Quiet and To verify", () => {
  const idle = { ...bot, working: false };
  const staged: TaskView[] = [
    task({ id: "live", name: "Live", state: "running", now: "Editing", updatedAt: at(2) }),
    task({ id: "old", name: "Old", state: "running", now: "Waiting on CI", updatedAt: at(125) }),
    task({ id: "busy", name: "Busy", state: "running", updatedAt: at(30), atWork: true }),
    task({ id: "built", name: "Built", state: "running", stage: "built", updatedAt: at(3) }),
    task({ id: "rev", name: "Reviewed", state: "done", stage: "reviewed", updatedAt: at(4) }),
    task({ id: "inst", name: "Installed", state: "done", stage: "installed", updatedAt: at(5) }),
    task({ id: "ok", name: "Verified", state: "done", stage: "verified", updatedAt: at(6) }),
    task({ id: "plain", name: "Plain", state: "done", updatedAt: at(7) }),
    task({ id: "closed", name: "Closed", state: "done", stage: "built", manuallyCompletedAt: at(8), updatedAt: at(8) }),
    task({ id: "stop", name: "Stopped", state: "stopped", stage: "built", updatedAt: at(9) }),
  ];
  const ids = (list: TaskView[]) => list.map((item) => item.id);

  it("routes stale tasks to Quiet, built-not-verified work to To verify, done+verified to Done", () => {
    const lists = taskGroups(staged, false, Date.now());
    expect(ids(lists.running)).toEqual(["live", "busy"]);
    expect(ids(lists.quiet)).toEqual(["old"]);
    expect(ids(lists.verify)).toEqual(["built", "rev", "inst"]);
    expect(ids(lists.done)).toEqual(["ok", "plain", "closed", "stop"]);
    // While the bot works, nothing is quiet.
    expect(ids(taskGroups(staged, true, Date.now()).quiet)).toEqual([]);
  });

  it("orders the groups Needs you, Running, To verify, Quiet, Done; Quiet and Done start folded", async () => {
    const { host } = await mount(null, { bot: idle, tasks: [...staged, task({ id: "ask", name: "Ask", state: "waiting", blocked: "Which?" })] });
    const groups = [...host.querySelectorAll<HTMLElement>(".task-group")];
    expect(groups.map((node) => node.dataset.group)).toEqual(["waiting", "running", "verify", "quiet", "done"]);
    expect(groups.map((node) => node.querySelector("h3")!.textContent)).toEqual(["Needs you", "Running", "To verify", "Quiet", "Done"]);
    expect(group(host, "quiet")!.querySelector(".task-group-fold")!.getAttribute("aria-expanded")).toBe("false");
    expect(group(host, "verify")!.querySelector(".task-group-fold")!.getAttribute("aria-expanded")).toBe("true");
    expect(group(host, "verify")!.querySelector(".task-group-count")!.textContent).toBe("3");
  });

  it("a quiet row says how long without news, in gray, and its card still offers Ask it to report", async () => {
    const report = vi.fn();
    const { host } = await mount(null, { bot: idle, tasks: staged, onAskForReport: report });
    await act(async () => group(host, "quiet")!.querySelector<HTMLButtonElement>(".task-group-fold")!.click());
    const row = group(host, "quiet")!.querySelector<HTMLElement>(".task-row")!;
    expect(row.dataset.state).toBe("quiet");
    expect(row.querySelector(".task-line")!.textContent).toBe("No news for 2 h");
    expect(group(host, "running")!.querySelector('[data-task="old"]')).toBeNull();
    await cleanup!(); cleanup = null;
    const { host: open } = await mount("old", { bot: idle, tasks: staged, onAskForReport: report });
    await act(async () => group(open, "quiet")!.querySelector<HTMLButtonElement>(".task-report")!.click());
    expect(report).toHaveBeenCalled();
  });

  it("a To verify row shows its four-step bar and label; its card shows the four steps", async () => {
    const { host } = await mount(null, { bot: idle, tasks: staged });
    const line = (id: string) => group(host, "verify")!.querySelector(`.task-row[data-task="${id}"] .task-line`)!;
    expect(line("built").textContent).toBe("Built · not reviewed");
    expect(line("rev").textContent).toBe("Reviewed · not installed");
    expect(line("inst").textContent).toBe("Installed · verifying");
    expect([...line("rev").querySelectorAll<HTMLElement>(".task-stage-seg")].map((seg) => seg.dataset.step)).toEqual(["done", "current", "todo", "todo"]);
    await cleanup!(); cleanup = null;
    const { host: open } = await mount("inst", { bot: idle, tasks: staged });
    const steps = [...group(open, "verify")!.querySelectorAll<HTMLElement>(".task-card .task-stage")];
    expect(steps.map((step) => [step.textContent, step.dataset.step])).toEqual([["Code done", "done"], ["Reviewed", "done"], ["Installed", "current"], ["Verified", "todo"]]);
  });
});

describe("taskTimeline", () => {
  it("builds one for a card saved before history was kept, from what it has", () => {
    const events = taskTimeline(task({ id: "old", name: "Old", state: "waiting", blocked: "Which one?", createdAt: at(10) }));
    expect(events.map((event) => [event.kind, event.text])).toEqual([["start", null], ["waiting", "Which one?"]]);
    const done = taskTimeline(task({ id: "d", name: "D", state: "done", manuallyCompletedAt: at(1), createdAt: at(5) }));
    expect(done.map((event) => event.kind)).toEqual(["start", "complete"]);
  });

  it("names a codex worker a Worker", () => {
    const events = taskTimeline(task({ id: "w", name: "W", state: "running", history: [{ kind: "subagent", at: at(1), text: "w1" }],
      relatedAgents: [{ id: "w1", title: "Expiry tests", engine: "codex", status: "running", available: true, run: 1 }] }));
    expect(events.map((event) => [event.label, event.text])).toEqual([["Started", null], ["Worker", "Expiry tests"]]);
  });
});


it("registers folded-panel floating cards for their lifetime while brief status tips stay excluded", async () => {
  const { host } = await mount(null, { collapsed: true, results: [{ label: "Result", url: "https://example.invalid/result" }] });
  const face = host.querySelector<HTMLElement>(".strip-face")!;
  await act(async () => face.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(host.querySelector(".strip-tip")).not.toBeNull();
  expect(shellOverlayActive()).toBe(false);
  const open = host.querySelector<HTMLButtonElement>('.strip-icon[data-section="results"]')!;
  await act(async () => open.click());
  expect(host.querySelector('.strip-flyout[role="dialog"]')).not.toBeNull();
  expect(shellOverlayActive()).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(host.querySelector(".strip-flyout")).toBeNull();
  expect(shellOverlayActive()).toBe(false);
});
